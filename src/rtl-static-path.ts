// SPDX-License-Identifier: MPL-2.0

import { dependencyPaths, type TracePathMode } from "./rtl-trace-path";
import {
  selectionText,
  traceSignalScope,
  type TraceDirection,
} from "./rtl-trace";
import type { mergeStaticContinuationGraph } from "./rtl-static-continuations";
import { mermaidMarkdown } from "./trace-mermaid";

export type StaticPathGraph = ReturnType<typeof mergeStaticContinuationGraph>;

function signalPath(signal: StaticPathGraph["signals"][number]) {
  const scope = traceSignalScope(signal);
  return scope ? scope + "." + signal.name : signal.name;
}

export function staticTracePaths(
  graph: StaticPathGraph,
  direction: TraceDirection,
  nodeIds: readonly number[],
  selectors: readonly unknown[],
  mode: TracePathMode,
  operation?: AbortSignal,
) {
  const signals = new Map(graph.signals.map((signal) => [signal.id, signal]));
  const names = new Map(
    graph.signals.map((signal) => [signal.id, signalPath(signal)]),
  );
  const requested = new Set(nodeIds);
  const matches = selectors.map((entry) => {
    const selector = entry as
      | { signal?: unknown; tick?: unknown; changeOrder?: unknown }
      | undefined;
    if (
      typeof selector?.signal !== "string" ||
      !selector.signal.trim() ||
      selector.tick !== undefined ||
      selector.changeOrder !== undefined
    )
      throw Error("Select a static graph signal by its full declaration path.");
    const nodeIds: number[] = [];
    for (const [id, name] of names) {
      if (name !== selector.signal) continue;
      nodeIds.push(id);
      requested.add(id);
      if (requested.size > 16)
        throw Error("Path selection exceeds 16 signals.");
    }
    return { signal: selector.signal, nodeIds };
  });
  if (!requested.size)
    throw Error("No static graph signals match the selection.");
  if (requested.size > 16 || [...requested].some((id) => !signals.has(id)))
    throw Error("A requested signal is outside the static graph snapshot.");

  type Link = {
    source: number;
    target: number;
    assignment: number;
    input: number;
    written: number;
  };
  const incoming = new Map<number, Link[]>();
  for (const [index, assignment] of graph.assignments.entries()) {
    if (index % 128 === 0) operation?.throwIfAborted();
    for (const [input, operand] of assignment.inputs.entries()) {
      for (const written of assignment.targets) {
        const [source, target] =
          direction === "drivers"
            ? [operand.signal, written]
            : [written, operand.signal];
        const link = {
          source,
          target,
          assignment: assignment.id,
          input,
          written,
        };
        const links = incoming.get(target);
        if (links) links.push(link);
        else incoming.set(target, [link]);
      }
    }
  }
  const { paths, selected, links } = dependencyPaths(
    [graph.root],
    [...requested],
    incoming,
    mode,
    operation,
  );
  selected.add(graph.root);
  const relations = new Map<
    number,
    { inputs: Set<number>; targets: Set<number> }
  >();
  for (const link of links) {
    const entry = relations.get(link.assignment) ?? {
      inputs: new Set<number>(),
      targets: new Set<number>(),
    };
    entry.inputs.add(link.input);
    entry.targets.add(link.written);
    relations.set(link.assignment, entry);
  }
  const assignments = graph.assignments.flatMap((assignment) => {
    const relation = relations.get(assignment.id);
    if (!relation) return [];
    const inputs = assignment.inputs.filter((_, index) =>
      relation.inputs.has(index),
    );
    const targets = assignment.targets.filter((signal) =>
      relation.targets.has(signal),
    );
    const retained = new Set(inputs.map(({ signal }) => signal));
    return [
      {
        ...assignment,
        inputs,
        targets,
        bitDependencies: assignment.bitDependencies?.flatMap(
          ({ targetBit, reads }) => {
            const retainedReads = reads.filter(({ signal }) =>
              retained.has(signal),
            );
            return retainedReads.length
              ? [{ targetBit, reads: retainedReads }]
              : [];
          },
        ),
      },
    ];
  });
  const retainedAssignments = new Map(
    assignments.map((assignment) => [assignment.id, assignment]),
  );
  const feedbackEdges = graph.feedbackEdges.filter(
    ({ assignment, signal, side }) => {
      const retained = retainedAssignments.get(assignment);
      return side === "target"
        ? retained?.targets.includes(signal)
        : retained?.inputs.some((input) => input.signal === signal);
    },
  );
  const focused = {
    ...graph,
    signals: graph.signals.filter(({ id }) => selected.has(id)),
    assignments,
    feedbackEdges,
    bitSelection: graph.bitSelection && {
      ...graph.bitSelection,
      feedbackEdges,
    },
    gaps: graph.gaps.filter(({ signal }) => selected.has(signal)),
  };
  return { paths, matches, graph: focused, names };
}

export function staticPathReport(
  result: ReturnType<typeof staticTracePaths>,
  direction: TraceDirection,
  pages: readonly string[],
) {
  const code = (value: string) => "`" + value.replace(/[`\r\n]/g, " ") + "`";
  const { graph, names, paths } = result;
  const name = (id: number) => names.get(id) ?? "Signal " + id;
  const location = (
    source: StaticPathGraph["assignments"][number]["location"],
  ) =>
    code(source.uri) +
    " L" +
    (source.range.start.line + 1) +
    ":" +
    (source.range.start.character + 1);
  return [
    "# Static RTL dependency paths",
    "",
    "Direction · " +
      direction +
      " · Root · " +
      code(name(graph.root)) +
      selectionText(graph.bitSelection?.range, graph.bitSelection?.bit) +
      " · Parent coverage · " +
      graph.status,
    "Paths follow signal declarations. Bit selections describe individual RTL operands and writes.",
    "",
    ...paths.map((path) =>
      path.status === "found"
        ? "- " + code(name(path.node)) + " · " + path.hops + " assignment hops"
        : "- " + code(name(path.node)) + " · Unreachable in this snapshot",
    ),
    "",
    mermaidMarkdown(pages),
    "",
    "## RTL assignments",
    "",
    ...graph.assignments.flatMap((assignment) => {
      const port = assignment.port;
      const written = assignment.writtenBits?.length
        ? "[" + assignment.writtenBits.join(", ") + "]"
        : selectionText(port?.toRange ?? assignment.targetRange, port?.toBit);
      return [
        "- Assignment " +
          assignment.id +
          " · " +
          assignment.kind +
          " · " +
          location(assignment.location) +
          (assignment.hasUnresolvedOperands ? " · Unresolved operands" : ""),
        ...assignment.targets.map(
          (id) => "  - Writes " + code(name(id) + written),
        ),
        ...assignment.inputs.map((input) => {
          const bits = input.readBits?.length
            ? "[" + input.readBits.join(", ") + "]"
            : selectionText(
                input.interfaceRange ?? port?.fromRange,
                port?.fromBit,
              );
          return (
            "  - " +
            (input.edge ?? input.kind) +
            " · " +
            code(name(input.signal) + bits) +
            " · " +
            location(input.location)
          );
        }),
      ];
    }),
    "",
    ...graph.gaps.map(
      ({ signal, reason, unavailableBits }) =>
        "- Gap · " +
        code(name(signal)) +
        " · " +
        reason +
        (unavailableBits?.length
          ? " · bits " + unavailableBits.join(", ")
          : ""),
    ),
    "",
  ].join("\n");
}
