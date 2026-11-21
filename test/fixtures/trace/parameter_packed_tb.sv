// SPDX-License-Identifier: MPL-2.0
`timescale 1ps/1ps
module lane #(parameter integer HIGH = 3)(input wire a, b, output wire q);
    wire [HIGH:0] middle = {a, b};
    assign q = middle[1] ^ middle[0];
endmodule

module tb;
    logic a = 0, b = 0;
    wire qshort, qlong;
    lane #(.HIGH(2)) short_lane(a, b, qshort);
    lane #(.HIGH(5)) long_lane(a, b, qlong);
    initial begin
        $dumpfile("full.vcd");
        $dumpvars(0, tb);
        #1 a = 1;
        #1 b = 1;
        #1 $finish;
    end
endmodule
