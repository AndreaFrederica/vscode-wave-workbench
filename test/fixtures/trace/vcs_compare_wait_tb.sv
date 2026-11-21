// SPDX-License-Identifier: MPL-2.0
`timescale 1ns/1ns
module compare_wait_tb;
    logic clk = 0;
    logic ready = 0, select_path = 0;
    logic [3:0] status = 4'b00x1;
    logic signed [3:0] balance = 0;
    logic [7:0] d = 0, q, q_direct;

    always @(posedge clk) begin : delayed_update
        wait (ready && ((status & 4'b1011) === 4'b10x1) && balance < 4'sd0);
        #3;
        q <= d;
    end

    always @(posedge clk)
        case (select_path)
            1'b1: begin
                wait (ready && ((status & 4'b1011) === 4'b10x1)
                      && balance < 4'sd0) q_direct <= d;
            end
            default: ;
        endcase

    initial begin
        $dumpfile("live.vcd");
        $dumpvars(0, compare_wait_tb);
        #2 select_path = 1;
        #2 d = 8'h51;
        #1 clk = 1;
        #1 clk = 0;
        ready = 1;
        balance = 4'shF;
        #1 status = 4'b11x1;
        #1 status = 4'b00x1;
        #1 status = 4'b11x1;
        d = 8'ha7;
        #5 $finish;
    end
endmodule
