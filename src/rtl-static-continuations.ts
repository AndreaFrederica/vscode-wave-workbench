// SPDX-License-Identifier: MPL-2.0

import {
  isStaticBudgetStop,
  staticAssignmentPage,
  staticTraceCoverage,
  TraceContextChanged,
  traceFeedback,
  traceMermaidPages,
  traceReport,
  traceSignalScope,
  type StaticTraceDiagram,
  type TraceDirection,
  type VideTrace,
} from "./rtl-trace";
import { createMermaidFlowchart, mermaidMarkdown } from "./trace-mermaid";

type Coverage = ReturnType<typeof staticTraceCoverage>;
type Segment =
  | { signal: string; trace: VideTrace; coverage: Coverage }
  | { signal: string; error: string };

export async function followStaticFrontier(
  root: string,
  initial: VideTrace,
  limit: number,
  operation: AbortSignal,
  deadline: AbortSignal,
  query: (signal: string, abort: AbortSignal) => Promise<VideTrace>,
  assertCurrent: () => Promise<void>,
  previous: readonly Segment[] = [],
) {
  const queued = [root];
  const indices = new Map([[root, 0]]);
  const links: { segment: number; stop: number; nextSegment: number }[] = [];
  const segments = [...previous];
  const stopReasons = new Set<string>();
  function enqueue(segment: number, coverage: Coverage) {
    if (
      coverage.unresolvedAssignments.length ||
      coverage.compilationGaps.length ||
      coverage.incompleteCompilation
    )
      stopReasons.add("unresolvedRelations");
    for (const [stop, item] of coverage.stops.entries()) {
      if (!item.canRetrace || !item.waveformSignal) {
        stopReasons.add(
          item.waveformUnavailable
            ? "waveformUnavailable"
            : "unresolvedRelations",
        );
        continue;
      }
      for (const signal of item.continuationSignals ?? [item.waveformSignal]) {
        let nextSegment = indices.get(signal);
        if (nextSegment === undefined) {
          nextSegment = queued.push(signal) - 1;
          indices.set(signal, nextSegment);
        }
        if (nextSegment === segment) stopReasons.add("noProgress");
        links.push({ segment, stop, nextSegment });
      }
    }
  }
  enqueue(0, staticTraceCoverage(initial));
  previous.forEach((segment, index) => {
    if ("coverage" in segment) enqueue(index + 1, segment.coverage);
    else stopReasons.add("queryFailed");
  });
  const abort = AbortSignal.any([operation, deadline]);
  while (
    segments.length + 1 < queued.length &&
    segments.length - previous.length < limit &&
    !abort.aborted
  ) {
    const signal = queued[segments.length + 1];
    try {
      await assertCurrent();
      abort.throwIfAborted();
      const trace = await query(signal, abort);
      await assertCurrent();
      abort.throwIfAborted();
      const coverage = staticTraceCoverage(trace);
      segments.push({ signal, trace, coverage });
      enqueue(segments.length, coverage);
    } catch (error) {
      if (abort.aborted) break;
      if (error instanceof TraceContextChanged) {
        stopReasons.add("contextChanged");
        break;
      }
      stopReasons.add("queryFailed");
      segments.push({
        signal,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const remaining = queued.slice(segments.length + 1);
  if (operation.aborted) stopReasons.add("cancelled");
  else if (remaining.length && !stopReasons.has("contextChanged"))
    stopReasons.add(deadline.aborted ? "timeBudget" : "requestBudget");

  return {
    status: stopReasons.size
      ? ("partial" as const)
      : ("resolvedWithinScope" as const),
    segments,
    links,
    remaining,
    stopReasons: [...stopReasons],
  };
}

export type StaticWalk = Awaited<ReturnType<typeof followStaticFrontier>>;

export function summarizeStaticWalk(walk: StaticWalk) {
  return {
    ...walk,
    segments: walk.segments.map((segment) =>
      "error" in segment
        ? segment
        : {
            signal: segment.signal,
            status: segment.coverage.status,
            scope: segment.coverage.scope,
            assignmentCount: segment.trace.assignments.length,
          },
    ),
  };
}

function projectedFeedback(
  assignments: readonly Pick<
    VideTrace["assignments"][number],
    "targets" | "bitDependencies"
  >[],
) {
  const stateIds = new Map<string, number>();
  const signals: { id: number; signal: number }[] = [];
  const relations: {
    assignment: number;
    targets: number[];
    inputs: { signal: number }[];
  }[] = [];
  function state(signal: number, bit: number) {
    const key = signal + ":" + bit;
    const known = stateIds.get(key);
    if (known !== undefined) return known;
    const id = signals.length;
    signals.push({ id, signal });
    stateIds.set(key, id);
    return id;
  }
  for (const [
    assignment,
    { targets, bitDependencies },
  ] of assignments.entries()) {
    if (targets.length !== 1 || !bitDependencies) continue;
    for (const { targetBit, reads } of bitDependencies) {
      const inputs = reads.flatMap(({ signal, bits }) =>
        bits.map((bit) => ({ signal: state(signal, bit) })),
      );
      if (inputs.length)
        relations.push({
          assignment,
          inputs,
          targets: [state(targets[0], targetBit)],
        });
    }
  }
  return traceFeedback({ signals, assignments: relations }).map(
    ({ assignment, signal, side }) => ({
      assignment: relations[assignment].assignment,
      signal: signals[signal].signal,
      side,
    }),
  );
}

export function mergeStaticContinuationGraph(
  initial: VideTrace,
  walk?: StaticWalk,
) {
  type Signal = VideTrace["signals"][number];
  type Assignment = VideTrace["assignments"][number];
  type Relation = StaticTraceDiagram["assignments"][number] &
    Pick<
      Assignment,
      | "process"
      | "generateIndices"
      | "hasUnresolvedOperands"
      | "bitDependencies"
      | "fieldRead"
      | "targetField"
    > & {
      id: number;
      inputs: Pick<
        Assignment["inputs"][number],
        "signal" | "kind" | "edge" | "readBits" | "location" | "interfaceRange"
      >[];
      sources: { segment: number; assignment: number }[];
    };
  const signals: Signal[] = [];
  const assignments: Relation[] = [];
  const signalIds = new Map<string, number>();
  const relationIds = new Map<string, number>();
  const feedback: ReturnType<typeof traceFeedback> = [];
  const gaps = new Map<
    string,
    {
      signal: number;
      reason: string;
      waveformUnavailable?: true;
      locations: Assignment["location"][];
      continuationSignals: string[];
      stops: { segment: number; stop: number; nextSegments: number[] }[];
    }
  >();
  const links = new Map<string, number[]>();
  for (const { segment, stop, nextSegment } of walk?.links ?? []) {
    const key = segment + ":" + stop;
    const targets = links.get(key) ?? [];
    targets.push(nextSegment);
    links.set(key, targets);
  }

  let root = 0;
  let hasProjection = false;
  const traces = [
    initial,
    ...(walk?.segments ?? []).map((segment) =>
      "trace" in segment ? segment.trace : undefined,
    ),
  ];
  for (const [segment, trace] of traces.entries()) {
    if (!trace) continue;
    hasProjection ||= !!trace.bitSelection;
    const localSignals = new Map<number, number>();
    const localAssignments = new Map<number, number>();
    for (const signal of trace.signals) {
      const { id, name, declaration, selectedElement, modportAlias } = signal;
      const scope = traceSignalScope(signal);
      const key =
        scope && declaration
          ? JSON.stringify([
              scope,
              name,
              declaration.uri,
              declaration.range.start,
              selectedElement,
              modportAlias,
            ])
          : JSON.stringify([segment, id]);
      let combined = signalIds.get(key);
      if (combined === undefined) {
        combined = signals.length;
        signals.push({ ...signal, id: combined });
        signalIds.set(key, combined);
      }
      localSignals.set(id, combined);
    }
    if (segment === 0) root = localSignals.get(trace.root)!;
    for (const [assignment, relation] of trace.assignments.entries()) {
      const {
        kind,
        instance,
        location,
        process,
        generateIndices,
        hasUnresolvedOperands,
        hierarchicalTargets,
        targetRange,
        writtenBits,
        port,
        value,
      } = relation;
      hasProjection ||= !!(
        targetRange ||
        writtenBits ||
        port?.fromRange ||
        port?.toRange ||
        port?.fromField ||
        port?.toField ||
        port?.indexedPart ||
        port?.fromBit !== undefined ||
        port?.toBit !== undefined ||
        relation.targetField ||
        relation.fieldRead ||
        relation.targetIndex ||
        relation.targetElementIndex ||
        relation.wordRead ||
        relation.inputs.some((input) => input.readBits || input.interfaceRange)
      );
      const dependencies = {
        kind,
        instance,
        location,
        process,
        generateIndices,
        hasUnresolvedOperands,
        targetRange,
        writtenBits,
        value: value?.op === "literal" ? value : undefined,
        hierarchicalTargets: hierarchicalTargets?.map(
          ({ signal, location }) => ({
            signal: localSignals.get(signal),
            location,
          }),
        ),
        port: port && {
          ...port,
          indexSignal:
            port.indexSignal === undefined
              ? undefined
              : localSignals.get(port.indexSignal),
          indexSignals: port.indexSignals
            ?.map((signal) => localSignals.get(signal))
            .filter((signal) => signal !== undefined),
        },
        inputs: relation.inputs.map(
          ({ signal, kind, edge, readBits, location, interfaceRange }) => ({
            signal: localSignals.get(signal)!,
            kind,
            edge,
            readBits,
            location,
            interfaceRange,
          }),
        ),
        targets: relation.targets.map((signal) => localSignals.get(signal)!),
        fieldRead: relation.fieldRead && {
          ...relation.fieldRead,
          signal: localSignals.get(relation.fieldRead.signal)!,
        },
        targetField: relation.targetField && {
          ...relation.targetField,
          signal: localSignals.get(relation.targetField.signal)!,
        },
        bitDependencies: relation.bitDependencies?.map(
          ({ targetBit, reads }) => ({
            targetBit,
            reads: reads.flatMap(({ signal, bits }) => {
              const combined = localSignals.get(signal);
              return combined === undefined ? [] : [{ signal: combined, bits }];
            }),
          }),
        ),
      };
      const key = JSON.stringify(dependencies);
      let combined = relationIds.get(key);
      if (combined === undefined) {
        combined = assignments.length;
        assignments.push({ ...dependencies, id: combined, sources: [] });
        relationIds.set(key, combined);
      }
      assignments[combined].sources.push({ segment, assignment });
      localAssignments.set(assignment, combined);
    }
    for (const { assignment, signal, side } of traceFeedback(trace)) {
      const combinedAssignment = localAssignments.get(assignment);
      const combinedSignal = localSignals.get(signal);
      if (combinedAssignment !== undefined && combinedSignal !== undefined)
        feedback.push({
          assignment: combinedAssignment,
          signal: combinedSignal,
          side,
        });
    }
    const entry = walk?.segments[segment - 1];
    const coverage =
      entry && "coverage" in entry
        ? entry.coverage
        : staticTraceCoverage(trace);
    for (const [stop, item] of coverage.stops.entries()) {
      const signal = localSignals.get(item.signal);
      if (signal === undefined) continue;
      const nextSegments = links.get(segment + ":" + stop) ?? [];
      if (
        nextSegments.length &&
        nextSegments.every(
          (target) => target !== segment && traces[target] !== undefined,
        )
      )
        continue;
      const { reason, waveformUnavailable } = item;
      const key = JSON.stringify([signal, reason, waveformUnavailable]);
      let gap = gaps.get(key);
      if (!gap) {
        gap = {
          signal,
          reason,
          waveformUnavailable,
          stops: [],
          locations: [],
          continuationSignals: [],
        };
        gaps.set(key, gap);
      }
      gap.stops.push({ segment, stop, nextSegments });
      for (const location of item.locations ?? [])
        if (
          !gap.locations.some(
            (known) => JSON.stringify(known) === JSON.stringify(location),
          )
        )
          gap.locations.push(location);
      const requests =
        item.continuationSignals ??
        (item.waveformSignal ? [item.waveformSignal] : []);
      if (!nextSegments.length)
        for (const request of requests)
          if (!gap.continuationSignals.includes(request))
            gap.continuationSignals.push(request);
      for (const [index, target] of nextSegments.entries()) {
        const request = requests[index];
        if (
          request &&
          (target === segment || !traces[target]) &&
          !gap.continuationSignals.includes(request)
        )
          gap.continuationSignals.push(request);
      }
    }
  }
  const bitSelection = initial.bitSelection && {
    bit: initial.bitSelection.bit,
    range: initial.bitSelection.range,
    feedbackEdges: [],
  };
  const diagram = { root, bitSelection, signals, assignments };
  // A signal-level cycle can pass through disjoint bits of one vector.
  const feedbackEdges = hasProjection
    ? [
        ...new Map(
          [...feedback, ...projectedFeedback(assignments)].map((edge) => [
            JSON.stringify(edge),
            edge,
          ]),
        ).values(),
      ]
    : traceFeedback(diagram);
  return {
    schemaVersion: 1 as const,
    ...diagram,
    bitSelection: bitSelection && { ...bitSelection, feedbackEdges },
    status: walk?.status ?? staticTraceCoverage(initial).status,
    feedbackScope: hasProjection
      ? ("segmentsAndKnownBits" as const)
      : ("merged" as const),
    feedbackEdges,
    gaps: [...gaps.values()],
  };
}

export function pageStaticContinuationGraph(
  graph: ReturnType<typeof mergeStaticContinuationGraph>,
  direction: TraceDirection,
  signal: string,
  size?: number,
  cursor?: string,
) {
  const { assignments, signals, page } = staticAssignmentPage(
    graph,
    direction,
    signal,
    ["graph", graph],
    graph.gaps,
    size,
    cursor,
  );
  const ids = new Set(assignments.map(({ id }) => id));
  const feedbackEdges = graph.feedbackEdges.filter(({ assignment }) =>
    ids.has(assignment),
  );
  const bitSelection = graph.bitSelection && {
    ...graph.bitSelection,
    feedbackEdges,
  };
  return {
    graph: { ...graph, assignments, signals, feedbackEdges, bitSelection },
    page,
  };
}

export function mergedStaticMermaid(
  graph: ReturnType<typeof mergeStaticContinuationGraph>,
) {
  const gaps = graph.gaps.map(({ signal, reason, waveformUnavailable }) => ({
    signal,
    reason: waveformUnavailable
      ? "Waveform signal unavailable"
      : isStaticBudgetStop(reason)
        ? "Frontier · " + reason
        : reason,
  }));
  const localAssignments = new Map(
    graph.assignments.map(({ id }, index) => [id, index]),
  );
  const feedback = graph.feedbackEdges.flatMap((edge) => {
    const assignment = localAssignments.get(edge.assignment);
    return assignment === undefined ? [] : [{ ...edge, assignment }];
  });
  return traceMermaidPages(graph, feedback, gaps);
}

export function staticContinuationMermaid(root: string, walk: StaticWalk) {
  const graph = createMermaidFlowchart({
    pending: "stroke-dasharray:4 3",
    failed: "fill:#fff0f0,color:#722,stroke:#b55",
  });
  graph.node("static0", root);
  for (const [index, segment] of walk.segments.entries()) {
    const failed = "error" in segment;
    graph.node(
      "static" + (index + 1),
      segment.signal + (failed ? " · Query failed" : ""),
      { style: failed ? "failed" : undefined },
    );
  }
  for (const [index, signal] of walk.remaining.entries())
    graph.node(
      "static" + (walk.segments.length + index + 1),
      signal + " · Pending",
      { style: "pending" },
    );
  const links = new Set(
    walk.links.map(({ segment, nextSegment }) => segment + "/" + nextSegment),
  );
  for (const link of links) {
    const [from, to] = link.split("/");
    graph.edge("static" + from, "static" + to, "continue", true);
  }
  return graph.pages();
}

export function staticContinuationReport(
  direction: TraceDirection,
  walk: StaticWalk,
  diagrams: readonly string[],
  merged: readonly string[],
) {
  const code = (value: string) => "`" + value.replace(/[`\r\n]/g, " ") + "`";
  const lines = [
    "## Static trace continuations",
    "",
    walk.segments.length + " queried · " + walk.remaining.length + " pending",
    ...(walk.stopReasons.length
      ? ["", "Stop reasons · " + walk.stopReasons.join(", ")]
      : []),
    "",
    "### Combined static dependencies",
    "",
    mermaidMarkdown(merged),
    "",
    "### Continuation overview",
    "",
    mermaidMarkdown(diagrams),
  ];
  for (const [index, segment] of walk.segments.entries()) {
    lines.push("", "### Static continuation " + (index + 1), "");
    if ("error" in segment)
      lines.push(code(segment.signal) + " · " + code(segment.error));
    else lines.push(traceReport(segment.trace, direction, segment.signal));
  }
  if (walk.remaining.length)
    lines.push(
      "",
      "### Pending static queries",
      "",
      ...walk.remaining.map((signal) => "- " + code(signal)),
    );
  return lines.join("\n") + "\n";
}
