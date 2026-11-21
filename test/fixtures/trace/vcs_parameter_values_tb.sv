// SPDX-License-Identifier: MPL-2.0

module param_dut #(
  parameter logic signed [8:0] DELTA = -9'sd2,
  parameter logic [67:0] WIDE = 68'hdecaf0123456789ab,
  parameter logic [3:0] FOUR = 4'b10xz,
  parameter real GAIN = 2.75,
  parameter string LABEL = "slow"
)(output wire [12:0] q);
  assign q = {DELTA, FOUR} ^ WIDE[12:0];
endmodule

module parameter_tb;
  wire [12:0] first, second;
  param_dut a(first);
  param_dut #(
    .DELTA(9'sd17), .WIDE(68'h123456789abcdefff), .FOUR(4'b01zx),
    .GAIN(-1.5), .LABEL("fast")
  ) b(second);
  initial begin
    $dumpfile("parameters.vcd");
    $dumpvars(0, parameter_tb);
    #2 $finish;
  end
endmodule
