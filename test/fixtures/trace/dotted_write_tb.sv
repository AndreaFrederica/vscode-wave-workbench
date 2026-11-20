module write_leaf(output logic q);
endmodule

module write_tb;
    logic a = 0, b = 1;
    wire ql, qr;
    write_leaf l(ql), r(qr);
    always_comb l.q = a;
    always_comb r.q = b;

    initial begin
        $dumpfile("write.vcd");
        $dumpvars;
        #5 a = 1;
        #5 b = 0;
        #5 $finish;
    end
endmodule
