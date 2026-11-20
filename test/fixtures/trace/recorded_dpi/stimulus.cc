#include "verilator_execution.h"
#include <bitset>

extern "C" int adjust(int source, int *side) {
  wave_workbench_external_step("adjust.entry", "adjust argument",
                                std::bitset<32>(source).to_string().c_str());
  const int result = source * 2;
  *side = result + 1;
  wave_workbench_external_step("adjust.result", "adjust return",
                                std::bitset<32>(result).to_string().c_str());
  return result;
}
