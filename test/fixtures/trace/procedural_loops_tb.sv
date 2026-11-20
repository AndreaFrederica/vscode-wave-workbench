// SPDX-License-Identifier: MPL-2.0
`timescale 1ps/1ps
module procedural_loops_tb;
  bit clk, data, enabled = 1, do_again;
  int count = 1, bound = 1;
  bit [1:0] lanes;
  bit q_while, q_repeat, q_do, q_foreach, q_for, q_forever;

  always @(posedge clk) begin
    while (enabled) begin
      q_while = data;
      enabled = 0;
    end
    repeat (count) q_repeat <= data;
    do q_do <= data; while (do_again);
    foreach (lanes[i]) q_foreach <= lanes[i];
    for (int i = 0; i < bound; i++) q_for <= data;
  end

  initial forever @(negedge clk) q_forever <= data;

  initial begin
    $fsdbDumpfile("loops.fsdb");
    $fsdbDumpvars(0, procedural_loops_tb);
    #2 data = 1;
    lanes = '1;
    #3 clk = 1;
    #2 clk = 0;
    #2 $finish;
  end

  int incremented = 1, decremented = 9, captured = 0, cursor = 0, final_index;
  bit [3:0] write_lanes;
  always @(posedge clk) begin
    incremented++;
    captured = --decremented;
    write_lanes[cursor++] = data;
    for (final_index = 0; final_index < bound; final_index++) ;
  end
endmodule
