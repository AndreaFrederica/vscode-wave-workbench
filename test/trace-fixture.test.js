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
const { staticGraphSnapshot, temporalGraphSnapshot, traceGraphPage } = require("../dist/rtl-trace-graph-page");
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

  let generation = 0;
  const invalidated = await followTemporalFrontier(
    root, frontier(input, clock), 2, new AbortController().signal, new AbortController().signal,
    async (request) => {
      if (request === clock) generation++;
      return { context: { temporalTrace: frontier() } };
    },
    async () => {
      if (generation) throw new TraceContextChanged("The reference changed.");
    },
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
    undefined, deeper.segments,
  );
  assert.equal(deeper.segments.length, 2);
  assert.deepEqual(nextBatch.segments.map(({ request }) => request), [input, child, clock]);
  assert.deepEqual(nextBatch.links, [
    ...deeper.links,
    { segment: 3, gap: 0, nextSegment: 2 },
  ]);
  assert.deepEqual(nextBatch.remaining, []);
  assert.deepEqual(nextBatch.stopReasons, []);
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
  assert.equal(joined.gaps[0].target, 0);
  assert.equal(joined.gaps[0].source, 2);
  assert.match(combinedTemporalMermaid(joined).join("\n"), /continued index candidate.*matches recorded array index.*commit 8/);
  assert.deepEqual(joined.edges.map(({ segment, source, target }) => [segment, source, target]),
    [[0, 1, 0], [1, 1, 2]]);
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
    signals: ["out", "mem", "ptr", "Top"].map((name, id) => ({ id, name, declaration: location })),
    assignments: [
      {
        kind: "continuous", targets: [0], location, hasUnresolvedOperands: false,
        generateBranches: [{ selected, alternatives: [other] }],
        inputs: [1, 2, 3].map(signal => ({ kind: "data", signal, location })),
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
    },
  };
  const result = await expandInstanceTrace(
    trace, "dut", design, "drivers", { maxDepth: 2 }, source => pathToFileURL(source).href,
    async () => undefined,
  );
  assert.equal(result.assignments.length, 1);
  const pointer = result.signals.find(({ name }) => name === "ptr");
  assert.deepEqual(result.assignments[0].wordRead.index, { op: "select", args: [pointer.id, 1, 0] });
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
  const [mapped] = staticTraceCoverage({
    ...limited,
    frontier: [
      { signal: 0, reason: "depth", bits: [0], continuation: null },
      { signal: 0, reason: "depth", bits: [2], continuation: { signal: "dump.lane", bits: [2] } },
      { signal: 0, reason: "depth", bits: [3], continuation: { signal: "dump.lane", bits: [3] } },
    ],
  }).stops;
  assert.deepEqual(mapped.continuationSignals, ["dump.lane[2]", "dump.lane[3]"]);
  assert.equal(mapped.waveformUnavailable, undefined);
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

test("Trace Explorer stops a temporal feedback path and shows unavailable evidence", () => {
  const { createTraceExplorer } = require("../dist/trace-explorer");
  let provider;
  const commands = new Map();
  const followups = [];
  const jumps = [];
  const added = [];
  const opened = [];
  let resumed = 0;
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
      window: {
        registerTreeDataProvider(_id, tree) {
          provider = tree;
        },
      },
      commands: { registerCommand: (name, run) => commands.set(name, run) },
    },
    { subscriptions: [] },
    (source) => opened.push(source),
    (signal, bit) => added.push([signal.name, bit]),
    noOp,
    (...args) => followups.push(args),
    async (tick) => jumps.push(tick),
    async () => { resumed++; },
  );
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
  explorer.updateCombined({ ...combined });
  assert.equal(batchRow(), undefined);
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
