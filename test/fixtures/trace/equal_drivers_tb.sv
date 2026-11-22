`timescale 1ns/1ns
module equal_drivers_tb;
  logic left = 0;
  logic right = 0;
  wire q;
  assign q = left;
  assign q = right;

  initial begin
    $dumpfile("equal_drivers.vcd");
    $dumpvars(0, equal_drivers_tb);
    #2;
    left = 1;
    right = 1;
    #2 $finish;
  end
endmodule
