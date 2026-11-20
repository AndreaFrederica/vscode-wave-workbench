// SPDX-License-Identifier: MPL-2.0

import type * as vscode from "vscode";
import { createHash } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";
import type { readTraceObservations } from "./rtl-trace-observations";
import type {
  buildTemporalTrace,
  TemporalGap,
  TemporalEdgeEvidence,
  traceAssignmentCandidates,
  traceCursorWriters,
} from "./rtl-trace-candidates";
import type { AssignmentValue, IndexedPartSelect } from "./shared/protocol";
import { traceInteger } from "./rtl-trace-values";
import {
  runtimeInputLabel,
  type RuntimeInputEvidence,
} from "./rtl-runtime-inputs";
import {
  createMermaidFlowchart,
  mermaidLabel,
  mermaidMarkdown,
  mermaidOutput,
} from "./trace-mermaid";
export type { AssignmentValue } from "./shared/protocol";

export interface TraceOptions {
  module?: string;
  maxDepth?: number;
  maxSignals?: number;
  maxAssignments?: number;
  includeCompilation?: boolean;
  interfaceMember?: string;
  interfaceBacking?: string;
  genericInterfaces?: {
    formal: TracePosition;
    interface: TracePosition;
    modport?: string;
  }[];
}

type Location = {
  uri: string;
  range: {
    start: { line: number; character: number };
    end?: { line: number; character: number };
  };
};

export interface GenerateLabel {
  name: string;
  uri: string;
  line: number;
  byteColumn: number;
}

export interface VideTrace {
  schemaVersion: 1;
  revision: string;
  scope: "file" | "elaborated" | "module";
  root: number;
  bitSelection?: {
    bit?: number;
    range?: [number, number];
    feedbackEdges: FeedbackEdge[];
  };
  signals: {
    id: number;
    name: string;
    declaration: Location | null;
    instance?: string;
    signed?: boolean;
    packedStruct?: Location;
    lexicalScope?: string[];
    selectedElement?: number;
    modportAlias?: true;
    parameterValue?: { bits: string; signed: boolean };
  }[];
  assignments: {
    kind:
      | "continuous"
      | "blocking"
      | "nonblocking"
      | "initialization"
      | "port"
      | "force"
      | "release"
      | "proceduralAssign"
      | "deassign"
      | "subroutineCall"
      | "taskInput";
    instance?: string;
    location: Location;
    process?: Location;
    targets: number[];
    hierarchicalTargets?: {
      signal: number;
      location: Location;
      byteColumn?: number;
      interfacePath?: string;
      interfaceIndex?: AssignmentValue;
      interfaceRange?: [number, number];
      interfaceComponent?: [number, number];
    }[];
    inputs: {
      signal: number;
      kind: "data" | "control" | "trigger";
      edge: "rising" | "falling" | "either" | "change" | null;
      location: Location;
      hierarchical?: boolean;
      byteColumn?: number;
      sourceOffset?: number;
      interfacePath?: string;
      interfaceIndex?: AssignmentValue;
      interfaceRange?: [number, number];
      interfaceComponent?: [number, number];
      readBits?: number[];
    }[];
    guards?: {
      location: Location;
      takenWhenTrue: boolean;
      expression?: GuardExpression | null;
    }[];
    generateBranches?: {
      selected: GenerateLabel | null;
      alternatives: GenerateLabel[];
      loopScope?: boolean;
      loopVariable?: string;
    }[];
    generateIndices?: Record<string, number>;
    hasUnresolvedOperands: boolean;
    unresolvedControlOnly?: true;
    value?: AssignmentValue;
    wordRead?: { signal: number; index: AssignmentValue };
    fieldRead?: { signal: number; field: string };
    targetField?: { signal: number; field: string };
    fieldValue?: AssignmentValue;
    targetRange?: [number, number];
    overlappingModportWrite?: true;
    targetIndex?: AssignmentValue;
    targetElementIndex?: AssignmentValue;
    elementValue?: AssignmentValue;
    targetIndexedPart?: IndexedPartSelect;
    writtenBits?: number[];
    bitDependencies?: {
      targetBit: number;
      reads: { signal: number; bits: number[] }[];
    }[];
    port?: {
      fromField?: string;
      toField?: string;
      fromBit?: number;
      toBit?: number;
      fromRange?: [number, number];
      toRange?: [number, number];
      indexSignal?: number;
      indexSignals?: number[];
      indexedPart?: IndexedPartSelect;
      expression?: true;
      modportAlias?: true;
      conversion?: { fromWidth: number; toWidth: number; twoState: boolean };
    };
  }[];
  frontier: {
    signal: number;
    reason: string;
    bits?: number[];
    continuation?: { signal: string; bits?: number[] } | null;
    location?: Location;
    byteColumn?: number;
    interfaceArrayAccess?: { formal: Location; memberPath: string };
  }[];
  diagnostics: string[];
  simulationProject?: (
    | { filelist: string }
    | { buildManifest: string }
    | { videManifest: string }
  ) & {
    workingDirectory: string;
    limitations: string[];
    unverifiedVcsParameterPaths?: string[];
    vcsRebuild?: boolean;
    libraryMaps?: string[];
    resolvedLibraryFiles?: {
      design: string;
      kind?: "kdb" | "verilator";
      files: string[];
    };
  };
  compilation?: {
    roots: string[];
    compilationUnits?: string[][];
    compilationUnitOptions?: { defines: string[]; includeDirs: string[] }[];
    libraryFiles?: string[];
    libraryMaps?: string[];
    sourceLibraries?: { path: string; name: string }[];
    files: string[];
    includeDirs: string[];
    topModules: string[];
    parameterOverrides?: string[];
    defines: string[];
    complete: boolean;
  };
}

export type GuardExpression =
  | { op: "signal"; args: number }
  | { op: "not"; args: GuardExpression }
  | { op: "and" | "or"; args: [GuardExpression, GuardExpression] }
  | { op: "value"; args: AssignmentValue };

export type TraceDirection = "drivers" | "loads";

type TracePosition = {
  textDocument: { uri: string };
  position: { line: number; character: number };
};

interface TraceParams extends TracePosition {
  options?: TraceOptions;
}

export interface VideAnalysisApi {
  version?: number;
  capabilities?: { staticTraceVersion?: number };
  traceDrivers?: (
    params: TraceParams,
    token?: vscode.CancellationToken,
  ) => Promise<VideTrace | null>;
  traceLoads?: (
    params: TraceParams,
    token?: vscode.CancellationToken,
  ) => Promise<VideTrace | null>;
  openTraceProject?: (manifest: string) => Promise<VideTraceProject>;
  openTraceProjectFile?: (manifestPath: string) => Promise<VideTraceProject>;
}

export interface VideTraceProject
  extends Pick<VideAnalysisApi, "traceDrivers" | "traceLoads"> {
  readonly closed: boolean;
  dispose(): void;
}

export class UnresolvedTraceSignal extends Error {}

export async function queryTrace(
  api: VideAnalysisApi | undefined,
  direction: TraceDirection,
  params: TraceParams,
  token?: vscode.CancellationToken,
) {
  const request = direction === "drivers" ? api?.traceDrivers : api?.traceLoads;
  if (
    api?.version !== 1 ||
    api.capabilities?.staticTraceVersion !== 1 ||
    !request
  ) {
    throw Error("The active VIDE extension needs RTL trace schema 1.");
  }
  const deadline = Date.now() + 5_000;
  let trace: VideTrace | null;
  for (;;) {
    if (token?.isCancellationRequested)
      throw Error("The RTL trace was cancelled.");
    try {
      trace = await request.call(api, params, token);
      break;
    } catch (error) {
      // VIDE returns LSP ContentModified during the initial workspace index.
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== -32801 ||
        !error.message.includes("VIDE is still indexing the trace project") ||
        Date.now() >= deadline
      )
        throw error;
      await wait(100);
    }
  }
  if (!trace)
    throw new UnresolvedTraceSignal(
      "VIDE could not resolve an RTL signal at this position.",
    );
  if (trace.schemaVersion !== 1)
    throw Error("Unsupported VIDE trace result schema.");
  return trace;
}

export function declaredSignalName(signal: string) {
  return signal.replace(/\s*\[\s*-?\d+\s*:\s*-?\d+\s*\]$/, "");
}

export function traceSignalScope(
  signal: Pick<VideTrace["signals"][number], "instance" | "lexicalScope">,
  fallback = "",
) {
  const scope = signal.instance ?? fallback;
  const nested = signal.lexicalScope?.join(".");
  if (!nested || scope === nested || scope.endsWith("." + nested)) return scope;
  return scope ? scope + "." + nested : nested;
}

export function declarationColumns(line: string, signal: string) {
  const declarationName = signal.replace(
    /(?:\s*\[\s*-?\d+(?:\s*:\s*-?\d+)?\s*\])+$/,
    "",
  );
  const code = line.replace(/\/\*.*?\*\/|\/\/.*$|"(?:\\.|[^"\\])*"/g, (part) =>
    " ".repeat(part.length),
  );
  return [...code.matchAll(/\\\S+|[A-Za-z_$][\w$]*/g)]
    .filter(
      (match) =>
        match[0].replace(/^\\/, "") === declarationName.replace(/^\\/, ""),
    )
    .map((match) => match.index);
}

function sourceLocation(location: Location) {
  return location.uri + "#L" + (location.range.start.line + 1);
}

export function selectionText(range?: readonly [number, number], bit?: number) {
  if (bit !== undefined) return "[" + bit + "]";
  return range ? "[" + range.join(":") + "]" : "";
}

export function portSourceSelection(
  port?: VideTrace["assignments"][number]["port"],
) {
  const part = port?.indexedPart;
  if (part)
    return (
      "[index " + (part.ascendingIndices ? "+:" : "-:") + " " + part.width + "]"
    );
  if (port?.indexSignal !== undefined) return "[index]";
  return selectionText(port?.fromRange, port?.fromBit);
}

export function isDirectTracePort(
  assignment: VideTrace["assignments"][number],
) {
  const port = assignment.port;
  return (
    assignment.kind === "port" &&
    !assignment.hasUnresolvedOperands &&
    assignment.inputs.length === 1 &&
    assignment.inputs[0].kind === "data" &&
    assignment.targets.length === 1 &&
    !assignment.targetRange &&
    !assignment.value &&
    !port?.fromField &&
    !port?.toField &&
    !port?.expression &&
    !port?.conversion &&
    port?.indexSignal === undefined &&
    !port?.indexSignals?.length &&
    !port?.fromRange &&
    !port?.toRange &&
    port?.fromBit === undefined &&
    port?.toBit === undefined
  );
}

export function packedStructPorts(trace: VideTrace) {
  const signatures = new Map(
    trace.signals.flatMap(({ id, packedStruct }) =>
      packedStruct ? [[id, JSON.stringify(packedStruct)] as const] : [],
    ),
  );
  return trace.assignments.flatMap((assignment, id) => {
    if (!isDirectTracePort(assignment)) return [];
    const [target] = assignment.targets;
    const source = assignment.inputs[0].signal;
    const signature = signatures.get(source);
    return signature && signature === signatures.get(target)
      ? [{ id, target, source }]
      : [];
  });
}

export function isPortIndex(
  port: VideTrace["assignments"][number]["port"],
  signal: number,
) {
  return port?.indexSignal === signal || port?.indexSignals?.includes(signal);
}

function portExpression(
  value: AssignmentValue,
  names: ReadonlyMap<number, string>,
): string {
  const signal = (id: number) => names.get(id) ?? "Signal " + id;
  switch (value.op) {
    case "signal":
      return signal(value.args);
    case "literal": {
      const [bits, signed] = value.args;
      return bits.length + (signed ? "'sb" : "'b") + bits;
    }
    case "select": {
      const [base, left, right] = value.args;
      return (
        signal(base) +
        (left === right ? "[" + left + "]" : selectionText([left, right]))
      );
    }
    case "boundSelect": {
      const [base, left, right] = value.args;
      return (
        signal(base) +
        "[" +
        portExpression(left, names) +
        ":" +
        portExpression(right, names) +
        "]"
      );
    }
    case "bitSelect":
    case "indexedPartSelect": {
      const [base, index] = value.args;
      const part = value.op === "indexedPartSelect" ? value.args[2] : undefined;
      const suffix = part
        ? (part.ascendingIndices ? " +: " : " -: ") + part.width
        : "";
      return signal(base) + "[" + portExpression(index, names) + suffix + "]";
    }
    case "concat":
      return (
        "{" +
        value.args.map((part) => portExpression(part, names)).join(", ") +
        "}"
      );
    case "repeat": {
      const [count, part] = value.args;
      return "{" + count + portExpression(part, names) + "}";
    }
    case "unary":
      return "~" + portExpression(value.args[1], names);
    case "binary": {
      const [op, left, right] = value.args;
      const sign = {
        bitAnd: "&",
        bitOr: "|",
        bitXor: "^",
        add: "+",
        subtract: "-",
      };
      return (
        "(" +
        portExpression(left, names) +
        " " +
        (sign[op as keyof typeof sign] ?? op) +
        " " +
        portExpression(right, names) +
        ")"
      );
    }
    case "cast":
      return portExpression(value.args[3], names);
    case "slice":
      return (
        portExpression(value.args[0], names) +
        selectionText(value.args.slice(1) as [number, number])
      );
    default:
      return value.op;
  }
}

export type FeedbackEdge = {
  assignment: number;
  signal: number;
  side: "input" | "target";
};

export function isStaticBudgetStop(reason: string) {
  return reason === "depth" || reason === "signals" || reason === "assignments";
}

export function staticTraceCoverage(trace: VideTrace) {
  const signals = new Map(trace.signals.map((signal) => [signal.id, signal]));
  const stops = new Map<
    string,
    {
      signal: number;
      reason: string;
      path?: string;
      canRetrace: boolean;
      waveformSignal?: string;
      waveformUnavailable?: true;
      continuationSignals?: string[];
      locations?: Location[];
    }
  >();
  for (const {
    signal,
    reason,
    bits,
    location,
    continuation,
  } of trace.frontier) {
    const node = signals.get(signal);
    const scope = node?.instance && traceSignalScope(node);
    const path = continuation?.signal ?? (scope && scope + "." + node.name);
    const canRetrace =
      !!path && continuation !== null && isStaticBudgetStop(reason);
    const allowedBits = continuation ? continuation.bits : bits;
    const continuationSignals =
      canRetrace && allowedBits?.length
        ? allowedBits.map((bit) => declaredSignalName(path) + "[" + bit + "]")
        : undefined;
    const key = signal + ":" + reason;
    const previous = stops.get(key);
    if (previous) {
      if (canRetrace) {
        if (!previous.canRetrace) {
          previous.canRetrace = true;
          delete previous.waveformUnavailable;
          previous.path = path;
          if (continuation) previous.waveformSignal = continuation.signal;
          if (continuationSignals)
            previous.continuationSignals = continuationSignals;
        } else if (continuationSignals && previous.continuationSignals) {
          previous.continuationSignals = [
            ...new Set([
              ...previous.continuationSignals,
              ...continuationSignals,
            ]),
          ];
        } else {
          delete previous.continuationSignals;
        }
      }
      if (
        location &&
        !previous.locations?.some(
          (site) => JSON.stringify(site) === JSON.stringify(location),
        )
      )
        (previous.locations ??= []).push(location);
      continue;
    }
    stops.set(key, {
      signal,
      reason,
      path,
      canRetrace,
      ...(continuation ? { waveformSignal: continuation.signal } : {}),
      ...(continuation === null ? { waveformUnavailable: true } : {}),
      ...(continuationSignals ? { continuationSignals } : {}),
      ...(location ? { locations: [location] } : {}),
    });
  }
  const unresolvedAssignments = trace.assignments.flatMap((assignment, id) =>
    assignment.hasUnresolvedOperands ? [id] : [],
  );
  const compilationGaps = trace.simulationProject?.limitations ?? [];
  const incompleteCompilation =
    trace.compilation?.complete === false ||
    trace.diagnostics.includes("multipleCompilationProfiles");
  const status =
    stops.size ||
    unresolvedAssignments.length ||
    compilationGaps.length ||
    incompleteCompilation
      ? ("partial" as const)
      : ("resolvedWithinScope" as const);
  return {
    status,
    scope: trace.scope,
    stops: [...stops.values()],
    unresolvedAssignments,
    compilationGaps,
    incompleteCompilation,
  };
}

type TraceDiagramAssignment = Pick<
  VideTrace["assignments"][number],
  | "kind"
  | "instance"
  | "location"
  | "targets"
  | "port"
  | "targetRange"
  | "writtenBits"
  | "bitDependencies"
  | "fieldRead"
  | "targetField"
  | "wordRead"
> & {
  value?: AssignmentValue;
  hierarchicalTargets?: readonly { signal?: number }[];
  inputs: Pick<
    VideTrace["assignments"][number]["inputs"][number],
    "signal" | "kind" | "edge" | "readBits"
  >[];
};

export type StaticTraceDiagram = Pick<
  VideTrace,
  "root" | "bitSelection" | "signals"
> & {
  assignments: TraceDiagramAssignment[];
};

export function traceFeedback(
  trace: Pick<StaticTraceDiagram, "bitSelection"> & {
    signals: readonly { id: number }[];
    assignments: readonly {
      targets: readonly number[];
      inputs: readonly { signal: number }[];
    }[];
  },
) {
  if (trace.bitSelection) return trace.bitSelection.feedbackEdges;
  const signalIndices = new Map(
    trace.signals.map(({ id }, index) => [id, index]),
  );
  const signalCount = trace.signals.length;
  const outgoing: { node: number; edge: FeedbackEdge }[][] = Array.from(
    { length: signalCount + trace.assignments.length },
    () => [],
  );
  for (const [assignment, relation] of trace.assignments.entries()) {
    const node = signalCount + assignment;
    for (const { signal } of relation.inputs) {
      const index = signalIndices.get(signal);
      if (index !== undefined)
        outgoing[index].push({
          node,
          edge: { assignment, signal, side: "input" },
        });
    }
    for (const signal of relation.targets) {
      const index = signalIndices.get(signal);
      if (index !== undefined)
        outgoing[node].push({
          node: index,
          edge: { assignment, signal, side: "target" },
        });
    }
  }
  const active = new Set<number>();
  const visited = new Set<number>();
  const feedback: FeedbackEdge[] = [];
  for (let start = 0; start < outgoing.length; start++) {
    if (visited.has(start)) continue;
    const stack = [{ node: start, index: 0 }];
    active.add(start);
    visited.add(start);
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const next = outgoing[frame.node][frame.index++];
      if (!next) {
        active.delete(frame.node);
        stack.pop();
      } else if (active.has(next.node)) {
        feedback.push(next.edge);
      } else if (!visited.has(next.node)) {
        visited.add(next.node);
        active.add(next.node);
        stack.push({ node: next.node, index: 0 });
      }
    }
  }
  return feedback;
}

export function staticAssignmentPage<Assignment extends TraceDiagramAssignment>(
  trace: Pick<StaticTraceDiagram, "root" | "signals"> & {
    assignments: Assignment[];
  },
  direction: TraceDirection,
  signal: string,
  fingerprint: unknown,
  frontier: readonly { signal: number }[],
  requestedSize?: number,
  cursor?: string,
) {
  const digest = createHash("sha256")
    .update(JSON.stringify([direction, signal, fingerprint]))
    .digest("hex");
  const match =
    cursor === undefined
      ? null
      : /^(\d{1,6})\.(\d{1,3})\.([a-f0-9]{64})$/.exec(cursor);
  if (cursor !== undefined && (!match || match[3] !== digest))
    throw Error(
      "The static trace page cursor is invalid or its graph changed. Start a new trace.",
    );
  const offset = match ? Number(match[1]) : 0;
  const size = match ? Number(match[2]) : (requestedSize ?? 64);
  if (
    !Number.isInteger(size) ||
    size < 1 ||
    size > 128 ||
    (match &&
      (offset === 0 ||
        offset >= trace.assignments.length ||
        offset % size !== 0)) ||
    (requestedSize !== undefined && size !== requestedSize)
  )
    throw Error("The static trace page bounds are invalid.");
  const assignments = trace.assignments.slice(offset, offset + size);
  const signals = new Set([trace.root]);
  for (const { signal } of frontier) signals.add(signal);
  for (const assignment of assignments) {
    for (const target of assignment.targets) signals.add(target);
    for (const input of assignment.inputs) signals.add(input.signal);
    for (const { signal } of assignment.hierarchicalTargets ?? [])
      if (signal !== undefined) signals.add(signal);
    for (const { reads } of assignment.bitDependencies ?? [])
      for (const { signal } of reads) signals.add(signal);
    for (const access of [
      assignment.fieldRead,
      assignment.targetField,
      assignment.wordRead,
    ])
      if (access) signals.add(access.signal);
    for (const signal of assignment.port?.indexSignals ?? [])
      signals.add(signal);
    if (assignment.port?.indexSignal !== undefined)
      signals.add(assignment.port.indexSignal);
  }
  const end = offset + assignments.length;
  return {
    assignments,
    signals: trace.signals.filter(({ id }) => signals.has(id)),
    page: {
      assignmentOffset: offset,
      assignmentCount: assignments.length,
      totalAssignments: trace.assignments.length,
      nextCursor:
        end < trace.assignments.length
          ? [end, size, digest].join(".")
          : undefined,
    },
  };
}

export function staticTracePage(
  trace: VideTrace,
  direction: TraceDirection,
  signal: string,
  requestedSize?: number,
  cursor?: string,
) {
  const { revision, ...graph } = trace;
  const { assignments, signals, page } = staticAssignmentPage(
    trace,
    direction,
    signal,
    graph,
    trace.frontier,
    requestedSize,
    cursor,
  );
  const bitSelection = trace.bitSelection && {
    ...trace.bitSelection,
    feedbackEdges: trace.bitSelection.feedbackEdges
      .filter(
        ({ assignment }) =>
          assignment >= page.assignmentOffset &&
          assignment < page.assignmentOffset + page.assignmentCount,
      )
      .map((edge) => ({
        ...edge,
        assignment: edge.assignment - page.assignmentOffset,
      })),
  };
  return {
    trace: { ...graph, revision, bitSelection, assignments, signals },
    page,
  };
}

export function traceMermaid(...args: Parameters<typeof traceMermaidPages>) {
  return traceMermaidPages(...args)[0];
}

export function traceMermaidPages(
  trace: StaticTraceDiagram,
  feedback = traceFeedback(trace),
  gaps: readonly { signal: number; reason: string }[] = [],
) {
  const graph = createMermaidFlowchart({
    root: "stroke-width:3px",
    ...(feedback.length
      ? { feedback: "stroke-width:3px,stroke-dasharray:5 3" }
      : {}),
  });
  const cyclic = new Set(feedback.map(({ assignment }) => assignment));
  for (const signal of trace.signals) {
    const scope = traceSignalScope(signal);
    const name = (scope ? scope + "." : "") + signal.name;
    const selection = signal.id === trace.root ? trace.bitSelection : undefined;
    graph.node(
      "s" + signal.id,
      name + selectionText(selection?.range, selection?.bit),
      { style: signal.id === trace.root ? "root" : undefined },
    );
  }
  for (const [id, assignment] of trace.assignments.entries()) {
    const port = assignment.port;
    const from = portSourceSelection(port);
    const to = assignment.writtenBits
      ? "[" + assignment.writtenBits.join(", ") + "]"
      : selectionText(port?.toRange ?? assignment.targetRange, port?.toBit);
    const constant =
      assignment.kind === "port" && assignment.value?.op === "literal"
        ? assignment.value.args[0]
        : undefined;
    const label =
      (constant
        ? "Port constant " + constant
        : port?.modportAlias
          ? "Modport alias"
          : port?.expression
            ? "Port expression"
            : assignment.kind) +
      " L" +
      (assignment.location.range.start.line + 1) +
      (assignment.hierarchicalTargets?.length && assignment.instance
        ? " · " + assignment.instance
        : "");
    graph.node("a" + id, label, {
      style: cyclic.has(id) ? "feedback" : undefined,
    });
    for (const input of assignment.inputs) {
      const selected = input.readBits
        ? "[" + input.readBits.join(", ") + "]"
        : from;
      const edge = isPortIndex(port, input.signal)
        ? "index"
        : (input.edge ?? input.kind) + (selected ? " " + selected : "");
      graph.edge("s" + input.signal, "a" + id, edge);
    }
    for (const target of assignment.targets)
      graph.edge("a" + id, "s" + target, to);
  }
  for (const [id, { signal, reason }] of gaps.entries()) {
    graph.node("gap" + id, reason);
    graph.edge("s" + signal, "gap" + id, "", true);
  }
  return graph.pages();
}

type TraceObservations = Awaited<ReturnType<typeof readTraceObservations>> & {
  runtimeInputs?: RuntimeInputEvidence[];
  runtimeInputSource?: "liveLaunch" | "runManifest";
  runtimeMismatches?: string[];
};

export function temporalMermaid(
  ...args: Parameters<typeof temporalMermaidPages>
) {
  return temporalMermaidPages(...args)[0];
}

export function temporalMermaidOutput(
  ...args: Parameters<typeof temporalMermaidPages>
) {
  return mermaidOutput("temporalMermaid", temporalMermaidPages(...args));
}

export function temporalEdgeLabel(edge: TemporalEdgeEvidence) {
  return (
    (edge.role ?? edge.kind) +
    (edge.confidence === "possible" ? " candidate" : " evidence") +
    (edge.callbackOrder
      ? edge.callbackOrder === "sourceBeforeTarget"
        ? " · source callback before target"
        : " · source callback after target"
      : edge.timing === "sameTickUnordered"
        ? " · same tick, order unknown"
        : "") +
    (edge.arrayIndexEvidence === "recordedTarget"
      ? " · matches recorded array index"
      : edge.controlSampleEvidence === "recordedEvaluation"
        ? " · matches recorded guard operand"
        : edge.rhsSampleEvidence === "recordedEvaluation"
          ? " · matches recorded RHS"
          : edge.rhsSample === "matches"
            ? " · RHS compatible"
            : edge.rhsSample === "differs"
              ? " · RHS differs"
              : "") +
    (edge.sourceWriteEvidence === "recordedSameValueWrite"
      ? " · same-value write"
      : "")
  );
}

export function temporalGapUseLabel(use: NonNullable<TemporalGap["use"]>) {
  if (!use.evidence) return use.edge ?? use.kind;
  const commit = use.evidence.recordedCommitOrdinal;
  return (
    temporalEdgeLabel(use.evidence) +
    (use.edge ? " · " + use.edge : "") +
    (commit === undefined ? "" : " · commit " + commit)
  );
}

export function temporalMermaidPages(
  trace: ReturnType<typeof buildTemporalTrace>,
  evidence: Pick<
    TraceObservations,
    "observations" | "runtimeInputs" | "runtimeInputSource"
  >,
  commits?: ReadonlyMap<number, number>,
  signals?: VideTrace["signals"],
) {
  const graph = createMermaidFlowchart();
  const names = temporalNames(evidence, signals);
  const recordedFields = new Set(
    trace.recordedFieldSignals?.map(({ id }) => id),
  );
  for (const [index, node] of trace.nodes.entries()) {
    const writer = node.recordedWriter;
    const commit = writer?.commitOrdinal ?? commits?.get(index);
    const name = temporalSignalName(
      names.get(node.signal) ?? "Signal " + node.signal,
      node.bit,
    );
    const label =
      name +
      " @ " +
      node.tick +
      (node.orderAtTick === undefined ? "" : " · change " + node.orderAtTick) +
      " = " +
      (node.value ?? "unavailable") +
      (node.elaboratedParameter
        ? " · elaborated parameter"
        : recordedFields.has(node.signal)
          ? " · execution log observation"
          : node.sameValueWrite
            ? " · recorded same-value write"
            : node.executionOnly
              ? " · execution log"
              : node.operandEvaluationOrdinal !== undefined
                ? " · captured operand · evaluation " +
                  node.operandEvaluationOrdinal
                : node.beforeTick
                  ? " · before tick"
                  : node.sampleOnly
                    ? " · stable sample"
                    : "") +
      (node.recordedWordWriters
        ? " · " + node.recordedWordWriters.length + " recorded writes"
        : commit === undefined
          ? ""
          : " · commit " + commit) +
      (node.valueChangeOrdinal === undefined
        ? ""
        : " · value-change callback " + node.valueChangeOrdinal) +
      (node.restoredFromCallbacks ? " · restored from VPI" : "") +
      (node.compatibleModportComponent
        ? " · compatible modport component " +
          selectionText(node.compatibleModportComponent.range)
        : "") +
      (node.compatibleModportComponent?.evaluationOrdinal === undefined
        ? ""
        : " · evaluation " +
          node.compatibleModportComponent.evaluationOrdinal) +
      (writer && !node.recordedWordWriters
        ? " · RTL assignment " + (writer.assignment + 1)
        : "") +
      (writer?.targetRange && !node.recordedWordWriters
        ? " · wrote [" + writer.targetRange.join(":") + "]"
        : "") +
      (writer?.evaluation && !node.recordedWordWriters
        ? " · evaluated @ " +
          writer.evaluation.tick +
          " order " +
          writer.evaluation.ordinal
        : "") +
      (node.recordedRhsCombinations
        ? " · compatible RHS combinations " +
          node.recordedRhsCombinations.length
        : "");
    graph.node("t" + index, label);
    for (const write of node.recordedWordWriters ?? []) {
      const id = "write" + index + "_" + write.commitOrdinal;
      graph.node(
        id,
        "Write" +
          selectionText(write.targetRange) +
          (write.evaluation?.value === undefined
            ? ""
            : " = " + write.evaluation.value) +
          " · commit " +
          write.commitOrdinal +
          " · RTL assignment " +
          (write.assignment + 1) +
          (write.evaluation ? " · evaluation " + write.evaluation.ordinal : ""),
      );
      graph.edge(
        id,
        "t" + index,
        write.contributingRanges
          ? "recorded bits " +
              write.contributingRanges
                .map((range) => selectionText(range))
                .join(", ")
          : "recorded bits",
      );
      for (const [sample, label] of guardEntryLabels(
        write.evaluation?.guardEntryValues,
      ).entries()) {
        const guard = id + "_guard" + sample;
        graph.node(guard, label);
        graph.edge(guard, id, "recorded branch entry");
      }
    }
    if (node.recordedWordUnresolved?.length) {
      const id = "unresolvedword" + index;
      graph.node(
        id,
        "Writer unresolved " +
          node.recordedWordUnresolved
            .map((range) => selectionText(range))
            .join(", "),
      );
      graph.edge(id, "t" + index, "unverified bits", true);
    }
    if (node.recordedWordChanges) {
      const changes = "changes" + index;
      graph.node(
        changes,
        "Same-tick word callbacks · " +
          node.recordedWordChanges
            .map(({ ordinal, value }) => ordinal + " " + value)
            .join(" → "),
      );
      graph.edge(changes, "t" + index, "recorded callback sequence", true);
    }
    const transfer = node.recordedTaskTransfer;
    if (transfer) {
      const call = "task" + index;
      graph.node(
        call,
        "Task input @ " +
          transfer.input.tick +
          " · commit " +
          transfer.input.ordinal +
          " · L" +
          transfer.input.source.line,
      );
      graph.edge(
        call,
        "t" + index,
        "recorded member write · commit " + transfer.write.ordinal,
      );
      for (const [offset, read] of transfer.reads.entries()) {
        const id = call + "_" + offset;
        graph.node(
          id,
          read.operation +
            " = " +
            read.value +
            " @ " +
            read.tick +
            " · evaluation " +
            read.ordinal +
            " · L" +
            read.source.line,
        );
        graph.edge(id, call, "recorded input byte");
      }
    }
    for (const [stepIndex, step] of (
      writer?.evaluation?.externalSteps ?? []
    ).entries()) {
      const id = "foreign" + index + "_" + stepIndex;
      const filename = step.source.file.split(/[\\/]/).at(-1);
      graph.node(
        id,
        step.operation +
          (step.value === undefined ? "" : " = " + step.value) +
          " · " +
          filename +
          " L" +
          step.source.line,
      );
      const verified = step.source.identity === "matched";
      graph.edge(
        id,
        "t" + index,
        verified
          ? "external execution"
          : "external source " + step.source.identity,
        !verified,
      );
    }
  }
  for (const edge of trace.edges) {
    const label = temporalEdgeLabel(edge);
    const source = "t" + edge.source;
    const target =
      edge.recordedCommitOrdinal === undefined
        ? "t" + edge.target
        : "write" + edge.target + "_" + edge.recordedCommitOrdinal;
    graph.edge(source, target, label);
  }
  for (const [index, gap] of trace.gaps.entries()) {
    const name = temporalSignalName(
      names.get(gap.signal) ?? "Signal " + gap.signal,
      gap.bit,
    );
    const label =
      name + " @ " + gap.tick + " · " + temporalGapLabels[gap.reason];
    const id = "gap" + index;
    graph.node(id, label);
    if (gap.use)
      graph.edge(id, "t" + gap.use.target, temporalGapUseLabel(gap.use), true);
    if (gap.anchor !== undefined)
      graph.edge(id, "t" + gap.anchor, "static frontier", true);
  }
  for (const [index, input] of (evidence.runtimeInputs ?? []).entries()) {
    const id = "runtime" + index;
    const source =
      evidence.runtimeInputSource === "liveLaunch"
        ? "live launch"
        : "run manifest";
    graph.node(id, runtimeInputLabel(input) + " · " + source);
    for (const [point, node] of trace.nodes.entries())
      if (node.signal === input.signal)
        graph.edge(id, "t" + point, "associated call site", true);
  }
  return graph.pages();
}

export const temporalGapLabels: Record<TemporalGap["reason"], string> = {
  unmapped: "No waveform binding",
  truncated: "History truncated",
  noChangeInWindow: "No usable change in the requested window",
  noMatchingOperandChange: "No waveform change matches the operand evidence",
  projectedDependency: "Needs the full signal value",
  unprovenTrigger: "Trigger edge unavailable",
  unrecordedTaskInput: "Task input requires a recorded invocation",
  nodeBudget: "Time graph node budget reached",
  edgeBudget: "Time graph edge budget reached",
  staticBudget: "Static traversal budget reached",
};

export function guardEntryLabels(values?: Record<string, string>) {
  return Object.entries(values ?? {}).map(([key, value]) => {
    const match = /^g(\d+)_(\d+)(f?)_(.+)$/.exec(key);
    return match
      ? "Guard L" +
          match[1] +
          ":" +
          match[2] +
          (match[3] ? " · else" : "") +
          " · " +
          match[4] +
          " = " +
          value
      : key + " = " + value;
  });
}

function temporalNames(
  evidence: Pick<TraceObservations, "observations">,
  signals?: VideTrace["signals"],
) {
  const names = new Map(
    signals?.map(({ id, name, instance }) => [
      id,
      instance ? instance + "." + name : name,
    ]),
  );
  for (const { signal, waveformSignal } of evidence.observations)
    names.set(signal, waveformSignal);
  return names;
}

function temporalSignalName(name: string, bit?: number) {
  return bit === undefined
    ? name
    : name.replace(/\s*\[\s*-?\d+\s*(?::\s*-?\d+\s*)?\]$/, "") +
        "[" +
        bit +
        "]";
}

export function observationMermaid(evidence: TraceObservations) {
  return observationMermaidPages(evidence)[0];
}

export function observationMermaidPages(evidence: TraceObservations) {
  const graph = createMermaidFlowchart();
  for (const signal of evidence.observations) {
    const group = "g" + signal.signal;
    const samples = [
      ...(signal.initial ? [signal.initial] : []),
      ...signal.history,
    ];
    graph.group(group, signal.waveformSignal);
    const prefix = "t" + signal.signal + "_";
    for (const [index, sample] of samples.entries()) {
      const id = prefix + index;
      graph.node(id, sample.tick + " · " + (sample.value ?? "unavailable"), {
        group,
      });
      if (index > 0) graph.edge(prefix + (index - 1), id);
    }
    if (!samples.length) graph.node(prefix + "0", "unavailable", { group });
  }
  return graph.pages();
}

export function temporalTraceReferences(
  trace: VideTrace,
  graph: ReturnType<typeof buildTemporalTrace> | undefined,
) {
  const signalIds = new Set([trace.root]);
  const assignmentIds = new Set<number>();
  for (const node of graph?.nodes ?? []) {
    signalIds.add(node.signal);
    if (node.recordedWriter) assignmentIds.add(node.recordedWriter.assignment);
    for (const writer of node.recordedWordWriters ?? [])
      assignmentIds.add(writer.assignment);
    for (const combination of node.recordedRhsCombinations ?? [])
      for (const operand of combination) signalIds.add(operand.signal);
  }
  for (const { assignment, alsoAssignments } of graph?.edges ?? []) {
    assignmentIds.add(assignment);
    for (const id of alsoAssignments ?? []) assignmentIds.add(id);
  }
  for (const { signal, use } of graph?.gaps ?? []) {
    signalIds.add(signal);
    if (use) assignmentIds.add(use.assignment);
  }
  for (const id of graph?.frontier ?? []) signalIds.add(id);
  for (const { signal } of graph?.missingEvidence ?? []) signalIds.add(signal);
  for (const { signal, assignment } of graph?.wordReads ?? []) {
    signalIds.add(signal);
    assignmentIds.add(assignment);
  }
  for (const { array } of graph?.wordSignals ?? []) signalIds.add(array);
  for (const { signal } of graph?.recordedFieldSignals ?? [])
    signalIds.add(signal);
  return {
    schemaVersion: trace.schemaVersion,
    root: trace.root,
    signals: trace.signals.filter(({ id }) => signalIds.has(id)),
    assignmentSources: Object.fromEntries(
      [...assignmentIds].map((id) => {
        const { kind, instance, location, process, targetRange } =
          trace.assignments[id];
        return [id, { kind, instance, location, process, targetRange }];
      }),
    ),
  };
}

export type TemporalContinuation = NonNullable<TemporalGap["continuation"]>;
type TemporalGraph = ReturnType<typeof buildTemporalTrace>;
type TemporalContinuationSegment<T> =
  | { request: TemporalContinuation; trace: T }
  | { request: TemporalContinuation; error: string };

export class TraceContextChanged extends Error {}

export async function followTemporalFrontier<
  T extends {
    context: { temporalTrace?: TemporalGraph };
  },
>(
  root: TemporalContinuation,
  graph: TemporalGraph | undefined,
  limit: number,
  operation: AbortSignal,
  deadline: AbortSignal,
  query: (request: TemporalContinuation, operation: AbortSignal) => Promise<T>,
  assertCurrent?: () => Promise<void>,
  previous: readonly TemporalContinuationSegment<T>[] = [],
) {
  const key = ({
    signal,
    tick,
    changeOrder,
    liveSessionId,
    historyStart,
  }: TemporalContinuation) =>
    JSON.stringify([signal, tick, changeOrder, liveSessionId, historyStart]);
  const segmentByKey = new Map([[key(root), 0]]);
  const pending = new Map<
    string,
    { request: TemporalContinuation; staticBudget: boolean }
  >();
  const discoveredLinks: { segment: number; gap: number; id: string }[] = [];
  const segments = [...previous];
  previous.forEach(({ request }, index) =>
    segmentByKey.set(key(request), index + 1),
  );
  let truncated = false;
  let contextChanged = false;
  function enqueue(segment: number, current: TemporalGraph | undefined) {
    let firstStaticChild: string | undefined;
    truncated ||= Boolean(current?.gapsTruncated);
    const requests = [...(current?.gaps ?? []).entries()]
      .filter(([, { continuation }]) => continuation)
      .sort(
        ([, left], [, right]) =>
          Number(!!left.continuation?.historyStart) -
            Number(!!right.continuation?.historyStart) ||
          Number(left.reason === "staticBudget") -
            Number(right.reason === "staticBudget"),
      );
    for (const [gap, { continuation, reason }] of requests) {
      if (!continuation) continue;
      const id = key(continuation);
      if (!segmentByKey.has(id) && !pending.has(id)) {
        const staticBudget = reason === "staticBudget";
        pending.set(id, { request: continuation, staticBudget });
        if (staticBudget) firstStaticChild ??= id;
      }
      discoveredLinks.push({ segment, gap, id });
    }
    return firstStaticChild;
  }
  enqueue(0, graph);
  previous.forEach((segment, index) => {
    if ("trace" in segment)
      enqueue(index + 1, segment.trace.context.temporalTrace);
  });
  const signal = AbortSignal.any([operation, deadline]);
  let preferred: string | undefined;
  while (
    segments.length - previous.length < limit &&
    pending.size &&
    !deadline.aborted
  ) {
    operation.throwIfAborted();
    const [oldest, entry] = pending.entries().next().value!;
    const id = entry.staticBudget ? (preferred ?? oldest) : oldest;
    const { request, staticBudget } = pending.get(id)!;
    const promoteChild = staticBudget && preferred !== id;
    preferred = undefined;
    function finish() {
      pending.delete(id);
      segmentByKey.set(id, segments.length);
    }
    try {
      await assertCurrent?.();
      signal.throwIfAborted();
      const trace = await query(request, signal);
      await assertCurrent?.();
      signal.throwIfAborted();
      segments.push({ request, trace });
      finish();
      const child = enqueue(segments.length, trace.context.temporalTrace);
      // Alternate shallow and deeper work when a static boundary has many siblings.
      if (promoteChild) preferred = child;
    } catch (error) {
      operation.throwIfAborted();
      if (deadline.aborted) break;
      if (error instanceof TraceContextChanged) {
        contextChanged = true;
        break;
      }
      segments.push({
        request,
        error: error instanceof Error ? error.message : String(error),
      });
      finish();
    }
  }
  const remaining: TemporalContinuation[] = [];
  for (const [id, { request }] of pending) {
    remaining.push(request);
    segmentByKey.set(id, segments.length + remaining.length);
  }
  const links = discoveredLinks.map(({ segment, gap, id }) => ({
    segment,
    gap,
    nextSegment: segmentByKey.get(id)!,
  }));
  const stopReasons = [
    ...(contextChanged
      ? ["contextChanged"]
      : remaining.length
        ? [deadline.aborted ? "timeBudget" : "requestBudget"]
        : []),
    ...(truncated ? ["gapBudget"] : []),
    ...(segments.some((segment) => "error" in segment) ? ["queryFailed"] : []),
  ];
  return { segments, links, remaining, stopReasons };
}

export type ContinuationTrace = ReturnType<typeof temporalTraceReferences> & {
  context: Parameters<typeof temporalMermaidPages>[1] & {
    temporalTrace?: TemporalGraph;
    tick: string;
    scale: string;
    provider: { kind: string; sampling: string };
  };
  waveformSignals?: Record<number, string>;
};
export type ContinuationWalk = Awaited<
  ReturnType<typeof followTemporalFrontier<ContinuationTrace>>
>;

export function temporalWaveformSignals(
  evidence: Pick<TraceObservations, "observations">,
) {
  return Object.fromEntries(
    evidence.observations.flatMap(({ signal, waveformSignal }) =>
      waveformSignal ? [[signal, waveformSignal]] : [],
    ),
  );
}

export function mergeTemporalContinuationGraph(
  initial: ContinuationTrace,
  walk: ContinuationWalk,
) {
  type Point = TemporalGraph["nodes"][number];
  type Edge = TemporalGraph["edges"][number];
  const nodes: {
    signal: string;
    point: Point;
    sources: { segment: number; node: number }[];
  }[] = [];
  const edges: (Edge & { segment: number; edge: number })[] = [];
  const gaps: {
    segment: number;
    gap: number;
    signal: string;
    evidence: TemporalGap;
    target?: number;
    anchor?: number;
    nextSegment?: number;
    source?: number;
    status: "joined" | "pending" | "unmatched" | "unresolved";
  }[] = [];
  const traces = [
    initial,
    ...walk.segments.map((segment) =>
      "trace" in segment ? segment.trace : undefined,
    ),
  ];
  const sharedEvents = new Map<string, number>();
  const reasons = new Set(walk.stopReasons);
  const mappings = traces.map((trace, segment) => {
    if (!trace?.context.temporalTrace) return [];
    const names = temporalNames(trace.context, trace.signals);
    const provider = trace.context.provider;
    return trace.context.temporalTrace.nodes.map((point, node) => {
      const waveformSignal = trace.waveformSignals?.[point.signal];
      const name = temporalSignalName(
        waveformSignal ?? names.get(point.signal) ?? "Signal " + point.signal,
        point.bit,
      );
      // Samples taken for different evaluations can share a tick without representing the same observation.
      const key =
        !point.sampleOnly &&
        !point.executionOnly &&
        waveformSignal &&
        point.value !== undefined
          ? JSON.stringify([
              provider.kind,
              provider.sampling,
              trace.context.scale,
              name,
              point.bit,
              point.tick,
              point.orderAtTick,
              point.value,
              point.valueChangeOrdinal,
              point.recordedWriter?.commitOrdinal,
              point.recordedWriter?.evaluation?.ordinal,
            ])
          : undefined;
      let id = key === undefined ? undefined : sharedEvents.get(key);
      if (id === undefined) {
        id = nodes.length;
        nodes.push({ signal: name, point, sources: [] });
        if (key !== undefined) sharedEvents.set(key, id);
      }
      nodes[id].sources.push({ segment, node });
      return id;
    });
  });
  const links = new Map(
    walk.links.map(({ segment, gap, nextSegment }) => [
      segment + ":" + gap,
      nextSegment,
    ]),
  );
  const roots = (trace: ContinuationTrace) => {
    const graph = trace.context.temporalTrace;
    if (!graph?.nodes.length) return [];
    return (graph.rootNodes ?? [0]).filter(
      (id) => graph.nodes[id]?.signal === trace.root,
    );
  };
  for (const [segment, trace] of traces.entries()) {
    if (!trace) continue;
    const { context } = trace;
    const graph = context.temporalTrace;
    if (!graph) {
      reasons.add("missingTimeGraph");
      continue;
    }
    const names = temporalNames(context, trace.signals);
    const mapped = mappings[segment];
    graph.edges.forEach((edge, index) =>
      edges.push({
        ...edge,
        source: mapped[edge.source],
        target: mapped[edge.target],
        segment,
        edge: index,
      }),
    );
    let remainingBudget = Boolean(graph.gapsTruncated);
    let remainingStaticBudget = Boolean(graph.gapsTruncated);
    let remainingObservations = Boolean(graph.gapsTruncated);
    for (const [gap, evidence] of graph.gaps.entries()) {
      const nextSegment = links.get(segment + ":" + gap);
      let source: number | undefined;
      const anchor =
        evidence.anchor === undefined ? undefined : mapped[evidence.anchor];
      let status: (typeof gaps)[number]["status"] = "unresolved";
      if (nextSegment !== undefined) {
        const next = traces[nextSegment];
        const requested = walk.segments[nextSegment - 1]?.request;
        status = nextSegment > walk.segments.length ? "pending" : "unmatched";
        if (
          next &&
          nextSegment !== segment &&
          !evidence.sampleOnly &&
          context.scale === next.context.scale &&
          context.provider.kind === next.context.provider.kind &&
          context.provider.sampling === next.context.provider.sampling &&
          (nextSegment === 0 ||
            (requested?.signal === evidence.continuation?.signal &&
              requested?.liveSessionId ===
                evidence.continuation?.liveSessionId))
        ) {
          const prior = evidence.continuation?.historyStart === "auto";
          const observation =
            prior &&
            next.context.observations.find(
              ({ signal }) => signal === next.root,
            );
          const compatible = roots(next).filter((index, order) => {
            const event = next.context.temporalTrace!.nodes[index];
            if (
              event.sampleOnly ||
              event.executionOnly ||
              event.bit !== evidence.bit ||
              event.value === undefined
            )
              return false;
            if (anchor !== undefined) {
              const continued = nodes[mappings[nextSegment][index]];
              const original = nodes[anchor];
              if (
                original.signal !== continued.signal ||
                (original.point.valueChangeOrdinal !== undefined &&
                  continued.point.valueChangeOrdinal !== undefined &&
                  original.point.valueChangeOrdinal !==
                    continued.point.valueChangeOrdinal) ||
                (original.point.recordedWriter &&
                  continued.point.recordedWriter &&
                  original.point.recordedWriter.commitOrdinal !==
                    continued.point.recordedWriter.commitOrdinal)
              )
                return false;
            }
            if (!prior)
              return (
                event.tick === evidence.tick &&
                event.orderAtTick === evidence.orderAtTick &&
                (evidence.value === undefined || event.value === evidence.value)
              );
            return (
              order === 0 &&
              evidence.historyCutoff !== undefined &&
              next.context.tick === evidence.historyCutoff &&
              BigInt(event.tick) <= BigInt(evidence.historyCutoff) &&
              event.value === evidence.value &&
              observation &&
              observation.status === "observed" &&
              !observation.historyTruncated &&
              observation.value === event.value &&
              observation.history.findLast(({ tick }) => tick === event.tick)
                ?.value === event.value &&
              observation.history.every(
                ({ tick, value }) =>
                  BigInt(tick) <= BigInt(event.tick) || value === event.value,
              )
            );
          });
          if (compatible.length === 1) {
            source = mappings[nextSegment][compatible[0]];
            status = "joined";
          }
        }
        if (status === "unmatched") reasons.add("unmatchedContinuation");
      }
      remainingBudget ||=
        status !== "joined" &&
        (evidence.reason === "nodeBudget" || evidence.reason === "edgeBudget");
      remainingStaticBudget ||=
        status !== "joined" && evidence.reason === "staticBudget";
      remainingObservations ||=
        status !== "joined" &&
        evidence.reason !== "nodeBudget" &&
        evidence.reason !== "edgeBudget" &&
        evidence.reason !== "staticBudget";
      gaps.push({
        segment,
        gap,
        evidence,
        nextSegment,
        source,
        anchor,
        status,
        signal: temporalSignalName(
          trace.waveformSignals?.[evidence.signal] ??
            names.get(evidence.signal) ??
            "Signal " + evidence.signal,
          evidence.bit,
        ),
        target: evidence.use && mapped[evidence.use.target],
      });
    }
    for (const reason of graph.coverage.reasons) {
      if (reason === "traversalBudget" && !remainingBudget) continue;
      if (reason === "staticTraversalBudget" && !remainingStaticBudget)
        continue;
      if (reason === "missingObservations" && !remainingObservations) continue;
      reasons.add(reason);
    }
  }
  const partial =
    reasons.size !== 0 || gaps.some(({ status }) => status !== "joined");
  return {
    schemaVersion: 1 as const,
    scale: initial.context.scale,
    provider: initial.context.provider,
    roots: [
      ...new Set([
        ...roots(initial).map((id) => mappings[0][id]),
        ...gaps.flatMap((gap) =>
          gap.segment === 0 &&
          gap.target === undefined &&
          gap.anchor === undefined &&
          gap.status === "joined" &&
          gap.source !== undefined
            ? [gap.source]
            : [],
        ),
      ]),
    ],
    nodes,
    edges,
    gaps,
    assignmentSources: traces.map((trace) => trace?.assignmentSources ?? null),
    coverage: {
      status: partial
        ? ("partial" as const)
        : ("resolvedWithinWindow" as const),
      reasons: [...reasons],
    },
  };
}

export function combinedTemporalMermaid(
  combined: ReturnType<typeof mergeTemporalContinuationGraph>,
) {
  const graph = createMermaidFlowchart({ root: "stroke-width:3px" });
  const roots = new Set(combined.roots);
  combined.nodes.forEach(({ signal, point }, id) => {
    graph.node(
      "t" + id,
      signal +
        " @ " +
        point.tick +
        " = " +
        (point.value ?? "unavailable") +
        (point.orderAtTick === undefined
          ? ""
          : " · change " + point.orderAtTick) +
        (point.sampleOnly
          ? point.beforeTick
            ? " · before tick"
            : " · sample"
          : "") +
        (point.sameValueWrite ? " · recorded same-value write" : "") +
        (point.recordedWriter
          ? " · commit " + point.recordedWriter.commitOrdinal
          : ""),
      { style: roots.has(id) ? "root" : undefined },
    );
  });
  const renderedEdges = new Set<string>();
  for (const edge of combined.edges) {
    const label =
      temporalEdgeLabel(edge) +
      (edge.recordedCommitOrdinal === undefined
        ? ""
        : " · commit " + edge.recordedCommitOrdinal);
    const key = JSON.stringify([edge.source, edge.target, label]);
    if (renderedEdges.has(key)) continue;
    renderedEdges.add(key);
    graph.edge("t" + edge.source, "t" + edge.target, label);
  }
  for (const [id, gap] of combined.gaps.entries()) {
    const target = gap.target === undefined ? undefined : "t" + gap.target;
    const anchor = gap.anchor === undefined ? undefined : "t" + gap.anchor;
    if (gap.status === "joined" && gap.source !== undefined) {
      if (anchor && gap.source !== gap.anchor)
        graph.edge(
          "t" + gap.source,
          anchor,
          "same change · continued static trace",
          true,
        );
      if (target)
        graph.edge(
          "t" + gap.source,
          target,
          "continued " +
            (gap.evidence.use
              ? temporalGapUseLabel(gap.evidence.use)
              : "observation") +
            (gap.evidence.historyCutoff === undefined
              ? ""
              : " · earlier change"),
          true,
        );
      continue;
    }
    const node = "g" + id;
    graph.node(
      node,
      gap.signal +
        " @ " +
        gap.evidence.tick +
        " · " +
        temporalGapLabels[gap.evidence.reason] +
        (gap.status === "unmatched"
          ? " · transition unavailable"
          : gap.status === "pending"
            ? " · continuation pending"
            : ""),
    );
    if (target)
      graph.edge(
        node,
        target,
        gap.evidence.use && temporalGapUseLabel(gap.evidence.use),
        true,
      );
    if (anchor) graph.edge(node, anchor, "static frontier", true);
  }
  return graph.pages();
}

function continuationLabel(request: TemporalContinuation) {
  return (
    request.signal +
    " @ " +
    request.tick +
    (request.changeOrder === undefined
      ? ""
      : " · Change " + request.changeOrder) +
    (request.historyStart === "auto" ? " · Search earlier history" : "")
  );
}

export function continuationMermaidPages(
  root: TemporalContinuation,
  walk: ContinuationWalk,
) {
  const graph = createMermaidFlowchart({
    pending: "fill:#f4f4f4,color:#333,stroke:#888,stroke-dasharray:4 3",
    failed: "fill:#fff0f0,color:#722,stroke:#b55",
  });
  graph.node("part0", "Root · " + continuationLabel(root));
  for (const [index, segment] of walk.segments.entries()) {
    const number = index + 1;
    graph.node(
      "part" + number,
      "Continuation " +
        number +
        " · " +
        continuationLabel(segment.request) +
        ("error" in segment ? " · Query failed" : ""),
      { style: "error" in segment ? "failed" : undefined },
    );
  }
  for (const [index, request] of walk.remaining.entries()) {
    const number = walk.segments.length + index + 1;
    graph.node(
      "part" + number,
      "Pending " + number + " · " + continuationLabel(request),
      { style: "pending" },
    );
  }
  const linkCounts = new Map<string, number>();
  for (const { segment, nextSegment } of walk.links) {
    const key = segment + "/" + nextSegment;
    linkCounts.set(key, (linkCounts.get(key) ?? 0) + 1);
  }
  for (const [key, count] of linkCounts) {
    const [segment, nextSegment] = key.split("/");
    graph.edge(
      "part" + segment,
      "part" + nextSegment,
      count + (count === 1 ? " gap" : " gaps"),
      true,
    );
  }
  return graph.pages();
}

export function continuationReport(
  walk: ContinuationWalk,
  overview: readonly string[],
  combined?: ReturnType<typeof mergeTemporalContinuationGraph>,
  initial?: ContinuationTrace,
) {
  const code = (text: string) => "`" + text.replace(/[`\r\n]/g, " ") + "`";
  const section = (number: number) =>
    number === 0
      ? initial
        ? "[Root query](#root-query)"
        : "[Root query](#trace-continuations)"
      : number <= walk.segments.length
        ? "[Continuation " + number + "](#continuation-" + number + ")"
        : "[Pending " + number + "](#pending-" + number + ")";
  const lines = [
    "",
    "## Trace continuations",
    "",
    walk.segments.length + " queried · " + walk.remaining.length + " pending",
    ...(walk.stopReasons.length
      ? ["", "Stop reasons · " + walk.stopReasons.join(", ")]
      : []),
    "",
  ];
  if (combined?.nodes.length)
    lines.push(
      "### Combined time graph",
      "",
      combined.nodes.length +
        " time nodes · " +
        combined.edges.length +
        " evidence edges · " +
        combined.gaps.filter(({ status }) => status === "joined").length +
        " linked continuations",
      ...(combined.coverage.reasons.length
        ? ["", "Coverage · " + combined.coverage.reasons.join(", ")]
        : []),
      "",
      mermaidMarkdown(combinedTemporalMermaid(combined)),
      "",
    );
  lines.push(mermaidMarkdown(overview), "");
  if (walk.links.length) {
    lines.push("### Links from time graph gaps", "");
    for (const { segment, gap, nextSegment } of walk.links)
      lines.push(
        "- " +
          section(segment) +
          " · gap " +
          (gap + 1) +
          " → " +
          section(nextSegment),
      );
  }
  const addTrace = ({
    context,
    signals,
    assignmentSources,
  }: ContinuationTrace) => {
    const graph = context.temporalTrace;
    if (!graph) {
      lines.push("", "Time graph unavailable.");
      return;
    }
    lines.push(
      "",
      "Tick unit " +
        context.scale +
        " · " +
        graph.nodes.length +
        " time nodes · " +
        graph.edges.length +
        " edges · " +
        graph.gaps.length +
        " gaps",
    );
    if (graph.coverage.reasons.length)
      lines.push("", "Coverage · " + graph.coverage.reasons.join(", "));
    lines.push(
      "",
      mermaidMarkdown(temporalMermaidPages(graph, context, undefined, signals)),
    );
    const sources = Object.entries(assignmentSources);
    if (sources.length) lines.push("", "RTL assignment locations", "");
    for (const [assignment, { location, kind }] of sources)
      lines.push(
        "- RTL assignment " +
          (Number(assignment) + 1) +
          " · " +
          kind +
          " · " +
          code(location.uri) +
          " L" +
          (location.range.start.line + 1) +
          ":" +
          (location.range.start.character + 1),
      );
  };
  if (initial) {
    lines.push("", "### Root query", "");
    addTrace(initial);
  }
  for (const [index, segment] of walk.segments.entries()) {
    lines.push(
      "",
      "### Continuation " + (index + 1),
      "",
      code(continuationLabel(segment.request)),
    );
    if ("error" in segment)
      lines.push("", "Query failed · " + code(segment.error));
    else addTrace(segment.trace);
  }
  for (const [index, request] of walk.remaining.entries())
    lines.push(
      "",
      "### Pending " + (walk.segments.length + index + 1),
      "",
      code(continuationLabel(request)),
    );
  return lines.join("\n") + "\n";
}

export function appendContinuationReport(report: string, appendix?: string) {
  if (!appendix) return report;
  const heading = appendix
    .trimStart()
    .startsWith("## Static trace continuations")
    ? "Static trace continuations"
    : "Trace continuations";
  const anchor = heading.toLowerCase().replaceAll(" ", "-");
  return (
    report.replace("\n\n", "\n\n[" + heading + "](#" + anchor + ")\n\n") +
    appendix
  );
}

export function observationReport(
  evidence: TraceObservations & {
    assignmentCandidates?: ReturnType<typeof traceAssignmentCandidates>;
    cursorWriters?: ReturnType<typeof traceCursorWriters>;
    temporalTrace?: ReturnType<typeof buildTemporalTrace>;
    selectedTransition?: {
      signal: number;
      tick: string;
      value?: string;
      orderAtTick: number;
    };
    sourceMatch?: "matched" | "mismatched" | "unverified";
    sourceVerification?: { mismatches: string[]; limitations: string[] };
  },
  trace?: VideTrace,
) {
  const lines = [
    "",
    "## Waveform observations",
    "",
    "Window " +
      evidence.historyStart +
      "–" +
      evidence.historyEnd +
      " ticks · Tick unit " +
      evidence.scale,
    "",
  ];
  if (evidence.historyEnd !== evidence.tick) {
    lines.push("Cursor values sampled at tick " + evidence.tick, "");
  }
  if (evidence.selectedTransition) {
    const { tick, orderAtTick, value } = evidence.selectedTransition;
    lines.push(
      "Selected change " +
        orderAtTick +
        " @ " +
        tick +
        " · " +
        (value ?? "unavailable"),
      "",
    );
  }
  if (evidence.automaticSearchLimited)
    lines.push(
      "The automatic search reached its budget while looking for an earlier change of the selected bit.",
      "",
    );
  if (evidence.sourceMatch) {
    const clean = (value: string) => value.replace(/[\x60\r\n]/g, " ");
    lines.push("Build and RTL source identity · " + evidence.sourceMatch, "");
    for (const mismatch of evidence.sourceVerification?.mismatches ?? [])
      lines.push("- Build difference · `" + clean(mismatch) + "`");
    for (const limitation of evidence.sourceVerification?.limitations ?? [])
      lines.push("- Verification gap · `" + clean(limitation) + "`");
  }
  if (evidence.runtimeInputs?.length || evidence.runtimeMismatches?.length) {
    const clean = (value: string) => value.replace(/[\x60\r\n]/g, " ");
    lines.push(
      "",
      "## Testbench run inputs",
      "",
      evidence.runtimeInputSource === "liveLaunch"
        ? "Inputs from the active simulation launch. Execution of these call sites requires separate evidence."
        : evidence.runtimeInputs?.length
          ? "Inputs from the waveform's run manifest. Execution of these call sites requires separate evidence."
          : "The online launch differs from the waveform's run manifest.",
      "",
    );
    for (const mismatch of evidence.runtimeMismatches ?? [])
      lines.push("- Reference run difference · `" + clean(mismatch) + "`");
    for (const input of evidence.runtimeInputs ?? []) {
      lines.push(
        "- `" +
          clean(runtimeInputLabel(input)) +
          "` · " +
          clean(sourceLocation(input.location)),
      );
      if (input.file)
        lines.push(
          "  - File `" +
            clean(input.file.path) +
            "`" +
            (input.file.sha256 ? " · SHA-256 `" + input.file.sha256 + "`" : ""),
        );
    }
    lines.push("");
  }
  for (const signal of evidence.observations) {
    const name = signal.waveformSignal.replace(/[\x60\r\n]/g, " ");
    lines.push("- `" + name + "` · " + (signal.value ?? signal.status));
    if (signal.initial)
      lines.push(
        "  - Prior sample at " +
          signal.initial.tick +
          " · " +
          signal.initial.value,
      );
    if (signal.historyLimitedToTransition)
      lines.push("  - The retained samples cover the selected bit transition.");
    for (const sample of signal.history)
      lines.push("  - Tick " + sample.tick + " · " + sample.value);
  }
  lines.push("", mermaidMarkdown(observationMermaidPages(evidence)));
  const temporal = evidence.temporalTrace;
  if (temporal && (temporal.nodes.length || temporal.gaps.length)) {
    lines.push("", "## Time graph evidence");
    if (temporal.coverage?.reasons.length)
      lines.push(
        "",
        "Partial time graph · " + temporal.coverage.reasons.join(", "),
      );
    for (const page of temporalMermaidPages(
      temporal,
      evidence,
      undefined,
      trace?.signals,
    ))
      lines.push("", "```mermaid", page, "```");
    if (temporal.frontier.length)
      lines.push(
        "",
        "Trace budget reached for " + temporal.frontier.length + " signals.",
      );
    const names = temporalNames(evidence, trace?.signals);
    const inlineCode = (value: string) =>
      "`" + value.replace(/[\x60\r\n]/g, " ") + "`";
    const sameValueWrites = temporal.nodes.flatMap((point) =>
      point.sameValueWrite && point.recordedWriter
        ? [
            "- " +
              inlineCode(
                temporalSignalName(
                  names.get(point.signal) ?? "Signal " + point.signal,
                  point.bit,
                ),
              ) +
              " · Tick " +
              point.tick +
              " · Commit " +
              point.recordedWriter.commitOrdinal,
          ]
        : [],
    );
    if (sameValueWrites.length)
      lines.push("", "### Recorded same-value writes", "", ...sameValueWrites);
    const components = temporal.nodes.flatMap((point) =>
      point.compatibleModportComponent
        ? [
            "- " +
              inlineCode(
                temporalSignalName(
                  names.get(point.signal) ?? "Signal " + point.signal,
                  point.bit,
                ),
              ) +
              " · Tick " +
              point.tick +
              " · Callback " +
              point.compatibleModportComponent.ordinal +
              " · Component " +
              inlineCode(
                selectionText(point.compatibleModportComponent.range),
              ) +
              (point.compatibleModportComponent.evaluationOrdinal === undefined
                ? ""
                : " · Evaluation " +
                  point.compatibleModportComponent.evaluationOrdinal),
          ]
        : [],
    );
    if (components.length)
      lines.push(
        "",
        "### Modport components compatible with recorded changes",
        "",
        ...components,
      );
    const combinations = temporal.nodes.flatMap((point) =>
      point.recordedRhsCombinations?.length && point.recordedWriter?.evaluation
        ? [
            "- " +
              inlineCode(names.get(point.signal) ?? "Signal " + point.signal) +
              " · Evaluation " +
              point.recordedWriter.evaluation.ordinal +
              " · Tick " +
              point.recordedWriter.evaluation.tick,
            ...point.recordedRhsCombinations.map(
              (samples) =>
                "  - " +
                samples
                  .map(({ signal, bits }) =>
                    inlineCode(
                      (names.get(signal) ?? "Signal " + signal) + "=" + bits,
                    ),
                  )
                  .join(", "),
            ),
          ]
        : [],
    );
    if (combinations.length)
      lines.push(
        "",
        "## Observed sample combinations compatible with recorded RHS",
        "",
        ...combinations,
      );
    const external = temporal.nodes.flatMap((point, index) =>
      (point.recordedWriter?.evaluation?.externalSteps ?? []).map(
        ({ operation, source, value }) =>
          "- Time graph node " +
          index +
          " · " +
          operation.replace(/[\\*_\x60#[\]<>|]/g, "\\$&") +
          (value === undefined ? "" : " = " + value) +
          " · " +
          source.file
            .replace(/[\\*_\x60#[\]<>|]/g, "\\$&")
            .replace(/[\r\n]/g, " ") +
          " L" +
          source.line +
          " · Source " +
          source.identity,
      ),
    );
    if (external.length)
      lines.push("", "## Recorded external execution", "", ...external);
    const tasks = temporal.nodes.flatMap((point) => {
      const task = point.recordedTaskTransfer;
      if (!task) return [];
      return [
        "- " +
          inlineCode(names.get(point.signal) ?? "Signal " + point.signal) +
          " · input commit " +
          task.input.ordinal +
          " @ " +
          task.input.tick +
          " · member write commit " +
          task.write.ordinal +
          " @ " +
          task.write.tick,
        ...task.reads.map(
          (read) =>
            "  - " +
            inlineCode(read.operation + " = " + read.value) +
            " · evaluation " +
            read.ordinal +
            " @ " +
            read.tick +
            " · " +
            inlineCode(read.source.file) +
            " L" +
            read.source.line,
        ),
      ];
    });
    if (tasks.length)
      lines.push(
        "",
        "## Recorded task inputs from firmware reads",
        "",
        ...tasks,
      );
    const wordsWritten = temporal.nodes.filter(
      ({ recordedWordWriters }) => recordedWordWriters,
    );
    if (wordsWritten.length) {
      lines.push("", "## Recorded writes that form an array word", "");
      for (const point of wordsWritten) {
        lines.push(
          "- " +
            inlineCode(names.get(point.signal) ?? "Signal " + point.signal) +
            " · Tick " +
            point.tick +
            " · " +
            inlineCode(point.value ?? ""),
        );
        for (const writer of point.recordedWordWriters ?? []) {
          const source = trace?.assignments[writer.assignment]?.location;
          lines.push(
            "  - " +
              inlineCode(selectionText(writer.targetRange)) +
              " · Commit " +
              writer.commitOrdinal +
              (writer.contributingRanges
                ? " · Contributes " +
                  writer.contributingRanges
                    .map((range) => inlineCode(selectionText(range)))
                    .join(", ")
                : "") +
              (writer.evaluation
                ? " · Evaluation " +
                  writer.evaluation.ordinal +
                  " @ " +
                  writer.evaluation.tick +
                  " · " +
                  inlineCode(writer.evaluation.value ?? "")
                : "") +
              " · RTL assignment " +
              (writer.assignment + 1) +
              (source
                ? " · " +
                  inlineCode(source.uri) +
                  " L" +
                  (source.range.start.line + 1)
                : ""),
          );
          for (const [name, value] of Object.entries(
            writer.evaluation?.operandValues ?? {},
          ))
            lines.push(
              "    - Recorded operand " + inlineCode(name + " = " + value),
            );
          for (const label of guardEntryLabels(
            writer.evaluation?.guardEntryValues,
          ))
            lines.push("    - Branch entry · " + inlineCode(label));
        }
        if (point.recordedWordUnresolved?.length)
          lines.push(
            "  - Writer unresolved " +
              point.recordedWordUnresolved
                .map((range) => inlineCode(selectionText(range)))
                .join(", "),
          );
      }
    }
    const wordChanges = new Map(
      temporal.nodes.flatMap((point) =>
        point.recordedWordChanges
          ? [[point.signal + ":" + point.tick, point] as const]
          : [],
      ),
    );
    if (wordChanges.size) {
      lines.push("", "## Same-tick array word callbacks", "");
      for (const point of wordChanges.values()) {
        lines.push(
          "- " +
            inlineCode(names.get(point.signal) ?? "Signal " + point.signal) +
            " · Tick " +
            point.tick,
        );
        for (const { ordinal, value } of point.recordedWordChanges ?? [])
          lines.push("  - Callback " + ordinal + " · " + inlineCode(value));
      }
    }
  }
  if (temporal?.gaps.length) {
    lines.push("", "## Unavailable transition evidence", "");
    const names = temporalNames(evidence, trace?.signals);
    const name = (signal: number, bit?: number) =>
      mermaidLabel(
        temporalSignalName(names.get(signal) ?? "RTL signal " + signal, bit),
      );
    for (const {
      signal,
      bit,
      tick,
      reason,
      use,
      continuation,
    } of temporal.gaps) {
      const target = use && temporal.nodes[use.target];
      const assignment = use && trace?.assignments[use.assignment];
      lines.push(
        "- " +
          name(signal, bit) +
          " @ " +
          tick +
          " · " +
          temporalGapLabels[reason] +
          (target
            ? " · " +
              temporalGapUseLabel(use) +
              " input to " +
              name(target.signal, target.bit) +
              " @ " +
              target.tick
            : "") +
          (assignment
            ? " · " + mermaidLabel(sourceLocation(assignment.location))
            : "") +
          (continuation
            ? " · Continue from `" +
              continuation.signal.replace(/[\x60\r\n]/g, " ") +
              "` @ " +
              continuation.tick +
              (continuation.changeOrder === undefined
                ? ""
                : " · Change " + continuation.changeOrder) +
              (continuation.historyStart === "auto"
                ? " · Search earlier history"
                : "")
            : ""),
      );
    }
    if (temporal.gapsTruncated)
      lines.push(
        "- Additional individual gaps were omitted. The signal summary includes them.",
      );
  }
  const result = evidence.assignmentCandidates;
  if (evidence.cursorWriters) {
    const { tick, value, candidateStatus, candidates } = evidence.cursorWriters;
    const status = {
      incomplete: "Driver coverage is incomplete.",
      writersExcluded: "The available observations exclude the listed writes.",
      sameValueWritePossible: "A candidate could write the same value.",
      inconclusive:
        "The available samples leave the writer conditions unresolved.",
    }[candidateStatus];
    lines.push(
      "",
      "## Unchanged cursor sample",
      "",
      "Tick " + tick + " · Value " + value,
      status,
      "",
      ...candidates.map(
        (candidate) =>
          "- " + sourceLocation(candidate.location) + " · " + candidate.status,
      ),
    );
  }
  if (result?.status === "observedChange") {
    lines.push(
      "",
      "## Candidate assignments for the observed change",
      "",
      "Tick " + result.change.tick + " · Value " + result.change.value,
      "",
    );
    if (result.changesAtTick)
      lines.push(
        "The waveform records " +
          result.changesAtTick.map(({ value }) => value).join(" → ") +
          " at this tick. The order is specific to the observed signal. Assignment timing is unresolved.",
        "",
      );
    for (const candidate of result.candidates) {
      const commits =
        temporal?.nodes.flatMap(({ tick, recordedWriter }) =>
          tick === result.change.tick &&
          recordedWriter?.assignment === candidate.assignment
            ? [recordedWriter.commitOrdinal]
            : [],
        ) ?? [];
      const index = candidate.targetIndex;
      const indexExcluded =
        index?.status === "outOfRange" ||
        index?.status === "differentBit" ||
        candidate.targetElement?.status === "differentElement";
      const label =
        candidate.status === "consistentWithObservations"
          ? "Trigger and guards consistent with the observations"
          : candidate.status === "contradictedByObservations"
            ? indexExcluded
              ? "The target index excludes this write"
              : "Trigger or guard contradicted by the observations"
            : "Possible assignment";
      lines.push(
        "- " +
          label +
          " · " +
          sourceLocation(candidate.location) +
          (commits.length
            ? " · Recorded writer at commit " + commits.join(", ")
            : ""),
      );
      if (index)
        lines.push(
          "  - Target index " +
            (index.index ?? "unresolved") +
            " · " +
            index.status,
        );
      if (candidate.targetElement)
        lines.push(
          "  - Array word index " +
            (candidate.targetElement.index ?? "unresolved") +
            " · " +
            candidate.targetElement.status,
        );
      if (candidate.value) {
        const target = candidate.value.targetRange?.join(":");
        lines.push(
          "  - Assignment value " +
            candidate.value.expected +
            (target ? " · Target [" + target + "]" : "") +
            " · Observed " +
            candidate.value.observed +
            " · " +
            (candidate.value.match ? "matched" : "different"),
        );
        const inputNames = candidate.value.inputs.map(
          (signal) =>
            evidence.observations.find((item) => item.signal === signal)
              ?.waveformSignal ?? "Unmapped signal",
        );
        if (inputNames.length)
          lines.push(
            "  - RHS inputs used · " + inputNames.map(mermaidLabel).join(", "),
          );
      }
      for (const { signal, values } of candidate.rhsSamples ?? []) {
        const name = evidence.observations.find(
          (item) => item.signal === signal,
        )?.waveformSignal;
        lines.push(
          "  - RHS sample comparison for " +
            mermaidLabel(name ?? "Signal " + signal) +
            " · " +
            values
              .map(
                ({ bits, match }) =>
                  bits + (match ? " compatible" : " differs"),
              )
              .join(", "),
        );
      }
      for (const trigger of candidate.triggers) {
        const name =
          evidence.observations.find(({ signal }) => trigger.signal === signal)
            ?.waveformSignal ?? "Unmapped signal";
        lines.push(
          "  - Trigger " +
            mermaidLabel(name) +
            " · " +
            (trigger.edge ?? "event") +
            " · " +
            (trigger.match == null
              ? "unknown"
              : trigger.match
                ? "matched"
                : "no matching event") +
            (trigger.multipleSamplesAtTick
              ? " · multiple recorded samples at this tick"
              : ""),
        );
      }
      for (const guard of candidate.guards) {
        lines.push(
          "  - Guard " +
            sourceLocation(guard.location) +
            " · " +
            (guard.expected ? "then" : "else") +
            " · " +
            (guard.value ?? "unknown"),
        );
      }
    }
  }
  return lines.join("\n") + "\n";
}

export function traceReport(
  trace: VideTrace,
  direction: TraceDirection,
  signal?: string,
  feedback = traceFeedback(trace),
  coverage = staticTraceCoverage(trace),
) {
  const names = new Map(
    trace.signals.map(({ id, name, instance }) => [
      id,
      instance ? instance + "." + name : name,
    ]),
  );
  const safe = (value: string) =>
    value.replace(/[\\\x60*_[\]<>|#]/g, "\\$&").replace(/[\r\n]/g, " ");
  const root = safe(signal ?? names.get(trace.root) ?? "Signal");
  const parameters = new Map(
    trace.signals.flatMap(({ id, parameterValue }) =>
      parameterValue ? [[id, parameterValue] as const] : [],
    ),
  );
  const lines = [
    "# RTL trace of " + root,
    "",
    "Direction " +
      direction +
      " · Scope " +
      trace.scope +
      " · Revision " +
      trace.revision,
    "",
    mermaidMarkdown(traceMermaidPages(trace, feedback)),
    "",
    "## Assignments",
    "",
  ];
  if (trace.simulationProject) {
    const project = trace.simulationProject;
    const compilation = trace.compilation;
    lines.splice(
      4,
      0,
      "filelist" in project
        ? (project.vcsRebuild
            ? "VCS rebuild metadata "
            : "Simulation filelist ") + safe(project.filelist)
        : "videManifest" in project
          ? "VIDE project manifest " + safe(project.videManifest)
          : "Simulation build manifest " + safe(project.buildManifest),
      "Simulator directory " + safe(project.workingDirectory),
      ...(compilation?.topModules.length
        ? ["- Top modules " + compilation.topModules.map(safe).join(", ")]
        : []),
      ...(compilation?.parameterOverrides?.length
        ? [
            "- Parameter overrides " +
              compilation.parameterOverrides.map(safe).join(", "),
          ]
        : []),
      ...(compilation?.defines.length
        ? ["- Defines " + compilation.defines.map(safe).join(", ")]
        : []),
      ...(compilation?.includeDirs.length
        ? [
            "- Include directories " +
              compilation.includeDirs.map(safe).join(", "),
          ]
        : []),
      ...(project.libraryMaps ?? []).map(
        (file) => "- Library map " + safe(file),
      ),
      ...(compilation?.compilationUnits ?? []).flatMap((unit, index) => {
        const options = compilation?.compilationUnitOptions?.[index];
        return [
          "- Compilation unit " +
            (index + 1) +
            " · " +
            unit.map(safe).join(", "),
          ...(options?.defines.length
            ? ["  - Defines " + options.defines.map(safe).join(", ")]
            : []),
          ...(options?.includeDirs.length
            ? [
                "  - Include directories " +
                  options.includeDirs.map(safe).join(", "),
              ]
            : []),
        ];
      }),
      ...(project.resolvedLibraryFiles
        ? [
            (project.resolvedLibraryFiles.kind === "kdb"
              ? "Library lookup from VCS KDB "
              : "Library lookup from Verilator elaboration ") +
              safe(project.resolvedLibraryFiles.design),
            ...project.resolvedLibraryFiles.files.map(
              (file) => "- Resolved library " + safe(file),
            ),
          ]
        : []),
      ...(compilation?.libraryFiles ?? []).map(
        (uri) => "- Source library " + safe(uri),
      ),
      ...(compilation?.sourceLibraries ?? []).map(
        ({ path, name }) => "- Library " + safe(name) + " · " + safe(path),
      ),
      ...project.limitations.map(
        (item) => "- Unmapped compilation input " + safe(item),
      ),
      "",
    );
  }
  for (const assignment of trace.assignments) {
    const port = assignment.port;
    const from = portSourceSelection(port);
    const to = selectionText(
      port?.toRange ?? assignment.targetRange,
      port?.toBit,
    );
    const targetLabel = assignment.writtenBits
      ? "[" + assignment.writtenBits.join(", ") + "]"
      : to || (assignment.targetIndex ? "[index]" : "");
    const targets = assignment.targets
      .map((target) => safe((names.get(target) ?? "?") + targetLabel))
      .join(", ");
    lines.push(
      "- **" +
        targets +
        "** · " +
        (port?.modportAlias ? "modport alias" : assignment.kind) +
        " · " +
        safe(sourceLocation(assignment.location)),
    );
    if (assignment.process)
      lines.push("  - Process " + safe(sourceLocation(assignment.process)));
    if (assignment.instance)
      lines.push("  - Assignment instance " + safe(assignment.instance));
    if (assignment.overlappingModportWrite)
      lines.push(
        "  - A component of the same modport assignment also writes to this range. The waveform or an execution record can provide evidence of the write order.",
      );
    if (assignment.generateIndices)
      lines.push(
        "  - Generate indices " +
          Object.entries(assignment.generateIndices)
            .map(([name, index]) => safe(name + " = " + index))
            .join(", "),
      );
    if (port?.indexSignal !== undefined)
      lines.push("  - Port index " + safe(names.get(port.indexSignal) ?? "?"));
    if (port?.indexSignals?.length)
      lines.push(
        "  - Port index operands " +
          port.indexSignals.map((id) => safe(names.get(id) ?? "?")).join(", "),
      );
    if (port?.expression && assignment.value)
      lines.push(
        (port.modportAlias ? "  - Alias mapping " : "  - Port expression ") +
          safe(portExpression(assignment.value, names)),
      );
    if (port?.conversion) {
      const { fromWidth, toWidth, twoState } = port.conversion;
      lines.push(
        "  - Port conversion " +
          fromWidth +
          " → " +
          toWidth +
          " bits" +
          (twoState ? " · two-state destination" : ""),
      );
    }
    for (const input of assignment.inputs) {
      const selected = input.readBits
        ? "[" + input.readBits.join(", ") + "]"
        : from;
      const name = safe((names.get(input.signal) ?? "?") + selected);
      const kind = input.edge ? input.kind + " " + input.edge : input.kind;
      const parameter = parameters.get(input.signal);
      const elaborated = parameter
        ? " · elaborated parameter " +
          (traceInteger(parameter.bits, parameter.signed)?.toString() ??
            parameter.bits)
        : "";
      lines.push(
        "  - " +
          name +
          " · " +
          kind +
          elaborated +
          " · " +
          safe(sourceLocation(input.location)),
      );
    }
    if (assignment.writtenBits && assignment.writtenBits.length > 1) {
      for (const { targetBit, reads } of assignment.bitDependencies ?? []) {
        if (reads.length)
          lines.push(
            "  - Target [" +
              targetBit +
              "] reads " +
              reads
                .map(({ signal, bits }) =>
                  safe(
                    (names.get(signal) ?? "?") + "[" + bits.join(", ") + "]",
                  ),
                )
                .join(", "),
          );
      }
    }
    if (assignment.kind === "port" && assignment.value?.op === "literal")
      lines.push("  - Port constant `" + assignment.value.args[0] + "`");
    for (const guard of assignment.guards ?? []) {
      lines.push(
        "  - Branch " +
          (guard.takenWhenTrue ? "then" : "else") +
          " · " +
          safe(sourceLocation(guard.location)),
      );
    }
    if (assignment.hasUnresolvedOperands)
      lines.push(
        assignment.unresolvedControlOnly
          ? "  - Unresolved control or timing operands"
          : "  - Unresolved operands",
      );
  }
  if (!trace.assignments.length)
    lines.push("No assignments in the query result.");
  if (feedback.length) {
    lines.push("", "## Feedback loops", "");
    for (const { assignment, signal, side } of feedback) {
      const relation = trace.assignments[assignment];
      lines.push(
        "- " +
          safe(names.get(signal) ?? "?") +
          " · " +
          side +
          " · " +
          safe(sourceLocation(relation.location)),
      );
    }
  }
  lines.push(
    "",
    "## Trace coverage",
    "",
    trace.scope === "elaborated"
      ? "Assignments and supported port connections in the elaborated design."
      : "The current analysis covers assignments within the queried RTL file.",
    coverage.status === "partial"
      ? "The query has unresolved or omitted relations."
      : "The query exhausted the supported relations in this scope.",
  );
  if (coverage.incompleteCompilation)
    lines.push(
      "- Parts of this graph could not be tied to one complete compilation profile.",
    );
  const descriptions: Record<string, string> = {
    unresolvedPort: "has an unresolved port connection.",
    unresolvedDesignSignal:
      "has a port declaration that could not be matched to the elaborated design.",
    unresolvedPortExpression: "has an unresolved port expression.",
    unresolvedGenerateBranch:
      "has an assignment whose generate branch could not be identified in the elaborated design.",
    unresolvedHierarchicalRead:
      "has a hierarchical read whose instance could not be verified.",
    unresolvedHierarchicalLoad:
      "has a hierarchical consumer that requires instance-level load tracing.",
    unresolvedHierarchicalWrite:
      "has a hierarchical write whose instance or source could not be verified.",
    unresolvedRuntimeInput:
      "depends on simulator arguments or external stimulus whose value could not be established.",
    unresolvedProceduralLoop:
      "has a driver inside a procedural loop whose iterations could not be reconstructed.",
    unresolvedProceduralTiming:
      "has a driver whose delay or wait could not be reconstructed.",
    unresolvedVirtualInterfaceBinding:
      "accesses a virtual interface whose runtime target is unavailable.",
    unresolvedUpdateEvaluation:
      "depends on an increment or decrement whose evaluation order could not be reconstructed.",
    mismatchedDesign:
      "could only be traced in its source file because the attached design differs from the build manifest.",
    vendorPortLinksUnavailable:
      "was traced within its RTL file. The SHM or WDB source index lacks connections between instances.",
    unverifiedVcsParameterPath:
      "could only be traced in its source file because VCS KDB may omit an indexed parameter override.",
  };
  for (const item of coverage.stops) {
    const reason =
      descriptions[item.reason] ??
      "reached the " + safe(item.reason) + " limit.";
    lines.push(
      "- " +
        safe(item.path ?? names.get(item.signal) ?? "?") +
        " " +
        reason +
        (item.reason === "unresolvedPort" ||
        item.reason === "unresolvedDesignSignal"
          ? (item.locations ?? [])
              .map((location) => " · " + safe(sourceLocation(location)))
              .join("")
          : "") +
        (item.continuationSignals?.length
          ? " Continue from " +
            item.continuationSignals
              .map(
                (signal) =>
                  "\x60" + signal.replace(/[\x60\r\n]/g, " ") + "\x60",
              )
              .join(", ") +
            "."
          : item.canRetrace
            ? " Use " +
              (item.waveformSignal
                ? safe(item.waveformSignal)
                : "this signal") +
              " as the root of a follow-up trace."
            : item.waveformUnavailable
              ? " No matching dumped signal for waveform continuation."
              : ""),
    );
  }
  const traceSites = new Set<string>();
  const siteLabels: Record<string, string> = {
    unresolvedRuntimeInput: "Runtime input",
    unresolvedProceduralLoop: "Procedural loop",
    unresolvedProceduralTiming: "Procedural timing",
    unresolvedVirtualInterfaceBinding: "Virtual interface access",
    unresolvedUpdateEvaluation: "Increment or decrement",
  };
  for (const { reason, location } of trace.frontier) {
    if (!location) continue;
    const label = siteLabels[reason];
    if (label)
      traceSites.add("- " + label + " · " + safe(sourceLocation(location)));
  }
  lines.push(...traceSites);
  for (const diagnostic of trace.diagnostics) {
    if (diagnostic !== "localAssignmentCoverage")
      lines.push("- " + safe(diagnostic));
  }
  return lines.join("\n") + "\n";
}
