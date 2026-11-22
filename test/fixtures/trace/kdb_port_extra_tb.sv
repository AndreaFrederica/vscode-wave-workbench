// SPDX-License-Identifier: MPL-2.0
`timescale 1ns/1ns

module extra_leaf(input wire [7:0] value, output wire [7:0] result);
  assign result = value;
endmodule

module extra_port_tb;
  logic [7:0] data = 8'h09, alternate = 8'h03;
  logic [2:0] amount = 3'd1;
  logic choose = 0;
  wire [7:0] left_result, right_result, multiply_result, conditional_result;
  extra_leaf left_shift(.value(data << amount), .result(left_result));
  extra_leaf right_shift(.value(data >> amount), .result(right_result));
  extra_leaf multiply(.value(data * alternate), .result(multiply_result));
  extra_leaf conditional(.value(choose ? data : alternate), .result(conditional_result));

  initial begin
    $dumpfile("trace.vcd");
    $dumpvars(0, extra_port_tb);
    #2 begin
      data = 8'h3c;
      alternate = 8'h05;
      amount = 3'd2;
      choose = 1;
    end
    #3 $finish;
  end
endmodule
