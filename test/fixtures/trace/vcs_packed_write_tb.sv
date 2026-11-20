// SPDX-License-Identifier: MPL-2.0
module packed_write_tb;
  bit clk;
  logic [7:0] d = 0;
  logic [0:7] q = 0;

  always #1 clk = !clk;
  always @(posedge clk) begin
    q[0:3] <= d[7:4];
    q[4:7] <= d[3:0];
  end

  initial begin
    $dumpfile("live.vcd");
    $dumpvars(0, packed_write_tb);
    #2 d[7:4] = 4'b1001;
       d[3:0] = 4'b0101;
    #2 d[7:4] = 4'b0110;
       d[0] = 1'b0;
    #2 $finish;
  end
endmodule
