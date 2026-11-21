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

## Feedback and missing samples in a time trace

Copy `time_feedback_tb.sv` to a scratch directory and run:

~~~sh
printf '%s\n' time_feedback_tb.sv > sources.f
vcs -full64 -sverilog -kdb -debug_access+all -top time_feedback_tb -f sources.f -o simv
./simv
~~~

Open `time_feedback.vcd` with `wave_open`, then attach `simv.daidir` with
`wave_design_attach`. Call `wave_trace_context` with `filelist` pointing to
`sources.f` and these arguments:

~~~json
{
  "signal": "time_feedback_tb.q",
  "tick": "3",
  "historyStart": "0",
  "maxDepth": 1,
  "followContinuations": 0,
  "output": "paged"
}
~~~

The first response reports two pending time points. Pass its
`continuationCursor` to `wave_trace_resume` with `followAllContinuations: true`,
`output: "paged"`, `format: "mermaid"` and `detail: "full"`. Read
`feedbackEdges`, `gaps`, `mermaid`, and `report` using `wave_trace_graph_page`.
The time graph marks the closure of the feedback loop at ticks 0 and 3. The
undumped `hidden` signal keeps coverage partial after the pending queue empties.

## Procedural case inside

Copy `case_inside_tb.sv` to a scratch directory and build it with VCS.

~~~sh
printf '%s\n' case_inside_tb.sv > sources.f
vcs -full64 -sverilog -kdb -debug_access+all -top case_inside_tb -f sources.f -o simv
./simv
~~~

Use the modified VIDE server. Open `case_inside.vcd`, attach `simv.daidir`,
and pass `sources.f` as `filelist` to `wave_trace_drivers`,
`wave_trace_loads`, and `wave_trace_context`. Static Drivers of
`case_inside_tb.q` include all three writes. Loads of `case_inside_tb.sel`
include the selector dependency of each write.

For each timed query, set `historyStart` to two ticks before `tick`, use
`output: "paged"`, and request `format: "mermaid"` and `detail: "full"`.
Read the `nodes`, `edges`, `mermaid`, and `report` sections with
`wave_trace_graph_page`.

| Signal | Tick (ns) | Selector | Data source |
| --- | ---: | --- | --- |
| `q` | 3 | `0101` | `a`, first matching range |
| `q` | 7 | `0111` | `b`, wildcard label |
| `q` | 11 | `10z1` | `a`, first of two matching labels |
| `q` | 15 | `1x01` | `c`, default |
| `q` | 19 | `10z0` | `b`, wildcard label |
| `q` | 23 | `0010` | `c`, default |
| `signed_q` | 3 | `0001` | `c`, after the later unsigned label sets the comparison type |

The clock and selector remain in each time graph. The report for tick 15
shows both label groups evaluating to X and the default write taking effect.

## Procedural case comparison type

Build `case_common_type_tb.sv` with the same VCS options, replacing the source
and top names. Open `case_common_type.vcd`, attach `simv.daidir`, and query
`wave_trace_context` with the generated filelist and a two-tick history.

| Tick (ns) | Selector | `q` (case) | `qz` (casez) | `qx` (casex) |
| ---: | --- | --- | --- | --- |
| 3 | `1111` | `b` | | |
| 7 | `10z1` | Missing label observation | `a` | `a` |
| 11 | `1x01` | `d` | `c` | `a` |
| 15 | `10z0` | | `b` | `b` |

The undumped eight-bit unsigned `late_label` sets the comparison type for
`q`. At tick 3 the earlier labels compare against a zero-extended selector,
and `late_label` contributes no time edge. At tick 7 the preceding labels
fail, and the graph reports `waveformMissing` for `late_label` and partial
coverage. At tick 11 the ordinary case matches an explicit X in its label.

## Parameterized generate branches

Two instances of the same module select different branches of a named
`if/else` and `case`. The negative instance also exercises an assignment in a
nested generate block. The same pair exposes unnamed branches through
`probe_positive` and `probe_negative`. `probe_inline` puts both unnamed
branches on one source line.

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

For the KDB check, run the following commands in a separate scratch directory
with a copy of `generate_tb.sv`.

~~~sh
vcs -full64 -kdb -sverilog -debug_access+all -timescale=1ns/1ns -top generate_tb generate_tb.sv -o simv
./simv
~~~

Attach `simv.daidir` to `generate.vcd` and select a file list containing
`generate_tb.sv`. Driver, Load and time queries follow `probe_positive` to
`p.a` at tick 5 and `probe_negative` to `n.b` at tick 10. KDB reports both
`probe_inline` candidates because the two branches share source line 43.
The Verilator tree provides a column and resolves `probe_inline` to `a`.

### VCS anonymous generate loops

Copy `anonymous_generate_loop_tb.sv` to a scratch directory and build it with
the Verdi PLI enabled. The same run writes FSDB and VCD.

~~~sh
pli="$VERDI_HOME/share/PLI/VCS/LINUX64"
vcs -full64 -sverilog -kdb -debug_access+all -top anonymous_generate_loop_tb \
    +define+WITH_FSDB -P "$pli/novas.tab" "$pli/pli.a" anonymous_generate_loop_tb.sv -o simv
./simv
printf '+define+WITH_FSDB\nanonymous_generate_loop_tb.sv\n' > sources.f
~~~

Set `WAVE_TEST_VCS_ANONYMOUS_LOOP` to the build directory and
`WAVE_WORKBENCH_VIDE_PATH` to the modified VIDE server. The regression in
`test/mcp-headless.test.js` verifies both waveforms, including a trace rooted
at a local signal whose VCD variable name includes `genblk1[-1]`. Set
`WAVE_TEST_INDEPENDENT=1` to run against the independent reader and KDB.
The time graph for each output bit reaches the selected source through the
local `intermediate` and `result_value` signals.

### Verilator generate loops

Copy `anonymous_generate_loop_tb.sv` into a scratch directory and into an
`fst` subdirectory. Build each copy with the named waveform and matching
elaboration metadata. Verilator 5.054 needs the LZ4 and zlib development
libraries for the FST build.

~~~sh
top=anonymous_generate_loop_tb
verilator --json-only --top-module "$top" \
    --json-only-output anonymous_generate_loop.tree.json \
    --json-only-meta-output anonymous_generate_loop.tree.meta.json "$top.sv"
verilator --binary --timing --trace-vcd --top-module "$top" "$top.sv"
"./obj_dir/V$top"
printf '%s.sv\n' "$top" > sources.f

cd fst
verilator --json-only -DWITH_FST --top-module "$top" \
    --json-only-output anonymous_generate_loop.tree.json \
    --json-only-meta-output anonymous_generate_loop.tree.meta.json "$top.sv"
verilator --binary --timing --trace-fst -DWITH_FST --top-module "$top" "$top.sv"
"./obj_dir/V$top"
printf '+define+WITH_FST\n%s.sv\n' "$top" > sources.f
~~~

Set `WAVE_TEST_VERILATOR_ANONYMOUS_LOOP` to the parent scratch directory.
The standalone MCP regression verifies both waveform formats with the modified
VIDE server. Roots `result_bus[0]`, `[1]`, and `[2]` reach `src_a`, `src_b`, and
`src_a`, respectively, through separate `genblk1` iterations.

For the single-statement branch variant, add `-DWITH_INLINE_GENERATE` to
both elaboration and simulation commands in each directory. Add
`+define+WITH_INLINE_GENERATE` to each `sources.f` and set
`WAVE_TEST_VERILATOR_INLINE_LOOP` to the parent scratch directory. The two
branches share a source line. The time graphs retain the selected assignment
column and the corresponding source signal for each bit.

### Generate loops without else

Build `generate_without_else_tb.sv` using Verilator JSON and VCD, or VCS KDB
and VCD, with top `generate_without_else_tb`. Attach the matching design and
use a filelist containing `generate_without_else_tb.sv`. At tick 5,
`negative_only[0]` traces via lane −1 and `center_only[1]` via lane 0. Both
reach `data`. A Load trace from `data` reaches only these two output bits.
The other bits have no assignment after specializing the generate loop.
The regression for an absent scope also exercises a true or unavailable
condition, which retains `unresolvedGenerateBranch`.

### Generate case without default

Run these commands from `test/fixtures/trace` with VCS and Verilator on PATH.

~~~sh
top=generate_without_default_tb
fixture=$(mktemp -d)
mkdir "$fixture/vcs" "$fixture/verilator"
for simulator in vcs verilator; do
  cp "$top.sv" "$fixture/$simulator/"
  printf '%s.sv\n' "$top" > "$fixture/$simulator/sources.f"
done
(
  cd "$fixture/vcs"
  vcs -full64 -sverilog -kdb -debug_access+all -top "$top" "$top.sv" -o simv
  ./simv
)
(
  cd "$fixture/verilator"
  verilator --json-only --top-module "$top" \
    --json-only-output generate_without_default.tree.json \
    --json-only-meta-output generate_without_default.tree.meta.json "$top.sv"
  verilator --binary --timing --trace-vcd -Wno-fatal --top-module "$top" "$top.sv"
  ./obj_dir/Vgenerate_without_default_tb
)
export WAVE_TEST_GENERATE_WITHOUT_DEFAULT="$fixture"
~~~

Use the modified VIDE server and run `npm test` from the repository root.
Bits 0 and 2 trace to `edge_data` at 5 ps via lanes −1 and 1. Bit 1 traces
to `center_data` at 6 ps via lane 0. Load from either input reaches its
corresponding bits. Lane 2 matches none of the case labels. Bit 3 has no
writer or upstream edge. VCS dumps this bit as Z and Verilator dumps it as 0.
An absent scope retains `unresolvedGenerateBranch` when a label matches,
the expression cannot be evaluated, or the operands have different widths.

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

### VCS late callbacks on an undelayed assignment

Use `vcs_late_continuous_callback_tb.sv` and the value-change probe above.
Build top `late_continuous_callback_tb`, watch its `a`, `b`, and `q`, and
seal `trace.vcd` with the callback log. With an isolated fixture directory,
put the VCD, sealed log, build manifest and `simv.daidir` in `original/`.

The waveform at tick 5 contains rising edges on `a[1]`, `b[1]`, and `q`.
The value-change log records `a` as callback 0, `q` as callback 1, and
`b` as callback 2. Query `q` at tick 5. With the verified log, its
immediate dependencies include the first callback on `a[1]` and the
prior low sample on `b[1]`. With waveform-only evidence, both rises
remain candidates. Filtering requires a verified callback sequence
that matches the signal history and a resolved undelayed driver.
With complete input coverage, callback 0 changes the RHS to the
observed output value and the RHS holds until callback 1. The graph edge
includes `continuousCause: { sourceOrdinal: 0, targetOrdinal: 1 }`.
The Mermaid graph and detailed report show the same callback pair.

~~~sh
WAVE_WORKBENCH_VIDE_PATH=/path/to/vide \
WAVE_TEST_VCS_LATE_CONTINUOUS_CALLBACK=/path/to/fixture \
node --test --test-name-pattern='after a continuous output change' test/mcp-headless.test.js
~~~

### VCS RV32A dual-hart ready callbacks

Use the OpenTitan RV32A atomic adapter unit test, top
`rv32a_atomic_adapter_tb`, and its ordered VCS source list. With the
original waveform and KDB open, collect execution maps with
`captureOperands: true` for `hart_q` and `rr_q` in
`rv32a_atomic_adapter_tb.dut`. Generate VCS NBA probes and compile the
probe library and the instrumented design as described below. For these
two signals, list the single writer process for each from tick 0 in
`coverage.json`.

In the fixture's `rebuild/` directory, run the instrumented simulation
with the following watch list in order. The packed enum `state_q`
appears as a four-bit value in the callback recording.

~~~sh
instance=rv32a_atomic_adapter_tb.dut
watches=()
for signal in clk_i rst_ni hart_q rr_q capture_atomic selected_hart \
  atomic_req_valid_i atomic_req_ready_o selected_valid init_busy_i state_q; do
  watches+=("+wave_watch=$instance.$signal")
done
./simv +dump_rv32a_wave +rv32a_random_delay=3 +ntb_random_seed=1 \
  +wave_execution_events=raw.jsonl "${watches[@]}"
node "$repo/scripts/verilator-execution.mjs" seal-vpi rv32a_atomic_adapter.vcd \
  raw.jsonl covered.jsonl ../generated/execution-probes.json ../coverage.json
~~~

Place the build manifest beside the VCD and bind it to the replay waveform
and instrumented executable hashes. Use the original RTL hashes and set
source path mappings in `workspace/.vscode/settings.json` for the
instrumented source and the build's source directory. Attach
`rebuild/simv.daidir` to the VCD. In the verified VCS T-2022.06-SP2
recording, the two transitions of `hart_q` at 375000 and 465000 ps link
to commits 136 and 174, and to ready callbacks 131 and 168 through
`capture_atomic` callbacks 132 and 169. For live verification, start the
same executable with the same ordered watches and seed, then use a
commit breakpoint on the `hart_q` assignment. Query `wave_live_trace`
at each matching stop with the sealed replay and build manifest.

~~~sh
WAVE_WORKBENCH_VIDE_PATH=/path/to/vide \
WAVE_TEST_VCS_RV32A_READY=/path/to/fixture \
node --test --test-name-pattern='both RV32A commits' test/mcp-headless.test.js
~~~

To capture the procedural source of each ready transition, include an
execution map for `atomic_req_ready_o` with `captureGuards: true`.
Verify that the map includes both blocking assignments and the
`selected_hart` target index. Include the ready process in writer
coverage from tick 0, regenerate the probes, and repeat the same run
with the same ordered watch list. The instrumented run records the
blocking writes to ready bits 1 and 0 at commits 162 and 219, followed
by ready callbacks 163 and 220. Each evaluation records
`state_q=StIdle`, `init_busy_i=0`, and `selected_valid=1`. The root
NBA commits in this recording are 168 and 226. A path query for
`state_q` joins the sampled guard to the root in three edges.
Use `WAVE_TEST_VCS_RV32A_READY_WRITER` with the instrumented fixture
and the same Node test command to check these paths.

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

#### Two writer instances on the same modport

Use `modport_multiple_writers_tb.sv` in the same VCS build and recording
steps. Both instances execute the same RTL source line and write the same
two ranges of `nested_tb.overlap.data`. Generate a new execution map for
`data` and `bypass` from the original KDB. The map has four `data`
statement IDs across two process IDs. Declare both processes in the writer
coverage for each physical target. Watch `nested_tb.overlap.data`,
`nested_tb.overlap.bypass`, `nested_tb.writer.d`, `nested_tb.writer2.d`,
`nested_tb.b`, `nested_tb.c`, `nested_tb.first` and `nested_tb.second`.

Query `nested_tb.overlap.data` at tick 3 with `historyStart: "0"`. The
waveform and recording yield `x101 → 1001 → 1011 → 0101`. The first two
changes match `nested_tb.writer` and the last two match
`nested_tb.writer2`. Query `data[2]` with `changeOrder` 1, 2 and 3 to
select the first, second and fourth bus callbacks. For online replay,
use the verified build manifest, pause on the second writer's
`assignment-committed` event with `timing: "simulator-commit"` and query the
same reference recording. Regenerate and rebuild the probes to record the
physical commits. With the watches in the order above, the four data commits
are 13, 15, 22 and 23. The running harness advertises `modportCommitEvents`.
The supported probe observes the entire physical word on both sides of the
assignment. Each value-change callback must fit exactly one evaluated
component. Delayed callbacks, incomplete probe maps and ambiguous components
retain `assignment-unobserved`.

To test an ambiguous transition, replace the final `#1 $finish;` in a
scratch copy with the following stimulus, then rebuild the original KDB
and regenerate the probes.

~~~systemverilog
#1 first = 0; b = 7'b0010011;
#0 first = 1;
#1 $finish;
~~~

At tick 4 the callback changes `0101` to `0011`. Both component
evaluations fit that transition. The recording includes the callback and
two unobserved outcomes. Set `WAVE_TEST_VCS_MODPORT_COMMITS` to the
instrumented two-writer directory containing `execution-vcd.jsonl` and
`execution-fsdb.jsonl`, and optionally set `WAVE_TEST_VCS_MODPORT_AMBIGUOUS`
to the ambiguous variant directory containing `execution-vcd.jsonl`.
Run `node --test test/rtl-execution.test.js` from the built repository.

#### Mixed commit coverage in a single time slot

Starting with `modport_multiple_writers_tb.sv`, replace the final `#1 $finish;`
in a scratch copy with the following stimulus. Rebuild the original KDB and
regenerate the probes using the same signal order.

~~~systemverilog
#1 first = 0; second = 0; b = 7'b0010011; c = 7'b1010011;
#0 first = 1;
#0 second = 1;
#1 $finish;
~~~

At tick 4, callback 35 changes the bus to `0011` with ambiguous component
evaluations. Callback 43 changes it to `1011` and links to commit 44 of
`writer2`. A query for `data[3]` links to commit 44. A query for
`data[2]` retains callback 35 and the unobserved outcomes. The same
execution recording restores both changes from the FSDB slot-end value.
Use `wave_live_trace` with the matching sealed FSDB recording after
pausing on the second writer's simulator-commit breakpoint.

At tick 3 all four bus changes have physical commit evidence. Each time
graph node carries both the callback and commit ordinal. To reproduce an
invalid link, edit a copy of the sealed log and change commit 15's
`valueChangeOrdinal` from 12 to 11, the callback for `bypass`. The VCD
query keeps the other three links and lists 15 under the unverified
commit callbacks. A coalesced FSDB sample retains the original dumped
value when the recording's commit and callback evidence disagree.

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

### VCS PLI synchronous write probes

Build the extension, then copy the files from `test/fixtures/trace/vcs_pli` into a scratch directory. The PLI task reads its second argument and writes the first. The probe records the read and intended write before the call to `tf_putp`, then samples the mapped signal immediately after `tf_putp` returns.

~~~sh
node "$repo/scripts/verilator-execution.mjs" generate-vcs-pli calls.json generated
cc -fPIC -I"$VCS_HOME/include" -I"$repo/native" -c driver.c -o driver.o
cc -std=c11 -shared -fPIC -I"$VCS_HOME/include" -I"$PWD/generated" \
  -DWAVE_WORKBENCH_VCS_PROBES "$repo/native/vpi_execution.c" -o wave_vpi.so
vcs -full64 -sverilog -kdb -debug_access+all +vpi -timescale=1ns/1ps \
  -top tb -P drivers.tab driver.o \
  -load "$PWD/wave_vpi.so:wave_workbench_register_vpi" \
  "$PWD/wave_vpi.so" "$PWD/tb.sv" -o simv
./simv +wave_execution_events=raw.jsonl +wave_watch=tb.target \
  +wave_watch=tb.input_value +wave_watch=tb.observed
node - <<'NODE'
const { writeFileSync } = require("node:fs");
const { sites } = require("./generated/execution-probes.json");
writeFileSync("coverage.json", JSON.stringify([
  { instance: "tb", signal: "target", start: "1", writers: [sites[0].processId] },
]));
NODE
node "$repo/scripts/verilator-execution.mjs" seal-vpi trace.vcd raw.jsonl \
  sealed.jsonl generated/execution-probes.json coverage.json
WAVE_TEST_VCS_PLI="$PWD" node --test --test-name-pattern='VCS PLI replay' \
  "$repo/test/rtl-execution.test.js"
~~~

The fixture declares write coverage for its single callback after the declaration initializer at tick 0. In MCP, attach `simv.daidir` to `trace.vcd` and call `wave_trace_context` for `tb.observed` at tick 5000 with `executionLog` set to `sealed.jsonl`.

For an online comparison, use `record-trace-run.mjs --vcs-kdb simv.daidir --manifest build.json --waveform trace.vcd -- ./simv ...` in place of the direct run above. Supply the compile-time hash of `tb.sv` in `build.json`, and keep the same watch arguments. Archive the waveform, its adjacent `.wave-build.json` and `sealed.jsonl` together before launching the live run, since the testbench writes `trace.vcd` again. Attach the archived reference waveform to `simv.daidir`, then launch `wave_live_start` with `backend: "vcs"` from the original run directory. Watch `tb.input_value`, `tb.target` and `tb.observed`.

Use `wave_live_control` with `action: "setStatementBreakpoint"`, `instance: "tb"`, `eventKind: "assignment-committed"` and the statement ID in `generated/execution-probes.json`. Resume and wait for `breakEvent.ordinal` 4 at tick 5000. Call `wave_live_trace` for `tb.observed` with the archived `executionLog`, `historyStart: "0"`, `format: "mermaid"` and `detail: "full"`. The selected replay and the upstream `target` replay match the live events. The graph traces back to `tf_getp(2)` and `tf_putp(1)` in the detailed report, and the capture still reports the `externalPliCallbacks` coverage gap.

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

### VCS fixed-target branch entry

Compile `vcs_fixed_guard_entry_tb.sv` with top `fixed_guard_tb` in
`original/`. Open its VCD with the original KDB and a matching build
manifest. Call `wave_execution_map` for `fixed_guard_tb.q` with
`captureOperands: true` and `captureGuardEntry: true`. The returned map
has the named true block on line 11 and the bare else branch on line 14.

Use the [VCS NBA commit probe steps](#vcs-nba-commit-probes) in `probe/`.
Watch `fixed_guard_tb.clk`, `.select_a`, `.a`, `.b`, and `.q` in that
order. Declare writer coverage for `q` from tick 1 using the process ID
from the map. Save `reference.vcd`, `sealed.jsonl`, and the matching build
manifest in `probe/`, including the instrumented executable hash for
online replay.

Query `wave_trace_context` at ticks 5 and 9 with the sealed log. At tick 5,
evaluation 4 samples `select_a=0` after the block changed it. Commit 6
comes from the true branch entered with `select_a=1`. The time graph follows
the observed `select_a=1` at tick 2 and labels the edge as matching the
recorded branch entry. Tick 9 associates the bare else entry value of 0
with evaluation 10 and commit 12. An online breakpoint on the first
statement's `assignment-committed` event reproduces commit 6.

~~~sh
WAVE_TEST_VCS_FIXED_GUARD=/path/to/fixture \
WAVE_WORKBENCH_VIDE_PATH=/path/to/vide \
node --test --test-name-pattern='fixed-target NBA' test/mcp-headless.test.js
~~~

### VCS case branch entry

Build `vcs_case_entry_tb.sv` with top `case_entry_tb` in `original/` using
the [fixed-target branch entry steps](#vcs-fixed-target-branch-entry).
Generate a map for each of `q`, `qz`, `qx`, `qi`, and `delayed_q`
with `captureOperands: true` and `captureGuardEntry: true`. The map includes
the selected and default arm of each of the four ordinary outputs.
`delayed_q` has an NBA probe and a `#1` delay before the assignment.

Compile the generated probe in `probe/`. Pass the watch signals in this
order under `case_entry_tb`: `clk`, `sel`, `sz`, `sx`, `si`, `a`,
`b`, `q`, `qz`, `qx`, `qi`, `delayed_q`. Declare writer coverage
from tick 1 for each of the five mapped outputs. Seal the execution log
against `reference.vcd` and copy the matching build manifest with
the instrumented executable hash.

| Trace target | Case form | Branch entry at tick 5 | Evaluation / commit |
| --- | --- | --- | --- |
| `q` | `case` | `sel=0101` | 7 / 15 |
| `qz` | `casez` | `sz=10z1` | 9 / 17 |
| `qx` | `casex` | `sx=1x01` | 11 / 19 |
| `qi` | `case inside` | `si=0110` | 13 / 21 |

For each output, query `wave_trace_context` at tick 5 with
`historyStart: "0"` and the sealed log. The graph follows the selector's
tick 2 change. Each NBA samples `0000` at evaluation because its arm clears
the selector before the assignment. At tick 9 each default arm records
`0000` and its graph follows the tick 5 change. At tick 6 the delayed
write to `delayed_q` records tick 5 as the entry time when rebuilt with the
timestamped probes. Archived logs made before timestamp support retain the
original evidence. An online
`assignment-committed` breakpoint on the first `q` statement stops at
commit 15 and reproduces its branch-entry trace.

### VCS timestamped branch entry after a procedural delay

Use `vcs_timed_case_entry_tb.sv` with top `timed_case_tb` and the same
VCS NBA commit-probe steps. Map `q` with `captureOperands: true` and
`captureGuardEntry: true`. Set writer coverage from tick 1 and watch
`clk`, `sel`, `d`, and `q` in that order under `timed_case_tb`.

At tick 5, the case arm records `sel=1` before its `#3` delay. The input
returns to 1 at tick 7 and supplies `d=0x5a` in the same tick. At tick 8
evaluation 6 produces `0x5a` and commit 8 updates `q`.
`wave_trace_context` at tick 8 with `historyStart: "0"` and the sealed log
links the branch entry to the original selector change at tick 2 and the
data input to tick 7. With `historyStart: "7"`, the graph keeps the
recorded branch-entry sample at tick 5 and reports the history gap.
A live `assignment-committed` breakpoint on the selected arm reproduces
the same control and data edges.

~~~sh
WAVE_WORKBENCH_VIDE_PATH=/path/to/vide \
WAVE_TEST_VCS_TIMED_CASE=/path/to/fixture \
node --test --test-name-pattern='delayed NBA' test/mcp-headless.test.js
~~~

### VCS wait resume inside a case

Use `vcs_wait_resume_tb.sv` with top `wait_resume_tb` and the same
VCS NBA commit-probe steps. Map `q` with `captureOperands: true` and
`captureGuardEntry: true`. Set writer coverage from tick 1 and watch
`clk`, `sel`, `ready`, `d`, and `q` in that order under `wait_resume_tb`.

The arm is selected at tick 5 with `sel=1`. At tick 6 the selector
changes to 0 while the process is waiting. At tick 9 `ready=1` resumes
the process and evaluation 6 schedules commit 8. Query `wave_trace_context`
at tick 9 with the sealed log and `historyStart: "0"`. The time graph
links the selection to tick 2, the wait resume to tick 9, and the data to
tick 8. Use a live `assignment-committed` breakpoint on the mapped wait
arm to reproduce the graph while paused at commit 8.

~~~sh
WAVE_WORKBENCH_VIDE_PATH=/path/to/vide \
WAVE_TEST_VCS_WAIT_RESUME=/path/to/fixture \
node --test --test-name-pattern='case entry from a wait resume' test/mcp-headless.test.js
~~~

### VCS standalone wait before an NBA

Use `vcs_standalone_wait_tb.sv` with top `standalone_wait_tb` and the
VCS NBA commit-probe steps. Map `q` with `captureOperands: true` and
`captureGuardEntry: true`. Set writer coverage from tick 1 and watch
`clk`, `ready`, `d`, and `q` in that order under `standalone_wait_tb`.

The independent `wait (ready);` resumes at tick 7. A procedural `#3`
delays the assignment to tick 10, where evaluation 6 schedules commit 8.
`ready` falls at tick 8 and rises again at tick 9. Static Driver and Load
graphs link `ready` and `q` through the wait. In
`wave_trace_context` with the sealed log and `historyStart: "0"`, the
control edge follows the tick 7 resume and the data edge follows tick 9.
With `historyStart: "9"`, the graph keeps the recorded tick 7 sample
and reports the earlier history gap. The first mapped statement also
supports an online `assignment-committed` breakpoint at commit 8.

~~~sh
WAVE_WORKBENCH_VIDE_PATH=/path/to/vide \
WAVE_TEST_VCS_STANDALONE_WAIT=/path/to/fixture \
node --test --test-name-pattern='independent wait' test/mcp-headless.test.js
~~~

### VCS compound wait before an NBA

Use `vcs_compound_wait_tb.sv` with top `compound_wait_tb` and the VCS
NBA commit-probe steps. Map both `q` and `q_direct` with `captureOperands`
and `captureGuardEntry`, then pass both maps in the JSON array to
`generate-vcs-nba`. Set writer coverage for both signals from tick 1.
Watch `clk`, `ready`, `inhibit`, `rescue`, `select_path`, `d`, `q`, and
`q_direct` in that order under `compound_wait_tb`.

The predicate is `ready && (!inhibit || rescue)`. Both waits resume at
tick 7 with `ready=1`, `inhibit=0`, and `rescue=0`. The time graph links
the three operands back to ticks 6, 7, and 0 respectively. The standalone
wait delays evaluation to tick 10, using data from tick 9 and reaching
commit 14. The direct wait inside a `case` arm separately records the
selector at tick 5, uses data from tick 4, and reaches commit 8 at tick 7.
Both graphs mark the transition of `inhibit` at tick 7 with
`waitResumeCause: "uniqueObservedTransition"`. The report lists that
change under **Observed changes that enabled a wait**. The predicate is
false in the waveform immediately before tick 7 and true under the
three recorded resume samples. The marker requires a single observed
operand transition in that tick and a complete observation window.
Query `q` with `historyStart: "9"` to verify that all three recorded tick 7
samples remain available when the earlier waveform history is outside
the window. Both statements can be selected in online commit breakpoints.

The probe supports local integral signals, integer literals, logical and
bitwise operators, equality and relational comparisons, and parentheses.
It samples the operands after the simulator resumes the statement.
Conditions that call functions or use other expression forms remain
eligible for static dependency analysis where VIDE can resolve them.

~~~sh
WAVE_WORKBENCH_VIDE_PATH=/path/to/vide \
WAVE_TEST_VCS_COMPOUND_WAIT=/path/to/fixture \
node --test --test-name-pattern='compound wait' test/mcp-headless.test.js
~~~

### VCS masked and signed comparisons in a wait

Use `vcs_compare_wait_tb.sv` with top `compare_wait_tb`. Map `q` and
`q_direct` with `captureOperands` and `captureGuardEntry` and set writer
coverage from tick 1, as in the compound wait procedure. Watch `clk`,
`ready`, `status`, `balance`, `select_path`, `d`, `q`, and `q_direct`
in that order under `compare_wait_tb`.

The wait checks `(status & 4'b1011) === 4'b10x1` and
`balance < 4'sd0` with `ready` high. At tick 7, `status` changes from
`00x1` to `11x1`. Masking retains the unknown bit, and the case equality
becomes true. The signed `balance` was already `1111` at tick 6.
Both traces mark `status` as the observed change that enabled the wait
and include the other operand samples. The direct NBA inside the
`case` reaches commit 9 at tick 7. The independent wait followed by
a delay reaches commit 15 at tick 10.

~~~sh
WAVE_WORKBENCH_VIDE_PATH=/path/to/vide \
WAVE_TEST_VCS_COMPARE_WAIT=/path/to/fixture \
node --test --test-name-pattern='masked four-state comparison' test/mcp-headless.test.js
~~~

### VCS ordered callbacks in a wait

Use `vcs_ordered_wait_tb.sv` with top `ordered_wait_tb` and the compound
wait procedure above. Watch `clk`, `ready`, `inhibit`, `rescue`,
`select_path`, `d`, `q`, and `q_direct` in that order. At tick 7,
callback 4 sets `ready` to 1 and callback 5 changes `inhibit` to 0.
Replaying the callbacks against the four-state predicate identifies
callback 5 as the transition that makes the wait condition true.

Both the direct commit at tick 7 and the delayed commit at tick 10
return `waitResumeCause: "orderedCallbacks"` and
`waitResumeCallbackOrdinal: 5` on the `inhibit` edge.
This attribution requires complete callbacks for the operands,
agreement with the waveform and the recorded resume samples, and a
predicate that stays true after the enabling transition within the
slot. On an incomplete trace, the graph retains the available operand
samples and candidate edges.

~~~sh
WAVE_WORKBENCH_VIDE_PATH=/path/to/vide \
WAVE_TEST_VCS_ORDERED_WAIT=/path/to/fixture \
node --test --test-name-pattern='ordered callbacks in the same tick' test/mcp-headless.test.js
~~~

### VCS repeated changes in a wait

Use `vcs_repeated_wait_tb.sv` and top `repeated_wait_tb` with the same
execution maps, writer coverage and watched signals as the ordered
wait example. At tick 7, callbacks 4 and 5 change `ready` to 1 and back
to 0. Callback 6 clears `inhibit`. Callback 7 changes `ready` to 1
again and makes the predicate true. In the time graph, callback 7
is the third change of `ready` in that tick. The first change to the
same value is retained as a candidate without the cause marker.
Check direct commit 10 at tick 7 and delayed commit 16 at tick 10.

~~~sh
WAVE_WORKBENCH_VIDE_PATH=/path/to/vide \
WAVE_TEST_VCS_REPEATED_WAIT=/path/to/fixture \
node --test --test-name-pattern='repeated same-value changes' test/mcp-headless.test.js
~~~

### VCS wait resumed during a pulse

Use `vcs_pulsed_wait_tb.sv` with top `pulsed_wait_tb` and the ordered
wait procedure. Build the probe with the current `native/vpi_execution.c`.
At tick 7, callback 5 clears `inhibit` and the simulator resumes both
waits. Callbacks 7 and 8 set and clear `inhibit` again in the same tick.
Both NBA evaluations preserve a resume boundary of 6 in
`guardEntryNextOrdinals`. The boundary is exclusive, so only callbacks
with a smaller ordinal can explain the recorded resume.

Check that direct commit 10 at tick 7 and delayed commit 16 at tick
10 both identify callback 5 and the first `inhibit` change in the slot.
Recordings with complete operand callbacks and matching waveform
history can use the boundary to distinguish multiple true intervals.
Earlier recordings use the existing whole-slot inference.

~~~sh
WAVE_WORKBENCH_VIDE_PATH=/path/to/vide \
WAVE_TEST_VCS_PULSED_WAIT=/path/to/fixture \
node --test --test-name-pattern='condition is true twice' test/mcp-headless.test.js
~~~

### VCS upstream writer of a wait condition

Use `vcs_wait_driver_tb.sv` with top `wait_driver_tb`. In addition to
the two NBA maps from the pulse example, map `inhibit` with
`captureOperands: true` and include all three of its blocking writers
in the coverage declaration. Watch `clk`, `ready`, `inhibit`, `rescue`,
`select_path`, `d`, `q`, `q_direct`, `trigger_value`, and `later_value`
in that order.

At tick 7, the first blocking assignment to `inhibit` emits callback 7
and commit 8. Its captured operand comes from `trigger_value` at tick 3.
The wait resumes before event 9. The later write to the same value emits
callback 14 and commit 15. Query `q` at tick 10 or `q_direct` at tick 7
with `output: "paged"`. In `wave_trace_graph_path`, select
`{"signal":"wait_driver_tb.inhibit","tick":"7","callbackOrdinal":7}` or
`{"signal":"wait_driver_tb.trigger_value","tick":"3","callbackOrdinal":1}`.
The paths should have one and two edges respectively and retain the
blocking writer at RTL line 33.

To verify continuation, add `maxTemporalEdges: 1`,
`maxTemporalGaps: 128` and `followContinuations: 0` to the paged query
for `q`. Its first frontier entry should select the first change of
`inhibit` at tick 7. Call `wave_trace_resume` with
`followContinuations: 1` on that cursor. The joined gap should retain
callback 7 and the upstream commit 8. Both callback selectors above
should return the same hop counts in the combined graph. For live
verification, stop at the commit of `q` and run the same operations
using `wave_live_trace` as the initial query.

~~~sh
WAVE_WORKBENCH_VIDE_PATH=/path/to/vide \
WAVE_TEST_VCS_WAIT_DRIVER=/path/to/fixture \
node --test --test-name-pattern='exact VCS wait cause' test/mcp-headless.test.js
~~~

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
out-of-range indices at ticks 6 and 8 have no writable bits. Current
probes record `assignment-no-target` for both evaluations. At
tick 10, the commit to `q[1]` can still be attributed.

Use `vcs_no_target_tb.sv`, top `no_target_tb`, and a map for `q` to
exercise valid commits in the same slot as an invalid selection. Watch
`no_target_tb.index`, `no_target_tb.first`, `no_target_tb.second`, and
`no_target_tb.q` in that order. Declare writer coverage for `q` from tick 1.
The original and instrumented VCDs both show `0000`, `0001`, and `0011`
at ticks 0, 2, and 4. The sealed log pairs the two no-target outcomes with
evaluations 2 and 10. Commits 6 and 13 write bits 0 and 1 respectively.
Set `WAVE_TEST_VCS_NO_TARGET` to the directory containing `reference.vcd`
and `sealed.jsonl` to run the replay test.

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
slot is 7. Both bit 4 queries trace to `d[1]`. The evaluations retain
the attempted ranges `[7:8]` at tick 6 and `[0:-1]` at tick 8. When the
current probe verifies the in-range bits, the commit lists both the
actual and attempted ranges. Older captures can report these outcomes
as unobserved. The unknown index at tick 10 produces
`assignment-no-target`. Later in-bounds commits remain verifiable.

Use `vcs_partial_target_tb.sv`, top `partial_tb`, to exercise clipping
at both ends of ascending and descending declarations. Map writes to
`asc_left`, `asc_right`, `desc_left`, and `desc_right`, and declare
coverage for each from tick 1. Watch these four signals in that order
followed by `d`, `hi`, `lo`, `zero`, and `above`. VCS T-2022.06-SP2
records four same-value commits at tick 2. At tick 4 the committed bit
of each signal becomes 1 and traces to `d[0]` at tick 3. Set
`WAVE_TEST_VCS_PARTIAL_TARGET` to the directory containing
`reference.vcd` and `sealed.jsonl` to run the replay regression.

### VCS overlapping packed writes

Use the VCS NBA probe steps with `vcs_overlap_write_tb.sv`, top
`overlap_write_tb`, and execution maps for `q` and `mixed` from the original
waveform and KDB. Declare both writers starting at tick 1. Watch
`clk`, `a`, `b`, `q` and `mixed` in the same order in both sessions.
Set `WAVE_TEST_VCS_OVERLAP_WRITE` to the directory with the sealed log and
its `reference.vcd` for the replay check.

At tick 2, the current probes record distinct commits for `q[2:1]`,
`q[1:0]`, and `q[3]`. Query `q[1]` with `changeOrder: 1` and
`changeOrder: 2` to trace the two changes to `a[0]` and `b[1]`.
Repeat with `wave_live_trace` using `executionLog` and the corresponding
instrumented VCD. The live snapshot contains the settled value and the
verified callbacks restore both changes. The `mixed` writes use separate
markers for the dynamic range, fixed range, and whole-variable writes.
At tick 2, `mixed[1]` changes twice and traces to `a[0]` and `b[1]`
respectively. At tick 4, the `mixed[2]` query follows the whole-variable
write of `4'b1000`. To include the index and control values, append `index` and
`phase` to the watch list in both recordings. Older captures can report
some overlapping commits as unobserved. Compare the settled values with
the original VCD and use the instrumented VCD for replay.

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

### VCS recorded shift and mux operands

Use `vcs_recorded_selectors_tb.sv` and the [VCS NBA commit probe steps](#vcs-nba-commit-probes).
Keep the original build in `original/` and the instrumented build in `probe/`.
Compile the original with top `tb`. Place `live.vcd.wave-build.json` next to
the original VCD. Use the `wave-workbench-build` format, schema version 1,
top `tb`, the original source in `roots` and `files`, and the SHA-256 hashes
of the source and VCD. Set `include_dirs` and `defines` to empty arrays.
Open `original/live.vcd` with `original/simv.daidir` attached.
Call `wave_execution_map` for `tb` and each
of `q` and `r`, with `captureOperands: true`. Save both results in the
array passed to `generate-vcs-nba`, writing to `probe/generated/`.

Compile the generated testbench and probe with top `tb`. Run the instrumented
executable from `probe/` and record `raw.jsonl`. Use these watch signals in
order: `tb.clk`, `tb.a`, `tb.b`, `tb.amount`, `tb.choose`, `tb.q`, and
`tb.r`. Copy the resulting `live.vcd` to `reference.vcd` and seal the events
to `sealed.jsonl`. Declare writer coverage from tick 1 for `tb.q` and `tb.r`
with the corresponding process IDs from `generated/execution-probes.json`.
Copy the original build manifest to `reference.vcd.wave-build.json`.
Use absolute paths for the original source so both manifests resolve it
from their respective directories. Set `waveformSha256` to the SHA-256
of the reference VCD and `harnessSha256` to the SHA-256 of the
instrumented `probe/simv`.

From the repository root, use the modified VIDE and run the MCP regression
against the directory containing `original/` and `probe/`.

~~~sh
WAVE_WORKBENCH_VIDE_PATH=/path/to/vide \
WAVE_TEST_VCS_RECORDED_SELECTORS=/path/to/fixture \
node --test --test-name-pattern='recorded VCS shift' test/mcp-headless.test.js
~~~

The test breaks on the commit to `q` at tick 3, traces `q[5]` and `r[3]` to
`a[4] @ 1 ns`, and verifies that a changed recorded shift amount removes
the execution attribution. It then runs the simulation to exit and compares
the online and offline raw recordings.

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

### VCS startup operand reads

Build `vcs_startup_operand_tb.sv` with top `startup_tb`. Follow the VCS NBA
probe steps with writer coverage starting at tick 0 for `seed`, `early` and
`late`. Request `captureOperands: true` for the two result signals and watch
`seed`, `early` and `late` in that order. Use the instrumented VCD for replay.

At tick 0, the VCD shows `seed=1`. The evaluation for `early` reads
`seed=0`, and the evaluation for `late` reads `seed=1` after the blocking
write. With `executionLog`, the time graph links each initial result sample
to its recorded commit. The `early` graph retains the captured operand and
its waveform evidence gap. The `late` graph reaches the blocking write to
`seed` in the same slot.

### VCS elaborated parameter values

Build `vcs_parameter_values_tb.sv` with top `parameter_tb` and options
`-kdb -debug_access+all -timescale=1ns/1ns`. Set
`WAVE_TEST_NPI_PARAMETER_KDB` to the resulting `simv.daidir` and run
`node --test --test-name-pattern='integral parameters' test/kdb.test.js`
with the Verdi SDK backend. The fixture checks different parameter values
for two instances with a shared declaration, including signed, 68-bit and
four-state values. Real and string parameters have declaration locations
and their integral value field is absent.

### Verdi FSDB window seed

Build `selective_dump_tb.sv` with VCS, top `selective_tb` and the
Verdi FSDB PLI. Run the simulator and set `WAVE_TEST_VERDI_SEED_FSDB`
to its `selective.fsdb`. Run
`node --test --test-name-pattern='window seed keeps' test/backend.test.js`
with the Verdi SDK backend. The regression checks that a query at tick 4
returns the source event at tick 3. It also queries the transition itself
and a window straddling it.

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

Use `parameter_packed_tb.sv` to check the elaborated range of a parameterized net. Build with `vcs -full64 -sverilog -kdb -debug_access+all -timescale=1ps/1ps -top tb parameter_packed_tb.sv -o simv` and run `./simv` in the build directory. Set `WAVE_TEST_PACKED_PARAMETER_KDB` to the absolute path of `simv.daidir` and run `node --test --test-name-pattern='KDB packed ranges' test/kdb.test.js` from the repository. The same regression supports the independent reader with `WAVE_TEST_INDEPENDENT=1`. Use `WAVE_TEST_PACKED_PARAMETER_BACKEND` to select a freshly built executable.

The reference `full.vcd` records both `middle` buses. For a partial capture, retain only bit 1 of `tb.short_lane.middle` and bit 0 of `tb.long_lane.middle` in a copy of the VCD. Attach the matching design and trace `tb.short_lane.q` and `tb.long_lane.q` with `maxDepth: 1` and `followAllContinuations: true`. Static Driver reports `unavailableBits` 0 and 1 respectively. A time trace at tick 2 reports `waveformBitsUnavailable` for the same bits and keeps the observed upstream path. The same fixture can be built with Verilator using `--json-only --top-module tb` and `--binary --timing --trace-vcd --top-module tb`.

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
