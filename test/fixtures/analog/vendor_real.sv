`timescale 1ns/1ns
module mixed_tb;
  real voltage;
  logic ready;
  initial begin
`ifdef DUMP_SHM
    $dumpfile("native.vcd");
    $dumpvars(0,mixed_tb);
    $shm_open("mixed.shm");
    $shm_probe("AS");
`endif
    voltage = -0.125;
    ready = 0;
    #4 voltage = 0.125;
    #5 begin
      voltage = 0.9;
      ready = 1;
    end
    #7 voltage = 0.75;
    #1 $finish;
  end
endmodule
