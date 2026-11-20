// SPDX-License-Identifier: MPL-2.0
`timescale 1ps/1ps
module subroutine_effects_tb;
  logic data = 0, config_bit = 0;
  logic ordered_result, named_result, function_result;

  task automatic transform(input logic source, output logic dest);
    dest = source ^ config_bit;
  endtask

  function automatic logic value_with_config(input logic source);
    return source ^ config_bit;
  endfunction

  function automatic logic evaluate(input logic source);
    return value_with_config(source);
  endfunction

  always_comb begin
    transform(data, ordered_result);
    transform(.dest(named_result), .source(data));
    function_result = evaluate(data);
  end

  initial begin
    $fsdbDumpfile("subroutine.fsdb");
    $fsdbDumpvars(0, subroutine_effects_tb);
    #2 data = 1;
    #2 config_bit = 1;
    #2 $finish;
  end
endmodule
