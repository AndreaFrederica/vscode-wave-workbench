// SPDX-License-Identifier: MPL-2.0
`timescale 1ns/1ns
module standalone_wait_tb;
    logic clk = 0;
    logic ready = 0;
    logic [7:0] d = 0, q;

    always @(posedge clk) begin : update
        wait (ready);
        #3;
        q <= d;
    end

    initial begin
        $dumpfile("live.vcd");
        $dumpvars(0, standalone_wait_tb);
        #5 clk = 1;
        #1 clk = 0;
        #1 ready = 1;
        #1 ready = 0;
        #1 ready = 1;
        d = 8'ha7;
        #5 $finish;
    end
endmodule
