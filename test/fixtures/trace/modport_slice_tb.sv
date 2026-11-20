// SPDX-License-Identifier: MPL-2.0
interface channel;
  wire [7:4] datum;
  wire [0:3] ascending;
  modport sender(output .tx(datum[7:6]), output .low(datum[5:4]), output .order(ascending[1:2]));
  modport receiver(input .rx(datum[7:6]), input .low(datum[5:4]), input .order(ascending[1:2]));
endinterface
module source(input logic [1:0] high, low, asc, channel.sender link);
  assign link.tx = high;
  assign link.low = low;
  assign link.order = asc;
endmodule
module sink(channel.receiver link, output wire [1:0] p, n, ordered);
  assign p = link.rx;
  assign n = link.low;
  assign ordered = link.order;
endmodule
module slice_tb;
  logic [1:0] a=0,b=0,c=0;
  wire [1:0] p,n,o;
  channel x();
  source tx(a,b,c,x);
  sink rx(x,p,n,o);
  initial begin
    $dumpfile("slice.vcd"); $dumpvars(0,slice_tb);
    $fsdbDumpfile("slice.fsdb"); $fsdbDumpvars(0,slice_tb);
    #1 a=2'b10;
    #1 b=2'b01;
    #1 c=2'b11;
    #1 $finish;
  end
endmodule
