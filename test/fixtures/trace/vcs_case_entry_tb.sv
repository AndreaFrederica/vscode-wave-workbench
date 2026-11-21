// SPDX-License-Identifier: MPL-2.0
`timescale 1ns/1ns
module case_entry_tb;
    logic clk = 0;
    logic [3:0] sel = 0, sz = 0, sx = 0, si = 0;
    logic [7:0] a = 0, b = 0, q, qz, qx, qi, delayed_q;

    always @(posedge clk) begin
        case (sel)
            4'b0101: begin : matched
                sel = 0;
                q <= a;
            end
            default: q <= b;
        endcase
        casez (sz)
            4'b10?1: begin
                sz = 0;
                qz <= a;
            end
            default: qz <= b;
        endcase
        casex (sx)
            4'b10?1: begin
                sx = 0;
                qx <= a;
            end
            default: qx <= b;
        endcase
        case (si) inside
            [4'd4:4'd6]: begin
                si = 0;
                qi <= a;
            end
            default: qi <= b;
        endcase
    end

    always @(posedge clk)
        case (sel)
            default: begin
                #1;
                delayed_q <= b;
            end
        endcase

    initial begin
        $dumpfile("live.vcd");
        $dumpvars(0, case_entry_tb);
        #2 sel = 4'b0101;
        sz = 4'b10z1;
        sx = 4'b1x01;
        si = 4'b0110;
        a = 8'h3c;
        #3 clk = 1;
        #1 clk = 0;
        #1 b = 8'h5a;
        #2 clk = 1;
        #1 clk = 0;
        #2 $finish;
    end
endmodule
