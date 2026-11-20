// SPDX-License-Identifier: MPL-2.0
`timescale 1ps/1ps
module sampled_pipe_tb(input bit clk, value, output bit first_q, second_q);
  always @(posedge clk) begin
    first_q <= value;
    second_q <= first_q;
  end
endmodule
