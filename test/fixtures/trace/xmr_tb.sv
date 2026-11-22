`timescale 1ns/1ns
module xmr_tb;
  logic a, b, stimulus;
  wire p, p_other, q_port, q_local, q_pair, q_indexed, q_written, q_follow;
  xmr_leaf u_leaf(.a(a), .p(p));
  xmr_leaf u_other(.a(b), .p(p_other));
  for (genvar i = 0; i < 2; i++) begin : lane
    xmr_leaf u_indexed(.a(i == 0 ? a : b), .p());
  end
  assign q_port = u_leaf.p;
  assign q_local = u_leaf.local_value;
  assign q_follow = q_local;
  assign q_pair = u_leaf.local_value ^ u_other.local_value;
  assign q_indexed = lane[1].u_indexed.local_value;
  always_comb u_leaf.external_value = stimulus;
  assign q_written = u_leaf.external_value;
  initial begin
    $dumpfile("xmr.vcd");
    $dumpvars(0, xmr_tb);
    a = 0;
    b = 0;
    stimulus = 0;
    #2 a = 1;
    #2 b = 1;
    stimulus = 1;
    #2 $finish;
  end
endmodule
