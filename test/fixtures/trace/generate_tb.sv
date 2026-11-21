module generate_choice #(parameter bit SELECT = 1)(
    input logic a, b,
    output logic q, r, probe
);
    localparam bit NESTED = !SELECT;
    if (SELECT) begin : yes
        assign q = a;
    end else begin : no
        if (NESTED) begin : nested
            always_comb q = b;
        end
    end

    case (SELECT)
        1'b1: begin : one
            assign r = b;
        end
        default: begin : zero
            assign r = a;
        end
    endcase

    if (SELECT) assign probe = a;
    else assign probe = b;
endmodule

module generate_tb;
    logic a = 0, b = 1;
    wire positive, negative, case_positive, case_negative;
    wire probe_positive, probe_negative;
    generate_choice #(.SELECT(1)) p(a, b, positive, case_positive, probe_positive);
    generate_choice #(.SELECT(0)) n(a, b, negative, case_negative, probe_negative);

    initial begin
        $dumpfile("generate.vcd");
        $dumpvars;
        #5 a = 1;
        #5 b = 0;
        #5 $finish;
    end

    wire probe_inline;
    if (1) assign probe_inline = a; else assign probe_inline = b;
endmodule
