module unresolved_control_tb;
  bit clk;
  logic [1:0] data = '0;
  logic [3:0] q = '0;
  logic r = '0;

  function automatic logic reduce_data(input logic [1:0] operand);
    return ^operand;
  endfunction

  always #1 clk = !clk;
  always @(posedge clk) data <= 2'b01;

  always @(negedge clk) begin
    if ($time == 2) begin
      q[3] <= data[0];
      r <= reduce_data(data);
    end
  end

  initial begin
    $dumpfile("live.vcd");
    $dumpvars(0, unresolved_control_tb);
    #5 $finish;
  end
endmodule
