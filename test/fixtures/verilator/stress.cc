#include "Vtop.h"
#include "verilated_fst_c.h"
int main(int argc, char** argv) {
  Verilated::commandArgs(argc, argv);
  Verilated::traceEverOn(true);
  Vtop dut;
  VerilatedFstC trace;
  dut.trace(&trace, 99);
  trace.open("top.fst");
  uint64_t x = 0xabcdef123456789ULL;
  const uint64_t count = argc < 2 ? 100000 : std::stoull(argv[1]);
  for (uint64_t tick = 0; tick < count; ++tick) {
    dut.clk = tick & 1;
    for (int i = 0; i < 32; ++i) {
      x ^= x << 13; x ^= x >> 7; x ^= x << 17;
      dut.seed[i] = x;
    }
    dut.eval();
    trace.dump(tick);
  }
  trace.close();
}
