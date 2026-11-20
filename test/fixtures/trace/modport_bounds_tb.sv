// SPDX-License-Identifier: MPL-2.0
interface bus;
  wire [141:138] wide;
  wire [301:298] wider;
  wire [-1:-4] neg;
  wire [7:0] bits;
  modport mp(input .w(wide[140:139]), input .wi(wide[140]), input .ww(wider[300:299]), input .wwi(wider[300]), input .n(neg[-2:-3]), input .ni(neg[-2]), input .z(bits[7:0]), input .zr(bits[0:0]), input .zi(bits[0]));
endinterface
module reader(bus.mp link, output wire [18:0] q);
  assign q = {link.w, link.wi, link.ww, link.wwi, link.n, link.ni, link.z, link.zr, link.zi};
endmodule
module bounds_tb;
  wire [18:0] q;
  bus x();
  reader r(x,q);
  assign x.wide = 4'b0110;
  assign x.wider = 4'b0110;
  assign x.neg = 4'b0110;
  assign x.bits = 8'b10000001;
  initial begin
    $dumpfile("bounds.vcd"); $dumpvars(0,bounds_tb);
    $fsdbDumpfile("bounds.fsdb"); $fsdbDumpvars(0,bounds_tb);
    #1 $display("fixed alias bounds = %b",q); $finish;
  end
endmodule
