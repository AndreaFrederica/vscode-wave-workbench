// SPDX-License-Identifier: MPL-2.0

import { dependencyPaths, type TracePathMode } from "./rtl-trace-path";
import {
  traceSignalScope,
  type AssignmentValue,
  type TraceDirection,
} from "./rtl-trace";
import { directPortValue, packedDependencies } from "./rtl-trace-bits";
import type { StaticPathGraph } from "./rtl-static-path";
import { createMermaidFlowchart, mermaidMarkdown } from "./trace-mermaid";

type Bit = { signal: number; bit: number };
type Link = {
  source: number;
  target: number;
  assignment: number;
  fromPort?: true;
  fromExpression?: true;
};
type Assignment = StaticPathGraph["assignments"][number];
type Signal = StaticPathGraph["signals"][number];
const maxDerivedBitWork = 16_384;

function directPortBits(
  assignment: Assignment,
  signals: ReadonlyMap<number, Signal>,
  budget: number,
) {
  const { port, inputs, targets } = assignment;
  if (!port || !directPortValue(assignment)) return;
  const input = inputs[0];
  const sourceSignal = signals.get(input.signal);
  const source =
    port.fromBit === undefined
      ? (port.fromRange ?? sourceSignal?.packedRange)
      : [port.fromBit, port.fromBit];
  const target =
    port.toBit === undefined
      ? (port.toRange ??
        assignment.targetRange ??
        signals.get(targets[0])?.packedRange)
      : [port.toBit, port.toBit];
  if (
    !source ||
    !target ||
    !source.every(Number.isSafeInteger) ||
    !target.every(Number.isSafeInteger)
  )
    return;
  const sourceWidth = Math.abs(source[0] - source[1]) + 1;
  const targetWidth = Math.abs(target[0] - target[1]) + 1;
  const conversion = port.conversion;
  if (
    targetWidth > budget ||
    (conversion
      ? conversion.fromWidth !== sourceWidth ||
        conversion.toWidth !== targetWidth
      : sourceWidth !== targetWidth)
  )
    return;
  const reads = input.readBits && new Set(input.readBits);
  const writes = assignment.writtenBits && new Set(assignment.writtenBits);
  const sourceStep = source[0] < source[1] ? -1 : 1;
  const targetStep = target[0] < target[1] ? -1 : 1;
  const signed =
    port.fromRange || port.fromBit !== undefined ? false : sourceSignal?.signed;
  const dependencies: NonNullable<Assignment["bitDependencies"]> = [];
  let incomplete = false;
  for (let offset = 0; offset < targetWidth; offset++) {
    const targetBit = target[1] + offset * targetStep;
    if (writes && !writes.has(targetBit)) continue;
    const extended = offset >= sourceWidth;
    if (extended && signed === undefined) {
      incomplete = true;
      continue;
    }
    const sourceBit =
      source[1] + Math.min(offset, sourceWidth - 1) * sourceStep;
    dependencies.push({
      targetBit,
      reads:
        (extended && !signed) || (reads && !reads.has(sourceBit))
          ? []
          : [{ signal: input.signal, bits: [sourceBit] }],
    });
  }
  return { dependencies, work: targetWidth, incomplete };
}

function expressionBits(
  assignment: Assignment,
  value: AssignmentValue,
  signals: ReadonlyMap<number, Signal>,
  readsAt: ReturnType<typeof packedDependencies>,
  budget: number,
) {
  if (assignment.targets.length !== 1) return;
  const range =
    assignment.targetRange ?? signals.get(assignment.targets[0])?.packedRange;
  if (!range?.every(Number.isSafeInteger)) return;
  const width = Math.abs(range[0] - range[1]) + 1;
  const work = width * Math.max(1, assignment.inputs.length);
  if (work > budget) return;
  const step = range[0] < range[1] ? -1 : 1;
  const written = assignment.writtenBits && new Set(assignment.writtenBits);
  const eligible = new Map(
    assignment.inputs
      .filter(({ kind }) => kind === "data")
      .map(({ signal, readBits }) => [signal, readBits && new Set(readBits)]),
  );
  const expression = { ...assignment, value };
  const dependencies: NonNullable<Assignment["bitDependencies"]> = [];
  let incomplete = false;
  for (let offset = 0; offset < width; offset++) {
    const targetBit = range[1] + offset * step;
    if (written && !written.has(targetBit)) continue;
    const reads = readsAt(expression, offset, undefined, width);
    if (!reads) {
      incomplete = true;
      continue;
    }
    dependencies.push({
      targetBit,
      reads: [...reads].flatMap(([signal, bits]) => {
        const selection = eligible.get(signal);
        const eligibleBits = [...bits].filter(
          (bit) => !selection || selection.has(bit),
        );
        return eligibleBits.length ? [{ signal, bits: eligibleBits }] : [];
      }),
    });
  }
  return { dependencies, work, incomplete };
}

export function isBitPathSelector(value: unknown) {
  return (
    typeof value === "object" && value !== null && Object.hasOwn(value, "bit")
  );
}

export function staticBitPaths(
  graph: StaticPathGraph,
  direction: TraceDirection,
  selectors: readonly unknown[],
  mode: TracePathMode,
  operation?: AbortSignal,
  bitExpressions?: ReadonlyMap<number, AssignmentValue | undefined>,
) {
  const signals = new Map(graph.signals.map((signal) => [signal.id, signal]));
  const readsAt = packedDependencies(
    (id) => signals.get(id)?.packedRange,
    (id) => signals.get(id)?.signed,
  );
  const names = new Map(
    graph.signals.map((signal) => {
      const scope = traceSignalScope(signal);
      return [signal.id, scope ? scope + "." + signal.name : signal.name];
    }),
  );
  const states: Bit[] = [];
  const indices = new Map<string, number>();
  function state(signal: number, bit: number) {
    const key = signal + ":" + bit;
    const existing = indices.get(key);
    if (existing !== undefined) return existing;
    const id = states.length;
    indices.set(key, id);
    states.push({ signal, bit });
    return id;
  }

  const requested = new Set<number>();
  for (const value of selectors) {
    const selector = value as
      | {
          signal?: unknown;
          bit?: unknown;
          tick?: unknown;
          changeOrder?: unknown;
        }
      | undefined;
    if (
      !selector ||
      typeof selector.signal !== "string" ||
      !Number.isSafeInteger(selector.bit) ||
      selector.tick !== undefined ||
      selector.changeOrder !== undefined
    )
      throw Error(
        "Select each static path endpoint by its full declaration path and integer bit index.",
      );
    const matching = [...names].filter(([, name]) => name === selector.signal);
    if (matching.length !== 1)
      throw Error("The static bit selector must match one signal declaration.");
    const signal = matching[0][0];
    const bit = selector.bit as number;
    const range = signals.get(signal)?.packedRange;
    if (range && (bit < Math.min(...range) || bit > Math.max(...range)))
      throw Error("A selected bit is outside the signal's declared range.");
    requested.add(state(signal, bit));
  }

  const incoming = new Map<number, Link[]>();
  let assignmentsWithoutBitMappings = 0;
  let remainingBitWork = maxDerivedBitWork;
  for (const [index, assignment] of graph.assignments.entries()) {
    if (index % 128 === 0) operation?.throwIfAborted();
    const portBits =
      !assignment.bitDependencies?.length &&
      directPortBits(assignment, signals, remainingBitWork);
    const value = bitExpressions?.get(assignment.id);
    const derived =
      portBits ||
      (!assignment.bitDependencies?.length &&
        value &&
        expressionBits(assignment, value, signals, readsAt, remainingBitWork));
    if (derived) remainingBitWork -= derived.work;
    const dependencies = derived
      ? derived.dependencies
      : assignment.bitDependencies;
    if (assignment.targets.length !== 1 || !dependencies?.length) {
      assignmentsWithoutBitMappings++;
      continue;
    }
    if (derived && derived.incomplete) assignmentsWithoutBitMappings++;
    const written = assignment.targets[0];
    const dataSignals = new Set(
      assignment.inputs
        .filter(({ kind }) => kind === "data")
        .map(({ signal }) => signal),
    );
    for (const { targetBit, reads } of dependencies) {
      for (const { signal, bits } of reads) {
        if (!dataSignals.has(signal) || !signals.has(signal)) continue;
        const output = state(written, targetBit);
        for (const bit of bits) {
          const input = state(signal, bit);
          const [source, target] =
            direction === "drivers" ? [input, output] : [output, input];
          const link: Link = {
            source,
            target,
            assignment: assignment.id,
            ...(portBits ? { fromPort: true } : {}),
            ...(derived && !portBits ? { fromExpression: true } : {}),
          };
          const links = incoming.get(target);
          if (links) links.push(link);
          else incoming.set(target, [link]);
        }
      }
    }
  }
  const rootRange = graph.bitSelection?.range;
  const rootBit = graph.bitSelection?.bit;
  const roots = states.flatMap(({ signal, bit }, id) =>
    signal === graph.root &&
    (rootBit === undefined || bit === rootBit) &&
    (!rootRange ||
      (bit >= Math.min(...rootRange) && bit <= Math.max(...rootRange)))
      ? [id]
      : [],
  );
  const { paths, selected, links } = dependencyPaths(
    roots,
    [...requested],
    incoming,
    mode,
    operation,
  );
  const edges = [...links].map(
    ({ source, target, assignment, ...evidence }) => ({
      // Keep data flow in the RTL direction for both Driver and Load.
      input: states[direction === "drivers" ? source : target],
      output: states[direction === "drivers" ? target : source],
      assignment,
      ...evidence,
    }),
  );
  const chosen = [...selected].map((id) => states[id]);
  const usedSignals = new Set(chosen.map(({ signal }) => signal));
  usedSignals.add(graph.root);
  const assignments = new Set(edges.map(({ assignment }) => assignment));
  const focused = {
    ...graph,
    signals: graph.signals.filter(({ id }) => usedSignals.has(id)),
    assignments: graph.assignments.filter(({ id }) => assignments.has(id)),
    feedbackEdges: graph.feedbackEdges.filter(
      ({ assignment, signal }) =>
        assignments.has(assignment) && usedSignals.has(signal),
    ),
    gaps: graph.gaps.filter(({ signal }) => usedSignals.has(signal)),
  };
  return {
    graph: focused,
    names,
    edges,
    chosen,
    assignmentsWithoutBitMappings,
    paths: paths.map((path) =>
      path.status === "found"
        ? {
            node: states[path.node],
            status: path.status,
            root: states[path.root],
            hops: path.hops,
          }
        : { node: states[path.node], status: path.status },
    ),
  };
}

type Result = ReturnType<typeof staticBitPaths>;

export function staticBitMermaid(result: Result) {
  const graph = createMermaidFlowchart({ root: "stroke-width:3px" });
  const id = (point: Bit) =>
    "s" + point.signal + "_" + String(point.bit).replace("-", "n");
  const assignments = new Map(
    result.graph.assignments.map((item) => [item.id, item]),
  );
  for (const point of result.chosen)
    graph.node(
      id(point),
      result.names.get(point.signal) + "[" + point.bit + "]",
      {
        style: point.signal === result.graph.root ? "root" : undefined,
      },
    );
  for (const {
    input,
    output,
    assignment,
    fromPort,
    fromExpression,
  } of result.edges) {
    const location = assignments.get(assignment)?.location;
    graph.edge(
      id(input),
      id(output),
      "A" +
        assignment +
        (fromPort ? " · port mapping" : "") +
        (fromExpression ? " · RTL expression" : "") +
        (location ? " · L" + (location.range.start.line + 1) : ""),
    );
  }
  return graph.pages();
}

export function staticBitReport(result: Result, pages: readonly string[]) {
  const code = (value: string) => "`" + value.replace(/[`\r\n]/g, " ") + "`";
  const label = ({ signal, bit }: Bit) =>
    code(result.names.get(signal) + "[" + bit + "]");
  const assignments = new Map(
    result.graph.assignments.map((item) => [item.id, item]),
  );
  return [
    "# Static RTL bit dependency paths",
    "",
    "Paths use RTL data bit mappings, supported RTL expressions, and elaborated direct ports. Parent coverage · " +
      result.graph.status,
    "Assignments with missing bit mappings in the source snapshot · " +
      result.assignmentsWithoutBitMappings,
    "",
    ...result.paths.map(
      (path) =>
        "- " +
        label(path.node) +
        (path.status === "found"
          ? " · " + label(path.root) + " · " + path.hops + " assignment hops"
          : " · Unreachable through recorded bit mappings"),
    ),
    "",
    mermaidMarkdown(pages),
    "",
    "## RTL bit dependencies",
    "",
    ...result.edges.map(
      ({ input, output, assignment, fromPort, fromExpression }) => {
        const { location, port } = assignments.get(assignment)!;
        const { uri, range } = location;
        const conversion = port?.conversion;
        return (
          "- " +
          label(input) +
          " → " +
          label(output) +
          " · A" +
          assignment +
          (fromPort ? " · elaborated port mapping" : "") +
          (fromExpression ? " · RTL expression" : "") +
          (conversion
            ? " · port conversion " +
              conversion.fromWidth +
              " → " +
              conversion.toWidth +
              " bits" +
              (conversion.twoState ? " · two-state destination" : "")
            : "") +
          " · " +
          code(uri) +
          " L" +
          (range.start.line + 1) +
          ":" +
          (range.start.character + 1)
        );
      },
    ),
    "",
    ...result.graph.gaps.map(
      ({ signal, reason }) =>
        "- Gap · " + code(result.names.get(signal)!) + " · " + reason,
    ),
    "",
  ].join("\n");
}
