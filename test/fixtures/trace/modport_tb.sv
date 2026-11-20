interface link_if;
    logic datum;
    modport tx(output datum);
    modport rx(input datum);
endinterface

module sender(input logic a, link_if.tx link);
    assign link.datum = a;
endmodule

module receiver(input logic clk, link_if.rx link, output logic q);
    always @(posedge clk) q <= link.datum;
endmodule

module iface_tb;
    logic a = 0, b = 0, clk = 0;
    wire p, n;
    link_if x();
    link_if y();
    sender sx(a, x), sy(b, y);
    receiver rx(clk, x, p), ry(clk, y, n);

    initial begin
        $dumpfile("interface.vcd");
        $dumpvars;
        #1 a = 1;
        #1 clk = 1;
        #1 clk = 0;
        #1 b = 1;
        #1 clk = 1;
        #1 $finish;
    end
endmodule
