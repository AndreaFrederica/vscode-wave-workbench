// SPDX-License-Identifier: MPL-2.0
module undumped_packed_tb;
  bit clk;
  logic [1:0] hi = 2'b10, lo = 2'b01;
  logic [4:7] q = '0, result = '0;

  always #1 clk = !clk;
  initial #2 begin
    hi = 2'b11;
    lo = 2'b10;
  end

  always @(posedge clk) begin
    if ($time == 1) q[4:5] <= hi;
    if ($time == 3) q[6:7] <= lo;
    result <= q;
  end

  initial begin
    $dumpfile("live.vcd");
    $dumpvars(0, clk, hi, lo, result);
    #7 $finish;
  end
endmodule
