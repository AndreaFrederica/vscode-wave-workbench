`timescale 1ns/1ns
module mid_tb;
  mid_leaf u_leaf();
  mid_leaf u_other();
  mid_observer u_observer();
  initial begin
    $dumpfile("trace.vcd");
    $dumpvars(0, mid_tb);
    #5 $finish;
  end
endmodule
