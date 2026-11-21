// SPDX-License-Identifier: MPL-2.0
`timescale 1ps/1ps

module generate_without_default_tb;
  logic edge_data = 0;
  logic center_data = 0;
  wire [3:0] result_bus;

  for (genvar lane = -1; lane <= 2; lane++) begin : lanes
    case (lane)
      -1, 1: assign result_bus[lane + 1] = edge_data;
      0: assign result_bus[lane + 1] = center_data;
    endcase
  end

  initial begin
    $dumpfile("generate_without_default.vcd");
    $dumpvars(0, generate_without_default_tb);
    #5 edge_data = 1;
    #1 center_data = 1;
    #4 edge_data = 0; center_data = 0;
    #5 $finish;
  end
endmodule
