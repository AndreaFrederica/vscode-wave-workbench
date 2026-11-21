// SPDX-License-Identifier: MPL-2.0
`timescale 1ns/1ns
module case_common_type_tb;
    logic clk = 0;
    logic signed [3:0] sel;
    logic [7:0] late_label = 0;
    logic [7:0] a, b, c, d, q, qz, qx;

    always @(posedge clk) begin
        case (sel)
            8'shff: q <= a;
            4'shf: q <= b;
            4'sb1x01: q <= d;
            late_label: q <= c;
            default: q <= c;
        endcase
        casez (sel)
            8'b000010?1: qz <= a;
            4'b10??: qz <= b;
            default: qz <= c;
        endcase
        casex (sel)
            8'b000010?1: qx <= a;
            4'b10??: qx <= b;
            default: qx <= c;
        endcase
    end

    task automatic sample(input logic [3:0] select, input logic [7:0] offset);
        sel = select;
        a = 8'h10 + offset;
        b = 8'h20 + offset;
        c = 8'h30 + offset;
        d = 8'h40 + offset;
        #2 clk = 1;
        #1 clk = 0;
        #1;
    endtask

    initial begin
        $dumpfile("case_common_type.vcd");
        $dumpvars(0, clk, sel, a, b, c, d, q, qz, qx);
        #1;
        sample(4'b1111, 0);
        sample(4'b10z1, 1);
        sample(4'b1x01, 2);
        sample(4'b10z0, 3);
        $finish;
    end
endmodule
