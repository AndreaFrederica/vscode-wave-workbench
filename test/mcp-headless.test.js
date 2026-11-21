// SPDX-License-Identifier: MPL-2.0

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const sparseCaseFixture = process.env.WAVE_TEST_GENERATE_WITHOUT_DEFAULT;
test("standalone MCP keeps only elaborated writers in a generate case without default", {
  skip: !sparseCaseFixture,
  timeout: 45000,
}, () => {
  const top = "generate_without_default_tb";
  const bits = [[0, "edge_data", "5"], [1, "center_data", "6"], [2, "edge_data", "5"], [3, null, "6"]];
  const loads = [["edge_data", [0, 2]], ["center_data", [1]]];
  for (const [provider, design] of [
    ["vcs", "simv.daidir"],
    ["verilator", "generate_without_default.tree.json"],
  ]) {
    const fixture = path.resolve(sparseCaseFixture, provider);
    const waveform = path.join(fixture, "generate_without_default.vcd");
    const options = { waveform, filelist: path.join(fixture, "sources.f"), detail: "full", format: "mermaid" };
    const [, , ...results] = callTraceMcp(fixture, [
      ["wave_open", { path: waveform, backend: "independent" }],
      ["wave_design_attach", { waveform, path: path.join(fixture, design) }],
      ...bits.map(([bit, , tick]) => ["wave_trace_context", {
        ...options, signal: `${top}.result_bus[${bit}]`, tick, historyStart: "0",
      }]),
      ...loads.map(([name]) => ["wave_trace_loads", { ...options, signal: top + "." + name }]),
    ]);
    for (const [bit, input, tick] of bits) {
      const result = results[bit];
      const writers = result.assignments.filter(({ targets }) => targets.includes(result.root));
      assert.deepEqual(writers.map(({ generateIndices }) => generateIndices?.lane), input ? [bit - 1] : []);
      assert(!result.staticCoverage.stops.some(({ reason }) => reason === "unresolvedGenerateBranch"));
      const { nodes, edges } = result.context.temporalTrace;
      assert.equal(edges.length, input ? 1 : 0);
      if (input) assert(nodes.some(({ signal, tick: sourceTick }) =>
        sourceTick === tick && result.signals.some(({ id, name }) => id === signal && name === input),
      ));
      assert.match(result.temporalMermaid, /flowchart/);
    }
    for (const [index, [, expected]] of loads.entries()) {
      const { assignments } = results[bits.length + index];
      assert.deepEqual(assignments.flatMap(({ targetRange }) => targetRange ? [targetRange[0]] : []).sort(), expected);
    }
  }
});

const recordedSelectors = process.env.WAVE_TEST_VCS_RECORDED_SELECTORS;
test("standalone MCP replays recorded VCS shift and mux operands at a live commit", {
  skip: !recordedSelectors,
  timeout: 30000,
}, (t) => {
  const fixture = path.resolve(recordedSelectors);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wave-live-selectors-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const probe = path.join(fixture, "probe");
  const waveform = path.join(probe, "reference.vcd");
  const executionLog = path.join(probe, "sealed.jsonl");
  const recording = path.join(directory, "live.jsonl");
  const { sites } = JSON.parse(fs.readFileSync(path.join(probe, "generated/execution-probes.json")));
  const statement = sites.find(({ signal }) => signal === "q");
  assert.ok(statement);
  const events = fs.readFileSync(executionLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const evaluation = events.find(({ kind, signal }) => kind === "assignment-evaluated" && signal === "q");
  assert.equal(evaluation.operandValues.amount, "010");
  evaluation.operandValues.amount = "011";
  const changedLog = path.join(directory, "changed.jsonl");
  fs.writeFileSync(changedLog, events.map((event) => JSON.stringify(event)).join("\n") + "\n");

  const options = { waveform, executionLog, tick: "3", historyStart: "0", detail: "full", format: "mermaid" };
  const step = ["wave_live_control", { action: "stepClock", signal: "tb.clk", cycles: 2 }];
  const calls = [
    ["wave_open", { path: waveform }],
    ["wave_design_attach", { waveform, path: path.join(fixture, "original/simv.daidir") }],
    ["wave_live_start", {
      backend: "vcs",
      program: path.join(probe, "simv"),
      cwd: directory,
      signals: ["clk", "a", "b", "amount", "choose", "q", "r"].map((name) => "tb." + name),
      recording,
    }],
    ["wave_live_control", {
      action: "setStatementBreakpoint", instance: "tb", statementId: statement.statementId,
      eventKind: "assignment-committed", timing: "simulator-commit",
    }],
    step,
    ["wave_live_trace", { ...options, signal: "tb.q[5]" }],
    ["wave_live_trace", { ...options, signal: "tb.r[3]" }],
    ["wave_live_trace", { ...options, signal: "tb.q[5]", executionLog: changedLog }],
    ["wave_live_status", {}],
    ["wave_live_control", { action: "clearBreakpoint" }],
    step,
  ];
  const child = spawnSync(process.execPath, [path.resolve(__dirname, "../dist/mcp-headless.js"), directory], {
    input: calls.map(([name, args], id) =>
      JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })
    ).join("\n") + "\n",
    encoding: "utf8",
    timeout: 25000,
  });
  assert.equal(child.status, 0, child.stderr || child.error);
  const responses = child.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(responses.length, calls.length);
  const values = responses.map(({ id, result }, index) => {
    assert.equal(id, index);
    assert.equal(result.isError, undefined, result.content[0].text);
    return JSON.parse(result.content[0].text);
  });
  const [, , , , stopped, shift, mux, mismatch, afterQueries, , finished] = values;
  assert.equal(stopped.snapshot.tick, "3");
  assert.equal(stopped.breakEvent.ordinal, 5);
  assert.equal(stopped.breakEvent.timing, "simulator-commit");
  for (const [result, commit, ordinal, name, bits] of [
    [shift, 5, 2, "amount", "010"],
    [mux, 7, 3, "choose", "01"],
  ]) {
    assert.equal(result.executionReplayMatch.status, "matched");
    const root = result.context.temporalTrace.nodes[0];
    assert.equal(root.recordedWriter.commitOrdinal, commit);
    assert.equal(root.recordedWriter.evaluation.ordinal, ordinal);
    assert.equal(root.recordedWriter.evaluation.operandValues[name], bits);
    const range = name === "amount" ? "[2:0]" : "[1:0]";
    assert.ok(result.context.observations.some(({ waveformSignal }) => waveformSignal === "tb." + name + range));
    assert.ok(result.context.temporalTrace.nodes.some(({ signal, bit, tick }) =>
      result.signals.find(({ id }) => id === signal)?.name === "a" && bit === 4 && tick === "1"));
    assert.match(result.report, /matches recorded RHS/);
  }
  assert.equal(mismatch.executionReplayMatch.status, "eventSequenceDiffers");
  assert.equal(mismatch.context.temporalTrace.nodes[0].recordedWriter, undefined);
  assert.equal(afterQueries.snapshot.tick, "3");
  assert.equal(finished.state, "exited");
  assert.equal(fs.readFileSync(recording, "utf8"), fs.readFileSync(path.join(probe, "raw.jsonl"), "utf8"));
});

const fixedGuardFixture = process.env.WAVE_TEST_VCS_FIXED_GUARD;
test("standalone MCP traces a fixed-target NBA to the recorded branch entry", {
  skip: !fixedGuardFixture,
  timeout: 25000,
}, () => {
  const fixture = path.resolve(fixedGuardFixture);
  const waveform = path.join(fixture, "probe/reference.vcd");
  const request = {
    waveform,
    executionLog: path.join(fixture, "probe/sealed.jsonl"),
    signal: "fixed_guard_tb.q",
    historyStart: "0",
    detail: "full",
    format: "mermaid",
  };
  const [, , yes, no] = callTraceMcp(fixture, [
    ["wave_open", { path: waveform }],
    ["wave_design_attach", { waveform, path: path.join(fixture, "original/simv.daidir") }],
    ["wave_trace_context", { ...request, tick: "5" }],
    ["wave_trace_context", { ...request, tick: "9" }],
  ]);
  for (const [result, commit, expected] of [[yes, 6, "1"], [no, 12, "0"]]) {
    const { nodes, edges } = result.context.temporalTrace;
    const target = nodes.findIndex(({ recordedWriter }) => recordedWriter?.commitOrdinal === commit);
    assert(target >= 0);
    const evaluation = nodes[target].recordedWriter.evaluation;
    assert.equal(evaluation.operandValues.select_a, "0");
    assert.deepEqual(Object.values(evaluation.guardEntryValues), [expected]);
    const sources = edges.filter(edge => edge.target === target && edge.controlSampleEvidence === "recordedBranchEntry");
    assert.deepEqual(sources.map(edge => nodes[edge.source].value), [expected]);
    assert.match(result.temporalMermaid, /matches recorded branch entry/);
    assert.match(result.report, /Recorded branch entry/);
  }
});

const timedCaseFixture = process.env.WAVE_TEST_VCS_TIMED_CASE;
test("standalone MCP traces a delayed NBA through its earlier case entry", {
  skip: !timedCaseFixture,
  timeout: 25000,
}, () => {
  const fixture = path.resolve(timedCaseFixture);
  const waveform = path.join(fixture, "probe/reference.vcd");
  const request = {
    waveform,
    executionLog: path.join(fixture, "probe/sealed.jsonl"),
    signal: "timed_case_tb.q",
    tick: "8",
    detail: "full",
    format: "mermaid",
  };
  const [, , full, windowed] = callTraceMcp(fixture, [
    ["wave_open", { path: waveform }],
    ["wave_design_attach", { waveform, path: path.join(fixture, "original/simv.daidir") }],
    ["wave_trace_context", { ...request, historyStart: "0" }],
    ["wave_trace_context", { ...request, historyStart: "7" }],
  ]);
  for (const [result, sourceTick, captured] of [[full, "2", false], [windowed, "5", true]]) {
    const { nodes, edges } = result.context.temporalTrace;
    const target = nodes.findIndex(({ recordedWriter }) => recordedWriter?.commitOrdinal === 8);
    assert(target >= 0);
    const { evaluation } = nodes[target].recordedWriter;
    assert.equal(evaluation.tick, "8");
    assert.deepEqual(Object.values(evaluation.guardEntryTicks), ["5"]);
    const branch = edges.find(edge => edge.target === target && edge.controlSampleEvidence === "recordedBranchEntry");
    assert(branch);
    assert.equal(nodes[branch.source].tick, sourceTick);
    assert.equal(!!nodes[branch.source].branchEntrySample, captured);
    assert.match(result.report, /Case L9:15 · sel = 1 @ 5/);
  }
});

const waitResumeFixture = process.env.WAVE_TEST_VCS_WAIT_RESUME;
test("standalone MCP distinguishes a case entry from a wait resume", {
  skip: !waitResumeFixture,
  timeout: 25000,
}, () => {
  const fixture = path.resolve(waitResumeFixture);
  const waveform = path.join(fixture, "probe/reference.vcd");
  const [, , result] = callTraceMcp(fixture, [
    ["wave_open", { path: waveform }],
    ["wave_design_attach", { waveform, path: path.join(fixture, "original/simv.daidir") }],
    ["wave_trace_context", {
      waveform,
      executionLog: path.join(fixture, "probe/sealed.jsonl"),
      signal: "wait_resume_tb.q",
      tick: "9",
      historyStart: "0",
      detail: "full",
      format: "mermaid",
    }],
  ]);
  const { nodes, edges } = result.context.temporalTrace;
  const target = nodes.findIndex(({ recordedWriter }) => recordedWriter?.commitOrdinal === 8);
  assert(target >= 0);
  const sources = edges.filter(edge => edge.target === target);
  assert.equal(nodes[sources.find(edge => edge.controlSampleEvidence === "recordedBranchEntry").source].tick, "2");
  assert.equal(nodes[sources.find(edge => edge.controlSampleEvidence === "recordedWaitResume").source].tick, "9");
  assert.equal(nodes[sources.find(edge => edge.kind === "data").source].tick, "8");
  assert.match(result.report, /Case L10:15 · sel = 1 @ 5/);
  assert.match(result.report, /Wait resume L12:23 · ready = 1 @ 9/);
});

const standaloneWaitFixture = process.env.WAVE_TEST_VCS_STANDALONE_WAIT;
test("standalone MCP keeps the timestamp of an independent wait before an NBA", {
  skip: !standaloneWaitFixture,
  timeout: 25000,
}, () => {
  const fixture = path.resolve(standaloneWaitFixture);
  const waveform = path.join(fixture, "probe/reference.vcd");
  const [, , result] = callTraceMcp(fixture, [
    ["wave_open", { path: waveform }],
    ["wave_design_attach", { waveform, path: path.join(fixture, "original/simv.daidir") }],
    ["wave_trace_context", {
      waveform,
      executionLog: path.join(fixture, "probe/sealed.jsonl"),
      signal: "standalone_wait_tb.q",
      tick: "10",
      historyStart: "0",
      detail: "full",
      format: "mermaid",
    }],
  ]);
  const { nodes, edges } = result.context.temporalTrace;
  const target = nodes.findIndex(({ recordedWriter }) => recordedWriter?.commitOrdinal === 8);
  assert(target >= 0);
  const sources = edges.filter(edge => edge.target === target);
  assert.equal(nodes[sources.find(edge => edge.controlSampleEvidence === "recordedWaitResume").source].tick, "7");
  assert.equal(nodes[sources.find(edge => edge.kind === "data").source].tick, "9");
  assert.match(result.report, /Wait resume L9:15 · ready = 1 @ 7/);
});

const compoundWaitFixture = process.env.WAVE_TEST_VCS_COMPOUND_WAIT;
test("standalone MCP traces recorded VCS compound wait operands at resume", {
  skip: !compoundWaitFixture,
  timeout: 25000,
}, () => {
  const fixture = path.resolve(compoundWaitFixture);
  const waveform = path.join(fixture, "probe/reference.vcd");
  const common = { waveform, executionLog: path.join(fixture, "probe/sealed.jsonl"), detail: "full", format: "mermaid" };
  const delayed = { ...common, signal: "compound_wait_tb.q", tick: "10" };
  const direct = { ...common, signal: "compound_wait_tb.q_direct", tick: "7" };
  const [, , ...results] = callTraceMcp(fixture, [
    ["wave_open", { path: waveform }],
    ["wave_design_attach", { waveform, path: path.join(fixture, "original/simv.daidir") }],
    ["wave_trace_context", { ...delayed, historyStart: "0" }],
    ["wave_trace_context", { ...direct, historyStart: "0" }],
    ["wave_trace_context", { ...delayed, historyStart: "9" }],
  ]);
  for (const [index, result] of results.entries()) {
    const direct = index === 1;
    const short = index === 2;
    const { nodes, edges } = result.context.temporalTrace;
    const target = nodes.findIndex(({ recordedWriter }) => recordedWriter?.commitOrdinal === (direct ? 8 : 14));
    assert(target >= 0);
    const waits = edges.filter(edge => edge.target === target && edge.controlSampleEvidence === "recordedWaitResume");
    assert.deepEqual(waits.map(({ source }) => {
      const node = nodes[source];
      return [result.signals.find(({ id }) => id === node.signal).name, node.tick, node.value];
    }).sort(), [
      ["inhibit", "7", "0"], ["ready", short ? "7" : "6", "1"], ["rescue", short ? "7" : "0", "0"],
    ]);
    if (short) assert(waits.every(({ source }) => nodes[source].waitResumeSample));
    const causes = waits.filter(({ waitResumeCause }) => waitResumeCause === "uniqueObservedTransition");
    assert.deepEqual(causes.map(({ source }) => nodes[source].signal),
      short ? [] : [result.signals.find(({ name }) => name === "inhibit").id]);
    if (!short) {
      assert.match(result.temporalMermaid, /observed transition enabled wait/);
      assert.match(result.report, /inhibit\x60 became \x600\x60 at tick 7 and enabled the wait/);
    } else {
      assert.doesNotMatch(result.report, /## Observed changes that enabled a wait/);
    }
    const data = edges.find(edge => edge.target === target && edge.kind === "data");
    assert.equal(nodes[data.source].tick, direct ? "4" : "9");
    assert.match(result.report, new RegExp("Wait resume L" + (direct ? "17:23" : "9:15") + " · inhibit = 0 @ 7"));
    if (direct) assert.match(result.report, /Case L15:15 · select_path = 1 @ 5/);
  }
});

const compareWaitFixture = process.env.WAVE_TEST_VCS_COMPARE_WAIT;
test("standalone MCP traces a masked four-state comparison and signed threshold in a VCS wait", {
  skip: !compareWaitFixture,
  timeout: 25000,
}, () => {
  const fixture = path.resolve(compareWaitFixture);
  const waveform = path.join(fixture, "probe/reference.vcd");
  const executionLog = path.join(fixture, "probe/sealed.jsonl");
  const samples = [["q", "10", 15, "11:15", "9"], ["q_direct", "7", 9, "19:23", "4"]];
  const [, , ...results] = callTraceMcp(fixture, [
    ["wave_open", { path: waveform }],
    ["wave_design_attach", { waveform, path: path.join(fixture, "original/simv.daidir") }],
    ...samples.map(([signal, tick]) => ["wave_trace_context", {
      waveform, executionLog, signal: "compare_wait_tb." + signal, tick,
      historyStart: "0", detail: "full", format: "mermaid",
    }]),
  ]);
  for (const [index, result] of results.entries()) {
    const [, , commit, location, dataTick] = samples[index];
    const { nodes, edges } = result.context.temporalTrace;
    const target = nodes.findIndex(({ recordedWriter }) => recordedWriter?.commitOrdinal === commit);
    assert(target >= 0);
    const uses = edges.filter(edge => edge.target === target);
    const causes = uses.filter(({ waitResumeCause }) => waitResumeCause === "uniqueObservedTransition");
    assert.equal(causes.length, 1);
    const source = nodes[causes[0].source];
    assert.equal(result.signals.find(({ id }) => id === source.signal).name, "status");
    assert.deepEqual([source.tick, source.value], ["7", "11x1"]);
    assert.equal(nodes[uses.find(edge => edge.kind === "data").source].tick, dataTick);
    assert(result.report.includes("Wait resume L" + location + " · balance = 1111 @ 7"));
    if (index === 1) assert.match(result.report, /Case L17:15 · select_path = 1 @ 5/);
  }
});

const lateContinuousFixture = process.env.WAVE_TEST_VCS_LATE_CONTINUOUS_CALLBACK;
test("standalone MCP excludes a VCS input callback after a continuous output change", {
  skip: !lateContinuousFixture,
  timeout: 25000,
}, () => {
  const fixture = path.resolve(lateContinuousFixture);
  const waveform = path.join(fixture, "original/trace.vcd");
  const executionLog = path.join(fixture, "original/sealed.jsonl");
  const options = { waveform, signal: "late_continuous_callback_tb.q", tick: "5", historyStart: "0", detail: "full", format: "mermaid" };
  const [, , waveformOnly, recorded] = callTraceMcp(fixture, [
    ["wave_open", { path: waveform }],
    ["wave_design_attach", { waveform, path: path.join(fixture, "original/simv.daidir") }],
    ["wave_trace_context", options],
    ["wave_trace_context", { ...options, executionLog }],
  ]);
  const sources = result => {
    const { nodes, edges } = result.context.temporalTrace;
    return edges.filter(edge => edge.target === 0).map(edge => {
      const node = nodes[edge.source];
      return [result.signals.find(signal => signal.id === node.signal).name,
        node.bit, node.value, node.valueChangeOrdinal, edge.callbackOrder];
    });
  };
  assert(sources(waveformOnly).some(([name, bit, value]) => name === "b" && bit === 1 && value === "1"));
  assert.deepEqual(sources(recorded), [
    ["a", 1, "1", 0, "sourceBeforeTarget"],
    ["b", 1, "0", undefined, undefined],
  ]);
  assert.equal(recorded.context.temporalTrace.nodes[0].valueChangeOrdinal, 1);
  assert(waveformOnly.context.temporalTrace.edges.every(edge => !edge.continuousCause));
  const cause = recorded.context.temporalTrace.edges.filter(edge => edge.continuousCause);
  assert.equal(cause.length, 1);
  assert.equal(recorded.context.temporalTrace.nodes[cause[0].source].valueChangeOrdinal, 0);
  assert.deepEqual(cause[0].continuousCause, { sourceOrdinal: 0, targetOrdinal: 1 });
  assert.match(recorded.temporalMermaid, /callback 0 changed RHS before output callback 1/);
  assert.match(recorded.report, /callback 0 changed RHS before output callback 1/);
});

for (const { fixture, captureWriter, stateOrdinal, commits } of [
  {
    fixture: process.env.WAVE_TEST_VCS_RV32A_READY,
    captureWriter: false,
    stateOrdinal: 135,
    commits: [[136, 131, 132], [174, 168, 169]],
  },
  {
    fixture: process.env.WAVE_TEST_VCS_RV32A_READY_WRITER,
    captureWriter: true,
    stateOrdinal: 167,
    commits: [[168, 163, 164, 162], [226, 220, 221, 219]],
  },
]) test("standalone MCP traces both RV32A commits to their observed ready callbacks" +
  (captureWriter ? " and guarded bit writes" : ""), {
  skip: !fixture,
  timeout: 25000,
}, () => {
  const root = path.resolve(fixture);
  const build = path.join(root, "rebuild");
  const waveform = path.join(build, "rv32a_atomic_adapter.vcd");
  const executionLog = path.join(build, "covered.jsonl");
  const instance = "rv32a_atomic_adapter_tb.dut";
  const options = {
    waveform, executionLog, signal: instance + ".hart_q", historyStart: "365000",
    maxDepth: 5, detail: "full", format: "mermaid",
  };
  const [, , hart1, hart0, state] = callTraceMcp(path.join(root, "workspace"), [
    ["wave_open", { path: waveform }],
    ["wave_design_attach", { waveform, path: path.join(build, "simv.daidir") }],
    ["wave_trace_context", { ...options, tick: "375000" }],
    ["wave_trace_context", { ...options, tick: "465000" }],
    ["wave_execution_trace", { waveform, executionLog, instance, signal: "state_q", tick: "375000" }],
  ]);
  for (const [hart, result] of [[1, hart1], [0, hart0]]) {
    const [commit, readyOrdinal, captureOrdinal, readyCommit] = commits[1 - hart];
    const { nodes, edges } = result.context.temporalTrace;
    const name = node => result.signals.find(({ id }) => id === node.signal)?.name;
    assert.equal(nodes[0].recordedWriter.commitOrdinal, commit);
    const capture = edges.find(edge => edge.target === 0 && name(nodes[edge.source]) === "capture_atomic");
    assert.ok(capture);
    const causes = edges.filter(edge => edge.target === capture.source && edge.continuousCause);
    assert.equal(causes.length, 1);
    const [cause] = causes;
    assert.equal(name(nodes[cause.source]), "atomic_req_ready_o");
    assert.equal(nodes[cause.source].bit, hart);
    assert.deepEqual(cause.continuousCause, { sourceOrdinal: readyOrdinal, targetOrdinal: captureOrdinal });
    if (captureWriter) {
      const writer = nodes[cause.source].recordedWriter;
      assert.equal(writer.commitOrdinal, readyCommit);
      assert.deepEqual(writer.targetRange, [hart, hart]);
      assert.deepEqual(writer.evaluation.operandValues, {
        state_q: "0000", StIdle: "0000", init_busy_i: "0", selected_valid: "1",
      });
      assert.ok(edges.some(edge => edge.target === cause.source &&
        edge.controlSampleEvidence === "recordedEvaluation" &&
        name(nodes[edge.source]) === "state_q"));
    }
  }
  assert(state.events.some(event =>
    event.kind === "signal-value-changed" && event.ordinal === stateOrdinal && event.value === "0001"));
});

const orderedWaitFixture = process.env.WAVE_TEST_VCS_ORDERED_WAIT;
const repeatedWaitFixture = process.env.WAVE_TEST_VCS_REPEATED_WAIT;
test("standalone MCP resolves a VCS wait from ordered callbacks in the same tick", {
  skip: !orderedWaitFixture,
  timeout: 25000,
}, () => checkOrderedWait(orderedWaitFixture, "ordered_wait_tb", [14, 8]));
test("standalone MCP locates the exact VCS wait callback after repeated same-value changes", {
  skip: !repeatedWaitFixture,
  timeout: 25000,
}, () => checkOrderedWait(repeatedWaitFixture, "repeated_wait_tb", [16, 10]));

const pulsedWaitFixture = process.env.WAVE_TEST_VCS_PULSED_WAIT;
test("standalone MCP uses the VCS wait resume ordinal when the condition is true twice", {
  skip: !pulsedWaitFixture,
  timeout: 25000,
}, () => {
  const fixture = path.resolve(pulsedWaitFixture);
  const waveform = path.join(fixture, "probe/reference.vcd");
  const executionLog = path.join(fixture, "probe/sealed.jsonl");
  const [, , ...results] = callTraceMcp(fixture, [
    ["wave_open", { path: waveform }],
    ["wave_design_attach", { waveform, path: path.join(fixture, "original/simv.daidir") }],
    ...[["q", "10"], ["q_direct", "7"]].map(([signal, tick]) => ["wave_trace_context", {
      waveform, executionLog, signal: "pulsed_wait_tb." + signal, tick,
      historyStart: "0", detail: "full", format: "mermaid",
    }]),
  ]);
  for (const [index, result] of results.entries()) {
    const { nodes, edges } = result.context.temporalTrace;
    const target = nodes.findIndex(({ recordedWriter }) => recordedWriter?.commitOrdinal === (index ? 10 : 16));
    assert(target >= 0);
    const recorded = nodes[target].recordedWriter.evaluation.guardEntryNextOrdinals;
    assert.equal(recorded[index ? "p17_23_inhibit" : "p9_15_inhibit"], 6);
    const causes = edges.filter(edge => edge.target === target && edge.waitResumeCause);
    assert.equal(causes.length, 1);
    assert.equal(causes[0].waitResumeCallbackOrdinal, 5);
    const { signal, tick, value, orderAtTick } = nodes[causes[0].source];
    assert.equal(result.signals.find(({ id }) => id === signal).name, "inhibit");
    assert.deepEqual([tick, value, orderAtTick], ["7", "0", 1]);
    assert.match(result.report, /at tick 7 \(recorded callback 5\) and enabled the wait/);
  }
});

const waitDriverFixture = process.env.WAVE_TEST_VCS_WAIT_DRIVER;
test("standalone MCP follows the exact VCS wait cause through its blocking writer", {
  skip: !waitDriverFixture,
  timeout: 25000,
}, () => {
  const fixture = path.resolve(waitDriverFixture);
  const waveform = path.join(fixture, "probe/reference.vcd");
  const executionLog = path.join(fixture, "probe/sealed.jsonl");
  const [, , result] = callTraceMcp(fixture, [
    ["wave_open", { path: waveform }],
    ["wave_design_attach", { waveform, path: path.join(fixture, "original/simv.daidir") }],
    ["wave_trace_context", { waveform, executionLog, signal: "wait_driver_tb.q", tick: "10", historyStart: "0", detail: "full" }],
  ]);
  const { nodes, edges } = result.context.temporalTrace;
  const target = nodes.findIndex(({ recordedWriter }) => recordedWriter?.commitOrdinal === 21);
  assert(target >= 0);
  const cause = edges.find(edge => edge.target === target && edge.waitResumeCallbackOrdinal === 7);
  assert(cause);
  const driver = nodes[cause.source];
  assert.equal(driver.valueChangeOrdinal, 7);
  assert.equal(driver.recordedWriter.commitOrdinal, 8);
  assert.equal(result.assignments[driver.recordedWriter.assignment].location.range.start.line + 1, 33);
  const data = edges.find(edge => edge.target === cause.source && edge.kind === "data");
  assert.equal(nodes[data.source].tick, "3");
  assert.equal(result.signals.find(({ id }) => id === nodes[data.source].signal).name, "trigger_value");
});

function checkOrderedWait(directory, top, commits) {
  const repeated = top === "repeated_wait_tb";
  const fixture = path.resolve(directory);
  const waveform = path.join(fixture, "probe/reference.vcd");
  const executionLog = path.join(fixture, "probe/sealed.jsonl");
  const [, , ...results] = callTraceMcp(fixture, [
    ["wave_open", { path: waveform }],
    ["wave_design_attach", { waveform, path: path.join(fixture, "original/simv.daidir") }],
    ...[["q", "10"], ["q_direct", "7"]].map(([signal, tick]) => ["wave_trace_context", {
      waveform, executionLog, signal: top + "." + signal, tick,
      historyStart: "0", detail: "full", format: "mermaid",
    }]),
  ]);
  for (const [index, result] of results.entries()) {
    const { nodes, edges } = result.context.temporalTrace;
    const target = nodes.findIndex(({ recordedWriter }) => recordedWriter?.commitOrdinal === commits[index]);
    assert(target >= 0);
    const cause = edges.filter(edge => edge.target === target && edge.waitResumeCause);
    assert.equal(cause.length, 1);
    assert.equal(cause[0].waitResumeCause, "orderedCallbacks");
    const ordinal = repeated ? 7 : 5;
    assert.equal(cause[0].waitResumeCallbackOrdinal, ordinal);
    const { signal, tick, value, orderAtTick } = nodes[cause[0].source];
    assert.equal(result.signals.find(({ id }) => id === signal).name, repeated ? "ready" : "inhibit");
    assert.deepEqual([tick, value, orderAtTick], repeated ? ["7", "1", 3] : ["7", "0", undefined]);
    if (repeated) assert(edges.some(edge => {
      const source = nodes[edge.source];
      return edge.target === target && !edge.waitResumeCause && source.signal === signal &&
        source.tick === tick && source.value === value && source.orderAtTick === 1;
    }));
    assert(result.report.includes("at tick 7 (recorded callback " + ordinal + ") and enabled the wait"));
  }
}

const anonymousLoop = process.env.WAVE_TEST_VCS_ANONYMOUS_LOOP;
const verilatorLoop = process.env.WAVE_TEST_VERILATOR_ANONYMOUS_LOOP;
const verilatorInlineLoop = process.env.WAVE_TEST_VERILATOR_INLINE_LOOP;
test("standalone MCP specializes anonymous generate iterations in VCS FSDB and VCD", {
  skip: !anonymousLoop,
  timeout: 45000,
}, () => checkAnonymousLoop(path.resolve(anonymousLoop), false));
test("standalone MCP specializes anonymous generate iterations in Verilator VCD and FST", {
  skip: !verilatorLoop,
  timeout: 45000,
}, () => checkAnonymousLoop(path.resolve(verilatorLoop), true));
test("standalone MCP specializes single-statement Verilator generate branches inside a loop", {
  skip: !verilatorInlineLoop,
  timeout: 45000,
}, () => checkAnonymousLoop(path.resolve(verilatorInlineLoop), true));

function checkAnonymousLoop(fixture, verilator) {
  const top = "anonymous_generate_loop_tb";
  for (const extension of verilator ? ["vcd", "fst"] : ["fsdb", "vcd"]) {
    const directory = verilator && extension === "fst" ? path.join(fixture, "fst") : fixture;
    const waveform = path.join(directory, "anonymous_generate_loop." + extension);
    const options = {
      waveform,
      filelist: path.join(directory, "sources.f"),
      detail: "full",
      format: "mermaid",
    };
    const backend = verilator || process.env.WAVE_TEST_INDEPENDENT ? "independent" : "verdi";
    const design = verilator ? "anonymous_generate_loop.tree.json" : "simv.daidir";
    const calls = [
      ["wave_open", { path: waveform, backend }],
      ["wave_design_attach", { waveform, path: path.join(directory, design) }],
      ...[[0, "5"], [1, "6"], [2, "5"]].map(([bit, tick]) => [
        "wave_trace_context",
        { ...options, signal: top + `.result_bus[${bit}]`, tick, historyStart: "0" },
      ]),
      ["wave_trace_context", {
        ...options, signal: top + ".genblk1[-1].result_value", tick: "5", historyStart: "0",
      }],
      ...["src_a", "src_b"].map((name) => [
        "wave_trace_loads", { ...options, signal: top + "." + name },
      ]),
    ];
    const values = callTraceMcp(fixture, calls);
    const traces = values.slice(2, 5);
    for (const [bit, trace] of traces.entries()) {
      const iteration = bit - 1;
      const inputName = iteration === 0 ? "src_b" : "src_a";
      const scope = top + `.genblk1[${iteration}]`;
      assert.deepEqual(
        trace.assignments.filter((assignment) => assignment.targets.includes(trace.root))
          .map(({ instance, generateIndices, targetRange }) => ({ instance, generateIndices, targetRange })),
        [{ instance: scope, generateIndices: { index: iteration }, targetRange: [bit, bit] }],
      );
      const actual = trace.context.temporalTrace.nodes.map(({ signal }) =>
        trace.signals.find(({ id }) => id === signal));
      assert.ok(actual.some(({ instance, name }) => instance === top && name === inputName));
      assert.ok(actual.some(({ instance, name }) => instance === scope && name === "result_value"));
      assert.ok(actual.some(({ instance, name }) => instance === scope && name === "intermediate"));
      assert.ok(!trace.staticCoverage.stops.some(({ reason }) => reason === "unresolvedGenerateBranch"));
      assert.match(trace.temporalMermaid, /flowchart/);
    }
    const local = values[5];
    const root = local.signals.find(({ id }) => id === local.root);
    assert.equal(root.instance, top + ".genblk1[-1]");
    assert.equal(root.name, "result_value");
    for (const [trace, expectedBits] of [[values[6], [0, 2]], [values[7], [1]]]) {
      assert.deepEqual(trace.assignments.flatMap(({ targetRange }) => targetRange ? [targetRange[0]] : []), expectedBits);
      assert.ok(!trace.staticCoverage.stops.some(({ reason }) => reason === "unresolvedGenerateBranch"));
    }
  }
}

function callTraceMcp(workspace, calls) {
  const child = spawnSync(process.execPath, [path.resolve(__dirname, "../dist/mcp-headless.js"), workspace], {
    input: calls.map(([name, args], id) =>
      JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })
    ).join("\n") + "\n",
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout: 20000,
  });
  assert.equal(child.status, 0, child.error || child.stderr);
  const values = child.stdout.trim().split("\n").map((line, index) => {
    const { id, result } = JSON.parse(line);
    assert.equal(id, index);
    assert.equal(result.isError, undefined, result.content[0].text);
    return JSON.parse(result.content[0].text);
  });
  assert.equal(values.length, calls.length);
  return values;
}

test("standalone MCP opens, clips and exports without a VS Code connection", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wave-headless-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "mixed.vcd"), [
    "$timescale 1 ns $end", "$scope module tb $end",
    "$var real 64 r voltage $end", "$var wire 1 w ready $end",
    "$upscope $end", "$enddefinitions $end",
    "#0", "r0.125 r", "0w", "#5", "r-2.5 r", "1w", "#12", "",
  ].join("\n"));
  const clip = { signals: ["tb.voltage", "tb.ready"], start: "2", end: "12" };
  const calls = [
    ["wave_open", { path: "mixed.vcd" }],
    ["wave_search", { query: "voltage" }],
    ["wave_clip", clip],
    ["wave_export", { ...clip, format: "png" }],
    ["wave_export", { ...clip, format: "vcd", path: "cut.vcd" }],
    ["wave_export", { ...clip, format: "vcd", path: "cut.vcd" }],
    ["wave_close", {}],
    ["wave_list", {}],
  ];
  const input = calls.map(([name, args], id) =>
    JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })
  ).join("\n") + "\n";
  const child = spawnSync(process.execPath, [path.resolve(__dirname, "../dist/mcp-headless.js"), dir], {
    input,
    encoding: "utf8",
    env: { ...process.env, TMPDIR: dir, DISPLAY: "", VSCODE_IPC_HOOK_CLI: "" },
    timeout: 15000,
  });
  assert.equal(child.status, 0, child.stderr);
  const responses = child.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(responses.map(({ id }) => id), calls.map((_, id) => id));
  for (const { result, id } of responses) assert.equal(Boolean(result.isError), id === 5, JSON.stringify(result.content[0]));
  const data = (index) => JSON.parse(responses[index].result.content[0].text);
  assert.equal(data(0).scale, "1ns");
  assert.ok(data(1).signals[0].real);
  assert.deepEqual(data(2).traces[0].events, [["2", "0.125"], ["5", "-2.5"]]);
  assert.equal(responses[3].result.content[1].mimeType, "image/png");
  assert.equal(Buffer.from(responses[3].result.content[1].data, "base64").readUInt32BE(16), 1440);
  assert.match(fs.readFileSync(path.join(dir, "cut.vcd"), "utf8"), /#3\nr-2\.5 s0/);
  assert.match(responses[5].result.content[0].text, /EEXIST/);
  assert.deepEqual(data(7), { selected: null, views: [] });
});

test("standalone MCP and Tcl honor the configured FSDB backend and explicit overrides", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wave-backend-preference-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, ".vscode"));
  fs.writeFileSync(path.join(dir, ".vscode", "settings.json"),
    JSON.stringify({ "waveWorkbench.fsdbBackend": "verdi" }));
  fs.writeFileSync(path.join(dir, "bench.fsdb"), "");
  const calls = [
    ["wave_open", { path: "bench.fsdb" }, "missing-verdi"],
    ["wave_tcl", { script: "wvOpenFile bench.fsdb" }, "missing-verdi"],
    ["wave_open", { path: "bench.fsdb", backend: "independent" }, "missing-independent"],
    ["wave_open", { path: "bench.fsdb", backend: "auto" }, "missing-independent"],
  ];
  const child = spawnSync(process.execPath, [path.resolve(__dirname, "../dist/mcp-headless.js"), dir], {
    input: calls.map(([name, args], id) => JSON.stringify({
      jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args },
    })).join("\n") + "\n",
    encoding: "utf8",
    env: {
      ...process.env,
      WAVE_WORKBENCH_INDEPENDENT_BACKEND: path.join(dir, "missing-independent"),
      WAVE_WORKBENCH_VERDI_BACKEND: path.join(dir, "missing-verdi"),
    },
    timeout: 15000,
  });
  assert.equal(child.status, 0, child.stderr);
  const replies = child.stdout.trim().split("\n").map(JSON.parse);
  assert.equal(replies.length, calls.length);
  for (const { id, result } of replies) {
    assert.equal(result.isError, true);
    assert.ok(result.content[0].text.includes(calls[id][2]), result.content[0].text);
  }
});

test("both MCP hosts publish the same schema and Tcl can run math and live debug", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wave-tools-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "mixed.vcd"), [
    "$timescale 1 ns $end", "$scope module tb $end", "$var real 64 r voltage $end",
    "$upscope $end", "$enddefinitions $end", "#0", "r0.125 r", "#5", "r0.75 r", "#12", "",
  ].join("\n"));
  const harness = path.join(dir, "harness");
  fs.writeFileSync(harness, [
    "#!/usr/bin/env node",
    "let tick = 0;",
    "require('node:readline').createInterface({input: process.stdin}).on('line', (command) => {",
    "  if (command === 'advance') tick++;",
    "  console.log(JSON.stringify({snapshot: {tick: String(tick), scale: '1ns', done: false, values: {'tb.clk': String(tick % 2)}}}));",
    "});",
  ].join("\n"), { mode: 0o700 });

  const run = (entry, calls) => {
    const result = spawnSync(process.execPath, [path.resolve(__dirname, "../dist", entry), dir], {
      input: calls.map(({ method, params }, id) => JSON.stringify({ jsonrpc: "2.0", id, method, params })).join("\n") + "\n",
      encoding: "utf8",
      env: { ...process.env, TMPDIR: dir, DISPLAY: "" },
      timeout: 15000,
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim().split("\n").map((line) => JSON.parse(line).result);
  };
  const list = { method: "tools/list" };
  const call = (name, args = {}) => ({ method: "tools/call", params: { name, arguments: args } });
  const launch = process.platform === "win32" ? [] : [
    call("wave_live_start", { program: harness }),
    call("wave_live_debug", { action: "attach" }),
    call("wave_debug_request", { command: "evaluate", arguments: { expression: "$tick" } }),
    call("wave_live_debug", { action: "detach" }),
    call("wave_live_control", { action: "stepClock", signal: "tb.clk", cycles: 3 }),
    call("wave_live_stop"),
    call("wave_live_history", { start: "0", end: "6", limit: 3 }),
    call("wave_live_history", { start: "3", end: "6", limit: 4 }),
  ];
  const [catalog, ...responses] = run("mcp-headless.js", [
    list,
    call("wave_tcl", { script: 'waveTool wave_open {{"path":"mixed.vcd"}}' }),
    call("wave_tcl", { script: 'set conversion adc; waveTool wave_math {{"operation":"adc","signals":["tb.voltage"],"options":{"bits":4,"name":"adc"}}}' }),
    call("wave_tcl", { script: "if {$conversion ne {adc}} {error {Tcl variables were lost}}; waveView" }),
    call("wave_save_project", { path: "mixed.waveproj" }),
    call("wave_close"),
    call("wave_open", { path: "mixed.waveproj" }),
    call("wave_clip", { start: "0", end: "12" }),
    ...launch,
  ]);
  assert.deepEqual(catalog, run("mcp.js", [list])[0]);
  for (const { name, inputSchema } of catalog.tools) {
    if (["wave_trace_drivers", "wave_trace_loads", "wave_trace_context", "wave_live_trace"].includes(name))
      assert.equal(inputSchema.properties.followContinuations.minimum, 0, name);
    if (name === "wave_trace_resume")
      assert.equal(inputSchema.properties.followContinuations.minimum, 1, name);
  }
  const data = responses.map((response) => {
    assert.equal(response.isError, undefined, response.content[0].text);
    return JSON.parse(response.content[0].text);
  });
  const converted = JSON.parse(data[1].result).signal;
  assert.equal(converted.width, 4);
  assert.equal(JSON.parse(data[2].result).chosen[0].name, "adc");
  assert.deepEqual(data[6].traces[0].events.slice(0, 2), [["0", "0010"], ["5", "1011"]]);
  if (launch.length) {
    assert.equal(data[9].body.result, "0");
    assert.equal(data[12].state, "exited");
    assert.deepEqual(data[13].samples.map(({ tick }) => tick), ["0", "1", "2"]);
    assert.equal(data[13].nextStart, "3");
    assert.deepEqual(data[14].samples.map(({ tick }) => tick), ["3", "4", "5"]);
  }
});
