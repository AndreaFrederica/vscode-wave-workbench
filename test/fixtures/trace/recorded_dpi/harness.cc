#include "Vrecorded_dpi_tb.h"
#include "verilated_vcd_c.h"
#include "verilator_execution.h"
#include <bitset>
#include <cstdio>
#include <cstdlib>
#include <iostream>
#include <string>

int main() {
  Verilated::traceEverOn(true);
  Vrecorded_dpi_tb dut;
  VerilatedVcdC trace;
  const bool live = std::getenv("WAVE_WORKBENCH_LIVE") != nullptr;
  if (!live) {
    dut.trace(&trace, 20);
    trace.open("trace.vcd");
  }
  const auto eval = [&](unsigned tick) {
    dut.clk = tick & 1;
    dut.input_arg = tick < 2 ? 3 : 4;
    wave_workbench_begin_slot(tick);
    dut.eval();
    if (!live) trace.dump(tick);
  };
  if (live) {
    unsigned tick = 0;
    eval(tick);
    for (std::string command; std::getline(std::cin, command);) {
      if (command == "advance" && tick < 4) eval(++tick);
      else if (command != "current") return 2;
      std::printf("{\"snapshot\":{\"schemaVersion\":1,\"tick\":\"%u\",\"scale\":\"1ps\","
        "\"done\":%s,\"executionEvents\":true,\"values\":{"
        "\"TOP.recorded_dpi_tb.clk\":\"%u\","
        "\"TOP.recorded_dpi_tb.input_arg\":\"%s\","
        "\"TOP.recorded_dpi_tb.result\":\"%s\","
        "\"TOP.recorded_dpi_tb.side_effect\":\"%s\"}}}\n",
        tick, tick == 4 ? "true" : "false", unsigned(dut.clk),
        std::bitset<32>(dut.input_arg).to_string().c_str(),
        std::bitset<32>(dut.result).to_string().c_str(),
        std::bitset<32>(dut.side_effect).to_string().c_str());
      std::fflush(stdout);
      if (tick == 4) break;
    }
  } else {
    for (unsigned tick = 0; tick <= 4; ++tick) eval(tick);
    trace.close();
    wave_workbench_finish_execution(4);
  }
  dut.final();
}
