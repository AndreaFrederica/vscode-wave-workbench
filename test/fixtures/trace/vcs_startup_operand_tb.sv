// SPDX-License-Identifier: MPL-2.0

module startup_tb;
  bit seed;
  logic early, late;

  initial begin
    early <= seed;
    seed = 1'b1;
    late <= seed;
    #3 $finish;
  end

  initial begin
    $dumpfile("live.vcd");
    $dumpvars(0, startup_tb);
  end
endmodule
