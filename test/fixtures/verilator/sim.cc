#include "Vtop.h"
#if VM_TRACE_FST
#include "verilated_fst_c.h"
using Trace = VerilatedFstC;
constexpr char filename[] = "top.fst";
#else
#include "verilated_vcd_c.h"
using Trace = VerilatedVcdC;
constexpr char filename[] = "top.vcd";
#endif
int main(int argc, char** argv) {
  Verilated::commandArgs(argc, argv);
  Verilated::traceEverOn(true);
  Vtop dut;
  Trace trace;
  dut.trace(&trace, 99);
  trace.open(filename);
  unsigned long count = argc < 2 ? 80 : std::stoul(argv[1]);
  for (unsigned long t=0; t<count; ++t) {
    dut.clk = t & 1;
    dut.eval();
    trace.dump(t);
  }
  dut.final();
  trace.close();
}
