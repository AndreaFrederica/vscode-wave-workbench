// SPDX-License-Identifier: MPL-2.0
`timescale 1ns/1ns
module timed_case_tb;
    logic clk = 0;
    logic sel = 0;
    logic [7:0] d = 0, q;

    always @(posedge clk) begin
        case (sel)
            1'b1: begin : selected
                #3;
                q <= d;
            end
            default: q <= 0;
        endcase
    end

    initial begin
        $dumpfile("live.vcd");
        $dumpvars(0, timed_case_tb);
        #2 sel = 1;
        #3 clk = 1;
        #1 sel = 0;
        clk = 0;
        #1 sel = 1;
        d = 8'h5a;
        #5 $finish;
    end
endmodule
