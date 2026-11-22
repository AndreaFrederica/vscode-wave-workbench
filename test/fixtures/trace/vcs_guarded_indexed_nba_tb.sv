// SPDX-License-Identifier: MPL-2.0
`timescale 1ns/1ns
module guarded_indexed_nba_tb;
  logic [2:0] req = '0;
  logic [1:0] idx = '0;
  logic [0:3] q = '0;
  logic [1:0] dest = 1;

  initial begin
    $dumpfile("live.vcd");
    $dumpvars(0, guarded_indexed_nba_tb);
    #3;
    if (req[idx]) begin
      #2;
      if (req[idx]) begin
        q[dest +: 2] <= 2'b00;
      end else begin
        #2;
        q[dest +: 2] <= 2'b11;
        dest = 0;
      end
    end
    #3 $finish;
  end

  initial begin
    #2 req = 3'b001;
    #2 begin
      req = 3'b0x0;
      idx = 2'd1;
    end
    #2 begin
      req = 3'b100;
      idx = 2'd2;
      dest = 2;
    end
  end
endmodule
