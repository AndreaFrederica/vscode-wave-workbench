module leaf(input logic d, en, clk, output logic q);
  always @(posedge clk) if (en) q <= d;
endmodule

module inout_leaf(inout wire z);
endmodule

module legacy(d, clk, q);
  input d, clk;
  output reg q;
  always @(posedge clk) q <= d;
endmodule

module ports_tb;
  logic a=0, b=0, clk=0, en=1;
  logic d=1;
  wire p, n, q, other, opt, cat, legacy_q, z;
  leaf lx(.d(a), .en, .clk, .q(p));
  leaf ly(b, en, clk, n);
  leaf lw(.*);
  leaf lo(.d(), .en(en), .clk(clk), .q(opt));
  leaf ls(.d({a,b}), .en(en), .clk(clk), .q(cat));
  inout_leaf io(z);
  legacy ld(b, clk, legacy_q);
  if (1) begin : gen
    logic internal;
    assign internal = b;
    leaf lg(.d(internal), .en(en), .clk(clk), .q(other));
  end
  initial begin
    $dumpfile("ports.vcd");
    $dumpvars;
`ifdef WAVE_TEST_FSDB
    $fsdbDumpfile("ports.fsdb");
    $fsdbDumpvars(0, ports_tb);
`endif
    #1 a=1;
    #1 clk=1;
    #1 clk=0;
    #1 a=0; b=1;
    #1 clk=1;
    #1 $finish;
  end
endmodule
