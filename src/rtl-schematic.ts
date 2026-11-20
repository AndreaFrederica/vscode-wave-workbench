// SPDX-License-Identifier: MPL-2.0

import {
  temporalEdgeLabel,
  temporalGapLabels,
  type mergeTemporalContinuationGraph,
  type StaticTraceDiagram,
  type VideTrace,
} from "./rtl-trace";
import type { SchematicGraph } from "./shared/schematic";

export function traceSchematic(
  trace: StaticTraceDiagram & {
    frontier?: VideTrace["frontier"];
    diagnostics?: VideTrace["diagnostics"];
    gaps?: readonly unknown[];
    status?: string;
  },
) {
  const signalId = (id: number) => "signal-" + id;
  const graph: SchematicGraph = {
    nodes: [],
    edges: [],
    root: signalId(trace.root),
    partial: !!(
      trace.frontier?.length ||
      trace.diagnostics?.length ||
      trace.gaps?.length ||
      (trace.status && trace.status !== "resolvedWithinScope")
    ),
  };
  const locations = new Map<
    string,
    VideTrace["signals"][number]["declaration"]
  >();
  const signalNodes = new Map<string, number>();
  for (const signal of trace.signals) {
    const id = signalId(signal.id);
    graph.nodes.push({
      id,
      kind: "signal",
      label: signal.name,
      detail: signal.instance ?? "",
      source: !!signal.declaration,
    });
    signalNodes.set(id, signal.id);
    locations.set(id, signal.declaration);
  }
  trace.assignments.forEach((assignment, index) => {
    const id = "assignment-" + index;
    const clocked =
      assignment.kind === "nonblocking" &&
      assignment.inputs.some(
        (input) =>
          input.kind === "trigger" &&
          (input.edge === "rising" || input.edge === "falling"),
      );
    const mux = assignment.value?.op === "conditional";
    const operator =
      assignment.value?.op === "binary" || assignment.value?.op === "unary"
        ? assignment.value.args[0]
        : undefined;
    graph.nodes.push({
      id,
      label: clocked ? "DFF" : mux ? "MUX" : operator || assignment.kind,
      detail: assignment.targetRange ? assignment.targetRange.join(":") : "",
      kind: clocked ? "register" : mux ? "mux" : "logic",
      source: true,
    });
    locations.set(id, assignment.location);
    graph.partial ||=
      "hasUnresolvedOperands" in assignment &&
      assignment.hasUnresolvedOperands === true;
    const inputs = new Map<number, boolean>();
    for (const input of assignment.inputs)
      inputs.set(
        input.signal,
        (inputs.get(input.signal) ?? true) && input.kind !== "data",
      );
    for (const [signal, control] of inputs)
      if (signalNodes.has(signalId(signal)))
        graph.edges.push({ from: signalId(signal), to: id, control });
    for (const target of new Set(assignment.targets))
      if (signalNodes.has(signalId(target)))
        graph.edges.push({ from: id, to: signalId(target) });
  });
  return { graph, locations, signalNodes };
}

export function traceTimeSchematic(
  trace: VideTrace,
  time: ReturnType<typeof mergeTemporalContinuationGraph>,
) {
  const pointId = (index: number) => "event-" + index;
  const graph: SchematicGraph = {
    nodes: [],
    edges: [],
    root: time.roots.length ? pointId(time.roots[0]) : "",
    roots: time.roots.map(pointId),
    partial: time.coverage.status === "partial",
  };
  const locations = new Map<
    string,
    VideTrace["signals"][number]["declaration"]
  >();
  const signalNodes = new Map<string, number>();
  const signals = new Map(trace.signals.map((signal) => [signal.id, signal]));
  for (const [index, { signal, point, sources }] of time.nodes.entries()) {
    const id = pointId(index);
    const local = sources.some(({ segment }) => segment === 0);
    const declaration = local
      ? signals.get(point.signal)?.declaration
      : undefined;
    if (local) signalNodes.set(id, point.signal);
    if (declaration) locations.set(id, declaration);
    const split = signal.lastIndexOf(".");
    graph.nodes.push({
      id,
      kind: "signal",
      label: signal.slice(split + 1),
      instance: split > 0 ? signal.slice(0, split) : undefined,
      detail: [
        "tick " + point.tick,
        point.value === undefined ? undefined : "= " + point.value,
        point.orderAtTick === undefined
          ? undefined
          : "事件 " + point.orderAtTick,
        point.sampleOnly ? "采样" : undefined,
        point.recordedWriter
          ? "提交 " + point.recordedWriter.commitOrdinal
          : undefined,
      ]
        .filter(Boolean)
        .join(" · "),
      source: !!declaration,
    });
  }

  const assignments = new Set<string>();
  const addAssignment = (
    segment: number,
    assignment: number,
    target: number,
  ) => {
    const id = `writer-${segment}-${assignment}-${target}`;
    if (assignments.has(id)) return id;
    assignments.add(id);
    const record = time.assignmentSources[segment]?.[assignment];
    graph.nodes.push({
      id,
      label: record?.kind ?? "RTL 赋值",
      kind: "logic",
      detail: "tick " + time.nodes[target].point.tick,
      source: !!record?.location,
    });
    if (record?.location) locations.set(id, record.location);
    graph.edges.push({ from: id, to: pointId(target) });
    return id;
  };

  for (const edge of time.edges) {
    for (const assignment of [
      edge.assignment,
      ...(edge.alsoAssignments ?? []),
    ]) {
      graph.edges.push({
        from: pointId(edge.source),
        to: addAssignment(edge.segment, assignment, edge.target),
        label: temporalEdgeLabel(edge),
        control: edge.kind !== "data",
      });
    }
  }
  // Recorded writes can have no incoming dependency, such as a constant assignment.
  for (const [index, { point, sources }] of time.nodes.entries()) {
    const writers =
      point.recordedWordWriters ??
      (point.recordedWriter ? [point.recordedWriter] : []);
    for (const writer of writers)
      addAssignment(sources[0].segment, writer.assignment, index);
  }
  for (const [index, gap] of time.gaps.entries()) {
    let id: string;
    if (gap.status === "joined" && gap.source !== undefined) {
      id = pointId(gap.source);
    } else {
      id = "gap-" + index;
      graph.nodes.push({
        id,
        label: gap.signal,
        kind: "gap",
        detail:
          "tick " +
          gap.evidence.tick +
          " · " +
          temporalGapLabels[gap.evidence.reason],
      });
    }
    if (gap.target !== undefined) {
      const use = gap.evidence.use;
      graph.edges.push({
        from: id,
        to: use
          ? addAssignment(gap.segment, use.assignment, gap.target)
          : pointId(gap.target),
        control: use?.kind !== "data",
        label: gap.status === "joined" ? "续查" : undefined,
      });
    }
    if (gap.anchor !== undefined && id !== pointId(gap.anchor))
      graph.edges.push({ from: id, to: pointId(gap.anchor), control: true });
  }
  return { graph, locations, signalNodes };
}
