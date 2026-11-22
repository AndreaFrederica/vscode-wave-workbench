`timescale 1ns/1ns
module lane(input logic [1:0] data, output wire [1:0] result);
  assign result = data;
endmodule

module dynamic_output_tb;
  logic [1:0] data = 2'b01;
  logic [1:0] idx = 0;
  wire [3:0] bus;
  lane dut(.data(data), .result(bus[idx+:2]));
  initial begin
    $dumpfile("dynamic.vcd");
    $dumpvars(0, dynamic_output_tb);
    #2;
    idx = 2;
    data = 2'b10;
    #2 $finish;
  end
endmodule
