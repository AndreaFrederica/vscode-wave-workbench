module multi_rhs_tb;
  bit clk;
  logic seed = 1'b1;
  logic left_q = 1'b0, right_q = 1'b0;
  logic and_q = 1'b0, or_q = 1'b0;

  always #1 clk = !clk;
  initial #2 seed = 1'b0;

  always @(posedge clk) begin
    left_q <= seed;
    right_q <= seed;
    and_q <= left_q & right_q;
    or_q <= left_q | right_q;
  end

  initial begin
    $dumpfile("live.vcd");
    $dumpvars(0, multi_rhs_tb);
    #7 $finish;
  end
endmodule
