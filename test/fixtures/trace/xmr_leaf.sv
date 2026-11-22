`timescale 1ns/1ns
module xmr_leaf(input wire a, output wire p);
  wire local_value;
  logic external_value;
  assign local_value = a;
  assign p = a;
endmodule
