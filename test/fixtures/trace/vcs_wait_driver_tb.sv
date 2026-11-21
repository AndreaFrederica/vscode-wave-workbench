// SPDX-License-Identifier: MPL-2.0
`timescale 1ns/1ns
module wait_driver_tb;
    logic clk = 0;
    logic ready = 0, inhibit = 1, rescue = 0, select_path = 0;
    logic trigger_value = 1, later_value = 1;
    logic [7:0] d = 0, q, q_direct;

    always @(posedge clk) begin : delayed_update
        wait (ready && (!inhibit || rescue));
        #3;
        q <= d;
    end

    always @(posedge clk)
        case (select_path)
            1'b1: begin
                wait (ready && (!inhibit || rescue)) q_direct <= d;
            end
            default: ;
        endcase

    initial begin
        $dumpfile("live.vcd");
        $dumpvars(0, wait_driver_tb);
        #2 select_path = 1;
        #1 trigger_value = 0;
        #1 d = 8'h51;
        #1 clk = 1;
        #1 clk = 0;
        ready = 1;
        #1;
        inhibit = trigger_value;
        #0;
        inhibit = later_value;
        #0;
        inhibit = trigger_value;
        d = 8'ha7;
        #5 $finish;
    end
endmodule
