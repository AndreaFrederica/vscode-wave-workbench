// SPDX-License-Identifier: MPL-2.0
module no_target_tb;
  logic signed [31:0] index;
  logic [3:0] q = '0;
  logic first = 0, second = 0;
  initial begin
    $dumpfile("live.vcd");
    $dumpvars(0, no_target_tb);
    #1 first = 1;
    #1 index = -2;
       q[index] <= 1;
       q[0] <= first;
    #1 second = 1;
    #1 index = 'x;
       q[1] <= second;
       q[index] <= 1;
    #2 $finish;
  end
endmodule
