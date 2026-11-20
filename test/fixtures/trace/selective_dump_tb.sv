// SPDX-License-Identifier: MPL-2.0
`timescale 1ps/1ps
module selective_tb;
  logic scalar = 0, hidden = 1;
  logic [7:4] bus = 0;
  logic [-1:2] crossed = 0;

  initial begin
    $fsdbDumpfile("selective.fsdb");
    $fsdbDumpvars(0, scalar, bus, crossed);
    #3 scalar = hidden;
    bus = 4'b1010;
    crossed = 4'b1001;
    #3 $finish;
  end
endmodule
