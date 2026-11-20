// SPDX-License-Identifier: MPL-2.0
interface lane;
  wire data, unused;
  modport sender(output .tx(data));
  modport receiver(input .rx(data));
endinterface
module source(input logic stimulus, interface link);
  assign link.tx = stimulus;
endmodule
module sink(interface link, output wire result);
  assign result = link.rx;
endmodule
module typed_source(input logic stimulus, lane.sender link);
  source inner(stimulus,link);
endmodule
module typed_sink(lane.receiver link, output wire result);
  sink inner(link,result);
endmodule
module generic_tb;
  logic a=0,b=0;
  wire p,n;
  lane x(), y();
  source lx(a,x.sender);
  sink rx(x.receiver,p);
  typed_source ly(b,y);
  typed_sink ry(y,n);
  initial begin
    $dumpfile("generic.vcd"); $dumpvars(0,generic_tb);
    $fsdbDumpfile("generic.fsdb"); $fsdbDumpvars(0,generic_tb);
    #1 a=1;
    #2 b=1;
    #2 $finish;
  end
endmodule
