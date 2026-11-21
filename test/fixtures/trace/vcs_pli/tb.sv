module tb;
  reg target = 0;
  reg input_value = 0;
  wire observed = target;
  initial begin
    $dumpfile("trace.vcd");
    $dumpvars(0, tb);
    #2 input_value = 1;
    #3 $wb_drive(target, input_value);
    #2 $finish;
  end
endmodule
