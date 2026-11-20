// SPDX-License-Identifier: MPL-2.0
`timescale 1ps/1ps

module port_slice_dut(
    input logic [1:0] request,
    input logic masked,
    input logic constant_select,
    output wire [1:0] result,
    output wire observed_masked
);
    assign result = constant_select ? request : 2'b00;
    assign observed_masked = masked;
endmodule

module port_slice_tb;
    logic [0:7] tb_request = '0;
    logic mask_enabled = 1'b0;
    logic feedback = 1'b0;
    wire [7:0] dut_response;
    wire observed_masked;
    port_slice_dut dut(
        .request(tb_request[2:3]),
        .masked(tb_request[3] & mask_enabled),
        .constant_select(1'b1),
        .result(dut_response[5:4]),
        .observed_masked(observed_masked)
    );
`ifdef WAVE_TEST_KDB_PACKED
    wire [1:0] indexed, signed_value, unsigned_value, unknown_value, fill_value, reverse_index;
    wire one_bit, dynamic_bit;
    wire [1:0] ascending_plus, ascending_minus, descending_plus, descending_minus;
    wire [3:0] widened;
    wire [1:0] narrowed, coerced;
    wire [7:0] signed_bus;
    wire [3:0] whole_signed_input, whole_unsigned_input, whole_signed_output;
    wire [1:0] whole_narrowed, whole_coerced;
    logic [2:0] index = 2;
    logic signed [3:0] signed_index = -1;
    logic [7:0] descending_data = 8'b10101100;
    localparam integer PART_WIDTH = 2;
    logic [1:0] mixed = 2'bxz;
    logic signed [1:0] whole_signed = 0;
    logic [1:0] whole_unsigned = 0;
    logic [3:0] whole_truncation = 0;
    pass two(.a(tb_request[3 -: 2]), .q(indexed));
    pass rev(.a(tb_request[2 +: 2]), .q(reverse_index));
    pass signed_const(.a(1'sb1), .q(signed_value));
    pass unsigned_const(.a(1'b1), .q(unsigned_value));
    pass unknown_const(.a(2'bxz), .q(unknown_value));
    pass fill(.a('1), .q(fill_value));
    single bit_x(.a(tb_request[2]), .q(one_bit));
    single bit_dynamic(.a(tb_request[index]), .q(dynamic_bit));
    pass range_asc_plus(.a(tb_request[index +: PART_WIDTH]), .q(ascending_plus));
    pass range_asc_minus(.a(tb_request[index -: 2]), .q(ascending_minus));
    pass range_desc_plus(.a(descending_data[signed_index +: 2]), .q(descending_plus));
    pass range_desc_minus(.a(descending_data[index -: 2]), .q(descending_minus));
    pass_wide widen(.a(tb_request[2:3]), .q(widened));
    pass narrow(.a(tb_request[0:2]), .q(narrowed));
    pass_signed extend_output(.a(tb_request[2:3]), .q(signed_bus[5:2]));
    pass_two_state convert(.a(mixed[1:0]), .q(coerced));
    pass_whole #(.WIDTH(4)) whole_widen_signed(.a(whole_signed), .q(whole_signed_input));
    pass_whole_signed_input whole_widen_unsigned(.a(whole_unsigned), .q(whole_unsigned_input));
    pass_signed whole_extend_output(.a(whole_unsigned), .q(whole_signed_output));
    pass whole_narrow(.a(whole_truncation), .q(whole_narrowed));
    pass_two_state whole_convert(.a(mixed), .q(whole_coerced));
    assign signed_bus[7:6] = '0;
    assign signed_bus[1:0] = '0;
`endif
    assign dut_response[7:6] = '0;
    assign dut_response[3:0] = '0;
    always @(posedge mask_enabled)
        feedback <= feedback ^ tb_request[2];

    initial begin
`ifdef WAVE_TEST_KDB_PACKED
        $fsdbDumpfile("port_slice.fsdb");
        $fsdbDumpvars(0, port_slice_tb);
`else
        $dumpfile("port_slice.fst");
        $dumpvars;
`endif
        #5 tb_request[2:3] = 2'b10;
`ifdef WAVE_TEST_KDB_PACKED
        mixed = 2'b1x;
        whole_signed = 2'sb10;
        whole_unsigned = 2'b10;
        whole_truncation = 4'b1001;
`endif
        #1 mask_enabled = 1'b1;
`ifdef WAVE_TEST_KDB_PACKED
        index = 3;
        signed_index = 2;
        #1 index = 3'bxxx;
        signed_index = 4'bzzzz;
        #1 index = 7;
        signed_index = 7;
        #1 index = 0;
`endif
        #1 $finish;
    end
endmodule

`ifdef WAVE_TEST_KDB_PACKED
module pass(input [1:0] a, output [1:0] q); assign q=a; endmodule
module single(input a, output q); assign q=a; endmodule
module pass_wide(input [3:0] a, output [3:0] q); assign q=a; endmodule
module pass_signed(input [1:0] a, output wire signed [1:0] q); assign q=a; endmodule
module pass_two_state(input bit [1:0] a, output [1:0] q); assign q=a; endmodule
module pass_whole #(parameter WIDTH = 2)(input [WIDTH-1:0] a, output [WIDTH-1:0] q); assign q=a; endmodule
module pass_whole_signed_input(input wire signed [3:0] a, output [3:0] q); assign q=a; endmodule
`endif
