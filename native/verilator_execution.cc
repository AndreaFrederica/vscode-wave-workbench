// SPDX-License-Identifier: MPL-2.0
#include "verilator_execution.h"
#include "svdpi.h"

#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <inttypes.h>
#include <mutex>
#include <optional>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

namespace {
struct Probe {
  const char *site;
  const char *instance;
  const char *signal;
  const char *statement;
  const char *process;
  const char *kind;
};

const Probe probes[] = {
#include "wave_workbench_probes.h"
};

std::uint64_t current_tick = 0;
std::uint64_t next_ordinal = 0;
const bool live = std::getenv("WAVE_WORKBENCH_LIVE") != nullptr;
std::unordered_map<const Probe *, std::uint64_t> pending_blocking;
struct ExternalStep {
  std::string statement, operation, value;
  std::optional<WaveWorkbenchExternalStamp> captured;
};
std::mutex external_clock_mutex;
std::uint64_t external_tick = 0;
std::uint64_t external_ordinal = 0;
struct ExternalObservation {
  std::string instance, signal;
  ExternalStep step;
};
std::vector<ExternalObservation> external_observations;
struct EvaluationFrame {
  const Probe *probe;
  std::vector<ExternalStep> steps;
};
std::vector<EvaluationFrame> evaluations;
struct PendingNba {
  const Probe *probe;
  std::uint64_t ordinal;
  std::string value;
  bool finished = false;

  PendingNba(const Probe *probe, std::uint64_t ordinal, const char *value)
      : probe(probe), ordinal(ordinal), value(value) {}
};
std::unordered_map<std::string, std::vector<PendingNba>> pending_nba;

const Probe *find_probe(const char *site, const char *instance) {
  for (const auto &probe : probes) {
    if (std::strcmp(site, probe.site) == 0 &&
        std::strcmp(instance, probe.instance) == 0)
      return &probe;
  }
  return nullptr;
}

std::string signal_key(const char *instance, const char *signal) {
  return std::string(instance) + '\0' + signal;
}

std::vector<PendingNba> *nba_writes(const char *instance, const char *signal) {
  const auto entry = pending_nba.find(signal_key(instance, signal));
  return entry == pending_nba.end() ? nullptr : &entry->second;
}

PendingNba *unfinished_nba(std::vector<PendingNba> &writes,
                            std::uint64_t ordinal) {
  const auto entry = std::find_if(writes.begin(), writes.end(),
                                  [ordinal](const PendingNba &write) {
    return !write.finished && write.ordinal == ordinal;
  });
  return entry == writes.end() ? nullptr : &*entry;
}

void open_event(const Probe *probe, const char *kind) {
  if (live) std::fputs("{\"execution\":", stdout);
  std::printf("{\"tick\":\"%" PRIu64 "\",\"ordinal\":%" PRIu64
              ",\"instance\":\"%s\",\"processId\":\"%s\",\"kind\":\"%s\"",
              current_tick, next_ordinal++, probe->instance, probe->process,
              kind);
}

void close_event() {
  std::puts(live ? "}}" : "}");
}

void write_external_step(const ExternalStep &step) {
  std::printf("{\"statementId\":\"%s\",\"operation\":\"", step.statement.c_str());
  for (const char character : step.operation) {
    if (character == '"' || character == '\\') std::putchar('\\');
    std::putchar(character);
  }
  std::putchar('"');
  if (!step.value.empty())
    std::printf(",\"value\":\"%s\"", step.value.c_str());
  if (step.captured)
    std::printf(",\"captured\":{\"tick\":\"%" PRIu64 "\",\"ordinal\":%" PRIu64 "}",
                step.captured->tick, step.captured->ordinal);
  std::putchar('}');
}

void emit(const Probe *probe, const char *value, const std::uint64_t *evaluation,
          const char *timing = nullptr,
          const std::vector<ExternalStep> *steps = nullptr) {
  open_event(probe, evaluation ? "assignment-committed" : "assignment-evaluated");
  std::printf(",\"signal\":\"%s\",\"statementId\":\"%s\","
              "\"writeKind\":\"%s\",\"value\":\"%s\"",
              probe->signal, probe->statement, probe->kind, value);
  if (evaluation)
    std::printf(",\"evaluationOrdinal\":%" PRIu64, *evaluation);
  if (timing) std::printf(",\"timing\":\"%s\"", timing);
  if (steps && !steps->empty()) {
    std::fputs(",\"externalSteps\":[", stdout);
    bool first = true;
    for (const auto &step : *steps) {
      if (!first) std::putchar(',');
      first = false;
      write_external_step(step);
    }
    std::putchar(']');
  }
  close_event();
}
} // namespace

void wave_workbench_begin_slot(std::uint64_t tick) {
  if (tick < current_tick || !pending_blocking.empty() || !evaluations.empty())
    std::abort();
  if (tick != current_tick) pending_nba.clear();
  current_tick = tick;
  std::vector<ExternalObservation> pending;
  {
    const std::lock_guard<std::mutex> lock(external_clock_mutex);
    external_tick = tick;
    pending.swap(external_observations);
  }
  for (const auto &entry : pending) {
    if (live) std::fputs("{\"execution\":", stdout);
    std::printf("{\"tick\":\"%" PRIu64 "\",\"ordinal\":%" PRIu64
                ",\"kind\":\"external-observation\",\"instance\":\"%s\",\"signal\":\"%s\",\"externalSteps\":[",
                tick, next_ordinal++, entry.instance.c_str(), entry.signal.c_str());
    write_external_step(entry.step);
    std::putchar(']');
    close_event();
  }
}

WaveWorkbenchExternalStamp wave_workbench_stamp_external() {
  const std::lock_guard<std::mutex> lock(external_clock_mutex);
  return {external_tick, external_ordinal++};
}

extern "C" void wave_workbench_begin_evaluation(const char *site) {
  const auto *instance = svGetNameFromScope(svGetScope());
  if (!instance) std::abort();
  if (const auto *probe = find_probe(site, instance)) {
    if (evaluations.size() >= 64) std::abort();
    evaluations.push_back({probe, {}});
  }
}

static ExternalStep external_step(const char *statement, const char *operation,
                                  const char *value,
                                  std::optional<WaveWorkbenchExternalStamp> captured) {
  constexpr const char *id_characters =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.-";
  if (!statement || !operation || !*statement || !*operation ||
      std::strlen(statement) > 128 || statement[std::strspn(statement, id_characters)] ||
      std::strlen(operation) > 128 ||
      (value && (!*value || std::strlen(value) > 4096 ||
                 value[std::strspn(value, "01xXzZ")])))
    std::abort();
  for (const char *character = operation; *character; ++character)
    if (*character < 32 || *character > 126) std::abort();
  return {statement, operation, value ? value : "", captured};
}

void wave_workbench_observe_external(const char *instance, const char *signal,
                                     const char *statement, const char *operation,
                                     const char *value) {
  constexpr const char *path_characters =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_$.[]-";
  if (!instance || !signal || !*instance || !*signal ||
      std::strlen(instance) + std::strlen(signal) > 4096 ||
      instance[std::strspn(instance, path_characters)] ||
      signal[std::strspn(signal, path_characters)])
    std::abort();
  auto step = external_step(statement, operation, value, std::nullopt);
  const std::lock_guard<std::mutex> lock(external_clock_mutex);
  if (external_observations.size() >= 4096) std::abort();
  step.captured = WaveWorkbenchExternalStamp{external_tick, external_ordinal++};
  external_observations.push_back({instance, signal, std::move(step)});
}

static void record_external_step(const char *statement, const char *operation,
                                 const char *value,
                                 std::optional<WaveWorkbenchExternalStamp> captured) {
  if (evaluations.empty()) return;
  auto &steps = evaluations.back().steps;
  if (steps.size() >= 64 || (captured && captured->tick > current_tick)) std::abort();
  steps.push_back(external_step(statement, operation, value, captured));
}

void wave_workbench_external_step(const char *statement, const char *operation,
                                  const char *value) {
  record_external_step(statement, operation, value, std::nullopt);
}

void wave_workbench_external_step(const char *statement, const char *operation,
                                  const char *value, WaveWorkbenchExternalStamp stamp) {
  record_external_step(statement, operation, value, stamp);
}

extern "C" void wave_workbench_process(const char *site) {
  const auto *instance = svGetNameFromScope(svGetScope());
  if (!instance) std::abort();
  const auto *probe = find_probe(site, instance);
  if (!probe || std::strcmp(probe->kind, "process") != 0) return;
  open_event(probe, "process-trigger");
  close_event();
}

extern "C" void wave_workbench_branch(const char *site) {
  const auto *instance = svGetNameFromScope(svGetScope());
  if (!instance) std::abort();
  const auto *probe = find_probe(site, instance);
  if (!probe || std::strcmp(probe->kind, "branch") != 0) return;
  open_event(probe, "branch-taken");
  std::printf(",\"statementId\":\"%s\"", probe->statement);
  close_event();
}

extern "C" void wave_workbench_write(const char *site, const char *value,
                                     svBit committed) {
  const auto *instance = svGetNameFromScope(svGetScope());
  if (!instance) std::abort();
  const auto *probe = find_probe(site, instance);
  if (!probe) return;
  if (!*value || value[std::strspn(value, "01xXzZ")]) std::abort();
  const bool blocking = std::strcmp(probe->kind, "blocking") == 0;
  if (committed) {
    const auto evaluation = pending_blocking.find(probe);
    if (!blocking || evaluation == pending_blocking.end()) std::abort();
    emit(probe, value, &evaluation->second);
    pending_blocking.erase(evaluation);
    return;
  }
  if (blocking) {
    if (!pending_blocking.emplace(probe, next_ordinal).second) std::abort();
  } else {
    pending_nba[signal_key(probe->instance, probe->signal)].emplace_back(
        probe, next_ordinal, value);
  }
  if (!evaluations.empty() && evaluations.back().probe == probe) {
    emit(probe, value, nullptr, nullptr, &evaluations.back().steps);
    evaluations.pop_back();
  } else {
    emit(probe, value, nullptr);
  }
}

bool wave_workbench_observe_nba(const char *instance, const char *signal,
                                const char *value) {
  auto *writes = nba_writes(instance, signal);
  if (!writes || writes->size() != 1) return false;
  auto &write = writes->front();
  if (write.finished || write.value != value) return false;
  emit(write.probe, value, &write.ordinal, "end-of-slot");
  write.finished = true;
  return true;
}

bool wave_workbench_nba_evaluation(const char *instance, const char *signal,
                                   const char *statement,
                                   std::uint64_t &ordinal) {
  const auto *writes = nba_writes(instance, signal);
  if (!writes) return false;
  const auto entry = std::find_if(writes->rbegin(), writes->rend(),
                                  [statement](const PendingNba &write) {
    return !write.finished && std::strcmp(write.probe->statement, statement) == 0;
  });
  if (entry == writes->rend()) return false;
  ordinal = entry->ordinal;
  return true;
}

bool wave_workbench_record_nba_commit(const char *instance, const char *signal,
                                      std::uint64_t evaluation,
                                      const char *value, bool end_of_slot) {
  auto *writes = nba_writes(instance, signal);
  auto *write = writes ? unfinished_nba(*writes, evaluation) : nullptr;
  if (!write || write->value != value) return false;
  emit(write->probe, value, &write->ordinal,
       end_of_slot ? "end-of-slot" : "simulator-commit");
  write->finished = true;
  return true;
}

bool wave_workbench_record_nba_superseded(const char *instance,
                                          const char *signal,
                                          std::uint64_t evaluation,
                                          std::uint64_t replacement) {
  auto *writes = nba_writes(instance, signal);
  if (!writes || evaluation >= replacement) return false;
  auto *write = unfinished_nba(*writes, evaluation);
  if (!write || !unfinished_nba(*writes, replacement)) return false;
  open_event(write->probe, "assignment-superseded");
  std::printf(",\"signal\":\"%s\",\"statementId\":\"%s\",\"writeKind\":\"nonblocking\","
              "\"evaluationOrdinal\":%" PRIu64 ",\"replacementOrdinal\":%" PRIu64,
              write->probe->signal, write->probe->statement, evaluation, replacement);
  close_event();
  write->finished = true;
  return true;
}

std::uint64_t wave_workbench_stage_nba(const char *instance, const char *signal,
                                      const char *statement, std::uint64_t pending) {
  std::uint64_t evaluation;
  if (!wave_workbench_nba_evaluation(instance, signal, statement, evaluation))
    return 0;
  if (pending && !wave_workbench_record_nba_superseded(
                     instance, signal, pending - 1, evaluation))
    return 0;
  return evaluation + 1;  // Zero marks an empty simulator slot.
}

void wave_workbench_commit_nba(const char *instance, const char *signal,
                               std::uint64_t pending, std::uint64_t value,
                               unsigned width) {
  if (!pending || width == 0 || width > 64) return;
  char bits[65];
  for (unsigned bit = 0; bit < width; ++bit)
    bits[width - bit - 1] = ((value >> bit) & 1) ? '1' : '0';
  bits[width] = '\0';
  wave_workbench_record_nba_commit(instance, signal, pending - 1, bits, false);
}

void wave_workbench_finish_execution(std::uint64_t tick) {
  wave_workbench_begin_slot(tick);
  if (live) return;
  std::printf("{\"type\":\"end\",\"tick\":\"%" PRIu64
              "\",\"eventCount\":%" PRIu64 "}\n",
              tick, next_ordinal);
}
