// SPDX-License-Identifier: MPL-2.0
module clock_tb;
  bit clk;
  logic [3:0] d = 0;
  logic [3:0] q = 0;

  always #1 clk = !clk;
  always @(posedge clk) q <= d;

  initial begin
    $dumpfile("live.vcd");
    $dumpvars(0, clock_tb);
    #2 d = 4'h5;
    #2 d = 4'ha;
    #4 $finish;
  end
endmodule
