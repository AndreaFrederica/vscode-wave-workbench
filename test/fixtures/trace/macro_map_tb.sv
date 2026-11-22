`timescale 1ns/1ns
`define WRITE_Q(dst, rhs) dst <= rhs;
module writer(input wire clk, sel, a, b, output logic q);
  always_ff @(posedge clk) begin
    `WRITE_Q(q, a)
    if (sel) `WRITE_Q(q, b)
  end
endmodule
module macro_map_tb;
  logic clk = 0, sel = 0, a = 1, b = 0;
  wire x, y;
  writer left(clk, sel, a, b, x);
  writer right(clk, sel, b, a, y);
  initial begin
    $dumpfile("macro.vcd");
    $dumpvars(0, macro_map_tb);
    #1 clk = 1;
    #1 clk = 0;
    sel = 1;
    #1 clk = 1;
    #1 $finish;
  end
endmodule
