module select_dut(
  input logic clk, rst_n, en, replace, mode,
  input logic [1:0] sel,
  input logic [3:0] a, b, c, d, e,
  output logic [3:0] q, comb
);
  logic [3:0] acc = 0;
  wire [3:0] a_copy = a;
  always_comb begin
    case (sel)
      0: comb = a_copy;
      1: comb = b;
      default: comb = c;
    endcase
  end
  always @(posedge clk or negedge rst_n) begin
    if (!rst_n)
      q <= 0;
    else if (en) begin
      if (mode)
        q <= comb;
      else begin
        q <= d;
        if (replace) q <= e;
      end
    end
  end
  always @(posedge clk)
    if (en) acc += a;
endmodule

module driver_load_tb;
  logic clk=0,rst_n=1,en=0,replace=0,mode=0;
  logic [1:0] sel=0;
  logic [3:0] a=1,b=2,c=3,d=4,e=5;
  wire [3:0] q, comb;
  select_dut dut(.*);
  initial begin
    $dumpfile("trace.vcd");
    $dumpvars(0,driver_load_tb);
    #1 rst_n=0;
    #1 rst_n=1; en=1; replace=1;
    #1 clk=1;
    #1 clk=0; en=0;
    #1 clk=1;
    #1 clk=0; en=1; mode=1; sel=1;
    #1 clk=1;
    #1 clk=0; sel=2;
    #1 clk=1;
    #1 rst_n=0;
    #1 $finish;
  end
endmodule
