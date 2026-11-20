// SPDX-License-Identifier: MPL-2.0
`timescale 1ps/1ps
module pass #(parameter WIDTH=4)(input wire [WIDTH-1:0] a, output wire [WIDTH-1:0] q);
  assign q = a;
endmodule
module pass_bit #(parameter WIDTH=4)(input bit [WIDTH-1:0] a, output wire [WIDTH-1:0] q);
  assign q = a;
endmodule
module expr_tb;
  logic [0:3] data = '0;
  logic [1:0] mask = '0;
  logic enable = 0;
  logic unrelated_data = 0;
  logic [1:0] index = 1;
  logic [1:0] offset = 0;
  logic signed [1:0] signed_data = 0, signed_mask = 0;
  wire [3:0] concat_out, binary_out, mixed_out, signed_out;
  wire [2:0] compact_out;
  wire [3:0] coerced_out, mixed_literal_out, unused, repeated;
  wire [4:0] ordered_out;
  wire complex_bit;
  wire [1:0] complex_up, complex_down;
  wire [7:0] repeated_slice;
  wire [1:0] zero_repeat;
  localparam REPEATS = 2;
  pass concat_inst(.a({data[1:2], 1'bz, enable}), .q(concat_out));
  pass binary_inst(.a(data & {2'b10, mask} | 4'b0001), .q(binary_out));
  pass mixed_inst(.a({{data[index], 1'b1}, ~(mask ^ 2'b10)}), .q(mixed_out));
  pass signed_inst(.a(signed_data | signed_mask), .q(signed_out));
  pass_bit coerced_inst(.a(data ^ {mask, 2'bxx}), .q(coerced_out));
  pass mixed_literal_inst(.a(data ^ {mask, 2'bz1}), .q(mixed_literal_out));
  pass #(.WIDTH(3)) compact_inst(.a({data[1:2], 1'bz, enable}), .q(compact_out));
  pass unrelated_inst(.a({2'b0, enable, unrelated_data}), .q(unused));
  pass #(.WIDTH(5)) ordered_inst(.a({1'b1, enable, 1'b0, mask[0], data[3]}), .q(ordered_out));
  pass repeat_inst(.a({4{enable}}), .q(repeated));
  pass #(.WIDTH(8)) repeat_slice_inst(.a({REPEATS{data[1:2], 1'bz, enable}}), .q(repeated_slice));
  pass #(.WIDTH(2)) zero_repeat_inst(.a({data[0], {0{unrelated_data}}, enable}), .q(zero_repeat));
  pass #(.WIDTH(1)) complex_bit_inst(.a(data[index + offset]), .q(complex_bit));
  pass #(.WIDTH(2)) complex_up_inst(.a(data[(index ^ offset) +: 2]), .q(complex_up));
  pass #(.WIDTH(2)) complex_down_inst(.a(data[(index + offset - 1) -: 2]), .q(complex_down));
  initial begin
    $fsdbDumpfile("expr.fsdb");
    $fsdbDumpvars(0, expr_tb);
    #5 data = 4'b1110; mask = 2'b01; enable = 1; signed_data = 2'sb10;
    #1 index = 2; offset = 1; mask = 2'bx0; enable = 0;
    #1 data = 4'b10z1; signed_mask = 2'sb01; offset = 2'bx0;
    #1 index = 3; offset = 1;
    #1 $finish;
  end
endmodule
