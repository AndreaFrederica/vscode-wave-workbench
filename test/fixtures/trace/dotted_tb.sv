module leaf(input logic a);
    logic internal_a;
    assign internal_a = a;
endmodule

module middle(input logic a, b, output logic q);
    leaf left(a);
    leaf right(b);
    assign q = left.internal_a ^ right.internal_a;
endmodule

module observer(output logic observed);
    assign observed = dotted_tb.m.left.internal_a;
endmodule

module dotted_tb;
    logic a = 0, b = 0;
    wire q;
    wire observed;
    middle m(a, b, q);
    observer spy(observed);
    initial begin
        $dumpfile("dotted.vcd");
        $dumpvars;
        #5 a = 1;
        #5 b = 1;
        #5 $finish;
    end
endmodule
