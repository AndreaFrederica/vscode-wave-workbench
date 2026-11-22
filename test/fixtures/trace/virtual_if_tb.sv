interface channel_if;
  logic [3:0] data = 0;
  modport source(output data);
  modport sink(input data);
endinterface

module virtual_if_tb;
  channel_if left();
  channel_if right();
  virtual channel_if.source write_port;
  virtual channel_if.sink read_port;
  logic [3:0] stimulus = 3;
  logic [3:0] result = 0;

  initial begin
    $dumpfile("trace.vcd");
    $dumpvars(0, virtual_if_tb);
    write_port = left;
    read_port = left;
    #1 write_port.data = stimulus;
    #1 result = read_port.data;
    #1 write_port = right;
    read_port = right;
    stimulus = 9;
    #1 write_port.data = stimulus;
    #1 result = read_port.data;
    #1 $finish;
  end
endmodule
