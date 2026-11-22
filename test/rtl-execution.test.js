// SPDX-License-Identifier: MPL-2.0

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { test } = require("node:test");
const { Backend } = require("../dist/backend");
const { VerilatorDesign } = require("../dist/verilator");
const { annotateRecordedValueChanges, attachRecordedTaskTransfers, correlateExecutionTransitions, readExecutionEvidence, readExecutionEvidenceBatch, reachedWriteEvents, executionMermaid, executionReport, linkExecutionAssignments, matchRecordedModportComponents, reconcileRecordedWordHistory, recordedCursorWrite, recordedOperandHistory, recordedWriters, restoreRecordedSignalHistory, vcsExecutionStatements } = require("../dist/rtl-execution");
const { buildTemporalTrace, temporalTransitionKey } = require("../dist/rtl-trace-candidates");
const { LiveTraceSession, matchLiveExecution } = require("../dist/rtl-live-trace");
const { codeOnly, vcsCaseEntry, vcsGuardEntry, vcsStandaloneWait, vcsWaitEntry, vcsWaitOperands } = require("../dist/rtl-selection");

test("verified array callbacks refine coalesced waveform history only when slot values match", () => {
  const observation = {
    signal: 7, width: 4,
    history: [{ tick: "0", value: "0" }, { tick: "5", value: "1010" }],
  };
  const recording = {
    waveformMatch: "verified", observationCoverage: { status: "complete" },
    events: [
      { kind: "signal-value-changed", tick: "0", value: "0000", ordinal: 7 },
      { kind: "signal-value-changed", tick: "5", value: "0010", ordinal: 9 },
      { kind: "signal-value-changed", tick: "5", value: "1010", ordinal: 13 },
    ],
  };
  const result = reconcileRecordedWordHistory(observation, recording, "0", "6");
  assert.deepEqual(result.history.map(({ value }) => value), ["0000", "0010", "1010"]);
  assert.deepEqual(result.changes.get("5"),
    [{ ordinal: 9, value: "0010" }, { ordinal: 13, value: "1010" }]);
  observation.history.splice(1, 0, { tick: "5", value: "1000" });
  assert.equal(reconcileRecordedWordHistory(observation, recording, "0", "6"), undefined);
  observation.history.splice(1, 1);
  recording.events[2].value = "0101";
  assert.equal(reconcileRecordedWordHistory(observation, recording, "0", "6"), undefined);
});

test("complete callbacks restore a packed bit that returns to its prior value at slot end", () => {
  const signal = {
    signal: 0, status: "observed", width: 1, range: [0, 3], bit: 1, projected: true,
    value: "0", initial: { tick: "2", value: "0" },
    history: [{ tick: "3", value: "0" }],
    cursorSamples: { initial: { tick: "2", value: "0" }, events: [{ tick: "3", value: "0" }], truncated: false },
  };
  const evidence = {
    tick: "3", historyStart: "3", historyEnd: "3", observations: [signal],
    wholeRoot: {
      signal: 0, width: 4, range: [0, 3], projected: false,
      initial: { tick: "2", value: "0001" }, history: [{ tick: "3", value: "1001" }],
    },
  };
  const events = [
    { kind: "signal-value-changed", ordinal: 20, tick: "3", value: "0101" },
    { kind: "signal-value-changed", ordinal: 22, tick: "3", value: "1001" },
  ];
  const recording = { start: "3", waveformMatch: "verified", observationCoverage: { status: "complete" }, events };
  const recordings = new Map([[0, recording]]);
  const restored = restoreRecordedSignalHistory(evidence, recordings);
  assert.deepEqual(restored.observations[0].history, [{ tick: "3", value: "1" }, { tick: "3", value: "0" }]);
  assert.deepEqual(restored.observations[0].cursorSamples.events, restored.observations[0].history);
  assert.deepEqual(evidence.observations[0].history, [{ tick: "3", value: "0" }]);
  recording.observationCoverage.status = "partial";
  assert.equal(restoreRecordedSignalHistory(evidence, recordings), undefined);
  recording.observationCoverage.status = "complete";
  events.push({ kind: "assignment-committed", ordinal: 23, tick: "3", value: "1001" });
  assert.equal(restoreRecordedSignalHistory(evidence, recordings), undefined);
  recording.coverage = { status: "complete" };
  assert.equal(restoreRecordedSignalHistory(evidence, recordings), undefined);
  events.splice(1, 0, {
    kind: "assignment-committed", ordinal: 21, tick: "3",
    writeKind: "nonblocking", timing: "simulator-commit", targetRange: [1, 1], value: "1",
  });
  assert.deepEqual(restoreRecordedSignalHistory(evidence, recordings).observations[0].history,
    restored.observations[0].history);
  events[1].timing = "end-of-slot";
  assert.equal(restoreRecordedSignalHistory(evidence, recordings), undefined);
  events[1].timing = "simulator-commit";
  const noInitial = {
    ...evidence, historyStart: "0",
    observations: [{ ...signal, initial: undefined, history: [
      { tick: "0", value: "0" }, { tick: "3", value: "0" },
    ] }],
    wholeRoot: { ...evidence.wholeRoot, initial: undefined, history: [
      { tick: "0", value: "0001" }, { tick: "3", value: "1001" },
    ] },
  };
  assert.deepEqual(restoreRecordedSignalHistory(noInitial, recordings).observations[0].history,
    [{ tick: "0", value: "0" }, ...restored.observations[0].history]);
});

test("a commit with a verified callback survives a mixed packed-signal slot", () => {
  const instance = "tb.dut";
  const signal = "q";
  const tick = "4";
  const initial = { tick: "3", value: "0101" };
  const observation = {
    signal: 0, range: [3, 0], width: 4, status: "observed",
    initial, history: [{ tick, value: "1011" }],
  };
  const evidence = { tick, historyStart: tick, historyEnd: tick, observations: [observation] };
  const events = [
    { ordinal: 1, kind: "signal-value-changed", value: "0011" },
    { ordinal: 2, kind: "assignment-unobserved", targetRange: [2, 0] },
    { ordinal: 3, kind: "assignment-evaluated", targetRange: [3, 1], value: "101" },
    { ordinal: 4, kind: "signal-value-changed", value: "1011" },
    { ordinal: 5, kind: "assignment-committed", writeKind: "blocking",
      evaluationOrdinal: 3, timing: "simulator-commit", targetRange: [3, 1],
      targetPackedRange: [3, 0], value: "101", valueChangeOrdinal: 4 },
  ].map(event => ({ ...event, tick, instance, signal }));
  const recording = {
    start: tick, waveformMatch: "verified", events,
    observationCoverage: { status: "complete", start: tick, gaps: [] },
    coverage: { status: "partial", declared: { start: tick }, gaps: ["unobservedCommit"] },
  };
  const restored = restoreRecordedSignalHistory(evidence, new Map([[0, recording]]));
  assert.deepEqual(restored.observations[0].history.map(({ value }) => value), ["0011", "1011"]);
  const temporal = { nodes: ["0011", "1011"].map((value, index) =>
    ({ signal: 0, tick, value, orderAtTick: index + 1 })) };
  const links = [3, 5].map(ordinal => ({ ordinal, assignment: 0 }));
  const compare = () => correlateExecutionTransitions(0, restored, temporal, recording, links)[0];
  assert.deepEqual(compare().callbackLinks, [{ node: 0, ordinal: 1 }, { node: 1, ordinal: 4 }]);
  assert.deepEqual(compare().links, [{ node: 1, ordinal: 5, assignment: 0 }]);
  events.at(-1).valueChangeOrdinal = 1;
  assert.equal(compare().links, undefined);
  assert.equal(restoreRecordedSignalHistory(evidence, new Map([[0, recording]])), undefined);
});

test("complete commit replay verifies the callback for each change independently", () => {
  const tick = "3";
  const instance = "tb.dut";
  const signal = "q";
  const events = [
    { ordinal: 0, kind: "assignment-evaluated", value: "01" },
    { ordinal: 1, kind: "assignment-evaluated", value: "10" },
    { ordinal: 2, kind: "signal-value-changed", value: "0001" },
    { ordinal: 3, kind: "signal-value-changed", value: "1001" },
    { ordinal: 4, kind: "assignment-committed", evaluationOrdinal: 0, valueChangeOrdinal: 2,
      targetRange: [1, 0], value: "01" },
    { ordinal: 5, kind: "assignment-committed", evaluationOrdinal: 1, valueChangeOrdinal: 3,
      targetRange: [3, 2], value: "10" },
  ].map((event) => ({
    ...event, tick, instance, signal,
    ...(event.kind === "assignment-committed" && {
      timing: "simulator-commit", writeKind: "blocking", targetPackedRange: [3, 0],
    }),
  }));
  const history = ["0001", "1001"].map(value => ({ tick, value }));
  const evidence = {
    tick, historyStart: tick, historyEnd: tick,
    observations: [{
      signal: 0, range: [3, 0], width: 4, status: "observed",
      initial: { tick: "2", value: "0000" }, history,
    }],
  };
  const temporal = { nodes: history.map(({ value }, index) =>
    ({ signal: 0, tick, value, orderAtTick: index + 1 })) };
  const recording = {
    start: tick, waveformMatch: "verified", events,
    observationCoverage: { status: "complete", start: tick, gaps: [] },
    coverage: { status: "complete", declared: { start: tick } },
  };
  const assignments = [0, 1, 4, 5].map(ordinal => ({ ordinal, assignment: ordinal % 2 }));
  const compare = () => correlateExecutionTransitions(0, evidence, temporal, recording, assignments)[0];
  assert.equal(compare().status, "matched");
  assert.deepEqual(compare().callbackLinks, [{ node: 0, ordinal: 2 }, { node: 1, ordinal: 3 }]);
  assert.deepEqual(compare().links, [{ node: 0, ordinal: 4, assignment: 0 }, { node: 1, ordinal: 5, assignment: 1 }]);
  events[5].valueChangeOrdinal = 4;
  assert.deepEqual(compare().unverifiedCommitCallbacks, [5]);
  assert.deepEqual(compare().links, [{ node: 0, ordinal: 4, assignment: 0 }]);
  const coalesced = {
    ...evidence, observations: [{ ...evidence.observations[0], history: history.slice(1) }],
  };
  const recordings = new Map([[0, recording]]);
  assert.equal(restoreRecordedSignalHistory(coalesced, recordings), undefined);
  events[5].valueChangeOrdinal = 3;
  assert.deepEqual(restoreRecordedSignalHistory(coalesced, recordings).observations[0].history, history);
});

test("overlapping modport callbacks narrow components only with complete compatible evidence", () => {
  const source = path.resolve("design.sv");
  const location = {
    uri: pathToFileURL(source).href,
    range: { start: { line: 20, character: 14 } },
  };
  const rhs = { op: "cast", args: [7, false, false, { op: "signal", args: 1 }] };
  const trace = {
    root: 0,
    assignments: [
      [[3, 1], 0, 6, 4],
      [[2, 0], 2, 2, 0],
    ].map(([targetRange, component, first, last]) => ({
      targets: [0], kind: "blocking", instance: "tb.writer", location,
      targetRange, overlappingModportWrite: true, value: { op: "slice", args: [rhs, first, last] },
      inputs: [{ signal: 1, kind: "data" }],
      hierarchicalTargets: [{ interfaceComponent: [component, 3] }],
    })),
  };
  const evidence = {
    observations: [{ signal: 0, width: 1, projected: true, range: [3, 0] },
      { signal: 1, width: 7, range: [6, 0], signed: false }],
    wholeRoot: { signal: 0, width: 4, range: [3, 0] },
  };
  const temporal = { nodes: [
    { signal: 0, bit: 2, tick: "3", orderAtTick: 1 },
    { signal: 0, bit: 2, tick: "3", orderAtTick: 2 },
  ] };
  const links = [{ node: 0, ordinal: 20 }, { node: 1, ordinal: 22 }];
  const compare = [{ status: "valueChangesMatch", callbackLinks: links }];
  const recording = (samples) => ({
    waveformMatch: "verified",
    observationCoverage: { status: "complete" },
    events: samples.map(([tick, ordinal, value]) => ({ tick, ordinal, value, kind: "signal-value-changed" })),
  });
  const target = recording([["2", 16, "0001"], ["3", 20, "0101"], ["3", 22, "1001"]]);
  const input = recording([["2", 12, "0001111"], ["3", 18, "1000101"]]);
  const recordings = new Map([[0, target], [1, input]]);
  const match = (comparisons = compare, dirty = []) =>
    matchRecordedModportComponents(trace, evidence, temporal, comparisons, recordings, new Set(dirty));
  assert.deepEqual([...match().values()], [
    { assignment: 1, ordinal: 20, range: [2, 0] },
    { assignment: 0, ordinal: 22, range: [3, 1] },
  ]);
  assert.equal(match([{ status: "valueChangesDiffer", callbackLinks: links }]).size, 0);
  assert.equal(match(compare, [source]).size, 0);
  input.events.push({ tick: "3", ordinal: 19, value: "0100101", kind: "signal-value-changed" });
  assert.deepEqual([...match().values()], [{ assignment: 0, ordinal: 22, range: [3, 1] }]);
  input.observationCoverage.status = "partial";
  assert.equal(match().size, 0);

  const evaluated = (ordinal, targetRange, value) => ({
    kind: "assignment-evaluated", tick: "3", ordinal, targetRange, value,
    writeKind: "blocking",
    source: { file: source, line: 21, column: 15, identity: "matched" },
  });
  const measured = {
    ...target,
    coverage: { declared: { start: "2" }, checkedThrough: "3", gaps: ["unobservedCommit"] },
    events: [
      target.events[0], evaluated(18, [3, 1], "100"), evaluated(19, [2, 0], "101"),
      ...target.events.slice(1),
    ],
  };
  const captured = new Map([[0, measured]]);
  const matchCaptured = () => matchRecordedModportComponents(
    trace, evidence, temporal, compare, captured, new Set(),
  );
  assert.deepEqual([...matchCaptured().values()], [
    { assignment: 1, ordinal: 20, range: [2, 0], evaluationOrdinal: 19 },
    { assignment: 0, ordinal: 22, range: [3, 1], evaluationOrdinal: 18 },
  ]);
  const callback = (ordinal, value) => ({
    ordinal, value, tick: "3", kind: "signal-value-changed",
  });
  const repeated = {
    ...measured,
    events: [
      target.events[0],
      evaluated(37, [3, 1], "100"), evaluated(38, [2, 0], "101"),
      callback(43, "0101"), callback(45, "1001"),
      evaluated(48, [3, 1], "010"), evaluated(49, [2, 0], "011"),
      callback(54, "1011"), callback(55, "0101"),
      evaluated(58, [3, 1], "100"), evaluated(59, [2, 0], "101"),
      callback(64, "1001"),
    ],
  };
  // A projected query can show just the last change. The other callbacks in
  // the recording still disambiguate repeated identical RHS values.
  const lastChange = { nodes: [{ ...temporal.nodes[1], orderAtTick: 4 }] };
  const atLastCallback = [{ status: "valueChangesMatch", callbackLinks: [{ node: 0, ordinal: 64 }] }];
  const matchRepeated = () => matchRecordedModportComponents(
    trace, evidence, lastChange, atLastCallback, new Map([[0, repeated]]), new Set(),
  );
  assert.deepEqual([...matchRepeated().values()], [
    { assignment: 0, ordinal: 64, range: [3, 1], evaluationOrdinal: 58 },
  ]);
  // A missing observation leaves both repeated evaluations compatible.
  repeated.events = repeated.events.filter(({ ordinal }) => ordinal !== 45 && ordinal !== 54);
  assert.deepEqual([...matchRepeated().values()], [
    { assignment: 0, ordinal: 64, range: [3, 1] },
  ]);

  measured.events.splice(1, 0, evaluated(17, [2, 0], "101"));
  assert.equal(matchCaptured().get("0:2@3:1").evaluationOrdinal, undefined);
  measured.coverage.gaps.push("undeclaredWriter");
  assert.equal(matchCaptured().size, 0);

  const process = { ...location, range: { start: { line: 20, character: 2 } } };
  const owners = ["tb.writer", "tb.writer2"];
  const sha256 = "a".repeat(64);
  const multiTrace = {
    ...trace,
    assignments: owners.flatMap((instance) =>
      trace.assignments.map((assignment) => ({ ...assignment, process, instance })),
    ),
  };
  const multiEvaluation = (ordinal, owner, range, value) => {
    const processId = createHash("sha256")
      .update(JSON.stringify([owners[owner], sha256, 21, 3])).digest("hex");
    const event = evaluated(ordinal, range, value);
    return { ...event, processId, source: { ...event.source, sha256 } };
  };
  const multiRecording = {
    ...repeated,
    start: "0",
    coverage: { declared: { start: "0" }, checkedThrough: "3", gaps: ["unobservedCommit"] },
    events: [
      multiEvaluation(7, 0, [3, 1], "100"), multiEvaluation(8, 0, [2, 0], "101"),
      callback(10, "x101"), callback(12, "1001"),
      multiEvaluation(17, 1, [3, 1], "010"), multiEvaluation(18, 1, [2, 0], "011"),
      callback(20, "1011"), callback(21, "0101"),
    ],
  };
  const multiEvidence = {
    ...evidence,
    historyStart: "0",
    wholeRoot: { ...evidence.wholeRoot, history: [{ tick: "0", value: "xxxx" }] },
  };
  const changes = [10, 12, 20, 21];
  const wholeBus = { nodes: changes.map((_, index) => ({ signal: 0, tick: "3", orderAtTick: index + 1 })) };
  const matchOwners = () => matchRecordedModportComponents(
    multiTrace, multiEvidence, wholeBus, [{
      status: "valueChangesMatch", callbackLinks: changes.map((ordinal, node) => ({ ordinal, node })),
    }], new Map([[0, multiRecording]]), new Set(),
  );
  assert.deepEqual([...matchOwners().values()].map(({ assignment, evaluationOrdinal }) =>
    [multiTrace.assignments[assignment].instance, evaluationOrdinal]), [
      ["tb.writer", 8], ["tb.writer", 7], ["tb.writer2", 18], ["tb.writer2", 17],
    ]);
  multiRecording.events[4].processId = "unknown";
  assert.equal(matchOwners().size, 0);
});

test("VCS modport probes retain each RHS component and its unobserved outcome", {
  skip: !process.env.WAVE_TEST_VCS_MODPORT_EVALUATION,
}, async () => {
  const directory = process.env.WAVE_TEST_VCS_MODPORT_EVALUATION;
  const replay = await readExecutionEvidence(
    path.join(directory, "execution-vcd.jsonl"), path.join(directory, "capture/nested.vcd"),
    "1ns", "nested_tb.overlap", "data", "3", "3",
  );
  const evaluated = replay.events.filter(({ kind }) => kind === "assignment-evaluated");
  assert.deepEqual(evaluated.map(({ targetRange, value, source }) => [targetRange, value, source.identity]), [
    [[3, 1], "100", "matched"], [[2, 0], "101", "matched"],
  ]);
  assert.deepEqual(replay.events.filter(({ kind }) => kind === "assignment-unobserved")
    .map(({ evaluationOrdinal }) => evaluationOrdinal), evaluated.map(({ ordinal }) => ordinal));
  assert.deepEqual(replay.events.filter(({ kind }) => kind === "signal-value-changed")
    .map(({ value }) => value), ["0101", "1001"]);
  assert.equal(replay.coverage.pendingEvaluations, 0);
  assert(!replay.events.some(({ kind }) => kind === "assignment-committed"));
});

test("VCS modport probes confirm unique physical changes and preserve ambiguous outcomes", {
  skip: !process.env.WAVE_TEST_VCS_MODPORT_COMMITS,
}, async () => {
  const directory = process.env.WAVE_TEST_VCS_MODPORT_COMMITS;
  for (const extension of ["vcd", "fsdb"]) {
    const replay = await readExecutionEvidence(
      path.join(directory, "execution-" + extension + ".jsonl"),
      path.join(directory, "nested." + extension),
      "1ns", "nested_tb.overlap", "data", "0", "3",
    );
    assert.equal(replay.waveformMatch, "verified");
    const commits = replay.events.filter(({ kind }) => kind === "assignment-committed");
    assert.deepEqual(commits.map(({ ordinal, evaluationOrdinal, targetRange, value }) =>
      [ordinal, evaluationOrdinal, targetRange, value]), [
        [13, 8, [2, 0], "101"], [15, 7, [3, 1], "100"],
        [22, 18, [2, 0], "011"], [23, 17, [3, 1], "010"],
      ]);
    assert(commits.every(({ timing }) => timing === "simulator-commit"));
    assert.equal(replay.coverage.pendingEvaluations, 0);
  }
  const ambiguous = process.env.WAVE_TEST_VCS_MODPORT_AMBIGUOUS;
  if (!ambiguous) return;
  const replay = await readExecutionEvidence(
    path.join(ambiguous, "execution-vcd.jsonl"), path.join(ambiguous, "nested.vcd"),
    "1ns", "nested_tb.overlap", "data", "4", "4",
  );
  assert.equal(replay.waveformMatch, "verified");
  assert.deepEqual(replay.events.map(({ kind, value }) => [kind, value]), [
    ["assignment-evaluated", "001"], ["assignment-evaluated", "011"],
    ["signal-value-changed", "0011"],
    ["assignment-unobserved", undefined], ["assignment-unobserved", undefined],
  ]);
});

test("VCS modport replay records uniquely matched callbacks after the assignment returns", {
  skip: !process.env.WAVE_TEST_VCS_MODPORT_DEFERRED,
}, async () => {
  const directory = process.env.WAVE_TEST_VCS_MODPORT_DEFERRED;
  const replay = await readExecutionEvidence(
    path.join(directory, "execution-vcd.jsonl"), path.join(directory, "nested.vcd"),
    "1ns", "nested_tb.overlap", "data", "1", "2",
  );
  assert.equal(replay.waveformMatch, "verified");
  const commits = replay.events.filter(({ kind }) => kind === "assignment-committed");
  assert.deepEqual(commits.map(({ tick, evaluationOrdinal, valueChangeOrdinal }) =>
    [tick, evaluationOrdinal, valueChangeOrdinal]), [["1", 17, 20], ["2", 27, 29], ["2", 26, 31]]);
  assert(replay.events.some(({ tick, kind }) => tick === "1" && kind === "assignment-unobserved"));
  assert.equal(replay.coverage.pendingEvaluations, 0);
});

test("VCS PLI replay links synchronous writes to ordered foreign steps", {
  skip: !process.env.WAVE_TEST_VCS_PLI,
}, async (t) => {
  const directory = process.env.WAVE_TEST_VCS_PLI;
  const waveform = path.join(directory, "trace.vcd");
  const log = path.join(directory, "sealed.jsonl");
  const replay = await readExecutionEvidence(log, waveform, "1ps", "tb", "target", "5000", "5000");
  const evaluation = replay.events.find(({ kind }) => kind === "assignment-evaluated");
  const commit = replay.events.find(({ kind }) => kind === "assignment-committed");
  assert.equal(replay.waveformMatch, "verified");
  assert.equal(evaluation.writeKind, "subroutineCall");
  assert.equal(commit.evaluationOrdinal, evaluation.ordinal);
  assert.equal(commit.value, "1");
  assert.deepEqual(evaluation.resolvedExternalSteps.map(({ operation, value, source }) =>
    [operation, value, source.identity]), [["tf_getp(2)", "1", "matched"], ["tf_putp(1)", "1", "matched"]]);
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "wave-pli-replay-"));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const lines = (await fs.readFile(log, "utf8")).trimEnd().split("\n").map(JSON.parse);
  lines.find(({ kind }) => kind === "assignment-committed").tick = "5001";
  const shifted = path.join(temporary, "shifted.jsonl");
  await fs.writeFile(shifted, lines.map(line => JSON.stringify(line)).join("\n") + "\n");
  await assert.rejects(readExecutionEvidence(shifted, waveform, "1ps", "tb", "target", "5000", "5001"),
    /Execution outcome does not match its evaluation/);
});

test("task replay pairs overlapping activations and same-tick field writes by captured identity", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wave-task-replay-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, "task.sv");
  const wave = path.join(dir, "wave.fsdb");
  const log = path.join(dir, "execution.jsonl");
  const digest = (text) => createHash("sha256").update(text).digest("hex");
  await fs.writeFile(source, "task send;\n  bus.data = data;\nendtask\nsend(word);\n$fgetc(fd);\n");
  await fs.writeFile(wave, "fixture waveform identity");
  const config = {
    instance: "tb", signal: "bus.data", input: digest("input"), inputIndex: digest("inputIndex"),
    write: digest("write"), writeIndex: digest("writeIndex"), fileReads: ["byte"],
  };
  const mapped = (line, column) => ({ file: source, line, column });
  const mappings = {
    [config.input]: mapped(4, 6), [config.inputIndex]: mapped(4, 1),
    [config.write]: mapped(2, 3), [config.writeIndex]: mapped(2, 3), byte: mapped(5, 1),
    [digest("read")]: mapped(5, 1),
  };
  const sha256 = digest(await fs.readFile(source));
  for (const location of Object.values(mappings)) location.sha256 = sha256;
  const events = [];
  const add = (event) => events.push({ instance: "tb", ordinal: events.length, ...event });
  const capture = (statementId, value, tick, callback, externalSteps) => {
    const evaluationOrdinal = events.length;
    const data = { statementId, signal: "probe", tick, value, writeKind: "blocking", processId: digest("process") };
    add({ ...data, kind: "assignment-evaluated", externalSteps });
    if (callback) add({ kind: "signal-value-changed", tick, value, instance: "tb.bus", signal: "data" });
    add({ ...data, kind: "assignment-committed", evaluationOrdinal });
  };
  capture(digest("read"), "00001010", "1", false,
    [{ statementId: "byte", operation: "$fgetc at byte 0", value: "00001010" }]);
  capture(digest("read"), "00001011", "1", false,
    [{ statementId: "byte", operation: "$fgetc at byte 1", value: "00001011" }]);
  capture(config.input, "00001010", "2");
  capture(config.inputIndex, "01", "2");
  capture(config.input, "00001011", "2");
  capture(config.inputIndex, "10", "2");
  capture(config.write, "00001011", "3", true);
  capture(config.writeIndex, "10", "3");
  capture(config.write, "00001010", "3", true);
  capture(config.writeIndex, "01", "3");
  await fs.writeFile(log, [{
    format: "wave-workbench-execution", schemaVersion: 1, scale: "1ps",
    buildId: digest("build"), waveformSha256: digest(await fs.readFile(wave)),
    statements: mappings, taskTransferProbes: config,
    observationCoverage: { start: "0", signals: [{ instance: "tb.bus", signal: "data" }] },
  }, ...events, { type: "end", tick: "4", eventCount: events.length }]
    .map((event) => JSON.stringify(event)).join("\n") + "\n");
  const location = (line, character) => ({
    uri: pathToFileURL(source).href, range: { start: { line, character } },
  });
  const trace = { assignments: [
    { kind: "blocking", instance: "tb", location: location(1, 2),
      targetField: { signal: 1, field: "data" }, fieldValue: { op: "signal", args: 2 } },
    { kind: "taskInput", instance: "tb", location: location(3, 5), targets: [2] },
  ] };
  const graph = {
    recordedFieldSignals: [{ id: 5, instance: "tb", field: "data", name: "bus.data", signal: 1 }],
    nodes: [
      { signal: 5, tick: "3", value: "1011", orderAtTick: 1 },
      { signal: 5, tick: "3", value: "1010", orderAtTick: 2 },
      { signal: 5, tick: "3", value: "1010" },
    ],
  };
  await attachRecordedTaskTransfers(log, wave, "1ps", "4", trace, graph, new Set());
  assert.deepEqual(graph.nodes.map((node) => node.recordedTaskTransfer?.index), [2, 1, undefined]);
  assert.deepEqual(graph.nodes.map((node) => node.recordedTaskTransfer?.reads[0].operation),
    ["$fgetc at byte 1", "$fgetc at byte 0", undefined]);
  for (const node of graph.nodes) delete node.recordedTaskTransfer;
  await attachRecordedTaskTransfers(log, wave, "1ps", "4", trace, graph, new Set([source]));
  assert(graph.nodes.every((node) => node.recordedTaskTransfer === undefined));
});

test("VCS execution maps and the generator agree on opt-in operand capture", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wave-auto-operands-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "top.sv");
  const uri = pathToFileURL(file).href;
  await fs.writeFile(file, [
    "module top(input logic [1:0] a, input logic b, enable, clk, output logic q);",
    "  always @(posedge clk) begin",
    "    if (a && enable) q <= (~a /* comment */ &",
    "          b);",
    "    q <= a & 1'b1;",
    "    q <= b ^ b;",
    "    q = a[0];",
    "    q <= a << b;",
    "    q <= enable ? a : b;",
    "  end",
    "endmodule",
    "",
  ].join("\n"));
  const location = (line, character) => ({ uri, range: { start: { line, character } } });
  const nonblocking = (line, ids) => ({
    instance: "top", kind: "nonblocking", location: location(line, 4),
    process: location(1, 2), targets: [0],
    inputs: ids.map(signal => ({ signal, kind: "data" })),
    value: { op: "signal", args: ids[0] },
  });
  const trace = {
    root: 0,
    signals: ["q", "a", "b", "enable"].map((name, id) => ({ id, name, instance: "top" })),
    assignments: [nonblocking(2, [1, 2]), nonblocking(4, [1]), nonblocking(5, [2, 2]),
      { ...nonblocking(6, [1]), kind: "blocking" },
      nonblocking(7, [1, 2]), nonblocking(8, [3, 1, 2])],
  };
  trace.assignments[0].location = location(2, 21);
  trace.assignments[0].guards = [{ expression: { op: "signal", args: 3 } }];
  trace.assignments[0].inputs.push({ signal: 1, kind: "control" }, { signal: 3, kind: "control" });
  const plain = await vcsExecutionStatements(trace, "top", "q", new Set());
  const captured = await vcsExecutionStatements(trace, "top", "q", new Set(), true);
  assert.deepEqual(captured.map(({ sampleOperands }) => sampleOperands), [
    ["a", "b"], undefined, undefined, ["a"], ["a", "b"], ["enable", "a", "b"],
  ]);
  assert.deepEqual(captured.map(({ sampleOperands, ...site }) => site), plain);
  const guarded = await vcsExecutionStatements(trace, "top", "q", new Set(), true, true);
  assert.deepEqual(guarded.map(({ sampleGuards }) => sampleGuards), [
    ["a", "enable"], undefined, undefined, undefined, undefined, undefined,
  ]);
  const runGenerator = async (statements, output) => {
    const map = path.join(dir, "maps.json");
    await fs.writeFile(map, JSON.stringify([{ schemaVersion: 1, instance: "top", signal: "q", statements }]));
    return execFileSync(process.execPath, [
      path.resolve(__dirname, "../scripts/verilator-execution.mjs"),
      "generate-vcs-nba", map, path.join(dir, output),
    ], { stdio: "pipe" });
  };
  await runGenerator(guarded, "generated");
  const generated = await fs.readFile(path.join(dir, "generated", "top.sv"), "utf8");
  assert.match(generated, /a=%b,b=%b,enable=%b/);
  assert.match(generated, /_operand_0\[0\]; wave_workbench_probe::wave_workbench_blocking_evaluate_sampled/);
  assert.match(generated, /_operand_0 << [\w$]+_operand_1/);
  assert.match(generated, /_operand_0 \? [\w$]+_operand_1 : [\w$]+_operand_2/);
  assert.equal(generated.split("\n").length, 12);
  const bad = captured.map((site, index) => index === 1 ? { ...site, sampleOperands: ["a"] } : site);
  await assert.rejects(runGenerator(bad, "invalid"), (error) =>
    /Operand capture requires a supported expression/.test(error.stderr.toString()));
});

test("VCS maps and generates one guarded source edit for multiple selected array words", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wave-array-probes-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "top.sv");
  const uri = pathToFileURL(file).href;
  await fs.writeFile(file, [
    "module top(input logic clk, enable, input int idx, input logic [7:0] data); timeunit 1ps; timeprecision 1ps;",
    "  logic [7:0] mem [-2:2];",
    "  always @(posedge clk) begin",
    "    if (enable && take_lane()) begin : selected mem[idx][7:4] <= data[7:4]; end",
    "    mem[-1][3:0] <=",
    "      data[3:0];",
    "  end",
    "endmodule",
    "",
  ].join("\n"));
  const location = (line, character, end) => ({
    uri, range: { start: { line, character }, ...(end ? { end: { line, character: end } } : {}) },
  });
  const maps = await Promise.all([-1, 2].map(async (selectedElement) => {
    const assignments = [
      { targetElementIndex: { op: "signal", args: 1 }, targetRange: [7, 4],
        guards: [{ takenWhenTrue: true, location: location(3, 8, 29), expression: null }],
        inputs: [{ signal: 2, kind: "control", location: location(3, 8) }] },
      { targetElementIndex: { op: "literal", args: ["1111", true] }, targetRange: [3, 0] },
    ].map((assignment, index) => ({
      inputs: [], ...assignment, instance: "top", kind: "nonblocking", targets: [0],
      location: location(3 + index, index === 0 ? 48 : 4), process: location(2, 2),
    }));
    const trace = {
      root: 0,
      signals: [{ id: 0, name: "mem", selectedElement }, { id: 1, name: "idx" },
        { id: 2, name: "enable", instance: "top" }],
      assignments,
    };
    const signal = "mem[" + selectedElement + "]";
    const statements = await vcsExecutionStatements(trace, "top", signal, new Set(), true, true, true);
    return { schemaVersion: 1, instance: "top", signal, statements };
  }));
  assert.deepEqual(maps.map(({ statements }) => statements.map(({ arrayElement }) => arrayElement.selector)),
    [["idx", "-1"], ["idx"]]);
  assert.deepEqual(maps.map(({ statements }) => statements.map(({ sampleGuards }) => sampleGuards)),
    [[["enable"], undefined], [["enable"]]]);
  const input = path.join(dir, "maps.json");
  const output = path.join(dir, "generated");
  await fs.writeFile(input, JSON.stringify(maps));
  execFileSync(process.execPath, [
    path.resolve(__dirname, "../scripts/verilator-execution.mjs"),
    "generate-vcs-nba", input, output,
  ], { stdio: "pipe" });
  const generated = await fs.readFile(path.join(output, "top.sv"), "utf8");
  const original = await fs.readFile(file, "utf8");
  assert.equal(generated.split("\n").length, original.split("\n").length);
  assert.match(generated, /timeunit 1ps; timeprecision 1ps; bit \[63:0\]/);
  assert.match(generated, /case .*"-1": begin .*"2": begin .*default: mem\[/);
  assert.equal(generated.match(/automatic type\(enable\) wave_guard_/g).length, 1);
  assert.equal(generated.match(/take_lane\(\)/g).length, 1);
  assert.match(generated, /wave_workbench_nba_evaluate_guarded.*\$sformatf\("enable=%b", enable\).*g4_9_enable=%b/);
  const probes = JSON.parse(await fs.readFile(path.join(output, "execution-probes.json"), "utf8"));
  assert.deepEqual(probes.sites.map(({ signal }) => signal), ["mem[-1]", "mem[-1]", "mem[2]"]);
  assert.equal(new Set(probes.sites.map(({ nbaTag }) => nbaTag)).size, 3);
});

test("VCS guard entry mapping preserves bare branches and dangling else ownership", () => {
  const locate = (source, takenWhenTrue = true) => {
    const first = source.indexOf("enable");
    return vcsGuardEntry(codeOnly(source), first, first + "enable".length,
      source.indexOf("mem"), takenWhenTrue);
  };
  const bareTrue = "if (enable) mem[idx] <= data; else q <= data;";
  assert.deepEqual(locate(bareTrue), { at: bareTrue.indexOf("mem"), bare: true });
  const bareFalse = "if (enable) q[3:0] <= data; else mem[idx] <= data;";
  assert.deepEqual(locate(bareFalse, false), { at: bareFalse.indexOf("mem"), bare: true });
  const namedFalse = "if (enable) begin : reset begin q <= data; end end : reset else begin : update mem[idx] <= data; end";
  assert.deepEqual(locate(namedFalse, false), {
    at: namedFalse.indexOf(": update") + ": update".length, bare: false,
  });
  assert.equal(locate("if (enable) if (ready) q <= data; else mem[idx] <= data;", false), undefined);
});

test("VCS case entry capture keeps a simple procedural delay", () => {
  const locate = (source, body) => {
    const first = source.indexOf("selector");
    return vcsCaseEntry(codeOnly(source), first, first + "selector".length,
      source.indexOf(body), source.indexOf("endcase"), source.indexOf("q <="));
  };
  const direct = "case (selector) default: q <= b; endcase";
  assert.deepEqual(locate(direct, "q <="), { at: direct.indexOf("q <="), bare: true });
  const named = "casez (selector) 4'b10?1: begin : take selector = 0; q <= a; end endcase";
  assert.deepEqual(locate(named, "begin"), { at: named.indexOf("take") + 4, bare: false });
  const delay = "case (selector) default: begin #1; q <= b; end endcase";
  assert.deepEqual(locate(delay, "begin"), { at: delay.indexOf("begin") + 5, bare: false });
  assert.equal(locate("case (selector) default: begin #DELAY q <= b; end endcase", "begin"), undefined);
  assert.equal(locate("case (selector) default: begin int selector; q <= b; end endcase", "begin"), undefined);
  assert.equal(locate("case (selector) default: begin wait (ready); q <= b; end endcase", "begin"), undefined);
});

test("VCS wait capture binds the NBA that the wait directly controls", () => {
  const locate = (source) => {
    const first = source.indexOf("ready");
    return vcsWaitEntry(codeOnly(source), first, first + 5, source.indexOf("q <="));
  };
  const direct = "wait (ready) q <= d;";
  assert.deepEqual(locate(direct), { at: direct.indexOf("q <="), bare: true });
  assert.equal(locate("wait (ready); q <= d;"), undefined);
  assert.equal(locate("wait (ready) #2 q <= d;"), undefined);
  assert.equal(locate("wait (ready && valid) q <= d;"), undefined);
  const standalone = source => {
    const first = source.indexOf("ready");
    return vcsStandaloneWait(codeOnly(source), first, first + 5, source.indexOf("q <="));
  };
  assert.deepEqual(standalone("wait (ready); #3; q <= d;"), { start: 0, semicolon: 12 });
  assert.equal(standalone("wait (ready); if (en) q <= d;"), undefined);
  assert.equal(standalone("wait (ready); q2 <= d; q <= d;"), undefined);
});

test("VCS wait operands preserve logical grouping and reject function calls and mutations", () => {
  assert.deepEqual(vcsWaitOperands("ready && (!inhibit || ready)"), {
    names: ["ready", "inhibit"], compound: true,
  });
  assert.deepEqual(vcsWaitOperands("ready"), { names: ["ready"], compound: false });
  assert.deepEqual(vcsWaitOperands("(status & 4'b1011) === 4'b10x1 /* mask */ && signed_status < 4'sd0"), {
    names: ["status", "signed_status"], compound: true,
  });
  for (const expression of ["ready &&", "!()", "(ready", "ready || sample()", "++ready", "top.ready",
    "status = 4'b1010", "status == 2.0", "ready && 4'b1010garbage", "ready === \"go\"", "ready ==? 1'bx"])
    assert.equal(vcsWaitOperands(expression), undefined, expression);
});

test("VPI replay retains ordered value changes without fabricating assignment evidence", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wave-vpi-replay-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const raw = path.join(directory, "raw.jsonl");
  const sealed = path.join(directory, "sealed.jsonl");
  const waveform = path.join(directory, "trace.vcd");
  await fs.writeFile(waveform, "$timescale 10ps $end\n");
  const values = ["1", "0"];
  const events = values.map((value, ordinal) => ({
    value, ordinal: ordinal + 1, tick: "3", kind: "signal-value-changed", instance: "top.dut", signal: "q",
  }));
  const input = { ...events[0], ordinal: 0, signal: "d" };
  await fs.writeFile(raw, [
    { type: "vpi-capture", timePrecision: -11, observationCoverage: {
      start: "0", signals: ["q", "d", "stable"].map(signal => ({ instance: "top.dut", signal })),
    } },
    input,
    ...events,
    { type: "end", tick: "4", eventCount: 3 },
  ].map(event => JSON.stringify(event)).join("\n") + "\n");
  execFileSync(process.execPath, [
    path.resolve(__dirname, "../scripts/verilator-execution.mjs"),
    "seal-vpi", waveform, raw, sealed,
  ]);
  const [replay, upstream, stable, unselected] = await readExecutionEvidenceBatch(
    sealed, waveform, "10ps",
    ["q", "d", "stable", "unselected"].map(signal => ({ instance: "top.dut", signal })),
    "3", "3",
  );
  assert.equal(replay.waveformMatch, "verified");
  assert.equal(replay.coverage.checkedThrough, "4");
  assert.deepEqual(replay.coverage.gaps, ["coverageUndeclared"]);
  assert.equal(replay.cursor, undefined);
  assert.deepEqual(replay.events, events.map(event => ({ ...event, source: undefined })));
  assert.deepEqual(upstream.events, [{ ...input, source: undefined }]);
  assert.deepEqual(stable.observationCoverage, { status: "complete", start: "0", checkedThrough: "4", gaps: [] });
  assert.deepEqual(stable.events, []);
  assert.equal(unselected.observationCoverage, undefined);
  assert.match(executionReport(stable), /No value-change callbacks in the requested window/);
  const short = path.join(directory, "truncated.jsonl");
  const recorded = await fs.readFile(sealed, "utf8");
  await fs.writeFile(short, recorded.split("\n").slice(0, -2).join("\n") + "\n");
  const incomplete = await readExecutionEvidence(short, waveform, "10ps", "top.dut", "stable", "3", "3");
  assert.deepEqual(incomplete.observationCoverage.gaps, ["recordingEndsBeforeCursor"]);
  assert.equal(incomplete.observationCoverage.status, "partial");
  assert.deepEqual(linkExecutionAssignments({ root: 0, assignments: [] }, replay), []);
  assert.match(executionReport(replay), /signal-value-changed · top\.dut\.q · 1/);
  assert.match(executionMermaid(replay), /e1.*next value change.*e2/);
  assert.match(executionMermaid({ events: [input, ...replay.events] }), /e0.*next recorded callback.*e1/);
  const observations = [{
    signal: 0, width: 1, initial: { tick: "0", value: "0" },
    history: values.map(value => ({ tick: "3", value })),
  }];
  observations.push({ ...observations[0], signal: 1, history: [{ tick: "3", value: "1" }] });
  const graph = {
    nodes: [
      { signal: 0, tick: "3", value: "1", orderAtTick: 1 },
      { signal: 0, tick: "3", value: "0", orderAtTick: 2 },
      { signal: 1, tick: "3", value: "1" },
    ],
    edges: [
      { source: 2, target: 0, timing: "sameTickUnordered", confidence: "possible" },
      { source: 0, target: 2, timing: "sameTickUnordered", confidence: "possible" },
    ],
  };
  const compare = (id, recording) => correlateExecutionTransitions(
    id, { tick: "3", observations }, graph, recording, [],
  );
  observations.push({ ...observations[0], signal: 2, history: [] });
  assert.equal(compare(2, stable)[0].status, "valueChangesMatch");
  assert.equal(compare(2, incomplete)[0].status, "incomplete");
  assert.deepEqual(compare(2, unselected), []);
  const [result] = compare(0, replay);
  assert.equal(result.status, "valueChangesMatch");
  assert.deepEqual(result.callbackOrdinals, [1, 2]);
  assert.equal(result.links, undefined);
  annotateRecordedValueChanges(graph, [result, ...compare(1, upstream)]);
  assert.deepEqual(graph.nodes.map(node => node.valueChangeOrdinal), [1, 2, 0]);
  assert.deepEqual(graph.edges.map(edge => edge.callbackOrder), ["sourceBeforeTarget", "sourceAfterTarget"]);
  assert(graph.edges.every(edge => edge.confidence === "possible"));
  observations[0].history = [];
  const [different] = compare(0, replay);
  assert.equal(different.status, "valueChangesDiffer");
  assert.deepEqual(different.recordedChangeValues, values);
  assert.equal(different.callbackLinks, undefined);
});

test("VCS DPI replay verifies its probe map and pairs exact blocking writes", {
  skip: !process.env.WAVE_TEST_VCS_DPI,
}, async (t) => {
  const build = process.env.WAVE_TEST_VCS_DPI;
  const waveform = path.join(build, "reference.vcd");
  const probes = path.join(build, "generated/execution-probes.json");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wave-vcs-probe-map-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const changedMap = path.join(directory, "changed.json");
  await fs.writeFile(changedMap, (await fs.readFile(probes, "utf8")) + "\n");
  const seal = (map, output) => execFileSync(process.execPath, [
    path.resolve(__dirname, "../scripts/verilator-execution.mjs"), "seal-vpi",
    waveform, path.join(build, "raw.jsonl"), path.join(directory, output),
    map, path.join(build, "coverage.json"),
  ], { stdio: "pipe" });
  assert.throws(() => seal(changedMap, "bad.jsonl"), /probe map SHA-256 differ/);
  seal(probes, "sealed.jsonl");
  const direct = await readExecutionEvidence(
    path.join(directory, "sealed.jsonl"), waveform, "1ns", "clock_tb", "d", "1", "5",
  );
  const nba = await readExecutionEvidence(
    path.join(directory, "sealed.jsonl"), waveform, "1ns", "clock_tb", "q", "1", "5",
  );
  assert.equal(direct.coverage.status, "complete");
  const [evaluation, change, commit] = direct.events.filter(({ tick }) => tick === "4");
  assert.deepEqual([evaluation.kind, change.kind, commit.kind], [
    "assignment-evaluated", "signal-value-changed", "assignment-committed",
  ]);
  assert.deepEqual([evaluation.value, change.value, commit.value], ["1010", "1010", "1010"]);
  assert.equal(commit.evaluationOrdinal, evaluation.ordinal);
  assert.equal(commit.source.line, 14);
  assert.equal(commit.source.identity, "matched");
  assert(nba.events.some(({ kind, tick, value }) =>
    kind === "assignment-evaluated" && tick === "5" && value === "1010"));
  assert(!nba.events.some(({ kind }) => kind === "assignment-committed"));
});

test("VCS tags pair observed NBA commits and keep coalesced outcomes unresolved", {
  skip: !process.env.WAVE_TEST_VCS_NBA,
}, async () => {
  const stage = process.env.WAVE_TEST_VCS_NBA;
  const trace = (build, instance, end) => readExecutionEvidence(
    path.join(stage, build, "sealed.jsonl"), path.join(stage, build, "reference.vcd"),
    "1ns", instance, "q", "1", end,
  );
  const clock = await trace("integrated", "clock_tb", "5");
  assert.equal(clock.coverage.status, "complete");
  const held = clock.events.filter(({ tick }) => tick === "1");
  assert.deepEqual(held.map(({ kind }) => kind), ["assignment-evaluated", "assignment-committed"]);
  assert.equal(held[1].evaluationOrdinal, held[0].ordinal);
  assert.equal(held[1].value, "0000");
  assert.equal(held[1].timing, "simulator-commit");

  const burst = await trace("burst", "nba_burst_tb", "2");
  assert.equal(burst.coverage.status, "partial");
  assert.deepEqual(burst.coverage.gaps, ["unobservedCommit"]);
  assert.equal(burst.coverage.pendingEvaluations, 0);
  assert.deepEqual(burst.events.filter(({ kind }) => kind === "assignment-unobserved")
    .map(({ evaluationOrdinal }) => evaluationOrdinal), [0, 1]);
  assert.deepEqual(burst.events.filter(({ kind }) => kind === "assignment-committed")
    .map(({ evaluationOrdinal, value }) => [evaluationOrdinal, value]), [[2, "0010"], [7, "0011"]]);
  const observations = [{
    signal: 0, width: 4, initial: { tick: "0", value: "0000" },
    history: [{ tick: "1", value: "0010" }, { tick: "2", value: "0011" }],
  }];
  const graph = { nodes: [{ signal: 0, tick: "2", value: "0011" }], edges: [] };
  const comparisons = correlateExecutionTransitions(0, { tick: "2", observations }, graph, burst, []);
  assert.equal(comparisons.find(({ tick }) => tick === "1").status, "incomplete");
  assert.equal(comparisons.find(({ tick }) => tick === "2").status, "matched");
  assert.match(executionMermaid(burst), /outcome unobserved/);
});

test("VCS packed writes reconstruct the bus and attribute only the written bits", {
  skip: !process.env.WAVE_TEST_VCS_PACKED_WRITE,
}, async () => {
  const build = process.env.WAVE_TEST_VCS_PACKED_WRITE;
  const replay = await readExecutionEvidence(
    path.join(build, "sealed.jsonl"), path.join(build, "reference.vcd"),
    "1ns", "packed_write_tb", "q", "1", "3",
  );
  assert.equal(replay.coverage.status, "complete");
  const commits = replay.events.filter(event =>
    event.tick === "3" && event.kind === "assignment-committed");
  assert.deepEqual(commits.map(({ targetRange, value }) => [targetRange, value]),
    [[[0, 3], "1001"], [[4, 7], "0101"]]);
  const observations = [{
    signal: 0, width: 8, range: [0, 7],
    initial: { tick: "0", value: "00000000" },
    history: [{ tick: "3", value: "10010000" }, { tick: "3", value: "10010101" }],
  }];
  const graph = { nodes: [
    { signal: 0, tick: "3", value: "10010000", orderAtTick: 1 },
    { signal: 0, tick: "3", value: "10010101", orderAtTick: 2 },
    { signal: 0, tick: "3", value: "1", bit: 0 },
    { signal: 0, tick: "3", value: "1", bit: 7 },
  ], edges: [] };
  const compare = (bit) => correlateExecutionTransitions(
    0, { tick: "3", observations }, graph, replay, [], { bit },
  )[0];
  assert.deepEqual(compare().links.map(({ ordinal }) => ordinal),
    commits.map(({ ordinal }) => ordinal));
  assert.deepEqual(compare(0).links.map(({ ordinal }) => ordinal), [commits[0].ordinal]);
  assert.deepEqual(compare(7).links.map(({ ordinal }) => ordinal), [commits[1].ordinal]);
});

test("VCS dynamic NBA replay uses the saved index across same-tick updates and invalid indices", {
  skip: !process.env.WAVE_TEST_VCS_DYNAMIC_WRITE,
}, async () => {
  const build = process.env.WAVE_TEST_VCS_DYNAMIC_WRITE;
  const replay = await readExecutionEvidence(
    path.join(build, "sealed.jsonl"), path.join(build, "reference.vcd"),
    "1ns", "dynamic_write_tb", "q", "1", "10",
  );
  const commits = replay.events.filter(({ kind }) => kind === "assignment-committed");
  assert.deepEqual(commits.map(({ tick, targetRange }) => [tick, targetRange]),
    [["2", [-1, -1]], ["4", [2, 2]], ["10", [1, 1]]]);
  const unusableIndexes = replay.events.filter(({ kind }) =>
    kind === "assignment-unobserved" || kind === "assignment-no-target");
  assert.deepEqual(unusableIndexes
    .map(({ tick, targetRange }) => [tick, targetRange]), [["6", undefined], ["8", undefined]]);
  assert.deepEqual(replay.coverage.gaps,
    unusableIndexes.some(({ kind }) => kind === "assignment-unobserved") ? ["unobservedCommit"] : []);
  const observations = [{
    signal: 0, width: 5, range: [3, -1],
    initial: { tick: "0", value: "00000" },
    history: [
      { tick: "2", value: "00001" },
      { tick: "4", value: "01001" },
      { tick: "10", value: "01101" },
    ],
  }];
  const graph = { nodes: [
    { signal: 0, tick: "2", value: "1", bit: -1 },
    { signal: 0, tick: "4", value: "1", bit: 2 },
    { signal: 0, tick: "10", value: "1", bit: 1 },
  ], edges: [] };
  for (const [node, bit] of [-1, 2, 1].entries()) {
    const result = correlateExecutionTransitions(
      0, { tick: "10", observations }, graph, replay, [], { bit },
    );
    assert.deepEqual(result.find(({ tick }) => tick === commits[node].tick)?.links,
      [{ node, ordinal: commits[node].ordinal, assignment: undefined }]);
  }
});

test("VCS indexed NBA replay preserves range direction for old and clipped outcomes", {
  skip: !process.env.WAVE_TEST_VCS_INDEXED_WRITE,
}, async () => {
  const build = process.env.WAVE_TEST_VCS_INDEXED_WRITE;
  const get = (signal) => readExecutionEvidence(
    path.join(build, "sealed.jsonl"), path.join(build, "reference.vcd"),
    "1ns", "indexed_write_tb", signal, "1", "12",
  );
  const [asc, desc] = await Promise.all([get("ascending"), get("descending")]);
  const writes = (recording) => recording.events.filter(({ kind, attemptedTargetRange }) =>
    kind === "assignment-committed" && !attemptedTargetRange)
    .map(({ tick, targetRange, value }) => [tick, targetRange, value]);
  assert.deepEqual(writes(asc), [
    ["2", [1, 2], "10"], ["4", [4, 5], "10"], ["8", [0, 1], "10"], ["12", [3, 4], "10"],
  ]);
  assert.deepEqual(writes(desc), [
    ["2", [1, 0], "10"], ["4", [4, 3], "10"], ["6", [7, 6], "10"], ["12", [3, 2], "10"],
  ]);
  const special = (recording) => recording.events.filter(({ kind, attemptedTargetRange }) =>
    kind === "assignment-unobserved" || kind === "assignment-no-target" || attemptedTargetRange)
    .map(({ tick, targetRange, attemptedTargetRange, evaluationOrdinal }) => {
      const evaluation = recording.events.find(({ ordinal }) => ordinal === evaluationOrdinal);
      assert.deepEqual(evaluation.targetRange, attemptedTargetRange ?? targetRange);
      assert.equal(evaluation.value, "10");
      return [tick, attemptedTargetRange ?? targetRange];
    });
  for (const [recording, tick, expectedRange] of [
    [asc, "6", [7, 8]], [desc, "8", [0, -1]],
  ]) {
    const outcomes = special(recording);
    assert.deepEqual(outcomes.map(([time]) => time), [tick, "10"]);
    if (outcomes[0][1]) assert.deepEqual(outcomes[0][1], expectedRange);
    assert.equal(outcomes[1][1], undefined);
  }
  assert.equal(asc.coverage.pendingEvaluations, 0);
  assert.equal(desc.coverage.pendingEvaluations, 0);
});

test("VCS partial NBA commits retain the attempted range and actual bits", {
  skip: !process.env.WAVE_TEST_VCS_PARTIAL_TARGET,
}, async (t) => {
  const fixture = process.env.WAVE_TEST_VCS_PARTIAL_TARGET;
  const log = path.join(fixture, "sealed.jsonl");
  const waveform = path.join(fixture, "reference.vcd");
  const read = (signal, recording = log) =>
    readExecutionEvidence(recording, waveform, "1ns", "partial_tb", signal, "1", "4");
  const cases = [
    ["asc_right", [7, 8], 7, 14], ["desc_right", [0, -1], 0, 16],
    ["asc_left", [-1, 0], 0, 18], ["desc_left", [8, 7], 7, 20],
  ];
  for (const [signal, attempted, bit, ordinal] of cases) {
    const replay = await read(signal);
    assert.deepEqual(replay.coverage.gaps, []);
    const commits = replay.events.filter(({ kind }) => kind === "assignment-committed");
    assert.deepEqual(commits.map((event) => ({
      tick: event.tick,
      attempted: event.attemptedTargetRange,
      range: event.targetRange,
      written: event.value,
      evaluated: replay.events.find((sample) => sample.ordinal === event.evaluationOrdinal)?.value,
    })), [
      { tick: "2", attempted, range: [bit, bit], written: "0", evaluated: "10" },
      { tick: "4", attempted, range: [bit, bit], written: "1", evaluated: "01" },
    ]);
    assert.equal(commits[1].ordinal, ordinal);
    assert.match(executionReport(replay), /Attempted target/);
  }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wave-clipped-commit-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const events = (await fs.readFile(log, "utf8")).trim().split("\n").map(JSON.parse);
  const commit = events.find(({ ordinal }) => ordinal === 14);
  commit.value = "0";
  const changed = path.join(directory, "changed.jsonl");
  await fs.writeFile(changed, events.map((event) => JSON.stringify(event)).join("\n") + "\n");
  await assert.rejects(read("asc_right", changed), /Execution outcome does not match its evaluation/);
});

test("VCS NBA selections without a writable target preserve same-slot commit attribution", {
  skip: !process.env.WAVE_TEST_VCS_NO_TARGET,
}, async () => {
  const build = process.env.WAVE_TEST_VCS_NO_TARGET;
  const replay = await readExecutionEvidence(
    path.join(build, "sealed.jsonl"), path.join(build, "reference.vcd"),
    "1ns", "no_target_tb", "q", "1", "4",
  );
  assert.deepEqual(replay.coverage.gaps, []);
  assert.equal(replay.coverage.pendingEvaluations, 0);
  assert.deepEqual(replay.events.filter(({ kind }) => kind === "assignment-no-target")
    .map(({ tick, ordinal, evaluationOrdinal }) => [tick, ordinal, evaluationOrdinal]),
  [["2", 3, 2], ["4", 11, 10]]);
  assert.match(executionMermaid(replay), /no writable target bits/);
  const observations = [{
    signal: 0, width: 4, range: [3, 0], initial: { tick: "0", value: "0000" },
    history: [{ tick: "2", value: "0001" }, { tick: "4", value: "0011" }],
  }];
  const graph = { nodes: [
    { signal: 0, bit: 0, tick: "2", value: "1" },
    { signal: 0, bit: 1, tick: "4", value: "1" },
  ] };
  for (const [bit, tick, ordinal] of [[0, "2", 6], [1, "4", 13]]) {
    const compare = (recording) => correlateExecutionTransitions(
      0, { tick, observations }, graph, recording, [], { bit },
    ).find((entry) => entry.tick === tick);
    assert.deepEqual(compare(replay).links, [{ node: bit, ordinal, assignment: undefined }]);
    const legacy = {
      ...replay,
      events: replay.events.map((event) => event.kind === "assignment-no-target"
        ? { ...event, kind: "assignment-unobserved" } : event),
    };
    assert.equal(compare(legacy).status, "incomplete");
  }
});

test("VCS overlapping NBA outcomes preserve observed commits and unresolved gaps", {
  skip: !process.env.WAVE_TEST_VCS_OVERLAP_WRITE,
}, async () => {
  const build = process.env.WAVE_TEST_VCS_OVERLAP_WRITE;
  const read = (signal) => readExecutionEvidence(
    path.join(build, "sealed.jsonl"), path.join(build, "reference.vcd"),
    "1ns", "overlap_write_tb", signal, "1", "4",
  );
  const [q, mixed] = await Promise.all([read("q"), read("mixed")]);
  const writes = (recording) => recording.events.filter(({ kind }) =>
    kind === "assignment-committed" || kind === "assignment-unobserved")
    .map(({ tick, kind, targetRange, value }) => [tick, kind, targetRange, value]);
  const rangeTags = q.events.some(({ ordinal, kind }) =>
    ordinal === 8 && kind === "assignment-committed");
  const mixedTags = mixed.events.some(({ tick, kind }) =>
    tick === "2" && kind === "assignment-committed");
  assert.deepEqual(writes(q), [
    rangeTags ? ["2", "assignment-committed", [2, 1], "11"]
      : ["2", "assignment-unobserved", [2, 1], undefined],
    rangeTags ? ["2", "assignment-committed", [1, 0], "01"]
      : ["2", "assignment-unobserved", [1, 0], undefined],
    ["2", "assignment-committed", [3, 3], "1"],
    ["4", "assignment-committed", [2, 1], "01"],
  ]);
  assert.deepEqual(writes(mixed), [
    mixedTags ? ["2", "assignment-committed", [2, 1], "11"]
      : ["2", "assignment-unobserved", [2, 1], undefined],
    mixedTags ? ["2", "assignment-committed", [1, 0], "01"]
      : ["2", "assignment-unobserved", [1, 0], undefined],
    mixedTags ? ["4", "assignment-committed", [1, 0], "01"]
      : ["4", "assignment-unobserved", [1, 0], undefined],
    mixedTags ? ["4", "assignment-committed", undefined, "1000"]
      : ["4", "assignment-unobserved", undefined, undefined],
  ]);
  for (const [recording, complete] of [[q, rangeTags], [mixed, mixedTags]]) {
    assert.deepEqual(recording.coverage.gaps, complete ? [] : ["unobservedCommit"]);
    assert.equal(recording.coverage.pendingEvaluations, 0);
  }
  const observations = [{
    signal: 0, width: 4, range: [3, 0], initial: { tick: "0", value: "0000" },
    history: ["0110", "0101", "1101"].map(value => ({ tick: "2", value })),
  }];
  const temporal = { nodes: [
    { signal: 0, bit: 2, tick: "2", value: "1" },
    { signal: 0, bit: 3, tick: "2", value: "1" },
    { signal: 0, bit: 1, tick: "2", value: "1", orderAtTick: 1 },
    { signal: 0, bit: 1, tick: "2", value: "0", orderAtTick: 2 },
  ] };
  const compare = (bit) => correlateExecutionTransitions(
    0, { tick: "2", observations }, temporal, q, [], { bit },
  ).find(({ tick }) => tick === "2");
  if (rangeTags) {
    assert.deepEqual(compare(2).links, [{ node: 0, ordinal: 8, assignment: undefined }]);
    assert.deepEqual(compare(1).links, [
      { node: 2, ordinal: 8, assignment: undefined },
      { node: 3, ordinal: 10, assignment: undefined },
    ]);
  } else {
    assert.equal(compare(2).status, "incomplete");
  }
  assert.deepEqual(compare(3).links, [{ node: 1, ordinal: 12, assignment: undefined }]);
  if (mixedTags) {
    const observed = [{
      ...observations[0],
      history: observations[0].history.slice(0, 2),
    }];
    const comparison = correlateExecutionTransitions(
      0, { tick: "2", observations: observed }, temporal, mixed, [], { bit: 1 },
    ).find(({ tick }) => tick === "2");
    assert.deepEqual(comparison.links, [
      { node: 2, ordinal: 14, assignment: undefined },
      { node: 3, ordinal: 16, assignment: undefined },
    ]);
    const whole = mixed.events.find(({ ordinal }) => ordinal === 26);
    assert.equal(whole.evaluationOrdinal, 21);
    assert.equal(whole.timing, "simulator-commit");
  }
});

test("replays mapped C++ steps of a recorded DPI assignment", {
  skip: !process.env.WAVE_TEST_RECORDED_DPI,
}, async (t) => {
  const stage = process.env.WAVE_TEST_RECORDED_DPI;
  const instance = "TOP.recorded_dpi_tb";
  const replay = await readExecutionEvidence(
    path.join(stage, "execution.jsonl"), path.join(stage, "trace.vcd"),
    "1ps", instance, "result", "0", "3",
  );
  assert.equal(replay.coverage.status, "complete");
  const evaluation = replay.events.find(({ ordinal }) => ordinal === 4);
  assert.equal(evaluation.kind, "assignment-evaluated");
  assert.deepEqual(evaluation.resolvedExternalSteps.map(step => [
    step.statementId, Number.parseInt(step.value, 2), step.source.identity,
  ]), [["adjust.entry", 4, "matched"], ["adjust.result", 8, "matched"]]);
  assert.match(executionMermaid(replay), /next recorded step/);
  assert.match(executionReport(replay), /stimulus\.cc L9 · Source matched/);
  const binary = process.platform === "win32" ? "Vrecorded_dpi_tb.exe" : "Vrecorded_dpi_tb";
  const session = await LiveTraceSession.start(path.join(stage, "obj_dir", binary), stage, () => {});
  t.after(() => session.dispose());
  assert.equal((await session.stepClock(instance + ".clk", 2)).snapshot.tick, "3");
  assert.equal(matchLiveExecution(replay, session.executionWindow(instance, "result", "0", "3"), true), "matched");
});

test("replays data from a deferred Verilator DPI worker", {
  skip: !process.env.WAVE_TEST_DEFERRED_DPI,
}, async (t) => {
  const stage = process.env.WAVE_TEST_DEFERRED_DPI;
  const instance = "TOP.recorded_dpi_tb";
  const replay = await readExecutionEvidence(
    path.join(stage, "execution.jsonl"), path.join(stage, "trace.vcd"),
    "1ps", instance, "result", "0", "3",
  );
  assert.equal(replay.coverage.status, "complete");
  const evaluation = replay.events.find(event =>
    event.tick === "3" && event.kind === "assignment-evaluated");
  assert.deepEqual(evaluation.resolvedExternalSteps.map(step => [
    step.statementId, Number.parseInt(step.value, 2), step.source.identity,
  ]), [["worker.input", 3, "matched"], ["worker.result", 6, "matched"]]);
  if (process.env.WAVE_TEST_DEFERRED_DPI_STAMPS === "1")
    assert.deepEqual(evaluation.resolvedExternalSteps.map(step => step.captured), [
      {tick: "1", ordinal: 0}, {tick: "1", ordinal: 1},
    ]);
  if (process.env.WAVE_TEST_DEFERRED_DPI_AUTONOMOUS === "1") {
    const independent = replay.events.find(event => event.kind === "external-observation");
    assert.equal(independent.tick, "2");
    assert.equal(independent.externalSteps[0].statementId, "worker.complete");
    assert.equal(independent.resolvedExternalSteps[0].source.identity, "matched");
    assert.deepEqual(independent.externalSteps[0].captured, {tick: "1", ordinal: 2});
    assert.equal(Number.parseInt(independent.externalSteps[0].value, 2), 6);
  }
  const binary = process.platform === "win32" ? "Vrecorded_dpi_tb.exe" : "Vrecorded_dpi_tb";
  const session = await LiveTraceSession.start(path.join(stage, "obj_dir", binary), stage, () => {});
  t.after(() => session.dispose());
  const { snapshot } = await session.stepClock(instance + ".clk", 2);
  assert.equal(snapshot.tick, "3");
  assert.equal(Number.parseInt(snapshot.values[instance + ".input_arg"], 2), 4);
  assert.equal(Number.parseInt(snapshot.values[instance + ".result"], 2), 6);
  assert.equal(matchLiveExecution(replay, session.executionWindow(instance, "result", "0", "3"), true), "matched");
});

test("recorded commits correlate with same-tick changes only when their sequences agree", () => {
  const tick = "5";
  const history = ["1", "0", "1"].map(value => ({ tick, value }));
  const observation = { signal: 0, width: 1, initial: { tick: "0", value: "0" }, history };
  const temporal = { nodes: [...history].reverse().map((event, index) => ({
    ...event, signal: 0, orderAtTick: 3 - index,
  })) };
  const events = ["1", "1", "0", "1"].map((value, ordinal) => ({
    tick, value, ordinal, kind: "assignment-committed",
    writeKind: "nonblocking", timing: "simulator-commit",
  }));
  const recording = { start: "0", waveformMatch: "verified", events, coverage: {
    declared: { start: "0" }, status: "complete",
  } };
  const correlate = (wave, execution = recording) => correlateExecutionTransitions(
    0, { tick, observations: [wave] }, temporal, execution, [{ ordinal: 0, assignment: 2 }],
  )[0];
  const result = correlate(observation);
  assert.equal(result.status, "matched");
  assert.deepEqual(result.links.map(({ node, ordinal }) => [node, ordinal]), [[2, 0], [1, 2], [0, 3]]);
  assert.equal(result.links[0].assignment, 2);
  const compressed = correlate({ ...observation, history: [{ tick, value: "1" }] });
  assert.equal(compressed.status, "sequenceDiffers");
  assert.deepEqual(compressed.recordedChangeValues, ["1", "0", "1"]);
  assert.equal(compressed.links, undefined);
  assert.equal(correlate(observation, { ...recording, truncated: true }).status, "incomplete");
  assert.equal(correlate(observation, { ...recording,
    events: events.map(event => ({ ...event, timing: "end-of-slot" })),
  }).status, "approximateCommitTiming");
});

test("verified array writes contribute their individual ranges and upstream operands", () => {
  const tick = "5";
  const range = [3, 0];
  const word = { id: 7, array: 4, index: "1", name: "mem[1]", instance: "tb" };
  const location = { uri: "file:///trace.sv", range: { start: { line: 4, character: 0 } } };
  const slices = [[1, 0], [3, 2]];
  const trace = {
    root: word.id,
    assignments: slices.map((targetRange, index) => ({
      kind: "nonblocking", location, targets: [word.array], targetRange,
      targetElementIndex: { op: "signal", args: 9 },
      elementValue: { op: "signal", args: index + 1 },
      inputs: [{ signal: index + 1, kind: "data" }, { signal: 9, kind: "data" }],
    })),
  };
  const observation = (signal, width, history) => ({
    signal, width, range: [width - 1, 0],
    initial: { tick: "0", value: "0".repeat(width) },
    history: history.map(([tick, value]) => ({ tick, value })),
  });
  const evidence = { tick, observations: [
    observation(word.id, 4, [[tick, "0011"], [tick, "1011"]]),
    observation(1, 2, [["2", "11"]]),
    observation(2, 2, [["3", "10"]]),
    observation(9, 2, [["3", "01"], [tick, "10"]]),
  ] };
  const events = [
    ...["11", "10"].map((value, ordinal) => ({ kind: "assignment-evaluated", tick, value, ordinal })),
    ...["11", "10"].map((value, index) => ({
      kind: "assignment-committed", tick, value, ordinal: index + 2, evaluationOrdinal: index,
      writeKind: "nonblocking", timing: "simulator-commit",
      targetRange: slices[index], targetPackedRange: range,
    })),
  ];
  const base = buildTemporalTrace(trace, evidence, undefined, false, undefined, undefined, [word]);
  const replay = (links, input = evidence, recorded = events, lost = false) => {
    const execution = { start: "0", waveformMatch: "verified", events: recorded,
      coverage: {
        status: lost ? "partial" : "complete",
        ...(lost ? { gaps: ["unobservedCommit"] } : {}),
        declared: { start: "0" },
      } };
    const before = input === evidence ? base :
      buildTemporalTrace(trace, input, undefined, false, undefined, undefined, [word]);
    const comparisons = correlateExecutionTransitions(word.id, input, before, execution, links);
    assert.equal(comparisons.find(comparison => comparison.tick === tick).status, "matched");
    const writers = recordedWriters(before, comparisons, recorded, undefined, links);
    return buildTemporalTrace(trace, input, writers, false, undefined, undefined, [word]);
  };
  const links = events.map(({ ordinal }) => ({ ordinal, assignment: ordinal % 2 }));
  const graph = replay(links);
  const final = graph.nodes.findIndex(({ signal, value }) => signal === word.id && value === "1011");
  assert.deepEqual(graph.nodes[final].recordedWordWriters.map((writer) =>
    [writer.targetRange, writer.evaluation.ordinal, writer.commitOrdinal]),
    [[[1, 0], 0, 2], [[3, 2], 1, 3]]);
  assert.deepEqual(graph.edges.filter(({ target, role }) => target === final && role !== "index").map((edge) =>
    [edge.recordedCommitOrdinal, graph.nodes[edge.source].signal, graph.nodes[edge.source].tick]),
    [[2, 1, "2"], [3, 2, "3"]]);
  assert.deepEqual(graph.edges.filter(({ target, role }) => target === final && role === "index").map((edge) =>
    [edge.recordedCommitOrdinal, edge.arrayIndexEvidence, graph.nodes[edge.source].value]),
    [[2, "recordedTarget", "01"], [3, "recordedTarget", "01"]]);
  const incomplete = replay(links.filter(({ ordinal }) => ordinal !== 0));
  assert.deepEqual(incomplete.nodes[final].recordedWordUnresolved, [[1, 0]]);
  assert.deepEqual(incomplete.nodes[final].recordedWordWriters.map(({ commitOrdinal }) => commitOrdinal), [3]);
  assert(incomplete.coverage.reasons.includes("arrayWordWriterUnresolved"));
  assert.equal(incomplete.nodes[final].recordedWriter.commitOrdinal, 3);
  const moved = {
    ...evidence,
    observations: [observation(word.id, 4, [["4", "0011"], [tick, "1011"]]),
      ...evidence.observations.slice(1)],
  };
  const olderCommit = { ...events[2], ordinal: 1, tick: "4" };
  const laterEvaluation = { ...events[1], ordinal: 3 };
  const laterCommit = { ...events[3], ordinal: 4, evaluationOrdinal: 3 };
  const loss = {
    ordinal: 2, tick: "4", kind: "assignment-unobserved", targetRange: [1, 1],
  };
  const recorded = [{ ...events[0], tick: "4" }, olderCommit, loss, laterEvaluation, laterCommit];
  const mappings = [0, 1, 3, 4].map(ordinal => ({ ordinal, assignment: ordinal >= 3 ? 1 : 0 }));
  const oneLostBit = replay(mappings, moved, recorded, true).nodes
    .find(({ signal, value }) => signal === word.id && value === "1011");
  assert.deepEqual(oneLostBit.recordedWordUnresolved, [[1, 1]]);
  assert.deepEqual(oneLostBit.recordedWordWriters.map(({ commitOrdinal, contributingRanges }) =>
    [commitOrdinal, contributingRanges]), [[1, [[0, 0]]], [4, undefined]]);

  const sameSlot = [...events, { ...loss, ordinal: 4, tick },
    { ordinal: 5, tick, kind: "signal-value-changed", value: "0011" },
    { ordinal: 6, tick, kind: "signal-value-changed", value: "1011" }];
  const compareSlot = (recorded, waveformMatch = "verified") => correlateExecutionTransitions(
    word.id, evidence, base, {
      start: "0", waveformMatch, events: recorded,
      coverage: { status: "partial", gaps: ["unobservedCommit"], declared: { start: "0" } },
      observationCoverage: { start: "0", gaps: [] },
    }, links, { word: true },
  );
  const accepted = compareSlot(sameSlot);
  assert.equal(accepted[0].status, "partiallyMatched");
  const slot = buildTemporalTrace(
    trace, evidence, recordedWriters(base, accepted, sameSlot, undefined, links),
    false, undefined, undefined, [word],
  );
  assert.deepEqual(slot.nodes[final].recordedWordUnresolved, [[1, 1]]);
  assert.deepEqual(slot.nodes[final].recordedWordWriters.map(({ commitOrdinal, contributingRanges }) =>
    [commitOrdinal, contributingRanges]), [[2, [[0, 0]]], [3, undefined]]);
  const partialRange = sameSlot.map(event => event.ordinal === 4
    ? { ...event, targetRange: [4, 3] }
    : event);
  const partialComparison = compareSlot(partialRange);
  assert.deepEqual(partialComparison[0].wordSnapshot.excluded, [0]);
  const partial = buildTemporalTrace(
    trace, evidence, recordedWriters(base, partialComparison, partialRange, undefined, links),
    false, undefined, undefined, [word],
  );
  assert.deepEqual(partial.nodes[final].recordedWordUnresolved, [[3, 3]]);
  assert.deepEqual(partial.nodes[final].recordedWordWriters.map(({ commitOrdinal, contributingRanges }) =>
    [commitOrdinal, contributingRanges]), [[2, undefined], [3, [[2, 2]]]]);
  const earlierPartial = recorded.map(event => event.ordinal === loss.ordinal
    ? { ...event, targetRange: [0, -1] }
    : event);
  const earlier = replay(mappings, moved, earlierPartial, true).nodes
    .find(({ signal, value }) => signal === word.id && value === "1011");
  assert.deepEqual(earlier.recordedWordUnresolved, [[0, 0]]);
  assert.deepEqual(earlier.recordedWordWriters.map(({ commitOrdinal, contributingRanges }) =>
    [commitOrdinal, contributingRanges]), [[1, [[1, 1]]], [4, undefined]]);
  const wrongTail = [...sameSlot.slice(0, -1), { ...sameSlot.at(-1), value: "1010" }];
  assert.equal(compareSlot(wrongTail)[0].status, "incomplete");
  assert.equal(compareSlot(sameSlot, "unverified")[0].status, "incomplete");
  const unexpectedBit = sameSlot.map(event => event.ordinal === 5 ? { ...event, value: "0111" } : event);
  assert.deepEqual(compareSlot(unexpectedBit)[0].wordSnapshot.excluded, [1, 2]);
});

const directory = process.env.WAVE_TEST_EXECUTION_TRACE;
test("one Verilator recording verifies both stages of a pipeline", {
  skip: !process.env.WAVE_TEST_RECORDED_UPSTREAM,
}, async () => {
  const stage = process.env.WAVE_TEST_RECORDED_UPSTREAM;
  const instance = "TOP.sampled_pipe_tb";
  const [second, first] = await readExecutionEvidenceBatch(
    path.join(stage, "execution.jsonl"), path.join(stage, "trace.fst"), "1ps",
    [{ instance, signal: "second_q" }, { instance, signal: "first_q" }], "0", "3",
  );
  for (const evidence of [first, second]) {
    assert.equal(evidence.coverage.status, "complete");
    assert.equal(evidence.coverage.pendingEvaluations, 0);
    assert.equal(evidence.waveformMatch, "verified");
  }
  assert(first.events.every(event => event.signal === undefined || event.signal === "first_q"));
  assert(second.events.every(event => event.signal === undefined || event.signal === "second_q"));
  assert.equal(first.events.find(event => event.ordinal === 4).source.identity, "matched");
  assert.equal(second.events.find(event => event.ordinal === 8).source.identity, "matched");
});

test("captured operands resolve earlier whole writes through covered execution history", () => {
  const evaluation = { tick: "1", ordinal: 1, kind: "assignment-evaluated", value: "1" };
  const commit = { tick: "1", ordinal: 3, kind: "assignment-committed", value: "1",
    writeKind: "nonblocking", timing: "simulator-commit", evaluationOrdinal: 1 };
  const pending = { ...commit, tick: "3", ordinal: 9, evaluationOrdinal: 5, value: "0" };
  const events = [evaluation, commit, pending];
  const links = [1, 3].map(ordinal => ({ ordinal, assignment: 2 }));
  const recording = { waveformMatch: "verified", coverage: {
    status: "complete", declared: { start: "1" },
  }, events };
  const resolve = (replacement = events, mappings = links) =>
    recordedOperandHistory({ ...recording, events: replacement }, mappings)?.("3", 6, "1");
  assert.deepEqual(resolve(), [{ tick: "1", value: "1", writer: {
    assignment: 2, commitOrdinal: 3, evaluation: { tick: "1", ordinal: 1, value: "1" },
  } }]);
  assert.equal(resolve([...events, { ...pending, ordinal: 10 }]), undefined);
  assert.equal(resolve([evaluation, commit, { ...pending, value: "1" }]), undefined);
  assert.equal(resolve([evaluation, { ...commit, timing: "end-of-slot" }]), undefined);
  assert.equal(resolve(events, links.slice(1)), undefined);
  assert.equal(recordedOperandHistory({ ...recording, truncated: true }, links), undefined);
  const upper = { ...commit, targetRange: [4, 5], targetPackedRange: [4, 7], value: "10" };
  const lower = { ...commit, tick: "3", ordinal: 6, evaluationOrdinal: 5,
    targetRange: [6, 7], targetPackedRange: [4, 7], value: "10" };
  const packed = { ...recording, events: [
    { ...evaluation, value: "10" }, upper, { ...evaluation, tick: "3", ordinal: 5, value: "10" }, lower,
  ] };
  const packedLinks = [...links, { ordinal: 5, assignment: 4 }, { ordinal: 6, assignment: 4 }];
  const bits = recordedOperandHistory(packed, packedLinks)("5", 9, "1010");
  assert.deepEqual(bits.map(({ bit, value, writer }) => [bit, value, writer?.commitOrdinal]),
    [[4, "1", 3], [5, "0", 3], [6, "1", 6], [7, "0", 6]]);
  const partial = recordedOperandHistory(packed, links)("5", 9, "1010");
  assert.deepEqual(partial.map(({ bit, writer }) => [bit, writer?.commitOrdinal]),
    [[4, 3], [5, 3], [6, undefined], [7, undefined]]);
  const loss = { tick: "3", ordinal: 7, kind: "assignment-unobserved",
    evaluationOrdinal: 5, targetRange: [6, 7] };
  const overlap = { ...packed, coverage: {
    ...packed.coverage, status: "partial", gaps: ["unobservedCommit"],
  }, events: [...packed.events, loss, { ...evaluation, tick: "5", ordinal: 8, value: "01" },
    { ...lower, tick: "5", ordinal: 10, value: "01", evaluationOrdinal: 8 }] };
  const overlapLinks = [...packedLinks, { ordinal: 8, assignment: 4 }, { ordinal: 10, assignment: 4 }];
  const recover = recordedOperandHistory(overlap, overlapLinks);
  assert.deepEqual(recover("5", 9, "1010").map(({ bit, writer }) => [bit, writer?.commitOrdinal]),
    [[4, 3], [5, 3], [6, undefined], [7, undefined]]);
  assert.deepEqual(recover("7", 12, "1001").map(({ bit, writer }) => [bit, writer?.commitOrdinal]),
    [[4, 3], [5, 3], [6, 10], [7, 10]]);
  const unknownRange = { ...overlap, events: overlap.events.map(event =>
    event === loss ? { ...loss, targetRange: undefined } : event) };
  assert.equal(recordedOperandHistory(unknownRange, overlapLinks)("5", 9, "1010"), undefined);
  const comparison = correlateExecutionTransitions(0, {
    tick: "5", observations: [{ signal: 0, status: "unavailable", width: 0, history: [] }],
  }, { nodes: [{ signal: 0, bit: 6, tick: "5", sampleOnly: true }] }, {
    ...overlap, start: "0",
  }, overlapLinks, { bit: 6, compareCursor: false });
  assert.deepEqual(comparison.map(({ tick, status }) => [tick, status]), [["3", "incomplete"]]);
});

test("the time graph follows a verified same-value cursor write", () => {
  const location = { uri: "file:///trace.sv", range: { start: { line: 4, character: 0 } } };
  const trace = {
    root: 0,
    assignments: [{ kind: "nonblocking", location, targets: [0], inputs: [{ signal: 1, kind: "data" }] }],
  };
  const root = {
    signal: 0, width: 1, status: "observed", value: "1",
    initial: { tick: "0", value: "0" },
    history: [{ tick: "1", value: "1" }],
  };
  const evidence = { tick: "5", historyStart: "0", historyEnd: "5", observations: [
    root, { ...root, signal: 1, history: [{ tick: "2", value: "1" }] },
  ] };
  const evaluation = { tick: "3", ordinal: 4, kind: "assignment-evaluated", value: "1" };
  const commit = {
    tick: "3", ordinal: 5, kind: "assignment-committed", evaluationOrdinal: 4,
    value: "1", writeKind: "nonblocking", timing: "simulator-commit",
  };
  const recording = {
    waveformMatch: "verified", coverage: { status: "complete" },
    events: [evaluation, commit], cursor: { status: "held", latestCommit: commit },
  };
  const links = [4, 5].map((ordinal) => ({ ordinal, assignment: 0 }));
  const recover = (entry, observation = evidence) => recordedCursorWrite(trace, observation, entry, links);
  const write = recover(recording);
  assert.deepEqual(write, {
    tick: "3", value: "1",
    writer: { assignment: 0, commitOrdinal: 5, evaluation: { tick: "3", ordinal: 4, value: "1" } },
  });
  const graph = (samples, limits) => buildTemporalTrace(trace, samples, undefined, false,
    undefined, limits, undefined, undefined, write);
  const held = graph(evidence);
  assert.equal(held.nodes[0].tick, "3");
  assert.equal(held.nodes[0].sameValueWrite, true);
  assert.equal(held.nodes[0].executionOnly, true);
  assert.deepEqual(held.edges.map(({ source }) => held.nodes[source].tick), ["2"]);

  const change = graph({ ...evidence, tick: "1" }, { changeOrder: 1 });
  assert.equal(change.nodes[0].tick, "1");
  assert.equal(change.nodes[0].sameValueWrite, undefined);
  const aligned = { ...root, history: [{ tick: "3", value: "1" }] };
  const observed = graph({ ...evidence, observations: [aligned, evidence.observations[1]] });
  assert.equal(observed.nodes[0].tick, "3");
  assert.equal(observed.nodes[0].sameValueWrite, undefined);
  const truncated = graph({ ...evidence, observations: [{ ...root, historyTruncated: true }] });
  assert(!truncated.nodes.some(({ sameValueWrite }) => sameValueWrite));

  assert.equal(recover({ ...recording, coverage: { status: "partial" } }), undefined);
  assert.equal(recover({ ...recording, waveformMatch: "unverified" }), undefined);
  assert.equal(recordedCursorWrite(trace, evidence, recording, links.slice(1)), undefined);
  assert.equal(recover({
    ...recording,
    events: [evaluation, commit, { ...commit, ordinal: 6, kind: "signal-value-changed" }],
  }), undefined);

  const packed = { ...commit, value: "01", targetRange: [2, 3] };
  const projected = { ...root, projected: true, range: [0, 3], bit: 3 };
  assert.equal(recover({
    ...recording, events: [evaluation, packed], cursor: { latestCommit: packed },
  }, { ...evidence, observations: [projected] }).value, "1");
  assert.equal(recover({
    ...recording, events: [evaluation, packed], cursor: { latestCommit: packed },
  }, { ...evidence, observations: [{ ...projected, bit: 1 }] }), undefined);
});

test("a verified startup commit supplies an initial sample and can recover its actual operand", () => {
  const location = { uri: "file:///startup.sv", range: { start: { line: 4, character: 0 } } };
  const trace = {
    root: 0,
    signals: [{ id: 0, name: "q" }, { id: 1, name: "seed", instance: "tb" }],
    assignments: [{
      instance: "tb",
      kind: "nonblocking",
      location,
      targets: [0],
      inputs: [{ signal: 1, kind: "data" }],
    }, { kind: "blocking", location, targets: [1], inputs: [] }],
    frontier: [],
  };
  const observation = (signal, value) => ({
    signal, status: "observed", width: 1, value, history: [{ tick: "0", value }],
  });
  const evidence = {
    tick: "0", historyStart: "0", observations: [observation(0, "1"), observation(1, "1")],
  };
  const graph = buildTemporalTrace(trace, evidence);
  assert(graph.gaps.some(({ reason }) => reason === "unprovenInitialOrder"));
  const evaluation = { kind: "assignment-evaluated", ordinal: 4, tick: "0", value: "1", operandValues: { seed: "1" } };
  const commit = { kind: "assignment-committed", ordinal: 8, tick: "0", value: "1",
    writeKind: "nonblocking", timing: "simulator-commit", evaluationOrdinal: 4 };
  const callback = { kind: "signal-value-changed", ordinal: 7, tick: "0", value: "1" };
  const recording = {
    start: "0", waveformMatch: "verified",
    events: [evaluation, callback, commit],
    coverage: { status: "complete", declared: { start: "0" } },
  };
  const links = [{ ordinal: 4, assignment: 0 }, { ordinal: 8, assignment: 0 }];
  const compare = (data, mappings = links) =>
    correlateExecutionTransitions(0, evidence, graph, data, mappings)[0];
  const comparison = compare(recording);
  assert.equal(comparison.status, "initialSampleMatched");
  assert.deepEqual(comparison.links, [{ node: 0, ordinal: 8, assignment: 0 }]);
  assert.equal(compare(recording, links.slice(1)).status, "incomplete");
  for (const replacement of [
    { ...recording, waveformMatch: "unverified" },
    { ...recording, events: [evaluation, { ...callback, value: "0" }, commit] },
    { ...recording, events: [evaluation, callback, commit, { ...commit, ordinal: 9 }] },
    { ...recording, events: [evaluation, callback, { ...commit, timing: "read-only" }] },
    { ...recording, events: [evaluation, callback, commit, { ...commit, kind: "assignment-unobserved", ordinal: 9 }] },
  ]) assert.equal(compare(replacement).status, "incomplete");

  const seedEvents = [
    { ...evaluation, ordinal: 1 },
    { ...commit, ordinal: 3, writeKind: "blocking", evaluationOrdinal: 1 },
  ];
  const seedLinks = [{ ordinal: 1, assignment: 1 }, { ordinal: 3, assignment: 1 }];
  const resolve = recordedOperandHistory({ ...recording, events: seedEvents }, seedLinks);
  assert.equal(resolve("0", 4, "1")[0].writer.commitOrdinal, 3);
  assert.equal(resolve("0", 0, "0"), undefined);
  const repeated = recordedOperandHistory({
    ...recording, events: [...seedEvents, { ...seedEvents[1], ordinal: 6 }],
  }, seedLinks);
  assert.equal(repeated("0", 4, "1"), undefined);
  const attributed = buildTemporalTrace(
    trace, evidence, recordedWriters(graph, [comparison], recording.events), false,
    (_signal, tick, ordinal, value) => resolve(tick, ordinal, value),
  );
  assert.equal(attributed.nodes[0].recordedWriter.commitOrdinal, 8);
  assert.equal(attributed.nodes[1].recordedWriter.commitOrdinal, 3);
  assert.equal(attributed.nodes[1].executionOnly, true);
  assert.equal(attributed.edges[0].rhsSampleEvidence, "recordedEvaluation");
  assert.deepEqual(attributed.gaps, []);
});

test("startup bit replay distinguishes the changing blocking commit from later same-value writes", () => {
  const observation = {
    signal: 0, status: "observed", projected: true, bit: 1, range: [3, 0], width: 1,
    value: "0", history: [{ tick: "0", value: "0" }],
  };
  const evidence = { tick: "0", historyStart: "0", observations: [observation] };
  const graph = { nodes: [{ signal: 0, bit: 1, tick: "0", value: "0", initialSample: true }] };
  const callback = (ordinal, value) => ({ tick: "0", kind: "signal-value-changed", ordinal, value });
  const evaluation = { tick: "0", ordinal: 3, kind: "assignment-evaluated", value: "00" };
  const commit = {
    tick: "0", kind: "assignment-committed", writeKind: "blocking", ordinal: 4,
    evaluationOrdinal: 3, targetRange: [2, 1], value: "00",
  };
  const sameValue = { ...commit, ordinal: 6, evaluationOrdinal: 5 };
  const base = {
    start: "0", waveformMatch: "verified",
    coverage: { status: "complete", declared: { start: "0" } },
    observationCoverage: { start: "0", gaps: [] },
    events: [callback(2, "0xx0"), evaluation, commit,
      { ...evaluation, ordinal: 5 }, sameValue, callback(7, "0000")],
  };
  const links = [3, 4, 5, 6].map(ordinal => ({ ordinal, assignment: 2 }));
  const compare = (overrides) =>
    correlateExecutionTransitions(0, evidence, graph, { ...base, ...overrides }, links, { bit: 1 })[0];
  assert.deepEqual(compare().links, [{ node: 0, ordinal: 4, assignment: 2 }]);
  for (const overrides of [
    { observationCoverage: { start: "0", gaps: ["truncated"] } },
    { events: [callback(2, "0xx0"), evaluation, commit, { ...sameValue, value: "01" }, callback(7, "0000")] },
    { events: [callback(2, "0xx0"), evaluation, commit, sameValue] },
    { events: [...base.events, { ...sameValue, ordinal: 8, kind: "assignment-unobserved" }] },
  ]) assert.equal(compare(overrides).links, undefined);

  const packedSample = { ...observation, projected: false, bit: undefined, width: 4,
    value: "0000", history: [{ tick: "0", value: "0000" }] };
  const packedGraph = { nodes: [{ signal: 0, tick: "0", value: "0000", initialSample: true }] };
  const packed = (recording) => correlateExecutionTransitions(
    0, { ...evidence, observations: [packedSample] }, packedGraph, recording, links,
  );
  const comparisons = packed(base);
  assert.equal(comparisons[0].status, "initialPackedSampleMatched");
  const [attribution] = recordedWriters(packedGraph, comparisons, base.events).values();
  assert.deepEqual(attribution.wordWriters.map(({ commitOrdinal, contributingRanges }) =>
    [commitOrdinal, contributingRanges]), [[4, [[2, 1]]]]);
  assert.deepEqual(attribution.unresolved, [[3, 3], [0, 0]]);
  assert.equal(packed({ ...base, waveformMatch: "unverified" })[0].startupPacked, undefined);
});

test("wait cause uses a unique transition or verified callback order", () => {
  const location = { uri: "file:///trace.sv", range: {
    start: { line: 3, character: 4 }, end: { line: 3, character: 10 },
  } };
  const expression = { op: "and", args: [
    { op: "signal", args: 1 }, { op: "signal", args: 2 },
  ] };
  const trace = {
    root: 0,
    signals: ["q", "a", "b"].map((name, id) => ({ id, name, instance: "tb" })),
    assignments: [{
      kind: "nonblocking", location, targets: [0], instance: "tb",
      inputs: [1, 2].map(signal => ({ signal, location, kind: "control" })),
      waitEntries: [location],
      waitPredicates: [{ location, expression }],
    }],
  };
  const sample = (tick, value) => ({ tick, value });
  const observation = (signal, initial, history) => ({
    signal, width: 1, initial: sample("0", initial), history,
  });
  const graph = (first, second, recordedValueCallbacks, resume = "5", nextOrdinal) => {
    const evidence = { tick: "7", historyStart: "0", recordedValueCallbacks, observations: [
      observation(0, "0", [sample("7", "1")]), first, second,
    ] };
    const root = buildTemporalTrace(trace, evidence).nodes[0];
    const writers = new Map([[temporalTransitionKey(root), {
      assignment: 0, commitOrdinal: 9,
      evaluation: { ordinal: 8, value: "1", tick: "7",
        guardEntryValues: { p4_5_a: "1", p4_5_b: "1" },
        guardEntryTicks: { p4_5_a: resume, p4_5_b: resume },
        ...(nextOrdinal === undefined ? {} : {
          guardEntryNextOrdinals: { p4_5_a: nextOrdinal, p4_5_b: nextOrdinal },
        }),
      },
    }]]);
    const result = buildTemporalTrace(trace, evidence, writers);
    return result.edges.filter(edge => edge.waitResumeCause).map(edge => result.nodes[edge.source].signal);
  };
  const rise = id => observation(id, "0", [sample("5", "1")]);
  assert.deepEqual(graph(rise(1), observation(2, "1", [])), [1]);
  assert.deepEqual(graph(observation(1, "x", [sample("5", "1")]), observation(2, "1", [])), [1]);
  assert.deepEqual(graph(rise(1), rise(2)), []);
  const callbacks = (signal) => [{ ordinal: signal + 2, value: "1" }];
  assert.deepEqual(graph(rise(1), rise(2), callbacks), [2]);
  const oscillations = ["1", "0", "1"];
  const repeated = observation(1, "0", oscillations.map(value => sample("5", value)));
  const changes = (id, ordinals) => id === 1
    ? oscillations.map((value, index) => ({ ordinal: ordinals[index], value }))
    : [{ ordinal: 4, value: "1" }];
  assert.deepEqual(graph(repeated, rise(2), id => changes(id, [2, 3, 5])), [1]);
  assert.deepEqual(graph(repeated, rise(2), id => changes(id, [3, 2, 5])), []);
  assert.deepEqual(graph(repeated, rise(2), id => changes(id, [2, 5, 6])), []);
  assert.deepEqual(graph(repeated, rise(2), id => changes(id, [2, 5, 6]), "5", 5), [2]);
  assert.deepEqual(graph(repeated, rise(2), id => changes(id, [2, 5, 6]), "5", 6), []);
  assert.deepEqual(graph(rise(1), rise(2), signal => signal === 1 ? callbacks(signal) : undefined), []);
  assert.deepEqual(graph(rise(1), rise(2), signal => [{ ordinal: signal, value: "0" }]), []);
  assert.deepEqual(graph(rise(1), rise(2), () => [{ ordinal: 3, value: "1" }]), []);
  const atEvaluation = id => observation(id, "0", [sample("7", "1")]);
  assert.deepEqual(graph(atEvaluation(1), atEvaluation(2),
    signal => [{ ordinal: signal + 6, value: "1" }], "7"), []);
  assert.deepEqual(graph(observation(1, "1", []), observation(2, "1", [])), []);
  assert.deepEqual(graph(rise(1), { ...observation(2, "1", []), historyTruncated: true }), []);
});

test("recorded writes select one assignment and trace its inputs at evaluation time", () => {
  const location = { uri: "file:///trace.sv", range: { start: { line: 4, character: 0 } } };
  const trace = {
    root: 0,
    assignments: [1, 2].map(signal => ({ kind: "nonblocking", location, targets: [0], inputs: [{ signal, kind: "data" }] })),
  };
  const observation = (signal, history) => ({ signal, width: 1, initial: { tick: "0", value: "0" }, history });
  const evidence = { tick: "7", observations: [
    observation(0, [{ tick: "7", value: "1" }]),
    observation(1, [{ tick: "2", value: "1" }, { tick: "6", value: "0" }]),
    observation(2, [{ tick: "2", value: "1" }]),
  ] };
  const temporal = buildTemporalTrace(trace, evidence);
  assert.deepEqual(temporal.edges.map(e => e.assignment), [0, 1]);
  const events = [
    { tick: "3", ordinal: 4, kind: "assignment-evaluated", value: "1" },
    { tick: "7", ordinal: 9, evaluationOrdinal: 4, kind: "assignment-committed", value: "1", writeKind: "nonblocking", timing: "simulator-commit" },
  ];
  const execution = { start: "0", waveformMatch: "verified", events, coverage: { status: "complete", declared: { start: "0" } } };
  const comparisons = correlateExecutionTransitions(0, evidence, temporal, execution, [{ ordinal: 9, assignment: 0 }]);
  const writes = reachedWriteEvents([
    { ...events[0], ordinal: 1, tick: "2" },
    events[0],
    { ...events[0], ordinal: 5, tick: "7", targetRange: [3, 2] },
    { ...events[0], ordinal: 6, tick: "7", targetRange: [1, 1] },
    { ...events[1], ordinal: 8, targetRange: [3, 2], evaluationOrdinal: 5 },
    { ...events[1], targetRange: [1, 0] },
  ], comparisons, 1);
  assert.deepEqual(writes.map(({ ordinal }) => ordinal), [4, 6, 9]);
  const annotated = buildTemporalTrace(trace, evidence, recordedWriters(temporal, comparisons, events));
  assert.deepEqual(annotated.nodes[0].recordedWriter, { assignment: 0, commitOrdinal: 9, evaluation: { ordinal: 4, tick: "3", value: "1" } });
  assert.deepEqual(annotated.edges.map(e => [e.assignment, annotated.nodes[e.source].signal, annotated.nodes[e.source].tick]), [[0, 1, "2"]]);

  const copy = { ...trace, assignments: [
    { ...trace.assignments[0], value: { op: "signal", args: 1 } },
  ] };
  const concurrent = { ...evidence, observations: [
    evidence.observations[0],
    observation(1, [{ tick: "2", value: "1" }, { tick: "7", value: "0" }]),
  ] };
  const possible = buildTemporalTrace(copy, concurrent);
  assert.deepEqual(possible.edges.map(({ source }) => possible.nodes[source].tick), ["7", "2"]);
  const sameTick = events.map(event => ({ ...event, tick: "7" }));
  const narrowed = buildTemporalTrace(
    copy, concurrent, recordedWriters(possible, comparisons, sameTick),
  );
  assert.deepEqual(narrowed.edges.map(({ source, rhsSampleEvidence }) =>
    [narrowed.nodes[source].tick, rhsSampleEvidence]), [["2", "recordedEvaluation"]]);
  const heldTrace = { ...copy, signals: [{ id: 1, name: "d" }] };
  const heldEvidence = { ...evidence, observations: [
    evidence.observations[0], observation(1, [{ tick: "2", value: "1" }]),
  ] };
  const heldWriters = recordedWriters(possible, comparisons, sameTick.map((event) =>
    event.kind === "assignment-evaluated" ? { ...event, operandValues: { d: "1" } } : event));
  const source = { assignment: 1, commitOrdinal: 3 };
  heldTrace.assignments.push({ ...heldTrace.assignments[0], targets: [1], inputs: [] });
  const recover = (tick) => () => [{ tick, value: "1", writer: source }];
  const held = buildTemporalTrace(heldTrace, heldEvidence, heldWriters, false, recover("5"));
  const [heldEdge] = held.edges;
  assert.equal(heldEdge.sourceWriteEvidence, "recordedSameValueWrite");
  assert.equal(held.nodes[heldEdge.source].tick, "5");
  assert.equal(held.nodes[heldEdge.source].recordedWriter.commitOrdinal, 3);
  assert.equal(held.nodes[heldEdge.source].executionOnly, true);
  const matched = buildTemporalTrace(heldTrace, heldEvidence, heldWriters, false, recover("2"));
  assert.equal(matched.nodes[matched.edges[0].source].recordedWriter, undefined);
  const sameSlot = buildTemporalTrace(heldTrace, concurrent, heldWriters, false, recover("5"));
  assert(!sameSlot.edges.some(({ sourceWriteEvidence }) => sourceWriteEvidence));
  const unknown = sameTick.map(event => event.kind === "assignment-evaluated"
    ? { ...event, value: "x" } : event);
  assert.equal(buildTemporalTrace(
    copy, concurrent, recordedWriters(possible, comparisons, unknown),
  ).edges.length, possible.edges.length);

  const sameTickInputs = { ...concurrent, observations: [
    ...concurrent.observations,
    observation(2, [{ tick: "3", value: "1" }, { tick: "7", value: "0" }]),
  ] };
  for (const [operator, combinations, expectedTicks] of [
    ["bitAnd", ["11"], ["2", "3"]],
    ["bitOr", ["01", "10", "11"], ["2", "3", "7", "7"]],
  ]) {
    const binary = { ...copy, assignments: [{
      ...copy.assignments[0],
      inputs: [1, 2].map(signal => ({ signal, kind: "data" })),
      value: { op: "binary", args: [operator, { op: "signal", args: 1 }, { op: "signal", args: 2 }] },
    }] };
    const writers = recordedWriters(possible, comparisons, sameTick);
    const graph = buildTemporalTrace(binary, sameTickInputs, writers);
    assert.deepEqual(graph.nodes[0].recordedRhsCombinations.map(samples =>
      samples.map(({ bits }) => bits).join("")).sort(), combinations);
    assert.deepEqual(graph.edges.map(({ source }) => graph.nodes[source].tick).sort(), expectedTicks);
    const named = { ...binary, signals: [{ id: 1, name: "left" }, { id: 2, name: "right" }] };
    const captured = sameTick.map((event) => event.kind === "assignment-evaluated"
      ? { ...event, operandValues: { left: "1", right: "1" } } : event);
    const capturedGraph = buildTemporalTrace(
      named, sameTickInputs, recordedWriters(possible, comparisons, captured),
    );
    assert.deepEqual(capturedGraph.nodes[0].recordedWriter.evaluation.operandValues,
      { left: "1", right: "1" });
    assert.deepEqual(capturedGraph.nodes[0].recordedRhsCombinations, [[
      { signal: 1, bits: "1" }, { signal: 2, bits: "1" },
    ]]);
    assert.deepEqual(capturedGraph.edges.map(({ source }) => capturedGraph.nodes[source].tick).sort(),
      ["2", "3"]);
    const missing = { ...sameTickInputs, observations: sameTickInputs.observations.slice(0, 2) };
    const partial = buildTemporalTrace(binary, missing, writers);
    assert.equal(partial.nodes[0].recordedRhsCombinations, undefined);
    assert.deepEqual(partial.edges.map(({ source }) => partial.nodes[source].tick), ["7", "2"]);
    const capturedPartial = buildTemporalTrace(
      named, missing, recordedWriters(possible, comparisons, captured),
    );
    const right = capturedPartial.nodes.find(({ signal }) => signal === 2);
    assert.deepEqual(right, {
      signal: 2, tick: "7", value: "1", sampleOnly: true, operandEvaluationOrdinal: 4,
    });
    assert(capturedPartial.edges.some(({ source, rhsSampleEvidence }) =>
      capturedPartial.nodes[source] === right && rhsSampleEvidence === "recordedEvaluation"));
    assert(capturedPartial.gaps.some(({ signal, reason }) => signal === 2 && reason === "unmapped"));
    assert.deepEqual(capturedPartial.edges.flatMap(({ source }) =>
      capturedPartial.nodes[source].signal === 1 ? [capturedPartial.nodes[source].tick] : []), ["2"]);
    const unobservedValue = { ...missing, observations: [
      ...missing.observations,
      observation(2, [{ tick: "3", value: "x" }, { tick: "7", value: "0" }]),
    ] };
    const unmatched = buildTemporalTrace(
      named, unobservedValue, recordedWriters(possible, comparisons, captured),
    );
    assert.deepEqual(unmatched.nodes.find(({ signal }) => signal === 2), right);
    assert(unmatched.gaps.some(({ signal, reason }) =>
      signal === 2 && reason === "noMatchingOperandChange"));
  }

  assert.equal([...recordedWriters(temporal, comparisons, events.slice(1)).values()][0].evaluation, undefined);
  assert.equal(recordedWriters(temporal, correlateExecutionTransitions(0, evidence, temporal, { ...execution, truncated: true }, [{ ordinal: 9, assignment: 0 }]), events).size, 0);

  const feedback = {
    ...trace,
    assignments: [
      { ...trace.assignments[0], inputs: [{ signal: 0, kind: "data" }, ...trace.assignments[0].inputs] },
      trace.assignments[1],
    ],
  };
  const history = { ...evidence, observations: [
    observation(0, [{ tick: "2", value: "1" }, { tick: "5", value: "0" }, { tick: "7", value: "1" }]),
    ...evidence.observations.slice(1),
  ] };
  const logged = [["2", "1"], ["5", "0"], ["7", "1"]].map(([tick, value], ordinal) => ({ ...events[1], tick, value, ordinal, evaluationOrdinal: undefined }));
  const waveformGraph = buildTemporalTrace(feedback, history);
  const matches = correlateExecutionTransitions(0, history, waveformGraph, { ...execution, events: logged }, [{ ordinal: 0, assignment: 1 }, { ordinal: 1, assignment: 0 }, { ordinal: 2, assignment: 0 }]);
  const graph = buildTemporalTrace(feedback, history, recordedWriters(waveformGraph, matches, logged));
  assert.deepEqual(graph.nodes.filter(point => point.signal === 0 && point.recordedWriter).map(point => [point.tick, point.recordedWriter.assignment]), [["7", 0], ["5", 0], ["2", 1]]);

  const bus = { signal: 3, width: 4, range: [0, 3], initial: { tick: "0", value: "0000" }, history: [{ tick: "5", value: "0100" }] };
  const bitGraph = { nodes: [{ signal: 3, bit: 1, tick: "5", value: "1" }] };
  const bitEvents = [{ ...events[1], tick: "5", value: "0100" }];
  const [bitMatch] = correlateExecutionTransitions(3, { tick: "7", observations: [bus] }, bitGraph, { ...execution, events: bitEvents }, [{ ordinal: 9, assignment: 0 }], { compareCursor: false, bit: 1 });
  assert.equal(bitMatch.status, "matched");
  assert.deepEqual(bitMatch.links, [{ node: 0, ordinal: 9, assignment: 0 }]);
});

test("reads actual Verilator execution in simulator order and verifies the waveform", {
  skip: !directory,
}, async (t) => {
  const log = path.join(directory, "execution.jsonl");
  const waveform = path.join(directory, "trace.fst");
  const instance = "TOP.trace_tb.dut";
  const read = (start, end) => readExecutionEvidence(log, waveform, "1ps", instance, "owner_q", start, end);
  const evidence = await read("1", "8");
  assert.equal(evidence.waveformMatch, "verified");
  assert.ok(evidence.events.some(({ kind }) => kind === "branch-taken"));
  const sameValueCommit = evidence.events.find(({ tick, kind }) =>
    tick === "3" && kind === "assignment-committed",
  );
  assert.equal(sameValueCommit.value, "0");
  const evaluation = evidence.events.find(({ ordinal }) => ordinal === sameValueCommit.evaluationOrdinal);
  assert.equal(evaluation.kind, "assignment-evaluated");
  assert.equal(evaluation.statementId, sameValueCommit.statementId);
  assert.match(await fs.readFile(sameValueCommit.source.file, "utf8"), /wave-trace: owner.accept/);
  assert.deepEqual((await read("5", "5")).events.map(({ kind }) => kind), ["process-trigger"]);
  if (evidence.cursor) {
    assert.equal(evidence.cursor.status, "committed");
    const hold = await read("5", "5");
    assert.equal(hold.cursor.status, "held");
    assert.equal(hold.cursor.latestCommit.tick, "3");
    assert.deepEqual(hold.cursor.triggeredWriters, ["owner"]);
    assert.match(executionReport(hold), /held through tick 5/);
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "wave-execution-incomplete-"));
    t.after(() => fs.rm(temporary, { recursive: true, force: true }));
    const incomplete = path.join(temporary, "recording.jsonl");
    const lines = (await fs.readFile(log, "utf8")).trimEnd().split("\n");
    assert.equal(JSON.parse(lines.at(-1)).type, "end");
    await fs.writeFile(incomplete, lines.slice(0, -1).join("\n") + "\n");
    const partial = await readExecutionEvidence(incomplete, waveform, "1ps", instance, "owner_q", "1", "8");
    assert.equal(partial.cursor, undefined);
  }
  assert.match(executionReport(evidence), /assignment-committed/);
  await assert.rejects(readExecutionEvidence(log, log, "1ps", instance, "owner_q", "1", "8"),
    /waveform hash mismatch/);
});

test("execution coverage independently validates log gaps, pending writes and response limits", async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "wave-execution-coverage-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const waveform = path.join(temp, "trace.fst");
  const log = path.join(temp, "execution.jsonl");
  const source = path.join(temp, "tb.sv");
  const sourceCode = "module tb; endmodule\n";
  await fs.writeFile(waveform, "fixture");
  await fs.writeFile(source, sourceCode);
  const header = {
    format: "wave-workbench-execution", schemaVersion: 1, scale: "1ps", buildId: "test",
    waveformSha256: createHash("sha256").update("fixture").digest("hex"),
    statements: { write: {
      file: "tb.sv", line: 1, column: 1,
      sha256: createHash("sha256").update(sourceCode).digest("hex"),
    } },
    coverage: [{ start: "1", instance: "top.first", signal: "q", writers: ["writer"] }],
  };
  const event = {
    tick: "1", instance: "top.first", signal: "q", processId: "writer", value: "1",
    writeKind: "nonblocking", statementId: "write",
  };
  const evaluation = { ...event, kind: "assignment-evaluated", ordinal: 0 };
  const commit = { ...event, kind: "assignment-committed", ordinal: 1, evaluationOrdinal: 0 };
  const end = { type: "end", tick: "1", eventCount: 2 };
  async function replay(records, limit) {
    await fs.writeFile(log, [header, ...records].map(JSON.stringify).join("\n") + "\n");
    return readExecutionEvidence(log, waveform, "1ps", "top.first", "q", "1", "1", limit);
  }
  const bounded = await replay([evaluation, commit, end], 1);
  assert.equal(bounded.truncated, true);
  assert.equal(bounded.coverage.status, "complete");
  assert.equal(bounded.cursor.latestCommit.ordinal, 1);
  assert.equal(bounded.cursor.latestCommit.source.identity, "matched");
  const declaration = { uri: pathToFileURL(source).href, range: { start: { line: 0, character: 0 } } };
  const assignment = { targets: [0], location: declaration, kind: "nonblocking" };
  const trace = { root: 0, assignments: [assignment] };
  assert.deepEqual(linkExecutionAssignments(trace, bounded).map(({ ordinal, assignment }) => [ordinal, assignment]), [[0, 0], [1, 0]]);
  assert.deepEqual(linkExecutionAssignments({ ...trace, assignments: [assignment, assignment] }, bounded), []);
  const standalone = await readExecutionEvidence(log, undefined, undefined, "top.first", "q", "1", "1");
  assert.equal(standalone.waveformMatch, "unverified");
  assert.equal(standalone.scale, "1ps");
  assert.equal(standalone.coverage.status, "complete");
  assert.match(executionReport(standalone), /Recording-only playback/);
  await assert.rejects(
    readExecutionEvidence(log, waveform, "10ps", "top.first", "q", "1", "1"),
    /different waveform time unit/,
  );
  for (const schemaVersion of [undefined, 0, 2, "1"]) {
    await fs.writeFile(log, [{ ...header, schemaVersion }, evaluation, commit, end]
      .map(JSON.stringify).join("\n") + "\n");
    await assert.rejects(
      readExecutionEvidence(log, waveform, "1ps", "top.first", "q", "1", "1"),
      /Unsupported execution trace header/,
    );
  }
  await fs.writeFile(source, "module updated_tb; endmodule\n");
  const stale = await replay([evaluation, commit, end]);
  assert.equal(stale.cursor.latestCommit.source.identity, "changed");
  assert.deepEqual(linkExecutionAssignments(trace, stale), []);
  assert.match(executionReport(stale), /Source changed/);
  const pending = await replay([evaluation, commit, { ...evaluation, ordinal: 2 }, { ...end, eventCount: 3 }]);
  assert.deepEqual(pending.coverage.gaps, ["pendingEvaluation"]);
  assert.equal(pending.cursor, undefined);
  const lost = await replay([commit, end]);
  assert.deepEqual(lost.coverage.gaps, ["missingEventOrdinals"]);
  assert.equal(lost.cursor, undefined);
  const unexpected = await replay([{ ...evaluation, processId: "other" }, { ...commit, processId: "other" }, end]);
  assert.deepEqual(unexpected.coverage.unexpectedWriters, ["other"]);
  assert.equal(unexpected.cursor, undefined);
  await assert.rejects(replay([evaluation, { ...commit, value: "0" }, end]), /does not match/);

  const skipped = Array.from({ length: 3000 }, (_, index) => ({
    instance: "top.另一个", processId: "observer", kind: "process-trigger",
    tick: String(index + 2), ordinal: index + 2,
  }));
  const cursorEvent = { instance: "top.first", processId: "writer", kind: "process-trigger", tick: "3002", ordinal: 3002 };
  const longRecording = [header, evaluation, commit, ...skipped, cursorEvent,
    { type: "end", tick: "3002", eventCount: 3003 }].map(JSON.stringify).join("\r\n") + "\r\n";
  await fs.writeFile(log, longRecording);
  const readLatest = () => readExecutionEvidence(log, waveform, "1ps", "top.first", "q", "3002", "3002");
  await assert.rejects(readExecutionEvidence(log, waveform, "1ps", "top.first", "q", "3002", "3002", undefined, AbortSignal.abort()), { name: "AbortError" });
  const cold = await readLatest();
  assert.equal(cold.scannedAfterOrdinal, undefined);
  assert.equal(cold.cursor.status, "held");
  const warm = await readLatest();
  assert(warm.scannedAfterOrdinal > 2000);
  assert.deepEqual(warm.events, cold.events);
  assert.deepEqual(warm.cursor, cold.cursor);
  const diskCache = path.join(temp, "replay-index");
  const replayInNewProcess = (wave = waveform) => JSON.parse(execFileSync(process.execPath, [
    "-e", `const {readExecutionEvidence} = require(process.argv[1]);
    readExecutionEvidence(process.argv[2], process.argv[3], "1ps", "top.first", "q", "3002", "3002")
      .then(result => console.log(JSON.stringify(result)))
      .catch(error => console.log(JSON.stringify({error: error.message})));`,
    require.resolve("../dist/rtl-execution"), log, wave,
  ], { env: { ...process.env, WAVE_WORKBENCH_REPLAY_CACHE_DIR: diskCache }, encoding: "utf8" }));
  const coldProcess = replayInNewProcess();
  assert.equal(coldProcess.scannedAfterOrdinal, undefined);
  const warmProcess = replayInNewProcess();
  assert(warmProcess.scannedAfterOrdinal > 2000);
  assert.deepEqual({ ...warmProcess, scannedAfterOrdinal: undefined },
    { ...coldProcess, scannedAfterOrdinal: undefined });
  assert.equal(warmProcess.cursor.latestCommit.source.identity, "changed");
  await fs.writeFile(source, sourceCode);
  const restoredSource = replayInNewProcess();
  assert.equal(restoredSource.scannedAfterOrdinal, warmProcess.scannedAfterOrdinal);
  assert.equal(restoredSource.cursor.latestCommit.source.identity, "matched");
  const differentWave = path.join(temp, "different.vcd");
  await fs.writeFile(differentWave, "different waveform");
  assert.match(replayInNewProcess(differentWave).error, /waveform hash mismatch/);
  const [slot] = await fs.readdir(diskCache);
  assert(slot.endsWith(".json"));
  await fs.appendFile(path.join(diskCache, slot), "corrupted");
  assert.equal(replayInNewProcess().scannedAfterOrdinal, undefined);
  assert(replayInNewProcess().scannedAfterOrdinal > 2000);
  await fs.writeFile(log, longRecording.replace('"eventCount":3003', '"eventCount":3004'));
  const edited = await readLatest();
  assert.equal(edited.scannedAfterOrdinal, undefined);
  assert.deepEqual(edited.coverage.gaps, ["missingEventOrdinals"]);
  const editedInNewProcess = replayInNewProcess();
  assert.equal(editedInNewProcess.scannedAfterOrdinal, undefined);
  assert.deepEqual(editedInNewProcess.coverage.gaps, edited.coverage.gaps);
});

const orderDirectory = process.env.WAVE_TEST_EXECUTION_ORDER;
test("replays actual blocking writes, overwritten NBAs and final commits by Verilator instance", {
  skip: !orderDirectory,
}, async (t) => {
  const waveform = path.join(orderDirectory, "trace.fst");
  const backend = new Backend(path.resolve(__dirname, "../bin/wave-backend-independent"), {
    useVerdiLibraries: false,
  });
  t.after(() => backend.dispose());
  const metadata = await backend.request("open", { path: waveform });
  const design = await VerilatorDesign.open(
    path.join(orderDirectory, "Vexecution_order_tb.tree.json"), metadata.signals, [orderDirectory],
  );
  const firstMap = await design.executionStatements("TOP.execution_order_tb.first", "q");
  const secondMap = await design.executionStatements("TOP.execution_order_tb.second", "q");
  assert.deepEqual(firstMap, await design.executionStatements("TOP.execution_order_tb.first", "q"));
  assert.deepEqual(firstMap.map(({ kind }) => kind), ["blocking", "nonblocking", "nonblocking"]);
  assert.equal(new Set(firstMap.map(({ processId }) => processId)).size, 1);
  assert.equal(new Set(firstMap.map(({ statementId }) => statementId)).size, 3);
  assert.notEqual(firstMap[0].processId, secondMap[0].processId);
  assert.notEqual(firstMap[0].statementId, secondMap[0].statementId);
  assert.deepEqual(firstMap.map(({ source }) => source), secondMap.map(({ source }) => source));
  const generated = await fs.mkdtemp(path.join(os.tmpdir(), "trace-probe-test-"));
  t.after(() => fs.rm(generated, { recursive: true, force: true }));
  const maps = path.join(generated, "maps.json");
  const originals = await fs.readFile(firstMap[0].source.file);
  await fs.writeFile(maps, JSON.stringify([{ schemaVersion: 1, instance: "TOP.execution_order_tb.first", signal: "q", statements: firstMap }]));
  execFileSync(process.execPath, [
    path.resolve(__dirname, "../scripts/verilator-execution.mjs"),
    "generate", maps, path.join(generated, "overlay"),
  ]);
  const overlay = await fs.readFile(path.join(generated, "overlay", path.basename(firstMap[0].source.file)), "utf8");
  assert.match(overlay, /automatic type\(q\) wave_probe_/);
  assert.match(overlay, /wave_workbench_probe::wave_workbench_write/);
  assert.match(overlay, /wave_workbench_probe::wave_workbench_process/);
  assert.deepEqual(await fs.readFile(firstMap[0].source.file), originals);
  const instance = "TOP.execution_order_tb.first";
  const { processId, statementId } = firstMap[0];
  const raw = path.join(generated, "raw.jsonl");
  const coverageFile = path.join(generated, "coverage.json");
  const sealed = path.join(generated, "sealed.jsonl");
  const generatedEvent = { instance, processId, statementId, signal: "q", tick: "1", value: "0", writeKind: "blocking" };
  await fs.writeFile(raw, [
    { ...generatedEvent, kind: "assignment-evaluated", ordinal: 0 },
    { ...generatedEvent, kind: "assignment-committed", ordinal: 1, evaluationOrdinal: 0 },
    { type: "end", tick: "3", eventCount: 2 },
  ].map(event => JSON.stringify(event)).join("\n") + "\n");
  const seal = () => execFileSync(process.execPath, [
    path.resolve(__dirname, "../scripts/verilator-execution.mjs"), "seal",
    path.join(generated, "overlay", "execution-probes.json"), waveform, "1ps", raw, sealed, coverageFile,
  ], { stdio: "pipe" });
  await fs.writeFile(coverageFile, JSON.stringify([{ instance, signal: "q", start: "0", writers: ["unknown"] }]));
  assert.throws(seal, /Coverage must list the generated write processes/);
  await fs.writeFile(coverageFile, JSON.stringify([{ instance, signal: "q", start: "0", writers: [processId] }]));
  seal();
  const generatedReplay = await readExecutionEvidence(sealed, waveform, "1ps", instance, "q", "1", "3");
  assert.equal(generatedReplay.coverage.status, "complete");
  assert.equal(generatedReplay.cursor.latestCommit.statementId, statementId);
  assert.equal(generatedReplay.cursor.status, "held");
  const read = (instance, start, end) => readExecutionEvidence(
    path.join(orderDirectory, "execution.jsonl"), waveform,
    "1ps", "TOP.execution_order_tb." + instance, "q", start, end,
  );
  for (const [instance, values] of [["first", ["1", "0"]], ["second", ["0", "1"]]]) {
    const signal = metadata.signals.find(({ scope, name }) =>
      scope === "TOP.execution_order_tb." + instance && name === "q",
    );
    assert.ok(signal);
    const observed = await backend.request("query", {
      signals: [signal.id], start: "3", end: "3", limit: 8,
    });
    assert.equal(observed[signal.id].events.at(-1)[1], values[1]);
    assert.ok(!observed[signal.id].events.some(([tick]) => tick === "3"));
    const evidence = await read(instance, "3", "3");
    assert.equal(evidence.coverage.status, "complete");
    assert.deepEqual(evidence.events.map(({ kind }) => kind), [
      "process-trigger", "assignment-evaluated", "assignment-committed",
      "assignment-evaluated", "assignment-evaluated", "assignment-superseded",
      "assignment-committed",
    ]);
    const commits = evidence.events.filter(({ kind }) => kind === "assignment-committed");
    assert.deepEqual(commits.map(({ value }) => value), values);
    assert.deepEqual(commits.map(({ writeKind }) => writeKind), ["blocking", "nonblocking"]);
    assert.equal(commits[1].timing, "end-of-slot");
    assert.equal(evidence.cursor.latestCommit.ordinal, commits[1].ordinal);
    const replaced = evidence.events.find(({ kind }) => kind === "assignment-superseded");
    assert.equal(evidence.events.find(({ ordinal }) => ordinal === replaced.evaluationOrdinal).statementId, "write.replaced");
    assert.equal(evidence.events.find(({ ordinal }) => ordinal === replaced.replacementOrdinal).statementId, "write.final");
    assert.match(executionMermaid(evidence), /next commit/);
    assert.match(executionMermaid(evidence), /supersedes/);
    assert.match(executionReport(evidence), /assignment-superseded/);
    assert.equal((await read(instance, "5", "5")).cursor.status, "held");
  }
});
