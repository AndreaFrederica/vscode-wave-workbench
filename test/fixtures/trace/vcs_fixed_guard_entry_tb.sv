// SPDX-License-Identifier: MPL-2.0
`timescale 1ns/1ns
module fixed_guard_tb;
    logic clk = 0;
    logic select_a = 0;
    logic [7:0] a = 0;
    logic [7:0] b = 0;
    logic [7:0] q;

    always @(posedge clk) begin
        if (select_a) begin : take_a
            select_a = 0;
            q <= a;
        end else q <= b;
    end

    initial begin
        $dumpfile("live.vcd");
        $dumpvars(0, fixed_guard_tb);
        #2 select_a = 1;
        a = 8'h3c;
        #3 clk = 1;
        #1 clk = 0;
        #1 b = 8'h5a;
        #2 clk = 1;
        #1 clk = 0;
        #2 $finish;
    end
endmodule
