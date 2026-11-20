// SPDX-License-Identifier: MPL-2.0
#include "Vtrace_tb.h"
#include <cstdio>
#include <cstdlib>
#include <iostream>
#include <string>

#ifdef WAVE_EXECUTION_TRACE
namespace {
unsigned current_tick = 0;
unsigned next_ordinal = 0;
bool stream_events = false;
struct Evaluation {
  const char *statement = nullptr;
  unsigned ordinal = 0;
  int value = 0;
};
Evaluation pending;

void event(const char *kind, const char *statement = nullptr, int value = -1,
           int evaluation = -1) {
  if (stream_events) std::printf("{\"execution\":");
  std::printf("{\"tick\":\"%u\",\"ordinal\":%u,\"instance\":\"TOP.trace_tb.dut\","
              "\"processId\":\"owner\",\"kind\":\"%s\"", current_tick, next_ordinal++, kind);
  if (statement) std::printf(",\"statementId\":\"%s\",\"signal\":\"owner_q\"", statement);
  if (value >= 0) std::printf(",\"value\":\"%d\"", value);
  if (evaluation >= 0) std::printf(",\"evaluationOrdinal\":%d", evaluation);
  std::puts(stream_events ? "}}" : "}");
}
} // namespace

extern "C" void wave_trace_owner(int kind, int id, int value) {
  if (kind == 0) {
    event("process-trigger");
    return;
  }
  const char *statement = id == 1 ? "owner.reset" : "owner.accept";
  if (kind == 1) {
    event("branch-taken", statement);
  } else {
    if (pending.statement) std::abort();
    pending = {statement, next_ordinal, value};
    event("assignment-evaluated", statement, value);
  }
}
#endif

#if VM_TRACE_FST
#include "verilated_fst_c.h"
using Trace = VerilatedFstC;
constexpr char filename[] = "trace.fst";
#else
#include "verilated_vcd_c.h"
using Trace = VerilatedVcdC;
constexpr char filename[] = "trace.vcd";
#endif

struct Sample {
  bool clk;
  bool reset_n;
  bool accept;
  unsigned request;
};

int main(int argc, char **argv) {
  Verilated::commandArgs(argc, argv);
  Verilated::traceEverOn(true);
  Vtrace_tb dut;
  Trace trace;
  const bool live = std::getenv("WAVE_WORKBENCH_LIVE") != nullptr;
  if (!live) {
    dut.trace(&trace, 99);
    trace.open(filename);
  }
#ifdef WAVE_EXECUTION_TRACE
  stream_events = live;
#endif
  const Sample samples[] = {
      {0, 1, 0, 0}, {1, 0, 0, 0}, {0, 1, 1, 3},
      {1, 1, 1, 3}, {0, 1, 0, 1}, {1, 1, 0, 1},
      {0, 1, 1, 2}, {1, 1, 1, 2}, {0, 0, 0, 0},
  };
  const auto evaluate = [&](unsigned tick) {
    const auto &sample = samples[tick];
    dut.clk = sample.clk;
    dut.rst_n = sample.reset_n;
    dut.accept = sample.accept;
    dut.request = sample.request;
#ifdef WAVE_EXECUTION_TRACE
    current_tick = tick;
#endif
    dut.eval();
#ifdef WAVE_EXECUTION_TRACE
    // The fixture has one NBA writer for owner_q and one evaluation per tick.
    if (pending.statement) {
      if (dut.owner_q != pending.value) std::abort();
      event("assignment-committed", pending.statement, dut.owner_q, pending.ordinal);
      pending = {};
    }
#endif
    if (!live) trace.dump(tick);
  };
  const unsigned count = sizeof(samples) / sizeof(samples[0]);
  if (live) {
    unsigned tick = 0;
    evaluate(tick);
    for (std::string command; std::getline(std::cin, command);) {
      if (command == "advance" && tick + 1 < count) evaluate(++tick);
      else if (command != "current" && command != "advance") return 2;
      std::printf("{\"snapshot\":{\"tick\":\"%u\",\"scale\":\"1ps\",\"done\":%s,"
#ifdef WAVE_EXECUTION_TRACE
                  "\"executionEvents\":true,"
#else
                  "\"executionEvents\":false,"
#endif
                  "\"values\":{\"TOP.trace_tb.dut.clk\":\"%u\","
                  "\"TOP.trace_tb.dut.owner_q\":\"%u\","
                  "\"TOP.trace_tb.dut.valid_q\":\"%u\"}}}\n",
                  tick, tick + 1 == count ? "true" : "false",
                  static_cast<unsigned>(dut.clk), static_cast<unsigned>(dut.owner_q),
                  static_cast<unsigned>(dut.valid_q));
      std::fflush(stdout);
      if (tick + 1 == count) break;
    }
  } else {
    for (unsigned tick = 0; tick < count; ++tick) evaluate(tick);
  }
  dut.final();
  if (!live) {
    trace.close();
#ifdef WAVE_EXECUTION_TRACE
    std::printf("{\"type\":\"end\",\"tick\":\"%u\",\"eventCount\":%u}\n", count - 1, next_ordinal);
#endif
  }
}
