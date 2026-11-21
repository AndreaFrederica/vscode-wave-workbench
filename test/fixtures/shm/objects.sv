// SPDX-License-Identifier: MPL-2.0
`timescale 1ps/1ps
module order;
 typedef enum logic [2:0] {ON=3'b011, OFF=3'b100} state_t;
 state_t state=OFF;
 int signed si=-2;
 int unsigned ui=5;
 shortint signed short_value=-7;
 byte b=-4;
 time stamp=0;
 bit one=0;
 shortreal short_real=0.25;
 realtime rt=0.25;
 logic [2:0] cells[];
 int queued[$];
 logic [3:0] assoc[int];
 string s="";
 initial begin
   cells = new[2]; cells[0] = 3'b011; cells[1]='z;
   queued.push_back(9); assoc[7]=4'hb;
   #5 state=ON; si=-38; ui=20; short_value=-2; b=2; stamp=42; one=1; short_real=-2.25; rt=2.25;
   cells[1] = 3'b111; queued.push_back(8); assoc[11]=4'ha; s="hello";
   #5 $finish;
 end
endmodule
