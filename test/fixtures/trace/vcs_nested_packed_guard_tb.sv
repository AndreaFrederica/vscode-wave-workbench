// SPDX-License-Identifier: MPL-2.0
`timescale 1ns/1ns
module nested_packed_guard_tb;
  logic [2:0] req = '0;
  logic [1:0] idx = '0;
  logic q = 1'b0;

  initial begin
    $dumpfile("live.vcd");
    $dumpvars(0, nested_packed_guard_tb);
    #3;
    if (req[idx]) begin
      #2;
      if (req[idx]) begin
        #2;
        q = 1'b1;
      end
    end
    #3 $finish;
  end

  initial begin
    #2 req = 3'b001;
    #2 begin
      req = 3'b010;
      idx = 2'd1;
    end
    #2 begin
      req = 3'b100;
      idx = 2'd2;
    end
  end
endmodule
