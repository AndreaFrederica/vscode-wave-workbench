`ifdef WAVE_TEST_XMR_NESTED_MACRO
  `define MID_READ_INNER(which, member) mid_tb.u_``which.member
  `define MID_READ(member) `MID_READ_INNER(leaf, member)
`else
  `define MID_READ(member) mid_tb.u_leaf.member
`endif
