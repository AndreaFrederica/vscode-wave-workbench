// SPDX-License-Identifier: MPL-2.0
`timescale 1ns/1ns
module time_feedback_tb;
  logic stimulus = 0, blocked = 1, hidden = 0;
  wire a, b, q;
  assign a = stimulus | b;
  assign b = a & blocked;
  assign q = a ^ hidden;
  initial begin
    $dumpfile("time_feedback.vcd");
    $dumpvars(0, stimulus, blocked, a, b, q);
    #3 stimulus = 1;
    #2 blocked = 0;
    #2 $finish;
  end
endmodule
