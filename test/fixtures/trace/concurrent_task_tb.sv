`timescale 1ns/1ns
package task_trace_probe;
  import "DPI-C" context function void wave_workbench_write(input string site, input string bits, input bit committed);
  import "DPI-C" context function void wave_workbench_begin_evaluation(input string site);
  import "DPI-C" context function void wave_workbench_file_read(input string site, input int offset, input int value);
endpackage

module concurrent_task_tb;
  import task_trace_probe::*;
  typedef struct packed { logic [7:0] data; } payload_t;
  payload_t bus;
  wire [7:0] result;
  assign result = bus.data;

  task automatic send(input logic [7:0] data, input int index);
    wave_workbench_write("argument", $sformatf("%b", data), 0);
    wave_workbench_write("argument", $sformatf("%b", data), 1);
    wave_workbench_write("argument_index", $sformatf("%b", index), 0);
    wave_workbench_write("argument_index", $sformatf("%b", index), 1);
    #2;
    if (index == 1) #0;
    wave_workbench_write("write", $sformatf("%b", data), 0);
    bus.data = data;
    wave_workbench_write("write", $sformatf("%b", bus.data), 1);
    wave_workbench_write("write_index", $sformatf("%b", index), 0);
    wave_workbench_write("write_index", $sformatf("%b", index), 1);
  endtask

  initial begin : run
    int fd, byte_offset, first_value, second_value;
    bus = '0;
    $dumpfile("task.vcd");
    $dumpvars(0, concurrent_task_tb);
    fd = $fopen("stimulus.bin", "rb");
    wave_workbench_begin_evaluation("read_first");
    byte_offset = $ftell(fd);
    first_value = $fgetc(fd);
    wave_workbench_file_read("read.first", byte_offset, first_value);
    wave_workbench_write("read_first", $sformatf("%b", 8'(first_value)), 0);
    wave_workbench_write("read_first", $sformatf("%b", 8'(first_value)), 1);
    wave_workbench_begin_evaluation("read_second");
    byte_offset = $ftell(fd);
    second_value = $fgetc(fd);
    wave_workbench_file_read("read.second", byte_offset, second_value);
    wave_workbench_write("read_second", $sformatf("%b", 8'(second_value)), 0);
    wave_workbench_write("read_second", $sformatf("%b", 8'(second_value)), 1);
    $fclose(fd);
    #1;
    for (int i = 1; i <= 2; i++) fork
      automatic int index = i;
      send(8'(index == 1 ? first_value : second_value), index);
    join_none
    wait fork;
    #1 $finish;
  end
endmodule
