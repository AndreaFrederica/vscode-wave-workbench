// SPDX-License-Identifier: MPL-2.0
`timescale 1ps/1ps
module diff_leaf(input wire k, output wire inv);
  assign inv = ~k;
endmodule
module diff_tb;
  typedef struct packed {
    logic [5:3] code;
    logic valid;
  } packet_t;
  typedef struct {
    logic [0:2] data;
    logic ready;
    packet_t packed_member;
  } item_t;

  logic tick = 0;
  logic [3:0] word = 4'bxz01;
  logic [0:3] ascending = 4'bzx10;
  logic [1:0][2:0] packed_grid = '0;
  packet_t packet = '0;
  item_t entries[-1:1];
  logic [3:0] matrix[1:0][-2:0];
  integer integer_value = 0;
  bit [7:0] two_state = 0;
  real real_value = 0.0;
  event notice;
  string message = "initial";

  for(genvar index=0; index<2; index++) begin : lane
    wire inverted;
    diff_leaf u_leaf(tick, inverted);
  end

  initial begin
    entries[0].data = 3'b0xz;
    entries[0].ready = 1;
    entries[0].packed_member = 4'b01zx;
    matrix[1][-2] = 4'b0z1x;
    #5 tick=1; word=4'bz1x0; ascending=4'b101z; packed_grid[0]=3'bz01;
    packet.code=3'b1xz; entries[0].packed_member.valid=1; ->notice;
    #8 tick=0; word=4'b1111; ascending=4'b0011; packed_grid[1]=3'b01x;
    packet.valid=1; entries[0].data=3'bz01; matrix[0][0]=4'bz10x;
    integer_value=-12; two_state=65; real_value=0.125; message="updated";
    #23 tick=1; word=4'b0000; ascending=4'bz000; ->notice;
    #120 $finish;
  end
endmodule
