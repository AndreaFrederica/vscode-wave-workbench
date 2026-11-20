// SPDX-License-Identifier: MPL-2.0
`timescale 1ps/1ps

module emit_bus(input wire [5:0] src, output wire [0:5] q);
    assign q = src;
endmodule

module signed_lane(input wire [2:0] a, output wire signed [0:2] q);
    assign q = a;
endmodule

module unsigned_lane(input wire [2:0] a, output wire [2:0] q);
    assign q = a;
endmodule

module tb;
    logic [5:0] src = 0;
    wire [3:0] upper;
    wire [0:3] lane;
    wire tail_a, tail_b;
    logic [2:0] a = 0;
    wire [1:0] sign_hi, sign_lo, zero_hi, zero_lo;
    wire narrow_hi, narrow_lo;
    emit_bus dut(.src(src), .q({upper[2:1], lane[1:2], {tail_a, tail_b}}));
    signed_lane s(.a(a), .q({sign_hi, sign_lo}));
    unsigned_lane u(.a(a), .q({zero_hi, zero_lo}));
    signed_lane n(.a(a), .q({narrow_hi, narrow_lo}));
    assign upper[3] = 0;
    assign upper[0] = 0;
    assign lane[0] = 0;
    assign lane[3] = 0;

    initial begin
        $dumpfile("out.vcd");
        $dumpvars(0, tb);
        $fsdbDumpfile("out.fsdb");
        $fsdbDumpvars(0, tb);
        #2 {src, a} = {6'b100000, 3'b100};
        #3 {src, a} = {6'b001000, 3'b010};
        #3 {src, a} = {6'b000010, 3'b001};
        #3 src = 6'b000001;
        #2 $finish;
    end
endmodule
