// SPDX-License-Identifier: MPL-2.0
interface nested_channel;
  logic [7:4] data;
  logic [0:3] ascending;
  modport send(output .joined({{data[7:6], ascending[1]}, {data[5:4], ascending[2]}}));
  modport receive(input .joined({data[7], {ascending[1:2], {data[4], data[7]}}}));
endinterface
module nested_writer(input logic [5:0] d, nested_channel.send bus_if);
  assign bus_if.joined = d;
endmodule
module nested_reader(nested_channel.receive bus_if, output wire [4:0] q);
  assign q = bus_if.joined;
endmodule
interface overlap_channel;
  logic [3:0] data;
  logic bypass;
  modport send(output .joined({{data[3:1], bypass}, data[2:0]}));
  modport receive(input data, input bypass);
endinterface
module overlap_writer(input logic [6:0] d, input logic enable, overlap_channel.send bus_if);
  always @(enable) if (enable) bus_if.joined = d;
endmodule
module overlap_reader(overlap_channel.receive bus_if, output wire [3:0] value,
                      output wire bypass);
  assign value = bus_if.data;
  assign bypass = bus_if.bypass;
endmodule
module nested_tb;
  logic [5:0] a = 0;
  logic [6:0] b = 0;
  nested_channel nested();
  overlap_channel overlap();
  wire [4:0] q;
  wire [3:0] overlap_value;
  wire bypass;
  nested_writer src(a,nested);
  nested_reader sink(nested,q);
  logic first = 0;
  logic second = 0;
  logic [6:0] c = 7'b0100011;
  overlap_writer writer(b,first,overlap);
  overlap_writer writer2(c,second,overlap);
  overlap_reader observed(overlap,overlap_value,bypass);
  initial begin
    $dumpfile("nested.vcd"); $dumpvars(0,nested_tb);
    $fsdbDumpfile("nested.fsdb"); $fsdbDumpvars(0,nested_tb);
    #1 a = 6'b101001;
       b = 7'b1110000;
    #1 a = 6'b010011;
       b = 7'b0001111;
    #1 b = 7'b1000101; first = 1;
    #0 second = 1;
    #1 $finish;
  end
endmodule
