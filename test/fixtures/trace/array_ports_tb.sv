// SPDX-License-Identifier: MPL-2.0
`timescale 1ps/1ps

module array_lane(input wire [1:0] i, input wire en, output wire [1:0] o);
    assign o = en ? i : 2'b00;
endmodule

module arrays_tb;
    logic [7:4] high = '0;
    logic [2:5] low = '0;
    logic [1:0] shared = '0;
    logic enable = 1;
    wire [5:8] desc_out;
    wire [9:6] asc_out;
    wire [7:0] slice_out;
    wire [3:0] literal_split, literal_broadcast;
    array_lane desc[3:2](.i(high), .en(enable), .o(desc_out));
    array_lane asc[-1:0](.i(low), .en(enable), .o(asc_out));
    array_lane slices[1:0](.i(shared), .en(enable), .o(slice_out[5:2]));
    array_lane constants[1:0](.i(4'b1001), .en(enable), .o(literal_split));
    array_lane broadcast[0:1](.i(2'sb10), .en(enable), .o(literal_broadcast));
    assign slice_out[7:6] = '0;
    assign slice_out[1:0] = '0;

    initial begin
        $fsdbDumpfile("arrays.fsdb");
        $fsdbDumpvars(0, arrays_tb);
        #5 high = 4'b1001;
        low = 4'b0110;
        shared = 2'b11;
        #2 $finish;
    end
endmodule
