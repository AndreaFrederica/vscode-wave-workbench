// SPDX-License-Identifier: MPL-2.0
module trace_request(
    input logic request,
    input logic enabled,
    output wire active
);
    assign active = request & enabled;
endmodule

module trace_arbiter #(
    parameter bit PreferHart1 = 0
)(
    input logic clk,
    input logic rst_n,
    input logic accept,
    input logic [1:0] request,
    output logic owner_q,
    output logic valid_q,
    output wire [1:0] grant
);
    wire [1:0] active;
    for (genvar hart = 0; hart < 2; ++hart) begin : requesters
        trace_request u_request(request[hart], rst_n, active[hart]);
    end
    assign grant[0] = active[0] & (!active[1] | !PreferHart1);
    assign grant[1] = active[1] & (!active[0] | PreferHart1);

`ifdef WAVE_EXECUTION_TRACE
    import "DPI-C" function void wave_trace_owner(input int event_kind, input int statement, input int new_value);
`endif
    always_ff @(posedge clk or negedge rst_n) begin
`ifdef WAVE_EXECUTION_TRACE
        wave_trace_owner(0, 0, 0);
`endif
        if (!rst_n) begin
`ifdef WAVE_EXECUTION_TRACE
            wave_trace_owner(1, 1, 0);
            wave_trace_owner(2, 1, 0);
`endif
            owner_q <= 0; // wave-trace: owner.reset
            valid_q <= 0;
        end else if (accept && (|grant)) begin
`ifdef WAVE_EXECUTION_TRACE
            wave_trace_owner(1, 2, 0);
            wave_trace_owner(2, 2, int'(grant[1]));
`endif
            owner_q <= grant[1]; // wave-trace: owner.accept
            valid_q <= 1;
        end
    end
endmodule

module trace_tb(
    input logic clk,
    input logic rst_n,
    input logic accept,
    input logic [1:0] request,
    output wire owner_q,
    output wire valid_q,
    output wire [1:0] grant,
    output wire selected_request
);
    localparam bit PreferHart1 =
`ifdef TRACE_PREFER_HART_1
        1;
`else
        0;
`endif
    trace_arbiter #(.PreferHart1(PreferHart1)) dut(
        .clk, .rst_n, .accept, .request, .owner_q, .valid_q, .grant
    );

    assign selected_request = grant[0] ? request[0] : 1'bz;
    assign selected_request = grant[1] ? request[1] : 1'bz;
endmodule
