`timescale 1ns/1ns
module xmr_up_middle(input wire a, output wire result);
  wire shared_value = a;
  logic external_value;
  xmr_up_leaf u_leaf(.write_value(a), .result(result));
endmodule

module xmr_up_tb;
  logic a, b;
  wire left, right;
  xmr_up_middle u_left(.a(a), .result(left));
  xmr_up_middle u_right(.a(b), .result(right));
  initial begin
    $dumpfile("upward.vcd");
    $dumpvars(0, xmr_up_tb);
    a = 0;
    b = 1;
    #2 a = 1;
    #2 b = 0;
    #2 $finish;
  end
endmodule
