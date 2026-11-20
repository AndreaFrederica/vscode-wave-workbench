// SPDX-License-Identifier: MPL-2.0

interface lane;
  logic data;
endinterface

interface other_lane;
  wire data;
endinterface

module source(input logic a, b, interface link[7:6]);
  assign link[7].data = a;
  assign link[6].data = b;
endmodule

module sink(interface link[-1:0], output wire p, n);
  assign p = link[-1].data;
  assign n = link[0].data;
endmodule

module generic_tb;
  logic a=0, b=0, c=0, d=0;
  wire p,n,r,s;
  lane x[4:5]();
  other_lane y[3:2]();
  source lx(a,b,x);
  source ly(c,d,y);
  sink rx(x,p,n);
  sink ry(y,r,s);
  initial begin
    $dumpfile("generic.vcd"); $dumpvars(0,generic_tb);
    $fsdbDumpfile("generic.fsdb"); $fsdbDumpvars(0,generic_tb);
    #1 a=1;
    #1 b=1;
    #1 c=1;
    #1 d=1;
    #1 $finish;
  end
endmodule
