# RTL Trace fixture

The testbench connects a two-requester arbiter to a Verilator harness. The
fixture covers combinational dependencies, generated instance paths, bit
selects, explicit and shorthand port connections, nonblocking assignments,
register hold, asynchronous reset, and two continuous drivers on one net.

From this directory, build either or both configurations with Verilator 5.054:

~~~sh
for target in hart0 hart1; do
  mkdir -p "$target"
  if [ "$target" = hart1 ]; then
    set -- +define+TRACE_PREFER_HART_1
  else
    set --
  fi
  verilator --json-only --top-module trace_tb --Mdir "$target" "$@" trace_tb.sv
  for format in fst vcd; do
    verilator --cc --exe --build "--trace-$format" --top-module trace_tb \
      --Mdir "$target/obj_$format" "$@" trace_tb.sv sim.cc
    (cd "$target" && "./obj_$format/Vtrace_tb")
  done
done
~~~

The simulation takes these paths in both waveform formats.

| Tick | Event | hart0 target owner / valid | hart1 target owner / valid |
| --- | --- | --- | --- |
| 1 | Reset while clock rises | 0 / 0 | 0 / 0 |
| 3 | Both requests accepted at a rising edge | 0 / 1 | 1 / 1 |
| 5 | Request present with accept low | 0 / 1 | 1 / 1 |
| 7 | Hart 1 accepted at a rising edge | 1 / 1 | 1 / 1 |
| 8 | Reset while clock falls | 0 / 0 | 0 / 0 |

Set `WAVE_TEST_RTL_TRACE` to this directory and run `npm test` from the repository
root to check the waveform values and generated instance paths.

## Parameterized generate branches

Two instances of the same module select different branches of a named
`if/else` and `case`. The negative instance also exercises an assignment in a
nested generate block. The unnamed branches exercise partial trace reporting.

~~~sh
verilator --json-only --top-module generate_tb \
  --json-only-output generate.tree.json \
  --json-only-meta-output generate.tree.meta.json generate_tb.sv
verilator --binary --timing --trace-vcd --top-module generate_tb \
  --Mdir generate_sim generate_tb.sv
./generate_sim/Vgenerate_tb
~~~

Set `WAVE_TEST_GENERATE` to the directory with these files to run the
specialization regression. Open the VCD with the JSON files beside it. At tick
11, `generate_tb.positive` is 1 from `p.a` and `generate_tb.negative` is 0 from
`n.b`. The case outputs select the opposite inputs.

## Hierarchical reads

The two leaf instances share a declaration. The middle module reads their
internal signals by name and computes their XOR. Build the elaboration tree
and VCD together to verify the independent signal paths.

~~~sh
verilator --json-only --top-module dotted_tb --json-only-output dotted.tree.json \
  --json-only-meta-output dotted.tree.meta.json dotted_tb.sv
verilator --binary --timing --trace-vcd --top-module dotted_tb \
  --Mdir dotted_sim dotted_tb.sv
./dotted_sim/Vdotted_tb
~~~

Open `dotted.vcd` and trace `dotted_tb.q` at tick 5. The left and right
instances produce 1 and 0 from their respective TB inputs. A Load trace
from either leaf's `internal_a` reaches the XOR and the TB output. The
left leaf also reaches the observer in a separate instance.

## Named modports

Use `modport_tb.sv` to build a pair of channels of the same interface type.
Build the tree and waveform with top `iface_tb`, using
`interface.tree.json`, `interface.tree.meta.json` and `interface.vcd` as output
names. The first registered output `iface_tb.p` rises at tick 2 via `x.datum`.
The second output `iface_tb.n` rises at tick 5 via `y.datum`.

The explicit read and write aliases in `modport_alias_tb.sv` are covered by
VCS and Xcelium VCDs with a Verilator JSON tree from the same source. Run in a
scratch build directory so the waveform and simulator files stay together.

~~~sh
verilator --json-only --top-module alias_tb modport_alias_tb.sv
vcs -full64 -kdb -sverilog -timescale=1ns/1ns -debug_access+all modport_alias_tb.sv -o simv
./simv
# Alternatively, run Xcelium in its own build directory.
xrun -64bit -sv -timescale 1ns/1ns -access +rwc -top alias_tb modport_alias_tb.sv
~~~

Associate `alias.vcd` with the generated tree and an ordered source list for
`modport_alias_tb.sv`. Query `alias_tb.p` at tick 3 and `alias_tb.n` at tick 5.
The upstream graphs reach `x.datum` and `a`, or `y.datum` and `b`,
respectively. Load graphs from the two interface members reach the matching
reader and output. Verilator 5.054 exports the tree for this fixture. Generating
its simulation model raises a variable scope error.

Set `WAVE_TEST_MODPORT_KDB` to the VCS `simv.daidir` directory to enable the KDB
source-location and NPI alias-binding assertions in `test/kdb.test.js`.
For the KDB-backed MCP check, build the interface and each module as separate
source files in the same VCS invocation. List all four files in the build
manifest and attach `simv.daidir` to the waveform. To check alias names as
waveform roots, dump FSDB with VCS and query `alias_tb.x.receiver.rx_data` or
`alias_tb.x.sender.tx_data` at tick 3. Both resolve to `alias_tb.x.datum` and
show the value `1`.

## Modport bit and part selections

Build `modport_slice_tb.sv` using the VCS command below with `-top slice_tb`.
Set `WAVE_TEST_MODPORT_SLICE_KDB` to the generated `simv.daidir` to test
the independent reader or Verdi NPI. In `slice.vcd` and `slice.fsdb`, trace `p[1]`,
`n[0]`, and `o[1]` at ticks 1, 2, and 3. The physical dependencies are
`datum[7]`, `datum[4]`, and `ascending[1]`, respectively. In FSDB,
`slice_tb.x.receiver.rx[7:6]` can also be the root of a Driver or Load trace.

Build `modport_bounds_tb.sv` with `-top bounds_tb` and set
`WAVE_TEST_MODPORT_BOUNDS_KDB` to its `simv.daidir` with either reader. It checks the VCS
encoding of negative indices, indices above 255, single bits, and one-bit
part selections. Open `bounds.fsdb` to inspect the selected aliases.

Build `modport_concat_tb.sv` with `-top concat_tb` and set
`WAVE_TEST_MODPORT_CONCAT_KDB` to its `simv.daidir`. In both dumps,
`r[3]` and `r[0]` trace to `datum[4]` and `a[1]` at tick 1,
`r[2]` traces to `ascending[2]` and `a[0]` at tick 2, and
`r[1]` traces to `datum[7]` and `b` at tick 3. Load traces from
the physical bits recover those same output bits.

In either FSDB reader, start a trace at
`concat_tb.x.receiver.with_repeat` or an individual bit of that alias.
Load tracing from bit 3 or bit 0 reaches `p[1]`, `r[3]`, and `r[0]`
through their shared `datum[4]` storage. Cursor A at tick 1 displays the
dependency from either alias bit to `a[1]`.

Build `modport_nested_tb.sv` with `-top nested_tb` and set
`WAVE_TEST_MODPORT_NESTED_KDB` to its `simv.daidir`. Use both readers to
trace `q[4]` and `q[0]` through the nested receive alias to `data[7]` and
`a[5]` at tick 1. From `nested_tb.overlap.data[2]`, Driver tracing finds
the two RHS bits `b[5]` and `b[2]`. At tick 3 the VCD records this bit
changing to 1 and then back to 0. The detailed time report retains the two
candidate components of the assignment.

### VCS value-change recording

From a scratch directory, set `repo` to the Wave Workbench checkout and
`VCS_HOME` and `VERDI_HOME` to your simulator and Verdi installations.
Compile the nested modport fixture with the value-change callback.

~~~sh
pli="$VERDI_HOME/share/PLI/VCS/LINUX64"
cc -std=c11 -shared -fPIC -I"$VCS_HOME/include" "$repo/native/vpi_execution.c" -o wave_vpi.so
vcs -full64 -sverilog -kdb -debug_access+all +vpi -timescale=1ns/1ns \
  -top nested_tb -P "$pli/novas.tab" "$pli/pli.a" \
  -load "$PWD/wave_vpi.so:wave_workbench_register_vpi" \
  "$repo/test/fixtures/trace/modport_nested_tb.sv" -o simv
./simv +wave_execution_events=raw.jsonl +wave_watch=nested_tb.overlap.data \
  +wave_watch=nested_tb.writer.d +wave_watch=nested_tb.b
node "$repo/scripts/verilator-execution.mjs" seal-vpi nested.vcd raw.jsonl execution-vcd.jsonl
node "$repo/scripts/verilator-execution.mjs" seal-vpi nested.fsdb raw.jsonl execution-fsdb.jsonl
~~~

Call `wave_execution_trace` with `instance="nested_tb.overlap"`,
`signal="data"`, and `tick="3"`. A `wave_trace_context` query for
`nested_tb.overlap.data[2]` with either sealed log reports the callbacks
for `0101` and `1001` in that order. With the VCD, the time graph and
report identify the compatible components `data[2:0]` and `data[3:1]`,
using the recorded values of `writer.d` and the full target transitions.
Use `changeOrder: 1` or `changeOrder: 2` to trace the changes individually
to `writer.d[2]` and `writer.d[5]` respectively. The FSDB retains the
slot-end value. In offline replay with the matching execution log, the time
graph restores both changes from the callbacks and marks their provenance.
The report also shows the original FSDB samples and the sequence difference.
Exact assignment commits require execution probes.
Query the whole `nested_tb.overlap.data` bus at tick 3 to compare the
upstream callbacks for `b` and `writer.d` with the two target changes.
The VCD time graph links matching nodes to their callback ordinals.

### VCS modport component evaluations

Open the original `nested.vcd` with its KDB. Call `wave_execution_map` for
instance `nested_tb.overlap` and signals `data` and `bypass`, and put the
two responses in an array. Follow the VCS DPI build steps below with
`generate-vcs-nba`, top `nested_tb`, and the FSDB PLI options above.
Store the instrumented waveform at `capture/nested.vcd` and seal the
recording as `execution-vcd.jsonl` at the parent directory. Watch
`nested_tb.overlap.data`, `nested_tb.overlap.bypass`, `nested_tb.writer.d`,
and `nested_tb.b`. Use the original source and its KDB for trace replay.
Set `WAVE_TEST_VCS_MODPORT_EVALUATION` to the parent directory for the
replay regression.

At tick 3, the evaluations record `100` for `data[3:1]`, `101` for
`data[2:0]`, and `0` for `bypass`. The probe retains the original
`bus_if.joined` assignment and records unobserved outcomes for the physical
writes. The time graph links the compatible modport components to their
recorded evaluations and the two physical value-change callbacks.

To match using the captured component values, declare writer coverage for
the physical `data` and `bypass` targets and record the two target watches.
The whole `data` bus and `data[2]` both identify their compatible component
for each change. In live mode, set an `assignment-evaluated` breakpoint with
the physical target instance and the component statement ID. Supply a matched
build manifest and the sealed reference recording to `wave_live_trace` to
recover both changes from the callbacks at the pause.

To reproduce repeated evaluations in one slot, use a scratch copy of
`modport_nested_tb.sv` and replace the single tick 3 assignment of
`b = 7'b1000101` with the following block, preserving the other stimulus.

~~~systemverilog
begin
  b = 7'b1000101;
  #0 b = 7'b0100011;
  #0 b = 7'b1000101;
end
~~~

Build the original copy's KDB, regenerate its execution maps, and watch
`nested_tb.overlap.data`, `nested_tb.overlap.bypass`, `nested_tb.writer.d`
and `nested_tb.b`. At tick 3 the physical data callbacks report
`0101, 1001, 1011, 0101, 1001`. Query the whole bus and bit 2, including
the individual bit changes through `changeOrder`. The last callback pairs
with the third evaluation of the upper slice when the full slot supports
a unique one-to-one match. The report keeps the physical commit status
`assignment-unobserved`.

### VCS live trace

Compile `vpi_live_tb.sv` with the same shared library in a scratch
directory. The testbench writes `live.vcd` during each run.

~~~sh
cc -std=c11 -shared -fPIC -I"$VCS_HOME/include" "$repo/native/vpi_execution.c" -o wave_vpi.so
vcs -full64 -sverilog -kdb -debug_access+all +vpi -timescale=1ns/1ns \
  -top clock_tb -load "$PWD/wave_vpi.so:wave_workbench_register_vpi" \
  "$repo/test/fixtures/trace/vpi_live_tb.sv" -o simv
./simv +wave_execution_events=offline.jsonl +wave_watch=clock_tb.clk \
  +wave_watch=clock_tb.d +wave_watch=clock_tb.q
cp live.vcd reference.vcd
node "$repo/scripts/verilator-execution.mjs" seal-vpi reference.vcd offline.jsonl sealed.jsonl
~~~

Set `WAVE_TEST_VCS_LIVE` to the scratch directory to run the Node test.
For the IDE, open `reference.vcd` with `simv.daidir` and run
**Start VCS Live Trace** with `simv` and the three watched signals.
Two rising edges reach tick 3 with `q=0101`. A signal breakpoint on
`q=1010` stops at tick 5. For replay verification, use a build manifest
with the hashes of `reference.vcd`, `simv` and the fixture's RTL, then
pass this manifest and `sealed.jsonl` to `wave_live_trace`. The time graph
can link callback 8 for `q` and its input `d` at callback 5.

To include assignment entry, run the same executable with
`+wave_statement_scope=clock_tb` and `+wave_execution_events=raw.jsonl`,
keeping the three `+wave_watch` arguments. Copy the resulting `live.vcd` to
`reference.vcd` and seal `raw.jsonl` as `sealed.jsonl` in that directory.
Set `WAVE_TEST_VCS_STATEMENTS` to this directory for the mixed-event replay
test. In **Start VCS Live Trace**, enter `clock_tb` as the assignment scope.
`wave_execution_trace` at tick 1 returns the statement ID for the NBA on
line 8. Set a breakpoint on that ID with `eventKind: "assignment-entered"`
to pause at tick 1, where the sampled value of `q` is still `0000`.

### VCS DPI assignment probes

With the unmodified fixture's VCD and KDB open, call `wave_execution_map`
for `clock_tb.d` and `clock_tb.q`, using `clock_tb` as `instance` and each
leaf name as `signal`. Save the two responses as an array in `maps.json`.
Run the following in a fresh scratch directory. For the example coverage
file, list `clock_tb.d` starting at tick 1 and the single `processId` shared
by both of its selected writes. The `q` probes record its NBA evaluations.

~~~sh
node "$repo/scripts/verilator-execution.mjs" generate maps.json generated
cc -std=c11 -shared -fPIC -I"$VCS_HOME/include" -I"$PWD/generated" \
  -DWAVE_WORKBENCH_VCS_PROBES "$repo/native/vpi_execution.c" -o wave_vpi.so
vcs -full64 -sverilog -kdb -debug_access+all +vpi -timescale=1ns/1ns \
  -top clock_tb -load "$PWD/wave_vpi.so:wave_workbench_register_vpi" \
  "$PWD/wave_vpi.so" "$PWD/generated/wave_workbench_probe.sv" \
  "$PWD/generated/vpi_live_tb.sv" -o simv
./simv +wave_execution_events=raw.jsonl +wave_watch=clock_tb.clk \
  +wave_watch=clock_tb.d +wave_watch=clock_tb.q
cp live.vcd reference.vcd
node "$repo/scripts/verilator-execution.mjs" seal-vpi reference.vcd raw.jsonl \
  sealed.jsonl generated/execution-probes.json coverage.json
~~~

Set `WAVE_TEST_VCS_DPI` to this scratch directory to run the replay test.
Use a `waveWorkbench.sourcePathMappings` entry from the generated testbench
path to the original fixture and a reference build manifest with the
original source hash. `wave_trace_context` at tick 4 identifies the write
to `d` at line 14. Run the same executable with **Start VCS Live Trace**
and use the `d` statement ID at line 14 for an `assignment-committed`
breakpoint. The resulting pause retains the committed `1010` value.

### VCS NBA commit probes

Use the DPI assignment probe steps with `generate-vcs-nba maps.json generated`.
In the clock fixture, include the observed `d` and `q` writers in `coverage.json`.
The capture includes the same-value commit to `q` at tick 1. It can trigger an
`assignment-committed` breakpoint with `timing: "simulator-commit"`. At tick 5,
the time graph links the NBA to the blocking write to `d` at tick 4.

Repeat the build with `vcs_nba_burst_tb.sv`, top `nba_burst_tb`, and `q` as the
selected signal. Declare its initial process as the writer from tick 1. VCS
reports one observed update for the three assignments at tick 1. Replay retains
all three evaluations, two `assignment-unobserved` events and the final observed
commit. The independent commit at tick 2 can still be attributed. Set
`WAVE_TEST_VCS_NBA` to a directory containing these two builds as `integrated`
and `burst`, with `reference.vcd` and `sealed.jsonl` in each, to run the replay test.

### VCS fixed packed writes

Use the VCS NBA probe steps with `vcs_packed_write_tb.sv`, top
`packed_write_tb`, and execution maps for `d` and `q` from the original
waveform and KDB. The map includes four blocking sites for `d` and two NBA
sites for `q`. Provide both processes in the writer coverage, with one
coverage entry per signal starting at tick 1. Watch `clk`, `d` and `q`.
Set `WAVE_TEST_VCS_PACKED_WRITE` to the directory containing the sealed log
and its `reference.vcd` to run the replay check.

With the instrumented reference open, query `packed_write_tb.q[0]` and
`packed_write_tb.q[7]` at tick 3. Their commits trace to `d[7]` and `d[0]`,
respectively. At tick 5, `q[7]` traces to the individual blocking write to
`d[0]`. Compare settled source signals between the two builds. VCS exposes
additional intermediate writes in the instrumented waveform, which is the
waveform used to verify those changes against the execution log.

### VCS dynamic packed writes

Use the VCS NBA probe steps with `vcs_dynamic_write_tb.sv`, top
`dynamic_write_tb`, and an execution map for `q`. The execution map includes
the simple index variable `index` at line 10. Include the `q` writer in the
coverage file from tick 1. Watch `clk`, `d`, `index` and `q`, using the same
watch order for the offline recording and live session. Set
`WAVE_TEST_VCS_DYNAMIC_WRITE` to the directory with the sealed log and its
`reference.vcd` for the replay test.

Query `dynamic_write_tb.q[-1]` at tick 2. The commit targets bit −1 even
though `index` has reached 2 by the end of that slot. At tick 4, the
commit targets bit 2 and the index waveform ends in X. Unknown and
out-of-range indices at ticks 6 and 8 produce unobserved results. At
tick 10, the commit to `q[1]` can still be attributed.

### VCS indexed packed writes

Use the VCS NBA probe steps with `vcs_indexed_write_tb.sv`, top
`indexed_write_tb`, and execution maps for `ascending` and `descending`
from the original VCD and KDB. The maps include the direction and literal
width for each indexed part-select. Declare both writers from tick 1.
Watch `clk`, `d`, `index`, `ascending` and `descending` in that order.
Set `WAVE_TEST_VCS_INDEXED_WRITE` to the directory containing
`reference.vcd` and `sealed.jsonl` to run the replay check.

At tick 4 the two commits target `[4:5]` and `[4:3]` respectively, using
the captured base 4 even though the value of `index` at the end of the
slot is 7. Both bit 4 queries trace to `d[1]`. Partial out-of-bounds
selects fall back to the original assignment and appear in the replay
as unobserved. Later in-bounds commits remain verifiable.

### VCS overlapping packed writes

Use the VCS NBA probe steps with `vcs_overlap_write_tb.sv`, top
`overlap_write_tb`, and execution maps for `q` and `mixed` from the original
waveform and KDB. Declare both writers starting at tick 1. Watch
`clk`, `a`, `b`, `q` and `mixed` in the same order in both sessions.
Set `WAVE_TEST_VCS_OVERLAP_WRITE` to the directory with the sealed log and
its `reference.vcd` for the replay check.

At tick 2, the overlapping `q[2:1]` and `q[1:0]` writes have evaluations and
unobserved commits. The disjoint write to `q[3]` has a verified commit and
the bit trace reaches `a[0]`. At tick 4, the bit 2 query reaches `b[1]`.
The `mixed` writes check that a captured index can share a marker with fixed
and whole-variable writes while retaining each event's own range. Compare
settled values with the original VCD and use the instrumented VCD for replay.

### VCS packed dependency with an unresolved guard

Build `vcs_unresolved_control_tb.sv` with VCS as top
`unresolved_control_tb` using `-kdb -debug_access+all -timescale=1ns/1ns`.
In the generated VCD, query `q[3]` at tick 2. The Driver graph identifies
`data[0]`, and the time graph includes its change at tick 1. The report
marks the `$time` guard as unresolved. The Load query for `data[1]`
excludes `q[3]` and retains the unresolved call that drives `r`.

For execution replay, generate the NBA probes using the `q` statement map
from the original VCD and KDB. Watch `clk`, `data` and `q` in both sessions.
The commit query and live breakpoint can identify the write to `q[3]` at
tick 2 while the report retains the static control gap.

### VCS undumped packed write history

Use `vcs_undumped_packed_tb.sv` with top `undumped_packed_tb`. Obtain the
execution maps for `q` and `result` from an original waveform with `q`
dumped. Enable operand capture on the `result` assignment and declare
writer coverage for both signals from tick 1. For the instrumented run,
use the fixture's dump list and watch `clk`, `hi`, `lo` and `result`.

At tick 5, the time graph traces `result` through `q[4:5]` at tick 1 and
`q[6:7]` at tick 3 to the corresponding bits of `hi` and `lo`. To check
partial recovery, omit the source hash for the second write in the replay
log. Bits 6 and 7 then show their captured values at tick 5.

Repeat with `vcs_undumped_overlap_tb.sv`, top `undumped_overlap_tb`,
and add `recovery` to the watch list. At tick 5, the captured values of
bits 6 and 7 remain visible because an overlapping commit at tick 3
was unobserved. Bits 4 and 5 still trace to tick 1. At tick 7, bits 6
and 7 trace to the confirmed recovery write at tick 5 and its RHS.

### VCS same-tick RHS combinations

Build `vcs_multi_rhs_tb.sv` with top `multi_rhs_tb`. Use the VCS NBA
probe steps for `left_q`, `right_q`, `and_q` and `or_q` with writer
coverage starting at tick 1. Watch `clk`, `seed`, `left_q`, `right_q`,
`and_q` and `or_q` in the same order offline and live.

At tick 3, both source registers fall from 1 to 0 while the two result
registers rise to 1. The recorded RHS in the AND trace retains the
pair `(1,1)`. The OR trace retains `(0,1)`, `(1,0)` and `(1,1)`.
The time graph shows the number of compatible observed combinations,
and the detailed report lists each pair. The live and offline traces
can be queried through MCP.

Repeat in a fresh directory with `captureOperands: true` in the
`wave_execution_map` requests. The returned maps contain
`sampleOperands: ["left_q", "right_q"]` for `and_q` and `or_q`.
Pass the returned maps directly to the generator. In both evaluations at
tick 3, the log records the actual inputs as `operandValues`. Both queries
retain only `(1,1)` when those values are available. Replay the same log
with the operand fields omitted to verify the three OR candidates again.

To reproduce a missing waveform source, change the generated copy's
`$dumpvars` list to `clk, seed, left_q, and_q, or_q` and omit
`right_q` from both VPI watch lists. Keep its operand capture enabled.
With complete writer coverage, the OR trace links the captured `right_q=1`
to commit 7 at tick 1 and continues to `seed`. The graph retains the waveform
gap and traces the dumped `left_q` to tick 1. If the replay log omits
`right_q`'s writer coverage, the same query shows the captured sample at
tick 3 with evaluation order 16.

## Interface arrays with named modports

Run VCS in a scratch directory with `fixture` set to the absolute path of
`modport_array_tb.sv` and `VERDI_HOME` set to the Verdi installation.

~~~sh
pli="$VERDI_HOME/share/PLI/VCS/LINUX64"
vcs -full64 -kdb -sverilog -timescale=1ns/1ns -debug_access+all -top array_tb \
  -P "$pli/novas.tab" "$pli/pli.a" "$fixture" -o simv
./simv
~~~

Open `array.vcd` or `array.fsdb` from that directory with the independent
reader. A Driver or time trace of `array_tb.p` at tick 1 reaches
`channels[4].data` and `a`. The trace of `array_tb.n` at tick 3 reaches
`channels[5].data` and `b`. A Load trace from either member or TB input
reaches its corresponding output. The FSDB also exposes the per-element
sender and receiver aliases.

For automated checks, set `WAVE_TEST_MODPORT_ARRAY_KDB` to the generated
`simv.daidir` and `WAVE_TEST_MODPORT_ARRAY_FSDB` to `array.fsdb`. Use
`WAVE_TEST_INDEPENDENT=1` to exercise independent KDB reverse bindings.

Repeat the build with `modport_array_expr_tb.sv` to exercise selection by
constant arithmetic and a generate loop. The writer at `src.drive[0]` uses
`link[7]` and the one at `src.drive[1]` uses `link[6]`. The sink uses
`-(2-1)` and `2*2-4` to select the corresponding receiver members. The VCD
and FSDB preserve the same output transition ticks as the fixed-index fixture.

Build `modport_array_param_tb.sv` with the same command to exercise
per-instance integer parameters. `lx.DEST` is 7 and `ly.DEST` is 6 after
evaluating their localparams. `rx.DEST` is −1 and `ry.DEST` is 0. The Driver
and Load graphs keep the two channels separate. The time graph labels these
values as elaborated parameters. Set `WAVE_TEST_PARAMETER_INTERFACE_KDB` to
the generated `simv.daidir` for the independent reader regression.

## Independent KDB port connections

The same VCS command can build `generic_interface_tb.sv` with `-top generic_tb`.
The two copies of the generic source and sink ports connect to unrelated
interface types that both declare `data`. The VCD and FSDB show
`p` changing at tick 1 through `x.data` and `n` changing at tick 3 through
`y.data`. Set `WAVE_TEST_GENERIC_INTERFACE_KDB` to the generated
`simv.daidir` and `WAVE_TEST_GENERIC_INTERFACE_FSDB` to `generic.fsdb`
for the reader regressions.

Use `generic_modport_tb.sv` with the same top and command to pass explicit
sender and receiver views to the generic ports on channel `x`. The modules
on channel `y` forward their typed views through a wrapper. Both waveforms
give the same transition ticks as `generic_interface_tb.sv`. In FSDB, the
sender `tx` and receiver `rx` alias paths trace to each channel's `data`.
Set `WAVE_TEST_GENERIC_MODPORT_KDB` to the resulting `simv.daidir` for the
independent KDB regression.

Use `generic_array_tb.sv` with the same top and VCS command for generic
interface arrays. The two pairs of module instances use different interface
types. The source formals have bounds `[7:6]` and the sink formals `[-1:0]`.
The outputs `p`, `n`, `r`, and `s` rise at ticks 1–4 through
`x[4]`, `x[5]`, `y[3]`, and `y[2]`, respectively. Set
`WAVE_TEST_GENERIC_ARRAY_KDB` and `WAVE_TEST_GENERIC_ARRAY_FSDB` to the
generated database and FSDB for the binding and repeated-declaration regressions.

Compile and run `independent_ports_tb.sv` with VCS from a scratch directory.

~~~sh
vcs -full64 -kdb -sverilog -debug_access+all -timescale=1ns/1ns \
  -top ports_tb independent_ports_tb.sv -o simv
./simv
~~~

Set `WAVE_TEST_INDEPENDENT_PORTS_KDB` to the resulting `simv.daidir` and run
`WAVE_TEST_INDEPENDENT=1 node --test test/kdb.test.js`. The fixture covers
named, positional, shorthand, wildcard, non-ANSI, and bidirectional ports,
plus a generate scope and both open and concatenated connections. Add
`+define+WAVE_TEST_FSDB` and the Verdi VCS PLI when generating `ports.fsdb` for
the independent waveform and KDB integration check.

## Packed port slices

Build the timing-enabled testbench with a C++20 toolchain. It connects an
ascending TB input slice to the DUT and sends the DUT result to a descending TB
output slice.

~~~sh
verilator --json-only --top-module port_slice_tb -Wno-LITENDIAN port_slice_tb.sv
verilator --binary --timing --trace-fst --top-module port_slice_tb \
  -Wno-LITENDIAN --Mdir port_slice_sim port_slice_tb.sv
./port_slice_sim/Vport_slice_tb
~~~

Set `WAVE_TEST_PORT_SLICE` to this directory to test the two port ranges, Mermaid
labels and detailed report.

For the independent KDB case, compile the same fixture with VCS to verify
indexed selects, one-bit selects, and constant inputs.

~~~sh
pli="$VERDI_HOME/share/PLI/VCS/LINUX64"
vcs -full64 -kdb -sverilog -debug_access+all -top port_slice_tb \
  +define+WAVE_TEST_KDB_PACKED -P "$pli/novas.tab" "$pli/pli.a" port_slice_tb.sv -o simv
./simv
~~~

Set `WAVE_TEST_INDEPENDENT_PACKED_KDB` to the resulting `simv.daidir` and run
`WAVE_TEST_INDEPENDENT=1 node --test test/kdb.test.js`. Open `port_slice.fsdb` in
independent mode for dynamic tracing. At tick 5, `dut_response` is `00100000`,
the fixed indexed selects produce `10`, and the signed, unsigned, unknown, and
fill examples produce `11`, `01`, `xz`, and `11`.
The conversion examples cover widening to `0010`, truncation to `01`, signed
widening to `1110`, and a two-state port that turns `1x` into `10`. The whole
signal examples also cover a parameterized destination width and zero extension
into a signed formal. Set `WAVE_TEST_PACKED_CONVERSION_FSDB` to the resulting FSDB
for the backend declaration and sampling test.
The dynamic input `tb_request[index]` produces `1`, `0`, and `x` at ticks 5,
6, and 7. Trace Loads from `index` to verify the selected port and the data input.

## Arrayed module ports

Build the VCS fixture and sample its FSDB to verify ordered slices and broadcast ports.

~~~sh
pli="$VERDI_HOME/share/PLI/VCS/LINUX64"
vcs -full64 -kdb -sverilog -debug_access+all -top arrays_tb \
  -P "$pli/novas.tab" "$pli/pli.a" array_ports_tb.sv -o simv
./simv
~~~

Set `WAVE_TEST_ARRAY_PORTS_KDB` to `simv.daidir` and
`WAVE_TEST_ARRAY_PORTS_FSDB` to `arrays.fsdb`. Tick 5 contains `1001`, `0110`,
and `00111100` in the three composite outputs. The split and broadcast constant
ports produce `1001` and `1010`.

## Packed output concatenation

Compile `output_concat_tb.sv` with VCS KDB and the Verdi FSDB PLI. Point
`WAVE_TEST_OUTPUT_CONCAT_KDB` at the resulting `simv.daidir` for the KDB regression.

~~~sh
pli="$VERDI_HOME/share/PLI/VCS/LINUX64"
vcs -full64 -sverilog -kdb -debug_access+all -top tb \
  -P "$pli/novas.tab" "$pli/pli.a" output_concat_tb.sv -o simv
./simv
~~~

Both `out.vcd` and `out.fsdb` record `upper[2]`, `lane[1]`, `tail_a` and
`tail_b` rising at 2, 5, 8 and 11 ps respectively. The corresponding child
output bits are `dut.q[0]`, `dut.q[2]`, `dut.q[4]` and `dut.q[5]`.
At 2 ps, `{sign_hi, sign_lo}` is `1100` and `{zero_hi, zero_lo}` is
`0100`. Driver tracing links `sign_hi[1]` to `s.q[0]` and assigns a
constant zero to `zero_hi[1]`. The two-bit concatenation receives only
`n.q[1:2]`. Its two targets rise at 5 and 8 ps respectively. Load tracing
from `n.q[0]` returns neither target.

## Execution recording

Build the opt-in Verilator recorder and generate its waveform-bound event file.
The harness records the `owner_q` process trigger, branch, NBA evaluation and
commit. It checks that only one owner evaluation occurs per tick and compares
the scheduled value to the post-evaluation signal.

~~~sh
verilator --cc --exe --build --trace-fst --top-module trace_tb \
  +define+WAVE_EXECUTION_TRACE -CFLAGS -DWAVE_EXECUTION_TRACE trace_tb.sv sim.cc
./obj_dir/Vtrace_tb > execution.raw.jsonl
node record-execution.mjs trace_tb.sv trace.fst execution.raw.jsonl execution.jsonl
~~~

Set `WAVE_TEST_EXECUTION_TRACE` to this directory for the playback test. The
`wave_trace_context` MCP tool accepts `executionLog` alongside the waveform.
`wave_execution_trace` also replays the file with an exact instance and signal
name. The execution header declares coverage for the `owner_q` writer, and a
completion record identifies the last recorded tick and event count. The
replay checks both before reporting that the signal held through the cursor.

## Same-tick writes in multiple instances

The execution-order fixture instantiates two copies of one writer. Each writer
performs a blocking write and schedules two NBAs to the same one-bit register
within one activation. On Verilator 5.054, the generated code stores both NBA
values in the same delayed temporary and applies its final value to the
register. The fixture records the blocking assignment at its source probe,
links the superseded NBA to its replacement and samples the final NBA value
after `eval()`. Events sampled after evaluation carry `timing: "end-of-slot"`.
Their ordinals order the records, and the probe establishes the assignment
sequence within each instance.

~~~sh
verilator --json-only --top-module execution_order_tb -Wno-BLKANDNBLK execution_order_tb.sv
cp obj_dir/Vexecution_order_tb.tree{,.meta}.json .
verilator --cc --exe --build --trace-fst --top-module execution_order_tb \
  -Wno-BLKANDNBLK --Mdir order_obj execution_order_tb.sv execution_order.cc
./order_obj/Vexecution_order_tb > order.raw.jsonl
node record-execution.mjs execution_order_tb.sv trace.fst order.raw.jsonl execution.jsonl \
  execution-order-coverage.json
~~~

Set `WAVE_TEST_EXECUTION_ORDER` to this directory to exercise both instance
paths. At tick 3, both registers perform writes and finish at their previous
values. At tick 5, the clock triggers both writers and both registers hold.

The `wave_execution_map` tool returns the elaborated statement IDs for a
selected signal. For the two-instance example, attach
`Vexecution_order_tb.tree.json` to the waveform and call the tool for
`q` in `TOP.execution_order_tb.first` and `TOP.execution_order_tb.second`.
Save the two tool result objects as a JSON array and pass that file as the
optional sixth argument to `record-execution.mjs`. Each scope in this fixture
has one writer. The recorder matches its existing probe markers to the
generated coordinates and emits the generated IDs in the recording.

## Recorded pipeline in live mode

Build `sampled_pipe_tb.sv` with top `sampled_pipe_tb`. Generate the Verilator
elaboration JSON from the original RTL and attach it to a FST or VCD of the
same design. Run `wave_execution_map` for `first_q` and `second_q` in
`TOP.sampled_pipe_tb` and save the two tool results as an array in
`maps.json`. From a scratch directory, with `repo` pointing to the Wave
Workbench checkout and its TypeScript output built, run:

~~~sh
node "$repo/scripts/verilator-execution.mjs" generate maps.json generated
verilator --cc --exe --trace-fst --top-module sampled_pipe_tb --Mdir obj_dir \
  -CFLAGS "-I$repo/native -I$PWD/generated" \
  generated/wave_workbench_probe.sv generated/sampled_pipe_tb.sv \
  "$repo/test/fixtures/trace/sampled_pipe_sim.cc" "$repo/native/verilator_execution.cc"
node "$repo/scripts/verilator-execution.mjs" scheduler \
  generated/execution-probes.json obj_dir obj_verified
make -C obj_verified -f Vsampled_pipe_tb.mk
./obj_verified/Vsampled_pipe_tb > raw.jsonl
node - <<'JS'
const fs = require("node:fs");
const { sites } = require("./generated/execution-probes.json");
const coverage = ["first_q", "second_q"].map((signal) => {
  const instance = "TOP.sampled_pipe_tb";
  const writers = [...new Set(sites
    .filter(site => site.signal === signal && site.instance === instance)
    .map(site => site.processId))];
  return { instance, signal, start: "0", writers };
});
fs.writeFileSync("coverage.json", JSON.stringify(coverage));
JS
node "$repo/scripts/verilator-execution.mjs" seal \
  generated/execution-probes.json trace.fst 1ps raw.jsonl execution.jsonl coverage.json
~~~

Set `WAVE_TEST_LIVE_RECORDED_UPSTREAM` and `WAVE_TEST_RECORDED_UPSTREAM` to
this directory for the live and offline tests. The same executable generates
the FST and serves live snapshots. To verify the IDE integration, attach the
original elaboration, add its hashes and the executable SHA-256 to the build
manifest, and start the harness. After two rising clock edges, use **Trace
Live Signal** or `wave_live_trace` on `second_q` with the execution JSONL.
The time graph identifies commit 8 at tick 3 and traces it to `first_q` commit
4 at tick 1. The execution graph and detailed report also include the
`first_q` evaluation (order 1) and commit (order 4). Both forms of evidence
are available through MCP. The VS Code live trace command opens the same
upstream event details in Markdown.

The harness deasserts `value` at tick 2. At tick 3, `first_q` falls to 0
and `second_q` rises to 1. A waveform-only query shows both samples
of `first_q` as candidates. With the execution log, evaluation 7
records RHS 1 and keeps the edge from the `first_q` change at tick 1.
Compare the offline graph, the online graph and the Markdown report.

## Recorded DPI call

The `recorded_dpi` fixture calls `adjust` from a blocking assignment. Generate
the elaboration tree from `recorded_dpi/recorded_dpi_tb.sv` with top
`recorded_dpi_tb` and use `wave_execution_map` for
`TOP.recorded_dpi_tb.result`. Use the assignment's ID in `external.json`
under `assignments`. In `steps`, map `adjust.entry` and `adjust.result` to
lines 5 and 9 of `recorded_dpi/stimulus.cc`, each at column 3.

Generate the probes with `generate maps.json generated external.json`.
Build the generated package and instrumented RTL with `--trace-vcd`, linking
`recorded_dpi/harness.cc`, `recorded_dpi/stimulus.cc` and
`native/verilator_execution.cc`. Include the generated and native directories.
Run the executable from the scratch directory and redirect stdout to
`raw.jsonl`. Seal the generated `trace.vcd` at `1ps` with writer coverage for
`TOP.recorded_dpi_tb.result`. Set `WAVE_TEST_RECORDED_DPI` to the scratch
directory to run the replay test. At tick 3, the recorded argument and return
value are 4 and 8. The evaluated assignment points to both C++ locations.
