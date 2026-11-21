// SPDX-License-Identifier: MPL-2.0

import { pathToFileURL } from "node:url";
import {
  guardEntryLabels,
  temporalEdgeLabel,
  temporalGapLabel,
  traceSignalScope,
  wordWriteLabel,
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
  const instances = new Map(
    trace.signals.map(({ id, instance }) => [id, instance]),
  );
  for (const signal of trace.signals) {
    const id = signalId(signal.id);
    graph.nodes.push({
      id,
      kind: "signal",
      label: signal.name,
      detail: signal.instance ?? "",
      instance: signal.instance,
      signal: signal.instance
        ? [traceSignalScope(signal), signal.name].join(".")
        : undefined,
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
      instance: assignment.instance ?? instances.get(assignment.targets[0]),
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
  for (const [index, event] of time.nodes.entries()) {
    const { signal, point, sources, waveformSignal } = event;
    const id = pointId(index);
    const local = sources.some(({ segment }) => segment === 0);
    const declaration =
      event.declaration ??
      (local ? signals.get(point.signal)?.declaration : undefined);
    if (local && waveformSignal === undefined)
      signalNodes.set(id, point.signal);
    if (declaration) locations.set(id, declaration);
    const split = signal.lastIndexOf(".");
    graph.nodes.push({
      id,
      kind: "signal",
      label: signal.slice(split + 1),
      instance: split > 0 ? signal.slice(0, split) : undefined,
      signal,
      ...(waveformSignal ? { waveformSignal, wave: true } : {}),
      ...(waveformSignal === null ? { wave: false } : {}),
      detail: [
        "tick " + point.tick,
        point.value === undefined ? undefined : "= " + point.value,
        point.initialSample ? "初始波形采样" : undefined,
        point.orderAtTick === undefined
          ? undefined
          : "事件 " + point.orderAtTick,
        point.enumConstant
          ? "RTL 枚举常量"
          : point.packageParameter
            ? "RTL package 参数"
            : point.elaboratedParameter
              ? "展开参数"
              : point.operandEvaluationOrdinal !== undefined
                ? "求值 " + point.operandEvaluationOrdinal + " 的操作数"
                : point.executionOnly
                  ? "执行记录"
                  : point.sampleOnly
                    ? "采样"
                    : undefined,
        point.recordedWriter
          ? "提交 " + point.recordedWriter.commitOrdinal
          : undefined,
        ...guardEntryLabels(
          point.recordedWriter?.evaluation?.guardEntryValues,
          point.recordedWriter?.evaluation?.guardEntryTicks,
        ),
      ]
        .filter(Boolean)
        .join(" · "),
      source: !!declaration,
    });
  }
  for (const [index, { point }] of time.nodes.entries()) {
    const id = pointId(index);
    const task = point.recordedTaskTransfer;
    if (task) {
      const callId = id + "-task-input";
      const writeId = id + "-member-write";
      addExecutionSource(
        callId,
        "Task input commit " + task.input.ordinal,
        "tick " + task.input.tick,
        task.input.source,
      );
      addExecutionSource(
        writeId,
        "Member write commit " + task.write.ordinal,
        "tick " + task.write.tick,
        task.write.source,
      );
      graph.edges.push(
        { from: callId, to: writeId },
        { from: writeId, to: id },
      );
      for (const [offset, read] of task.reads.entries()) {
        const readId = callId + "-" + offset;
        addExecutionSource(
          readId,
          read.operation,
          read.value + " · tick " + read.tick + " · evaluation " + read.ordinal,
          read.source,
        );
        graph.edges.push({ from: readId, to: callId });
      }
    }
  }

  function addExecutionSource(
    id: string,
    label: string,
    detail: string,
    source: { file: string; line: number; column: number },
  ) {
    graph.nodes.push({ id, label, detail, kind: "logic", source: true });
    locations.set(id, {
      uri: pathToFileURL(source.file).href,
      range: { start: { line: source.line - 1, character: source.column - 1 } },
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
      instance: record?.instance ?? graph.nodes[target]?.instance,
    });
    if (record?.location) locations.set(id, record.location);
    graph.edges.push({ from: id, to: pointId(target) });
    return id;
  };

  for (const [target, { point, sources }] of time.nodes.entries())
    for (const assignment of point.initializationAssignments ?? [])
      addAssignment(sources[0].segment, assignment, target);

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
  for (const [
    index,
    { point, sources, recordedWordEvidence },
  ] of time.nodes.entries()) {
    if (point.recordedWriter && !point.recordedWordWriters)
      addAssignment(sources[0].segment, point.recordedWriter.assignment, index);
    for (const { segment, node, writers } of recordedWordEvidence ?? []) {
      for (const [offset, writer] of (writers ?? []).entries()) {
        const id = `write-${segment}-${node}-${offset}`;
        const location =
          time.assignmentSources[segment]?.[writer.assignment]?.location;
        graph.nodes.push({
          id,
          kind: "logic",
          label: "提交 " + writer.commitOrdinal,
          detail: wordWriteLabel(writer),
          source: !!location,
          instance: graph.nodes[index]?.instance,
        });
        if (location) locations.set(id, location);
        graph.edges.push({ from: id, to: pointId(index) });
      }
    }
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
        instance: gap.signal.includes(".")
          ? gap.signal.slice(0, gap.signal.lastIndexOf("."))
          : undefined,
        kind: "gap",
        detail:
          "tick " + gap.evidence.tick + " · " + temporalGapLabel(gap.evidence),
      });
      if (gap.evidence.declaration) locations.set(id, gap.evidence.declaration);
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
