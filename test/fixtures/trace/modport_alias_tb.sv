interface channel;
  logic datum, alternative;
  modport sender(output .tx_data(datum));
  modport receiver(input .rx_data(datum));
  modport subset(input .low(datum));
endinterface
module source(input logic a, channel.sender link);
  assign link.tx_data = a;
endmodule
module sink(input logic clk, channel.receiver link, output logic q);
  always @(posedge clk) q <= link.rx_data;
endmodule
module alias_tb;
  logic a=0, b=0, clk=0;
  wire p,n, px;
  channel x(), y();
  source sx(a,x), sy(b,y);
  sink rx(clk,x,p), ry(clk,y,n);
  initial begin
    $dumpfile("alias.vcd");
    $dumpvars;
    #1 a = 1;
    #1 clk = 1;
    #1 clk = 0;
    #1 b = 1;
    #1 clk = 1;
    #1 $finish;
  end
endmodule
