// SPDX-License-Identifier: MPL-2.0
`timescale 1ps/1ps
module ordered_writer (
    input logic clk, update, blocking_value, replaced_value, final_value,
    output logic q
);
    import "DPI-C" context function void trace_write(input int event_kind, statement, value);

    always @(posedge clk) begin
        trace_write(0, 0, 0);
        if (update) begin
            trace_write(1, 1, int'(blocking_value));
            q = blocking_value; // wave-trace: write.blocking
            trace_write(2, 1, int'(q));
            trace_write(3, 2, int'(replaced_value));
            q <= replaced_value; // wave-trace: write.replaced
            trace_write(3, 3, int'(final_value));
            q <= final_value; // wave-trace: write.final
        end
    end
endmodule

module execution_order_tb (
    input logic clk, update, value,
    output wire first_q, second_q
);
    ordered_writer first(clk, update, value, value, !value, first_q);
    ordered_writer second(clk, update, !value, !value, value, second_q);
endmodule
