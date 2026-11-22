`timescale 1ns/1ns
interface channel;
  logic [7:4] data;
  modport consumer(input .selected({data[7], data[5:4]}));
endinterface

module receiver(channel.consumer link, output logic [2:0] result);
  assign result = link.selected;
endmodule

module wildcard_tb;
  channel link();
  logic [2:0] result;
  receiver sink(.*);
  initial begin
    $dumpfile("wildcard.vcd");
    $dumpvars(0, wildcard_tb);
    link.data = 4'b0000;
    #2 link.data = 4'b1011;
    #2 $finish;
  end
endmodule
