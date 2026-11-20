// SPDX-License-Identifier: MPL-2.0
module indexed_write_tb;
  bit clk;
  logic [3:0] index = 1;
  logic [1:0] d = 2'b10;
  logic [0:7] ascending = 0;
  logic [7:0] descending = 0;

  always #1 clk = !clk;
  always @(negedge clk) begin
    ascending[index +: 2] <= d;
    descending[index -: 2] <= d;
    case ($time)
      2: index = 4;
      4: index = 7;
      6: index = 0;
      8: index = 'x;
      10: index = 3;
      default: index = 3;
    endcase
  end

  initial begin
    $dumpfile("live.vcd");
    $dumpvars(0, indexed_write_tb);
    #14 $finish;
  end
endmodule
