// SPDX-License-Identifier: MPL-2.0
`timescale 1ps/1ps
module order(output wire [1:0] bus);
 logic low = 0;
 logic high = 0;
 logic [1:0] vec_value = 0;
 assign bus = {high, low};
 initial begin
  #5 low=1; vec_value=1; #0 high=1; vec_value=3;
  #0 low=0; vec_value=2; #0 high=0; vec_value=0;
  #5 $finish;
 end
endmodule
