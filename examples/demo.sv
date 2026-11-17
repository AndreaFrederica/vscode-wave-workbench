module dut(input logic clk, rst_n, output logic [7:0] data, output logic valid);
  always_ff @(posedge clk or negedge rst_n) begin
    if (!rst_n) begin data <= '0; valid <= 0; end
    else begin data <= data + 1; valid <= 1; end
  end
endmodule
