#include "verilator_execution.h"
#include <bitset>
#include <future>

struct Reply {
  int argument;
  int result;
  WaveWorkbenchExternalStamp input_stamp;
  WaveWorkbenchExternalStamp result_stamp;
};
static std::future<Reply> work;

extern "C" void launch(int argument) {
  const auto input_stamp = wave_workbench_stamp_external();
  work = std::async(std::launch::async, [argument, input_stamp] {
    const int result = argument * 2;
    const auto stamp = wave_workbench_stamp_external();
    wave_workbench_observe_external(
      "TOP.recorded_dpi_tb", "result", "worker.complete", "independent worker completion",
      std::bitset<32>(result).to_string().c_str());
    return Reply{argument, result, input_stamp, stamp};
  });
  // Make the fixture independent of host scheduling. RTL consumes the result
  // at its next rising edge.
  work.wait();
}

extern "C" int consume(int *side) {
  if (!work.valid()) {
    *side = 0;
    return 0;
  }
  const Reply reply = work.get();
  wave_workbench_external_step("worker.input", "deferred request input",
                                std::bitset<32>(reply.argument).to_string().c_str(),
                                reply.input_stamp);
  wave_workbench_external_step("worker.result", "deferred worker result",
                                std::bitset<32>(reply.result).to_string().c_str(),
                                reply.result_stamp);
  *side = reply.result + 1;
  return reply.result;
}
