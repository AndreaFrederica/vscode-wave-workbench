// SPDX-License-Identifier: MPL-2.0

import {
  declaredSignalName,
  guardEntryLabels,
  recordedTaskReport,
  temporalEdgeLabel,
  temporalFeedbackReport,
  temporalGapLabel,
  temporalGapUseLabel,
  wordWriteLabel,
  type mergeTemporalContinuationGraph,
} from "./rtl-trace";
import type { RecordedWriter } from "./rtl-trace-candidates";
import { temporalFeedback } from "./rtl-trace-feedback";
import { mermaidMarkdown } from "./trace-mermaid";

type TimeGraph = ReturnType<typeof mergeTemporalContinuationGraph>;
export type TracePathMode = "shortest" | "all";
type TracePathSelector = {
  signal: string;
  tick: string;
  changeOrder?: number;
  callbackOrdinal?: number;
};

export function selectTracePathNodes(
  graph: TimeGraph,
  nodeIds: readonly number[],
  selectors: readonly unknown[],
  operation?: AbortSignal,
) {
  if (!nodeIds.length && !selectors.length)
    throw Error("Provide nodeIds or nodeSelectors for the time graph.");
  const selected = new Set(nodeIds);
  const matches = selectors.map((entry) => {
    const selector = entry as TracePathSelector | undefined;
    if (
      !selector ||
      typeof selector.signal !== "string" ||
      !selector.signal.trim() ||
      typeof selector.tick !== "string" ||
      !/^\d{1,20}$/.test(selector.tick) ||
      (selector.changeOrder !== undefined &&
        (!Number.isSafeInteger(selector.changeOrder) ||
          selector.changeOrder < 1)) ||
      (selector.callbackOrdinal !== undefined &&
        (!Number.isSafeInteger(selector.callbackOrdinal) ||
          selector.callbackOrdinal < 0))
    )
      throw Error(
        "Use a signal path and decimal tick, with an optional positive changeOrder or non-negative callbackOrdinal.",
      );
    const { signal, changeOrder, callbackOrdinal } = selector;
    const tick = BigInt(selector.tick).toString();
    const candidates: number[] = [];
    for (const [id, node] of graph.nodes.entries()) {
      if (id % 128 === 0) operation?.throwIfAborted();
      const point = node.point;
      if (
        point.tick !== tick ||
        (node.signal !== signal &&
          declaredSignalName(node.signal) !== signal &&
          (!node.waveformSignal ||
            (node.waveformSignal !== signal &&
              declaredSignalName(node.waveformSignal) !== signal))) ||
        (changeOrder !== undefined &&
          (point.sampleOnly ||
            point.initialSample ||
            point.executionOnly ||
            (point.orderAtTick ?? 1) !== changeOrder)) ||
        (callbackOrdinal !== undefined &&
          point.valueChangeOrdinal !== callbackOrdinal)
      )
        continue;
      candidates.push(id);
      selected.add(id);
      if (selected.size > 16)
        throw Error(
          "Path selection exceeds 16 nodes. Refine the signal, tick or change order.",
        );
    }
    return {
      signal,
      tick,
      changeOrder,
      ...(callbackOrdinal === undefined ? {} : { callbackOrdinal }),
      nodeIds: candidates,
    };
  });
  if (!selected.size) throw Error("No time graph nodes match the selectors.");
  return { nodeIds: [...selected], matches };
}

type PathLink = {
  source: number;
  target: number;
} & ({ edge: TimeGraph["edges"][number] } | { gap: TimeGraph["gaps"][number] });

export function dependencyPaths<
  Link extends { source: number; target: number },
>(
  rootNodes: readonly number[],
  requested: readonly number[],
  incoming: ReadonlyMap<number, readonly Link[]>,
  mode: TracePathMode,
  operation?: AbortSignal,
) {
  const parent = new Map<number, Link | null>();
  const queue = [...rootNodes];
  for (const root of queue) parent.set(root, null);
  const searching = new Set(requested.filter((id) => !parent.has(id)));
  for (
    let index = 0;
    index < queue.length && (mode === "all" || searching.size);
    index++
  ) {
    if (index % 128 === 0) operation?.throwIfAborted();
    for (const link of incoming.get(queue[index]) ?? []) {
      if (parent.has(link.source)) continue;
      parent.set(link.source, link);
      queue.push(link.source);
      searching.delete(link.source);
    }
  }

  const selected = new Set(requested);
  const links = new Set<Link>();
  const roots = new Set<number>();
  const paths = requested.map((node) => {
    if (!parent.has(node)) return { node, status: "unreachable" as const };
    let root = node;
    let hops = 0;
    for (let link = parent.get(root); link; link = parent.get(root)) {
      links.add(link);
      root = link.target;
      selected.add(root);
      hops++;
    }
    roots.add(root);
    return { node, status: "found" as const, root, hops };
  });
  if (mode === "all") {
    const outgoing = new Map<number, Link[]>();
    // Only links that can reach a root can belong to the focused graph.
    for (const target of queue)
      for (const link of incoming.get(target) ?? []) {
        const list = outgoing.get(link.source);
        if (list) list.push(link);
        else outgoing.set(link.source, [link]);
      }
    const rootIds = new Set(rootNodes);
    const reachable = [...requested];
    const visited = new Set(reachable);
    for (let index = 0; index < reachable.length; index++) {
      if (index % 128 === 0) operation?.throwIfAborted();
      const node = reachable[index];
      if (rootIds.has(node)) {
        roots.add(node);
        continue;
      }
      for (const link of outgoing.get(node) ?? []) {
        links.add(link);
        selected.add(link.target);
        if (!visited.has(link.target)) {
          visited.add(link.target);
          reachable.push(link.target);
        }
      }
    }
  }
  return { paths, selected, links, roots };
}

export function traceGraphPaths(
  graph: TimeGraph & {
    nodes: (TimeGraph["nodes"][number] & { sourceNode?: number })[];
  },
  nodeIds: readonly number[],
  operation?: AbortSignal,
  mode: TracePathMode = "shortest",
) {
  const requested = [...new Set(nodeIds)];
  if (requested.some((id) => !Number.isSafeInteger(id) || !graph.nodes[id]))
    throw Error("A requested node is outside the trace graph snapshot.");

  const incoming = new Map<number, PathLink[]>();
  function add(link: PathLink) {
    const links = incoming.get(link.target);
    if (links) links.push(link);
    else incoming.set(link.target, [link]);
  }
  for (const edge of graph.edges)
    add({ source: edge.source, target: edge.target, edge });
  for (const gap of graph.gaps) {
    if (gap.status !== "joined" || gap.source === undefined) continue;
    for (const target of new Set([gap.target, gap.anchor])) {
      if (target !== undefined && target !== gap.source)
        add({ source: gap.source, target, gap });
    }
  }

  const { paths, selected, links, roots } = dependencyPaths(
    graph.roots,
    requested,
    incoming,
    mode,
    operation,
  );
  const originalNodes = [...selected].sort((a, b) => a - b);
  const local = new Map(originalNodes.map((id, index) => [id, index]));
  const nodes = originalNodes.map((id) => ({
    ...graph.nodes[id],
    sourceNode: graph.nodes[id].sourceNode ?? id,
  }));
  const edges: TimeGraph["edges"] = [];
  const joinedGaps = new Map<
    TimeGraph["gaps"][number],
    TimeGraph["gaps"][number]
  >();
  const assignmentSources: TimeGraph["assignmentSources"] =
    graph.assignmentSources.map((sources) => sources && {});
  function retainAssignment(segment: number, assignment: number) {
    const source = graph.assignmentSources[segment]?.[assignment];
    if (source) assignmentSources[segment]![assignment] = source;
  }
  for (const link of links) {
    const source = local.get(link.source)!;
    const target = local.get(link.target)!;
    if ("edge" in link) {
      const { edge } = link;
      edges.push({ ...edge, source, target });
      retainAssignment(edge.segment, edge.assignment);
      for (const assignment of edge.alsoAssignments ?? [])
        retainAssignment(edge.segment, assignment);
    } else {
      const { gap } = link;
      const selectedGap = joinedGaps.get(gap) ?? {
        ...gap,
        source,
        target: undefined,
        anchor: undefined,
      };
      if (link.target === gap.target) selectedGap.target = target;
      if (link.target === gap.anchor) selectedGap.anchor = target;
      joinedGaps.set(gap, selectedGap);
    }
  }
  for (const node of nodes) {
    for (const assignment of node.point.initializationAssignments ?? [])
      retainAssignment(node.sources[0].segment, assignment);
    for (const evidence of node.recordedWordEvidence ?? []) {
      for (const writer of evidence.writers ?? [])
        retainAssignment(evidence.segment, writer.assignment);
    }
    if (node.point.recordedWriter)
      retainAssignment(
        node.sources[0].segment,
        node.point.recordedWriter.assignment,
      );
  }
  const byReason: TimeGraph["gapSummary"]["byReason"] = {};
  const byBindingIssue: TimeGraph["gapSummary"]["byBindingIssue"] = {};
  const otherGaps: TimeGraph["gaps"] = [];
  for (const gap of graph.gaps) {
    const source = gap.source === undefined ? undefined : local.get(gap.source);
    if (gap.status === "joined") {
      if (source === undefined) continue;
      // A continuation can merge into an existing node without adding a hop.
      const linked = joinedGaps.get(gap);
      const target = gap.target === gap.source ? source : linked?.target;
      const anchor = gap.anchor === gap.source ? source : linked?.anchor;
      if (target === undefined && anchor === undefined) continue;
      joinedGaps.set(gap, { ...gap, target, anchor, source });
    } else {
      const target =
        gap.target === undefined ? undefined : local.get(gap.target);
      const anchor =
        gap.anchor === undefined ? undefined : local.get(gap.anchor);
      if (target === undefined && anchor === undefined) continue;
      otherGaps.push({ ...gap, target, anchor, source });
    }
    if (gap.evidence.use)
      retainAssignment(gap.segment, gap.evidence.use.assignment);
  }
  const gaps = [...joinedGaps.values(), ...otherGaps];
  const counts = { joined: 0, pending: 0, unmatched: 0, unresolved: 0 };
  for (const { evidence, status } of gaps) {
    counts[status]++;
    (byReason[evidence.reason] ??= {
      joined: 0,
      pending: 0,
      unmatched: 0,
      unresolved: 0,
    })[status]++;
    if (evidence.bindingIssue)
      byBindingIssue[evidence.bindingIssue] =
        (byBindingIssue[evidence.bindingIssue] ?? 0) + 1;
  }
  return {
    mode,
    paths,
    graph: {
      ...graph,
      roots: [...roots].map((root) => local.get(root)!),
      nodes,
      edges,
      gaps,
      feedbackEdges: temporalFeedback(nodes.length, edges, gaps),
      assignmentSources,
      gapSummary: {
        ...counts,
        byReason,
        byBindingIssue,
      },
    },
  };
}

export function tracePathReport(
  { graph, mode, paths }: ReturnType<typeof traceGraphPaths>,
  pages: readonly string[],
) {
  const code = (value: string) => "`" + value.replace(/[`\r\n]/g, " ") + "`";
  function writerLines(writer: RecordedWriter, segment?: number) {
    const evaluation = writer.evaluation;
    return [
      "  - " +
        (segment === undefined ? "" : "S" + segment + " · ") +
        wordWriteLabel(writer),
      ...Object.entries(evaluation?.operandValues ?? {}).map(
        ([operand, value]) =>
          "    - Recorded operand " + code(operand) + " = " + code(value),
      ),
      ...guardEntryLabels(
        evaluation?.guardEntryValues,
        evaluation?.guardEntryTicks,
        evaluation?.guardEntryNextOrdinals,
      ).map((label) => "    - " + code(label)),
      ...(evaluation?.externalSteps ?? []).map(
        ({ operation, source, value }, index) =>
          "    - External step " +
          (index + 1) +
          " · " +
          code(operation) +
          (value === undefined ? "" : " = " + code(value)) +
          " · " +
          code(source.file) +
          " L" +
          source.line +
          ":" +
          source.column +
          " · Source " +
          source.identity,
      ),
    ];
  }
  const endpoints = (gap: TimeGraph["gaps"][number]) =>
    [...new Set([gap.anchor, gap.target])]
      .filter((id) => id !== undefined)
      .map((id) => "t" + id)
      .join(", ");
  const sources = graph.assignmentSources.flatMap((assignments, segment) =>
    Object.entries(assignments ?? {}).map(
      ([id, { kind, instance, location }]) =>
        "- S" +
        segment +
        "/A" +
        (Number(id) + 1) +
        " · " +
        kind +
        (instance ? " · " + code(instance) : "") +
        " · " +
        code(location.uri) +
        " L" +
        (location.range.start.line + 1) +
        ":" +
        (location.range.start.character + 1),
    ),
  );
  return [
    "# Selected time graph paths",
    "",
    ...(mode === "all"
      ? [
          "Every recorded branch from the selected nodes to a traced root is included. The hop counts describe the shortest routes.",
          "",
        ]
      : []),
    ...paths.map((path) =>
      path.status === "found"
        ? "- Node " +
          path.node +
          " reaches root " +
          path.root +
          " in " +
          path.hops +
          " hops."
        : "- Node " + path.node + " has no path to a root in this snapshot.",
    ),
    "",
    "Parent trace coverage · " +
      [graph.coverage.status, ...graph.coverage.reasons].join(", "),
    "",
    mermaidMarkdown(pages),
    ...temporalFeedbackReport(graph.feedbackEdges, "##"),
    "",
    "## Observed values and recorded writes",
    "",
    ...graph.nodes.flatMap((node, index) => [
      "- t" +
        index +
        " · Original node " +
        node.sourceNode +
        " · " +
        code(node.signal) +
        " @ " +
        node.point.tick +
        " " +
        graph.scale +
        "/tick" +
        (node.point.value === undefined ? "" : " · " + code(node.point.value)) +
        (node.point.orderAtTick === undefined
          ? ""
          : " · Change " + node.point.orderAtTick) +
        (node.point.valueChangeOrdinal === undefined
          ? ""
          : " · Value-change callback " + node.point.valueChangeOrdinal),
      ...(node.point.recordedWriter
        ? writerLines(node.point.recordedWriter)
        : []),
      ...(node.recordedWordEvidence ?? []).flatMap(
        ({ segment, writers, unresolved }) => [
          ...(writers ?? []).flatMap((writer) => writerLines(writer, segment)),
          ...(unresolved?.length
            ? [
                "  - Unresolved bit ranges · " +
                  unresolved
                    .map((range) => "[" + range.join(":") + "]")
                    .join(", "),
              ]
            : []),
        ],
      ),
    ]),
    ...recordedTaskReport(
      graph.nodes.map(({ point }) => point),
      (point, index) =>
        "t" + index + " · " + graph.nodes[index].signal + " @ " + point.tick,
      "##",
    ),
    "",
    "## Path edges",
    "",
    ...graph.edges.map(
      (edge) =>
        "- t" +
        edge.source +
        " → t" +
        edge.target +
        " · " +
        temporalEdgeLabel(edge) +
        " · S" +
        edge.segment +
        "/A" +
        (edge.assignment + 1),
    ),
    ...graph.gaps
      .filter(({ status }) => status === "joined")
      .map((gap) => {
        const from = "t" + gap.source;
        const to = endpoints(gap);
        const segment =
          "S" +
          gap.segment +
          (gap.nextSegment === undefined ? "" : " → S" + gap.nextSegment);
        return (
          "- " +
          (to === from ? from : from + " → " + to) +
          " · Joined continuation " +
          segment +
          " · " +
          temporalGapLabel(gap.evidence) +
          (gap.evidence.use?.evidence
            ? " · " + temporalGapUseLabel(gap.evidence.use)
            : "")
        );
      }),
    ...(graph.gaps.some(({ status }) => status !== "joined")
      ? [
          "",
          "## Evidence gaps on these paths",
          "",
          ...graph.gaps.flatMap((gap) => {
            if (gap.status === "joined") return [];
            const { evidence } = gap;
            const reference =
              evidence.use &&
              "S" + gap.segment + "/A" + (evidence.use.assignment + 1);
            const lines = [
              "- " +
                code(gap.signal) +
                " @ " +
                evidence.tick +
                " → " +
                endpoints(gap) +
                " · " +
                gap.status +
                " · " +
                temporalGapLabel(evidence) +
                (reference ? " · " + reference : ""),
            ];
            if (evidence.continuation) {
              const { signal, tick, changeOrder, historyStart } =
                evidence.continuation;
              lines.push(
                "  - Continue from " +
                  code(signal) +
                  " @ " +
                  tick +
                  (changeOrder === undefined
                    ? ""
                    : " · Change " + changeOrder) +
                  (historyStart === undefined
                    ? ""
                    : " · History start " + historyStart),
              );
            }
            return lines;
          }),
        ]
      : []),
    "",
    "## RTL assignment sources",
    "",
    ...sources,
    "",
  ].join("\n");
}
