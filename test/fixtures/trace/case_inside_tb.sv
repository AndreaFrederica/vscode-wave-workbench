// SPDX-License-Identifier: MPL-2.0
`timescale 1ns/1ns
module case_inside_tb;
    logic clk = 0;
    logic [3:0] sel;
    logic signed [3:0] signed_sel = 4'sd1;
    logic [7:0] a, b, c, q, signed_q;

    always @(posedge clk) begin
        case (sel) inside
            default: q <= c;
            [4'd4:4'd6], 4'b10?1: q <= a;
            4'b01??, 4'b10??: q <= b;
        endcase

        case (signed_sel) inside
            [4'sb1110:4'sd2]: signed_q <= a;
            8'b11111111: signed_q <= b;
            default: signed_q <= c;
        endcase
    end

    task automatic sample(input logic [3:0] select, input logic [7:0] offset);
        sel = select;
        a = 8'h10 + offset;
        b = 8'h20 + offset;
        c = 8'h30 + offset;
        #2 clk = 1;
        #1 clk = 0;
        #1;
    endtask

    initial begin
        $dumpfile("case_inside.vcd");
        $dumpvars(0, case_inside_tb);
        #1;
        sample(4'b0101, 0);
        sample(4'b0111, 1);
        sample(4'b10z1, 2);
        sample(4'b1x01, 3);
        sample(4'b10z0, 4);
        sample(4'b0010, 5);
        $finish;
    end
endmodule
