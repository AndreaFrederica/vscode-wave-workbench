// SPDX-License-Identifier: MPL-2.0
#include "Vexecution_order_tb.h"
#include "svdpi.h"
#include "verilated_fst_c.h"
#include <cstdio>
#include <cstdlib>
#include <map>
#include <string>

namespace {
struct Write {
  const char *statement;
  unsigned ordinal;
  int value;
};

unsigned tick = 0;
unsigned next_ordinal = 0;
std::map<std::string, Write> blocking;
std::map<std::string, Write> scheduled;

void emit(const std::string &instance, const char *kind, const Write *write = nullptr,
          const char *write_kind = nullptr, int value = -1, bool pair = false,
          bool end_of_slot = false, int replacement_ordinal = -1) {
  std::printf("{\"tick\":\"%u\",\"ordinal\":%u,\"instance\":\"%s\","
              "\"processId\":\"writer\",\"kind\":\"%s\"",
              tick, next_ordinal++, instance.c_str(), kind);
  if (write)
    std::printf(",\"statementId\":\"%s\",\"signal\":\"q\",\"writeKind\":\"%s\"",
                write->statement, write_kind);
  if (value >= 0) std::printf(",\"value\":\"%d\"", value);
  if (pair) std::printf(",\"evaluationOrdinal\":%u", write->ordinal);
  if (replacement_ordinal >= 0) std::printf(",\"replacementOrdinal\":%d", replacement_ordinal);
  if (end_of_slot) std::printf(",\"timing\":\"end-of-slot\"");
  std::puts("}");
}
} // namespace

extern "C" void trace_write(int kind, int id, int value) {
  const char *scope = svGetNameFromScope(svGetScope());
  if (!scope) std::abort();
  const std::string instance = scope;
  const char *statements[] = {"", "write.blocking", "write.replaced", "write.final"};
  if (kind == 0) {
    emit(instance, "process-trigger");
  } else if (kind == 1) {
    const Write write{statements[id], next_ordinal, value};
    if (!blocking.emplace(instance, write).second) std::abort();
    emit(instance, "assignment-evaluated", &write, "blocking", value);
  } else if (kind == 2) {
    const auto &write = blocking.at(instance);
    if (value != write.value) std::abort();
    emit(instance, "assignment-committed", &write, "blocking", value, true);
    blocking.erase(instance);
  } else if (kind == 3) {
    const auto prior = scheduled.find(instance);
    const Write write{statements[id], next_ordinal, value};
    emit(instance, "assignment-evaluated", &write, "nonblocking", value);
    if (prior != scheduled.end()) {
      // These two complete writes execute in the order of one RTL process.
      if (id != 3 || std::string(prior->second.statement) != statements[2]) std::abort();
      emit(instance, "assignment-superseded", &prior->second, "nonblocking", -1,
           true, false, write.ordinal);
    }
    scheduled[instance] = write;
  } else {
    std::abort();
  }
}

int main() {
  Verilated::traceEverOn(true);
  Vexecution_order_tb dut;
  VerilatedFstC trace;
  dut.trace(&trace, 99);
  trace.open("trace.fst");
  for (tick = 0; tick <= 5; ++tick) {
    dut.clk = tick % 2;
    dut.update = tick < 4;
    dut.value = 1;
    dut.eval();
    if (!blocking.empty()) std::abort();
    for (const auto &entry : scheduled) {
      const auto &instance = entry.first;
      const auto &write = entry.second;
      int value;
      if (instance == "TOP.execution_order_tb.first") value = dut.first_q;
      else if (instance == "TOP.execution_order_tb.second") value = dut.second_q;
      else std::abort();
      if (value != write.value) std::abort();
      emit(instance, "assignment-committed", &write, "nonblocking", value, true, true);
    }
    scheduled.clear();
    trace.dump(tick);
  }
  dut.final();
  trace.close();
  std::printf("{\"type\":\"end\",\"tick\":\"5\",\"eventCount\":%u}\n", next_ordinal);
}
