// SPDX-License-Identifier: MPL-2.0
`timescale 1ns/1ns
module blocking_part_select_tb;
  logic [0:3] a = '0;
  logic [3:0] b = '0;
  logic signed [3:0] base = 1;
  logic [1:0] d = 2'b10;

  task automatic show_values;
    $display("tick=%0t base=%0d d=%b a=%b b=%b", $time, base, d, a, b);
  endtask

  initial begin
    $dumpfile("live.vcd");
    $dumpvars(0, blocking_part_select_tb);
    #2;
    a[base +: 2] = d;
    b[base -: 2] = d;
    show_values();
    #2 base = 3;
    a[base +: 2] = d;
    #2 base = 0;
    b[base -: 2] = d;
    show_values();
    #2 base = -1;
    a[base +: 2] = d;
    #2 base = 4;
    b[base -: 2] = d;
    show_values();
    #2 base = 'x;
    a[base +: 2] = d;
    b[base -: 2] = d;
    show_values();
    #2 $finish;
  end
endmodule
