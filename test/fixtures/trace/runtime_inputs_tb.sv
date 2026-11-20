// SPDX-License-Identifier: MPL-2.0
`timescale 1ps/1ps
`include "generated_tb_config.svh"

module runtime_inputs_tb;
  logic [3:0] generated_stimulus;
  logic [3:0] mode;
  logic [3:0] memory [0:0];
  logic [3:0] result = 0, file_result = 0;
  bit enabled;

  generated_tb_driver driver (.stimulus(generated_stimulus));

  initial begin
    $fsdbDumpfile("runtime.fsdb");
    $fsdbDumpvars(0, runtime_inputs_tb);
    enabled = $test$plusargs("ENABLE");
    if (!$value$plusargs("MODE=%d", mode)) mode = 0;
    $readmemh("stimulus.hex", memory);
    #5;
    if (enabled) result = generated_stimulus ^ mode ^ `GENERATED_MASK;
    file_result = memory[0];
    #3 $finish;
  end
endmodule
