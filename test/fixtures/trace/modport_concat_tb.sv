// SPDX-License-Identifier: MPL-2.0
interface channel;
  logic [7:4] datum;
  logic [0:3] ascending;
  modport sender(output .pair({datum[4], ascending[2]}), output .other(datum[7]));
  modport receiver(input .pair({datum[4], ascending[2]}),
                   input .with_repeat({datum[4], ascending[2], datum[7], datum[4]}));
endinterface
module source(input logic [1:0] data, input logic extra, channel.sender link);
  assign link.pair = data;
  assign link.other = extra;
endmodule
module sink(channel.receiver link, output wire [1:0] pair, output wire [3:0] combined);
  assign pair = link.pair;
  assign combined = link.with_repeat;
endmodule
module concat_tb;
  logic [1:0] a = 0;
  logic b = 0;
  wire [1:0] p;
  wire [3:0] r;
  channel x();
  source tx(a,b,x);
  sink rx(x,p,r);
  initial begin
    $dumpfile("concat.vcd"); $dumpvars(0,concat_tb);
    $fsdbDumpfile("concat.fsdb"); $fsdbDumpvars(0,concat_tb);
    #1 a = 2'b10;
    #1 a = 2'b11;
    #1 b = 1'b1;
    #1 $finish;
  end
endmodule
