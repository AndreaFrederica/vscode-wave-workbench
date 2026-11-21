// SPDX-License-Identifier: MPL-2.0
`timescale 1ps/1ps
module leaf(output reg sig = 0);
 parameter integer DELTA = 0;
 initial begin
  #5;
  if (DELTA == 0) begin sig=1; #0; #0 sig=0; end
  else begin #0 sig=1; #0; #0 sig=0; end
 end
endmodule
module order(output wire [1:0] bus);
 leaf #(.DELTA(0)) a(bus[0]);
 leaf #(.DELTA(1)) b(bus[1]);
 initial #10 $finish;
endmodule
