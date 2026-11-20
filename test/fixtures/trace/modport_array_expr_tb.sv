// SPDX-License-Identifier: MPL-2.0

interface trace_channel;
  logic data;
  modport sender(output .tx(data));
  modport receiver(input .rx(data));
endinterface

module array_source(input logic a, b, trace_channel.sender link[7:6]);
  wire [1:0] inputs_to_source = {b, a};
  for (genvar i=0; i<2; i++) begin : drive
    assign link[7-i].tx = inputs_to_source[i];
  end
endmodule

module array_sink(trace_channel.receiver link[-1:0], output wire p, n);
  assign p = link[-(2-1)].rx;
  assign n = link[2*2-4].rx;
endmodule

module array_tb;
  logic a=0,b=0;
  wire p,n;
  trace_channel channels[4:5]();
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
