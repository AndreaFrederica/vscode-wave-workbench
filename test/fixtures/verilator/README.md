# Verilator regression fixtures

Run these commands with Verilator 5.054 or a compatible version on PATH. The FST runtime may require the system LZ4 and zlib development packages. Run from this directory.

~~~sh
verilator --json-only --top-module top fixture.sv
verilator --cc --exe --build --trace-vcd --top-module top --Mdir obj_vcd fixture.sv sim.cc
verilator --cc --exe --build --trace-fst --top-module top --Mdir obj_fst fixture.sv sim.cc
./obj_vcd/Vtop
./obj_fst/Vtop

mkdir -p large
verilator --json-only --Mdir large --top-module top stress.sv
verilator --cc --exe --build -j 4 --trace-fst --trace-max-array 0 \
  --top-module top --Mdir obj_stress stress.sv stress.cc
(cd large && ../obj_stress/Vtop 100000)

export WAVE_TEST_VERILATOR="$PWD"
export WAVE_TEST_VERILATOR_LARGE="$PWD/large"
~~~

From the repository root run `npm run package:native` to build the native reader, then `npm test` and `npm run test:ui`. The stress fixture generates approximately 477 MiB of FST data with 1,604 signal entries.
