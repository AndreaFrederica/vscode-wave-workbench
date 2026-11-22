`timescale 1ns/1ns
module xmr_parameter_pick #(parameter integer SELECT = 0)
    (input wire a, b, output wire result, result_expr);
  for (genvar i = 0; i < 2; i++) begin : lane
    xmr_leaf u_indexed(.a(i == 0 ? a : b), .p());
  end
  assign result = lane[SELECT].u_indexed.local_value;
  assign result_expr = lane[(SELECT + 1) % 2].u_indexed.local_value;
endmodule

module xmr_parameter_tb;
  logic a, b;
  wire left, right, left_expr, right_expr;
  xmr_parameter_pick u_left(.a(a), .b(b), .result(left), .result_expr(left_expr));
  xmr_parameter_pick #(.SELECT(1)) u_right(.a(a), .b(b), .result(right), .result_expr(right_expr));
  initial begin
    $dumpfile("parameter.vcd");
    $dumpvars(0, xmr_parameter_tb);
    a = 0;
    b = 0;
    #2 a = 1;
    #2 b = 1;
    #2 $finish;
  end
endmodule
