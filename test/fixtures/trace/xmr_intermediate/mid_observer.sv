`ifdef WAVE_TEST_XMR_MACRO
`include "mid_read.svh"
`endif
module mid_observer;
`ifdef WAVE_TEST_XMR_MACRO
  wire observed = `MID_READ(middle);
`else
  wire observed = mid_tb.u_leaf.middle;
`endif
endmodule
