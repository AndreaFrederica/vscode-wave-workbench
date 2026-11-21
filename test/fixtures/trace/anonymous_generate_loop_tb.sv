// SPDX-License-Identifier: MPL-2.0
`timescale 1ps/1ps

module anonymous_generate_loop_tb;
  logic src_a = 0;
  logic src_b = 0;
  logic gate = 0;
  wire [2:0] result_bus;

  for (genvar index = -1; index <= 1; index++) begin
    wire intermediate;
    wire result_value;
`ifdef WITH_INLINE_GENERATE
    if (index == 0) assign intermediate = src_b; else assign intermediate = src_a;
`else
    if (index == 0) begin
      assign intermediate = src_b;
    end else begin
      assign intermediate = src_a;
    end
`endif
    assign result_value = intermediate & gate;
    assign result_bus[index + 1] = result_value;
  end

  initial begin
`ifdef WITH_FST
    $dumpfile("anonymous_generate_loop.fst");
`else
    $dumpfile("anonymous_generate_loop.vcd");
`endif
    $dumpvars(0, anonymous_generate_loop_tb);
`ifdef WITH_FSDB
    $fsdbDumpfile("anonymous_generate_loop.fsdb");
    $fsdbDumpvars(0, anonymous_generate_loop_tb);
`endif
    #5 gate = 1; src_a = 1;
    #1 src_a = 0; src_b = 1;
    #1 gate = 0;
    #1 $finish;
  end
endmodule
