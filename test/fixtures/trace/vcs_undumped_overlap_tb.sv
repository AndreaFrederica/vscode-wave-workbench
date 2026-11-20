// SPDX-License-Identifier: MPL-2.0
module undumped_overlap_tb;
  bit clk;
  logic [1:0] hi = 2'b10, lo = 2'b10, recovery = 2'b01;
  logic [4:7] q = '0, result = '0;

  always #1 clk = !clk;

  always @(posedge clk) begin
    if ($time == 1) begin
      q[4:5] <= hi;
      q[6:7] <= lo;
    end
    if ($time == 3) begin
      q[6:7] <= 2'b01;
      q[6:7] <= 2'b11;
    end
    if ($time == 5) q[6:7] <= recovery;
    result <= q;
  end

  initial begin
    $dumpfile("live.vcd");
    $dumpvars(0, clk, hi, lo, recovery, result);
    #9 $finish;
  end
endmodule
