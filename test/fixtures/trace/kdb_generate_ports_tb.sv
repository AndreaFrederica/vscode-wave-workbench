// SPDX-License-Identifier: MPL-2.0
`timescale 1ps/1ps

module generate_port_leaf(input wire a, output wire q);
  assign q = a;
endmodule

module generate_ports_tb;
  logic [0:5] input_bus = '0;
  logic shift = 0;
  wire [5:0] output_bus;
  wire [2:0] shifted_bus;

  for (genvar lane = -1; lane <= 1; lane++) begin : lanes
    localparam integer IN_BIT = (lane + 1) * 2;
    if (lane == 0) begin : center
      generate_port_leaf cell_inst(.a(input_bus[IN_BIT+1]), .q(output_bus[IN_BIT]));
    end else begin : outer
      generate_port_leaf cell_inst(.a(input_bus[IN_BIT]), .q(output_bus[IN_BIT+1]));
    end
    generate_port_leaf shifted(.a(input_bus[IN_BIT + shift]), .q(shifted_bus[lane+1]));
  end

  assign output_bus[4] = 1'b0;
  assign output_bus[3] = 1'b0;
  assign output_bus[0] = 1'b0;

  initial begin
    $fsdbDumpfile("generate_ports.fsdb");
    $fsdbDumpvars(0, generate_ports_tb);
    #5 input_bus = 6'b100000;
    #1 input_bus = 6'b000100; shift = 1;
    #1 input_bus = 6'b000010;
    #1 shift = 0;
    #1 $finish;
  end
endmodule
