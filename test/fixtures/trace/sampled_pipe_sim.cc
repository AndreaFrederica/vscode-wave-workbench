// SPDX-License-Identifier: MPL-2.0

#include "Vsampled_pipe_tb.h"
#include "verilated_fst_c.h"
#include "verilator_execution.h"
#include <cstdio>
#include <cstdlib>
#include <iostream>
#include <string>

int main() {
  Verilated::traceEverOn(true);
  Vsampled_pipe_tb dut;
  VerilatedFstC trace;
  const bool live = std::getenv("WAVE_WORKBENCH_LIVE") != nullptr;
  if (!live) {
    dut.trace(&trace, 20);
    trace.open("trace.fst");
  }
  const auto eval = [&](unsigned tick) {
    dut.clk = tick & 1;
    dut.value = tick < 2;
    wave_workbench_begin_slot(tick);
    dut.eval();
    if (!live) trace.dump(tick);
  };
  if (live) {
    unsigned tick = 0;
    eval(tick);
    for (std::string command; std::getline(std::cin, command);) {
      if (command == "advance" && tick < 7) eval(++tick);
      else if (command != "current" && command != "advance")
        return 2;
      std::printf("{\"snapshot\":{\"tick\":\"%u\",\"scale\":\"1ps\","
        "\"done\":%s,\"executionEvents\":true,\"values\":{"
        "\"TOP.sampled_pipe_tb.clk\":\"%u\","
        "\"TOP.sampled_pipe_tb.value\":\"%u\","
        "\"TOP.sampled_pipe_tb.first_q\":\"%u\","
        "\"TOP.sampled_pipe_tb.second_q\":\"%u\"}}}\n",
        tick, tick == 7 ? "true" : "false", unsigned(dut.clk),
        unsigned(dut.value), unsigned(dut.first_q), unsigned(dut.second_q));
      std::fflush(stdout);
      if (tick == 7) break;
    }
  } else {
    for (unsigned tick = 0; tick <= 7; ++tick) eval(tick);
    trace.close();
    wave_workbench_finish_execution(7);
  }
  dut.final();
}
