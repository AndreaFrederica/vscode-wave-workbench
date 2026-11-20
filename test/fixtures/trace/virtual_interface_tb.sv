// SPDX-License-Identifier: MPL-2.0
interface channel;
  logic data;
  modport reader(input .value(data));
endinterface
module virtual_tb;
  channel x(), y();
  virtual channel.reader view_handle;
  logic p = 0;
  initial begin
    $dumpfile("virtual.vcd");
    $dumpvars(0,virtual_tb);
    $fsdbDumpfile("virtual.fsdb");
    $fsdbDumpvars(0,virtual_tb);
    x.data = 0;
    y.data = 1;
    view_handle = x.reader;
    #1 p = view_handle.value;
    #1 view_handle = y.reader;
    #1 p = view_handle.value;
    #1 y.data = 0;
    #1 p = view_handle.value;
    #1 $finish;
  end
endmodule
