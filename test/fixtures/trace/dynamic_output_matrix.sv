`timescale 1ns/1ns
module lane(input wire [1:0] data, output wire [1:0] result);
  assign result = data;
endmodule
module ports;
  logic [1:0] data = 1;
  logic [3:0] idx = 0;
  wire [7:0] plain, expr, minus;
  wire [0:7] asc;
  wire [11:4] offset;
  lane a(.data(data),.result(plain[idx+:2]));
  lane b(.data(data),.result(expr[(idx+1)+:2]));
  lane c(.data(data),.result(minus[(idx+1)-:2]));
  lane d(.data(data),.result(asc[idx+:2]));
  lane e(.data(data),.result(offset[(idx+4)+:2]));
  initial begin
    $dumpfile("ports.vcd");
    $dumpvars(0, ports);
    #2 idx = 2;
    data = 2;
    #2 $finish;
  end
endmodule
