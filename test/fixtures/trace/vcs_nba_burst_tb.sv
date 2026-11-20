// SPDX-License-Identifier: MPL-2.0
module nba_burst_tb;
  logic [3:0] q = 0;
  initial begin
    $dumpfile("live.vcd");
    $dumpvars(0, nba_burst_tb);
    #1 q <= 4'd1;
       q <= 4'd2;
       q <= 4'd2;
    #1 q <= 4'd3;
    #1 $finish;
  end
endmodule
