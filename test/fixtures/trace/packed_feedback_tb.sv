// SPDX-License-Identifier: MPL-2.0
`timescale 1ps/1ps
module packed_feedback_tb;
  logic seed = 0, decoy = 0, enable = 0, clk = 0;
  wire [5:0] lanes;
  wire [0:3] ascending_bus;
  logic state = 0;
  assign lanes[0] = seed;
  assign lanes[1] = decoy;
  assign lanes[2] = lanes[0];
  assign lanes[3] = lanes[2] & enable;
  assign lanes[4] = lanes[5];
  assign lanes[5] = state;
  always @(posedge clk) state <= lanes[4];
  assign ascending_bus[0:1] = {decoy, lanes[3]};
  assign ascending_bus[2:3] = {lanes[0], lanes[1]};

  initial begin
    $fsdbDumpfile("packed_feedback.fsdb");
    $fsdbDumpvars(0, packed_feedback_tb);
    #5 seed = 1; enable = 1;
    #1 decoy = 1; clk = 1;
    #1 seed = 0;
    #1 $finish;
  end
endmodule
