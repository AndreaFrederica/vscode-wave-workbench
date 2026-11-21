// SPDX-License-Identifier: MPL-2.0
module partial_tb;
  logic [0:7] asc_right = '0, asc_left = '0;
  logic [7:0] desc_right = '0, desc_left = '0;
  logic signed [31:0] lo = -1, hi = 7, zero = 0, above = 8;
  logic [1:0] d = 2'b10;
  initial begin
    $dumpfile("live.vcd");
    $dumpvars;
    #2 asc_right[hi +: 2] <= d;
       desc_right[zero -: 2] <= d;
       asc_left[lo +: 2] <= d;
       desc_left[above -: 2] <= d;
    #1 d = 2'b01;
    #1 asc_right[hi +: 2] <= d;
       desc_right[zero -: 2] <= d;
       asc_left[lo +: 2] <= d;
       desc_left[above -: 2] <= d;
    #2 $finish;
  end
endmodule
