// SPDX-License-Identifier: MPL-2.0

import type { Signal } from "./shared/protocol";
import {
  traceFeedback,
  type AssignmentValue,
  type TraceDirection,
  type VideTrace,
} from "./rtl-trace";
import { tracePackedSelection } from "./rtl-trace-observations";
import {
  evaluateTraceValue,
  traceInteger,
  traceValueShapes,
} from "./rtl-trace-values";

type Assignment = VideTrace["assignments"][number];
type Range = readonly [number, number];
type Demand = { signal: number; bit?: number };
type Reads = Map<number, Set<number>>;
type Relation = { assignment: number; source: number; target: number };

function contains([left, right]: Range, bit: number) {
  return Math.min(left, right) <= bit && bit <= Math.max(left, right);
}

function indexFromRight([left, right]: Range, slot: number) {
  return right + (left >= right ? slot : -slot);
}

export function directPortValue(
  assignment: Pick<
    Assignment,
    "kind" | "port" | "inputs" | "targets" | "hasUnresolvedOperands"
  >,
) {
  const { port, inputs } = assignment;
  if (
    assignment.kind !== "port" ||
    !port ||
    assignment.hasUnresolvedOperands ||
    inputs.length !== 1 ||
    inputs[0].kind !== "data" ||
    assignment.targets.length !== 1 ||
    port.fromField ||
    port.toField ||
    port.expression ||
    port.indexSignal !== undefined ||
    port.indexSignals?.length ||
    port.indexedPart
  )
    return;
  const { signal } = inputs[0];
  const range =
    port.fromBit === undefined
      ? port.fromRange
      : ([port.fromBit, port.fromBit] as const);
  const value: AssignmentValue = range
    ? { op: "select", args: [signal, ...range] }
    : { op: "signal", args: signal };
  const conversion = port.conversion;
  return conversion?.twoState
    ? ({
        op: "cast",
        args: [conversion.toWidth, false, true, value],
      } satisfies AssignmentValue)
    : value;
}

export function hasPackedSelection(
  value: AssignmentValue | undefined,
): boolean {
  switch (value?.op) {
    case "select":
    case "slice":
    case "bitSelect":
    case "indexedPartSelect":
      return true;
    case "concat":
      return value.args.some(hasPackedSelection);
    case "repeat":
    case "unary":
      return hasPackedSelection(value.args[1]);
    case "binary":
      return (
        value.args[0] === "shiftLeft" ||
        value.args[0] === "shiftRight" ||
        value.args[0] === "arithmeticShiftRight" ||
        hasPackedSelection(value.args[1]) ||
        hasPackedSelection(value.args[2])
      );
    case "conditional":
      return true;
    case "cast":
      return hasPackedSelection(value.args[3]);
    default:
      return false;
  }
}

export function packedDependencies(
  rangeOf: (id: number) => Range | undefined,
  signedness: (id: number) => boolean | undefined,
) {
  const shape = traceValueShapes((id) => {
    const range = rangeOf(id);
    return (
      range && {
        width: Math.abs(range[0] - range[1]) + 1,
        signed: signedness(id),
      }
    );
  });
  const constants = new Map<
    AssignmentValue,
    ReturnType<typeof evaluateTraceValue>
  >();
  function constantValue(value: AssignmentValue) {
    if (!constants.has(value))
      constants.set(
        value,
        evaluateTraceValue(value, undefined, () => undefined),
      );
    return constants.get(value);
  }

  return function dependencies(
    assignment: Parameters<typeof directPortValue>[0] &
      Pick<Assignment, "value" | "unresolvedControlOnly" | "targetIndex">,
    ordinal: number,
    resolveSelector?: (
      selector: AssignmentValue,
      use: "index" | "shift" | "condition",
    ) => ReturnType<typeof evaluateTraceValue>,
    targetWidth?: number,
  ) {
    const value = assignment.value ?? directPortValue(assignment);
    if (
      !value ||
      (assignment.hasUnresolvedOperands && !assignment.unresolvedControlOnly) ||
      assignment.targetIndex ||
      assignment.targets.length !== 1
    )
      return;
    const reads = new Map<number, Set<number>>();
    function record(signal: number, index: number) {
      const indices = reads.get(signal) ?? new Set<number>();
      indices.add(index);
      reads.set(signal, indices);
    }
    function visitTruth(operand: AssignmentValue): boolean {
      const type = shape(operand);
      if (!type) return false;
      for (let bit = 0; bit < type.width; bit++)
        if (!visit(operand, bit, type.signed, type.width)) return false;
      return true;
    }
    function visit(
      node: AssignmentValue,
      slot: number,
      signed: boolean | undefined,
      width: number,
    ): boolean {
      const type = shape(node);
      if (!type) return false;
      const contextSized =
        node.op === "binary" ||
        node.op === "conditional" ||
        (node.op === "unary" && node.args[0] === "bitNot");
      if (slot >= type.width && !type.fill && !contextSized) {
        if (signed === false) return true;
        if (signed === undefined) return false;
        slot = type.width - 1;
      }
      switch (node.op) {
        case "signal": {
          const range = rangeOf(node.args);
          if (!range) return false;
          record(node.args, indexFromRight(range, slot));
          return true;
        }
        case "select": {
          const [id, left, right] = node.args;
          record(id, indexFromRight([left, right], slot));
          return true;
        }
        case "slice": {
          const input = shape(node.args[0]);
          return (
            !!input &&
            visit(node.args[0], slot + node.args[2], input.signed, input.width)
          );
        }
        case "bitSelect":
        case "indexedPartSelect": {
          const [id, index] = node.args;
          const range = rangeOf(id);
          if (!range) return false;
          const resolved =
            constantValue(index) ?? resolveSelector?.(index, "index");
          const start =
            resolved && traceInteger(resolved.bits, resolved.signed);
          if (start === undefined) return false;
          const up = node.op === "bitSelect" || node.args[2].ascendingIndices;
          const leftToRight = range[0] <= range[1];
          const last =
            leftToRight === up
              ? start + BigInt(type.width - 1) * (up ? 1n : -1n)
              : start;
          const selected = last + BigInt(slot) * (leftToRight ? -1n : 1n);
          if (
            selected >= BigInt(Math.min(...range)) &&
            selected <= BigInt(Math.max(...range))
          )
            record(id, Number(selected));
          return true;
        }
        case "concat":
          for (let index = node.args.length - 1; index >= 0; index--) {
            const part = node.args[index];
            const member = shape(part);
            if (!member) return false;
            if (slot < member.width)
              return visit(part, slot, member.signed, member.width);
            slot -= member.width;
          }
          return false;
        case "repeat": {
          const member = shape(node.args[1]);
          return (
            !!member &&
            visit(
              node.args[1],
              slot % member.width,
              member.signed,
              member.width,
            )
          );
        }
        case "unary":
          return (
            node.args[0] === "bitNot" &&
            visit(node.args[1], slot, signed, width)
          );
        case "binary": {
          const [op, left, right] = node.args;
          if (op === "and" || op === "or")
            return slot > 0 || (visitTruth(left) && visitTruth(right));
          if (
            op === "shiftLeft" ||
            op === "shiftRight" ||
            op === "arithmeticShiftRight"
          ) {
            const amount = (
              constantValue(right) ?? resolveSelector?.(right, "shift")
            )?.bits;
            if (amount === undefined) return false;
            if (/[xz]/.test(amount)) return true;
            const shift = BigInt("0b" + amount);
            const offset = shift >= BigInt(width) ? width : Number(shift);
            const source = op === "shiftLeft" ? slot - offset : slot + offset;
            if (source < 0) return true;
            if (source < width) return visit(left, source, signed, width);
            if (op !== "arithmeticShiftRight" || signed === false) return true;
            return signed === true && visit(left, width - 1, signed, width);
          }
          return (
            ["bitAnd", "bitOr", "bitXor"].includes(op) &&
            visit(left, slot, signed, width) &&
            visit(right, slot, signed, width)
          );
        }
        case "conditional": {
          const [condition, yes, no] = node.args;
          const test = (
            constantValue(condition) ??
            resolveSelector?.(condition, "condition")
          )?.bits;
          if (test === undefined) return false;
          if (test.includes("1")) return visit(yes, slot, signed, width);
          return (
            visit(no, slot, signed, width) &&
            (!/[xz]/.test(test) || visit(yes, slot, signed, width))
          );
        }
        case "cast": {
          const member = shape(node.args[3]);
          return (
            !!member &&
            visit(
              node.args[3],
              slot,
              member.signed,
              Math.max(type.width, member.width),
            )
          );
        }
        case "literal":
        case "unsignedBit":
        case "fillBit":
        case "fillUnknown":
          return true;
        default:
          return false;
      }
    }
    const result = shape(value);
    if (
      !result ||
      !visit(
        value,
        ordinal,
        result.signed,
        Math.max(targetWidth ?? result.width, result.width),
      )
    )
      return;
    const dataInputs = new Set(
      assignment.inputs
        .filter(({ kind }) => kind === "data")
        .map(({ signal }) => signal),
    );
    if ([...reads.keys()].every((signal) => dataInputs.has(signal)))
      return reads;
  };
}

export function focusPackedTrace(
  trace: VideTrace,
  selection: number | [number, number] | undefined,
  direction: TraceDirection,
  bindings: ReadonlyMap<number, Signal>,
): VideTrace {
  const limit = 16384;
  const descriptors = new Map(
    trace.signals.map((signal) => [signal.id, signal]),
  );
  const ranges = new Map<number, Range>();
  const implicitScalars = new Set<number>();
  for (const [id, binding] of bindings) {
    const width = binding.sourceWidth ?? binding.width;
    const range = tracePackedSelection(binding).range;
    if (range && Math.abs(range[0] - range[1]) + 1 === width)
      ranges.set(id, range);
    else if (width === 1) {
      ranges.set(id, [0, 0]);
      if (selection === undefined) implicitScalars.add(id);
    }
  }
  for (const { id, packedRange } of trace.signals) {
    if (packedRange?.length === 2 && packedRange.every(Number.isSafeInteger))
      ranges.set(id, packedRange);
  }
  const selectedRange =
    typeof selection === "number"
      ? [selection, selection]
      : (selection ?? ranges.get(trace.root));
  if (
    !selectedRange ||
    (selection === undefined && selectedRange[0] !== selectedRange[1])
  )
    return trace;
  const dependencies = packedDependencies(
    (id) => ranges.get(id),
    (id) => descriptors.get(id)?.signed,
  );

  const rootSelection: Omit<
    NonNullable<VideTrace["bitSelection"]>,
    "feedbackEdges"
  > = typeof selection === "number" ? { bit: selection } : { range: selection };
  function budgetFallback(): VideTrace {
    return {
      ...trace,
      frontier: [
        ...trace.frontier,
        { signal: trace.root, reason: "bitTraceBudget" },
      ],
      bitSelection: { ...rootSelection, feedbackEdges: traceFeedback(trace) },
    };
  }

  const bySignal = new Map<number, number[]>();
  trace.assignments.forEach((assignment, id) => {
    const signals =
      direction === "drivers"
        ? assignment.targets
        : assignment.inputs.map(({ signal }) => signal);
    for (const signal of new Set(signals)) {
      const entries = bySignal.get(signal) ?? [];
      entries.push(id);
      bySignal.set(signal, entries);
    }
  });

  const states: Demand[] = [];
  const ids = new Map<string, number>();
  const reachableSignals = new Set<number>();
  const used = new Map<
    number,
    {
      inputs: Map<number, Set<number> | null>;
      outputs: Set<number> | null;
      dependencies: Map<number, Reads | null>;
    }
  >();
  const edgeStates: Relation[] = [];
  function enqueue(signal: number, selected?: number) {
    const range = ranges.get(signal);
    const bit =
      selected ?? (range?.[0] === range?.[1] ? range?.[0] : undefined);
    const key = signal + ":" + (bit ?? "*");
    const existing = ids.get(key);
    if (existing !== undefined) return existing;
    const id = states.length;
    ids.set(key, id);
    states.push({ signal, bit });
    reachableSignals.add(signal);
    return id;
  }

  const start = Math.min(...selectedRange);
  const end = Math.max(...selectedRange);
  if (end - start + 1 > limit) return budgetFallback();
  for (let bit = start; bit <= end; bit++) enqueue(trace.root, bit);

  const lookup = new Map<number, Map<number, Reads | undefined>>();
  function readsAt(id: number, range: Range, bit: number) {
    const values = lookup.get(id) ?? new Map<number, Reads | undefined>();
    if (!lookup.has(id)) lookup.set(id, values);
    if (!values.has(bit))
      values.set(
        bit,
        dependencies(
          trace.assignments[id],
          Math.abs(bit - range[1]),
          undefined,
          Math.abs(range[0] - range[1]) + 1,
        ),
      );
    return values.get(bit);
  }

  function include(
    id: number,
    targetSignal: number | undefined,
    output: number | undefined,
    reads: Reads | undefined,
    state: number,
  ) {
    const assignment = trace.assignments[id];
    const relation = used.get(id) ?? {
      inputs: new Map<number, Set<number> | null>(),
      outputs: new Set<number>(),
      dependencies: new Map<number, Reads | null>(),
    };
    used.set(id, relation);
    if (output === undefined) relation.outputs = null;
    else {
      relation.outputs?.add(output);
      relation.dependencies.set(output, reads ?? null);
    }
    const target =
      direction === "drivers"
        ? state
        : targetSignal === undefined
          ? undefined
          : enqueue(targetSignal, output);
    for (const { signal, kind } of assignment.inputs) {
      const selected = kind === "data" ? reads?.get(signal) : undefined;
      if (kind === "data" && reads && !selected) continue;
      const known = relation.inputs.get(signal);
      if (!selected) relation.inputs.set(signal, null);
      else if (known !== null) {
        const bits = known ?? new Set<number>();
        for (const bit of selected) bits.add(bit);
        relation.inputs.set(signal, bits);
      }
      if (direction === "drivers") {
        const sources = selected
          ? [...selected].map((bit) => enqueue(signal, bit))
          : [enqueue(signal)];
        for (const source of sources)
          edgeStates.push({ assignment: id, source, target: state });
      }
    }
    if (direction === "loads" && target !== undefined)
      edgeStates.push({ assignment: id, source: state, target });
  }

  let examined = 0;
  function overBudget() {
    return ++examined + states.length + edgeStates.length > limit;
  }
  const loadOutputs = new Map<
    string,
    { byBit: Map<number, number[]>; all: number[]; possible: number[] }
  >();
  for (let state = 0; state < states.length; state++) {
    const demand = states[state];
    for (const id of bySignal.get(demand.signal) ?? []) {
      if (overBudget()) return budgetFallback();
      const assignment = trace.assignments[id];
      if (direction === "drivers") {
        const range =
          assignment.targets.length === 1
            ? (assignment.targetRange ?? ranges.get(demand.signal))
            : undefined;
        const bit = assignment.targetIndex || !range ? undefined : demand.bit;
        if (bit !== undefined && range && !contains(range, bit)) continue;
        include(
          id,
          demand.signal,
          bit,
          range && bit !== undefined ? readsAt(id, range, bit) : undefined,
          state,
        );
        continue;
      }
      const target = assignment.targets[0];
      const range = assignment.targetRange ?? ranges.get(target);
      if (!range || assignment.targetIndex || assignment.targets.length !== 1) {
        for (const target of new Set(
          assignment.targets.length ? assignment.targets : [undefined],
        ))
          include(id, target, undefined, undefined, state);
        continue;
      }
      const key = id + ":" + demand.signal;
      let outputs = loadOutputs.get(key);
      if (!outputs) {
        outputs = { byBit: new Map(), all: [], possible: [] };
        const controls = assignment.inputs.some(
          ({ signal, kind }) => signal === demand.signal && kind !== "data",
        );
        const first = Math.min(...range);
        const last = Math.max(...range);
        for (let bit = first; bit <= last; bit++) {
          if (overBudget()) return budgetFallback();
          const reads = readsAt(id, range, bit);
          if (!reads || controls) {
            outputs.possible.push(bit);
            outputs.all.push(bit);
          } else {
            const selected = reads.get(demand.signal);
            if (!selected) continue;
            outputs.all.push(bit);
            for (const sourceBit of selected) {
              const matched = outputs.byBit.get(sourceBit) ?? [];
              matched.push(bit);
              outputs.byBit.set(sourceBit, matched);
            }
          }
        }
        loadOutputs.set(key, outputs);
      }
      const bits =
        demand.bit === undefined
          ? outputs.all
          : [...outputs.possible, ...(outputs.byBit.get(demand.bit) ?? [])];
      for (const bit of bits) {
        if (overBudget()) return budgetFallback();
        include(id, target, bit, readsAt(id, range, bit), state);
      }
    }
  }

  const retained = new Set(reachableSignals);
  const assignmentIds = new Map<number, number>();
  const assignments = trace.assignments.flatMap((assignment, id) => {
    const relation = used.get(id);
    if (!relation) return [];
    assignmentIds.set(id, assignmentIds.size);
    for (const target of assignment.targets) retained.add(target);
    const inputs = assignment.inputs.flatMap((input) => {
      const bits = relation.inputs.get(input.signal);
      if (bits === undefined) return [];
      const selected =
        bits &&
        [...bits].filter(
          (bit) => !input.interfaceRange || contains(input.interfaceRange, bit),
        );
      if (selected?.length === 0) return [];
      retained.add(input.signal);
      return [
        {
          ...input,
          readBits: implicitScalars.has(input.signal)
            ? undefined
            : selected?.sort((a, b) => a - b),
        },
      ];
    });
    return [
      {
        ...assignment,
        inputs,
        writtenBits:
          relation.outputs && !implicitScalars.has(assignment.targets[0])
            ? [...relation.outputs].sort((a, b) => a - b)
            : undefined,
        bitDependencies:
          relation.outputs && assignment.targets.length === 1
            ? [...relation.dependencies]
                .flatMap(([targetBit, reads]) =>
                  reads
                    ? [
                        {
                          targetBit,
                          reads: [...reads].map(([signal, bits]) => ({
                            signal,
                            bits: [...bits].sort((a, b) => a - b),
                          })),
                        },
                      ]
                    : [],
                )
                .sort((a, b) => a.targetBit - b.targetBit)
            : undefined,
        value:
          inputs.length === assignment.inputs.length
            ? assignment.value
            : undefined,
      },
    ];
  });
  const frontierSignals = new Set(trace.frontier.map(({ signal }) => signal));
  const frontierBits = new Map<number, number[]>();
  const wholeFrontierSignals = new Set<number>();
  for (const { signal, bit } of states) {
    if (!frontierSignals.has(signal)) continue;
    const range = ranges.get(signal);
    if (bit === undefined || !range || range[0] === range[1]) {
      wholeFrontierSignals.add(signal);
      continue;
    }
    const bits = frontierBits.get(signal) ?? [];
    bits.push(bit);
    frontierBits.set(signal, bits);
  }
  const projected: VideTrace = {
    ...trace,
    assignments,
    signals: trace.signals.filter(({ id }) => retained.has(id)),
    frontier: trace.frontier.flatMap((stop) => {
      if (!reachableSignals.has(stop.signal)) return [];
      const bits = wholeFrontierSignals.has(stop.signal)
        ? undefined
        : frontierBits.get(stop.signal);
      return [
        bits?.length
          ? { ...stop, bits: [...bits].sort((left, right) => left - right) }
          : stop,
      ];
    }),
  };
  const feedbackEdges = states.some((state) => state.bit === undefined)
    ? traceFeedback(projected)
    : traceFeedback({
        ...projected,
        signals: states.map(({ signal }, id) => ({
          ...descriptors.get(signal)!,
          id,
        })),
        assignments: edgeStates.map(({ assignment, source, target }) => ({
          ...trace.assignments[assignment],
          inputs: [
            {
              signal: source,
              kind: "data",
              edge: null,
              location: trace.assignments[assignment].location,
            },
          ],
          targets: [target],
        })),
      }).map((edge) => ({
        ...edge,
        signal: states[edge.signal].signal,
        assignment: assignmentIds.get(edgeStates[edge.assignment].assignment)!,
      }));
  return { ...projected, bitSelection: { ...rootSelection, feedbackEdges } };
}
