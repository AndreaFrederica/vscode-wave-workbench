// SPDX-License-Identifier: MPL-2.0

interface trace_channel;
  logic data;
  modport sender(output .tx(data));
  modport receiver(input .rx(data));
endinterface

module indexed_source #(parameter int BASE=8)(input logic a, trace_channel.sender link[7:6]);
  localparam int DEST = BASE - 1;
  assign link[DEST].tx = a;
endmodule

module indexed_sink #(parameter int DEST=-1)(trace_channel.receiver link[-1:0], output wire q);
  assign q = link[DEST].rx;
endmodule

module array_tb;
  logic a=0, b=0;
  wire p,n;
  trace_channel channels[4:5]();
  indexed_source lx(a,channels);
  indexed_source #(.BASE(7)) ly(b,channels);
  indexed_sink rx(channels,p);
  indexed_sink #(.DEST(0)) ry(channels,n);
  initial begin
    $dumpfile("array.vcd"); $dumpvars(0,array_tb);
    $fsdbDumpfile("array.fsdb"); $fsdbDumpvars(0,array_tb);
    #1 a=1;
    #2 b=1;
    #2 $finish;
  end
endmodule
