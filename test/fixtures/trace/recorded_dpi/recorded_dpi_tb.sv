`timescale 1ps/1ps
module recorded_dpi_tb(input bit clk, input int input_arg, output int result, side_effect);
  import "DPI-C" context function int adjust(input int source, output int side);
  always @(posedge clk) begin
    result = adjust(input_arg, side_effect);
  end
endmodule
