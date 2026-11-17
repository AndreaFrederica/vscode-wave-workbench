# Open examples/demo.vcd first, then use Run nWave Tcl Script.
set wave [wvCreateWindow]
wvAddSignal -win $wave -clear -group [list DUT [list /tb/dut/clk] [list {/tb/dut/data[7:0]}]]
wvSetWindowTimeUnit -win $wave 1 ns
wvSetRadix -win $wave -format Hex {/tb/dut/data[7:0]}
wvSetCursor -win $wave 20
wvSetMarker -win $wave -name DATA_UPDATE 30
wvZoom -win $wave 10 40
set value [wvGetSigValueByTime -win $wave {/tb/dut/data[7:0]} -format Hex -time 20]
if {$value ne "2a"} {error "Unexpected bus value $value"}
puts "nWave Tcl demo passed: data at 20 ns = $value"
