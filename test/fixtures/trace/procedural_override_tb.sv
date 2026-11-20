// SPDX-License-Identifier: MPL-2.0
`timescale 1ps/1ps
module procedural_override_tb;
  logic normal = 0, stimulus = 0;
  wire net_out;
  logic temporary;
  assign net_out = normal;

  initial begin
    $fsdbDumpfile("override.fsdb");
    $fsdbDumpvars(0, procedural_override_tb);
    #1 force net_out = stimulus;
    assign temporary = stimulus;
    #2 stimulus = 1;
    #2 release net_out;
    deassign temporary;
    #2 stimulus = 0;
    #1 $finish;
  end
endmodule
