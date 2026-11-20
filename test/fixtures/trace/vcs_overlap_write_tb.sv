module overlap_write_tb;
  bit clk;
  logic [1:0] a = 2'b11, b = 2'b01;
  integer index = 1;
  logic [1:0] phase = '0;
  logic [3:0] q = '0, mixed = '0;

  always #1 clk = !clk;
  always @(negedge clk) begin
    phase = phase + 1'b1;
    if (phase == 1) begin
      q[2:1] <= a;
      q[1:0] <= b;
      q[3] <= a[0];
      mixed[index +: 2] <= a;
      mixed[1:0] <= b;
    end else if (phase == 2) begin
      q[2:1] <= b;
      mixed[1:0] <= b;
      mixed <= 4'b1000;
    end
  end

  initial begin
    $dumpfile("live.vcd");
    $dumpvars(0, overlap_write_tb);
    #7 $finish;
  end
endmodule
