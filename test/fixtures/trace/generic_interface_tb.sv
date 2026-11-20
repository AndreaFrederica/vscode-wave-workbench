// SPDX-License-Identifier: MPL-2.0

interface narrow_channel;
  logic data;
endinterface
interface alternate_channel;
  wire data;
endinterface

module source(input logic stimulus, interface link);
  assign link.data = stimulus;
endmodule
module sink(interface link, output wire result);
  assign result = link.data;
endmodule

module generic_tb;
  logic a=0,b=0;
  wire p,n;
  narrow_channel x();
  alternate_channel y();
  source lx(a,x), ly(b,y);
  sink rx(x,p), ry(y,n);
  initial begin
    $dumpfile("generic.vcd"); $dumpvars(0,generic_tb);
    $fsdbDumpfile("generic.fsdb"); $fsdbDumpvars(0,generic_tb);
    #1 a=1;
    #2 b=1;
    #2 $finish;
  end
endmodule
