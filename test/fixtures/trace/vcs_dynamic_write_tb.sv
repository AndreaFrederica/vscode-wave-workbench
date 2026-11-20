// SPDX-License-Identifier: MPL-2.0
module dynamic_write_tb;
  bit clk;
  logic signed [3:0] index = -1;
  logic [3:-1] q = 0;
  logic d = 1;

  always #1 clk = !clk;
  always @(negedge clk) begin
    q[index] <= d;
    case ($time)
      2: index = 2;
      4: index = 'x;
      6: index = 7;
      8: index = 1;
      default: index = 1;
    endcase
  end

  initial begin
    $dumpfile("live.vcd");
    $dumpvars(0, dynamic_write_tb);
    #12 $finish;
  end
endmodule
