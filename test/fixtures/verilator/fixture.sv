package shapes;
  typedef enum bit [1:0] {IDLE, BUSY} state_t;
endpackage
module leaf #(parameter W=4)(input logic clk, output logic [W-1:0] pc);
  shapes::state_t state;
  initial pc = '0;
  always @(posedge clk) begin
    pc <= pc + 1'b1;
    state <= pc[0] ? shapes::BUSY : shapes::IDLE;
  end
  for (genvar i=0; i<2; ++i) begin: stages
    wire s = pc[i];
    sub u1(s);
  end
endmodule
module sub(input wire flag);
endmodule
module top(input logic clk, output wire [3:0] left, output wire [7:0] right);
  leaf #(.W(4)) u0(clk, left);
  leaf #(.W(8)) u1(clk, right);
  for(genvar i=0; i<2; ++i) begin: slots
    sub gen_sub(clk);
  end
endmodule
