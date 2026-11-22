// SPDX-License-Identifier: MPL-2.0

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { pathToFileURL } = require("node:url");
const { Backend } = require("../dist/backend");
const { VerilatorDesign } = require("../dist/verilator");
const { expandInstanceTrace } = require("../dist/rtl-trace-instances");
const { readTraceObservations } = require("../dist/rtl-trace-observations");
const {
  buildTemporalTrace,
  traceAssignmentCandidates,
  traceCursorWriters,
} = require("../dist/rtl-trace-candidates");
const { evaluateTraceValue } = require("../dist/rtl-trace-values");
const { packedDependencies } = require("../dist/rtl-trace-bits");
const { staticGraphSnapshot, temporalGraphSnapshot, traceGraphPage } = require("../dist/rtl-trace-graph-page");
const { selectTracePathNodes, traceGraphPaths, tracePathReport } = require("../dist/rtl-trace-path");
const { temporalFeedback } = require("../dist/rtl-trace-feedback");
const { staticTracePaths, staticPathReport } = require("../dist/rtl-static-path");
const { staticBitPaths, staticBitReport } = require("../dist/rtl-static-bit-path");
const {
  followStaticFrontier,
  mergeStaticContinuationGraph,
  mergedStaticMermaid,
  pageStaticContinuationGraph,
} = require("../dist/rtl-static-continuations");
const {
  followTemporalFrontier,
  mergeTemporalContinuationGraph,
  combinedTemporalMermaid,
  continuationReport,
  TraceContextChanged,
  staticTraceCoverage,
  observationReport,
  queryTrace,
  observationMermaidPages,
  temporalMermaid,
  temporalMermaidOutput,
  staticTracePage,
  traceFeedback,
  traceMermaid,
  traceMermaidPages,
  traceReport,
} = require("../dist/rtl-trace");

test("inside comparisons use the full case type and wildcard only label bits", () => {
  const literal = (bits, signed = false) => ({ op: "literal", args: [bits, signed] });
  const compare = (selector, labels, span = [0, 1], operand = () => undefined) =>
    evaluateTraceValue({ op: "membership", args: [selector, labels, span] },
      undefined, operand)?.bits;
  assert.equal(compare(literal("10z1"), [[literal("10x1")]]), "1");
  assert.equal(compare(literal("1x01"), [[literal("10x1")]]), "x");
  assert.equal(compare(literal("x001"), [[literal("0111")]]), "0");
  assert.equal(compare(literal("011"), [[literal("011"), literal("100")]]), "1");
  assert.equal(compare(literal("100"), [[literal("011"), literal("100")]]), "1");
  const range = [literal("1110", true), literal("0010", true)];
  assert.equal(compare(literal("0001", true), [range]), "1");
  assert.equal(compare(literal("0001", true), [range, [literal("11111111")]]), "0");
  const laterLabel = { op: "signal", args: 1 };
  assert.equal(compare(literal("0001", true), [range, [laterLabel]], [0, 1],
    () => ({ width: 8, signed: false })), "0");
  assert.equal(compare(literal("0001", true), [range, [laterLabel]]), undefined);
});

test("case guards use later declarations for type and share the correct four-state rules", () => {
  const literal = (bits, signed = false) => ({ op: "literal", args: [bits, signed] });
  const late = { op: "typeShape", args: [8, false] };
  const compare = (kind, selector, first, later = late) =>
    evaluateTraceValue({
      op: "caseMatch", args: [selector, [[first], [later]], [0, 1], kind],
    }, undefined, () => undefined)?.bits;
  assert.equal(compare("equal", literal("1111", true), literal("11111111", true)), "0");
  assert.equal(compare("equal", literal("1111", true), literal("11111111", true),
    { op: "typeShape", args: [8, true] }), "1");
  assert.equal(compare("equal", literal("1x01", true), literal("1x01", true)), "1");
  const label = literal("000010z1");
  assert.equal(compare("wildcardZ", literal("10z1"), label), "1");
  assert.equal(compare("wildcardZ", literal("1x01"), label), "0");
  assert.equal(compare("wildcardX", literal("1x01"), label), "1");
  assert.equal(compare("inside", literal("1x01"), label), "x");
});

test("automatic temporal continuations reuse shared targets and preserve unfinished work", async () => {
  const root = { signal: "tb.q", tick: "5" };
  const input = { signal: "tb.d", tick: "3" };
  const clock = { signal: "tb.clk", tick: "5" };
  const frontier = (...requests) => ({
    gaps: requests.map((continuation) => ({ continuation })),
  });
  const requests = [];
  const walk = await followTemporalFrontier(
    root,
    frontier(input, input),
    1,
    new AbortController().signal,
    new AbortController().signal,
    async (request) => {
      requests.push(request);
      return { context: { temporalTrace: frontier(root, clock) } };
    },
  );
  assert.deepEqual(requests, [input]);
  assert.deepEqual(walk.links, [
    { segment: 0, gap: 0, nextSegment: 1 },
    { segment: 0, gap: 1, nextSegment: 1 },
    { segment: 1, gap: 0, nextSegment: 0 },
    { segment: 1, gap: 1, nextSegment: 2 },
  ]);
  assert.deepEqual(walk.remaining, [clock]);
  assert.deepEqual(walk.stopReasons, ["requestBudget"]);

  const deadline = new AbortController();
  const interrupted = await followTemporalFrontier(
    root,
    frontier(input, clock),
    2,
    new AbortController().signal,
    deadline.signal,
    async (request, signal) => {
      if (request === input) throw Error("Snapshot unavailable");
      deadline.abort();
      signal.throwIfAborted();
    },
  );
  assert.deepEqual(interrupted.segments, [
    { request: input, error: "Snapshot unavailable" },
  ]);
  assert.deepEqual(interrupted.remaining, [clock]);
  assert.deepEqual(interrupted.stopReasons, ["timeBudget", "queryFailed"]);

  const cancellation = new AbortController();
  const cancelled = await followTemporalFrontier(
    root,
    frontier(input, clock),
    2,
    cancellation.signal,
    new AbortController().signal,
    async (request, signal) => {
      if (request === clock) cancellation.abort();
      signal.throwIfAborted();
      return { context: { temporalTrace: frontier() } };
    },
  );
  assert.deepEqual(cancelled.segments.map(({ request }) => request), [input]);
  assert.deepEqual(cancelled.remaining, [clock]);
  assert.deepEqual(cancelled.stopReasons, ["cancelled"]);

  let generation = 0;
  const invalidated = await followTemporalFrontier(
    root, frontier(input, clock), 2, new AbortController().signal, new AbortController().signal,
    async (request) => {
      if (request === clock) generation++;
      return { context: { temporalTrace: frontier() } };
    },
    { assertCurrent: async () => {
      if (generation) throw new TraceContextChanged("The reference changed.");
    } },
  );
  assert.deepEqual(invalidated.segments.map(({ request }) => request), [input]);
  assert.deepEqual(invalidated.remaining, [clock]);
  assert.deepEqual(invalidated.stopReasons, ["contextChanged"]);

  const child = { signal: "tb.upstream", tick: "1" };
  const staticBoundary = (...requests) => ({
    gaps: requests.map((continuation) => ({ continuation, reason: "staticBudget" })),
  });
  const deeper = await followTemporalFrontier(
    root, staticBoundary(input, clock), 2,
    new AbortController().signal, new AbortController().signal,
    async (request) => ({
      context: { temporalTrace: request === input ? staticBoundary(child) : staticBoundary() },
    }),
  );
  assert.deepEqual(deeper.segments.map(({ request }) => request), [input, child]);
  assert.deepEqual(deeper.remaining, [clock]);
  assert.deepEqual(deeper.links, [
    { segment: 0, gap: 0, nextSegment: 1 },
    { segment: 0, gap: 1, nextSegment: 3 },
    { segment: 1, gap: 0, nextSegment: 2 },
  ]);
  const nextBatch = await followTemporalFrontier(
    root, staticBoundary(input, clock), 1,
    new AbortController().signal, new AbortController().signal,
    async (request) => {
      assert.equal(request, clock);
      return { context: { temporalTrace: staticBoundary(child) } };
    },
    { previous: deeper.segments },
  );
  assert.equal(deeper.segments.length, 2);
  assert.deepEqual(nextBatch.segments.map(({ request }) => request), [input, child, clock]);
  assert.deepEqual(nextBatch.links, [
    ...deeper.links,
    { segment: 3, gap: 0, nextSegment: 2 },
  ]);
  assert.deepEqual(nextBatch.remaining, []);
  assert.deepEqual(nextBatch.stopReasons, []);
  const query = async (request) => ({
    context: {
      temporalTrace: request === input
        ? staticBoundary(child)
        : request === clock ? staticBoundary(child) : staticBoundary(),
    },
  });
  const boundary = staticBoundary(input, clock);
  const first = await followTemporalFrontier(
    root, boundary, 1, new AbortController().signal, new AbortController().signal, query,
  );
  const split = await followTemporalFrontier(
    root, boundary, 2, new AbortController().signal, new AbortController().signal, query,
    { previous: first.segments },
  );
  assert.deepEqual(split, nextBatch);
});

test("temporal continuations share an effective history query across batches", async () => {
  const root = { signal: "tb.q", tick: "20" };
  const direct = { signal: "tb.d", tick: "8" };
  const history = { ...direct, historyStart: "auto" };
  const ordered = { ...direct, changeOrder: 1 };
  const graph = { gaps: [history, direct, ordered].map(continuation => ({ continuation })) };
  const requests = [];
  const query = async request => {
    requests.push(request);
    return { context: {} };
  };
  const signal = new AbortController().signal;
  const first = await followTemporalFrontier(root, graph, 1, signal, signal, query, {
    defaultHistoryStart: "12",
  });
  assert.deepEqual(requests, [direct]);
  assert.deepEqual(first.remaining, [ordered]);
  assert.deepEqual(first.links, [
    { segment: 0, gap: 1, nextSegment: 1 },
    { segment: 0, gap: 2, nextSegment: 2 },
    { segment: 0, gap: 0, nextSegment: 1 },
  ]);
  const resumed = await followTemporalFrontier(root, graph, 1, signal, signal, query, {
    defaultHistoryStart: "12",
    previous: first.segments,
  });
  assert.deepEqual(requests, [direct, ordered]);
  assert.deepEqual(resumed.links, first.links);
  assert.deepEqual(resumed.remaining, []);

  const bounded = await followTemporalFrontier(root, graph, 0, signal, signal, query, {
    defaultHistoryStart: "4",
  });
  assert.deepEqual(bounded.remaining, [direct, ordered, history]);

  const selected = await followTemporalFrontier(root, graph, 2, signal, signal, query, {
    defaultHistoryStart: "4",
    selected: [ordered, history],
  });
  assert.deepEqual(selected.segments.map(({ request }) => request), [ordered, history]);
  assert.deepEqual(selected.remaining, [direct]);
  assert.deepEqual(selected.links.map(({ nextSegment }) => nextSegment), [3, 1, 2]);
  const afterSelection = await followTemporalFrontier(root, graph, 1, signal, signal, query, {
    defaultHistoryStart: "4",
    previous: selected.segments,
  });
  assert.deepEqual(afterSelection.segments.map(({ request }) => request), [ordered, history, direct]);
  assert.deepEqual(afterSelection.remaining, []);
});

test("static path export preserves declaration IDs, source operands, and trace direction", () => {
  const location = { uri: "file:///sample.sv", range: { start: { line: 5, character: 2 } } };
  const assignment = (id, read, target) => ({ id, kind: "continuous", location,
    targets: [target], targetRange: [3, 2],
    inputs: [{ signal: read, kind: "data", readBits: [1, 0], location }],
  });
  const graph = { root: 7, status: "partial", signals: [2, 5, 7, 10].map((id) => ({
    id, instance: "tb", name: "n" + id,
  })), assignments: [assignment(20, 2, 5), assignment(32, 5, 7), assignment(60, 10, 7)],
  feedbackEdges: [], gaps: [{ signal: 5, reason: "depth" }, { signal: 10, reason: "depth" }] };
  const drivers = staticTracePaths(graph, "drivers", [], [{ signal: "tb.n2" }], "shortest");
  assert.deepEqual(drivers.paths, [{ node: 2, status: "found", root: 7, hops: 2 }]);
  assert.deepEqual(drivers.graph.signals.map(({ id }) => id), [2, 5, 7]);
  assert.deepEqual(drivers.graph.assignments.map(({ id }) => id), [20, 32]);
  assert.deepEqual(drivers.graph.gaps, [graph.gaps[0]]);
  const report = staticPathReport(drivers, "drivers", []);
  assert.match(report, /Writes `tb.n7\[3:2\]`/);
  assert.match(report, /data · `tb.n5\[1, 0\]` · `file:\/\/\/sample.sv` L6:3/);
  assert.deepEqual(staticTracePaths({ ...graph, root: 2 }, "loads", [7], [], "all").paths,
    [{ node: 7, status: "found", root: 2, hops: 2 }]);
  assert.equal(staticTracePaths({ ...graph, root: 2 }, "drivers", [7], [], "all").paths[0].status, "unreachable");
});

test("static bit paths follow elaborated direct ports by packed position", () => {
  const location = { uri: "file:///port.sv", range: { start: { line: 0, character: 0 } } };
  const graph = { root: 1, bitSelection: { bit: 4 }, status: "partial", feedbackEdges: [], gaps: [],
    signals: [{ id: 0, name: "data", instance: "tb", packedRange: [7, 0] },
      { id: 1, name: "in", instance: "tb.dut", packedRange: [4, 7] }],
    assignments: [{ id: 2, kind: "port", location, targets: [1],
      inputs: [{ signal: 0, kind: "data" }], port: { fromRange: [6, 3] } }],
  };
  const find = (parent) => staticBitPaths(parent, "drivers", [
    { signal: "tb.data", bit: 6 }, { signal: "tb.data", bit: 3 },
  ], "all");
  const mapped = find(graph);
  assert.deepEqual(mapped.paths.map(({ status }) => status), ["found", "unreachable"]);
  assert.deepEqual(mapped.edges, [{ input: { signal: 0, bit: 6 }, output: { signal: 1, bit: 4 }, assignment: 2, fromPort: true }]);
  assert.match(staticBitReport(mapped, []), /elaborated port mapping/);
  for (const port of [{ fromRange: [5, 3] }, { fromRange: [6, 3], fromField: "data" },
    { fromRange: [6, 3], indexSignal: 0 }, { fromRange: [6, 3], conversion: { fromWidth: 3, toWidth: 4, twoState: false } }]) {
    assert.equal(find({ ...graph, assignments: [{ ...graph.assignments[0], port }] }).assignmentsWithoutBitMappings, 1);
  }

  const snapshot = (sourceRange, fromWidth, signed, rootBit, port = {}) => ({
    ...graph, bitSelection: { bit: rootBit },
    signals: [{ ...graph.signals[0], packedRange: sourceRange, signed }, graph.signals[1]],
    assignments: [{ ...graph.assignments[0], value: { op: "signal", args: 0 },
      port: { conversion: { fromWidth, toWidth: 4, twoState: false }, ...port } }],
  });
  for (const [signed, status, missing] of [
    [true, "found", 0], [false, "unreachable", 0], [undefined, "unreachable", 1],
  ]) {
    const result = staticBitPaths(snapshot([6, 5], 2, signed, 4), "drivers",
      [{ signal: "tb.data", bit: 6 }, { signal: "tb.data", bit: 5 }], "all");
    assert.deepEqual(result.paths.map(({ status }) => status), [status, "unreachable"]);
    assert.equal(result.assignmentsWithoutBitMappings, missing);
    assert.deepEqual(result.edges.map(({ input, output }) => [input.bit, output.bit]),
      signed ? [[6, 4]] : []);
    const low = find(snapshot([6, 3], 4, signed, 7));
    assert.equal(low.paths[1].status, "found");
  }
  const narrowed = snapshot([7, 2], 6, true, 4);
  assert.equal(find(narrowed).paths[0].status, "unreachable");
  const loaded = staticBitPaths({ ...narrowed, root: 0, bitSelection: { bit: 5 } },
    "loads", [{ signal: "tb.dut.in", bit: 4 }], "all");
  assert.equal(loaded.paths[0].status, "found");
  const twoState = find(snapshot([7, 0], 4, false, 4, {
    fromRange: [6, 3], conversion: { fromWidth: 4, toWidth: 4, twoState: true },
  }));
  assert.equal(twoState.paths[0].status, "found");
});

test("whole-bus static bit paths recover RTL expressions across merged segments", () => {
  const location = (line) => ({ uri: "file:///lanes.sv", range: { start: { line, character: 0 } } });
  const a = { id: 9, name: "a", instance: "tb", declaration: location(0), packedRange: [3, 0] };
  const mid = { id: 3, name: "mid", instance: "tb", declaration: location(1), packedRange: [5, 4] };
  const q = { id: 12, name: "q", instance: "tb", declaration: location(2), packedRange: [0, 1] };
  const assignment = (read, target, value, line) => ({
    kind: "continuous", location: location(line), targets: [target], value,
    inputs: [{ signal: read, kind: "data", edge: null, location: location(line) }],
  });
  const initial = { root: q.id, signals: [q, mid], frontier: [], diagnostics: [],
    assignments: [assignment(mid.id, q.id, { op: "signal", args: mid.id }, 4)],
  };
  const segment = (high) => {
    const trace = { root: 7, signals: [{ ...mid, id: 7 }, a], frontier: [], diagnostics: [],
      assignments: [assignment(a.id, 7, { op: "concat", args: [
        { op: "select", args: [a.id, high, high] }, { op: "select", args: [a.id, 2, 2] },
      ] }, 3)],
    };
    return { signal: "tb.mid", trace, coverage: staticTraceCoverage(trace) };
  };
  const find = (segments) => {
    const expressions = new Map();
    const graph = mergeStaticContinuationGraph(initial, {
      status: "resolvedWithinScope", segments, links: [],
    }, expressions);
    assert.equal(JSON.stringify(staticGraphSnapshot(graph)).includes('"op":"concat"'), false);
    return staticBitPaths(graph, "drivers", [
      { signal: "tb.a", bit: 3 }, { signal: "tb.a", bit: 0 },
    ], "all", undefined, expressions);
  };
  const result = find([segment(3), segment(3)]);
  assert.deepEqual(result.paths.map(({ status }) => status), ["found", "unreachable"]);
  assert.deepEqual(result.edges.map(({ input, output, fromExpression }) =>
    [input.bit, output.bit, fromExpression]), [[3, 5, true], [5, 0, true]]);
  assert.match(staticBitReport(result, []), /RTL expression/);
  const conflicting = find([segment(3), segment(0)]);
  assert.ok(conflicting.paths.every(({ status }) => status === "unreachable"));
  assert.equal(conflicting.assignmentsWithoutBitMappings, 1);
});

test("packed shifts use the assignment width and retain the arithmetic sign bit", () => {
  const readsAt = packedDependencies((id) => id === 1 ? [3, 0] : [4, 7],
    (id) => id === 1);
  const signal = (args) => ({ op: "signal", args });
  const literal = (bits) => ({ op: "literal", args: [bits, false] });
  const shift = (op, lhs, rhs) => ({ op: "binary", args: [op, lhs, rhs] });
  const reads = (value, slot, width = 8, selector) => {
    const result = readsAt({ kind: "continuous", value, targets: [0],
      inputs: [1, 2].map((signal) => ({ signal, kind: "data" })) }, slot, selector, width);
    return result && [...result].map(([id, bits]) => [id, [...bits]]);
  };
  assert.deepEqual(reads(shift("shiftLeft", signal(2), literal("10")), 5), [[2, [4]]]);
  assert.deepEqual(reads(shift("shiftLeft", signal(2), literal("10")), 1), []);
  assert.deepEqual(reads(shift("arithmeticShiftRight", signal(1), literal("11")), 7), [[1, [3]]]);
  assert.deepEqual(reads(shift("shiftRight", signal(1), literal("11")), 7), []);
  assert.equal(reads(shift("shiftLeft", signal(1), signal(2)), 5), undefined);
  assert.deepEqual(reads(shift("shiftLeft", signal(2), signal(1)), 5, 8,
    () => ({ bits: "0010", signed: true })), [[2, [4]]]);
  assert.deepEqual(reads(shift("shiftRight", signal(1), signal(2)), 0, 8,
    () => ({ bits: "11", signed: true })), [[1, [3]]]);
  assert.deepEqual(reads(shift("shiftLeft", signal(1), signal(2)), 5, 8,
    () => ({ bits: "0x", signed: false })), []);
  assert.deepEqual(reads(shift("shiftRight", signal(1), literal("x")), 0), []);
  const select = (test) => ({ op: "conditional", args: [literal(test), signal(1), signal(2)] });
  assert.deepEqual(reads(select("1x"), 1), [[1, [1]]]);
  assert.deepEqual(reads(select("x"), 1), [[2, [6]], [1, [1]]]);
  const enable = shift("and", {
    op: "bitSelect", args: [1, signal(2)],
  }, signal(2));
  assert.equal(reads(enable, 0), undefined);
  assert.deepEqual(reads(enable, 0, 8, () => ({ bits: "10", signed: false })),
    [[1, [2]], [2, [7, 6, 5, 4]]]);
  assert.deepEqual(reads(enable, 1), []);
});

test("static bit paths keep separate lanes of the same packed declaration", () => {
  const location = { uri: "file:///lanes.sv", range: { start: { line: 0, character: 0 } } };
  const assignment = (id, signal, bit, target, targetBit) => ({ id, location,
    targets: [target], inputs: [{ signal, kind: "data" }],
    bitDependencies: [{ targetBit, reads: [{ signal, bits: [bit] }] }],
  });
  const graph = { root: 2, bitSelection: { bit: 3 }, status: "partial",
    signals: [0, 1, 2].map((id) => ({ id, name: "n" + id, instance: "tb", packedRange: [3, 0] })),
    assignments: [assignment(0, 0, 0, 1, 0), assignment(1, 0, 1, 1, 1),
      assignment(2, 1, 0, 2, 3), assignment(3, 1, 1, 2, 2)],
    feedbackEdges: [], gaps: [],
  };
  const drivers = staticBitPaths(graph, "drivers", [{ signal: "tb.n0", bit: 0 }, { signal: "tb.n0", bit: 1 }], "all");
  assert.deepEqual(drivers.paths, [
    { node: { signal: 0, bit: 0 }, status: "found", root: { signal: 2, bit: 3 }, hops: 2 },
    { node: { signal: 0, bit: 1 }, status: "unreachable" },
  ]);
  assert.deepEqual(drivers.edges.map(({ assignment }) => assignment), [0, 2]);
  assert.match(staticBitReport(drivers, []), /\x60tb.n1\[0\]\x60 → \x60tb.n2\[3\]\x60/);
  const loads = staticBitPaths({ ...graph, root: 0, bitSelection: { bit: 0 } }, "loads",
    [{ signal: "tb.n2", bit: 3 }, { signal: "tb.n2", bit: 2 }], "shortest");
  assert.deepEqual(loads.paths.map(({ status }) => status), ["found", "unreachable"]);
  assert.deepEqual(loads.edges.map(({ input, output }) => [input.signal, output.signal]), [[1, 2], [0, 1]]);
  const incomplete = staticBitPaths({ ...graph, assignments: [{ ...graph.assignments[2], bitDependencies: undefined }] },
    "drivers", [{ signal: "tb.n1", bit: 0 }], "shortest");
  assert.equal(incomplete.assignmentsWithoutBitMappings, 1);
  assert.equal(incomplete.edges.length, 0);
});

test("temporal feedback marks a cycle completed by a joined continuation", () => {
  const edges = [{ source: 0, target: 1 }, { source: 1, target: 2 },
    { source: 0, target: 2 }];
  const pending = { status: "pending", source: 2, target: 0 };
  const merged = { status: "joined", source: 1, anchor: 1 };
  assert.equal(temporalFeedback(3, edges, [pending, merged]), undefined);
  assert.deepEqual(
    temporalFeedback(3, edges, [{ ...pending, status: "joined" }, merged]),
    [{ source: 2, target: 0, gap: 0 }],
  );
  assert.deepEqual(
    temporalFeedback(3, [...edges, { source: 2, target: 2 }]),
    [{ source: 2, target: 2, edge: 3 }],
  );
});

test("path export follows joined gaps and retains original evidence through cycles", () => {
  const assignment = { kind: "blocking", location: {
    uri: "file:///fixture.sv", range: { start: { line: 2, character: 1 } },
  } };
  const source = { file: "/fixture.c", line: 7, column: 3, identity: "matched" };
  const recordedWriter = { assignment: 1, commitOrdinal: 19, evaluation: {
    tick: "0", ordinal: 17, operandValues: { ready: "1" },
    externalSteps: [{ operation: "tf_getp(2)", value: "1", source }],
  } };
  const recordedTaskTransfer = {
    input: { ordinal: 11, tick: "0", source },
    write: { ordinal: 13, tick: "0", source },
    reads: [{ ordinal: 10, tick: "0", source, operation: "firmware byte offset 16", value: "00010010" }],
  };
  const graph = {
    roots: [0], scale: "1ps", coverage: { status: "partial", reasons: ["requestBudget"] },
    nodes: Array.from({ length: 7 }, (_, id) => ({
      signal: "tb.n" + id, point: { tick: "0", value: "0", ...(id === 3 ? { recordedWriter, recordedTaskTransfer, orderAtTick: 2, valueChangeOrdinal: 18 } : {}), ...(id === 0 ? { initializationAssignments: [3] } : {}) },
      sources: [{ segment: 0, node: id }],
      ...(id === 2 ? { recordedWordEvidence: [{ segment: 0, node: id, writers: [{
        assignment: 1, commitOrdinal: 9, targetRange: [2, 0], evaluation: { tick: "0", ordinal: 8, operandValues: { mask: "001" }, guardEntryValues: { w3_6_mask: "101" }, guardEntryTicks: { w3_6_mask: "0" }, guardEntryNextOrdinals: { w3_6_mask: 7 } },
      }] }] } : {}),
    })),
    edges: [
      { source: 2, target: 0, segment: 0, assignment: 0, kind: "data", confidence: "possible" },
      { source: 0, target: 2, segment: 0, assignment: 0, kind: "data", confidence: "possible" },
      { source: 1, target: 2, segment: 0, assignment: 0, kind: "data", confidence: "possible" },
    ],
    gaps: [
      { source: 3, target: 2, status: "joined", segment: 0, evidence: { reason: "noChangeInWindow" } },
      { source: 4, target: 0, signal: "tb.unknown", status: "unmatched", segment: 0, evidence: { reason: "staticBudget", tick: "0" } },
      { target: 2, signal: "tb.input", status: "unresolved", segment: 0, evidence: {
        reason: "unmapped", bindingIssue: "waveformMissing", tick: "0", use: { assignment: 4, kind: "data" },
      } },
      { anchor: 3, signal: "tb.previous", status: "pending", segment: 0, nextSegment: 7, evidence: {
        reason: "staticBudget", tick: "0", continuation: { signal: "tb.previous", tick: "0", changeOrder: 2 },
      } },
      { target: 6, signal: "tb.outside", status: "unresolved", segment: 0, evidence: { reason: "unmapped", tick: "0" } },
    ],
    assignmentSources: [{ 0: assignment, 1: assignment, 2: assignment, 3: assignment, 4: assignment }],
  };
  const result = traceGraphPaths(graph, [3, 4, 3]);
  assert.equal(result.graph.feedbackEdges, undefined);
  assert.deepEqual(result.paths, [
    { node: 3, status: "found", root: 0, hops: 2 },
    { node: 4, status: "unreachable" },
  ]);
  assert.deepEqual(result.graph.nodes.map(({ sourceNode }) => sourceNode), [0, 2, 3, 4]);
  assert.deepEqual(result.graph.nodes[2].point.recordedWriter, recordedWriter);
  assert.deepEqual(result.graph.edges.map(({ source, target, confidence }) =>
    [source, target, confidence]), [[1, 0, "possible"]]);
  assert.deepEqual(result.graph.gaps.map(({ status, source, target, anchor }) => [status, source, target, anchor]), [
    ["joined", 2, 1, undefined], ["unmatched", 3, 0, undefined],
    ["unresolved", undefined, 1, undefined], ["pending", undefined, undefined, 2],
  ]);
  assert.equal(result.graph.gaps[3].nextSegment, 7);
  assert.deepEqual(result.graph.gapSummary.byBindingIssue, { waveformMissing: 1 });
  assert.deepEqual(Object.keys(result.graph.assignmentSources[0]), ["0", "1", "3", "4"]);
  const report = tracePathReport(result, combinedTemporalMermaid(result.graph));
  assert.match(report, /Commit 19/);
  assert.match(report, /Change 2 · Value-change callback 18/);
  assert.match(report, /Recorded operand `ready` = `1`/);
  assert.match(report, /External step 1 · `tf_getp\(2\)` = `1` · `\/fixture\.c` L7:3 · Source matched/);
  assert.match(report, /Commit 9 · Write \[2:0\]/);
  assert.match(report, /Recorded operand `mask` = `001`/);
  assert.match(report, /Wait resume L3:6 · mask = 101 @ 0 · before event 7/);
  assert.match(report, /`t2 · tb.n3 @ 0` · input commit 11 .*member write commit 13/);
  assert.match(report, /firmware byte offset 16 = 00010010/);
  assert.match(report, /data candidate/);
  assert.match(report, /requestBudget/);
  assert.match(report, /Evidence gaps on these paths/);
  assert.match(report, /`tb.input` @ 0 → t1 · unresolved/);
  assert.match(report, /Continue from `tb.previous` @ 0 · Change 2/);
  assert.doesNotMatch(report, /tb.outside/);
  assert.throws(() => traceGraphPaths(graph, [7]), /outside the trace graph/);

  const narrowed = traceGraphPaths(result.graph, [2]);
  assert.deepEqual(narrowed.paths, [{ node: 2, status: "found", root: 0, hops: 2 }]);
  assert.deepEqual(narrowed.graph.nodes.map(({ sourceNode }) => sourceNode), [0, 2, 3]);
  assert.deepEqual(narrowed.graph.nodes[2].point.recordedWriter, recordedWriter);
  assert.deepEqual(narrowed.graph.gaps[0], result.graph.gaps[0]);
  assert.deepEqual(narrowed.graph.assignmentSources, result.graph.assignmentSources);

  const merged = {
    source: 2, target: undefined, anchor: 2, status: "joined", segment: 0, nextSegment: 1,
    evidence: { reason: "staticBudget", use: { assignment: 2, kind: "data" } },
  };
  const withMerged = traceGraphPaths({ ...graph, gaps: [...graph.gaps, merged] }, [3]);
  const mergedAgain = traceGraphPaths(withMerged.graph, [2]);
  assert.deepEqual(mergedAgain.paths, narrowed.paths);
  assert.deepEqual(mergedAgain.graph.gaps[1], { ...merged, source: 1, anchor: 1 });
  assert.deepEqual(mergedAgain.graph.assignmentSources[0][2], assignment);
  assert.match(tracePathReport(mergedAgain, []), /t1 · Joined continuation S0 → S1/);

  const extraEdge = (source, target) => ({
    ...graph.edges[0], source, target, assignment: 2,
  });
  const branched = {
    ...graph,
    roots: [0, 5],
    edges: [
      ...graph.edges,
      extraEdge(2, 1),
      extraEdge(3, 1),
      extraEdge(1, 5),
      extraEdge(3, 6),
    ],
    gaps: [{ ...graph.gaps[0], anchor: 1 }, ...graph.gaps.slice(1)],
  };
  const all = traceGraphPaths(branched, [3, 4], undefined, "all");
  assert(all.graph.feedbackEdges?.length);
  assert.match(tracePathReport(all, []), /Feedback in the time graph/);
  assert.deepEqual(all.paths, result.paths);
  assert.deepEqual(all.graph.roots, [0, 5]);
  assert.deepEqual(all.graph.nodes.map(({ sourceNode }) => sourceNode), [0, 1, 2, 3, 4, 5]);
  const edges = all.graph.edges.map(({ source, target }) => [source, target].join("→"));
  assert.deepEqual(edges.sort(), ["1→2", "1→5", "2→0", "2→1", "3→1"]);
  assert.deepEqual(all.graph.gaps[0], branched.gaps[0]);
  assert.deepEqual(all.graph.gaps.slice(1).map(({ signal }) => signal), ["tb.unknown", "tb.input", "tb.previous"]);
  const { joined, pending, unmatched, unresolved } = all.graph.gapSummary;
  assert.deepEqual([joined, pending, unmatched, unresolved], [1, 1, 1, 1]);
  assert.deepEqual(Object.keys(all.graph.assignmentSources[0]), ["0", "1", "2", "3", "4"]);
  assert.deepEqual(all.graph.coverage, graph.coverage);
  assert.match(tracePathReport(all, []), /Every recorded branch/);
});

test("path selectors distinguish ordered changes from same-tick samples", () => {
  const graph = { nodes: [
    { signal: "tb.req[1:0]", waveformSignal: "dump.req[1:0]", point: { tick: "5", orderAtTick: 1, valueChangeOrdinal: 0 } },
    { signal: "tb.req[1:0]", point: { tick: "5", orderAtTick: 2, valueChangeOrdinal: 7 } },
    { signal: "tb.req[1:0]", point: { tick: "5", sampleOnly: true } },
    { signal: "tb.req[0]", point: { tick: "5" } },
    { signal: "tb.req[1:0]", point: { tick: "6" } },
  ] };
  const selection = selectTracePathNodes(graph, [0], [
    { signal: "tb.req", tick: "0005", changeOrder: 2 },
    { signal: "tb.req[1:0]", tick: "5", changeOrder: 1 },
    { signal: "tb.req[0]", tick: "5", changeOrder: 1 },
    { signal: "tb.req", tick: "10" },
  ]);
  assert.deepEqual(selection.nodeIds, [0, 1, 3]);
  assert.deepEqual(selection.matches.map(row => row.nodeIds), [[1], [0], [3], []]);
  assert.deepEqual(selectTracePathNodes(graph, [], [
    { signal: "dump.req[1:0]", tick: "5" },
    { signal: "dump.req", tick: "5" },
  ]).matches.map(row => row.nodeIds), [[0], [0]]);
  assert.deepEqual(selectTracePathNodes(graph, [], [{ signal: "tb.req", tick: "5" }]).nodeIds, [0, 1, 2]);
  assert.deepEqual(selectTracePathNodes(graph, [], [
    { signal: "tb.req", tick: "5", callbackOrdinal: 7 },
    { signal: "dump.req", tick: "5", callbackOrdinal: 0 },
  ]).nodeIds, [1, 0]);
  assert.throws(() => selectTracePathNodes(graph, [], [{ signal: "tb.req", tick: "5", callbackOrdinal: -1 }]), /non-negative callbackOrdinal/);
  assert.throws(() => selectTracePathNodes(graph, [], []), /Provide nodeIds or nodeSelectors/);
  assert.throws(() => selectTracePathNodes(graph, [], [{ signal: "tb.req", tick: "5ps" }]), /decimal tick/);
  assert.throws(() => selectTracePathNodes(graph, [], [{ signal: "tb.req", tick: "10" }]), /No time graph nodes/);
  assert.throws(() => selectTracePathNodes({ nodes: Array(17).fill(graph.nodes[0]) }, [], [{ signal: "tb.req", tick: "5" }]), /exceeds 16 nodes/);
});

test("combined time graphs join only the same transition and retain both edge sources", () => {
  const provider = { kind: "waveform", sampling: "orderedChanges" };
  const coverage = { status: "resolvedWithinWindow", reasons: [] };
  const segment = (name, nodes, edges = [], gaps = []) => ({
    root: 0, signals: [], assignmentSources: {},
    waveformSignals: { 0: name, 1: "tb.shared" },
    context: { scale: "1ps", provider, observations: [], temporalTrace: { nodes, edges, gaps, coverage } },
  });
  const request = { signal: "tb.a", tick: "3", changeOrder: 2 };
  const gap = {
    signal: 2, tick: "3", value: "1", orderAtTick: 2, reason: "nodeBudget",
    use: {
      target: 0, assignment: 0, kind: "data",
      evidence: { kind: "data", role: "index", confidence: "possible", timing: "sameTickUnordered",
        arrayIndexEvidence: "recordedTarget", recordedCommitOrdinal: 8 },
    },
    continuation: request,
  };
  const shared = { signal: 1, tick: "2", value: "1", orderAtTick: 1 };
  const relation = { source: 1, target: 0, assignment: 0, kind: "data", confidence: "possible" };
  const root = segment("tb.q", [{ signal: 0, tick: "4", value: "1" }, shared], [relation], [gap]);
  const next = segment("tb.a", [{ signal: 0, tick: "3", value: "1", orderAtTick: 2 }, shared], [relation]);
  const continuedDeclaration = {
    uri: pathToFileURL(path.resolve("a.sv")).href,
    range: { start: { line: 4, character: 2 } },
  };
  next.signals.push({ id: 0, declaration: continuedDeclaration });
  next.context.waveformBindings = { "0:": "dump.tb.a" };
  const walk = { segments: [{ request, trace: next }], remaining: [], stopReasons: [],
    links: [{ segment: 0, gap: 0, nextSegment: 1 }] };
  const joined = mergeTemporalContinuationGraph(root, walk);
  const snapshot = temporalGraphSnapshot({
    ...joined, assignmentSources: [{ 3: { kind: "continuous" } }, null],
  });
  assert.equal(snapshot.metadata.sourceSegmentCount, 2);
  assert.deepEqual(snapshot.metadata.missingSourceSegments, [1]);
  assert.deepEqual(snapshot.sections.assignmentSources, [
    { segment: 0, assignment: 3, source: { kind: "continuous" } },
  ]);
  assert.deepEqual(traceGraphPage(snapshot.sections.nodes, 1, 1), {
    offset: 1, total: 3, items: [joined.nodes[1]], nextOffset: 2,
  });
  assert.throws(() => traceGraphPage(snapshot.sections.nodes, 4, 1), /bounds/);
  const largeItem = "x".repeat(1024 * 1024);
  assert.equal(traceGraphPage([largeItem, largeItem], 0, 2).nextOffset, 1);
  assert.equal(joined.nodes.length, 3);
  assert.deepEqual(joined.nodes[1].sources, [{ segment: 0, node: 1 }, { segment: 1, node: 1 }]);
  assert.equal(joined.gaps[0].status, "joined");
  assert.deepEqual(snapshot.metadata.gapSummary, {
    joined: 1, pending: 0, unmatched: 0, unresolved: 0,
    byReason: { nodeBudget: { joined: 1, pending: 0, unmatched: 0, unresolved: 0 } },
    byBindingIssue: {},
  });
  assert.equal(joined.gaps[0].target, 0);
  assert.equal(joined.gaps[0].source, 2);
  const waitGap = {
    ...gap,
    use: { ...gap.use, evidence: { ...gap.use.evidence,
      waitResumeCause: "orderedCallbacks", waitResumeCallbackOrdinal: 7,
    } },
  };
  const withWait = segment("tb.q", root.context.temporalTrace.nodes, [relation], [waitGap]);
  for (const callback of [undefined, 7, 14]) {
    const continued = segment("tb.a", [
      { ...next.context.temporalTrace.nodes[0], valueChangeOrdinal: callback }, shared,
    ], [relation]);
    const graph = mergeTemporalContinuationGraph(withWait, {
      ...walk, segments: [{ request, trace: continued }],
    });
    assert.equal(graph.gaps[0].status, callback === 7 ? "joined" : "unmatched");
    if (callback === 7) {
      const selected = traceGraphPaths(graph, [graph.gaps[0].source]);
      assert.match(tracePathReport(selected, []), /Joined continuation.*callback 7 enabled wait/);
    }
  }
  assert.equal(joined.nodes[2].waveformSignal, "dump.tb.a");
  assert.deepEqual(joined.nodes[2].declaration, continuedDeclaration);
  const { traceTimeSchematic } = require("../dist/rtl-schematic");
  const continuedSchematic = traceTimeSchematic(root, joined);
  assert.deepEqual(continuedSchematic.locations.get("event-2"), continuedDeclaration);
  assert.equal(continuedSchematic.graph.nodes[2].waveformSignal, "dump.tb.a");
  assert.equal(continuedSchematic.graph.nodes[1].wave, undefined);
  assert.match(combinedTemporalMermaid(joined).join("\n"), /continued index candidate.*matches recorded array index.*commit 8/);
  assert.deepEqual(joined.edges.map(({ segment, source, target }) => [segment, source, target]),
    [[0, 1, 0], [1, 1, 2]]);
  const captured = {
    ...joined,
    nodes: joined.nodes.map((node, index) => index > 1 ? node : {
      ...node,
      point: index === 0
        ? { ...node.point, recordedWriter: { assignment: 0, commitOrdinal: 8, evaluation: { tick: "4", ordinal: 4 } } }
        : { ...node.point, sampleOnly: true, operandEvaluationOrdinal: 4 },
    }),
  };
  const capturedDiagram = combinedTemporalMermaid(captured).join("\n");
  assert.match(capturedDiagram, /captured operand .* evaluation 4/);
  assert.match(capturedDiagram, /commit 8 .* evaluated .* 4 order 4/);
  assert.match(traceTimeSchematic(root, captured).graph.nodes[1].detail, /求值 4 的操作数/);
  const sourceAt = (line, instance) => ({
    kind: "continuous", instance,
    location: { ...continuedDeclaration, range: { start: { line, character: 2 } } },
  });
  const sourceIndex = {
    ...joined,
    edges: [
      { ...joined.edges[0], alsoAssignments: [1, 2, 3, 4, 5, 6, 7] },
      { ...joined.edges[1], target: 0 },
    ],
    assignmentSources: [
      Object.fromEntries(Array.from({ length: 8 }, (_, id) => [id, sourceAt(10 + id, "tb")])),
      { 0: sourceAt(30, "tb.child") },
    ],
  };
  const sourcesDiagram = combinedTemporalMermaid(sourceIndex).join("\n");
  assert.match(sourcesDiagram, /t1 -->\|data candidate.*RTL S0\/A1 S0\/A2 .* S0\/A8\| t0/);
  assert.match(sourcesDiagram, /t1 -->\|data candidate.*RTL S1\/A1\| t0/);
  assert.match(sourcesDiagram, /t2 -\.->\|continued index candidate.*RTL S0\/A1\| t0/);
  const sourceReport = continuationReport(walk, [], sourceIndex);
  assert.match(sourceReport, /- `S0\/A2` · continuous · `tb` · .* L12:3/);
  assert.match(sourceReport, /- `S1\/A1` · continuous · `tb.child` · .* L31:3/);
  const pendingWalk = {
    ...walk, segments: [], remaining: [request],
  };
  const pendingGraph = mergeTemporalContinuationGraph(root, pendingWalk);
  const pendingDiagram = combinedTemporalMermaid(pendingGraph).join("\n");
  assert.equal(pendingGraph.gapSummary.pending, 1);
  assert.match(continuationReport(pendingWalk, [], pendingGraph),
    /\| Time graph node budget reached \| 0 \| 1 \| 0 \| 0 \|/);
  assert.match(pendingDiagram, /g0 -\.->\|index candidate.*RTL S0\/A1\| t0/);
  const liveProvider = { kind: "live", sampling: "endOfSlot", liveSessionId: "session-a" };
  const liveRoot = { ...root, context: { ...root.context, provider: liveProvider } };
  const otherSession = {
    ...next,
    context: { ...next.context, provider: { ...liveProvider, liveSessionId: "session-b" } },
  };
  const separate = mergeTemporalContinuationGraph(liveRoot, {
    ...walk, segments: [{ request, trace: otherSession }],
  });
  assert.equal(separate.nodes.length, 4);
  assert.equal(separate.gaps[0].status, "unmatched");
  assert.equal(separate.gapSummary.byReason.nodeBudget.unmatched, 1);
  assert.equal(temporalGraphSnapshot(separate).metadata.provider.liveSessionId, "session-a");
  const source = { file: path.resolve("task.sv"), line: 9, column: 3, identity: "matched" };
  const task = {
    index: 1,
    input: { tick: "1", ordinal: 3, source },
    write: { tick: "2", ordinal: 6, source },
    reads: [{ operation: "$fgetc at byte 0", value: "00000001", tick: "1", ordinal: 2, source }],
  };
  next.context.temporalTrace.nodes[1] = { ...shared, recordedTaskTransfer: task };
  const withTask = mergeTemporalContinuationGraph(root, walk);
  assert.equal(withTask.nodes.length, joined.nodes.length);
  assert.equal(withTask.nodes[1].point.recordedTaskTransfer, task);
  assert.equal(shared.recordedTaskTransfer, undefined);
  const diagram = combinedTemporalMermaid(withTask).join("\n");
  assert.match(diagram, /task1 -->\|recorded member write .* commit 6\| t1/);
  assert.match(diagram, /task1_0 -->\|recorded input byte\| task1/);
  assert.match(continuationReport(walk, [], withTask), /input commit 3 @ 1 .* member write commit 6 @ 2/);
  const schematic = traceTimeSchematic(root, withTask);
  assert.deepEqual(schematic.locations.get("event-1-task-input-0"), {
    uri: pathToFileURL(source.file).href,
    range: { start: { line: 8, character: 2 } },
  });
  assert(schematic.graph.edges.some(({ from, to }) =>
    from === "event-1-task-input-0" && to === "event-1-task-input"));
  assert(schematic.graph.edges.some(({ from, to }) =>
    from === "event-1-member-write" && to === "event-1"));
  const firstWordLocation = sourceAt(20, "tb");
  const nextWordLocation = sourceAt(25, "tb");
  const firstWrite = { assignment: 1, commitOrdinal: 4, targetRange: [7, 4] };
  const nextWrite = { assignment: 0, commitOrdinal: 6, targetRange: [3, 0],
    contributingRanges: [[3, 0]], evaluation: { ordinal: 5, tick: "2", value: "0011" } };
  root.assignmentSources[1] = firstWordLocation;
  next.assignmentSources[0] = nextWordLocation;
  root.context.temporalTrace.nodes[1] = { ...shared, recordedWordWriters: [firstWrite],
    recordedWordUnresolved: [[3, 0]] };
  next.context.temporalTrace.nodes[1] = { ...shared, recordedWordWriters: [nextWrite],
    recordedWordChanges: [{ ordinal: 7, value: "10100011" }] };
  const withWords = mergeTemporalContinuationGraph(root, walk);
  assert.deepEqual(temporalGraphSnapshot(withWords).sections.nodes[1].recordedWordEvidence, [
    { segment: 0, node: 1, writers: [firstWrite], unresolved: [[3, 0]], callbacks: undefined },
    { segment: 1, node: 1, writers: [nextWrite], unresolved: undefined,
      callbacks: [{ ordinal: 7, value: "10100011" }] },
  ]);
  const wordDiagram = combinedTemporalMermaid(withWords).join("\n");
  assert.match(wordDiagram, /word1_1_1_write0\["Commit 6.*Write .*Contributes .*Evaluation 5 #64;/);
  assert.match(wordDiagram, /word1_1_1_write0 -->\|RTL S1\/A1\| t1/);
  assert.match(wordDiagram, /word1_0_1_unresolved -\.->\|unverified bits\| t1/);
  const wordReport = continuationReport(walk, [], withWords);
  assert.match(wordReport.split("### Continuation 1")[1], /t0\["tb\.a #64; 3 #183; change 2 #61; 1/);
  assert.match(wordReport, /S1\/A1.*Commit 6.*Contributes \[3:0\].*Evaluation 5/);
  assert.match(wordReport, /Callback 7 · `10100011`/);
  const wordSchematic = traceTimeSchematic(root, withWords);
  assert.deepEqual(wordSchematic.locations.get("write-0-1-0"), firstWordLocation.location);
  assert.deepEqual(wordSchematic.locations.get("write-1-1-0"), nextWordLocation.location);
  root.context.temporalTrace.nodes[1] = shared;
  next.context.temporalTrace.nodes[1] = shared;
  for (const patch of [{ tick: "2" }, { orderAtTick: 1 }, { value: "0" }, { sampleOnly: true }]) {
    const timeline = next.context.temporalTrace;
    const original = timeline.nodes[0];
    timeline.nodes[0] = { ...original, ...patch };
    const unmatched = mergeTemporalContinuationGraph(root, walk);
    assert.equal(unmatched.gaps[0].status, "unmatched");
    assert.equal(unmatched.gaps[0].source, undefined);
    assert.equal(unmatched.coverage.status, "partial");
    timeline.nodes[0] = original;
  }
  root.context.temporalTrace.gaps = [{ ...gap, use: undefined }];
  assert.deepEqual(mergeTemporalContinuationGraph(root, walk).roots, [0, 2]);

  const earlierRequest = { signal: "tb.a", tick: "3", historyStart: "auto" };
  root.context.temporalTrace.gaps = [{
    ...gap, tick: "4", orderAtTick: undefined, reason: "noChangeInWindow",
    historyCutoff: "3", continuation: earlierRequest,
  }];
  root.context.temporalTrace.coverage = { status: "partial", reasons: ["missingObservations"] };
  walk.segments[0].request = earlierRequest;
  next.context.tick = "3";
  next.context.temporalTrace.nodes[0] = { signal: 0, tick: "1", value: "1" };
  const observation = {
    signal: 0, status: "observed", value: "1",
    history: [{ tick: "1", value: "1" }],
  };
  next.context.observations = [observation];
  const earlier = mergeTemporalContinuationGraph(root, walk);
  assert.equal(earlier.gaps[0].status, "joined");
  assert.equal(earlier.nodes[earlier.gaps[0].source].point.tick, "1");
  assert.equal(earlier.coverage.status, "resolvedWithinWindow");
  assert.match(combinedTemporalMermaid(earlier).join("\n"), /continued index candidate.*earlier change/);
  observation.history.push({ tick: "2", value: undefined }, { tick: "3", value: "1" });
  const discontinuous = mergeTemporalContinuationGraph(root, walk);
  assert.equal(discontinuous.gaps[0].status, "unmatched");
  assert(discontinuous.coverage.reasons.includes("missingObservations"));

  const boundaryPoint = { signal: 1, bit: 2, tick: "3", value: "1" };
  const boundary = { ...boundaryPoint, anchor: 1, reason: "staticBudget" };
  const holder = segment("tb.q", [{ signal: 0, tick: "4", value: "1" }, boundaryPoint], [relation], [boundary]);
  holder.waveformSignals[1] = "tb.a[7:0]";
  const anchored = segment("tb.a[2]", [{ ...boundaryPoint, signal: 0 }, shared], [relation]);
  holder.context.temporalTrace.coverage = { status: "partial", reasons: ["staticTraversalBudget"] };
  const boundaryRequest = { signal: "tb.a[2]", tick: "3" };
  boundary.continuation = boundaryRequest;
  walk.segments[0] = { request: boundaryRequest, trace: anchored };
  const resumed = mergeTemporalContinuationGraph(holder, walk);
  assert.equal(resumed.gaps[0].status, "joined");
  assert.equal(resumed.gaps[0].anchor, resumed.gaps[0].source);
  assert.deepEqual(resumed.roots, [0]);
  assert.deepEqual(resumed.coverage, coverage);
  assert(resumed.edges.some(({ segment, target }) => segment === 1 && target === resumed.gaps[0].anchor));

  holder.context.temporalTrace.coverage.reasons.push("staticFrontier");
  assert.deepEqual(mergeTemporalContinuationGraph(holder, walk).coverage,
    { status: "partial", reasons: ["staticFrontier"] });
  holder.context.temporalTrace.coverage.reasons.pop();
  holder.context.temporalTrace.gapsTruncated = true;
  assert(mergeTemporalContinuationGraph(holder, walk).coverage.reasons.includes("staticTraversalBudget"));
  delete holder.context.temporalTrace.gapsTruncated;

  anchored.context.temporalTrace.nodes[0].recordedWriter = { assignment: 0, commitOrdinal: 9 };
  const attributed = mergeTemporalContinuationGraph(holder, walk);
  assert.equal(attributed.gaps[0].status, "joined");
  assert.notEqual(attributed.gaps[0].anchor, attributed.gaps[0].source);
  assert.match(combinedTemporalMermaid(attributed).join("\n"), /same change .* continued static trace/);
  boundaryPoint.recordedWriter = { assignment: 0, commitOrdinal: 8 };
  const conflict = mergeTemporalContinuationGraph(holder, walk);
  assert.equal(conflict.gaps[0].status, "unmatched");
  assert(conflict.coverage.reasons.includes("staticTraversalBudget"));
});

test("automatic static continuations share targets, close cycles, and retain partial results", async () => {
  const graph = (...paths) => ({
    scope: "elaborated",
    signals: [{ id: 0, instance: "tb", name: "q" }],
    assignments: [],
    diagnostics: [],
    frontier: paths.map((signal) => ({
      signal: 0, reason: "depth", continuation: signal ? { signal } : null,
    })),
  });
  const initial = graph("tb.a", "tb.b");
  initial.frontier[1].reason = "signals";
  const cancellation = new AbortController();
  const deadline = new AbortController();
  const queried = [];
  const traverse = async (signal) => {
    queried.push(signal);
    return signal === "tb.shared" ? graph("tb.q") : graph("tb.shared");
  };
  const walk = await followStaticFrontier(
    "tb.q", initial, 3, cancellation.signal, deadline.signal, traverse, async () => {},
  );
  assert.deepEqual(queried, ["tb.a", "tb.b", "tb.shared"]);
  assert.deepEqual(walk.links.slice(2), [
    { segment: 1, stop: 0, nextSegment: 3 },
    { segment: 2, stop: 0, nextSegment: 3 },
    { segment: 3, stop: 0, nextSegment: 0 },
  ]);
  assert.equal(walk.status, "resolvedWithinScope");
  const partial = await followStaticFrontier(
    "tb.q", initial, 1, cancellation.signal, deadline.signal, traverse, async () => {},
  );
  queried.length = 0;
  const resumed = await followStaticFrontier(
    "tb.q", initial, 2, cancellation.signal, deadline.signal,
    traverse, async () => {}, partial.segments,
  );
  assert.deepEqual(queried, ["tb.b", "tb.shared"]);
  assert.equal(partial.segments.length, 1);
  assert.deepEqual(resumed, walk);

  const selected = await followStaticFrontier(
    "tb.q", initial, 1, cancellation.signal, deadline.signal,
    traverse, async () => {}, [], ["tb.b"],
  );
  assert.deepEqual(selected.segments.map(({ signal }) => signal), ["tb.b"]);
  assert.deepEqual(selected.remaining, ["tb.a", "tb.shared"]);
  assert.deepEqual(selected.links.map(({ nextSegment }) => nextSegment), [2, 1, 3]);
  const completed = await followStaticFrontier(
    "tb.q", initial, 2, cancellation.signal, deadline.signal,
    traverse, async () => {}, selected.segments,
  );
  assert.deepEqual(completed.segments.map(({ signal }) => signal), ["tb.b", "tb.a", "tb.shared"]);
  assert.deepEqual(completed.links.map(({ nextSegment }) => nextSegment), [2, 1, 3, 3, 0]);
  assert.equal(completed.status, "resolvedWithinScope");

  const stalled = await followStaticFrontier(
    "tb.q", graph("tb.q"), 3, cancellation.signal, deadline.signal, traverse, async () => {},
  );
  assert.deepEqual(stalled.stopReasons, ["noProgress"]);
  assert.equal(stalled.segments.length, 0);

  let changed = false;
  const invalidated = await followStaticFrontier(
    "tb.q", initial, 3, cancellation.signal, deadline.signal,
    async (signal) => {
      changed ||= signal === "tb.b";
      return graph();
    },
    async () => {
      if (changed) throw new TraceContextChanged("The reference changed.");
    },
  );
  assert.deepEqual(invalidated.segments.map(({ signal }) => signal), ["tb.a"]);
  assert.deepEqual(invalidated.remaining, ["tb.b"]);
  assert.deepEqual(invalidated.stopReasons, ["contextChanged"]);

  const interrupted = await followStaticFrontier(
    "tb.q", initial, 3, cancellation.signal, deadline.signal,
    async (signal) => {
      if (signal === "tb.b") cancellation.abort();
      return graph();
    },
    async () => {},
  );
  assert.deepEqual(interrupted.segments.map(({ signal }) => signal), ["tb.a"]);
  assert.deepEqual(interrupted.remaining, ["tb.b"]);
  assert.deepEqual(interrupted.stopReasons, ["cancelled"]);
});

test("combined static graphs share elaborated declarations and keep ordered evidence", () => {
  const location = (line) => ({
    uri: "file:///trace.sv",
    range: { start: { line, character: 0 } },
  });
  const signal = (id, name, line, instance = "tb") => ({
    id, name, instance, declaration: location(line),
  });
  const relation = (from, to, line) => ({
    kind: "continuous",
    hasUnresolvedOperands: false,
    location: location(line),
    inputs: [{ signal: from, kind: "data", edge: null, location: location(line) }],
    targets: [to],
  });
  const graph = (root, signals, assignments, frontier = []) => ({
    root, signals, assignments, frontier, scope: "elaborated", diagnostics: [],
  });
  const initial = graph(1, [signal(1, "q", 1), signal(2, "a", 2)], [relation(2, 1, 10)]);
  const first = graph(8, [signal(8, "a", 2), signal(9, "q", 1), signal(10, "b", 3), signal(11, "a", 2, "tb.other")],
    [relation(8, 9, 10), relation(10, 8, 11)]);
  const next = graph(50, [signal(50, "b", 3), signal(51, "q", 1)], [relation(51, 50, 12)],
    [{ signal: 50, reason: "depth", continuation: null }]);
  const walk = {
    status: "partial",
    segments: [first, next].map((trace) => ({ trace, coverage: staticTraceCoverage(trace) })),
    links: [],
  };
  const combined = mergeStaticContinuationGraph(initial, walk);
  assert.deepEqual(combined.signals.map(({ id, instance, name }) => [id, instance, name]),
    [[0, "tb", "q"], [1, "tb", "a"], [2, "tb", "b"], [3, "tb.other", "a"]]);
  assert.deepEqual(combined.assignments[0].sources, [
    { segment: 0, assignment: 0 }, { segment: 1, assignment: 0 },
  ]);
  assert.equal(combined.assignments.length, 3);
  assert.equal(combined.gaps[0].signal, 2);
  assert.equal(combined.gaps[0].waveformUnavailable, true);
  assert.equal(combined.feedbackScope, "merged");
  const snapshot = staticGraphSnapshot(combined);
  assert.deepEqual(snapshot.sections.signals, combined.signals);
  assert.deepEqual(snapshot.sections.feedbackEdges, combined.feedbackEdges);
  assert(combined.feedbackEdges.length);
  assert.match(mergedStaticMermaid(combined)[0], /s2 -.-> gap0/);

  const { graph: pageOne, page } = pageStaticContinuationGraph(combined, "drivers", "tb.q", 1);
  assert.deepEqual(pageOne.assignments, [combined.assignments[0]]);
  assert.deepEqual(pageOne.gaps, combined.gaps);
  assert.equal(page.totalAssignments, 3);
  const pageTwo = pageStaticContinuationGraph(combined, "drivers", "tb.q", 1, page.nextCursor);
  const pageThree = pageStaticContinuationGraph(combined, "drivers", "tb.q", 1, pageTwo.page.nextCursor);
  assert.equal(pageThree.page.assignmentOffset, 2);
  assert.equal(pageThree.page.nextCursor, undefined);
  assert.deepEqual(
    [...pageOne.assignments, ...pageTwo.graph.assignments, ...pageThree.graph.assignments],
    combined.assignments,
  );
  assert.deepEqual(
    [...pageOne.feedbackEdges, ...pageTwo.graph.feedbackEdges, ...pageThree.graph.feedbackEdges],
    combined.feedbackEdges,
  );
  const feedbackPage = [pageOne, pageTwo.graph, pageThree.graph].find(({ feedbackEdges }) => feedbackEdges.length);
  assert.match(mergedStaticMermaid(feedbackPage)[0], /class a0 feedback/);
  assert.throws(() => staticTracePage(initial, "drivers", "tb.q", 1, page.nextCursor), /cursor/);
  assert.throws(() => pageStaticContinuationGraph(
    { ...combined, status: "complete" }, "drivers", "tb.q", 1, page.nextCursor,
  ), /cursor/);

  initial.bitSelection = { bit: 5, feedbackEdges: [] };
  initial.assignments[0].writtenBits = [5];
  initial.assignments[0].inputs[0].readBits = [1];
  initial.assignments[0].bitDependencies = [{ targetBit: 5, reads: [{ signal: 2, bits: [1] }] }];
  const projected = mergeStaticContinuationGraph(initial, walk);
  assert.equal(projected.feedbackScope, "segmentsAndKnownBits");
  assert.deepEqual(projected.feedbackEdges, []);
  assert.deepEqual(projected.assignments[0].bitDependencies, [
    { targetBit: 5, reads: [{ signal: 1, bits: [1] }] },
  ]);
  first.assignments[1].bitDependencies = [{ targetBit: 1, reads: [{ signal: 10, bits: [2] }] }];
  next.assignments[0].bitDependencies = [{ targetBit: 2, reads: [{ signal: 51, bits: [6] }] }];
  assert.deepEqual(mergeStaticContinuationGraph(initial, walk).feedbackEdges, []);
  next.assignments[0].bitDependencies[0].reads[0].bits = [5];
  assert(mergeStaticContinuationGraph(initial, walk).feedbackEdges.length > 0);
});

test("a bounded instance trace preserves a nearby port before a deeper local branch", async () => {
  const location = { uri: "file:///trace.sv", range: { start: { line: 0, character: 0 } } };
  const graph = (names, assignments = []) => ({
    schemaVersion: 1,
    revision: "bounded-port",
    scope: "file",
    root: 0,
    signals: names.map((name, id) => ({ id, name, declaration: location })),
    assignments,
    frontier: [],
    diagnostics: [],
  });
  const write = (target, ...sources) => ({
    kind: "continuous",
    location,
    targets: [target],
    inputs: sources.map((signal) => ({ signal, kind: "data", edge: null, location })),
    hasUnresolvedOperands: false,
  });
  const link = {
    file: location.uri,
    line: 1,
    from: { instance: "tb", signal: "stimulus" },
    to: { instance: "tb.dut", signal: "port" },
  };
  const design = {
    kind: "kdb",
    resolve: async (name) => ({
      file: location.uri,
      line: 1,
      instance: name.slice(0, name.lastIndexOf(".")),
    }),
    portLinks: async (_, signal) => ["port", "stimulus"].includes(signal) ? [link] : [],
  };
  const trace = await expandInstanceTrace(
    graph(["out", "port", "local", "middle", "deep"], [write(0, 1, 2), write(2, 3), write(3, 4)]),
    "tb.dut",
    design,
    "drivers",
    { maxSignals: 4 },
    (file) => file,
    async ({ signal }) => graph([signal]),
  );
  assert.deepEqual(trace.signals.map(({ name }) => name), ["out", "port", "local", "stimulus"]);
  assert.deepEqual(trace.assignments.map(({ kind }) => kind), ["continuous", "port"]);
  const frontier = trace.frontier.find(({ reason }) => reason === "signals");
  assert.equal(trace.signals.find(({ id }) => id === frontier.signal).name, "local");
});

const fixture = process.env.WAVE_TEST_RTL_TRACE;
const portSliceFixture = process.env.WAVE_TEST_PORT_SLICE;
const generateFixture = process.env.WAVE_TEST_GENERATE;

test("KDB selects the elaborated generate branch and specializes an array index slice", async () => {
  const file = "/fifo.sv";
  const uri = pathToFileURL(file).href;
  const location = { uri, range: { start: { line: 2, character: 0 } } };
  const selected = { uri, name: "many", line: 5, byteColumn: 10 };
  const other = { uri, name: "one", line: 8, byteColumn: 10 };
  const trace = {
    schemaVersion: 1, revision: "1", scope: "file", root: 0, diagnostics: [], frontier: [],
    signals: ["out", "mem", "ptr", "Top", "Enabled", "Other"].map((name, id) => ({
      id, name, declaration: location, ...(id >= 3 ? { instanceParameter: true } : {}),
    })),
    assignments: [
      {
        kind: "continuous", targets: [0], location, hasUnresolvedOperands: false,
        generateBranches: [{ selected, alternatives: [other] }],
        inputs: [1, 2, 3, 4, 5].map(signal => ({ kind: "data", signal, location })),
        wordRead: { signal: 1, index: {
          op: "boundSelect", args: [2, { op: "signal", args: 3 }, { op: "unsignedBit", args: false }],
        } },
      },
      {
        kind: "continuous", targets: [0], location, hasUnresolvedOperands: false,
        generateBranches: [{ selected: other, alternatives: [selected] }],
        inputs: [{ kind: "data", signal: 1, location }],
        wordRead: { signal: 1, index: { op: "unsignedBit", args: false } },
      },
    ],
  };
  const design = {
    kind: "kdb",
    async portLinks() { return []; },
    async resolve(fullname) {
      if (fullname === "dut.many") return { fullname, kind: "npiGenScope", file, line: 6 };
      if (fullname === "dut.Top") return {
        fullname, instance: "dut", kind: "npiParameter", file, line: 3,
        parameterValue: { bits: "01", signed: false },
      };
      if (fullname === "dut.Enabled" || fullname === "dut.Other") return {
        fullname, instance: "dut", kind: "npiParameter", file,
        line: fullname === "dut.Enabled" ? 3 : 4,
        parameterValue: { bits: "1", signed: false },
      };
    },
  };
  const result = await expandInstanceTrace(
    trace, "dut", design, "drivers", { maxDepth: 2 }, source => pathToFileURL(source).href,
    async () => undefined,
  );
  assert.equal(result.assignments.length, 1);
  const pointer = result.signals.find(({ name }) => name === "ptr");
  assert.deepEqual(result.assignments[0].wordRead.index, { op: "select", args: [pointer.id, 1, 0] });
  assert.deepEqual(result.signals.find(({ name }) => name === "Enabled").instanceParameterValue, {
    bits: "1", signed: false,
  });
  assert.equal(result.signals.find(({ name }) => name === "Other").instanceParameterValue, undefined);
  assert(!result.frontier.some(({ reason }) => reason === "unresolvedGenerateBranch"));
});

test(
  "generate branches follow the actual Verilator specialization",
  { skip: !generateFixture },
  async () => {
    const tree = path.join(generateFixture, "generate.tree.json");
    const design = await VerilatorDesign.open(tree, [], [generateFixture]);
    const file = path.join(generateFixture, "generate_tb.sv");
    const uri = pathToFileURL(file).href;
    const label = (name, line, sourceLine) => ({
      uri,
      name,
      line: line - 1,
      byteColumn: sourceLine.indexOf(name),
    });
    const yes = label("yes", 6, "    if (SELECT) begin : yes");
    const no = label("no", 8, "    end else begin : no");
    const nested = label("nested", 9, "        if (NESTED) begin : nested");
    const location = { uri, range: { start: { line: 2, character: 0 } } };
    const assignment = (signal, branches) => ({
      kind: "continuous",
      location,
      targets: [0],
      inputs: [{ signal, kind: "data", edge: null, location }],
      generateBranches: branches,
      hasUnresolvedOperands: false,
    });
    const trace = {
      schemaVersion: 1,
      revision: "1",
      scope: "file",
      root: 0,
      frontier: [],
      diagnostics: [],
      signals: ["q", "a", "b"].map((name, id) => ({
        id,
        name,
        declaration: location,
      })),
      assignments: [
        assignment(1, [{ selected: yes, alternatives: [no] }]),
        assignment(2, [
          { selected: no, alternatives: [yes] },
          { selected: nested, alternatives: [] },
        ]),
      ],
    };
    const expand = (instance, graph = trace) =>
      expandInstanceTrace(
        graph,
        "generate_tb." + instance,
        design,
        "drivers",
        {},
        (file) => pathToFileURL(file).href,
        async () => undefined,
      );
    for (const [instance, input] of [
      ["p", "a"],
      ["n", "b"],
    ]) {
      const result = await expand(instance);
      assert.deepEqual(
        result.signals
          .filter((signal) => signal.instance.endsWith("." + instance))
          .map(({ name }) => name),
        ["q", input],
      );
      assert.equal(
        result.assignments.filter(({ kind }) => kind === "continuous").length,
        1,
      );
      assert(
        !result.frontier.some(
          ({ reason }) => reason === "unresolvedGenerateBranch",
        ),
      );
    }
    const anonymous = (line, column, end, uniqueLine = true) => ({
      uri, name: "", line: line - 1, byteColumn: column,
      blockEnd: [line - 1, end], uniqueLine,
    });
    const first = anonymous(23, 16, 34);
    const second = anonymous(24, 9, 27);
    const anonymousTrace = {
      ...trace,
      signals: [{ ...trace.signals[0], name: "probe" }, ...trace.signals.slice(1)],
      assignments: [
        assignment(1, [{ selected: first, alternatives: [second] }]),
        assignment(2, [{ selected: second, alternatives: [first] }]),
      ],
    };
    for (const [instance, input] of [["p", "a"], ["n", "b"]]) {
      const result = await expand(instance, anonymousTrace);
      assert.deepEqual(result.assignments.filter(({ kind }) => kind === "continuous")
        .map(({ inputs }) => result.signals.find(({ id }) => id === inputs[0].signal).name), [input]);
      assert(!result.frontier.some(({ reason }) => reason === "unresolvedGenerateBranch"));
    }
    const ambiguous = await expand("p", {
      ...trace,
      assignments: trace.assignments.map((item) => ({
        ...item,
        generateBranches: [{ selected: null, alternatives: [] }],
      })),
    });
    assert(
      ambiguous.frontier.some(
        ({ reason }) => reason === "unresolvedGenerateBranch",
      ),
    );
    assert.equal(
      ambiguous.assignments.filter(
        ({ hasUnresolvedOperands }) => hasUnresolvedOperands,
      ).length,
      2,
    );
  },
);

test("KDB identifies a unique anonymous generate line and preserves same-line candidates", async () => {
  const file = "/anonymous_generate.sv";
  const uri = pathToFileURL(file).href;
  const location = { uri, range: { start: { line: 1, character: 0 } } };
  const scope = { kind: "npiGenScope", fullname: "dut.genblk1", file, line: 5 };
  const design = {
    kind: "kdb",
    async children() { return [scope]; },
    async portLinks() { return []; },
    async resolve(fullname) { return fullname === scope.fullname ? scope : undefined; },
  };
  async function traceBranches(secondLine, uniqueLine) {
    const branches = [
      { name: "", uri, line: 4, byteColumn: 10, blockEnd: [4, 26], uniqueLine },
      { name: "", uri, line: secondLine, byteColumn: 28, blockEnd: [secondLine, 44], uniqueLine },
    ];
    return expandInstanceTrace({
      schemaVersion: 1, revision: "1", scope: "file", root: 0, diagnostics: [], frontier: [],
      signals: ["q", "a", "b"].map((name, id) => ({id, name, declaration: location})),
      assignments: branches.map((selected, index) => ({
        kind: "continuous", location, targets: [0], hasUnresolvedOperands: false,
        inputs: [{ kind: "data", signal: index + 1, location }],
        generateBranches: [{ selected, alternatives: [branches[1-index]] }],
      })),
    }, "dut", design, "drivers", {}, (file) => pathToFileURL(file).href, async () => undefined);
  }
  const selected = await traceBranches(5, true);
  assert.deepEqual(selected.signals.map(({ name }) => name), ["q", "a"]);
  assert.equal(selected.assignments.length, 1);
  assert(!selected.frontier.some(({ reason }) => reason === "unresolvedGenerateBranch"));

  const sharedLine = await traceBranches(4, false);
  assert.equal(sharedLine.assignments.length, 2);
  assert(sharedLine.assignments.every(({ hasUnresolvedOperands }) => hasUnresolvedOperands));
  assert(sharedLine.frontier.some(({ reason }) => reason === "unresolvedGenerateBranch"));
});

test("an absent generate scope requires proof that no branch matched", async () => {
  const file = "/sparse_generate.sv";
  const uri = pathToFileURL(file).href;
  const location = { uri, range: { start: { line: 1, character: 0 } } };
  const label = (name, line) => ({ name, uri, line, byteColumn: 5 });
  const scope = { fullname: "dut.lanes[-1]", file, line: 4, column: 6 };
  const design = {
    kind: "verilator",
    async resolve(fullname) {
      if (fullname === "dut") return { kind: "npiModule" };
    },
    async portLinks() { return []; },
    generateScopes(parent) { return parent === "dut" ? [scope] : []; },
  };
  const trace = {
    schemaVersion: 1, revision: "1", scope: "file", root: 0,
    diagnostics: [], frontier: [], signals: [{id: 0, name: "q", declaration: location}],
    assignments: [{
      kind: "continuous", location, targets: [0], inputs: [], hasUnresolvedOperands: false,
      generateBranches: [
        { selected: label("lanes", 3), alternatives: [], loopScope: true, loopVariable: "lane" },
        { selected: label("active", 4), alternatives: [] },
      ],
    }],
  };
  const lane = { op: "generateIndex", args: "lane" };
  const literal = (value) => ({
    op: "literal",
    args: [(value >>> 0).toString(2).padStart(32, "0"), true],
  });
  const ifCondition = (comparison) => ({
    loneIfCondition: { op: "binary", args: [comparison, lane, literal(0)] },
  });
  const caseMatch = (labels) => ({
    caseWithoutDefault: { selector: lane, labels },
  });
  const branch = trace.assignments[0].generateBranches[1];
  for (const [description, evidence, inactive] of [
    ["false if", ifCondition("greaterEqual"), true],
    ["true if", ifCondition("less"), false],
    ["no evidence", {}, false],
    ["no matching case label", caseMatch([literal(0), literal(1)]), true],
    ["later case label matches", caseMatch([literal(0), literal(-1)]), false],
    ["mixed label widths", caseMatch([literal(0), { op: "literal", args: ["1", false] }]), false],
    ["unknown genvar", caseMatch([{ op: "generateIndex", args: "missing" }]), false],
  ]) {
    const [assignment] = trace.assignments;
    const result = await expandInstanceTrace({
      ...trace,
      assignments: [{
        ...assignment,
        generateBranches: [assignment.generateBranches[0], { ...branch, ...evidence }],
      }],
    }, "dut", design, "drivers", {}, (source) => pathToFileURL(source).href, async () => undefined);
    assert.equal(result.assignments.length, inactive ? 0 : 1, description);
    assert.equal(result.frontier.some(({ reason }) => reason === "unresolvedGenerateBranch"), !inactive, description);
  }
});

test("trace requests wait for VIDE's startup index and preserve other failures", async () => {
  const response = { schemaVersion: 1 };
  const pending = Object.assign(
    new Error("VIDE is still indexing the trace project"),
    { code: -32801 },
  );
  let tries = 0;
  const api = {
    version: 1,
    capabilities: { staticTraceVersion: 1 },
    async traceDrivers() {
      if (++tries === 1) throw pending;
      return response;
    },
  };
  assert.equal(await queryTrace(api, "drivers", {}), response);
  assert.equal(tries, 2);
  const changed = Object.assign(new Error("RTL changed"), { code: -32801 });
  await assert.rejects(
    queryTrace(
      {
        ...api,
        async traceDrivers() {
          throw changed;
        },
      },
      "drivers",
      {},
    ),
    (error) => error === changed,
  );
});

test("VIDE results arriving after trace cancellation are discarded", async () => {
  const token = { isCancellationRequested: false };
  const api = {
    version: 1,
    capabilities: { staticTraceVersion: 1 },
    async traceLoads(_, receivedToken) {
      assert.equal(receivedToken, token);
      token.isCancellationRequested = true;
      return { schemaVersion: 1 };
    },
  };
  await assert.rejects(queryTrace(api, "loads", {}, token), /trace was cancelled/);
});

test("closing an isolated trace project invalidates its in-flight response", async () => {
  const { createStaticAnalysis } = require("../dist/wave-analysis-static");
  const project = {
    closed: false,
    async traceDrivers() {
      project.closed = true;
      return { schemaVersion: 1 };
    },
  };
  const { traceRtlPosition } = createStaticAnalysis({});
  const uri = new URL("file:///trace.sv");
  await assert.rejects(
    traceRtlPosition("drivers", uri, { line: 0, character: 0 }, {}, undefined, project),
    /trace project was closed/,
  );
});

test("the VIDE Trace client checks the API, capability, and wire schema separately", async () => {
  const request = {
    textDocument: { uri: "file:///fixture.sv" },
    position: { line: 9, character: 12 },
    options: { maxDepth: 3, includeCompilation: true },
  };
  const graph = {
    schemaVersion: 1, revision: "31", scope: "file", root: 2,
    signals: [{ id: 2, name: "ready", declaration: null }],
    assignments: [], frontier: [{ signal: 2, reason: "depth" }], diagnostics: [],
  };
  let calls = 0;
  const api = {
    version: 1,
    capabilities: { staticTraceVersion: 1 },
    async traceDrivers(params) {
      assert.deepEqual(JSON.parse(JSON.stringify(params)), request);
      calls += 1;
      return JSON.parse(JSON.stringify(graph));
    },
  };
  for (const incompatible of [
    undefined, { ...api, version: 2 }, { ...api, capabilities: {} },
    { ...api, capabilities: { staticTraceVersion: 2 } },
  ])
    await assert.rejects(queryTrace(incompatible, "drivers", request), /needs RTL trace schema 1/);
  await assert.rejects(queryTrace(api, "loads", request), /needs RTL trace schema 1/);
  assert.equal(calls, 0);
  for (const schemaVersion of [undefined, 0, 2, "1"]) {
    await assert.rejects(queryTrace({
      ...api,
      async traceDrivers() { return JSON.parse(JSON.stringify({ ...graph, schemaVersion })); },
    }, "drivers", request), /Unsupported VIDE trace result schema/);
  }
  const decoded = await queryTrace(api, "drivers", request);
  assert.deepEqual(decoded, graph);
  assert.equal(calls, 1);
});

test("automatic bit history can find a transition before unrelated bus activity", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "trace-bit-history-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "projected.vcd");
  const header = [
    "$timescale 1ns $end",
    "$scope module tb $end",
    "$var wire 2 ! q [1:0] $end",
    "$upscope $end",
    "$enddefinitions $end",
    "#0",
    "b0 !",
    "#5",
    "b10 !",
    "#400",
    "b11 !",
    "#450",
    "b10 !",
    "#500",
    "b11 !",
  ];
  await fs.writeFile(file, header.join("\n") + "\n");
  const backend = new Backend(
    path.resolve(__dirname, "../bin/wave-backend-independent"),
    {
      useVerdiLibraries: false,
    },
  );
  t.after(() => backend.dispose());
  const metadata = await backend.request("open", { path: file });
  const root = {
    ...metadata.signals[0],
    width: 1,
    sourceWidth: 2,
    bitOffset: 1,
  };
  const data = await readTraceObservations(
    backend,
    metadata,
    new Map([[0, root]]),
    "500",
    "auto",
    0,
  );
  assert.equal(data.historyEnd, "5");
  assert.equal(data.observations[0].value, "1");
  assert.deepEqual(data.observations[0].history.at(-1), {
    tick: "5",
    value: "1",
  });
  const whole = await readTraceObservations(
    backend,
    metadata,
    new Map([[0, metadata.signals[0]]]),
    "5",
    "0",
  );
  assert.deepEqual(whole.observations[0].history, [
    { tick: "0", value: "00" },
    { tick: "5", value: "10" },
  ]);

  const dense = path.join(directory, "dense.vcd");
  const changes = Array.from({ length: 350 }, (_, offset) => {
    const tick = offset + 1;
    return "#" + tick + "\nb" + (tick >= 300 ? "1" : "0") + (tick % 2) + " !";
  });
  await fs.writeFile(
    dense,
    [header[0].replace("1ns", "1ps"), ...header.slice(1, 7), ...changes].join(
      "\n",
    ) + "\n",
  );
  const denseMetadata = await backend.request("open", { path: dense });
  const denseHistory = await readTraceObservations(
    backend,
    denseMetadata,
    new Map([[0, root]]),
    "350",
    "auto",
    0,
  );
  assert.equal(denseHistory.historyEnd, "300");
  assert.equal(denseHistory.observations[0].value, "1");
  assert.equal(denseHistory.observations[0].historyLimitedToTransition, true);
  assert.deepEqual(denseHistory.observations[0].initial, {
    tick: "299",
    value: "0",
  });
  assert.deepEqual(denseHistory.observations[0].history, [
    { tick: "300", value: "1" },
  ]);

  const held = path.join(directory, "held.vcd");
  const heldBody = ["#0", "b0 !", "#400", "b1 !", "#450", "b0 !", "#500", "b1 !"];
  const readHeld = async (body) => {
    await fs.writeFile(held, [...header.slice(0, 5), ...body].join("\n") + "\n");
    const metadata = await backend.request("open", { path: held });
    return readTraceObservations(
      backend, metadata, new Map([[0, { ...metadata.signals[0], width: 1, sourceWidth: 2, bitOffset: 1 }]]),
      "500", "auto", 0,
    );
  };
  const trace = { root: 0, signals: [{ id: 0 }], assignments: [], frontier: [] };
  const heldHistory = await readHeld(heldBody);
  assert.equal(heldHistory.historyEnd, "0");
  assert.equal(heldHistory.observations[0].value, "0");
  assert.deepEqual(heldHistory.observations[0].history, [{ tick: "0", value: "0" }]);
  assert.deepEqual(buildTemporalTrace(trace, heldHistory).nodes, [
    { signal: 0, bit: 1, tick: "0", value: "0", initialSample: true },
  ]);

  const lateHistory = await readHeld(["#20", ...heldBody.slice(1)]);
  assert.equal(lateHistory.historyEnd, "500");
  assert.equal(buildTemporalTrace(trace, lateHistory).nodes.length, 0);
});

test("static trace marks feedback without treating shared fan-in as a loop", () => {
  const location = {
    uri: "file:///trace.sv",
    range: { start: { line: 3, character: 0 } },
  };
  const assignment = (target, ...sources) => ({
    kind: "blocking",
    location,
    targets: [target],
    inputs: sources.map((signal) => ({ signal, kind: "data", location })),
  });
  const trace = {
    root: 8,
    scope: "file",
    revision: "fixture",
    frontier: [],
    diagnostics: [],
    signals: [
      [4, "input"],
      [8, "result"],
      [12, "state"],
    ].map(([id, name]) => ({ id, name })),
    assignments: [assignment(8, 4, 12), assignment(12, 4)],
  };
  assert.deepEqual(traceFeedback(trace), []);
  trace.assignments.push(assignment(12, 12));
  assert.deepEqual(traceFeedback(trace), [
    { assignment: 2, signal: 12, side: "target" },
  ]);
  assert.match(traceMermaid(trace), /class a2 feedback/);
  assert.match(traceReport(trace, "drivers"), /Feedback loops\n\n- state/);
  const first = staticTracePage(trace, "drivers", "tb.result", 2);
  assert.deepEqual(first.trace.assignments, trace.assignments.slice(0, 2));
  assert.equal(first.page.assignmentOffset, 0);
  const next = staticTracePage(
    { ...trace, revision: "second-server" },
    "drivers",
    "tb.result",
    undefined,
    first.page.nextCursor,
  );
  assert.deepEqual(next.trace.assignments, trace.assignments.slice(2));
  assert.deepEqual(
    next.trace.signals.map((s) => s.id),
    [8, 12],
  );
  assert.equal(next.page.nextCursor, undefined);
  trace.assignments.pop();
  assert.throws(
    () =>
      staticTracePage(
        trace,
        "drivers",
        "tb.result",
        undefined,
        first.page.nextCursor,
      ),
    /graph changed/,
  );
});

test("packed tracing follows selected bits in both directions and preserves feedback", () => {
  const { focusPackedTrace } = require("../dist/rtl-trace-bits");
  const location = {
    uri: "file:///trace.sv",
    range: { start: { line: 0, character: 0 } },
  };
  const names = ["lane", "seed", "decoy", "enable", "state", "ascending"];
  const signals = names.map((name, id) => ({ id, name }));
  const widths = [6, 1, 1, 1, 1, 2];
  const bindings = new Map(
    names.map((name, id) => [
      id,
      {
        name: id === 0 ? name + "[5:0]" : id === 5 ? name + "[0:1]" : name,
        width: widths[id],
      },
    ]),
  );
  const input = (signal) => ({ signal, kind: "data", location });
  const assign = (target, targetRange, inputs, value) => ({
    kind: "continuous",
    location,
    targets: [target],
    targetRange,
    inputs: inputs.map(input),
    value,
  });
  const signal = (id) => ({ op: "signal", args: id });
  const select = (index) => ({ op: "select", args: [0, index, index] });
  const trace = {
    root: 5,
    signals,
    diagnostics: [],
    frontier: [],
    assignments: [
      assign(0, [0, 0], [1], signal(1)),
      assign(0, [1, 1], [2], signal(2)),
      assign(0, [2, 2], [0], select(0)),
      assign(0, [3, 3], [0, 3], {
        op: "binary",
        args: ["bitAnd", select(2), signal(3)],
      }),
      assign(0, [4, 4], [0], select(5)),
      assign(0, [5, 5], [4], signal(4)),
      assign(4, undefined, [0], select(4)),
      assign(5, [0, 1], [2, 0], { op: "concat", args: [signal(2), select(3)] }),
    ],
  };
  const selected = focusPackedTrace(trace, 1, "drivers", bindings);
  assert.deepEqual(
    selected.signals.map((s) => s.name),
    ["lane", "seed", "enable", "ascending"],
  );
  assert.deepEqual(
    selected.assignments.map((a) => a.targetRange),
    [
      [0, 0],
      [2, 2],
      [3, 3],
      [0, 1],
    ],
  );
  assert.deepEqual(
    selected.assignments.at(-1).inputs.map((i) => [i.signal, i.readBits]),
    [[0, [3]]],
  );
  assert.equal(selected.assignments.at(-1).value, undefined);
  assert.deepEqual(traceFeedback(selected), []);
  const limited = focusPackedTrace({
    ...trace,
    signals: trace.signals.map((node) => ({ ...node, instance: "top" })),
    frontier: [{ signal: 0, reason: "depth" }],
  }, 1, "drivers", bindings);
  const [stop] = staticTraceCoverage(limited).stops;
  assert.deepEqual(stop.continuationSignals, ["top.lane[0]", "top.lane[2]", "top.lane[3]"]);
  assert(staticTracePage(limited, "drivers", "top.ascending[1]", 1).trace.signals
    .some(({ id }) => id === stop.signal));
  const [missing, mapped] = staticTraceCoverage({
    ...limited,
    frontier: [
      { signal: 0, reason: "depth", bits: [0], continuation: null },
      { signal: 0, reason: "depth", bits: [2], continuation: { signal: "dump.lane", bits: [2] } },
      { signal: 0, reason: "depth", bits: [3], continuation: { signal: "dump.lane", bits: [3] } },
    ],
  }).stops;
  assert.deepEqual(missing.unavailableBits, [0]);
  assert.equal(missing.waveformUnavailable, true);
  assert.equal(missing.canRetrace, false);
  assert.deepEqual(mapped.continuationSignals, ["dump.lane[2]", "dump.lane[3]"]);
  assert.equal(mapped.waveformUnavailable, undefined);
  const clipped = focusPackedTrace({
    ...trace,
    signals: signals.map((node) => node.id === 0 ? { ...node, packedRange: [5, 0] } : node),
    frontier: [{ signal: 0, reason: "depth" }],
    assignments: [assign(5, undefined, [0], signal(0))],
  }, [0, 1], "drivers", new Map(bindings).set(0, { name: "lane[1:1]", width: 1 }));
  assert.deepEqual(clipped.frontier[0].bits, [0, 1]);
  assert.deepEqual(clipped.assignments[0].inputs[0].readBits, [0, 1]);
  const cycles = focusPackedTrace(
    { ...trace, root: 0 },
    4,
    "drivers",
    bindings,
  );
  assert.equal(cycles.assignments.length, 3);
  assert.equal(traceFeedback(cycles).length, 1);
  assert.match(traceMermaid(selected), /data #91;3#93;/);

  const loadRange = focusPackedTrace(
    { ...trace, root: 0 },
    [3, 2],
    "loads",
    bindings,
  );
  assert.deepEqual(loadRange.bitSelection.range, [3, 2]);
  assert.deepEqual(traceFeedback(loadRange), []);
  assert.deepEqual(
    loadRange.assignments.map((assignment) => assignment.writtenBits),
    [[3], [1]],
  );
  assert.deepEqual(
    loadRange.assignments.at(-1).inputs.map((input) => input.signal),
    [0],
  );
  assert(loadRange.signals.some(({ name }) => name === "enable"));
  assert.deepEqual(loadRange.assignments.at(-1).bitDependencies, [
    { targetBit: 1, reads: [{ signal: 0, bits: [3] }] },
  ]);
  assert.match(traceMermaid(loadRange), /lan[e]#91;3:2#93;/);

  const unknown = focusPackedTrace(
    {
      ...trace,
      root: 0,
      assignments: [
        assign(5, [0, 1], [0, 3], {
          op: "bitSelect",
          args: [0, signal(3)],
        }),
      ],
    },
    2,
    "loads",
    bindings,
  );
  assert.deepEqual(unknown.assignments[0].writtenBits, [1]);
  assert.deepEqual(unknown.assignments[0].bitDependencies, []);
  assert(
    unknown.assignments[0].inputs.every(
      ({ readBits }) => readBits === undefined,
    ),
  );

  const wide = focusPackedTrace(
    { ...trace, root: 0, assignments: [assign(5, undefined, [0], signal(0))] },
    [255, 1],
    "loads",
    new Map([
      [0, { name: "lane[255:0]", width: 256 }],
      [5, { name: "ascending[0:255]", width: 256 }],
    ]),
  );
  assert.deepEqual(wide.frontier, []);
  assert.equal(wide.assignments[0].writtenBits.length, 255);
  assert.deepEqual(wide.assignments[0].bitDependencies[0], {
    targetBit: 0,
    reads: [{ signal: 0, bits: [255] }],
  });

  const observed = (signal, width, range, before, changes, bit) => ({
    signal,
    width,
    range,
    bit,
    projected: bit !== undefined,
    initial: { tick: "0", value: before },
    history: changes.map(([tick, value]) => ({ tick, value })),
  });
  const lane = observed(0, 6, [5, 0], "000000", [
    ["5", "001101"],
    ["6", "001111"],
  ]);
  const inputs = [
    observed(1, 1, undefined, "0", [["5", "1"]]),
    observed(2, 1, undefined, "0", [["6", "1"]]),
    observed(3, 1, undefined, "0", [["5", "1"]]),
  ];
  const temporal = buildTemporalTrace(trace, {
    tick: "6",
    observations: [
      lane,
      ...inputs,
      observed(5, 1, [0, 1], "0", [["5", "1"]], 1),
    ],
  });
  assert.deepEqual(
    temporal.nodes
      .filter(({ signal, sampleOnly }) => signal === 0 && !sampleOnly)
      .map(({ bit, tick }) => [bit, tick]),
    [
      [3, "5"],
      [2, "5"],
      [0, "5"],
    ],
  );
  assert(
    temporal.nodes.some(({ signal, tick }) => signal === 1 && tick === "5"),
  );
  assert(!temporal.nodes.some(({ signal }) => signal === 2));
  assert(temporal.edges.some(({ timing }) => timing === "sameTickUnordered"));

  const sameBus = buildTemporalTrace(
    { ...trace, root: 0 },
    {
      tick: "6",
      wholeRoot: lane,
      observations: [...inputs, observed(0, 1, [5, 0], "0", [["5", "1"]], 2)],
    },
  );
  assert(
    sameBus.nodes.some(
      ({ signal, bit, tick }) => signal === 0 && bit === 0 && tick === "5",
    ),
  );
  assert(
    !sameBus.missingEvidence.some(
      ({ reason }) => reason === "projectedDependency",
    ),
  );
});

test(
  "Verilator port slices preserve the endpoints and their declared bit order",
  {
    skip: !portSliceFixture,
  },
  async (t) => {
    const file = path.join(portSliceFixture, "port_slice.fst");
    const backend = new Backend(
      path.resolve(__dirname, "../bin/wave-backend-independent"),
      {
        useVerdiLibraries: false,
      },
    );
    t.after(() => backend.dispose());
    const metadata = await backend.request("open", { path: file });
    const tree = path.join(
      portSliceFixture,
      "obj_dir/Vport_slice_tb.tree.json",
    );
    const design = await VerilatorDesign.open(tree, metadata.signals, [
      portSliceFixture,
    ]);
    const instance = "port_slice_tb";
    const dut = instance + ".dut";
    const [input] = await design.portLinks(dut, "request");
    assert.deepEqual(input.from, {
      instance,
      signal: "tb_request",
      range: [2, 3],
    });
    assert.deepEqual(input.to, { instance: dut, signal: "request" });
    const [output] = await design.portLinks(instance, "dut_response");
    assert.deepEqual(output.from, { instance: dut, signal: "result" });
    assert.deepEqual(output.to, {
      instance,
      signal: "dut_response",
      range: [5, 4],
    });
    assert.equal(
      design.unresolvedPortExpression(dut, "masked", "drivers"),
      true,
    );
    assert.equal(
      design.unresolvedPortExpression(dut, "request", "drivers"),
      false,
    );
    assert.equal(
      design.unresolvedPortExpression(instance, "tb_request", "loads"),
      true,
    );
    assert.equal(
      design.unresolvedPortExpression(instance, "tb_request", "drivers"),
      false,
    );
    assert.equal(
      design.unresolvedPortExpression(dut, "constant_select", "drivers"),
      false,
    );
    assert.equal(design.constantPortDriver(dut, "constant_select").bits, "1");
    const load = async ({ instance, signal }) => {
      const source = await design.resolve(instance + "." + signal);
      return {
        schemaVersion: 1,
        revision: "port-fixture",
        scope: "file",
        root: 0,
        signals: [
          {
            id: 0,
            name: signal,
            declaration: {
              uri: source.file,
              range: { start: { line: source.line - 1, character: 0 } },
            },
          },
        ],
        assignments: [],
        frontier: [],
        diagnostics: [],
      };
    };
    for (const [node, field, range, expected] of [
      [
        { instance: dut, signal: "request" },
        "fromRange",
        [2, 3],
        "tb\\_request\\[2:3\\]",
      ],
      [
        { instance, signal: "dut_response" },
        "toRange",
        [5, 4],
        "dut\\_response\\[5:4\\]",
      ],
    ]) {
      const trace = await expandInstanceTrace(
        await load(node),
        node.instance,
        design,
        "drivers",
        {},
        (file) => file,
        load,
      );
      assert.deepEqual(trace.assignments[0].port[field], range);
      assert(traceReport(trace, "drivers").includes(expected));
      assert.match(
        traceMermaid(trace),
        new RegExp("#91;" + range.join(":") + "#93;"),
      );
      assert.equal(staticTraceCoverage(trace).status, "resolvedWithinScope");
    }
    const unsupported = { instance: dut, signal: "masked" };
    const partial = await expandInstanceTrace(
      await load(unsupported),
      dut,
      design,
      "drivers",
      {},
      (file) => file,
      load,
    );
    assert.deepEqual(partial.frontier, [
      { signal: partial.root, reason: "unresolvedPortExpression" },
    ]);
    assert.deepEqual(staticTraceCoverage(partial).stops, [
      {
        signal: partial.root,
        path: dut + ".masked",
        reason: "unresolvedPortExpression",
        canRetrace: false,
      },
    ]);
    assert.match(traceReport(partial, "drivers"), /unresolved port expression/);
    partial.frontier.push(
      { signal: partial.root, reason: "depth" },
      { signal: partial.root, reason: "depth" },
    );
    assert.deepEqual(staticTraceCoverage(partial).stops.at(-1), {
      signal: partial.root,
      path: dut + ".masked",
      reason: "depth",
      canRetrace: true,
    });
    assert.equal(staticTraceCoverage(partial).stops.length, 2);
    assert.equal(staticTraceCoverage(partial).status, "partial");
    const constant = { instance: dut, signal: "constant_select" };
    const selected = { instance: dut, signal: "result" };
    const staleLoad = await expandInstanceTrace(
      await load(selected),
      dut,
      design,
      "loads",
      {},
      (file) => file,
      async (port) => {
        const trace = await load(port);
        if (port.signal === "dut_response")
          trace.signals[0].declaration.range.start.line++;
        return trace;
      },
    );
    assert.equal(staticTraceCoverage(staleLoad).status, "partial");
    assert.equal(staleLoad.assignments.length, 0);
    const lostPort = staticTraceCoverage(staleLoad).stops.find(
      ({ signal, reason }) => signal === staleLoad.root && reason === "unresolvedPort",
    );
    assert.deepEqual(lostPort?.locations, [{
      uri: output.file,
      range: { start: { line: output.line - 1, character: 0 } },
    }]);
    assert.match(traceReport(staleLoad, "loads"), /unresolved port connection/);
    const driven = await expandInstanceTrace(
      await load(constant),
      dut,
      design,
      "drivers",
      {},
      (file) => file,
      load,
    );
    assert.deepEqual(driven.assignments[0].value, {
      op: "literal",
      args: ["1", false],
    });
    assert.deepEqual(driven.assignments[0].inputs, []);
    assert.match(traceMermaid(driven), /Port constant 1/);
    assert.match(traceReport(driven, "drivers"), /Port constant `1`/);
  },
);

test("evaluates four-state RHS expressions and preserves packed range direction", () => {
  const signal = (args) => ({ op: "signal", args });
  const literal = (bits) => ({ op: "literal", args: [bits, false] });
  const binary = (op, lhs, rhs) => ({ op: "binary", args: [op, lhs, rhs] });
  const select = { op: "select", args: [0, 1, 2] };
  const concat = { op: "concat", args: [select, literal("z")] };
  const mux = { op: "conditional", args: [signal(1), concat, signal(2)] };
  const operands = [
    { width: 4, bits: "1x10", range: [0, 3] },
    { width: 1, bits: "x" },
    { width: 3, bits: "11z" },
  ];
  const evalValue = (expression, width) =>
    evaluateTraceValue(expression, width, (id) => operands[id]);
  assert.deepEqual(evalValue(mux, 3), {
    bits: "x1z",
    inputs: [1, 0, 2],
    signed: false,
  });
  operands[1].bits = "1";
  operands[2].bits = undefined;
  assert.deepEqual(evalValue(mux, 3), {
    bits: "x1z",
    inputs: [1, 0],
    signed: false,
  });
  assert.equal(
    evalValue(binary("caseEqual", concat, literal("x1z")), 1).bits,
    "1",
  );
  assert.equal(evalValue(binary("equal", concat, literal("x1z")), 1).bits, "x");
  assert.equal(evalValue(binary("equal", concat, literal("000")), 1).bits, "0");
  assert.equal(
    evalValue(binary("add", literal("11"), literal("01")), 2).bits,
    "00",
  );
  assert.equal(
    evalValue(binary("add", literal("11"), literal("01")), 3).bits,
    "100",
  );
  const signed = (bits) => ({ op: "literal", args: [bits, true] });
  assert.equal(
    evalValue(binary("add", signed("11"), signed("001")), 4).bits,
    "0000",
  );
  assert.equal(
    evalValue(binary("add", signed("11"), literal("001")), 4).bits,
    "0100",
  );
  assert.equal(
    evalValue(binary("caseEqual", signed("1"), signed("111")), 1).bits,
    "1",
  );
  assert.equal(
    evalValue(binary("caseItemEqual", signed("1"), signed("111")), 1),
    undefined,
  );
  assert.equal(
    evalValue(binary("less", signed("11"), signed("001")), 1).bits,
    "1",
  );
  assert.equal(
    evalValue(binary("less", signed("11"), literal("001")), 1).bits,
    "0",
  );
  assert.equal(
    evalValue(binary("greaterEqual", literal("11"), literal("011")), 1).bits,
    "1",
  );
  assert.equal(
    evalValue(binary("greater", literal("x1"), literal("00")), 1).bits,
    "x",
  );
  assert.equal(
    evalValue(binary("caseItemZ", literal("1z"), literal("10")), 1).bits,
    "1",
  );
  assert.equal(
    evalValue(binary("caseItemZ", literal("1x"), literal("10")), 1).bits,
    "0",
  );
  assert.equal(
    evalValue(binary("caseItemX", literal("1x"), literal("10")), 1).bits,
    "1",
  );
  assert.equal(
    evalValue(binary("multiply", signed("1001"), signed("0011")), 8).bits,
    "11101011",
  );
  assert.equal(
    evalValue(binary("divide", signed("1001"), signed("0011")), 8).bits,
    "11111110",
  );
  assert.equal(
    evalValue(binary("modulo", signed("1001"), signed("0011")), 8).bits,
    "11111111",
  );
  assert.equal(
    evalValue(binary("divide", literal("11"), literal("00")), 4).bits,
    "xxxx",
  );
  assert.equal(
    evalValue(binary("shiftLeft", signed("1001"), literal("10")), 8).bits,
    "11100100",
  );
  assert.equal(
    evalValue(binary("arithmeticShiftRight", signed("1001"), literal("10")), 8)
      .bits,
    "11111110",
  );
  assert.equal(
    evalValue(binary("shiftRight", signed("1001"), literal("10")), 8).bits,
    "00111110",
  );
  assert.equal(
    evalValue(binary("shiftLeft", literal("1"), literal("0x")), 4).bits,
    "xxxx",
  );
  assert.equal(
    evalValue(binary("shiftRight", literal("10z0"), literal("01")), 4).bits,
    "010z",
  );
  assert.equal(
    evalValue(binary("arithmeticShiftRight", signed("1001"), signed("11")), 2)
      .bits,
    "11",
  );
  const cast = (width, signed, twoState, input) => ({
    op: "cast",
    args: [width, signed, twoState, input],
  });
  assert.equal(
    evalValue(cast(null, true, false, literal("1001")), 8).bits,
    "11111001",
  );
  assert.equal(
    evalValue(cast(null, false, false, signed("1001")), 8).bits,
    "00001001",
  );
  assert.equal(
    evalValue(cast(8, true, true, signed("1x01")), 8).bits,
    "11111001",
  );
  assert.equal(
    evalValue(cast(8, true, false, signed("1x01")), 8).bits,
    "11111x01",
  );
  assert.equal(evalValue(cast(1, false, true, literal("1z")), 4).bits, "0000");
  assert.equal(evalValue(signal(0), 5), undefined);
  const indexed = { op: "bitSelect", args: [0, signal(1)] };
  operands[1] = { width: 2, bits: "10", signed: false };
  assert.deepEqual(evalValue(indexed, 1), {
    bits: "1",
    inputs: [1, 0],
    signed: false,
  });
  operands[1].bits = "x0";
  assert.deepEqual(evalValue(indexed, 1), {
    bits: "x",
    inputs: [1],
    signed: false,
  });
  operands[1].bits = "11";
  operands[1].signed = true;
  assert.deepEqual(evalValue(indexed, 1), {
    bits: "x",
    inputs: [1],
    signed: false,
  });
});

test("packed tracing retains RHS bits through an unresolved guard", () => {
  const { focusPackedTrace } = require("../dist/rtl-trace-bits");
  const location = {
    uri: "file:///trace.sv",
    range: { start: { line: 0, character: 0 } },
  };
  const assignment = {
    kind: "nonblocking",
    location,
    targets: [0],
    targetRange: [3, 3],
    inputs: [{ signal: 1, kind: "data", location }],
    guards: [{ location, takenWhenTrue: true, expression: null }],
    value: { op: "select", args: [1, 0, 0] },
    hasUnresolvedOperands: true,
    unresolvedControlOnly: true,
  };
  const trace = {
    root: 0,
    signals: [{ id: 0, name: "q" }, { id: 1, name: "data" }],
    diagnostics: [],
    frontier: [],
    assignments: [assignment],
  };
  const bindings = new Map([
    [0, { name: "q[3:0]", width: 4 }],
    [1, { name: "data[1:0]", width: 2 }],
  ]);
  const focused = focusPackedTrace(trace, 3, "drivers", bindings);
  assert.deepEqual(focused.assignments[0].bitDependencies, [
    { targetBit: 3, reads: [{ signal: 1, bits: [0] }] },
  ]);
  assert.equal(staticTraceCoverage(focused).status, "partial");
  const observations = [
    { signal: 0, width: 1, range: [3, 0], bit: 3, projected: true,
      initial: { tick: "0", value: "0" }, history: [{ tick: "2", value: "1" }] },
    { signal: 1, width: 2, range: [1, 0], initial: { tick: "0", value: "00" },
      history: [{ tick: "1", value: "01" }] },
  ];
  const temporal = buildTemporalTrace(focused, { tick: "2", observations });
  assert(temporal.nodes.some(({ signal, bit }) => signal === 1 && bit === 0));
  assert(temporal.edges.some(({ kind, confidence }) =>
    kind === "data" && confidence === "possible"));
  const budget = { ...focused, assignments: focused.assignments.map((relation) =>
    ({ ...relation, hasUnresolvedOperands: false })), frontier: [{ signal: 1, reason: "depth", bits: [0] }] };
  const covered = buildTemporalTrace(budget, { tick: "2", observations });
  assert(covered.coverage.reasons.includes("staticTraversalBudget"));
  assert(!covered.coverage.reasons.includes("staticFrontier"));
  budget.frontier[0].bits.push(1);
  const partiallyCovered = buildTemporalTrace(budget, { tick: "2", observations });
  assert(partiallyCovered.coverage.reasons.includes("staticTraversalBudget"));
  assert(partiallyCovered.coverage.reasons.includes("staticFrontier"));
  const loads = { ...trace, root: 1 };
  assert.equal(focusPackedTrace(loads, 1, "loads", bindings).assignments.length, 0);
  delete assignment.unresolvedControlOnly;
  assert.deepEqual(focusPackedTrace(trace, 3, "drivers", bindings).assignments[0].bitDependencies, []);
  assert.equal(focusPackedTrace(loads, 1, "loads", bindings).assignments.length, 1);
});

test("repeated assignment evidence leaves room for upstream temporal edges", () => {
  const write = (target, source) => ({
    kind: "blocking",
    targets: [target],
    inputs: [{ signal: source, kind: "data" }],
    hasUnresolvedOperands: true,
  });
  const trace = {
    root: 0,
    assignments: [...Array.from({ length: 1024 }, () => write(0, 1)), write(1, 2)],
  };
  const evidence = {
    tick: "7",
    observations: ["7", "5", "3"].map((tick, signal) => ({
      signal, width: 1, initial: { value: "0" }, history: [{ tick, value: "1" }],
    })),
  };
  const result = buildTemporalTrace(trace, evidence);
  assert.deepEqual(result.edges.map(({ source, target }) => [source, target]), [[1, 0], [2, 1]]);
  assert.equal(result.edges[0].assignment, 0);
  assert.deepEqual(result.edges[0].alsoAssignments, Array.from({ length: 1023 }, (_, i) => i + 1));
  assert.equal(result.edges[1].assignment, 1024);
  assert(!result.coverage.reasons.includes("traversalBudget"));
  const pli = buildTemporalTrace(trace, { ...evidence, externalPliCallbacks: true });
  assert.equal(pli.coverage.status, "partial");
  assert.deepEqual(pli.coverage.reasons, [...result.coverage.reasons, "externalPliCallbacks"]);
  assert.deepEqual(pli.edges, result.edges);
});

test("equal-width direct ports retain compatible same-tick samples", () => {
  const trace = {
    root: 0,
    assignments: [{ kind: "port", targets: [0], inputs: [{ signal: 1, kind: "data" }] }],
  };
  const evidence = {
    tick: "7",
    observations: [
      { signal: 0, width: 2, initial: { value: "00" }, history: [{ tick: "7", value: "10" }] },
      { signal: 1, width: 2, initial: { value: "00" }, history: [
        { tick: "5", value: "01" },
        { tick: "7", value: "10", orderAtTick: 0 },
        { tick: "7", value: "11", orderAtTick: 1 },
      ] },
    ],
  };
  const result = buildTemporalTrace(trace, evidence);
  assert.deepEqual(result.edges.map(({ source, timing }) => [result.nodes[source].value, timing]), [
    ["10", "sameTickUnordered"],
  ]);
  const differentWidth = {
    ...evidence,
    observations: [evidence.observations[0], { ...evidence.observations[1], width: 3 }],
  };
  assert.equal(buildTemporalTrace(trace, differentWidth).edges.length, 3);
});

test("a single undelayed continuous driver narrows only compatible RHS samples", () => {
  const assignment = {
    kind: "continuous", delayFreeContinuous: true, targets: [0],
    inputs: [1, 2].map(signal => ({ kind: "data", signal })),
    value: { op: "binary", args: ["bitXor", { op: "signal", args: 1 }, { op: "signal", args: 2 }] },
  };
  const trace = { root: 0, scope: "elaborated", assignments: [assignment] };
  const observations = [
    ["1", ["0"]],
    ["0", ["1"]],
    ["1", ["0"]],
  ].map(([value, changes], signal) => ({
    signal, width: 1, initial: { tick: "2", value },
    history: changes.map(value => ({ tick: "4", value })),
  }));
  const evidence = { tick: "4", observations };
  const samples = (result) => result.edges.map(({ source, timing, rhsSample, rhsSampleEvidence }) => {
    const { signal, value } = result.nodes[source];
    return [signal, value, timing, rhsSample, rhsSampleEvidence];
  });
  // Either old/new pair makes XOR change to zero. Keep both schedules.
  assert.equal(samples(buildTemporalTrace(trace, evidence)).length, 4);

  // If input 2 holds high, only input 1's new value gives XOR zero.
  const held = { ...evidence, observations: [
    ...observations.slice(0, 2), { ...observations[2], history: [] },
  ] };
  const fromInput1 = (graph) => samples(graph).filter(([signal]) => signal === 1);
  assert.deepEqual(fromInput1(buildTemporalTrace(trace, held)), [
    [1, "1", "sameTickUnordered", "matches", "waveformCombination"],
  ]);
  for (const uncertain of [
    { ...trace, assignments: [{ ...assignment, delayFreeContinuous: undefined }] },
    { ...trace, assignments: [assignment, { kind: "continuous", targets: [0], inputs: [] }] },
    { ...trace, frontier: [{ signal: 0, reason: "depthBudget" }] },
    { ...trace, compilation: { complete: false } },
  ]) {
    assert.equal(fromInput1(buildTemporalTrace(uncertain, held)).length, 2);
  }
});

test("continuous RHS callback attribution is per output change and requires a unique entry", () => {
  const trace = {
    root: 0, scope: "elaborated", assignments: [{
      kind: "continuous", delayFreeContinuous: true, targets: [0],
      inputs: [1, 2].map(signal => ({ kind: "data", signal })),
      value: { op: "binary", args: ["bitXor", { op: "signal", args: 1 }, { op: "signal", args: 2 }] },
    }],
  };
  function causes(records, callbackRecords = records) {
    const observations = records.map((changes, signal) => ({
      signal, width: 1, initial: { tick: "2", value: "0" },
      history: changes.map(([, value]) => ({ tick: "4", value })),
    }));
    const { nodes, edges } = buildTemporalTrace(trace, {
      tick: "4", observations,
      recordedValueCallbacks: signal =>
        callbackRecords[signal]?.map(([ordinal, value]) => ({ ordinal, value })),
    });
    return edges.flatMap(edge => edge.continuousCause
      ? [[nodes[edge.source].signal, nodes[edge.target].orderAtTick, edge.continuousCause]]
      : []);
  }
  const twoOutputs = [[[1, "1"], [3, "0"]], [[0, "1"]], [[2, "1"]]];
  assert.deepEqual(causes(twoOutputs), [
    [2, 2, { sourceOrdinal: 2, targetOrdinal: 3 }],
    [1, 1, { sourceOrdinal: 0, targetOrdinal: 1 }],
  ]);
  assert.deepEqual(causes(twoOutputs, twoOutputs.slice(0, 2)), []);
  assert.deepEqual(causes(twoOutputs, [twoOutputs[0], [[0, "0"]], twoOutputs[2]]), []);
  assert.deepEqual(causes([
    [[3, "1"]], [[0, "1"], [1, "0"], [2, "1"]], [],
  ]), []);
});

test("same-tick shift narrows only when all matching samples agree", () => {
  const assignment = {
    kind: "continuous", delayFreeContinuous: true, targets: [0],
    targetRange: [7, 0],
    inputs: [1, 2].map(signal => ({ kind: "data", signal })),
    value: { op: "binary", args: ["shiftLeft", { op: "signal", args: 1 }, { op: "signal", args: 2 }] },
  };
  const trace = { root: 0, scope: "elaborated", assignments: [assignment] };
  function fromData(value, endData) {
    const observations = [
      { signal: 0, width: 1, range: [7, 0], projected: true, bit: 5,
        initial: { tick: "0", value: value === "1" ? "0" : "1" },
        history: [{ tick: "4", value }] },
      { signal: 1, width: 4, range: [4, 7], signed: false,
        initial: { tick: "0", value: "0000" }, history: [{ tick: "4", value: endData }] },
      { signal: 2, width: 3, range: [2, 0], signed: false,
        initial: { tick: "0", value: "011" }, history: [{ tick: "4", value: "010" }] },
    ];
    const { nodes, edges } = buildTemporalTrace(trace, { tick: "4", observations });
    return edges.map(({ source, role, timing }) => [nodes[source].signal, nodes[source].bit, role, timing]);
  }
  assert.deepEqual(fromData("1", "1000"), [
    [1, 4, undefined, "sameTickUnordered"],
    [2, undefined, "index", "sameTickUnordered"],
  ]);
  const ambiguous = fromData("1", "1100");
  assert(ambiguous.some(([signal, bit]) => signal === 1 && bit === undefined));
  assert(ambiguous.some(([signal, , role]) => signal === 2 && role === "index"));
});

test("packed mux paths retain the condition and the lanes used by four-state evaluation", () => {
  const signal = (args) => ({ op: "signal", args });
  const assignment = {
    kind: "continuous", delayFreeContinuous: true, targets: [0], targetRange: [3, 0],
    inputs: [1, 2, 3].map(signal => ({ kind: "data", signal })),
    value: { op: "conditional", args: [signal(1), signal(2), signal(3)] },
  };
  const trace = { root: 0, scope: "elaborated", assignments: [assignment] };
  function paths(condition, prior, bBefore, bAfter, output = "0") {
    const observations = [
      { signal: 0, width: 1, range: [3, 0], projected: true, bit: 2,
        initial: { tick: "0", value: "1" }, history: [{ tick: "4", value: output }] },
      { signal: 1, width: 2, range: [1, 0], signed: false, initial: { tick: "0", value: prior },
        history: condition === prior ? [] : [{ tick: "4", value: condition }] },
      { signal: 2, width: 4, range: [0, 3], signed: false,
        initial: { tick: "0", value: "0100" }, history: [] },
      { signal: 3, width: 4, range: [3, 0], signed: false,
        initial: { tick: "0", value: bBefore }, history: [{ tick: "4", value: bAfter }] },
    ];
    const { nodes, edges } = buildTemporalTrace(trace, { tick: "4", observations });
    return edges.map(({ source, role, timing }) => [nodes[source].signal, nodes[source].bit, role, timing]);
  }
  assert.deepEqual(paths("00", "01", "0100", "0000"), [
    [1, undefined, "condition", "sameTickUnordered"],
    [3, 2, undefined, "sameTickUnordered"],
  ]);
  const merged = paths("0x", "0x", "0100", "0000");
  assert(merged.some(([id, , role]) => id === 1 && role === "condition"));
  assert(merged.some(([id, bit]) => id === 2 && bit === 1));
  assert(merged.some(([id, bit]) => id === 3 && bit === 2));
  for (const unknown of ["0x", "0z"]) {
    const sameTick = paths(unknown, "01", "0000", "0000", "x");
    assert(sameTick.some(([id, , role, timing]) =>
      id === 1 && role === "condition" && timing === "sameTickUnordered"));
    assert(sameTick.some(([id, bit]) => id === 2 && bit === 1));
    assert(sameTick.some(([id, bit]) => id === 3 && bit === 2));
    assert(!sameTick.some(([id, bit]) => (id === 2 || id === 3) && bit === undefined));
  }
});

test("temporal trace follows a matched mux arm and retains unresolved candidates", () => {
  const signal = (args) => ({ op: "signal", args });
  const assignment = {
    kind: "nonblocking",
    targets: [0],
    inputs: [1, 2, 3].map((signal) => ({ kind: "data", signal })),
    value: { op: "conditional", args: [signal(1), signal(2), signal(3)] },
    hasUnresolvedOperands: false,
  };
  const trace = { root: 0, assignments: [assignment] };
  const evidence = {
    tick: "7",
    observations: ["7", "1", "2", "3"].map((tick, signal) => ({
      signal,
      width: 1,
      initial: { value: "0" },
      history: [{ tick, value: "1" }],
    })),
  };
  const edgeSignals = ({ nodes, edges }) =>
    edges.map(({ source }) => nodes[source].signal);
  assert.deepEqual(edgeSignals(buildTemporalTrace(trace, evidence)), [1, 2]);
  assignment.hasUnresolvedOperands = true;
  assert.deepEqual(edgeSignals(buildTemporalTrace(trace, evidence)), [1, 2, 3]);
  assignment.hasUnresolvedOperands = false;
  assignment.guards = [
    {
      takenWhenTrue: true,
      expression: {
        op: "value",
        args: {
          op: "binary",
          args: ["caseEqual", signal(1), { op: "literal", args: ["0", false] }],
        },
      },
    },
  ];
  const { candidates } = traceAssignmentCandidates(trace, evidence);
  assert.equal(candidates[0].guards[0].match, false);
  assert.equal(candidates[0].status, "contradictedByObservations");
  assert.deepEqual(edgeSignals(buildTemporalTrace(trace, evidence)), []);
  assignment.guards = [];
  evidence.observations[2].history.push({ tick: "7", value: "0" });
  const temporal = buildTemporalTrace(trace, evidence);
  const parallel = temporal.edges.filter(
    ({ source }) => temporal.nodes[source].signal === 2,
  );
  assert.deepEqual(
    parallel.map(({ source, timing, confidence }) => [
      temporal.nodes[source].tick,
      timing,
      confidence,
    ]),
    [
      ["7", "sameTickUnordered", "possible"],
      ["2", undefined, "possible"],
    ],
  );
  evidence.observations[2].historyTruncated = true;
  assert.deepEqual(buildTemporalTrace(trace, evidence).missingEvidence, [
    { signal: 2, reason: "truncated" },
  ]);
  evidence.observations[2].historyTruncated = false;
  evidence.observations[2].history = [];
  evidence.historyStart = "5";
  const stable = buildTemporalTrace(trace, evidence);
  const stableNode = stable.nodes.find((node) => node.signal === 2);
  assert.deepEqual(stableNode, {
    signal: 2,
    tick: "7",
    value: evidence.observations[2].initial.value,
    sampleOnly: true,
  });
  assert(
    stable.edges.some(
      ({ source, target }) =>
        stable.nodes[source] === stableNode && target === 0,
    ),
  );
  assert(
    stable.missingEvidence.some(
      ({ signal, reason }) => signal === 2 && reason === "noChangeInWindow",
    ),
  );
  const boundary = stable.gaps.find(({ signal, historyCutoff }) => signal === 2 && historyCutoff);
  assert.equal(boundary.historyCutoff, "4");
  assert.equal(boundary.value, stableNode.value);
  assert.equal(boundary.use.evidence.kind, "data");
  evidence.observations[2].initial.tick = "2";
  for (const start of ["5", "6"]) {
    evidence.historyStart = start;
    const graph = buildTemporalTrace(trace, evidence);
    assert(graph.gaps.some(({ signal, historyCutoff }) =>
      signal === 2 && historyCutoff === "2",
    ));
  }
  evidence.observations[2].history = [{ tick: "6", value: undefined }];
  assert(!buildTemporalTrace(trace, evidence).gaps.some(({ signal, historyCutoff }) =>
    signal === 2 && historyCutoff !== undefined,
  ));
});

test("packed slice writers compare only their written bits", () => {
  const trace = {
    root: 0,
    assignments: [
      {
        kind: "nonblocking",
        targets: [0],
        targetRange: [3, 2],
        inputs: [],
        value: { op: "literal", args: ["10", false] },
      },
      {
        kind: "nonblocking",
        targets: [0],
        targetRange: [1, 0],
        inputs: [],
        value: { op: "literal", args: ["01", false] },
      },
    ],
  };
  const evidence = {
    tick: "5",
    observations: [
      {
        signal: 0,
        width: 4,
        range: [3, 0],
        initial: { value: "1101" },
        history: [{ tick: "5", value: "1001" }],
      },
    ],
  };
  const values = traceAssignmentCandidates(trace, evidence).candidates.map(
    ({ value }) => value,
  );
  assert.deepEqual(
    values.map(({ targetChanged, match, observed }) => [
      targetChanged,
      match,
      observed,
    ]),
    [
      [true, true, "10"],
      [false, true, "01"],
    ],
  );
  const projected = {
    ...evidence,
    observations: [
      {
        signal: 0,
        width: 1,
        range: [3, 0],
        projected: true,
        bit: 2,
        initial: { value: "1" },
        history: [{ tick: "5", value: "0" }],
      },
    ],
  };
  const bitCandidates = traceAssignmentCandidates(trace, projected).candidates;
  assert.deepEqual(
    bitCandidates.map(({ assignment, value }) => [
      assignment,
      value?.match,
      value?.expected,
    ]),
    [[0, true, "0"]],
  );
  trace.assignments[0].inputs.push({ signal: 0, kind: "data" });
  trace.assignments[0].value = { op: "signal", args: 0 };
  assert.deepEqual(buildTemporalTrace(trace, projected).missingEvidence, [
    { signal: 0, reason: "projectedDependency" },
  ]);
  evidence.observations[0].history.unshift({ tick: "5", value: "0000" });
  const ambiguous = traceAssignmentCandidates(trace, evidence);
  assert.equal(ambiguous.multipleChangesAtTick, true);
  assert(
    ambiguous.candidates.every(
      ({ status, value }) => status === "possible" && value === undefined,
    ),
  );
});

test("partial packed waveform samples preserve known bit dependencies without fabricating values", () => {
  const { evaluateTraceValue } = require("../dist/rtl-trace-values");
  const evaluate = (expression) => evaluateTraceValue(expression, undefined, () => ({
    width: 4, range: [3, 0], signed: false, sampledRange: [2, 2], bits: "1",
  }));
  const dynamicBit = (index) => ({ op: "bitSelect", args: [1, { op: "literal", args: [index, false] }] });
  assert.equal(evaluate({ op: "signal", args: 1 }), undefined);
  assert.equal(evaluate({ op: "select", args: [1, 2, 2] }).bits, "1");
  assert.equal(evaluate({ op: "select", args: [1, 2, 1] }), undefined);
  assert.equal(evaluate(dynamicBit("10")).bits, "1");
  assert.equal(evaluate(dynamicBit("01")), undefined);
  assert.equal(evaluate(dynamicBit("100")).bits, "x");

  const trace = {
    root: 0, signals: [{ id: 0 }, { id: 1, packedRange: [3, 0] }], frontier: [],
    assignments: [{
      kind: "continuous", targets: [0], inputs: [{ signal: 1, kind: "data" }],
      value: { op: "binary", args: ["bitXor", { op: "select", args: [1, 2, 2] }, { op: "select", args: [1, 1, 1] }] },
    }],
  };
  const evidence = { tick: "5", historyStart: "0", observations: [
    { signal: 0, width: 1, initial: { tick: "0", value: "0" }, history: [{ tick: "5", value: "1" }] },
    { signal: 1, width: 1, range: [2, 2], initial: { tick: "0", value: "0" }, history: [{ tick: "3", value: "1" }] },
  ] };
  assert.equal(traceAssignmentCandidates(trace, evidence).candidates[0].value, undefined);
  const graph = buildTemporalTrace(trace, evidence);
  assert(graph.nodes.some(({ signal, bit, tick }) => signal === 1 && bit === 2 && tick === "3"));
  assert(graph.gaps.some(({ signal, bit, reason }) => signal === 1 && bit === 1 && reason === "waveformBitsUnavailable"));
  assert.equal(graph.coverage.status, "partial");
});

test("a scalar read of a fixed packed bit follows only that bit's writer", () => {
  const { focusPackedTrace } = require("../dist/rtl-trace-bits");
  const select = {
    kind: "continuous", targets: [0], inputs: [{ signal: 1, kind: "data" }],
    value: { op: "select", args: [1, -1, -1] },
  };
  const trace = {
    root: 0,
    signals: ["result", "bus", "selected", "sibling"].map((name, id) => ({ id, name })),
    frontier: [],
    assignments: [select, ...[-1, 0].map((bit, offset) => ({
      kind: "port", targets: [1], targetRange: [bit, bit],
      inputs: [{ signal: offset + 2, kind: "data" }],
    }))],
  };
  const scalar = (signal, tick) => ({
    signal, width: 1, initial: { tick: "0", value: "0" },
    history: [{ tick, value: "1" }],
  });
  const evidence = { tick: "5", observations: [
    scalar(0, "5"),
    {
      signal: 1, width: 2, range: [0, -1], initial: { tick: "0", value: "00" },
      history: [{ tick: "2", value: "10" }, { tick: "5", value: "11" }],
    },
    scalar(2, "5"),
    scalar(3, "2"),
  ] };
  const graph = buildTemporalTrace(trace, evidence);
  assert.deepEqual([...new Set(graph.nodes.map(({ signal, bit }) => [signal, bit].join(":")))], [
    "0:", "1:-1", "2:",
  ]);
  assert(graph.edges.some(({ assignment }) => assignment === 1));
  assert(!graph.edges.some(({ assignment }) => assignment === 2));

  const bindings = new Map(trace.signals.map(({ id, name }) => [
    id, { name: id === 1 ? name + "[0:-1]" : name, width: id === 1 ? 2 : 1 },
  ]));
  const driverTrace = focusPackedTrace(trace, undefined, "drivers", bindings);
  assert.deepEqual(driverTrace.signals.map(({ id }) => id), [0, 1, 2]);
  assert.equal(driverTrace.bitSelection.bit, undefined);
  assert.deepEqual(driverTrace.assignments[0].inputs[0].readBits, [-1]);
  assert.equal(driverTrace.assignments[0].writtenBits, undefined);
  assert.equal(driverTrace.assignments[1].inputs[0].readBits, undefined);
  assert.deepEqual(buildTemporalTrace(driverTrace, evidence).nodes, graph.nodes);

  // With no usable range, retain the signal-level dependency.
  const unbound = buildTemporalTrace(trace, { ...evidence, observations: [
    evidence.observations[0],
    { ...evidence.observations[1], range: undefined },
    ...evidence.observations.slice(2),
  ] });
  assert(unbound.nodes.some(({ signal, bit }) => signal === 1 && bit === undefined));
});

test("a whole-bus transition follows only the backing bits read by a modport alias", () => {
  const trace = {
    root: 0,
    assignments: [
      {
        kind: "continuous",
        targets: [0],
        inputs: [{ signal: 1, kind: "data", interfaceRange: [1, 2] }],
        value: { op: "select", args: [1, 1, 2] },
      },
    ],
  };
  const observation = (signal, range, before, after) => ({
    signal,
    range,
    width: before.length,
    initial: { value: before },
    history: [{ tick: "5", value: after }],
  });
  const graph = buildTemporalTrace(trace, {
    tick: "5",
    observations: [
      observation(0, [1, 0], "00", "10"),
      observation(1, [0, 3], "0000", "1101"),
    ],
  });
  assert.deepEqual(
    [...new Set(graph.nodes.filter(({ signal }) => signal === 1).map(({ bit }) => bit))].sort(),
    [1, 2],
  );
});

test("NBA sample comparison distinguishes earlier values and preserves ambiguous combinations", () => {
  const recorded = (signal, before, events) => ({
    signal,
    width: 1,
    initial: { value: before },
    history: events.map(([tick, value]) => ({ tick, value })),
  });
  const evidence = {
    tick: "9",
    observations: [
      recorded(0, "0", [["9", "1"]]),
      recorded(1, "0", [
        ["5", "1"],
        ["9", "0"],
      ]),
      recorded(2, "0", [["9", "1"]]),
      recorded(3, "0", [["9", "1"]]),
    ],
  };
  const signal = (args) => ({ op: "signal", args });
  const assignment = {
    kind: "nonblocking",
    targets: [0],
    inputs: [
      { signal: 1, kind: "data" },
      { signal: 2, kind: "trigger", edge: "rising" },
    ],
    value: signal(1),
  };
  const trace = { root: 0, assignments: [assignment] };
  const result = traceAssignmentCandidates(trace, evidence);
  assert.deepEqual(result.candidates[0].rhsSamples, [
    {
      signal: 1,
      values: [
        { bits: "1", match: true },
        { bits: "0", match: false },
      ],
    },
  ]);
  const graph = buildTemporalTrace(trace, evidence);
  assert.deepEqual(
    graph.edges
      .filter(({ kind }) => kind === "data")
      .map(({ source, rhsSample, timing }) => [
        graph.nodes[source].tick,
        rhsSample,
        timing,
      ]),
    [
      ["9", "differs", "sameTickUnordered"],
      ["5", "matches", undefined],
    ],
  );

  assignment.inputs.push({ signal: 3, kind: "data" });
  assignment.value = { op: "binary", args: ["bitXor", signal(1), signal(3)] };
  const alternatives = traceAssignmentCandidates(trace, evidence).candidates[0]
    .rhsSamples;
  assert.equal(alternatives.length, 2);
  assert(
    alternatives.every(({ values }) => values.every(({ match }) => match)),
  );
  evidence.observations[1].historyTruncated = true;
  assert.equal(
    traceAssignmentCandidates(trace, evidence).candidates[0].rhsSamples,
    undefined,
  );
});

test("waveform binding reports where an upstream signal failed verification", async () => {
  const { createWaveAnalysis } = require("../dist/wave-analysis");
  const sourceDir = path.join(os.tmpdir(), "wave-binding-test");
  const declaration = {
    uri: pathToFileURL(path.join(sourceDir, "design.sv")).href,
    range: { start: { line: 4, character: 0 } },
  };
  const waveform = (name, supported = true) => ({ scope: "tb", name, supported });
  const matches = Object.fromEntries([
    ["unsupported", [waveform("unsupported", false)]],
    ["ambiguous", [waveform("ambiguous"), waveform("ambiguous")]],
    ...["absent", "noSource", "wrongLine", "wrongFile", "ok"].map(
      name => [name, [waveform(name)]],
    ),
  ]);
  const expected = {
    noDecl: "missingDeclaration",
    notDumped: "waveformMissing",
    unsupported: "waveformUnsupported",
    ambiguous: "waveformAmbiguous",
    absent: "designObjectMissing",
    noSource: "designLocationMissing",
    wrongLine: "declarationMismatch",
    wrongFile: "declarationMismatch",
  };
  const names = ["q", ...Object.keys(expected), "ok"];
  const design = {
    kind: "kdb",
    path: path.join(sourceDir, "simv.daidir"),
    async resolve(fullname) {
      const name = fullname.split(".").at(-1);
      if (name === "absent") throw Error("KDB declaration not found: " + fullname);
      return {
        fullname,
        instance: "tb",
        line: name === "wrongLine" ? 6 : 5,
        packedRange: [4, 0],
        file: name === "noSource" ? undefined
          : name === "wrongFile" ? "other.sv" : "design.sv",
      };
    },
  };
  const analysis = createWaveAnalysis({
    file: pathToFileURL,
    workspace: { textDocuments: [], getConfiguration: () => ({ get: () => undefined }) },
  });
  const { bindings, issues, packedRanges } = await analysis.bindTraceObservations({
    backend: { async request(method) { assert.equal(method, "matchNames"); return { matches }; } },
  }, {
    trace: {
      root: 0, signals: names.map((name, id) => ({ id, name, declaration: name === "noDecl" ? null : declaration })),
    },
    instance: "tb",
    design,
    signal: waveform("q"),
  });
  assert.deepEqual([...bindings.values()].map(({ name }) => name), ["q", "ok"]);
  assert.deepEqual([...packedRanges], [[names.indexOf("ok"), [4, 0]]]);
  assert.deepEqual(Object.fromEntries([...issues].map(([id, issue]) => [names[id], issue])), expected);
});

test("temporal gaps retain the candidate, consumer tick, and reason", () => {
  const location = {
    uri: "file:///gaps.sv",
    range: { start: { line: 5, character: 0 } },
  };
  const trace = {
    root: 0,
    signals: ["q", "clk", "hidden", "data"].map((name, id) => ({
      id,
      name,
      instance: "tb",
    })),
    assignments: [
      {
        kind: "nonblocking",
        location,
        targets: [0],
        inputs: [
          { signal: 1, kind: "trigger", edge: "rising" },
          { signal: 2, kind: "data" },
          { signal: 3, kind: "data" },
        ],
      },
    ],
  };
  const evidence = {
    tick: "5",
    historyStart: "2",
    historyEnd: "5",
    scale: "1ps",
    observations: [
      {
        signal: 0,
        width: 1,
        waveformSignal: "tb.q",
        initial: { tick: "0", value: "0" },
        history: [{ tick: "5", value: "1" }],
      },
      {
        signal: 1,
        width: 1,
        waveformSignal: "tb.clk",
        history: [{ tick: "5", value: "1" }],
      },
      {
        signal: 3,
        width: 1,
        waveformSignal: "tb.data",
        historyTruncated: true,
        history: [],
      },
    ],
  };
  const graph = buildTemporalTrace(trace, evidence);
  assert.deepEqual(graph.edges, []);
  const serialized = JSON.parse(JSON.stringify(graph));
  assert.equal(serialized.schemaVersion, 1);
  assert.equal(serialized.coverage.status, "partial");
  assert(serialized.coverage.reasons.includes("missingObservations"));
  assert.deepEqual(
    graph.gaps.map(({ signal, tick, reason, use }) => [
      signal,
      tick,
      reason,
      use.target,
      use.assignment,
    ]),
    [
      [1, "5", "unprovenTrigger", 0, 0],
      [2, "5", "unmapped", 0, 0],
      [3, "5", "truncated", 0, 0],
    ],
  );
  assert.match(
    temporalMermaid(graph, evidence, undefined, trace.signals),
    /tb\.hidden #64; 5 #183; No waveform binding/,
  );
  assert.match(
    observationReport({ ...evidence, temporalTrace: graph }, trace),
    /tb\.hidden @ 5 · No waveform binding · data input to tb\.q @ 5 · .*gaps\.sv.*L6/,
  );
  const classified = buildTemporalTrace(trace, {
    ...evidence,
    bindingIssues: new Map([[1, "declarationMismatch"], [2, "waveformMissing"]]),
  });
  assert.deepEqual(classified.gaps.map(({ bindingIssue }) => bindingIssue),
    [undefined, "waveformMissing", undefined]);
  assert.match(temporalMermaid(classified, evidence, undefined, trace.signals),
    /tb\.hidden #64; 5 #183; No matching dumped signal/);
  const enumTrace = {
    ...trace,
    signals: trace.signals.map(signal => signal.id === 2
      ? { ...signal, enumValue: { bits: "0010101", signed: false } }
      : signal),
  };
  const withEnum = buildTemporalTrace(enumTrace, evidence);
  const enumNode = withEnum.nodes.findIndex(node => node.signal === 2);
  assert(enumNode >= 0);
  assert.deepEqual(withEnum.nodes[enumNode], {
    signal: 2, tick: "5", value: "0010101", sampleOnly: true, enumConstant: true,
  });
  assert(withEnum.edges.some(({ source }) => source === enumNode));
  assert(!withEnum.gaps.some(({ signal }) => signal === 2));
  assert.match(temporalMermaid(withEnum, evidence, undefined, enumTrace.signals),
    /0010101 .* RTL enum constant/);
  const packageTrace = {
    ...trace,
    signals: trace.signals.map(signal => signal.id === 2
      ? { ...signal, packageParameterValue: { bits: "10", signed: false } }
      : signal),
  };
  const withParameter = buildTemporalTrace(packageTrace, evidence);
  const parameterNode = withParameter.nodes.findIndex(node => node.signal === 2);
  assert.deepEqual(withParameter.nodes[parameterNode], {
    signal: 2, tick: "5", value: "10", sampleOnly: true, packageParameter: true,
  });
  assert(withParameter.edges.some(({ source, role }) => source === parameterNode && role === undefined));
  assert(!withParameter.gaps.some(({ signal }) => signal === 2));
  assert.match(temporalMermaid(withParameter, evidence, undefined, packageTrace.signals),
    /10 .* RTL package parameter/);
  const declaration = {
    uri: "file:///gaps.sv",
    range: { start: { line: 2, character: 4 }, end: { line: 2, character: 10 } },
  };
  const unresolvedEnum = {
    ...trace,
    signals: trace.signals.map(signal => signal.id === 2
      ? { ...signal, enumValueUnavailable: true, declaration }
      : signal),
  };
  const enumGapGraph = buildTemporalTrace(unresolvedEnum, evidence);
  const enumGap = enumGapGraph.gaps.find(({ signal }) => signal === 2);
  assert.equal(enumGap.reason, "enumValueUnavailable");
  assert.deepEqual(enumGap.declaration, declaration);
  assert.equal(enumGap.bindingIssue, undefined);
  assert.equal(enumGap.continuation, undefined);
  assert.match(temporalMermaid(enumGapGraph, evidence, undefined, unresolvedEnum.signals),
    /RTL enum value could not be confirmed/);
  assert.match(observationReport({ ...evidence, temporalTrace: enumGapGraph }, unresolvedEnum),
    /RTL enum value could not be confirmed.*Declared at .*gaps\.sv.*L3/);
  const combinedEnumGap = mergeTemporalContinuationGraph({
    root: unresolvedEnum.root,
    signals: unresolvedEnum.signals,
    context: { ...evidence, temporalTrace: enumGapGraph },
    assignmentSources: { 0: { kind: "nonblocking", location } },
  }, { segments: [], remaining: [], stopReasons: [], links: [] });
  const { traceTimeSchematic } = require("../dist/rtl-schematic");
  const schematic = traceTimeSchematic(unresolvedEnum, combinedEnumGap);
  const enumNodeInSchematic = schematic.graph.nodes.find(({ kind, detail }) =>
    kind === "gap" && detail.includes("RTL enum value could not be confirmed"));
  assert.deepEqual(schematic.locations.get(enumNodeInSchematic.id), declaration);
  const unknownParameter = {
    ...trace,
    signals: trace.signals.map(signal => signal.id === 2
      ? { ...signal, packageParameterValueUnavailable: true, declaration }
      : signal),
  };
  const unknown = buildTemporalTrace(unknownParameter, evidence).gaps.find(({ signal }) => signal === 2);
  assert.equal(unknown.reason, "packageParameterValueUnavailable");
  assert.deepEqual(unknown.declaration, declaration);
  assert.equal(unknown.continuation, undefined);
  const instanceTrace = {
    ...trace,
    signals: trace.signals.map(signal => signal.id === 2
      ? { ...signal, instanceParameter: true, instanceParameterValue: { bits: "1", signed: false } }
      : signal),
  };
  const instanceGraph = buildTemporalTrace(instanceTrace, evidence);
  const instanceNode = instanceGraph.nodes.findIndex(node => node.signal === 2);
  assert.equal(instanceGraph.nodes[instanceNode].elaboratedParameter, true);
  assert(instanceGraph.edges.some(({ source, role }) => source === instanceNode && role === undefined));
  assert(!instanceGraph.gaps.some(({ signal }) => signal === 2));
  delete instanceTrace.signals.find(({ id }) => id === 2).instanceParameterValue;
  assert(buildTemporalTrace(instanceTrace, evidence).gaps.some(
    ({ signal, reason }) => signal === 2 && reason === "instanceParameterValueUnavailable",
  ));

  const gapsLimited = buildTemporalTrace(
    {
      ...trace,
      assignments: [{
        ...trace.assignments[0],
        inputs: [...trace.assignments[0].inputs, ...[4, 5].map((signal) => ({
          signal,
          kind: "data",
        }))],
      }],
    },
    {
      ...evidence,
      observations: [
        ...evidence.observations,
        ...[4, 5].map((signal) => ({
          signal,
          width: 1,
          initial: { tick: "0", value: "0" },
          history: [{ tick: "3", value: "1" }],
        })),
      ],
    },
    undefined, false, undefined, { nodes: 1, edges: 1, gaps: 2 },
  );
  assert.deepEqual(
    gapsLimited.gaps.map(({ signal, reason }) => [signal, reason]),
    [[4, "nodeBudget"], [5, "nodeBudget"]],
  );
  assert.equal(gapsLimited.gapsTruncated, true);
  assert(gapsLimited.coverage.reasons.includes("missingObservations"));
  assert.deepEqual(gapsLimited.frontier, [4, 5]);

  const fanIn = Array.from({ length: 260 }, (_, i) => ({
    signal: i + 1,
    kind: "data",
  }));
  const sources = fanIn.map(({ signal }) => ({
    signal,
    width: 1,
    initial: { tick: "0", value: "0" },
    history: [{ tick: "3", value: "1" }],
  }));
  const wideTrace = {
    root: 0,
    assignments: [
      { kind: "continuous", location, targets: [0], inputs: fanIn },
    ],
  };
  const wideEvidence = {
    ...evidence,
    observations: [evidence.observations[0], ...sources],
  };
  const bounded = buildTemporalTrace(wideTrace, wideEvidence);
  assert.equal(bounded.nodes.length, 256);
  assert.equal(bounded.gaps.length, 5);
  assert.deepEqual(bounded.gaps[0], {
    signal: 256,
    bit: undefined,
    tick: "3",
    value: "1",
    reason: "nodeBudget",
    use: {
      target: 0, assignment: 0, kind: "data", edge: undefined,
      evidence: { kind: "data", confidence: "possible", role: undefined, timing: undefined },
    },
  });
  const shared = {
    ...wideTrace,
    assignments: [{
      ...wideTrace.assignments[0],
      inputs: fanIn.slice(0, 1),
    }],
  };
  const denseEvidence = {
    ...wideEvidence,
    observations: [0, 1].map((signal) => ({
      signal,
      width: 1,
      initial: { tick: "0", value: "0" },
      history: Array.from({ length: 33 }, (_, orderAtTick) => ({
        tick: "5",
        orderAtTick,
        value: orderAtTick % 2 ? "0" : "1",
      })),
    })),
  };
  const dense = buildTemporalTrace(shared, denseEvidence);
  const rootsLimited = buildTemporalTrace(shared, denseEvidence, undefined, false, undefined, { nodes: 1 });
  const expectedRootOrders = dense.rootNodes.slice(1).map((id) => dense.nodes[id].orderAtTick);
  assert.deepEqual(
    rootsLimited.gaps.filter(({ signal, use }) => signal === 0 && !use).map(({ orderAtTick }) => orderAtTick),
    expectedRootOrders,
  );
  assert.equal(dense.edges.length, 1024);
  const omitted = dense.gaps.filter(({ reason }) => reason === "edgeBudget");
  assert(omitted.length > 0);
  assert(omitted.every(({ signal, use }) => signal === 1 && use.assignment === 0));
  const output = temporalMermaidOutput(dense, denseEvidence);
  assert.equal(output.temporalMermaidPages[0], output.temporalMermaid);
  assert(output.temporalMermaidPages.length > 1);
  for (const page of output.temporalMermaidPages) {
    assert(page.length < 50_000);
    assert(
      page.split("\n").filter((line) => /(?:-->|-\.->)\|/.test(line)).length <=
        500,
    );
  }
  const allPages = output.temporalMermaidPages.join("\n");
  assert.equal(allPages.match(/ -->\|/g).length, dense.edges.length);
  assert.equal(allPages.match(/ -\.->\|/g).length, dense.gaps.length);
});

test("static and waveform diagram pages retain their edges and endpoint labels", () => {
  const location = {
    uri: "file:///design.sv",
    range: { start: { line: 6, character: 0 } },
  };
  const trace = {
    root: 0,
    scope: "elaborated",
    revision: "fixture",
    frontier: [],
    diagnostics: [],
    signals: [
      { id: 0, name: "q" },
      { id: 1, name: "d" },
    ],
    assignments: Array.from({ length: 510 }, () => ({
      kind: "blocking",
      inputs: [{ signal: 1, kind: "data", location }],
      targets: [0],
      location,
    })),
  };
  const graph = traceMermaidPages(trace);
  assert(graph.length > 1);
  assert.equal(graph.join("\n").match(/ -->/g).length, 1020);
  for (const page of graph) {
    assert.match(page, /s0\["q"\]/);
    assert.match(page, /class s0 root/);
    assert(page.length < 50_000);
    assert(
      page
        .split("\n")
        .filter((line) => line.includes(" --> ") || line.includes(" -->|"))
        .length <= 500,
    );
    assert(traceReport(trace, "drivers").includes(page));
  }
  const observation = observationMermaidPages({
    observations: [
      {
        signal: 0,
        waveformSignal: "tb.q",
        history: Array.from({ length: 510 }, (_, i) => ({
          tick: String(i),
          value: String(i % 2),
        })),
      },
    ],
  });
  assert.equal(observation.length, 2);
  assert.equal(observation.join("\n").match(/ -->/g).length, 509);
  assert(observation.every((page) => page.includes('subgraph g0["tb.q"]')));
  assert.match(observation[1], /t0_500\["500 /);
  assert.match(observation[1], /t0_500 --> t0_501/);
});

test("a tick-zero sample keeps its initializer without implying a clock edge", () => {
  const location = {
    uri: "file:///initial.sv",
    range: { start: { line: 0, character: 0 } },
  };
  const trace = {
    schemaVersion: 1,
    root: 0,
    signals: ["seed", "clk", "d"].map((name, id) => ({ id, name })),
    assignments: [
      { kind: "initialization", targets: [0], inputs: [], value: { op: "literal", args: ["1", false] }, location },
      { kind: "nonblocking", targets: [0], inputs: [
        { signal: 1, kind: "trigger", edge: "rising", location },
        { signal: 2, kind: "data", edge: null, location },
      ], location },
    ],
    frontier: [],
  };
  const observation = (signal, history) => ({
    signal, status: "observed", width: 1, range: [0, 0], history,
    value: history.at(-1).value,
  });
  const start = (value) => [{ tick: "0", value }];
  const evidence = {
    tick: "0", historyStart: "0", scale: "1ns",
    observations: [
      observation(0, start("1")),
      observation(1, start("1")),
      observation(2, start("0")),
    ],
  };
  const graph = buildTemporalTrace(trace, evidence);
  assert.equal(graph.nodes[0].initialSample, true);
  assert.deepEqual(graph.nodes[0].initializationAssignments, [0]);
  assert(graph.gaps.some(gap => gap.reason === "unprovenTrigger"));
  assert(!graph.edges.some(edge => edge.kind === "trigger"));
  const startupGap = graph.gaps.find(({ signal }) => signal === 2);
  assert.equal(startupGap?.reason, "unprovenInitialOrder");
  assert.equal(startupGap.value, "0");
  assert.equal(startupGap.continuation, undefined);
  assert(graph.edges.some(({ source, timing }) =>
    graph.nodes[source].signal === 2 && timing === "sameTickUnordered"));
  assert.match(temporalMermaid(graph, evidence), /Startup sample available#44; evaluation order unknown/);
  assert.match(temporalMermaid(graph, evidence), /Declaration initializer/);
  assert.equal(buildTemporalTrace(trace, evidence, undefined, false, undefined, {
    changeOrder: 1,
  }).nodes.length, 0);

  // A real tick-zero transition still uses the existing change order.
  const transition = buildTemporalTrace(trace, {
    ...evidence,
    observations: [observation(0, [...start("0"), ...start("1")]), ...evidence.observations.slice(1)],
  });
  assert.equal(transition.nodes[0].initialSample, undefined);
  assert.equal(transition.nodes[0].value, "1");

  const missingInput = buildTemporalTrace(trace, {
    ...evidence,
    observations: [
      ...evidence.observations.slice(0, 2),
      { ...evidence.observations[2], value: undefined, history: [] },
    ],
  });
  assert(missingInput.gaps.some(({ signal, reason }) =>
    signal === 2 && reason === "noChangeInWindow"));

  // A capture that starts later provides no pre-capture transition evidence.
  const later = buildTemporalTrace(trace, {
    ...evidence, tick: "2", historyStart: "2",
    observations: [observation(0, [{ tick: "2", value: "1" }])],
  });
  assert.equal(later.nodes.length, 0);
});

test("startup initialization cannot explain a later value change or same-value write", () => {
  const { traceAssignmentCandidates, traceCursorWriters } = require("../dist/rtl-trace-candidates");
  const initializer = {
    kind: "initialization", initializationAtStart: true,
    targets: [0], inputs: [{ signal: 1, kind: "data" }], value: { op: "signal", args: 1 },
  };
  const trace = {
    root: 0, frontier: [],
    assignments: [initializer, {
      kind: "blocking", targets: [0], inputs: [{ signal: 2, kind: "data" }],
      value: { op: "signal", args: 2 },
    }],
  };
  const observations = [["1", "0", "6"], ["1", "0", "2"], ["1", "0", "3"]]
    .map(([before, value, tick], signal) => ({
      signal, width: 1, status: "observed", value,
      history: [{ tick: "0", value: before }, { tick, value }],
      cursorSamples: { initial: { tick, value }, events: [], truncated: false },
    }));
  const evidence = { tick: "7", historyStart: "0", observations };
  const change = traceAssignmentCandidates(trace, evidence);
  assert.equal(change.change.tick, "6");
  assert.equal(change.candidates[0].initializationOutsideStart, true);
  assert.equal(traceCursorWriters(trace, evidence).candidates[0].initializationOutsideStart, true);
  const graph = buildTemporalTrace(trace, evidence);
  assert.deepEqual(graph.edges.map(edge => graph.nodes[edge.source].signal), [2]);

  // Older VIDE replies and scope-entry declarations have no start-time marker.
  const scopeEntry = { ...trace, assignments: [
    { ...initializer, initializationAtStart: undefined }, trace.assignments[1],
  ] };
  const candidates = buildTemporalTrace(scopeEntry, evidence);
  assert.deepEqual(candidates.edges.map(edge => candidates.nodes[edge.source].signal), [1, 2]);
});

test("trace continuation checkpoints track changes to the offline execution recording", async () => {
  const { createWaveAnalysis } = require("../dist/wave-analysis");
  const { simulationFilelistsCurrent } = require("../dist/vide-project-config");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "trace-checkpoint-"));
  try {
    const waveform = path.join(directory, "trace.vcd");
    const recording = path.join(directory, "execution.jsonl");
    await fs.writeFile(waveform, "$enddefinitions $end\n");
    await fs.writeFile(recording, "{}\n");
    const analysis = createWaveAnalysis({
      workspace: { getConfiguration: () => ({ get: () => undefined }), textDocuments: [] },
    }, () => undefined, () => undefined);
    const viewer = { uri: { fsPath: waveform }, backend: {}, backendKind: "vcd" };
    const result = { trace: { compilation: { files: [] } } };
    const guard = () => analysis.createContinuationGuard(viewer, result, undefined, recording, true);
    const original = await guard();
    assert.equal(await simulationFilelistsCurrent(original.checkpoint.inputs), true);
    assert.equal((await guard()).checkpoint.identity, original.checkpoint.identity);

    await fs.appendFile(recording, "{}\n");
    assert.equal(await simulationFilelistsCurrent(original.checkpoint.inputs), false);
    await assert.rejects(original.assertCurrent, TraceContextChanged);
    assert.notEqual((await guard()).checkpoint.identity, original.checkpoint.identity);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("MCP continuations reject a changed design index without a persisted checkpoint", async (t) => {
  const { createWaveAnalysis } = require("../dist/wave-analysis");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "trace-design-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const waveform = path.join(directory, "trace.dsn");
  const index = path.join(directory, "trace.shm.hdl.json");
  await fs.writeFile(waveform, "");
  await fs.writeFile(index, '{"version":1,"locations":[]}');
  const analysis = createWaveAnalysis({
    workspace: { getConfiguration: () => ({ get: () => undefined }), textDocuments: [] },
  }, () => undefined, () => undefined);
  const design = { kind: "vendor-hdl", path: index };
  const viewer = { uri: { fsPath: waveform }, backend: {}, kdb: design };
  const result = { design, trace: { compilation: { files: [] } } };
  const guard = await analysis.createContinuationGuard(viewer, result, undefined);
  await guard.assertCurrent();
  await fs.appendFile(index, "\n");
  await assert.rejects(guard.assertCurrent, TraceContextChanged);
});

test("restored Trace Explorer gaps continue with the saved execution recording", async () => {
  const { createWaveTraceView } = require("../dist/wave-trace-view");
  const trace = {
    schemaVersion: 1,
    root: 0,
    signals: [{ id: 0, name: "q", instance: "tb" }],
    assignments: [],
    frontier: [],
    diagnostics: [],
  };
  const gap = {
    signal: 0,
    tick: "7",
    continuation: { signal: "tb.q", tick: "7", changeOrder: 2 },
  };
  const temporalTrace = {
    nodes: [],
    edges: [],
    frontier: [],
    gaps: [gap],
    missingEvidence: [],
  };
  const waveform = path.resolve("fixture.fsdb");
  const executionFile = path.resolve("fixture.jsonl");
  const saved = JSON.stringify({
    trace,
    direction: "drivers",
    waveform,
    fullname: "tb.q",
    executionFile,
    evidence: {
      tick: "10",
      observations: [],
      provider: { kind: "waveform" },
      temporalTrace,
    },
  });
  const commands = new Map();
  const viewer = { uri: { fsPath: waveform } };
  const stop = Error("Continuation reached the observation query");
  const queries = [];
  const errors = [];
  const traceView = createWaveTraceView(
    {
      EventEmitter: class { fire() {} },
      ProgressLocation: { Notification: 15 },
      window: {
        withProgress: (_options, run) => run({}, {
          isCancellationRequested: false,
          onCancellationRequested: () => ({ dispose() {} }),
        }),
      },
      commands: { registerCommand: (name, run) => commands.set(name, run) },
    },
    {
      context: {
        subscriptions: [],
        workspaceState: { get: () => JSON.parse(saved) },
      },
      output: { appendLine: (message) => assert.fail(message) },
      report: (error) => errors.push(error),
      restoreWaveformViewer: async (filename) => {
        assert.equal(filename, waveform);
        return viewer;
      },
      analyses: {
        traceWaveSignal: async () => ({ trace }),
        bindTraceObservations: async () => ({ bindings: [] }),
        bindStaticFrontier: async () => trace,
        verifyWaveTrace: async () => undefined,
        traceWaveContext: async (_viewer, _result, tick, _history, _build,
          _bindings, _abort, recording, _expand, limits) => {
          queries.push({ tick, recording, changeOrder: limits?.changeOrder });
          throw stop;
        },
      },
    },
  );
  const restoredGap = traceView.getTraceSnapshot().evidence.temporalTrace.gaps[0];
  await commands.get("waveWorkbench.traceFromSignal")({
    kind: "temporalContinuation",
    gap: restoredGap,
  });
  assert.deepEqual(queries, [{ tick: "7", recording: executionFile, changeOrder: 2 }]);
  assert.deepEqual(errors, [stop]);
});

test("Trace Explorer stops a temporal feedback path and shows unavailable evidence", () => {
  const { createTraceExplorer } = require("../dist/trace-explorer");
  let provider;
  const commands = new Map();
  const views = new Map();
  const followups = [];
  const jumps = [];
  const added = [];
  const addedWaveformPaths = [];
  const opened = [];
  let resumed = 0;
  const selectedResumptions = [];
  const noOp = () => {};
  const explorer = createTraceExplorer(
    {
      EventEmitter: class {
        fire() {}
      },
      TreeItem: class {
        constructor(label, collapsibleState) {
          Object.assign(this, { label, collapsibleState });
        }
      },
      TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
      Uri: { file: pathToFileURL },
      window: {
        createTreeView(id, {treeDataProvider}) {
          const view = { provider: treeDataProvider };
          views.set(id, view);
          if (id === "waveWorkbench.traceExplorer") provider = treeDataProvider;
          return view;
        },
      },
      commands: { registerCommand: (name, run) => commands.set(name, run) },
    },
    { subscriptions: [] },
    (source) => opened.push(source),
    (signal, bit, waveformSignal) =>
      waveformSignal ? addedWaveformPaths.push(waveformSignal) : added.push([signal.name, bit]),
    noOp,
    (...args) => followups.push(args),
    async (tick) => jumps.push(tick),
    async (request) => {
      resumed++;
      if (request) selectedResumptions.push(request);
    },
  );
  const panel = views.get("waveWorkbench.panelTrace");
  assert.equal(panel.provider, provider);
  explorer.setMessage("Trace result");
  assert.equal(panel.message, "Trace result");
  const location = {
    uri: "file:///test.sv",
    range: { start: { line: 0, character: 0 } },
  };
  const trace = {
    root: 0,
    frontier: [],
    diagnostics: [],
    signals: [
      { id: 0, name: "a", instance: "tb" },
      { id: 1, name: "b" },
    ],
    assignments: [
      {
        kind: "continuous",
        location,
        targets: [0],
        inputs: [{ signal: 1, kind: "data" }],
      },
      {
        kind: "continuous",
        location,
        targets: [1],
        inputs: [{ signal: 0, kind: "data" }],
      },
    ],
  };
  const graph = {
    nodes: [
      { signal: 0, tick: "5" },
      { signal: 1, tick: "5" },
    ],
    edges: [
      {
        source: 1,
        target: 0,
        assignment: 0,
        kind: "data",
        confidence: "possible",
      },
      {
        source: 0,
        target: 1,
        assignment: 1,
        kind: "data",
        confidence: "possible",
      },
    ],
    frontier: [0],
    missingEvidence: [{ signal: 1, reason: "truncated" }],
    gaps: [
      {
        signal: 1,
        tick: "5",
        reason: "truncated",
        use: { target: 0, assignment: 0, kind: "data" },
      },
      {
        signal: 0, tick: "4", reason: "nodeBudget",
        continuation: { signal: "dump.a[2]", tick: "4" },
      },
    ],
  };
  explorer.show(trace, "drivers", new Map(), graph, [{
    signal: 1, location, call: "$test$plusargs", literal: "ENABLE",
    argument: { present: false },
  }]);
  assert.ok(panel.provider.getChildren().length > 0);

  const runtime = provider.getChildren().find(({ kind }) => kind === "runtimeInputs");
  const [input] = provider.getChildren(runtime);
  assert.match(provider.getTreeItem(input).label, /argument absent/);
  assert.deepEqual(provider.getTreeItem(input).command.arguments, [location]);
  const timeline = provider
    .getChildren()
    .find(({ kind }) => kind === "timeline");
  const [root, , gaps] = provider.getChildren(timeline);
  const upstream = (node) =>
    provider
      .getChildren(node)
      .flatMap((assignment) => provider.getChildren(assignment));
  const [closed] = upstream(upstream(root)[0]);
  assert.equal(provider.getTreeItem(closed).label, "a");
  assert.match(provider.getTreeItem(closed).description, /Cycle/);
  assert.deepEqual(provider.getChildren(closed), []);
  assert.deepEqual(
    provider.getChildren(gaps).map((item) => provider.getTreeItem(item).label),
    ["b · History truncated", "a · Time graph node budget reached"],
  );
  const [, gap] = upstream(root);
  assert.match(provider.getTreeItem(gap).description, /Tick 5 · data · a/);
  assert.deepEqual(provider.getTreeItem(gap).command.arguments, [location]);
  const frontier = provider.getChildren(gaps)[1];
  assert.match(provider.getTreeItem(frontier).contextValue, /\btraceTemporalFrontier\b/);
  const frontierAction = provider.getTreeItem(provider.getChildren(frontier)[0]);
  assert.equal(frontierAction.label, "Continue from dump.a[2]");
  assert.equal(frontierAction.description, "Tick 4");
  assert.deepEqual(provider.getChildren(gap), []);
  commands.get(frontierAction.command.command)(...frontierAction.command.arguments);
  assert.deepEqual(followups, [
    [trace.signals[0], "drivers", {
      tick: "4", bit: undefined, continuation: { signal: "dump.a[2]", tick: "4" },
    }],
  ]);
  explorer.show({
    ...trace,
    bitSelection: { bit: 2, feedbackEdges: [] },
    frontier: [
      { signal: 0, reason: "depth", bits: [1, 2],
        continuation: { signal: "dump.dut.a", bits: [1, 2] } },
      { signal: 0, reason: "signals", continuation: null },
    ],
  }, "drivers");
  const selectedRoot = provider.getChildren()[0];
  commands.get("waveWorkbench.traceFromSignal")(selectedRoot);
  assert.deepEqual(followups.at(-1), [trace.signals[0], "drivers", undefined, "[2]"]);
  const choices = provider.getChildren(selectedRoot).filter(({ kind }) => kind === "staticFrontier");
  assert.deepEqual(choices.map((node) => provider.getTreeItem(node).label), ["Continue from a[2]"]);
  const action = provider.getTreeItem(choices[0]).command;
  commands.get(action.command)(...action.arguments);
  assert.deepEqual(followups.at(-1), [
    trace.signals[0], "drivers", undefined, "[2]", "dump.dut.a[2]",
  ]);
  assert(provider.getChildren(selectedRoot).some((item) =>
    provider.getTreeItem(item).label === "Waveform continuation unavailable · signals limit"));
  explorer.show({
    ...trace,
    bitSelection: { range: [2, 1], feedbackEdges: [] },
    frontier: [
      { signal: 0, reason: "depth", bits: [1], continuation: null },
      { signal: 0, reason: "depth", bits: [2], continuation: { signal: "dump.dut.a", bits: [2] } },
    ],
  }, "drivers");
  const partialRoot = provider.getChildren()[0];
  const partialLabels = provider.getChildren(partialRoot).map((node) => provider.getTreeItem(node).label);
  assert(partialLabels.includes("Continue from a[2]"));
  assert(partialLabels.includes("Waveform continuation unavailable · depth limit · bits 1"));
  explorer.show(trace, "drivers", new Map(), {
    ...graph,
    nodes: [],
    edges: [],
  });
  assert(!provider.getChildren().some(({ kind }) => kind === "runtimeInputs"));
  assert.deepEqual(provider.getChildren(root), []);
  assert(
    provider.getChildren(timeline).some(({ kind }) => kind === "temporalGaps"),
  );
  const combined = {
    roots: [0],
    provider: { kind: "waveform" },
    nodes: [
      { signal: "tb.a", point: { tick: "5", value: "1" }, sources: [{ segment: 0, node: 0 }] },
      { signal: "tb.b", point: { tick: "3", value: "1" }, sources: [{ segment: 1, node: 0 }] },
    ],
    edges: [{ segment: 1, assignment: 0, source: 0, target: 1 }],
    gaps: [{
      segment: 0, target: 0, source: 1, status: "joined", signal: "tb.b",
      evidence: { signal: 1, tick: "3", reason: "nodeBudget", use: { target: 0, assignment: 0, kind: "data" } },
    }],
    assignmentSources: [{ 0: { kind: "continuous", location } }, { 0: { kind: "continuous", location } }],
    coverage: { status: "resolvedWithinWindow", reasons: [] },
  };
  explorer.show(trace, "drivers", new Map(), undefined, [], combined);
  const combinedRoot = provider.getChildren(provider.getChildren().find(
    ({ kind }) => kind === "combinedTimeline",
  ))[0];
  const [assignment] = provider.getChildren(combinedRoot);
  assert.deepEqual(provider.getTreeItem(assignment).command.arguments, [location]);
  const [continued] = provider.getChildren(assignment);
  assert.match(provider.getTreeItem(continued).description, /Tick 3 · 1 · Continued data/);
  const [sourceAssignment] = provider.getChildren(continued);
  const [cycle] = provider.getChildren(sourceAssignment);
  assert.match(provider.getTreeItem(cycle).description, /Cycle/);
  assert.deepEqual(provider.getChildren(cycle), []);
  const taskSource = { file: path.resolve("task.sv"), line: 9, column: 3, identity: "matched" };
  const withTask = {
    ...combined,
    nodes: [combined.nodes[0], {
      ...combined.nodes[1],
      waveformSignal: "dump.tb.b[2]",
      declaration: location,
      point: {
        ...combined.nodes[1].point,
        recordedTaskTransfer: {
          input: { tick: "2", ordinal: 3, source: taskSource },
          write: { tick: "3", ordinal: 6, source: taskSource },
          reads: [{ operation: "$fgetc at byte 0", source: taskSource, value: "00000001" }],
        },
      },
    }],
  };
  explorer.updateCombined(withTask);
  const [taskRoot] = provider.getChildren(provider.getChildren().find(({ kind }) => kind === "combinedTimeline"));
  const [taskTransition] = upstream(taskRoot);
  const taskItem = provider.getTreeItem(taskTransition);
  assert.match(taskItem.contextValue, /\btraceWaveform\b/);
  assert.match(taskItem.contextValue, /\btraceSource\b/);
  commands.get("waveWorkbench.traceAddSignal")(taskTransition);
  assert.deepEqual(addedWaveformPaths, ["dump.tb.b[2]"]);
  commands.get("waveWorkbench.traceOpenNodeSource")(taskTransition);
  assert.deepEqual(opened.splice(0), [location]);
  const evidence = provider.getChildren(taskTransition).filter(({ kind }) => kind === "executionSource");
  assert.deepEqual(evidence.map((entry) => provider.getTreeItem(entry).label),
    ["Task input commit 3 · L9", "Member write commit 6 · L9", "$fgetc at byte 0 · L9"]);
  const read = provider.getTreeItem(evidence[2]);
  assert.equal(read.command.command, "waveWorkbench.traceOpenSource");
  assert.equal(read.command.arguments[0].uri, pathToFileURL(taskSource.file).href);
  const packedSource = { ...location, range: { start: { line: 19, character: 3 } } };
  explorer.updateCombined({
    ...combined,
    assignmentSources: [combined.assignmentSources[0], { 0: { kind: "nonblocking", location: packedSource } }],
    nodes: [combined.nodes[0], { ...combined.nodes[1],
      sources: [{ segment: 0, node: 1 }, { segment: 1, node: 0 }],
      recordedWordEvidence: [{ segment: 1, node: 0, writers: [
        { assignment: 0, commitOrdinal: 12, targetRange: [7, 4], contributingRanges: [[7, 4]] },
      ] }],
    }],
  });
  const [packedRoot] = provider.getChildren(provider.getChildren().find(({ kind }) => kind === "combinedTimeline"));
  const [packedTransition] = upstream(packedRoot);
  assert.match(provider.getTreeItem(packedTransition).description, /1 recorded writes/);
  const [packedWriter] = provider.getChildren(packedTransition);
  const packedItem = provider.getTreeItem(packedWriter);
  assert.match(packedItem.tooltip, /Commit 12 .* Contributes \[7:4\]/);
  assert.deepEqual(packedItem.command.arguments, [packedSource]);
  explorer.updateCombined(combined);
  commands.get("waveWorkbench.traceJumpToTick")(continued);
  assert.deepEqual(jumps, ["3"]);
  const batchRow = () => {
    const timeline = provider.getChildren().find(({ kind }) => kind === "combinedTimeline");
    return timeline && provider.getChildren(timeline).find(({ kind }) => kind === "resumeCombined");
  };
  explorer.updateCombined(combined, 2);
  const oldBatch = batchRow();
  assert.equal(provider.getTreeItem(oldBatch).description, "2 pending");
  const resume = commands.get("waveWorkbench.traceResumeBatch");
  resume(oldBatch);
  assert.equal(resumed, 1);
  explorer.updateCombined({ ...combined }, 1);
  resume(oldBatch);
  assert.equal(resumed, 1);
  const newBatch = batchRow();
  assert.equal(provider.getTreeItem(newBatch).description, "1 pending");
  resume(newBatch);
  assert.equal(resumed, 2);
  const pendingRequest = { signal: "dump.tb.b[2]", tick: "3", changeOrder: 2 };
  const pendingGap = {
    ...combined.gaps[0], status: "pending", source: undefined,
    evidence: { ...combined.gaps[0].evidence, continuation: pendingRequest },
  };
  explorer.updateCombined({ ...combined, gaps: [pendingGap], coverage: { status: "partial", reasons: [] } }, 1);
  const timelineWithPending = provider.getChildren().find(({ kind }) => kind === "combinedTimeline");
  const pendingGroup = provider.getChildren(timelineWithPending).find(({ kind }) => kind === "combinedGaps");
  const pendingNode = provider.getChildren(pendingGroup).find(({ kind }) => kind === "combinedGap");
  const pendingAction = provider.getTreeItem(pendingNode).command;
  assert.equal(pendingAction.title, "Continue in current graph");
  commands.get(pendingAction.command)(...pendingAction.arguments);
  assert.deepEqual(selectedResumptions, [pendingRequest]);
  assert.equal(resumed, 3);
  explorer.updateCombined({ ...combined });
  commands.get(pendingAction.command)(...pendingAction.arguments);
  assert.equal(resumed, 3);
  assert.equal(batchRow(), undefined);
  const largeGaps = Array.from({ length: 36_775 }, (_, index) => ({
    ...combined.gaps[0],
    signal: "tb.upstream" + index,
    status: index === 0 ? "joined" : "pending",
  }));
  explorer.updateCombined({
    ...combined,
    gaps: largeGaps,
    coverage: { status: "partial", reasons: ["requestBudget"] },
  });
  const timelineWithGaps = provider.getChildren().find(({ kind }) => kind === "combinedTimeline");
  const gapRoot = provider.getChildren(timelineWithGaps).find(({ kind }) => kind === "combinedGaps");
  const pages = provider.getChildren(gapRoot);
  assert.equal(provider.getTreeItem(gapRoot).description, (largeGaps.length - 1).toLocaleString());
  assert.equal(pages.length, 289);
  assert.equal(provider.getTreeItem(pages[0]).label, "Gaps 1–128");
  assert.equal(provider.getTreeItem(pages.at(-1)).label, "requestBudget");
  assert.deepEqual(provider.getChildren(pages[0]).map(({ gap }) => gap), largeGaps.slice(1, 129));
  assert.deepEqual(provider.getChildren(pages.at(-2)).map(({ gap }) => gap), largeGaps.slice(128 * 287 + 1));
  explorer.updateCombined(combined);
  assert.deepEqual(provider.getChildren(pages[0]), []);
  explorer.clearCombined();
  commands.get("waveWorkbench.traceJumpToTick")(continued);
  assert.deepEqual(jumps, ["3"]);
  assert(!provider.getChildren().some(({ kind }) => kind === "combinedTimeline"));
  const combinedStatic = {
    root: 0,
    status: "partial",
    bitSelection: { bit: 2, feedbackEdges: [] },
    signals: [
      trace.signals[0],
      { ...trace.signals[1], instance: "tb" },
      { id: 2, name: "c", instance: "tb" },
    ],
    assignments: [
      { ...trace.assignments[0], id: 0, inputs: [
        { signal: 1, kind: "data", readBits: [1] },
      ] },
      { ...trace.assignments[0], id: 1, targets: [1], inputs: [
        { signal: 2, kind: "data" },
      ] },
    ],
    gaps: [{ signal: 2, reason: "depth", locations: [], continuationSignals: ["dump.c"] }],
    feedbackEdges: [],
  };
  explorer.show(trace, "drivers", new Map(), undefined, [], undefined, combinedStatic);
  const [staticRoot] = provider.getChildren(provider.getChildren()[0]);
  const [firstStep] = provider.getChildren(staticRoot);
  const [portBit] = provider.getChildren(firstStep);
  assert.match(provider.getTreeItem(firstStep).contextValue, /\btraceSource\b/);
  assert.match(provider.getTreeItem(firstStep).contextValue, /\btraceWaveform\b/);
  assert.match(provider.getTreeItem(portBit).contextValue, /\btraceWaveform\b/);
  commands.get("waveWorkbench.traceOpenNodeSource")(firstStep);
  assert.deepEqual(opened, [location]);
  commands.get("waveWorkbench.traceAddSignal")(firstStep);
  assert.deepEqual(added, [["a", undefined]]);
  added.length = 0;
  assert.equal(provider.getTreeItem(portBit).label, "b[1]");
  commands.get("waveWorkbench.traceAddSignal")(portBit);
  assert.deepEqual(added, [["b", 1]]);
  const [continuedAssignment] = provider.getChildren(portBit);
  const [continuedInput] = provider.getChildren(continuedAssignment);
  const [pending] = provider.getChildren(continuedInput);
  assert.equal(provider.getTreeItem(pending).label, "Continue from c");
  commands.get("waveWorkbench.traceFromSignal")(pending);
  assert.equal(followups.at(-1)[4], "dump.c");
  explorer.show(trace, "drivers", new Map(), undefined, [], undefined, combinedStatic, ["dump.c"]);
  const staticTimeline = provider.getChildren().find(({ kind }) => kind === "combinedStaticRoot");
  const selectedSignal = provider.getChildren(staticTimeline).find(({ kind }) => kind === "signal");
  const [selectedAssignment] = provider.getChildren(selectedSignal);
  const [selectedBit] = provider.getChildren(selectedAssignment);
  const [selectedDriver] = provider.getChildren(selectedBit);
  const [selectedInput] = provider.getChildren(selectedDriver);
  const [selectedFrontier] = provider.getChildren(selectedInput);
  const continueAction = provider.getTreeItem(selectedFrontier).command;
  assert.equal(continueAction.title, "Continue in current graph");
  commands.get(continueAction.command)(...continueAction.arguments);
  assert.deepEqual(selectedResumptions, [pendingRequest, "dump.c"]);
  explorer.clearCombined();
  commands.get("waveWorkbench.traceAddSignal")(portBit);
  assert.deepEqual(added, [["b", 1]]);
});

test("same-tick waveforms retain per-signal changes and possible upstream edges", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "trace-same-tick-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const vcd = path.join(directory, "multi.vcd");
  await fs.writeFile(
    vcd,
    [
      "$timescale 1ps $end",
      "$scope module multi $end",
      "$var wire 1 ! clk $end",
      "$var wire 1 % data $end",
      "$var wire 1 & q $end",
      "$upscope $end",
      "$enddefinitions $end",
      "#0",
      "0!",
      "0%",
      "0&",
      "#5",
      "1!",
      "1%",
      "1&",
      "0!",
      "0%",
      "0&",
      "1!",
      "1%",
      "1&",
      "#10",
      "",
    ].join("\n"),
  );
  const fixture = process.env.WAVE_TEST_SAME_TICK;
  const backend = new Backend(
    path.resolve(__dirname, "../bin/wave-backend-independent"),
    {
      useVerdiLibraries: false,
    },
  );
  t.after(() => backend.dispose());
  const trace = {
    root: 2,
    assignments: [
      {
        kind: "nonblocking",
        targets: [2],
        inputs: [
          { signal: 0, kind: "trigger", edge: "rising" },
          { signal: 1, kind: "data" },
        ],
        value: { op: "signal", args: 1 },
      },
    ],
  };
  for (const file of [
    vcd,
    ...(fixture ? [path.join(fixture, "multi.fst")] : []),
  ]) {
    const metadata = await backend.request("open", { path: file });
    const bindings = new Map(
      metadata.signals.map((signal, index) => [index, signal]),
    );
    const rootId = bindings.get(trace.root).id;
    const standard = await backend.request("query", {
      signals: [rootId],
      start: "5",
      end: "5",
    });
    assert.deepEqual(standard[rootId].events, [["5", "1"]]);
    const evidence = await readTraceObservations(
      backend,
      metadata,
      bindings,
      "5",
      "5",
      trace.root,
    );
    const candidates = traceAssignmentCandidates(trace, evidence);
    assert.deepEqual(
      candidates.changesAtTick.map(({ orderAtTick, value }) => [
        orderAtTick,
        value,
      ]),
      [
        [1, "1"],
        [2, "0"],
        [3, "1"],
      ],
    );
    assert.deepEqual(candidates.change, { tick: "5", value: "1" });
    assert.equal(candidates.candidates[0].status, "possible");
    assert.equal(candidates.candidates[0].value, undefined);
    const graph = buildTemporalTrace(trace, evidence);
    assert.deepEqual(
      graph.rootNodes.map((id) => graph.nodes[id].orderAtTick),
      [3, 2, 1],
    );
    const chosen = buildTemporalTrace(trace, evidence, undefined, false, undefined, { changeOrder: 2 });
    assert.equal(chosen.nodes[0].value, "0");
    assert.equal(chosen.nodes[0].orderAtTick, 2);
    assert.equal(chosen.rootNodes, undefined);
    assert(chosen.edges.every(({ confidence }) => confidence === "possible"));
    assert.deepEqual(buildTemporalTrace(trace, evidence, undefined, false, undefined, { changeOrder: 4 }).nodes, []);
    for (const target of graph.rootNodes) {
      const edges = graph.edges.filter((edge) => edge.target === target);
      const orders = (kind) =>
        edges
          .filter(
            (edge) => edge.kind === kind && edge.timing === "sameTickUnordered",
          )
          .map(({ source }) => graph.nodes[source].orderAtTick);
      assert.deepEqual(orders("trigger"), [1, 3]);
      assert.deepEqual(orders("data"), [1, 2, 3]);
      assert(edges.every(({ confidence }) => confidence === "possible"));
      assert(edges.some(({ source }) => graph.nodes[source].beforeTick));
    }
  }
});

test("temporal indexed reads resolve stable signed indexes and keep unordered candidates", () => {
  const [data, index, result] = [0, 1, 2];
  const trace = {
    root: result,
    assignments: [
      {
        kind: "continuous",
        targets: [result],
        inputs: [
          { signal: data, kind: "data" },
          { signal: index, kind: "data" },
        ],
        value: {
          op: "indexedPartSelect",
          args: [
            data,
            { op: "signal", args: index },
            { width: 2, ascendingIndices: false },
          ],
        },
      },
    ],
  };
  const observations = [
    {
      signal: result,
      width: 2,
      range: [1, 0],
      initial: { value: "00" },
      history: [{ tick: "5", value: "10" }],
    },
    {
      signal: data,
      width: 6,
      range: [-2, 3],
      initial: { value: "000000" },
      history: [{ tick: "5", value: "100001" }],
    },
    {
      signal: index,
      width: 3,
      signed: true,
      initial: { value: "110" },
      history: [],
    },
  ];
  const inputs = () => {
    const graph = buildTemporalTrace(trace, { tick: "5", observations });
    return graph.edges
      .filter(({ target }) => target === 0)
      .map(({ source, role, timing }) => {
        const node = graph.nodes[source];
        return [node.signal, node.bit, role, timing];
      });
  };
  assert.deepEqual(inputs(), [
    [data, -2, undefined, "sameTickUnordered"],
    [data, -2, undefined, undefined],
    [index, undefined, "index", undefined],
  ]);
  observations[2].history.push({ tick: "5", value: "001" });
  assert.deepEqual(inputs(), [
    [data, undefined, undefined, "sameTickUnordered"],
    [data, undefined, undefined, undefined],
    [index, undefined, "index", "sameTickUnordered"],
    [index, undefined, "index", undefined],
  ]);
  observations[2].initial.value = "111";
  observations[2].history.length = 0;
  const graph = buildTemporalTrace(trace, { tick: "5", observations });
  assert(
    graph.nodes.some(
      (node) =>
        node.signal === data &&
        node.bit === -1 &&
        node.sampleOnly &&
        node.value === "0",
    ),
  );
});

test("dynamic LHS indexes identify the affected bit and preserve the index dependency", () => {
  const trace = {
    root: 0,
    assignments: [
      {
        kind: "nonblocking",
        targets: [0],
        inputs: [{ kind: "data", signal: 1 }],
        targetIndex: { op: "signal", args: 1 },
        value: { op: "unsignedBit", args: true },
      },
    ],
  };
  const root = {
    signal: 0,
    width: 4,
    range: [3, 0],
    initial: { value: "0000" },
    history: [{ tick: "5", value: "0100" }],
  };
  const index = {
    signal: 1,
    width: 3,
    signed: false,
    initial: { value: "000" },
    history: [{ tick: "2", value: "010" }],
  };
  const evidence = { tick: "5", observations: [root, index] };
  const candidate = () =>
    traceAssignmentCandidates(trace, evidence).candidates[0];
  assert.deepEqual(candidate().targetIndex, {
    status: "selected",
    index: "2",
    inputs: [1],
  });
  assert.deepEqual(candidate().value, {
    expected: "1",
    observed: "1",
    match: true,
    inputs: [1],
    targetRange: [2, 2],
    targetChanged: true,
  });
  assert.equal(buildTemporalTrace(trace, evidence).edges[0].kind, "data");
  evidence.observations[0] = {
    ...root,
    projected: true,
    bit: 1,
    width: 1,
    initial: { value: "0" },
    history: [{ tick: "5", value: "1" }],
  };
  assert.deepEqual(candidate().targetIndex, {
    status: "differentBit",
    index: "2",
  });
  assert.equal(candidate().status, "contradictedByObservations");
  index.history.push({ tick: "5", value: "001" });
  assert.deepEqual(candidate().targetIndex, { status: "unresolved" });
  assert.equal(candidate().value, undefined);
  index.history = [{ tick: "2", value: "111" }];
  index.signed = true;
  assert.deepEqual(candidate().targetIndex, {
    status: "outOfRange",
    index: "-1",
  });
});

test("word writes compare the array index before comparing the written lane", () => {
  const trace = {
    root: 0,
    signals: [{ id: 0, selectedElement: 2 }],
    assignments: [{
      kind: "nonblocking",
      targets: [0],
      inputs: [{ kind: "data", signal: 1 }],
      targetElementIndex: { op: "signal", args: 1 },
      targetRange: [3, 2],
      elementValue: { op: "literal", args: ["10", false] },
    }],
  };
  const word = {
    signal: 0,
    width: 4,
    range: [3, 0],
    initial: { value: "0000" },
    history: [{ tick: "5", value: "1000" }],
  };
  const index = {
    signal: 1,
    width: 2,
    signed: false,
    initial: { value: "00" },
    history: [{ tick: "2", value: "10" }],
  };
  const evidence = { tick: "5", observations: [word, index] };
  const candidate = () => traceAssignmentCandidates(trace, evidence).candidates[0];
  assert.deepEqual(candidate().targetElement, { status: "selected", index: "2" });
  assert.deepEqual(candidate().value, {
    expected: "10",
    observed: "10",
    match: true,
    inputs: [1],
    targetRange: [3, 2],
    targetChanged: true,
  });
  assert.equal(buildTemporalTrace(trace, evidence).edges[0].role, "index");
  index.history.push({ tick: "5", value: "01" });
  assert.deepEqual(candidate().targetElement, { status: "unresolved" });
  assert.equal(candidate().value, undefined);
  index.history[0].value = "01";
  assert.deepEqual(candidate().targetElement, { status: "differentElement", index: "1" });
  assert.equal(candidate().status, "contradictedByObservations");
  assert.equal(buildTemporalTrace(trace, evidence).edges.length, 0);
});

test("a changing read index links only waveform words compatible with the observed readout", () => {
  const trace = {
    root: 0,
    signals: [{ id: 0 }, { id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }],
    assignments: [
      {
        kind: "continuous",
        targets: [0],
        inputs: [{ kind: "data", signal: 1 }, { kind: "data", signal: 2 }],
        wordRead: { signal: 1, index: { op: "signal", args: 2 } },
      },
      {
        kind: "nonblocking",
        targets: [1],
        inputs: [{ kind: "data", signal: 3 }, { kind: "data", signal: 4 }],
        targetElementIndex: { op: "signal", args: 3 },
        elementValue: { op: "signal", args: 4 },
      },
    ],
  };
  const observe = (signal, initial, history) => ({
    signal, width: initial.length, signed: false, initial: { value: initial },
    history: history.map(([tick, value]) => ({ tick, value })),
  });
  const evidence = {
    tick: "9",
    observations: [
      observe(0, "0000", [["9", "1010"]]),
      observe(2, "0", [["9", "1"]]),
      observe(3, "0", [["2", "1"]]),
      observe(4, "0000", [["2", "1010"]]),
      observe(5, "0000", [["3", "0101"]]),
      observe(6, "0000", [["5", "1010"]]),
    ],
  };
  const words = [
    { id: 5, array: 1, index: "0", name: "mem[0]", instance: "tb" },
    { id: 6, array: 1, index: "1", name: "mem[1]", instance: "tb" },
  ];
  const graph = buildTemporalTrace(trace, evidence, undefined, false, undefined, undefined, words);
  assert.deepEqual(graph.wordReads.map(({ index, timing }) => [index, timing]), [
    ["0", "sameTickUnordered"],
    ["1", "sameTickUnordered"],
  ]);
  assert(!graph.nodes.some(({ signal }) => signal === 5));
  const source = graph.nodes.findIndex(({ signal, tick }) => signal === 6 && tick === "5");
  assert(source >= 0);
  assert(graph.edges.some((edge) => edge.target === 0 && edge.source === source &&
    edge.timing === "sameTickUnordered"));
  assert(graph.edges.some((edge) => edge.target === source &&
    graph.nodes[edge.source].signal === 4));
});

test("a projected array read maps the output bit to the compatible sampled word", () => {
  const trace = {
    root: 0,
    signals: [
      { id: 0, name: "result", packedRange: [7, 4] },
      { id: 1, name: "mem" },
      { id: 2, name: "index" },
    ],
    frontier: [],
    assignments: [{
      kind: "continuous",
      targets: [0],
      inputs: [{ kind: "data", signal: 1 }, { kind: "data", signal: 2 }],
      wordRead: { signal: 1, index: { op: "signal", args: 2 } },
    }],
  };
  const observation = (signal, range, before, tick, value) => ({
    signal, width: before.length, range, signed: false,
    initial: { tick: "0", value: before }, history: [{ tick, value }],
  });
  const evidence = { tick: "9", historyStart: "0", observations: [
    {
      ...observation(0, [7, 4], "0", "9", "1"),
      sourceWidth: 4, projected: true, bit: 6,
    },
    observation(2, [0, 0], "0", "9", "1"),
    observation(5, [-2, 1], "0000", "3", "1000"),
    observation(6, [-2, 1], "0000", "5", "0100"),
  ] };
  const words = [
    { id: 5, array: 1, index: "0", name: "mem[0]", instance: "tb" },
    { id: 6, array: 1, index: "1", name: "mem[1]", instance: "tb" },
  ];
  const graph = buildTemporalTrace(trace, evidence, undefined, false, undefined, undefined, words);
  assert(!graph.nodes.some(({ signal }) => signal === 5));
  const source = graph.nodes.findIndex(({ signal, bit, tick, value }) =>
    signal === 6 && bit === -1 && tick === "5" && value === "1",
  );
  assert(source >= 0);
  assert(graph.edges.some(edge => edge.target === 0 && edge.source === source &&
    edge.timing === "sameTickUnordered"));
});

test("a recorded struct member supplies the corresponding continuous assignment operand", () => {
  const packedStruct = { uri: "file:///packet_pkg.sv", range: { start: { line: 1, character: 2 } } };
  const trace = {
    root: 0,
    signals: [{ id: 0 }, { id: 1, packedStruct }, { id: 2 }, { id: 4, packedStruct }],
    assignments: [{
      kind: "continuous",
      targets: [0],
      inputs: [{ kind: "data", signal: 1 }, { kind: "data", signal: 2 }],
      fieldRead: { signal: 1, field: "data" },
    }, {
      kind: "port",
      targets: [1],
      inputs: [{ kind: "data", signal: 4 }],
    }],
  };
  const evidence = {
    tick: "9",
    observations: [
      { signal: 0, width: 4, initial: { value: "0000" }, history: [{ tick: "9", value: "1010" }] },
      { signal: 3, width: 4, initial: { value: "0000" }, history: [{ tick: "7", value: "1010" }] },
      { signal: 5, width: 4, initial: { value: "0000" }, history: [{ tick: "6", value: "1010" }] },
    ],
  };
  const fields = [
    { id: 3, signal: 1, field: "data", name: "packet.data", instance: "tb" },
    { id: 5, signal: 4, field: "data", name: "packet_out.data", instance: "tb" },
  ];
  function graph() {
    return buildTemporalTrace(trace, evidence, undefined, false, undefined, undefined, [], fields);
  }
  const result = graph();
  assert.equal(result.edges.length, 2);
  assert.equal(result.edges[0].assignment, 0);
  assert.deepEqual(result.nodes[result.edges[0].source], { signal: 3, tick: "7", value: "1010" });
  assert.equal(result.edges[1].assignment, 1);
  assert.equal(result.nodes[result.edges[1].source].signal, 5);
  const [whole, ...members] = evidence.observations;
  trace.signals[0].packedRange = [7, 4];
  const projected = value => buildTemporalTrace(trace, {
    ...evidence,
    observations: [{
      ...whole, width: 1, sourceWidth: 4, range: [7, 4], projected: true, bit: 5,
      initial: { value: "0" }, history: [{ tick: "9", value }],
    }, ...members],
  }, undefined, false, undefined, undefined, [], fields);
  assert.deepEqual(projected("1").nodes.slice(1).map(({ signal, tick, value }) =>
    [signal, tick, value]), [[3, "7", "1010"], [5, "6", "1010"]]);
  members[0].history[0].value = "1000";
  assert.equal(projected("1").edges.length, 0);
  members[0].history[0].value = "1010";
  delete trace.signals[3].packedStruct;
  assert.equal(graph().edges.length, 1);
  evidence.observations[1].history[0].value = "0110";
  assert.equal(graph().edges.length, 0);
});

test(
  "RTL trace fixture distinguishes builds and preserves testbench instance paths",
  {
    skip: !fixture,
  },
  async (t) => {
    const scope = "TOP.trace_tb.dut";
    for (const [target, preferred] of [
      ["hart0", "0"],
      ["hart1", "1"],
    ]) {
      for (const format of ["fst", "vcd"]) {
        await t.test(target + " " + format, async (t) => {
          const directory = path.join(fixture, target);
          const backend = new Backend(
            path.resolve(__dirname, "../bin/wave-backend-independent"),
            {
              useVerdiLibraries: false,
            },
          );
          t.after(() => backend.dispose());

          const metadata = await backend.request("open", {
            path: path.join(directory, "trace." + format),
          });
          const find = (name) => {
            const signal = metadata.signals.find(
              (signal) => signal.scope === scope && signal.name === name,
            );
            assert.ok(signal, name);
            return signal;
          };
          const owner = find("owner_q");
          const valid = find("valid_q");
          const grant = metadata.signals.find(
            (signal) => signal.scope === scope && /^grant\b/.test(signal.name),
          );
          assert.ok(grant);
          const cursorBindings = new Map([
            [0, owner],
            [1, grant],
            [2, find("accept")],
            [3, find("clk")],
          ]);
          const writerTrace = {
            root: 0,
            frontier: [],
            assignments: [
              {
                kind: "nonblocking",
                targets: [0],
                inputs: [
                  { kind: "data", signal: 1 },
                  { kind: "control", signal: 2 },
                  { kind: "trigger", edge: "rising", signal: 3 },
                ],
                guards: [
                  {
                    takenWhenTrue: true,
                    expression: { op: "signal", args: 2 },
                  },
                ],
                value: { op: "select", args: [1, 1, 1] },
              },
            ],
          };
          const held = await readTraceObservations(
            backend,
            metadata,
            cursorBindings,
            "5",
            "auto",
            0,
          );
          assert.equal(
            traceCursorWriters(writerTrace, held)?.candidateStatus,
            "writersExcluded",
          );
          const written = await readTraceObservations(
            backend,
            metadata,
            cursorBindings,
            "3",
            "auto",
            0,
          );
          assert.equal(
            traceCursorWriters(writerTrace, written)?.candidateStatus,
            target === "hart0" ? "sameValueWritePossible" : undefined,
          );
          for (const [tick, ownerValue, validValue] of [
            ["1", "0", "0"],
            ["3", preferred, "1"],
            ["5", preferred, "1"],
            ["7", "1", "1"],
            ["8", "0", "0"],
          ]) {
            const values = await backend.request("query", {
              signals: [owner.id, valid.id],
              start: tick,
              end: tick,
              limit: 4,
            });
            assert.equal(
              values[owner.id].events.at(-1)?.[1],
              ownerValue,
              "owner at " + tick,
            );
            assert.equal(
              values[valid.id].events.at(-1)?.[1],
              validValue,
              "valid at " + tick,
            );
          }
          const automatic = await readTraceObservations(
            backend,
            metadata,
            new Map([
              [0, owner],
              [1, valid],
              [2, grant],
            ]),
            "7",
            "auto",
            0,
          );
          assert.equal(automatic.historyEnd, target === "hart1" ? "3" : "7");
          assert.equal(automatic.observations[0].value, "1");
          assert(
            automatic.observations[0].history.some(
              ({ tick, value }) =>
                tick === automatic.historyEnd && value === "1",
            ),
          );
          const compared = traceAssignmentCandidates(
            {
              root: 0,
              assignments: [
                {
                  kind: "blocking",
                  targets: [0],
                  inputs: [],
                  value: { op: "unsignedBit", args: true },
                },
                {
                  kind: "blocking",
                  targets: [0],
                  inputs: [],
                  value: { op: "unsignedBit", args: false },
                },
                {
                  kind: "nonblocking",
                  targets: [0],
                  inputs: [{ kind: "data", signal: 2 }],
                  value: { op: "select", args: [2, 1, 1] },
                },
              ],
            },
            automatic,
          );
          assert.equal(compared.change.tick, automatic.historyEnd);
          assert.deepEqual(
            compared.candidates.map(({ value }) => value?.match),
            [true, false, true],
          );
          const boundaryTick = automatic.historyEnd;
          const boundary = await readTraceObservations(
            backend,
            metadata,
            new Map([[0, owner]]),
            boundaryTick,
            boundaryTick,
            0,
          );
          const boundaryOwner = boundary.observations[0];
          assert.equal(boundaryOwner.initial.value, "0");
          assert.deepEqual(boundaryOwner.history, [
            { tick: boundaryTick, value: "1" },
          ]);

          const design = await VerilatorDesign.open(
            path.join(directory, "Vtrace_tb.tree.json"),
            metadata.signals,
            [fixture],
          );
          const declaration = await design.resolve(scope + ".owner_q");
          assert.equal(declaration.instance, scope);
          assert.equal(declaration.module, "trace_arbiter");
          assert.equal(path.basename(declaration.file), "trace_tb.sv");
          const preference = await design.resolve(scope + ".PreferHart1");
          assert.equal(preference.kind, "npiParameter");
          assert.equal(preference.instance, scope);
          assert.deepEqual(preference.parameterValue, {
            bits: preferred,
            signed: false,
          });
          assert.deepEqual(
            (await design.instances("trace_request"))
              .map(({ fullname }) => fullname)
              .sort(),
            [
              scope + ".requesters[0].u_request",
              scope + ".requesters[1].u_request",
            ],
          );
          const links = await design.portLinks(scope, "active");
          assert.deepEqual(
            links.map((link) => [link.from.instance, link.to.bit]).sort(),
            [
              [scope + ".requesters[0].u_request", 0],
              [scope + ".requesters[1].u_request", 1],
            ],
          );
          const query = async ({ instance, signal }) => {
            const source = await design.resolve(instance + "." + signal);
            return {
              schemaVersion: 1,
              revision: "fixture",
              scope: "file",
              root: 0,
              signals: [
                {
                  id: 0,
                  name: signal,
                  declaration: {
                    uri: source.file,
                    range: { start: { line: source.line - 1, character: 0 } },
                  },
                },
              ],
              assignments: [],
              frontier: [],
              diagnostics: [],
            };
          };
          const root = { instance: scope, signal: "active" };
          const trace = await expandInstanceTrace(
            await query(root),
            scope,
            design,
            "drivers",
            {},
            (file) => file,
            query,
          );
          assert.equal(trace.scope, "elaborated");
          assert.equal(trace.assignments.length, 2);
          assert.deepEqual(
            trace.assignments
              .map((assignment) => [
                trace.signals[assignment.inputs[0].signal].instance,
                assignment.port.toBit,
              ])
              .sort(),
            [
              [scope + ".requesters[0].u_request", 0],
              [scope + ".requesters[1].u_request", 1],
            ],
          );

          const local = await query({ instance: scope, signal: "owner_q" });
          const active = (await query(root)).signals[0];
          local.signals.push({ ...active, id: 1 });
          local.assignments.push({
            kind: "blocking",
            targets: [0],
            location: local.signals[0].declaration,
            inputs: [
              {
                kind: "data",
                signal: 1,
                location: active.declaration,
                edge: null,
              },
            ],
            hasUnresolvedOperands: false,
          });
          const calls = [];
          const boundedQuery = (port, depth) => {
            calls.push(depth);
            return query(port);
          };
          const bounded = await expandInstanceTrace(
            local,
            scope,
            design,
            "drivers",
            { maxDepth: 1 },
            (file) => file,
            boundedQuery,
          );
          assert.deepEqual(calls, []);
          assert.equal(bounded.assignments.length, 1);
          assert.ok(
            bounded.frontier.some(
              ({ signal, reason }) => signal === 1 && reason === "depth",
            ),
          );
          const deeper = await expandInstanceTrace(
            local,
            scope,
            design,
            "drivers",
            { maxDepth: 2 },
            (file) => file,
            boundedQuery,
          );
          assert.deepEqual(calls, [0, 0]);
          assert.equal(deeper.assignments.length, 3);
        });
      }
    }
  },
);
