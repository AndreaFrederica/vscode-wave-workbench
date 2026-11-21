// SPDX-License-Identifier: MPL-2.0

import type * as vscode from "vscode";
import {
  isPortIndex,
  portSourceSelection,
  selectionText,
  temporalGapLabel,
  temporalGapUseLabel,
  guardEntryLabels,
  staticTraceCoverage,
  wordWriteLabel,
  type mergeTemporalContinuationGraph,
  type TemporalContinuation,
  type TraceDirection,
  type VideTrace,
} from "./rtl-trace";
import type {
  buildTemporalTrace,
  RecordedWordWriter,
  TemporalGap,
} from "./rtl-trace-candidates";
import type { mergeStaticContinuationGraph } from "./rtl-static-continuations";
import {
  runtimeInputLabel,
  type RuntimeInputEvidence,
} from "./rtl-runtime-inputs";
import type {
  readExecutionEvidence,
  ResolvedExternalStep,
} from "./rtl-execution";

type Assignment = VideTrace["assignments"][number];
type Signal = VideTrace["signals"][number];
type TemporalTrace = ReturnType<typeof buildTemporalTrace>;
type TemporalEdge = TemporalTrace["edges"][number];
type CombinedTimeGraph = ReturnType<typeof mergeTemporalContinuationGraph>;
type CombinedStaticGraph = ReturnType<typeof mergeStaticContinuationGraph>;
type StaticAssignment = Pick<
  Assignment,
  | "kind"
  | "location"
  | "instance"
  | "inputs"
  | "targets"
  | "port"
  | "writtenBits"
  | "targetRange"
  | "targetIndex"
  | "bitDependencies"
  | "hasUnresolvedOperands"
> & { id?: number };
type CombinedGap = CombinedTimeGraph["gaps"][number];
const combinedGapPageSize = 128;
type WaveformTarget =
  | { signal: Signal; bit?: number; waveformSignal?: undefined }
  | { waveformSignal: string; signal?: undefined; bit?: undefined };
type CombinedTransition = {
  kind: "combinedTransition";
  index: number;
  event: CombinedTimeGraph["nodes"][number];
  ancestry: ReadonlySet<number>;
  edge?: TemporalEdge;
  continuation?: CombinedGap;
};
type CombinedAssignment = {
  kind: "combinedAssignment";
  target: CombinedTransition;
  segment: number;
  assignment: number;
  edges: CombinedTimeGraph["edges"];
  gaps: CombinedGap[];
  writes: RecordedWordWriter[];
};
type TemporalAssignmentEvidence = {
  edges: TemporalEdge[];
  gaps: TemporalGap[];
};
type Transition = {
  kind: "transition";
  index: number;
  point: TemporalTrace["nodes"][number];
  ancestry?: ReadonlySet<number>;
  edge?: TemporalEdge;
};
type Replay = Awaited<ReturnType<typeof readExecutionEvidence>>;
type ReplayEvent = Replay["events"][number];
export type TraceLocation = Assignment["location"];

type Node =
  | {
      kind: "signal";
      generation: number;
      signal: Signal;
      ancestry: ReadonlySet<string>;
      bits?: readonly number[];
      rootSelection?: string;
      relationship?: string;
    }
  | {
      kind: "assignment";
      assignment: StaticAssignment;
      ancestry: ReadonlySet<string>;
      from?: { signal: number; bits: readonly number[] };
    }
  | { kind: "timeline" }
  | Transition
  | {
      kind: "temporalAssignment";
      assignment: Assignment;
      target: Transition;
      evidence: TemporalAssignmentEvidence;
    }
  | { kind: "temporalGaps" }
  | { kind: "temporalGap"; gap: TemporalGap }
  | { kind: "temporalContinuation"; gap: TemporalGap }
  | { kind: "combinedTimeline" }
  | { kind: "resumeCombined"; generation: number }
  | { kind: "combinedStaticRoot" }
  | { kind: "combinedGaps" }
  | { kind: "combinedGapPage"; start: number; end: number; generation: number }
  | CombinedTransition
  | CombinedAssignment
  | { kind: "combinedGap"; gap: CombinedGap }
  | {
      kind: "staticFrontier";
      generation: number;
      signal: Signal;
      reason: string;
      selection?: string;
      waveformSignal?: string;
    }
  | { kind: "runtimeInputs" }
  | { kind: "runtimeInput"; input: RuntimeInputEvidence }
  | { kind: "execution" }
  | { kind: "executionEvent"; event: ReplayEvent }
  | {
      kind: "executionSource";
      source: NonNullable<ReplayEvent["source"]>;
      step?: ResolvedExternalStep;
      label?: string;
    }
  | { kind: "notice"; label: string; location?: TraceLocation };

function recordedTaskSources(point: TemporalTrace["nodes"][number]): Node[] {
  const task = point.recordedTaskTransfer;
  if (!task) return [];
  return [
    {
      kind: "executionSource",
      label: "Task input commit " + task.input.ordinal,
      source: task.input.source,
    },
    {
      kind: "executionSource",
      label: "Member write commit " + task.write.ordinal,
      source: task.write.source,
    },
    ...task.reads.map(
      (step): Node => ({ kind: "executionSource", source: step.source, step }),
    ),
  ];
}

export function createTraceExplorer(
  api: typeof vscode,
  context: vscode.ExtensionContext,
  open: (location: TraceLocation) => Promise<void>,
  addSignal: (
    signal?: Signal,
    bit?: number,
    waveformSignal?: string,
  ) => Promise<void>,
  copy: (signal: Signal) => Promise<void>,
  retrace: (
    signal: Signal,
    direction: TraceDirection,
    point?: Pick<TemporalGap, "tick" | "bit" | "continuation">,
    packedSelection?: string,
    continuationSignal?: string,
  ) => Promise<void>,
  jumpToTick: (tick: string) => Promise<void>,
  resumeCombined: (request?: TemporalContinuation | string) => Promise<void>,
) {
  const changed = new api.EventEmitter<void>();
  let trace: VideTrace | undefined;
  let direction: TraceDirection = "drivers";
  let observations = new Map<number, string>();
  let staticStops: ReturnType<typeof staticTraceCoverage>["stops"] = [];
  let temporal: TemporalTrace | undefined;
  let combined: CombinedTimeGraph | undefined;
  let pendingContinuations = 0;
  let pendingStaticSignals = new Set<string>();
  let combinedGeneration = 0;
  let combinedStatic: CombinedStaticGraph | undefined;
  let signalGeneration = 0;
  const combinedAssignments = new Map<
    number,
    Map<string, Omit<CombinedAssignment, "kind" | "target">>
  >();
  const combinedAnchors = new Map<number, CombinedGap[]>();
  let remainingCombinedGaps: CombinedGap[] = [];
  const recordedFields = new Set<number>();
  let runtimeInputs: readonly RuntimeInputEvidence[] = [];
  let replay: { evidence: Replay; canJump: boolean } | undefined;
  const temporalAssignments = new Map<
    number,
    Map<number, TemporalAssignmentEvidence>
  >();
  const signals = new Map<number, Signal>();
  const relations = new Map<number, StaticAssignment[]>();
  const signalKey = (id: number, bits?: readonly number[]) =>
    id + ":" + (bits?.join(",") ?? "*");
  function setCombined(next?: CombinedTimeGraph, pending = 0) {
    if (combined !== next || pendingContinuations !== pending)
      combinedGeneration++;
    pendingContinuations = pending;
    if (combined === next) return;
    combined = next;
    combinedAssignments.clear();
    combinedAnchors.clear();
    remainingCombinedGaps =
      next?.gaps.filter(({ status }) => status !== "joined") ?? [];
    if (!next) return;
    function evidenceAt(target: number, segment: number, assignment: number) {
      const entries = combinedAssignments.get(target) ?? new Map();
      combinedAssignments.set(target, entries);
      const key = segment + ":" + assignment;
      const entry = entries.get(key) ?? {
        segment,
        assignment,
        edges: [],
        gaps: [],
        writes: [],
      };
      entries.set(key, entry);
      return entry;
    }
    for (const edge of next.edges) {
      evidenceAt(edge.target, edge.segment, edge.assignment).edges.push(edge);
      for (const assignment of edge.alsoAssignments ?? [])
        evidenceAt(edge.target, edge.segment, assignment).edges.push(edge);
    }
    for (const [
      target,
      { point, sources, recordedWordEvidence },
    ] of next.nodes.entries()) {
      for (const assignment of point.initializationAssignments ?? [])
        evidenceAt(target, sources[0].segment, assignment);
      if (point.recordedWriter && !point.recordedWordWriters)
        evidenceAt(target, sources[0].segment, point.recordedWriter.assignment);
      for (const { segment, writers } of recordedWordEvidence ?? [])
        for (const writer of writers ?? [])
          evidenceAt(target, segment, writer.assignment).writes.push(writer);
    }
    for (const gap of next.gaps) {
      if (gap.target !== undefined && gap.evidence.use)
        evidenceAt(
          gap.target,
          gap.segment,
          gap.evidence.use.assignment,
        ).gaps.push(gap);
      if (gap.anchor !== undefined && gap.source !== gap.anchor) {
        const anchors = combinedAnchors.get(gap.anchor) ?? [];
        anchors.push(gap);
        combinedAnchors.set(gap.anchor, anchors);
      }
    }
  }
  function combinedTransition(
    index: number,
    ancestry: ReadonlySet<number>,
    edge?: TemporalEdge,
    continuation?: CombinedGap,
  ): CombinedTransition {
    return {
      kind: "combinedTransition",
      index,
      event: combined!.nodes[index],
      ancestry,
      edge,
      continuation,
    };
  }

  function children(node?: Node): Node[] {
    if (replay) {
      if (!node) return [{ kind: "execution" }];
      if (node.kind === "execution")
        return replay.evidence.events.map((event) => ({
          kind: "executionEvent",
          event,
        }));
      if (node.kind === "executionEvent") {
        const { source, resolvedExternalSteps } = node.event;
        const sources: Node[] = source
          ? [{ kind: "executionSource", source }]
          : [];
        for (const step of resolvedExternalSteps ?? [])
          sources.push({ kind: "executionSource", source: step.source, step });
        return sources;
      }
      return [];
    }
    if (!trace) return [];
    if (!node && combinedStatic) return [{ kind: "combinedStaticRoot" }];
    if (!node || node.kind === "combinedStaticRoot") {
      if (node && !combinedStatic) return [];
      const model = combinedStatic ?? trace;
      const signal = signals.get(model.root);
      const selection = model.bitSelection;
      const range = selection?.range;
      const includeBits = !trace.frontier.some(
        ({ reason }) => reason === "bitTraceBudget",
      );
      const bits =
        includeBits && selection
          ? range
            ? Array.from(
                { length: Math.abs(range[0] - range[1]) + 1 },
                (_, index) => Math.min(...range) + index,
              )
            : selection.bit === undefined
              ? undefined
              : [selection.bit]
          : undefined;
      const roots: Node[] = signal
        ? [
            {
              kind: "signal",
              generation: signalGeneration,
              signal,
              ancestry: new Set(),
              bits,
              rootSelection: selectionText(range, selection?.bit),
            },
          ]
        : [];
      if (node?.kind === "combinedStaticRoot" && pendingContinuations)
        roots.unshift({
          kind: "resumeCombined",
          generation: combinedGeneration,
        });
      if (
        temporal &&
        (temporal.nodes.length ||
          temporal.missingEvidence.length ||
          temporal.frontier.length)
      )
        roots.push({ kind: "timeline" });
      if (runtimeInputs.length) roots.push({ kind: "runtimeInputs" });
      if (
        combined &&
        (combined.nodes.length ||
          combined.gaps.length ||
          combined.coverage.reasons.length)
      )
        roots.push({ kind: "combinedTimeline" });
      return roots;
    }
    if (node.kind === "combinedTimeline") {
      if (!combined) return [];
      const roots: Node[] = combined.roots.map((index) =>
        combinedTransition(index, new Set()),
      );
      if (pendingContinuations)
        roots.unshift({
          kind: "resumeCombined",
          generation: combinedGeneration,
        });
      if (combined.coverage.status === "partial")
        roots.push({ kind: "combinedGaps" });
      return roots;
    }
    if (node.kind === "combinedGaps") {
      if (!combined) return [];
      const count = remainingCombinedGaps.length;
      const entries: Node[] =
        count > combinedGapPageSize
          ? Array.from(
              { length: Math.ceil(count / combinedGapPageSize) },
              (_, page) => {
                const start = page * combinedGapPageSize;
                return {
                  kind: "combinedGapPage",
                  start,
                  end: Math.min(start + combinedGapPageSize, count),
                  generation: combinedGeneration,
                };
              },
            )
          : remainingCombinedGaps.map((gap) => ({ kind: "combinedGap", gap }));
      return [
        ...entries,
        ...combined.coverage.reasons.map(
          (reason): Node => ({ kind: "notice", label: reason }),
        ),
      ];
    }
    if (node.kind === "combinedGapPage")
      return node.generation === combinedGeneration
        ? remainingCombinedGaps
            .slice(node.start, node.end)
            .map((gap) => ({ kind: "combinedGap", gap }))
        : [];
    if (node.kind === "combinedGap" || node.kind === "resumeCombined")
      return [];
    if (node.kind === "combinedTransition") {
      if (
        combined?.nodes[node.index] !== node.event ||
        node.ancestry.has(node.index)
      )
        return [];
      const children: Node[] = [
        ...(combinedAssignments.get(node.index)?.values() ?? []),
      ].map((evidence) => ({
        kind: "combinedAssignment",
        target: node,
        ...evidence,
      }));
      const ancestry = new Set(node.ancestry).add(node.index);
      for (const gap of combinedAnchors.get(node.index) ?? []) {
        children.push(
          gap.status === "joined" && gap.source !== undefined
            ? combinedTransition(gap.source, ancestry, undefined, gap)
            : { kind: "combinedGap", gap },
        );
      }
      children.push(...recordedTaskSources(node.event.point));
      for (const step of node.event.point.recordedWriter?.evaluation
        ?.externalSteps ?? [])
        children.push({ kind: "executionSource", source: step.source, step });
      return children;
    }
    if (node.kind === "combinedAssignment") {
      if (combined?.nodes[node.target.index] !== node.target.event) return [];
      const ancestry = new Set(node.target.ancestry).add(node.target.index);
      const upstream: Node[] = [];
      for (const gap of node.gaps)
        if (gap.status === "joined" && gap.source !== undefined)
          upstream.push(
            combinedTransition(gap.source, ancestry, undefined, gap),
          );
      for (const edge of node.edges)
        upstream.push(combinedTransition(edge.source, ancestry, edge));
      for (const gap of node.gaps)
        if (gap.status !== "joined")
          upstream.push({ kind: "combinedGap", gap });
      return upstream;
    }
    if (
      node.kind === "notice" ||
      node.kind === "runtimeInput" ||
      node.kind === "temporalContinuation" ||
      node.kind === "staticFrontier" ||
      node.kind === "execution" ||
      node.kind === "executionEvent" ||
      node.kind === "executionSource"
    )
      return [];
    if (node.kind === "temporalGap")
      return node.gap.continuation
        ? [{ kind: "temporalContinuation", gap: node.gap }]
        : [];
    if (node.kind === "runtimeInputs")
      return runtimeInputs.map((input) => ({ kind: "runtimeInput", input }));
    if (node.kind === "timeline") {
      if (!temporal) return [];
      const samples: Node[] = temporal.nodes.map((point, index) => ({
        kind: "transition",
        index,
        point,
      }));
      if (temporal.gaps.length || temporal.gapsTruncated)
        samples.push({ kind: "temporalGaps" });
      return samples;
    }
    if (node.kind === "temporalGaps") {
      const gaps: Node[] =
        temporal?.gaps.map((gap) => ({ kind: "temporalGap", gap })) ?? [];
      if (temporal?.gapsTruncated)
        gaps.push({
          kind: "notice",
          label: "Additional individual gaps omitted",
        });
      return gaps;
    }
    if (node.kind === "transition") {
      if (
        temporal?.nodes[node.index] !== node.point ||
        node.ancestry?.has(node.index)
      )
        return [];
      const assignments: Node[] = [
        ...(temporalAssignments.get(node.index) ?? []),
      ].map(([id, evidence]) => ({
        kind: "temporalAssignment",
        assignment: trace!.assignments[id],
        target: node,
        evidence,
      }));
      assignments.push(...recordedTaskSources(node.point));
      for (const { ordinal, value } of node.point.recordedWordChanges ?? [])
        assignments.push({
          kind: "notice",
          label: "Value-change callback " + ordinal + " · " + value,
        });
      if (node.point.recordedWordUnresolved?.length)
        assignments.push({
          kind: "notice",
          label:
            "Writer unresolved " +
            node.point.recordedWordUnresolved
              .map((range) => selectionText(range))
              .join(", "),
        });
      const { recordedWordWriters, recordedWriter } = node.point;
      for (const writer of recordedWordWriters ??
        (recordedWriter ? [recordedWriter] : []))
        for (const label of guardEntryLabels(
          writer.evaluation?.guardEntryValues,
          writer.evaluation?.guardEntryTicks,
        ))
          assignments.push({
            kind: "notice",
            label: "Branch entry · " + label,
          });
      return assignments;
    }
    if (node.kind === "temporalAssignment") {
      const graph = temporal;
      if (!graph || graph.nodes[node.target.index] !== node.target.point)
        return [];
      const ancestry = new Set(node.target.ancestry).add(node.target.index);
      const upstream: Node[] = node.evidence.edges.map((edge) => ({
        kind: "transition",
        index: edge.source,
        point: graph.nodes[edge.source],
        ancestry,
        edge,
      }));
      for (const gap of node.evidence.gaps)
        upstream.push({ kind: "temporalGap", gap });
      const { recordedWriter, recordedWordWriters } = node.target.point;
      for (const writer of recordedWordWriters ??
        (recordedWriter ? [recordedWriter] : []))
        if (trace.assignments[writer.assignment] === node.assignment)
          for (const step of writer.evaluation?.externalSteps ?? [])
            upstream.push({
              kind: "executionSource",
              source: step.source,
              step,
            });
      return upstream;
    }
    if (node.kind === "signal") {
      const key = signalKey(node.signal.id, node.bits);
      if (node.ancestry.has(key)) return [];
      const ancestry = new Set(node.ancestry).add(key);
      const assignments: Node[] = (relations.get(node.signal.id) ?? [])
        .filter((assignment) => {
          if (!node.bits?.length) return true;
          if (direction === "loads")
            return assignment.inputs.some(
              ({ signal, readBits }) =>
                signal === node.signal.id &&
                (!readBits || readBits.some((bit) => node.bits!.includes(bit))),
            );
          if (assignment.writtenBits)
            return assignment.writtenBits.some((bit) =>
              node.bits!.includes(bit),
            );
          const range =
            "targetIndex" in assignment && assignment.targetIndex
              ? undefined
              : assignment.targetRange;
          return (
            !range ||
            node.bits.some(
              (bit) => bit >= Math.min(...range) && bit <= Math.max(...range),
            )
          );
        })
        .map((assignment) => ({
          kind: "assignment",
          assignment,
          ancestry,
          from: node.bits?.length
            ? { signal: node.signal.id, bits: node.bits }
            : undefined,
        }));
      for (const item of staticStops) {
        if (item.signal !== node.signal.id) continue;
        if (item.canRetrace) {
          const selection =
            node.rootSelection ||
            (node.bits?.length === 1
              ? selectionText(undefined, node.bits[0])
              : undefined);
          const waveformPath = item.waveformSignal;
          const choices = item.continuationSignals?.length
            ? item.continuationSignals.map((path) => ({
                selection: path.endsWith("." + node.signal.name)
                  ? undefined
                  : /\[-?\d+\]$/.exec(path)?.[0],
                waveformSignal: waveformPath ? path : undefined,
              }))
            : [
                {
                  selection,
                  waveformSignal:
                    waveformPath &&
                    selection &&
                    !waveformPath.endsWith(selection)
                      ? waveformPath + selection
                      : waveformPath,
                },
              ];
          for (const { selection, waveformSignal } of choices) {
            const bit = selection && /^\[(-?\d+)\]$/.exec(selection);
            if (bit && node.bits?.length && !node.bits.includes(Number(bit[1])))
              continue;
            assignments.push({
              kind: "staticFrontier",
              generation: signalGeneration,
              signal: node.signal,
              reason: item.reason,
              selection,
              waveformSignal,
            });
          }
        } else if (item.waveformUnavailable) {
          const bits = item.unavailableBits?.filter(
            (bit) => !node.bits?.length || node.bits.includes(bit),
          );
          if (bits?.length === 0) continue;
          assignments.push({
            kind: "notice",
            label:
              "Waveform continuation unavailable · " +
              item.reason +
              " limit" +
              (bits ? " · bits " + bits.join(", ") : ""),
          });
        } else if (
          (item.reason === "unresolvedPort" ||
            item.reason === "unresolvedDesignSignal") &&
          item.locations?.length
        ) {
          const label =
            item.reason === "unresolvedPort"
              ? "Unresolved port connection"
              : "Port declaration differs from elaboration";
          for (const location of item.locations)
            assignments.push({ kind: "notice", label, location });
        } else {
          assignments.push({
            kind: "notice",
            label:
              item.reason === "unresolvedPortExpression"
                ? "Unresolved port expression"
                : item.reason === "unresolvedGenerateBranch"
                  ? "Unresolved generate branch"
                  : item.reason === "proceduralOverride"
                    ? "Procedural override timing unresolved"
                    : item.reason === "unresolvedSubroutineEffects"
                      ? "Subroutine effects unresolved"
                      : item.reason === "unresolvedRuntimeInput"
                        ? "Runtime input evidence unavailable"
                        : item.reason === "unresolvedProceduralLoop"
                          ? "Procedural loop iterations unresolved"
                          : item.reason === "unresolvedProceduralTiming"
                            ? "Procedural timing unresolved"
                            : item.reason ===
                                "unresolvedVirtualInterfaceBinding"
                              ? "Virtual interface target unavailable"
                              : item.reason === "unresolvedUpdateEvaluation"
                                ? "Increment or decrement order unresolved"
                                : item.reason === "mismatchedDesign"
                                  ? "Design differs from build manifest"
                                  : item.reason === "unverifiedVcsParameterPath"
                                    ? "VCS KDB parameter override is unverified"
                                    : item.reason ===
                                        "vendorPortLinksUnavailable"
                                      ? "SHM/WDB instance connections unavailable"
                                      : "Trace incomplete · " + item.reason,
          });
        }
      }
      return assignments;
    }
    const { bitDependencies, writtenBits } = node.assignment;
    const outputs = writtenBits?.filter(
      (bit) =>
        !node.from || direction === "loads" || node.from.bits.includes(bit),
    );
    const byOutput = new Map(
      bitDependencies?.map((link) => [link.targetBit, link.reads]),
    );
    const exact = outputs?.length && outputs.every((bit) => byOutput.has(bit));
    const local =
      direction === "drivers"
        ? node.assignment.inputs.flatMap(({ signal, kind, edge, readBits }) => {
            const bits =
              exact && kind === "data"
                ? [
                    ...new Set(
                      outputs.flatMap(
                        (bit) =>
                          byOutput
                            .get(bit)!
                            .find((read) => read.signal === signal)?.bits ?? [],
                      ),
                    ),
                  ].sort((a, b) => a - b)
                : readBits;
            return bits?.length === 0
              ? []
              : [
                  {
                    id: signal,
                    bits,
                    relationship: isPortIndex(node.assignment.port, signal)
                      ? "index"
                      : (edge ?? kind),
                  },
                ];
          })
        : node.assignment.targets.map((id) => ({
            id,
            relationship: "target",
            bits:
              node.from &&
              !node.assignment.inputs.some(
                ({ signal, kind }) =>
                  signal === node.from!.signal && kind !== "data",
              )
                ? outputs?.filter(
                    (bit) =>
                      !byOutput.has(bit) ||
                      byOutput
                        .get(bit)!
                        .some(
                          (read) =>
                            read.signal === node.from!.signal &&
                            read.bits.some((index) =>
                              node.from!.bits.includes(index),
                            ),
                        ),
                  )
                : outputs,
          }));
    return local.flatMap(({ id, relationship, bits }) => {
      const signal = signals.get(id);
      return signal && bits?.length !== 0
        ? [
            {
              kind: "signal",
              generation: signalGeneration,
              signal,
              ancestry: node.ancestry,
              relationship,
              bits,
            },
          ]
        : [];
    });
  }

  function waveformTargets(node: Node): WaveformTarget[] {
    const target = (id: number, bit?: number) => {
      const signal = signals.get(id);
      return signal?.instance &&
        !signal.parameterValue &&
        !signal.instanceParameter &&
        !signal.packageParameterValue &&
        !signal.packageParameterValueUnavailable
        ? [{ signal, bit }]
        : [];
    };
    switch (node.kind) {
      case "signal":
        return node.generation === signalGeneration
          ? target(
              node.signal.id,
              node.bits?.length === 1 ? node.bits[0] : undefined,
            )
          : [];
      case "assignment":
        return (combinedStatic ?? trace)?.assignments.some(
          (assignment) => assignment === node.assignment,
        )
          ? [...new Set(node.assignment.targets)].flatMap((id) => target(id))
          : [];
      case "transition":
        return temporal?.nodes[node.index] === node.point
          ? target(node.point.signal, node.point.bit)
          : [];
      case "temporalAssignment":
      case "combinedAssignment":
        return waveformTargets(node.target);
      case "combinedTransition":
        if (combined?.nodes[node.index] !== node.event) return [];
        if (node.event.waveformSignal)
          return [{ waveformSignal: node.event.waveformSignal }];
        return node.event.waveformSignal === undefined &&
          node.event.sources[0].segment === 0
          ? target(node.event.point.signal, node.event.point.bit)
          : [];
      case "staticFrontier":
        return node.generation === signalGeneration
          ? target(node.signal.id)
          : [];
      case "temporalGap":
      case "temporalContinuation":
        return temporal?.gaps.includes(node.gap)
          ? target(node.gap.signal, node.gap.bit)
          : [];
      default:
        return [];
    }
  }

  function sourceFor(
    node: Node,
    item: vscode.TreeItem,
  ): TraceLocation | undefined {
    if (item.command?.command === "waveWorkbench.traceOpenSource")
      return item.command.arguments?.[0];
    if (node.kind === "staticFrontier" || node.kind === "signal")
      return node.signal.declaration ?? undefined;
    if (node.kind === "transition")
      return signals.get(node.point.signal)?.declaration ?? undefined;
    if (
      node.kind === "combinedTransition" &&
      combined?.nodes[node.index] === node.event
    )
      return (
        node.event.declaration ??
        (node.event.sources[0].segment === 0
          ? signals.get(node.event.point.signal)?.declaration
          : undefined) ??
        undefined
      );
    return undefined;
  }

  const provider: vscode.TreeDataProvider<Node> = {
    onDidChangeTreeData: changed.event,
    getChildren: children,
    getTreeItem(node) {
      const item = treeItem(node);
      const actions = [
        item.contextValue,
        sourceFor(node, item) && "traceSource",
        waveformTargets(node).length && "traceWaveform",
      ].filter(Boolean);
      if (actions.length) item.contextValue = actions.join(" ");
      return item;
    },
  };

  function treeItem(node: Node) {
    const collapsible = () =>
      children(node).length
        ? api.TreeItemCollapsibleState.Collapsed
        : api.TreeItemCollapsibleState.None;
    if (node.kind === "combinedStaticRoot") {
      const item = new api.TreeItem(
        "Combined static dependencies",
        api.TreeItemCollapsibleState.Expanded,
      );
      item.description =
        combinedStatic?.status === "partial" ? "Partial" : undefined;
      return item;
    }
    if (node.kind === "combinedTimeline")
      return new api.TreeItem(
        "Combined time graph",
        api.TreeItemCollapsibleState.Collapsed,
      );
    if (node.kind === "resumeCombined") {
      const item = new api.TreeItem("Continue next batch");
      item.description = pendingContinuations + " pending";
      item.command = {
        command: "waveWorkbench.traceResumeBatch",
        title: "Continue next batch",
        arguments: [node],
      };
      return item;
    }
    if (node.kind === "combinedGaps") {
      const item = new api.TreeItem(
        "Remaining trace gaps",
        api.TreeItemCollapsibleState.Collapsed,
      );
      item.description = remainingCombinedGaps.length.toLocaleString();
      const summary = combined?.gapSummary;
      if (summary) {
        const details = [
          summary.pending.toLocaleString() + " pending gaps",
          summary.unmatched.toLocaleString() + " unmatched gaps",
          summary.unresolved.toLocaleString() + " unresolved gaps",
        ];
        if (combined.coverage.reasons.includes("gapBudget"))
          details.push("The gap budget omitted additional entries.");
        item.tooltip = details.join("\n");
      }
      return item;
    }
    if (node.kind === "combinedGapPage")
      return new api.TreeItem(
        "Gaps " + (node.start + 1) + "–" + node.end,
        api.TreeItemCollapsibleState.Collapsed,
      );
    if (node.kind === "combinedTransition") {
      const { signal, point, recordedWordEvidence } = node.event;
      const commits = new Set(
        recordedWordEvidence?.flatMap(
          ({ writers }) =>
            writers?.map(({ commitOrdinal }) => commitOrdinal) ?? [],
        ),
      );
      const item = new api.TreeItem(signal, collapsible());
      const relation = node.continuation?.evidence.use;
      item.description = [
        "Tick " + point.tick,
        point.value,
        point.orderAtTick === undefined
          ? undefined
          : "Change " + point.orderAtTick,
        point.initialSample ? "Initial waveform sample" : undefined,
        point.recordedWriter &&
          "Recorded commit " + point.recordedWriter.commitOrdinal,
        point.recordedWriter?.evaluation &&
          "Evaluation " +
            point.recordedWriter.evaluation.ordinal +
            " at tick " +
            point.recordedWriter.evaluation.tick,
        commits.size ? commits.size + " recorded writes" : undefined,
        point.enumConstant
          ? "RTL enum constant"
          : point.packageParameter
            ? "RTL package parameter"
            : point.elaboratedParameter
              ? "Elaborated parameter"
              : point.operandEvaluationOrdinal !== undefined
                ? (point.branchEntrySample
                    ? "Captured branch entry · Evaluation "
                    : "Captured operand · Evaluation ") +
                  point.operandEvaluationOrdinal
                : point.beforeTick
                  ? "Before tick"
                  : point.sampleOnly
                    ? "Sample"
                    : undefined,
        point.sameValueWrite
          ? "Recorded same-value write"
          : point.executionOnly
            ? "Execution log"
            : undefined,
        node.continuation?.anchor !== undefined
          ? "Same change · continued static trace"
          : node.continuation
            ? "Continued " +
              (relation ? temporalGapUseLabel(relation) : "observation")
            : (node.edge?.role ?? node.edge?.kind),
        point.initialSample ||
        node.continuation?.evidence.historyCutoff === undefined
          ? undefined
          : "Earlier change",
        node.edge?.confidence === "possible" ? "Candidate" : undefined,
        node.edge?.sourceWriteEvidence === "recordedSameValueWrite"
          ? "Same-value write"
          : undefined,
        node.edge?.timing === "sameTickUnordered"
          ? "Same tick, order unknown"
          : undefined,
        node.ancestry.has(node.index) ? "Cycle" : undefined,
      ]
        .filter(Boolean)
        .join(" · ");
      item.tooltip = item.label + " · " + item.description;
      item.command = {
        command: "waveWorkbench.traceJumpToTick",
        title: "Jump to waveform tick",
        arguments: [node],
      };
      return item;
    }
    if (node.kind === "combinedAssignment") {
      const source =
        combined?.assignmentSources[node.segment]?.[node.assignment];
      const item = new api.TreeItem(
        source
          ? source.kind + " · L" + (source.location.range.start.line + 1)
          : "Assignment evidence",
        collapsible(),
      );
      if (source) {
        item.description = source.instance;
        item.command = {
          command: "waveWorkbench.traceOpenSource",
          title: "Open RTL source",
          arguments: [source.location],
        };
      }
      if (node.writes.length) {
        const commits = [
          ...new Set(node.writes.map(({ commitOrdinal }) => commitOrdinal)),
        ];
        item.description = [source?.instance, "Commit " + commits.join(", ")]
          .filter(Boolean)
          .join(" · ");
        item.tooltip = [...new Set(node.writes.map(wordWriteLabel))].join("\n");
      }
      return item;
    }
    if (node.kind === "combinedGap") {
      const { gap } = node;
      const item = new api.TreeItem(
        gap.signal + " · " + temporalGapLabel(gap.evidence),
      );
      item.description =
        "Tick " +
        gap.evidence.tick +
        (gap.evidence.use
          ? " · " + temporalGapUseLabel(gap.evidence.use)
          : "") +
        (gap.status === "pending"
          ? " · Continuation pending"
          : gap.status === "unmatched"
            ? " · Transition unavailable"
            : "");
      if (gap.evidence.continuation) {
        item.contextValue = "traceTemporalFrontier";
        item.command = {
          command: "waveWorkbench.traceFromSignal",
          title:
            gap.status === "pending" && pendingContinuations
              ? "Continue in current graph"
              : "Continue trace",
          arguments: [node],
        };
      } else if (gap.evidence.declaration) {
        item.command = {
          command: "waveWorkbench.traceOpenSource",
          title: "Open RTL source",
          arguments: [gap.evidence.declaration],
        };
      }
      return item;
    }
    if (node.kind === "notice") {
      const item = new api.TreeItem(node.label);
      if (node.location) {
        item.resourceUri = api.Uri.parse(node.location.uri);
        item.description = "Line " + (node.location.range.start.line + 1);
        item.command = {
          command: "waveWorkbench.traceOpenSource",
          title: "Open RTL source",
          arguments: [node.location],
        };
      }
      return item;
    }
    if (node.kind === "staticFrontier") {
      const item = new api.TreeItem(
        "Continue from " + node.signal.name + (node.selection ?? ""),
      );
      item.description = node.reason + " limit";
      item.command = {
        command: "waveWorkbench.traceFromSignal",
        title:
          node.waveformSignal && pendingStaticSignals.has(node.waveformSignal)
            ? "Continue in current graph"
            : "Continue trace",
        arguments: [node],
      };
      return item;
    }
    if (node.kind === "runtimeInputs")
      return new api.TreeItem(
        "Testbench run inputs",
        api.TreeItemCollapsibleState.Expanded,
      );
    if (node.kind === "runtimeInput") {
      const item = new api.TreeItem(runtimeInputLabel(node.input));
      item.tooltip = node.input.file?.path;
      item.command = {
        command: "waveWorkbench.traceOpenSource",
        title: "Open RTL source",
        arguments: [node.input.location],
      };
      return item;
    }
    if (node.kind === "execution") {
      const item = new api.TreeItem(
        "Recorded execution",
        api.TreeItemCollapsibleState.Expanded,
      );
      item.description =
        replay?.evidence.waveformMatch === "verified"
          ? "Waveform verified"
          : "Recording only";
      return item;
    }
    if (node.kind === "executionEvent") {
      const { event } = node;
      const item = new api.TreeItem(event.kind, collapsible());
      item.description = [
        "Tick " + event.tick,
        "Order " + event.ordinal,
        event.signal && event.signal + selectionText(event.targetRange),
        event.attemptedTargetRange &&
          "Attempted " + selectionText(event.attemptedTargetRange),
        event.value,
        event.timing,
      ]
        .filter(Boolean)
        .join(" · ");
      if (replay?.canJump)
        item.command = {
          command: "waveWorkbench.traceJumpToTick",
          title: "Jump to waveform tick",
          arguments: [node],
        };
      return item;
    }
    if (node.kind === "executionSource") {
      const { source, step, label } = node;
      const item = new api.TreeItem(
        (label ?? step?.operation ?? "RTL source") + " · L" + source.line,
      );
      item.description = [step?.value, source.identity]
        .filter(Boolean)
        .join(" · ");
      if (source.identity !== "missing")
        item.command = {
          command: "waveWorkbench.traceOpenSource",
          title: "Open execution source",
          arguments: [
            {
              uri: api.Uri.file(source.file).toString(),
              range: {
                start: {
                  line: source.line - 1,
                  character: source.column - 1,
                },
              },
            },
          ],
        };
      return item;
    }
    if (node.kind === "timeline")
      return new api.TreeItem(
        "Observed transitions",
        api.TreeItemCollapsibleState.Collapsed,
      );
    if (node.kind === "temporalGaps")
      return new api.TreeItem(
        "Trace gaps",
        api.TreeItemCollapsibleState.Collapsed,
      );
    if (node.kind === "temporalContinuation") {
      const { signal, tick, changeOrder, historyStart } =
        node.gap.continuation!;
      const item = new api.TreeItem("Continue from " + signal);
      item.description =
        "Tick " +
        tick +
        (changeOrder === undefined ? "" : " · Change " + changeOrder) +
        (historyStart === "auto" ? " · Search earlier history" : "");
      item.command = {
        command: "waveWorkbench.traceFromSignal",
        title: "Continue trace",
        arguments: [node],
      };
      return item;
    }
    if (node.kind === "temporalGap") {
      const { signal, bit, tick, use } = node.gap;
      const subject = signals.get(signal);
      const point = use && temporal?.nodes[use.target];
      const item = new api.TreeItem(
        (subject?.name ?? "Signal " + signal) +
          selectionText(undefined, bit) +
          " · " +
          temporalGapLabel(node.gap),
        collapsible(),
      );
      item.description = [
        "Tick " + tick,
        use && temporalGapUseLabel(use),
        point && signals.get(point.signal)?.name,
        subject?.instance,
      ]
        .filter(Boolean)
        .join(" · ");
      if (node.gap.continuation) item.contextValue = "traceTemporalFrontier";
      const location =
        node.gap.declaration ??
        (use && trace?.assignments[use.assignment]?.location);
      if (location)
        item.command = {
          command: "waveWorkbench.traceOpenSource",
          title: "Open RTL source",
          arguments: [location],
        };
      return item;
    }
    if (node.kind === "transition") {
      const {
        signal,
        bit,
        tick,
        value,
        orderAtTick,
        initialSample,
        beforeTick,
        sampleOnly,
        elaboratedParameter,
        enumConstant,
        packageParameter,
        recordedWriter,
        recordedWordWriters,
        operandEvaluationOrdinal,
        branchEntrySample,
        executionOnly,
        sameValueWrite,
        recordedRhsCombinations,
        valueChangeOrdinal,
        restoredFromCallbacks,
        compatibleModportComponent,
      } = node.point;
      const subject = signals.get(signal);
      const edge = node.edge;
      const item = new api.TreeItem(
        (subject?.name ?? "Signal") + selectionText(undefined, bit),
        collapsible(),
      );
      item.description = [
        "Tick " + tick,
        value,
        initialSample ? "Initial waveform sample" : undefined,
        orderAtTick === undefined ? undefined : "Change " + orderAtTick,
        enumConstant
          ? "RTL enum constant"
          : packageParameter
            ? "RTL package parameter"
            : elaboratedParameter
              ? "Elaborated parameter"
              : recordedFields.has(signal)
                ? "Execution log observation"
                : sameValueWrite
                  ? "Recorded same-value write"
                  : executionOnly
                    ? "Execution log"
                    : operandEvaluationOrdinal !== undefined
                      ? (branchEntrySample
                          ? "Captured branch entry · Evaluation "
                          : "Captured operand · Evaluation ") +
                        operandEvaluationOrdinal
                      : beforeTick
                        ? "Before tick"
                        : sampleOnly
                          ? "Stable sample"
                          : undefined,
        recordedWordWriters
          ? recordedWordWriters.length + " recorded writes"
          : recordedWriter && "Recorded commit " + recordedWriter.commitOrdinal,
        valueChangeOrdinal === undefined
          ? undefined
          : "Value-change callback " + valueChangeOrdinal,
        restoredFromCallbacks ? "Restored from VPI" : undefined,
        compatibleModportComponent
          ? "Compatible modport component " +
            selectionText(compatibleModportComponent.range)
          : undefined,
        compatibleModportComponent?.evaluationOrdinal === undefined
          ? undefined
          : "Evaluation " + compatibleModportComponent.evaluationOrdinal,
        recordedWriter?.evaluation && !recordedWordWriters
          ? "Evaluation " +
            recordedWriter.evaluation.ordinal +
            " at tick " +
            recordedWriter.evaluation.tick
          : undefined,
        recordedRhsCombinations
          ? recordedRhsCombinations.length + " compatible RHS combinations"
          : undefined,
        edge?.role ?? edge?.kind,
        edge?.sourceWriteEvidence === "recordedSameValueWrite"
          ? "Same-value write"
          : undefined,
        edge?.waitResumeCause === "uniqueObservedTransition"
          ? "Observed transition enabled wait"
          : edge?.waitResumeCause === "orderedCallbacks"
            ? "Callback " + edge.waitResumeCallbackOrdinal + " enabled wait"
            : undefined,
        edge?.continuousCause
          ? "Callback " +
            edge.continuousCause.sourceOrdinal +
            " changed RHS before output callback " +
            edge.continuousCause.targetOrdinal
          : edge?.confidence === "possible"
            ? "Candidate"
            : undefined,
        edge?.arrayIndexEvidence === "recordedTarget"
          ? "Matches recorded array index"
          : edge?.controlSampleEvidence === "recordedWaitResume"
            ? "Matches recorded wait resume"
            : edge?.controlSampleEvidence === "recordedBranchEntry"
              ? "Matches recorded branch entry"
              : edge?.controlSampleEvidence === "recordedEvaluation"
                ? "Matches recorded guard operand"
                : edge?.rhsSampleEvidence === "recordedEvaluation"
                  ? "Matches recorded RHS"
                  : edge?.rhsSampleEvidence === "waveformCombination"
                    ? "RHS matches a waveform sample combination"
                    : edge?.rhsSample === "matches"
                      ? "RHS compatible"
                      : edge?.rhsSample === "differs"
                        ? "RHS differs"
                        : undefined,
        edge?.callbackOrder
          ? edge.callbackOrder === "sourceBeforeTarget"
            ? "Source callback before target"
            : "Source callback after target"
          : edge?.timing === "sameTickUnordered"
            ? "Same tick, order unknown"
            : undefined,
        node.ancestry?.has(node.index) ? "Cycle" : undefined,
        subject?.instance,
      ]
        .filter(Boolean)
        .join(" · ");
      item.command = {
        command: "waveWorkbench.traceJumpToTick",
        title: "Jump to waveform tick",
        arguments: [node],
      };
      return item;
    }
    const item = new api.TreeItem(
      node.kind === "signal"
        ? node.signal.name +
          (node.rootSelection ||
            (node.bits ? "[" + node.bits.join(", ") + "]" : ""))
        : (node.assignment.port?.modportAlias
            ? "Modport alias"
            : node.assignment.port?.expression
              ? "Port expression"
              : node.assignment.kind) +
          " · L" +
          (node.assignment.location.range.start.line + 1),
      collapsible(),
    );
    const location =
      node.kind === "signal"
        ? node.signal.declaration
        : node.assignment.location;
    if (location)
      item.command = {
        command: "waveWorkbench.traceOpenSource",
        title: "Open RTL source",
        arguments: [location],
      };
    if (node.kind === "signal") {
      const { signal, ancestry, relationship } = node;
      item.contextValue = "traceSignal";
      item.description = [
        relationship,
        ancestry.has(signalKey(signal.id, node.bits)) ? "cycle" : undefined,
        observations.get(signal.id),
        signal.instance,
      ]
        .filter(Boolean)
        .join(" · ");
    } else {
      const { port, targetRange, instance } = node.assignment;
      const from = portSourceSelection(port);
      const to = selectionText(port?.toRange ?? targetRange, port?.toBit);
      const writes =
        node.kind === "temporalAssignment"
          ? node.target.point.recordedWordWriters?.filter(
              ({ assignment }) =>
                trace.assignments[assignment] === node.assignment,
            )
          : undefined;
      if (from || to || instance || writes?.length)
        item.description = [
          from && "Source " + from,
          to && "Target " + to,
          ...(writes ?? []).map(
            (write) =>
              "Commit " +
              write.commitOrdinal +
              " " +
              selectionText(write.targetRange) +
              (write.contributingRanges
                ? " · Contributes " +
                  write.contributingRanges
                    .map((range) => selectionText(range))
                    .join(", ")
                : "") +
              (write.evaluation
                ? " · Evaluation " + write.evaluation.ordinal
                : ""),
          ),
          instance,
        ]
          .filter(Boolean)
          .join(" · ");
      if (node.kind === "assignment" && combinedStatic) {
        const id = node.assignment.id;
        const feedback = combinedStatic.feedbackEdges.some(
          ({ assignment }) => assignment === id,
        );
        item.description = [
          item.description,
          feedback ? "Feedback" : undefined,
          node.assignment.hasUnresolvedOperands
            ? "Unresolved operands"
            : undefined,
        ]
          .filter(Boolean)
          .join(" · ");
      }
    }
    return item;
  }
  const viewId = "waveWorkbench.traceExplorer";
  const view = api.window.createTreeView?.(viewId, {
    treeDataProvider: provider,
  });
  const registration =
    view ?? api.window.registerTreeDataProvider?.(viewId, provider);
  if (registration) context.subscriptions.push(registration);
  const panel = api.window.createTreeView?.("waveWorkbench.panelTrace", {
    treeDataProvider: provider,
  });
  if (panel) context.subscriptions.push(panel);
  context.subscriptions.push(
    changed,
    api.commands.registerCommand("waveWorkbench.traceOpenSource", open),
    api.commands.registerCommand(
      "waveWorkbench.traceOpenNodeSource",
      (node: Node) => {
        if (!node) return;
        const location = sourceFor(node, treeItem(node));
        if (location) return open(location);
      },
    ),
    api.commands.registerCommand(
      "waveWorkbench.traceResumeBatch",
      (node: Node) => {
        if (
          node?.kind === "resumeCombined" &&
          node.generation === combinedGeneration &&
          pendingContinuations
        )
          return resumeCombined();
      },
    ),
    api.commands.registerCommand(
      "waveWorkbench.traceJumpToTick",
      (node: Node) => {
        if (
          node?.kind === "transition" &&
          temporal?.nodes[node.index] === node.point
        )
          return jumpToTick(node.point.tick);
        if (
          node?.kind === "combinedTransition" &&
          combined?.nodes[node.index] === node.event
        )
          return jumpToTick(node.event.point.tick);
        if (
          node?.kind === "executionEvent" &&
          replay?.canJump &&
          replay.evidence.events.includes(node.event)
        )
          return jumpToTick(node.event.tick);
      },
    ),
    api.commands.registerCommand(
      "waveWorkbench.traceAddSignal",
      (node: Node) => {
        if (!node) return;
        const targets = waveformTargets(node);
        if (targets.length <= 1) {
          const target = targets[0];
          if (target)
            return addSignal(target.signal, target.bit, target.waveformSignal);
          return;
        }
        const generation = signalGeneration;
        return (async () => {
          for (const { signal, bit, waveformSignal } of targets) {
            if (generation !== signalGeneration) return;
            await addSignal(signal, bit, waveformSignal);
          }
        })();
      },
    ),
    api.commands.registerCommand(
      "waveWorkbench.traceCopySignal",
      (node: Node) => {
        if (node?.kind !== "signal" || node.generation !== signalGeneration)
          return;
        const signal = signals.get(node.signal.id);
        if (signal) return copy(signal);
      },
    ),
    api.commands.registerCommand(
      "waveWorkbench.traceFromSignal",
      (node: Node) => {
        if (node?.kind === "staticFrontier") {
          if (node.generation !== signalGeneration) return;
          if (
            node.waveformSignal &&
            pendingStaticSignals.has(node.waveformSignal)
          )
            return resumeCombined(node.waveformSignal);
          if (node.waveformSignal)
            return retrace(
              node.signal,
              direction,
              undefined,
              node.selection,
              node.waveformSignal,
            );
          return node.selection
            ? retrace(node.signal, direction, undefined, node.selection)
            : retrace(node.signal, direction);
        }
        if (node?.kind === "signal") {
          if (node.generation !== signalGeneration) return;
          const selection =
            node.rootSelection ||
            (node.bits?.length === 1
              ? selectionText(undefined, node.bits[0])
              : "");
          return selection
            ? retrace(node.signal, direction, undefined, selection)
            : retrace(node.signal, direction);
        }
        if (node?.kind === "combinedGap") {
          if (!combined?.gaps.includes(node.gap)) return;
          const { signal, tick, bit, continuation } = node.gap.evidence;
          if (
            continuation &&
            node.gap.status === "pending" &&
            pendingContinuations
          )
            return resumeCombined(continuation);
          if (continuation)
            return retrace(
              { id: signal, name: node.gap.signal, declaration: null },
              "drivers",
              { tick, bit, continuation },
            );
        }
        if (
          (node?.kind !== "temporalGap" &&
            node?.kind !== "temporalContinuation") ||
          !temporal?.gaps.includes(node.gap)
        )
          return;
        const { signal, tick, bit, continuation } = node.gap;
        if (!continuation) return;
        const subject = signals.get(signal);
        if (subject)
          return retrace(subject, "drivers", { tick, bit, continuation });
      },
    ),
  );

  return {
    setMessage(message?: string) {
      if (view) view.message = message;
      if (panel) panel.message = message;
    },
    clear() {
      signalGeneration++;
      replay = undefined;
      trace = undefined;
      temporal = undefined;
      setCombined();
      combinedStatic = undefined;
      pendingStaticSignals.clear();
      staticStops = [];
      runtimeInputs = [];
      observations.clear();
      signals.clear();
      relations.clear();
      temporalAssignments.clear();
      recordedFields.clear();
      if (view) view.message = undefined;
      if (panel) panel.message = undefined;
      changed.fire();
    },
    updateCombined(next: CombinedTimeGraph, pending = 0) {
      setCombined(next, pending);
      changed.fire();
    },
    clearCombined(provider?: string) {
      const clearTime =
        combined && (!provider || combined.provider.kind === provider);
      const clearStatic = !provider && combinedStatic;
      if (clearTime) setCombined();
      if (clearStatic) {
        signalGeneration++;
        combinedStatic = undefined;
        pendingStaticSignals.clear();
        if (!combined) setCombined();
        signals.clear();
        relations.clear();
        staticStops = [];
      }
      if (clearTime || clearStatic) changed.fire();
    },
    showReplay(evidence: Replay, canJump: boolean) {
      signalGeneration++;
      replay = { evidence, canJump };
      trace = undefined;
      temporal = undefined;
      setCombined();
      combinedStatic = undefined;
      pendingStaticSignals.clear();
      runtimeInputs = [];
      changed.fire();
    },
    show(
      next: VideTrace,
      nextDirection: TraceDirection,
      values = new Map<number, string>(),
      timeTrace?: TemporalTrace,
      inputs: readonly RuntimeInputEvidence[] = [],
      combinedTrace?: CombinedTimeGraph,
      staticGraph?: CombinedStaticGraph,
      pending: number | readonly string[] = 0,
    ) {
      signalGeneration++;
      if (combinedStatic !== staticGraph) combinedGeneration++;
      trace = next;
      combinedStatic = staticGraph;
      pendingStaticSignals = new Set(
        typeof pending === "number" ? [] : pending,
      );
      staticStops = staticGraph
        ? staticGraph.gaps.map((gap) => ({
            ...gap,
            canRetrace: gap.continuationSignals.length > 0,
            waveformSignal: gap.continuationSignals[0],
          }))
        : staticTraceCoverage(next).stops;
      replay = undefined;
      direction = nextDirection;
      observations = values;
      temporal = timeTrace;
      setCombined(
        combinedTrace,
        typeof pending === "number" ? pending : pending.length,
      );
      runtimeInputs = inputs;
      temporalAssignments.clear();
      const evidenceAt = (target: number, assignment: number) => {
        const assignments =
          temporalAssignments.get(target) ??
          new Map<number, TemporalAssignmentEvidence>();
        const evidence = assignments.get(assignment) ?? { edges: [], gaps: [] };
        assignments.set(assignment, evidence);
        temporalAssignments.set(target, assignments);
        return evidence;
      };
      for (const edge of timeTrace?.edges ?? []) {
        evidenceAt(edge.target, edge.assignment).edges.push(edge);
        for (const assignment of edge.alsoAssignments ?? [])
          evidenceAt(edge.target, assignment).edges.push(edge);
      }
      for (const [target, point] of timeTrace?.nodes.entries() ?? []) {
        for (const assignment of point.initializationAssignments ?? [])
          evidenceAt(target, assignment);
        const { recordedWordWriters, recordedWriter } = point;
        for (const writer of recordedWordWriters ??
          (recordedWriter ? [recordedWriter] : []))
          evidenceAt(target, writer.assignment);
      }
      for (const gap of timeTrace?.gaps ?? [])
        if (gap.use)
          evidenceAt(gap.use.target, gap.use.assignment).gaps.push(gap);
      signals.clear();
      recordedFields.clear();
      relations.clear();
      for (const signal of (staticGraph ?? trace).signals)
        signals.set(signal.id, signal);
      for (const { id, array, name, instance } of timeTrace?.wordSignals ?? [])
        signals.set(id, {
          id,
          name,
          instance,
          declaration: signals.get(array)?.declaration ?? null,
        });
      for (const {
        id,
        signal,
        name,
        instance,
      } of timeTrace?.recordedFieldSignals ?? []) {
        signals.set(id, {
          id,
          name,
          instance,
          declaration: signals.get(signal)?.declaration ?? null,
        });
        recordedFields.add(id);
      }
      for (const assignment of (staticGraph ?? trace).assignments) {
        const selected =
          direction === "drivers"
            ? assignment.targets
            : assignment.inputs.map(({ signal }) => signal);
        for (const signal of new Set(selected)) {
          const list = relations.get(signal) ?? [];
          list.push(assignment);
          relations.set(signal, list);
        }
      }
      changed.fire();
    },
  };
}
