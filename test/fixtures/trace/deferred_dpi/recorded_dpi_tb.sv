`timescale 1ps/1ps
module recorded_dpi_tb(input bit clk, input int input_arg, output int result, side_effect);
  import "DPI-C" context function int consume(output int side);
  import "DPI-C" function void launch(input int value);
  always @(posedge clk) begin
    result = consume(side_effect);
    launch(input_arg);
  end
endmodule
