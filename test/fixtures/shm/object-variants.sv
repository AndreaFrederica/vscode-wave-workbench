// SPDX-License-Identifier: MPL-2.0
`timescale 1ps/1ps
package data_types;
  class Packet;
    int n = 10;
    string label_text = "before";
  endclass
endpackage
module order;
  import data_types::*;
  typedef union packed { logic [7:0] word; struct packed { logic [3:0] hi, lo; } parts; } overlay_t;
  overlay_t overlay;
  Packet pkt;
  logic [3:0] assoc[string];
  logic [3:0] wild[*];
  int nested[][];
  int queue_of_arrays[$][2];
  logic [2:0] ascending[2:4];
  logic [1:0] multidim[3:4][1:0];
  initial begin
    overlay.word=8'h69;
    pkt = new;
    assoc["alpha"]=4'h9;
    wild[3]=4'h6;
    nested = new[1]; nested[0]=new[2]; nested[0][0]=19; nested[0][1]=23;
    queue_of_arrays.push_back('{31,42});
    ascending[3]=3'b10x;
    multidim[3][0]=2'b1z;
    #5 overlay.parts.hi=4'bz11x; pkt.n=23; pkt.label_text="after";
    assoc["beta"]=4'h5; assoc["alpha"]=4'ha; assoc.delete("alpha");
    wild[8]=4'h7;
    nested[0][1]=42;
    queue_of_arrays[0][1]=11;
    ascending[3]=3'b011;
    multidim[3][0]=2'b00;
    #5 pkt=null;
    #5 $finish;
  end
endmodule
