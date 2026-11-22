`timescale 1ns/1ns
module xmr_up_leaf(input wire write_value, output wire result);
  assign result = xmr_up_middle.shared_value;
  always_comb xmr_up_middle.external_value = write_value;
endmodule
