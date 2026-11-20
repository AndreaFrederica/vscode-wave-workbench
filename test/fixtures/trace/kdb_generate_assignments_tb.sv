// SPDX-License-Identifier: MPL-2.0
`timescale 1ps/1ps

module generate_assignments_tb;
  logic src_a = 0;
  logic src_b = 0;
  logic gate = 0;
  logic [-1:1] input_bits = '0;
  wire [2:0] output_bits;

  for (genvar index = -1; index <= 1; index++) begin : lanes
    wire intermediate;
    wire result_value;
    if (index == 0) begin : center
      assign intermediate = src_b;
    end else begin : outer
      assign intermediate = src_a;
    end
    assign result_value = intermediate & gate;
    assign output_bits[1-index] = input_bits[index] & result_value;
  end

  initial begin
    $fsdbDumpfile("generate_assignments.fsdb");
    $fsdbDumpvars(0, generate_assignments_tb);
    #5 gate = 1; src_a = 1; input_bits = 3'b100;
    #1 src_a = 0; src_b = 1; input_bits = 3'b010;
    #1 gate = 0;
    #1 $finish;
  end
endmodule
