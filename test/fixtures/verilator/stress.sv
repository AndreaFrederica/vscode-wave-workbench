module top(input logic clk, input logic [63:0] seed [32],
           output wire [63:0] holding);
  assign holding = 64'h87654321f0e1d2c3;
  for (genvar i=0; i<256; i++) begin: bank
    wire [63:0] plus_offset = seed[i%32] + i;
    wire [63:0] flipped = ~plus_offset;
    wire even = plus_offset[0];
    wire odd = plus_offset[1];
    wire parity = ^plus_offset;
    wire zero = ~|plus_offset;
  end
endmodule
