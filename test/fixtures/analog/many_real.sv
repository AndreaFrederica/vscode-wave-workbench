`timescale 1ns/1ns
module many_real;
  real a, b;
  shortreal c;
  logic ready;
  initial begin
    $fsdbDumpfile("many.fsdb");
    $fsdbDumpvars(0,many_real);
    $dumpfile("many.vcd");
    $dumpvars(0,many_real);
    a = -7.75; b=5.125; c=1.25; ready=0;
    #1;
    for (int j=1; j<=400; j++) begin
      #(j) a=j/64.0;
      if (j%3==0) b=-j/16.0;
      if (j%4==0) c=j/2.0;
      ready=~ready;
    end
    #5000000000 a=-42.5;
    #17 b=2.5;
    #1 $finish;
  end
endmodule
