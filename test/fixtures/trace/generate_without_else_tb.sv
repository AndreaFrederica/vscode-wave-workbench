// SPDX-License-Identifier: MPL-2.0
`timescale 1ps/1ps

module generate_without_else_tb;
  logic data = 0;
  wire [2:0] negative_only;
  wire [2:0] center_only;

  for (genvar lane = -1; lane <= 1; lane++) begin : lanes
    if (lane < 0) assign negative_only[lane + 1] = data;
    if (lane == 0) assign center_only[lane + 1] = data;
  end

  initial begin
    $dumpfile("generate_without_else.vcd");
    $dumpvars(0, generate_without_else_tb);
    #5 data = 1;
    #5 data = 0;
    #5 $finish;
  end
endmodule
