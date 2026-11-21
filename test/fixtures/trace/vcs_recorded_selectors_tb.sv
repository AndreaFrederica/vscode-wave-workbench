// SPDX-License-Identifier: MPL-2.0
`timescale 1ns/1ns

module tb;
  logic clk = 0;
  logic [4:7] a = 0;
  logic [3:0] b = 0;
  logic [2:0] amount = 2;
  logic [1:0] choose = 1;
  logic [7:0] q = 0;
  logic [3:0] r = 0;

  always @(posedge clk) begin
    q <= a << amount;
    r <= choose ? a : b;
    amount <= 3;
    choose <= 0;
  end

  initial begin
    $dumpfile("live.vcd");
    $dumpvars(0, tb);
    #1 a = 4'b1000;
    #2 clk = 1;
    #1 clk = 0;
    #2 $finish;
  end
endmodule
