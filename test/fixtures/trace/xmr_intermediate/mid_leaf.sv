module mid_leaf;
  logic stimulus = 0;
  wire middle = stimulus;
  initial #2 stimulus = 1;
endmodule
