// SPDX-License-Identifier: MPL-2.0
`timescale 1ns/1ns
module late_continuous_callback_tb;
    logic [1:0] a = 0, b = 0;
    logic q;
    assign q = a[1] || b[1];

    initial begin
        $dumpfile("trace.vcd");
        $dumpvars(0, late_continuous_callback_tb);
        #5 a = 2'b10;
        #0 b = 2'b10;
        #5 $finish;
    end
endmodule
