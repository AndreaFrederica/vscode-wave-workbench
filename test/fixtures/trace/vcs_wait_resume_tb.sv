// SPDX-License-Identifier: MPL-2.0
`timescale 1ns/1ns
module wait_resume_tb;
    logic clk = 0;
    logic sel = 0;
    logic ready = 0;
    logic [7:0] d = 0, q;

    always @(posedge clk) begin
        case (sel)
            1'b1: begin : selected
                wait (ready) q <= d;
            end
            default: q <= 0;
        endcase
    end

    initial begin
        $dumpfile("live.vcd");
        $dumpvars(0, wait_resume_tb);
        #2 sel = 1;
        #3 clk = 1;
        #1 sel = 0;
        clk = 0;
        #2 d = 8'h6b;
        #1 ready = 1;
        #3 $finish;
    end
endmodule
