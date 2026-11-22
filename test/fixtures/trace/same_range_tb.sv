`timescale 1ns/1ns
module same_range_tb;
  logic [3:0] q;
  logic [1:0] a, b, c;
  initial begin
    $dumpfile("live.vcd");
    $dumpvars(0, same_range_tb);
    q = 4'b1001;
    a = 2'b01;
    b = 2'b11;
    c = 2'b10;
    #2;
    q[2:1] <= a;
    q[2:1] <= b;
    q[2:1] <= c;
    #1;
    a = 2'b00;
    b = 2'b01;
    #1;
    q[2:1] <= a;
    q[2:1] <= b;
    q[2:1] <= c;
    #1 $finish;
  end
endmodule
