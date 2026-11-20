// SPDX-License-Identifier: MPL-2.0

interface channel;
  logic data;
  modport sender(output .tx(data));
  modport receiver(input .rx(data));
endinterface
module array_source(input logic a, b, channel.sender link[7:6]);
  assign link[7].tx = a;
  assign link[6].tx = b;
endmodule
module array_sink(channel.receiver link[-1:0], output wire p, n);
  assign p = link[-1].rx;
  assign n = link[0].rx;
endmodule
module array_tb;
  logic a=0,b=0;
  wire p,n;
  channel channels[4:5]();
  array_source src(a,b,channels);
  array_sink sink(channels,p,n);
  initial begin
    $dumpfile("array.vcd"); $dumpvars(0,array_tb);
    $fsdbDumpfile("array.fsdb"); $fsdbDumpvars(0,array_tb);
    #1 a=1;
    #2 b=1;
    #2 $finish;
  end
endmodule
