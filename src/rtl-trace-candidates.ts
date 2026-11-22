// SPDX-License-Identifier: MPL-2.0

import {
  isDirectTracePort,
  isPortIndex,
  isStaticBudgetStop,
  packedStructPorts,
  type GuardExpression,
  type AssignmentValue,
  type VideTrace,
} from "./rtl-trace";
import { hasPackedSelection, packedDependencies } from "./rtl-trace-bits";
import { temporalFeedback } from "./rtl-trace-feedback";
import type {
  RecordedTaskTransfer,
  ResolvedExternalStep,
} from "./rtl-execution";
import type { readTraceObservations } from "./rtl-trace-observations";
import {
  evaluateTraceValue,
  normalizeBits,
  sliceTraceBits,
  traceInteger,
  type TraceOperand,
} from "./rtl-trace-values";

type Evidence = Awaited<ReturnType<typeof readTraceObservations>>;
export type TraceBindingIssue =
  | "missingDeclaration"
  | "waveformMissing"
  | "waveformUnsupported"
  | "waveformAmbiguous"
  | "designObjectMissing"
  | "designLocationMissing"
  | "declarationMismatch";
type Observation = Evidence["observations"][number] & {
  partialRange?: readonly [number, number];
};
export type ObservedTraceWord = {
  id: number;
  array: number;
  index: string;
  name: string;
  instance: string;
};
export type RecordedTraceField = {
  id: number;
  signal: number;
  field: string;
  name: string;
  instance: string;
};
type IndexedAssignment = {
  id: number;
  assignment: VideTrace["assignments"][number];
};
type TemporalInput = VideTrace["assignments"][number]["inputs"][number];
type MissingReason =
  | "unmapped"
  | "enumValueUnavailable"
  | "packageParameterValueUnavailable"
  | "instanceParameterValueUnavailable"
  | "truncated"
  | "noChangeInWindow"
  | "noMatchingOperandChange"
  | "projectedDependency"
  | "waveformBitsUnavailable"
  | "unprovenTrigger"
  | "unprovenInitialOrder"
  | "unrecordedTaskInput";
export type TemporalEdgeEvidence = {
  kind: TemporalInput["kind"];
  role?: "index" | "condition";
  confidence: "possible" | "consistentWithObservations";
  timing?: "sameTickUnordered";
  callbackOrder?: "sourceBeforeTarget" | "sourceAfterTarget";
  continuousCause?: { sourceOrdinal: number; targetOrdinal: number };
  rhsSample?: "matches" | "differs";
  rhsSampleEvidence?: "recordedEvaluation" | "waveformCombination";
  sourceWriteEvidence?: "recordedSameValueWrite";
  controlSampleEvidence?:
    | "recordedEvaluation"
    | "recordedBranchEntry"
    | "recordedWaitResume";
  branchEntry?: {
    line: number;
    column: number;
    tick?: string;
    nextOrdinal?: number;
  };
  waitResumeCause?: "uniqueObservedTransition" | "orderedCallbacks";
  waitResumeCallbackOrdinal?: number;
  recordedCommitOrdinal?: number;
  arrayIndexEvidence?: "recordedTarget";
  packedIndexEvidence?: "recordedTarget";
};
export type TemporalGap = {
  signal: number;
  bit?: number;
  tick: string;
  value?: string;
  reason:
    | MissingReason
    | "nodeBudget"
    | "edgeBudget"
    | "staticBudget"
    | "selectedContinuation";
  bindingIssue?: TraceBindingIssue;
  declaration?: VideTrace["signals"][number]["declaration"];
  anchor?: number;
  sampleOnly?: true;
  initialSample?: true;
  orderAtTick?: number;
  historyCutoff?: string;
  continuation?: {
    signal: string;
    tick: string;
    changeOrder?: number;
    liveSessionId?: string;
    historyStart?: string;
  };
  use?: {
    target: number;
    assignment: number;
    kind: TemporalInput["kind"];
    edge?: TemporalInput["edge"];
    evidence?: TemporalEdgeEvidence;
  };
};
export type RecordedWriter = {
  assignment: number;
  commitOrdinal: number;
  targetRange?: [number, number];
  attemptedTargetRange?: [number, number];
  evaluation?: {
    ordinal: number;
    tick: string;
    value?: string;
    operandValues?: Record<string, string>;
    guardEntryValues?: Record<string, string>;
    guardEntryTicks?: Record<string, string>;
    guardEntryNextOrdinals?: Record<string, number>;
    externalSteps?: ResolvedExternalStep[];
  };
};

export type RecordedCursorWrite = {
  tick: string;
  value: string;
  writer: RecordedWriter;
};

export type RecordedModportComponent = {
  assignment: number;
  ordinal: number;
  range: [number, number];
  evaluationOrdinal?: number;
};

export type RecordedWordWriter = RecordedWriter & {
  contributingRanges?: [number, number][];
};

export type RecordedWordAttribution = {
  writer?: RecordedWriter;
  wordWriters: RecordedWordWriter[];
  unresolved: [number, number][];
};

export type RecordedOperandHistory = (
  signal: number,
  tick: string,
  evaluationOrdinal: number,
  value: string,
  bit?: number,
) =>
  | { tick: string; value: string; bit?: number; writer?: RecordedWriter }[]
  | undefined;

export function temporalTransitionKey({
  signal,
  bit,
  tick,
  orderAtTick,
  initialSample,
}: {
  signal: number;
  bit?: number;
  tick: string;
  orderAtTick?: number;
  initialSample?: true;
}) {
  return (
    signal +
    ":" +
    (bit ?? "*") +
    "@" +
    tick +
    ":" +
    (initialSample ? "initial" : (orderAtTick ?? 1))
  );
}
type Truth = 0 | 1 | "x";

function evaluateGuard(
  expr: GuardExpression,
  read: (signal: number) => TraceOperand | undefined,
): Truth | undefined {
  switch (expr.op) {
    case "signal": {
      const operand = read(expr.args);
      return operand?.sampledRange ? undefined : truth(operand?.bits);
    }
    case "value":
      return truth(evaluateTraceValue(expr.args, undefined, read)?.bits);
    case "not": {
      const value = evaluateGuard(expr.args, read);
      return value === 0 ? 1 : value === 1 ? 0 : value;
    }
    case "and":
    case "or": {
      const left = evaluateGuard(expr.args[0], read);
      const right = evaluateGuard(expr.args[1], read);
      const decisive = expr.op === "and" ? 0 : 1;
      if (left === decisive || right === decisive) return decisive;
      if (left === undefined || right === undefined) return undefined;
      if (left === "x" || right === "x") return "x";
      return left;
    }
  }
}

// Negation preserves the bits read by a guard. A logical operation on the
// value requests its truth dependencies even when the value is a packed bus.
function guardReadExpression(guard: GuardExpression): AssignmentValue {
  switch (guard.op) {
    case "not":
      return guardReadExpression(guard.args);
    case "and":
    case "or":
      return {
        op: "binary",
        args: [
          guard.op,
          guardReadExpression(guard.args[0]),
          guardReadExpression(guard.args[1]),
        ],
      };
    case "value":
    case "signal":
      return {
        op: "binary",
        args: [
          "or",
          guard.op === "signal"
            ? { op: "signal", args: guard.args }
            : guard.args,
          { op: "literal", args: ["0", false] },
        ],
      };
  }
}

function firstSampleAtOrAfter(history: Observation["history"], tick: string) {
  const cutoff = BigInt(tick);
  let first = 0;
  let end = history.length;
  while (first < end) {
    const middle = first + Math.floor((end - first) / 2);
    if (BigInt(history[middle].tick) < cutoff) first = middle + 1;
    else end = middle;
  }
  return first;
}

function previousValue(observation: Observation, tick: string) {
  const index = firstSampleAtOrAfter(observation.history, tick);
  const previous = observation.history[index - 1];
  return previous ? previous.value : observation.initial?.value;
}

function valueAtStableTick(observation: Observation | undefined, tick: string) {
  if (!observation || observation.historyTruncated) return undefined;
  const { history, initial } = observation;
  const index = firstSampleAtOrAfter(history, tick);
  const before = index === 0 ? initial?.value : history[index - 1].value;
  if (before === undefined) return undefined;
  for (let cursor = index; history[cursor]?.tick === tick; cursor++)
    if (history[cursor].value !== before) return undefined;
  return before;
}

function stableOperand(observation: Observation | undefined, tick: string) {
  if (!observation || observation.projected || observation.real)
    return undefined;
  if (observation.partialRange)
    return {
      width:
        Math.abs(observation.partialRange[0] - observation.partialRange[1]) + 1,
      signed: observation.signed,
      range: observation.partialRange,
      sampledRange: observation.range,
      bits:
        observation.range &&
        observedBits(valueAtStableTick(observation, tick), observation),
    };
  return {
    width: observation.width,
    signed: observation.signed,
    range: observation.range,
    bits: valueAtStableTick(observation, tick),
  };
}

function observedBits(value: string | undefined, observation: Observation) {
  return observation.real ? undefined : normalizeBits(value, observation.width);
}

function truth(bits: string | undefined): Truth | undefined {
  if (!bits || !/^[01xz]+$/i.test(bits)) return undefined;
  return bits.includes("1") ? 1 : /[xz]/i.test(bits) ? "x" : 0;
}

function resolveTargetIndex(
  expression: VideTrace["assignments"][number]["targetIndex"],
  root: Observation,
  read: (id: number) => TraceOperand | undefined,
  part?: VideTrace["assignments"][number]["targetIndexedPart"],
) {
  if (!expression) return undefined;
  const range = root.partialRange ?? root.range;
  if (
    !range ||
    (root.projected
      ? root.bit === undefined
      : Math.abs(range[0] - range[1]) + 1 !== root.width)
  )
    return { status: "unresolved" as const };
  const result = evaluateTraceValue(expression, undefined, read);
  const value = result && traceInteger(result.bits, result.signed);
  if (value === undefined) return { status: "unresolved" as const };
  const index = value.toString();
  const delta = BigInt((part?.width ?? 1) - 1);
  const low = part && !part.ascendingIndices ? value - delta : value;
  const high = part?.ascendingIndices ? value + delta : value;
  if (high < BigInt(Math.min(...range)) || low > BigInt(Math.max(...range)))
    return { status: "outOfRange" as const, index };
  if (low < BigInt(Math.min(...range)) || high > BigInt(Math.max(...range)))
    return { status: "unresolved" as const };
  if (
    root.bit !== undefined &&
    (BigInt(root.bit) < low || BigInt(root.bit) > high)
  )
    return { status: "differentBit" as const, index };
  const targetRange: [number, number] =
    range[0] <= range[1]
      ? [Number(low), Number(high)]
      : [Number(high), Number(low)];
  return {
    status: "selected" as const,
    index,
    inputs: result.inputs,
    ...(part ? { targetRange } : {}),
  };
}

function compareAssignmentValue(
  assignment: VideTrace["assignments"][number],
  root: Observation,
  change: Observation["history"][number],
  read: (id: number) => TraceOperand | undefined,
  targetRange = assignment.targetRange,
  indexInputs: number[] = [],
) {
  const expression = assignment.value;
  if (
    !expression ||
    (root.projected ? root.bit === undefined : root.partialRange)
  )
    return undefined;
  const evaluatedRange = targetRange ?? root.partialRange ?? root.range;
  const wholeValue = observedBits(change.value, root);
  const observed =
    wholeValue &&
    (!root.projected && targetRange
      ? sliceTraceBits(wholeValue, root.range, ...targetRange)
      : wholeValue);
  if (!observed) return undefined;
  const expectedWidth =
    root.projected && evaluatedRange
      ? Math.abs(evaluatedRange[0] - evaluatedRange[1]) + 1
      : observed.length;
  const evaluated = evaluateTraceValue(expression, expectedWidth, read);
  if (!evaluated) return undefined;
  const { bits, inputs } = evaluated;
  const expected =
    root.bit === undefined
      ? bits
      : sliceTraceBits(bits, evaluatedRange, root.bit, root.bit);
  if (!expected) return undefined;
  const prior =
    !root.projected && targetRange && !root.historyTruncated
      ? observedBits(previousValue(root, change.tick), root)
      : undefined;
  const previousSlice =
    prior && targetRange && sliceTraceBits(prior, root.range, ...targetRange);
  return {
    expected,
    observed,
    match: expected === observed,
    inputs: [...new Set([...indexInputs, ...inputs])],
    targetRange,
    targetChanged:
      previousSlice === undefined ? undefined : previousSlice !== observed,
  };
}

function compareSampleCombinations(
  assignment: VideTrace["assignments"][number],
  observations: ReadonlyMap<number, Observation>,
  tick: string,
  compare: (
    read: (signal: number) => TraceOperand | undefined,
  ) => { match: boolean; inputs: number[] } | undefined,
  evidence: "procedural" | "recorded" | "continuous" = "procedural",
  samplesBeforeOutput?: (signal: number) => readonly string[] | undefined,
) {
  const alternatives: {
    signal: number;
    values: Set<string>;
    matching: Set<string>;
  }[] = [];
  const matchingCombinations: { signal: number; bits: string }[][] = [];
  const orderedStableSamples = new Map<number, string>();
  let combinations = 1;
  const inputs = new Set(
    assignment.inputs
      .filter(({ kind }) => kind === "data")
      .map(({ signal }) => signal),
  );
  for (const signal of inputs) {
    const observation = observations.get(signal);
    if (!observation) {
      if (evidence !== "procedural") return;
      continue;
    }
    const samples = observation.history.filter(
      (sample) => sample.tick === tick,
    );
    if (!samples.length && evidence === "procedural") continue;
    if (
      observation.projected ||
      observation.partialRange ||
      observation.historyTruncated
    )
      return;
    const before = observedBits(previousValue(observation, tick), observation);
    if (
      before === undefined ||
      (evidence === "recorded" && !/^[01]+$/.test(before))
    )
      return;
    const orderedSamples = samplesBeforeOutput?.(signal);
    const values = new Set([before]);
    for (const sample of samples) {
      const bits = observedBits(sample.value, observation);
      if (
        bits === undefined ||
        (evidence === "recorded" && !/^[01]+$/.test(bits))
      )
        return;
      if (!orderedSamples || orderedSamples.includes(bits)) values.add(bits);
    }
    if (values.size < 2) {
      if (orderedSamples) orderedStableSamples.set(signal, before);
      continue;
    }
    combinations *= values.size;
    if (combinations > 32) return;
    alternatives.push({ signal, values, matching: new Set() });
  }
  if (!alternatives.length) return;

  const sampled = new Map<number, string>();
  const read = (signal: number) => {
    const operand = stableOperand(observations.get(signal), tick);
    if (!operand) return;
    return {
      ...operand,
      bits:
        sampled.get(signal) ?? orderedStableSamples.get(signal) ?? operand.bits,
    };
  };
  function visit(index: number): boolean {
    const alternative = alternatives[index];
    if (alternative) {
      for (const bits of alternative.values) {
        sampled.set(alternative.signal, bits);
        if (!visit(index + 1)) return false;
      }
      return true;
    }
    const comparison = compare(read);
    if (!comparison) return false;
    if (comparison.match) {
      if (evidence !== "procedural")
        matchingCombinations.push(
          alternatives.map(({ signal }) => ({
            signal,
            bits: sampled.get(signal)!,
          })),
        );
      for (const { signal, values, matching } of alternatives) {
        if (comparison.inputs.includes(signal))
          matching.add(sampled.get(signal)!);
        else for (const bits of values) matching.add(bits);
      }
    }
    return true;
  }
  if (!visit(0)) return;
  return {
    samples: alternatives.map(({ signal, values, matching }) => ({
      signal,
      values: [...values].map((bits) => ({ bits, match: matching.has(bits) })),
    })),
    matchingCombinations,
  };
}

function samplesMatchingRecordedRhs(
  assignment: VideTrace["assignments"][number],
  observations: ReadonlyMap<number, Observation>,
  evaluation: RecordedWriter["evaluation"],
  signalNames: ReadonlyMap<number, VideTrace["signals"][number]>,
) {
  const value = evaluation?.value;
  const expression = assignment.value;
  if (
    !evaluation ||
    !value ||
    !/^[01]+$/.test(value) ||
    !expression ||
    (assignment.hasUnresolvedOperands && !assignment.unresolvedControlOnly)
  )
    return;
  const result = compareSampleCombinations(
    assignment,
    observations,
    evaluation.tick,
    (read) => {
      const computed = evaluateTraceValue(expression, value.length, read);
      if (!computed) return;
      const matchesOperands = computed.inputs.every((id) => {
        const captured = recordedOperandValue(
          evaluation,
          assignment.instance,
          signalNames.get(id),
        );
        return captured === undefined || read(id)?.bits === captured;
      });
      return {
        match: computed.bits === value && matchesOperands,
        inputs: computed.inputs,
      };
    },
    "recorded",
  );
  if (result?.matchingCombinations.length) return result;
}

function recordedOperandValue(
  evaluation: RecordedWriter["evaluation"],
  instance: string | undefined,
  signal: VideTrace["signals"][number] | undefined,
) {
  const values = evaluation?.operandValues;
  return values &&
    signal &&
    signal.instance === instance &&
    Object.hasOwn(values, signal.name)
    ? values[signal.name].toLowerCase()
    : undefined;
}

type AssignmentGuard = NonNullable<
  VideTrace["assignments"][number]["guards"]
>[number];

function readsGuard(input: TemporalInput, guard: AssignmentGuard) {
  const { start, end } = guard.location.range;
  const { line, character } = input.location.range.start;
  return (
    input.location.uri === guard.location.uri &&
    !!end &&
    (line > start.line ||
      (line === start.line && character >= start.character)) &&
    (line < end.line || (line === end.line && character < end.character))
  );
}

function guardSampleKey(guard: AssignmentGuard, operand: string) {
  const { line, character } = guard.location.range.start;
  return (
    "g" +
    (line + 1) +
    "_" +
    (character + 1) +
    (guard.takenWhenTrue ? "_" : "f_") +
    operand
  );
}

function recordedBranchValue(
  evaluation: RecordedWriter["evaluation"],
  assignment: VideTrace["assignments"][number],
  input: VideTrace["assignments"][number]["inputs"][number],
  signal: VideTrace["signals"][number] | undefined,
) {
  const values = evaluation?.guardEntryValues;
  if (!values || !signal || signal.instance !== assignment.instance)
    return undefined;
  const { line, character } = input.location.range.start;
  for (const condition of [
    ...(assignment.waitEntries ?? []),
    ...(assignment.standaloneWaitEntries ?? []),
  ]) {
    const { start, end } = condition.range;
    if (
      condition.uri !== input.location.uri ||
      !end ||
      line < start.line ||
      line > end.line ||
      (line === start.line && character < start.character) ||
      (line === end.line && character >= end.character)
    )
      continue;
    const suffix =
      start.line + 1 + "_" + (start.character + 1) + "_" + signal.name;
    for (const prefix of ["w", "p"]) {
      const key = prefix + suffix;
      const value = values[key];
      const tick = evaluation!.guardEntryTicks?.[key];
      // An operand of a resumed compound predicate may be false or unknown.
      if (
        tick !== undefined &&
        value !== undefined &&
        (prefix === "p" || value.includes("1"))
      )
        return { value: value.toLowerCase(), tick, wait: true };
    }
  }
  for (const { selector, defaultBranch } of assignment.caseEntries ?? []) {
    const start = selector.range.start;
    if (
      selector.uri === input.location.uri &&
      start.line === line &&
      start.character === character
    ) {
      const key =
        "c" +
        (line + 1) +
        "_" +
        (character + 1) +
        (defaultBranch ? "d_" : "_") +
        signal.name;
      if (Object.hasOwn(values, key))
        return {
          value: values[key].toLowerCase(),
          tick: evaluation!.guardEntryTicks?.[key],
        };
    }
  }
  for (const guard of assignment.guards ?? []) {
    if (!readsGuard(input, guard)) continue;
    const key = guardSampleKey(guard, signal.name);
    if (Object.hasOwn(values, key))
      return {
        value: values[key].toLowerCase(),
        tick: evaluation!.guardEntryTicks?.[key],
        nextOrdinal: evaluation!.guardEntryNextOrdinals?.[key],
        guardStart: guard.location.range.start,
      };
  }
}

type RecordedChange = {
  tick: string;
  value: string;
  prior?: string;
  orderAtTick?: number;
  initialSample?: true;
};

function recordedChanges(observation: Observation, atSimulationStart: boolean) {
  const groups: { tick: bigint; changes: RecordedChange[] }[] = [];
  if (observation.historyTruncated) return groups;
  let previous = observation.initial?.value;
  for (const event of observation.history) {
    if (
      previous !== undefined &&
      event.value !== undefined &&
      previous !== event.value
    ) {
      const tick = BigInt(event.tick);
      let group = groups.at(-1);
      if (!group || group.tick !== tick) {
        group = { tick, changes: [] };
        groups.push(group);
      }
      const first = group.changes[0];
      if (first) first.orderAtTick = 1;
      group.changes.push({
        tick: event.tick,
        value: event.value,
        prior: previous,
        orderAtTick: first ? group.changes.length + 1 : undefined,
      });
    }
    previous = event.value;
  }
  const first = observation.history[0];
  if (
    atSimulationStart &&
    !observation.initial &&
    first?.tick === "0" &&
    first.value !== undefined &&
    groups[0]?.tick !== 0n
  ) {
    groups.unshift({
      tick: 0n,
      changes: [{ tick: first.tick, value: first.value, initialSample: true }],
    });
  }
  return groups;
}

function changesAtOrBefore(
  groups: ReturnType<typeof recordedChanges>,
  cutoff: bigint,
) {
  let first = 0;
  let end = groups.length;
  while (first < end) {
    const middle = first + Math.floor((end - first) / 2);
    if (groups[middle].tick <= cutoff) first = middle + 1;
    else end = middle;
  }
  return groups[first - 1]?.changes ?? [];
}

export type RecordedValueCallbacks = (
  signal: number,
  tick: string,
) => readonly { ordinal: number; value: string }[] | undefined;

function orderedContinuousCause(
  assignment: VideTrace["assignments"][number],
  output: Observation,
  change: RecordedChange,
  observations: ReadonlyMap<number, Observation>,
  callbacks: RecordedValueCallbacks,
  targetOrdinal: number,
  previousOutput?: { ordinal: number; value: string },
) {
  const beforeOutput =
    previousOutput?.value ?? previousValue(output, change.tick);
  if (beforeOutput === undefined) return;
  const inputs = new Set(
    assignment.inputs
      .filter(({ kind }) => kind === "data")
      .map(({ signal }) => signal),
  );
  const samples = new Map<number, TraceOperand>();
  const ordered: { signal: number; ordinal: number; bits: string }[] = [];
  const ordinals = new Set([targetOrdinal, previousOutput?.ordinal]);
  for (const signal of inputs) {
    const input = observations.get(signal);
    const recorded = callbacks(signal, change.tick);
    if (!input || !recorded) return;
    const bits = observedBits(previousValue(input, change.tick), input);
    if (bits === undefined) return;
    samples.set(signal, {
      bits,
      width: input.width,
      signed: input.signed,
      range: input.range,
    });
    for (const { ordinal, value } of recorded) {
      if (ordinals.has(ordinal)) return;
      if (ordinal > targetOrdinal) break;
      const bits = observedBits(value, input);
      if (bits === undefined || ordered.length >= 128) return;
      ordinals.add(ordinal);
      ordered.push({ signal, ordinal, bits });
    }
  }

  ordered.sort((a, b) => a.ordinal - b.ordinal);
  const apply = ({ signal, bits }: (typeof ordered)[number]) => {
    samples.get(signal)!.bits = bits;
  };
  // A second output transition in this slot starts at the preceding verified
  // output callback. Reconstruct that snapshot before attributing the change.
  let start = 0;
  while (
    start < ordered.length &&
    ordered[start].ordinal < (previousOutput?.ordinal ?? 0)
  )
    apply(ordered[start++]);
  const read = (signal: number) => samples.get(signal);
  const before = compareAssignmentValue(
    assignment,
    output,
    { tick: change.tick, value: beforeOutput },
    read,
  );
  const after = compareAssignmentValue(assignment, output, change, read);
  if (!before?.match || !after || after.match) return;

  let cause: (typeof ordered)[number] | undefined;
  for (let index = start; index < ordered.length; index++) {
    const update = ordered[index];
    apply(update);
    const sample = compareAssignmentValue(assignment, output, change, read);
    if (!sample || (cause && !sample.match)) return;
    if (sample.match) cause ??= update;
  }
  return cause;
}

type WaitCause = Pick<
  TemporalEdgeEvidence,
  "waitResumeCause" | "waitResumeCallbackOrdinal"
>;

type WaitTransition = { evidence: WaitCause; orderAtTick?: number };

function orderedWaitCause(
  expression: GuardExpression,
  before: ReadonlyMap<number, TraceOperand>,
  resumed: ReadonlyMap<number, TraceOperand>,
  changes: ReadonlyMap<number, readonly RecordedChange[]>,
  tick: string,
  evaluation: NonNullable<RecordedWriter["evaluation"]>,
  callbacks: RecordedValueCallbacks,
  resumeNextOrdinal?: number,
) {
  const ordered: {
    signal: number;
    ordinal: number;
    operand: TraceOperand;
    orderAtTick?: number;
  }[] = [];
  const ordinals = new Set<number>();
  for (const [signal, operand] of resumed) {
    const recorded = callbacks(signal, tick);
    const observed = changes.get(signal) ?? [];
    if (!recorded || recorded.length !== observed.length) return;
    if (ordered.length + recorded.length > 128) return;
    for (const [index, { ordinal, value }] of recorded.entries()) {
      const change = observed[index];
      const bits = normalizeBits(value, operand.width);
      if (
        bits === undefined ||
        bits !== normalizeBits(change.value, operand.width) ||
        ordinals.has(ordinal) ||
        (index > 0 && ordinal <= recorded[index - 1].ordinal) ||
        (resumeNextOrdinal === undefined &&
          tick === evaluation.tick &&
          ordinal >= evaluation.ordinal)
      )
        return;
      ordinals.add(ordinal);
      ordered.push({
        signal,
        ordinal,
        operand: { ...operand, bits },
        orderAtTick: change.orderAtTick,
      });
    }
  }
  const samples = new Map(before);
  let cause: (typeof ordered)[number] | undefined;
  for (const change of ordered.sort((a, b) => a.ordinal - b.ordinal)) {
    if (resumeNextOrdinal !== undefined && change.ordinal >= resumeNextOrdinal)
      break;
    samples.set(change.signal, change.operand);
    const result = evaluateGuard(expression, (id) => samples.get(id));
    if (result === undefined) return;
    if (result === 1) cause ??= change;
    else if (cause) {
      if (resumeNextOrdinal === undefined) return;
      cause = undefined;
    }
  }
  if (
    [...resumed].some(([id, operand]) => samples.get(id)?.bits !== operand.bits)
  )
    return;
  return cause;
}

function observedWaitCauses(
  assignment: VideTrace["assignments"][number],
  evaluation: RecordedWriter["evaluation"],
  signals: ReadonlyMap<number, VideTrace["signals"][number]>,
  observations: ReadonlyMap<number, Observation>,
  historyStart: bigint,
  observed: (signal: number, tick: bigint) => readonly RecordedChange[],
  callbacks?: RecordedValueCallbacks,
) {
  const causes = new Map<number, Map<string, WaitTransition>>();
  const values = evaluation?.guardEntryValues;
  const ticks = evaluation?.guardEntryTicks;
  if (!values || !ticks) return causes;
  for (const { location, expression } of assignment.waitPredicates ?? []) {
    const { line, character } = location.range.start;
    const suffix = line + 1 + "_" + (character + 1) + "_";
    const sample = Object.entries(ticks).find(
      ([name]) =>
        name.startsWith("p" + suffix) || name.startsWith("w" + suffix),
    );
    if (!sample) continue;
    const [firstKey, tick] = sample;
    const prefix = firstKey[0] + suffix;
    const resumeNextOrdinal = evaluation?.guardEntryNextOrdinals?.[firstKey];
    const time = BigInt(tick);
    if (time <= historyStart) continue;
    const before = new Map<number, TraceOperand>();
    const resumed = new Map<number, TraceOperand>();
    const changes = new Map<number, readonly RecordedChange[]>();
    let complete = true;
    const result = evaluateGuard(expression, (id) => {
      if (resumed.has(id)) return resumed.get(id);
      const signal = signals.get(id);
      const observation = observations.get(id);
      const key = prefix + signal?.name;
      const sample = values[key]?.toLowerCase();
      if (
        !signal ||
        signal.instance !== assignment.instance ||
        !observation ||
        observation.projected ||
        observation.partialRange ||
        observation.historyTruncated ||
        observation.historyLimitedToTransition ||
        observation.real ||
        ticks[key] !== tick ||
        evaluation?.guardEntryNextOrdinals?.[key] !== resumeNextOrdinal ||
        sample?.length !== observation.width
      ) {
        complete = false;
        return;
      }
      const prior = observedBits(previousValue(observation, tick), observation);
      const concurrent = observed(id, time).filter(
        (change) => change.tick === tick,
      );
      if (
        prior === undefined ||
        (concurrent.length &&
          observedBits(concurrent[0].prior, observation) !== prior) ||
        (resumeNextOrdinal === undefined &&
          (concurrent.length
            ? observedBits(concurrent.at(-1)?.value, observation)
            : prior) !== sample)
      ) {
        complete = false;
        return;
      }
      if (concurrent.length) changes.set(id, concurrent);
      const operand = {
        width: observation.width,
        signed: observation.signed,
        bits: sample,
      };
      before.set(id, { ...operand, bits: prior });
      resumed.set(id, operand);
      return operand;
    });
    if (!complete || result !== 1) continue;
    const previous = evaluateGuard(expression, (id) => before.get(id));
    if (previous !== 0 && previous !== "x") continue;
    const unique = changes.size === 1 && [...changes.values()][0].length === 1;
    const ordered =
      (!unique || resumeNextOrdinal !== undefined) && callbacks && evaluation
        ? orderedWaitCause(
            expression,
            before,
            resumed,
            changes,
            tick,
            evaluation,
            callbacks,
            resumeNextOrdinal,
          )
        : undefined;
    if ((!unique || resumeNextOrdinal !== undefined) && !ordered) continue;
    const signal = ordered?.signal ?? [...changes.keys()][0];
    const resumeTicks = causes.get(signal) ?? new Map<string, WaitTransition>();
    resumeTicks.set(
      tick,
      ordered
        ? {
            evidence: {
              waitResumeCause: "orderedCallbacks",
              waitResumeCallbackOrdinal: ordered.ordinal,
            },
            orderAtTick: ordered.orderAtTick,
          }
        : { evidence: { waitResumeCause: "uniqueObservedTransition" } },
    );
    causes.set(signal, resumeTicks);
  }
  return causes;
}

function matchesEdge(prior: string, next: string, edge: string | null) {
  const before = prior.toLowerCase();
  const after = next.toLowerCase();
  if (edge === "change" || edge === null) return before !== after;
  if (!/^[01xz]$/.test(before) || !/^[01xz]$/.test(after)) return null;
  const rising = before !== after && (before === "0" || after === "1");
  const falling = before !== after && (before === "1" || after === "0");
  if (edge === "rising") return rising;
  if (edge === "falling") return falling;
  return rising || falling;
}

function observeTrigger(
  input: TemporalInput,
  observation: Observation | undefined,
  tick: string,
) {
  const events = observation?.history.filter((event) => event.tick === tick);
  let prior = observation && previousValue(observation, tick);
  let match: boolean | null = null;
  if (
    observation &&
    !observation.projected &&
    !observation.partialRange &&
    !observation.historyTruncated &&
    events
  ) {
    match = prior === undefined ? null : false;
    for (const { value } of events) {
      const edge =
        prior === undefined || value === undefined
          ? null
          : matchesEdge(prior, value, input.edge);
      if (edge === true) {
        match = true;
        break;
      }
      if (edge === null) match = null;
      prior = value;
    }
  }
  return {
    signal: input.signal,
    edge: input.edge,
    match,
    multipleSamplesAtTick:
      (events?.length ?? 0) > 1 ? (true as const) : undefined,
  };
}

function fullObservations(evidence: Evidence, trace: VideTrace) {
  const observations = new Map<number, Observation>(
    evidence.observations.map((signal) => [signal.signal, signal]),
  );
  if (evidence.wholeRoot)
    observations.set(evidence.wholeRoot.signal, evidence.wholeRoot);
  // These source literals are stable operands, independent of the dump window.
  for (const signal of trace.signals ?? []) {
    const { id } = signal;
    const observation = observations.get(id);
    const declared = signal.packedRange;
    if (
      observation &&
      !observation.real &&
      declared?.length === 2 &&
      declared.every(Number.isSafeInteger)
    ) {
      const [left, right] = declared;
      const range = observation.range;
      if (
        Math.abs(left - right) + 1 !==
          (observation.projected && range
            ? Math.abs(range[0] - range[1]) + 1
            : observation.width) ||
        (range && (range[0] !== left || range[1] !== right))
      )
        observations.set(id, { ...observation, partialRange: declared });
    }
    const constant =
      signal.enumValue ??
      signal.packageParameterValue ??
      signal.instanceParameterValue ??
      signal.parameterValue;
    if (!constant || observations.has(id)) continue;
    const { bits, signed } = constant;
    const initial = { tick: evidence.historyStart, value: bits };
    observations.set(id, {
      signal: id,
      value: bits,
      width: bits.length,
      signed,
      initial,
      history: [],
      historyTruncated: false,
      projected: false,
      status: "observed",
      cursorSamples: { initial, events: [], truncated: false },
    } as Observation);
  }
  return observations;
}

export function traceAssignmentCandidates(
  trace: VideTrace,
  evidence: Evidence,
) {
  const observations = fullObservations(evidence, trace);
  const root = evidence.observations.find(
    ({ signal }) => signal === trace.root,
  );
  return candidatesAt(
    directDrivers(trace),
    observations,
    root
      ? changesAtOrBefore(
          recordedChanges(root, evidence.historyStart === "0"),
          BigInt(evidence.tick),
        )
      : [],
    root && {
      ...root,
      partialRange: observations.get(trace.root)?.partialRange,
    },
    trace.signals?.find(({ id }) => id === trace.root)?.selectedElement,
  );
}

function directDrivers(trace: VideTrace) {
  return trace.assignments.flatMap((assignment, id) =>
    assignment.targets.includes(trace.root) ? [{ id, assignment }] : [],
  );
}

function candidatesAt(
  drivers: readonly IndexedAssignment[],
  observations: ReadonlyMap<number, Observation>,
  changes: readonly RecordedChange[],
  root?: Observation,
  selectedElement?: number,
) {
  const change = changes.at(-1);
  if (!root || !change)
    return { status: "noObservedChange" as const, candidates: [] };
  const multipleChangesAtTick = changes.length > 1;
  const point = { tick: change.tick, value: change.value };
  return {
    status: change.initialSample
      ? ("initialSample" as const)
      : ("observedChange" as const),
    change: point,
    multipleChangesAtTick,
    changesAtTick: multipleChangesAtTick
      ? changes.map(({ tick, value, orderAtTick }) => ({
          tick,
          value,
          orderAtTick,
        }))
      : undefined,
    candidates: evaluateCandidates(
      drivers,
      observations,
      root,
      point,
      multipleChangesAtTick,
      selectedElement,
    ),
  };
}

function evaluateCandidates(
  drivers: readonly IndexedAssignment[],
  observations: ReadonlyMap<number, Observation>,
  root: Observation,
  change: Observation["history"][number],
  multipleChangesAtTick = false,
  selectedElement?: number,
) {
  const read = (id: number) => stableOperand(observations.get(id), change.tick);
  const bit = root.bit;
  const selected =
    bit === undefined
      ? drivers
      : drivers.filter(({ assignment }) => {
          const range = assignment.targetRange;
          return (
            !range || (Math.min(...range) <= bit && bit <= Math.max(...range))
          );
        });
  return selected.map(({ assignment: original, id }) => {
    const elementExpression = original.targetElementIndex;
    const element =
      selectedElement === undefined || !elementExpression
        ? undefined
        : evaluateTraceValue(elementExpression, undefined, read);
    const elementIndex = element && traceInteger(element.bits, element.signed);
    const targetElement =
      selectedElement === undefined || !elementExpression
        ? undefined
        : elementIndex === undefined
          ? { status: "unresolved" as const }
          : {
              status:
                elementIndex === BigInt(selectedElement)
                  ? ("selected" as const)
                  : ("differentElement" as const),
              index: elementIndex.toString(),
            };
    const assignment =
      targetElement?.status === "selected" && original.elementValue
        ? { ...original, value: original.elementValue }
        : original;
    const targetIndex = resolveTargetIndex(
      assignment.targetIndex,
      root,
      read,
      assignment.targetIndexedPart,
    );
    const indexStatus = targetIndex?.status;
    const index =
      indexStatus === "selected" ? Number(targetIndex.index) : undefined;
    const targetRange: [number, number] | undefined =
      targetIndex?.status === "selected" && targetIndex.targetRange
        ? targetIndex.targetRange
        : index === undefined
          ? assignment.targetRange
          : [index, index];
    const indexExcluded =
      indexStatus === "outOfRange" ||
      indexStatus === "differentBit" ||
      targetElement?.status === "differentElement";
    const value =
      multipleChangesAtTick ||
      (indexStatus && indexStatus !== "selected") ||
      (targetElement && targetElement.status !== "selected")
        ? undefined
        : compareAssignmentValue(assignment, root, change, read, targetRange, [
            ...(targetIndex?.status === "selected" ? targetIndex.inputs : []),
            ...(element?.inputs ?? []),
          ]);
    if (assignment.kind === "continuous" || assignment.kind === "port")
      return {
        assignment: id,
        status: indexExcluded
          ? ("contradictedByObservations" as const)
          : ("possible" as const),
        location: assignment.location,
        targetIndex,
        targetElement,
        value,
        rhsSamples: undefined,
        initializationOutsideStart: undefined,
        triggers: [],
        guards: [],
      };
    if (
      assignment.kind === "force" ||
      assignment.kind === "release" ||
      assignment.kind === "proceduralAssign" ||
      assignment.kind === "deassign" ||
      assignment.kind === "subroutineCall"
    )
      return {
        assignment: id,
        status: "possible" as const,
        location: assignment.location,
        targetIndex,
        targetElement,
        rhsSamples: undefined,
        initializationOutsideStart: undefined,
        triggers: [],
        guards: [],
      };
    const triggerEvidence = assignment.inputs
      .filter(({ kind }) => kind === "trigger")
      .map((input) =>
        observeTrigger(input, observations.get(input.signal), change.tick),
      );
    const guards = (assignment.guards ?? []).map((guard) => {
      const value = guard.expression && evaluateGuard(guard.expression, read);
      return {
        location: guard.location,
        expected: guard.takenWhenTrue,
        value: value ?? null,
        match: value == null ? null : (value === 1) === guard.takenWhenTrue,
      };
    });
    const hasTrigger = triggerEvidence.some(
      (trigger) => trigger.match === true,
    );
    const triggerOrderAmbiguous = triggerEvidence.some(
      ({ match, multipleSamplesAtTick }) =>
        match === true && multipleSamplesAtTick,
    );
    const guardsMatch = guards.every((guard) => guard.match === true);
    const initializationOutsideStart =
      assignment.kind === "initialization" &&
      assignment.initializationAtStart &&
      BigInt(change.tick) !== 0n;
    const contradicted =
      indexExcluded ||
      initializationOutsideStart ||
      (!assignment.hasUnresolvedOperands &&
        (guards.some((guard) => guard.match === false) ||
          (triggerEvidence.length > 0 &&
            triggerEvidence.every((trigger) => trigger.match === false))));
    const status = contradicted
      ? "contradictedByObservations"
      : !multipleChangesAtTick &&
          !triggerOrderAmbiguous &&
          indexStatus !== "unresolved" &&
          targetElement?.status !== "unresolved" &&
          hasTrigger &&
          guardsMatch &&
          !assignment.hasUnresolvedOperands &&
          value?.match !== false
        ? "consistentWithObservations"
        : "possible";
    const rhsSamples =
      !value &&
      status === "consistentWithObservations" &&
      assignment.kind === "nonblocking" &&
      assignment.value &&
      assignment.targets.length === 1 &&
      !assignment.targetIndex
        ? compareSampleCombinations(
            assignment,
            observations,
            change.tick,
            (read) => compareAssignmentValue(assignment, root, change, read),
          )?.samples
        : undefined;
    return {
      assignment: id,
      status,
      location: assignment.location,
      targetIndex,
      targetElement,
      value,
      initializationOutsideStart: initializationOutsideStart || undefined,
      rhsSamples,
      triggers: triggerEvidence,
      guards,
    };
  });
}

export function traceCursorWriters(trace: VideTrace, evidence: Evidence) {
  const root = evidence.observations.find(
    ({ signal }) => signal === trace.root,
  );
  const samples = root?.cursorSamples;
  if (
    !root ||
    samples?.truncated !== false ||
    root.value === undefined ||
    samples.initial?.value !== root.value
  )
    return undefined;
  if (samples.events.some(({ value }) => value !== root.value))
    return undefined;
  const observations = new Map(
    [...fullObservations(evidence, trace).values()].map((item) => [
      item.signal,
      {
        ...item,
        initial: item.cursorSamples?.initial,
        history: item.cursorSamples?.events ?? [],
        historyTruncated: item.cursorSamples?.truncated ?? true,
      },
    ]),
  );
  const candidates = evaluateCandidates(
    directDrivers(trace),
    observations,
    { ...root, partialRange: observations.get(trace.root)?.partialRange },
    {
      tick: evidence.tick,
      value: root.value,
    },
    false,
    trace.signals?.find(({ id }) => id === trace.root)?.selectedElement,
  );
  const candidateStatus =
    !candidates.length ||
    trace.frontier.some(({ signal }) => signal === trace.root)
      ? "incomplete"
      : candidates.every(
            ({ status }) => status === "contradictedByObservations",
          )
        ? "writersExcluded"
        : candidates.some(
              ({ status, value }) =>
                status !== "contradictedByObservations" && value?.match,
            )
          ? "sameValueWritePossible"
          : "inconclusive";
  return {
    tick: evidence.tick,
    value: root.value,
    candidateStatus,
    candidates,
  };
}

export type TemporalLimits = {
  nodes?: number;
  edges?: number;
  gaps?: number;
  changeOrder?: number;
};

export function buildTemporalTrace(
  trace: VideTrace,
  evidence: Evidence & {
    bindingIssues?: ReadonlyMap<number, TraceBindingIssue>;
    externalPliCallbacks?: boolean;
    recordedValueCallbacks?: RecordedValueCallbacks;
  },
  recordedWriters?: ReadonlyMap<
    string,
    RecordedWriter | RecordedWordAttribution
  >,
  expandReachable = false,
  operandHistory?: RecordedOperandHistory,
  limits?: TemporalLimits,
  words: readonly ObservedTraceWord[] = [],
  fields: readonly RecordedTraceField[] = [],
  cursorWrite?: RecordedCursorWrite,
  modportComponents?: ReadonlyMap<string, RecordedModportComponent>,
) {
  const observations = fullObservations(evidence, trace);
  const signalNames = new Map(
    (trace.signals ?? []).map((signal) => [signal.id, signal]),
  );
  const parameters = new Map(
    (trace.signals ?? []).flatMap(({ id, parameterValue }) =>
      parameterValue ? [[id, parameterValue] as const] : [],
    ),
  );
  const rootView = evidence.observations.find(
    ({ signal }) => signal === trace.root,
  );
  const span = (id: number) => {
    const item = observations.get(id);
    if (!item || item.projected || item.real) return undefined;
    if (item.partialRange) return item.partialRange;
    if (
      item.range &&
      Math.abs(item.range[0] - item.range[1]) + 1 === item.width
    )
      return item.range;
    return item.width === 1 ? ([0, 0] as const) : undefined;
  };
  const dependencies = packedDependencies(
    span,
    (id) => observations.get(id)?.signed,
  );
  const selectionKey = (signal: number, bit?: number) =>
    signal + ":" + (bit ?? "*");
  const views = new Map<string, Observation>();
  function view(signal: number, bit?: number): Observation | undefined {
    if (signal === trace.root && rootView?.bit === bit && rootView?.projected)
      return rootView;
    const whole = observations.get(signal);
    if (!whole || bit === undefined || whole.projected) return whole;
    const key = selectionKey(signal, bit);
    const existing = views.get(key);
    if (existing) return existing;
    const project = (bits?: string) => {
      const normalized = observedBits(bits, whole);
      return (
        normalized &&
        sliceTraceBits(
          normalized,
          whole.range ?? (whole.partialRange ? undefined : span(signal)),
          bit,
          bit,
        )
      );
    };
    const sample = ({ tick, value }: Observation["history"][number]) => ({
      tick,
      value: project(value),
    });
    const result = {
      ...whole,
      bit,
      projected: true,
      width: 1,
      value: project(whole.value),
      initial: whole.initial && sample(whole.initial),
      history: whole.history.map(sample),
    };
    views.set(key, result);
    return result;
  }
  const byTarget = new Map<number, IndexedAssignment[]>();
  trace.assignments.forEach((assignment, id) => {
    const entry = { id, assignment };
    for (const target of new Set(assignment.targets)) {
      const entries = byTarget.get(target) ?? [];
      entries.push(entry);
      byTarget.set(target, entries);
    }
  });
  const incompleteDrivers = new Set(
    (trace.frontier ?? []).map(({ signal }) => signal),
  );
  const staticStops = new Map<number, VideTrace["frontier"]>();
  for (const stop of trace.frontier ?? []) {
    if (!isStaticBudgetStop(stop.reason) || stop.continuation === null)
      continue;
    const stops = staticStops.get(stop.signal) ?? [];
    stops.push(stop);
    staticStops.set(stop.signal, stops);
  }
  const wordsByAddress = new Map(
    words.map((word) => [word.array + ":" + word.index, word]),
  );
  const fieldsByName = new Map(
    fields.map((field) => [field.signal + ":" + field.field, field]),
  );
  const recordedFieldIds = new Set(fields.map(({ id }) => id));
  for (const word of words) {
    byTarget.set(word.id, byTarget.get(word.array) ?? []);
  }
  if (fields.length) {
    const fieldsByBase = new Map<number, RecordedTraceField[]>();
    for (const field of fields) {
      const group = fieldsByBase.get(field.signal) ?? [];
      group.push(field);
      fieldsByBase.set(field.signal, group);
    }
    for (const { id, target, source } of packedStructPorts(trace)) {
      for (const field of fieldsByBase.get(target) ?? []) {
        const upstream = fieldsByName.get(source + ":" + field.field);
        if (
          !upstream ||
          observations.get(upstream.id)?.width !==
            observations.get(field.id)?.width
        )
          continue;
        const port = trace.assignments[id];
        const entries = byTarget.get(field.id) ?? [];
        entries.push({
          id,
          assignment: {
            ...port,
            targets: [field.id],
            inputs: [{ ...port.inputs[0], signal: upstream.id }],
          },
        });
        byTarget.set(field.id, entries);
      }
    }
    trace.assignments.forEach((assignment, id) => {
      const selected = assignment.targetField;
      if (selected) {
        const target = fieldsByName.get(selected.signal + ":" + selected.field);
        if (target) {
          const entries = byTarget.get(target.id) ?? [];
          entries.push({
            id,
            assignment: {
              ...assignment,
              targets: [target.id],
              value: assignment.fieldValue,
            },
          });
          byTarget.set(target.id, entries);
        }
        return;
      }
      const field = assignment.port?.toField;
      if (
        !field ||
        assignment.targets.length !== 1 ||
        assignment.inputs.length !== 1 ||
        assignment.port?.conversion
      )
        return;
      const target = fieldsByName.get(assignment.targets[0] + ":" + field);
      if (!target) return;
      const entries = byTarget.get(target.id) ?? [];
      entries.push({ id, assignment: { ...assignment, targets: [target.id] } });
      byTarget.set(target.id, entries);
    });
  }
  const nodes: {
    signal: number;
    bit?: number;
    compatibleModportComponent?: Omit<RecordedModportComponent, "assignment">;
    tick: string;
    value?: string;
    sampleOnly?: true;
    initialSample?: true;
    initializationAssignments?: number[];
    orderAtTick?: number;
    beforeTick?: true;
    elaboratedParameter?: true;
    enumConstant?: true;
    packageParameter?: true;
    recordedWriter?: RecordedWriter;
    recordedWordWriters?: RecordedWordWriter[];
    recordedWordUnresolved?: [number, number][];
    operandEvaluationOrdinal?: number;
    branchEntrySample?: true;
    waitResumeSample?: true;
    executionOnly?: true;
    sameValueWrite?: true;
    recordedRhsCombinations?: { signal: number; bits: string }[][];
    valueChangeOrdinal?: number;
    restoredFromCallbacks?: true;
    recordedWordChanges?: { ordinal: number; value: string }[];
    recordedTaskTransfer?: RecordedTaskTransfer;
  }[] = [];
  const edges: (TemporalEdgeEvidence & {
    source: number;
    target: number;
    assignment: number;
    alsoAssignments?: number[];
  })[] = [];
  const wordReads: {
    signal: number;
    index: string;
    tick: string;
    target: number;
    assignment: number;
    timing?: "sameTickUnordered";
  }[] = [];
  const seenWordReads = new Set<string>();
  const byEvent = new Map<string, number>();
  const frontier = new Set<number>();
  const missing = new Map<
    string,
    { signal: number; bit?: number; reason: MissingReason }
  >();
  const maxNodes = limits?.nodes ?? (expandReachable ? 1024 : 256);
  const maxEdges = limits?.edges ?? (expandReachable ? 4096 : 1024);
  const maxGaps = limits?.gaps ?? maxEdges;
  const gaps = new Map<string, TemporalGap>();
  const retainedContinuations = new Set<string>();
  const replaceableGaps = new Set<string>();
  const anchoredBits = new Map<number, Set<number | undefined>>();
  let gapsTruncated = false;
  const recordGap = (gap: TemporalGap) => {
    const selection = selectionKey(gap.signal, gap.bit);
    if (gap.reason === "nodeBudget" || gap.reason === "edgeBudget") {
      frontier.add(gap.signal);
    } else if (
      gap.reason !== "staticBudget" &&
      gap.reason !== "selectedContinuation"
    ) {
      missing.set(selection + "/" + gap.reason, {
        signal: gap.signal,
        ...(gap.bit === undefined ? {} : { bit: gap.bit }),
        reason: gap.reason,
      });
    }
    const key = [
      selection,
      gap.tick,
      gap.value,
      gap.reason,
      gap.use?.target,
      gap.use?.assignment,
      gap.use?.kind,
      gap.use?.edge,
      gap.use?.evidence && JSON.stringify(gap.use.evidence),
      gap.sampleOnly,
      gap.initialSample,
      gap.orderAtTick,
      gap.historyCutoff,
      gap.anchor,
    ].join("/");
    if (gaps.has(key)) return;
    const continuation =
      !gap.sampleOnly &&
      (gap.historyCutoff !== undefined ||
        gap.reason === "nodeBudget" ||
        gap.reason === "edgeBudget" ||
        gap.reason === "staticBudget")
        ? JSON.stringify([
            selection,
            gap.historyCutoff ?? gap.tick,
            gap.orderAtTick,
            gap.initialSample,
            gap.historyCutoff !== undefined,
          ])
        : undefined;
    // Keep an entry for each reachable transition before repeated uses and diagnostics.
    const retainContinuation =
      continuation !== undefined && !retainedContinuations.has(continuation);
    if (gaps.size >= maxGaps) {
      gapsTruncated = true;
      const replace = retainContinuation
        ? replaceableGaps.values().next().value
        : undefined;
      if (replace === undefined) return;
      replaceableGaps.delete(replace);
      gaps.delete(replace);
    }
    gaps.set(key, gap);
    if (retainContinuation) retainedContinuations.add(continuation);
    else replaceableGaps.add(key);
  };
  const recordMissing = (
    signal: number,
    bit: number | undefined,
    tick: string,
    observation?: Observation,
    use?: TemporalGap["use"],
  ) => {
    const subject = signalNames.get(signal);
    const unavailable = subject?.enumValueUnavailable
      ? "enumValueUnavailable"
      : subject?.packageParameterValueUnavailable
        ? "packageParameterValueUnavailable"
        : subject?.instanceParameter
          ? "instanceParameterValueUnavailable"
          : undefined;
    if (!observation && unavailable) {
      recordGap({
        signal,
        bit,
        tick,
        use,
        reason: unavailable,
        declaration: subject.declaration ?? undefined,
      });
      return;
    }
    recordGap({
      signal,
      bit,
      tick,
      use,
      reason: !observation
        ? "unmapped"
        : observation.historyTruncated
          ? "truncated"
          : "noChangeInWindow",
      ...(!observation && evidence.bindingIssues?.has(signal)
        ? { bindingIssue: evidence.bindingIssues.get(signal) }
        : {}),
    });
  };
  const missingEvidence = () => [...missing.values()];
  const hasUnanchoredStaticStop = (stop: VideTrace["frontier"][number]) => {
    if (!isStaticBudgetStop(stop.reason) || stop.continuation === null)
      return true;
    const anchored = anchoredBits.get(stop.signal);
    if (!anchored) return true;
    if (anchored.has(undefined)) return false;
    const rootBit =
      stop.signal === trace.root ? trace.bitSelection?.bit : undefined;
    const bits = stop.bits?.length
      ? stop.bits
      : rootBit === undefined
        ? []
        : [rootBit];
    return !bits.length || !bits.every((bit) => anchored.has(bit));
  };
  const graph = (rootNodes: number[] = []) => {
    const reasons = [
      ...(frontier.size ? ["traversalBudget"] : []),
      ...(anchoredBits.size ? ["staticTraversalBudget"] : []),
      ...(missing.size ? ["missingObservations"] : []),
      ...(nodes.some(
        ({ recordedWordUnresolved }) => recordedWordUnresolved?.length,
      )
        ? ["arrayWordWriterUnresolved"]
        : []),
      ...(gapsTruncated ? ["gapBudget"] : []),
      ...(evidence.automaticSearchLimited ? ["historySearchLimit"] : []),
      ...(trace.frontier?.some(hasUnanchoredStaticStop) ||
      trace.assignments.some(
        ({ hasUnresolvedOperands }) => hasUnresolvedOperands,
      )
        ? ["staticFrontier"]
        : []),
      ...(trace.simulationProject?.limitations.length ||
      trace.compilation?.complete === false
        ? ["compilationInputs"]
        : []),
      ...(evidence.externalPliCallbacks ||
      trace.simulationProject?.vcsPli?.length
        ? ["externalPliCallbacks"]
        : []),
    ];
    return {
      schemaVersion: 1 as const,
      nodes,
      edges,
      feedbackEdges: temporalFeedback(nodes.length, edges),
      rootNodes: rootNodes.length > 1 ? rootNodes : undefined,
      frontier: [...frontier],
      missing: [...new Set(missingEvidence().map(({ signal }) => signal))],
      missingEvidence: missingEvidence(),
      gaps: [...gaps.values()],
      wordReads: wordReads.length ? wordReads : undefined,
      wordSignals: words.length ? words : undefined,
      recordedFieldSignals: fields.length ? fields : undefined,
      gapsTruncated: gapsTruncated || undefined,
      coverage: {
        status: reasons.length
          ? ("partial" as const)
          : ("resolvedWithinWindow" as const),
        reasons,
      },
    };
  };
  const seenEdges = new Map<string, (typeof edges)[number]>();
  const changeHistories = new Map<string, ReturnType<typeof recordedChanges>>();
  const observed = (
    signal: number,
    bit: number | undefined,
    cutoff: bigint,
  ) => {
    const key = selectionKey(signal, bit);
    let history = changeHistories.get(key);
    if (!history) {
      const observation = view(signal, bit);
      history = observation
        ? recordedChanges(observation, evidence.historyStart === "0")
        : [];
      changeHistories.set(key, history);
    }
    return changesAtOrBefore(history, cutoff);
  };
  function callbacksAt(signal: number, bit: number | undefined, tick: string) {
    const callbacks = evidence.recordedValueCallbacks?.(signal, tick);
    const whole = observations.get(signal);
    if (
      !callbacks ||
      !whole ||
      whole.projected ||
      whole.partialRange ||
      whole.historyTruncated ||
      whole.historyLimitedToTransition ||
      whole.real
    )
      return;
    const time = BigInt(tick);
    const changes = observed(signal, undefined, time).filter(
      (change) => change.tick === tick,
    );
    if (
      changes.length !== callbacks.length ||
      changes.some((change, index) => {
        const bits = observedBits(change.value, whole);
        const { ordinal, value } = callbacks[index];
        return (
          change.initialSample ||
          bits === undefined ||
          bits !== normalizeBits(value, whole.width) ||
          (index > 0 && ordinal <= callbacks[index - 1].ordinal)
        );
      })
    )
      return;
    if (bit === undefined) return callbacks;
    const range = span(signal);
    const initial = observedBits(previousValue(whole, tick), whole);
    let prior = initial && sliceTraceBits(initial, range, bit, bit);
    if (prior === undefined) return;
    return callbacks.flatMap(({ ordinal, value }) => {
      const bits = sliceTraceBits(
        normalizeBits(value, whole.width)!,
        range,
        bit,
        bit,
      );
      const changed = bits !== undefined && bits !== prior;
      prior = bits;
      return changed ? [{ ordinal, value: bits }] : [];
    });
  }
  const rootChanges = observed(
    trace.root,
    rootView?.bit,
    BigInt(evidence.tick),
  );
  const requestedChanges =
    limits?.changeOrder === undefined
      ? rootChanges
      : rootChanges.filter(
          ({ tick, orderAtTick, initialSample }) =>
            !initialSample &&
            tick === evidence.tick &&
            (orderAtTick ?? 1) === limits.changeOrder,
        );
  const selectedElements = new Map(
    trace.signals?.flatMap(({ id, selectedElement }) =>
      selectedElement === undefined ? [] : [[id, selectedElement] as const],
    ),
  );
  for (const { id, index } of words) selectedElements.set(id, Number(index));
  const root = candidatesAt(
    byTarget.get(trace.root) ?? [],
    observations,
    rootChanges,
    rootView,
    selectedElements.get(trace.root),
  );
  const heldWrite =
    limits?.changeOrder === undefined &&
    cursorWrite &&
    rootView &&
    evidence.historyStart !== undefined &&
    BigInt(cursorWrite.tick) >= BigInt(evidence.historyStart) &&
    BigInt(cursorWrite.tick) <= BigInt(evidence.historyEnd ?? evidence.tick) &&
    (!rootChanges.length ||
      BigInt(rootChanges[0].tick) < BigInt(cursorWrite.tick)) &&
    valueAtStableTick(rootView, cursorWrite.tick) === cursorWrite.value
      ? cursorWrite
      : undefined;
  if (root.status === "noObservedChange" && !heldWrite) {
    recordMissing(trace.root, rootView?.bit, evidence.tick, rootView);
    return graph();
  }
  function nodeKey(
    signal: number,
    event: Omit<(typeof nodes)[number], "signal">,
  ) {
    return (
      selectionKey(signal, event.bit) +
      "@" +
      event.tick +
      ":" +
      (event.executionOnly
        ? "commit:" + event.recordedWriter?.commitOrdinal
        : event.sampleOnly
          ? event.operandEvaluationOrdinal !== undefined
            ? (event.waitResumeSample
                ? "wait:"
                : event.branchEntrySample
                  ? "branch:"
                  : "operand:") +
              event.operandEvaluationOrdinal +
              ":" +
              event.value
            : event.beforeTick
              ? "before"
              : "sample"
          : event.initialSample
            ? "initial"
            : (event.orderAtTick ?? ""))
    );
  }
  function add(signal: number, event: Omit<(typeof nodes)[number], "signal">) {
    const key = nodeKey(signal, event);
    const existing = byEvent.get(key);
    if (existing !== undefined) return existing;
    if (nodes.length >= maxNodes) return undefined;
    const id = nodes.length;
    const { orderAtTick, beforeTick, ...sample } = event;
    nodes.push({
      signal,
      ...sample,
      ...(orderAtTick === undefined ? {} : { orderAtTick }),
      ...(beforeTick ? { beforeTick } : {}),
    });
    byEvent.set(key, id);
    return id;
  }
  const rootNodes: number[] = [];
  const historyBoundary = BigInt(evidence.historyStart ?? "0") - 1n;
  if (heldWrite) {
    rootNodes.push(
      add(trace.root, {
        tick: heldWrite.tick,
        value: heldWrite.value,
        bit: rootView?.bit,
        executionOnly: true,
        sameValueWrite: true,
        recordedWriter: heldWrite.writer,
      })!,
    );
  }
  for (const { tick, value, orderAtTick, initialSample } of heldWrite
    ? []
    : [...requestedChanges].reverse()) {
    const id = add(trace.root, {
      tick,
      value,
      orderAtTick,
      ...(initialSample ? { initialSample } : {}),
      ...(rootView?.bit === undefined ? {} : { bit: rootView.bit }),
    });
    if (id === undefined) {
      recordGap({
        signal: trace.root,
        bit: rootView?.bit,
        tick,
        value,
        reason: "nodeBudget",
        ...(initialSample ? { initialSample } : {}),
        ...(orderAtTick === undefined ? {} : { orderAtTick }),
      });
      continue;
    }
    rootNodes.push(id);
  }
  for (let target = 0; target < nodes.length; target++) {
    const event = nodes[target];
    if (event.sampleOnly) continue;
    if (
      !event.executionOnly &&
      event.value !== undefined &&
      staticStops
        .get(event.signal)
        ?.some(
          ({ bits }) =>
            event.bit === undefined ||
            !bits?.length ||
            bits.includes(event.bit!),
        )
    ) {
      const bits = anchoredBits.get(event.signal) ?? new Set();
      bits.add(event.bit);
      anchoredBits.set(event.signal, bits);
      recordGap({
        signal: event.signal,
        bit: event.bit,
        tick: event.tick,
        value: event.value,
        orderAtTick: event.orderAtTick,
        ...(event.initialSample ? { initialSample: true } : {}),
        reason: "staticBudget",
        anchor: target,
      });
    }
    const attribution =
      event.recordedWriter ??
      recordedWriters?.get(temporalTransitionKey(event));
    if (attribution && "wordWriters" in attribution) {
      event.recordedWordWriters = attribution.wordWriters;
      event.recordedWordUnresolved = attribution.unresolved.length
        ? attribution.unresolved
        : undefined;
      event.recordedWriter = attribution.writer;
    } else if (attribution && "commitOrdinal" in attribution) {
      event.recordedWriter = attribution;
    }
    const traceCandidates =
      target < rootNodes.length && !event.executionOnly
        ? root
        : candidatesAt(
            byTarget.get(event.signal) ?? [],
            observations,
            observed(event.signal, event.bit, BigInt(event.tick)),
            view(event.signal, event.bit),
            selectedElements.get(event.signal),
          );
    let candidates = traceCandidates.candidates.filter(
      ({ status, value }) =>
        status !== "contradictedByObservations" &&
        value?.targetChanged !== false,
    );
    if (event.initialSample) {
      const initializers = candidates.flatMap(({ assignment, value }) =>
        byTarget
          .get(event.signal)
          ?.some(
            ({ id, assignment: driver }) =>
              id === assignment && driver.kind === "initialization",
          ) && value?.match !== false
          ? [assignment]
          : [],
      );
      if (initializers.length) event.initializationAssignments = initializers;
    }
    const writers: RecordedWordWriter[] | undefined =
      event.recordedWordWriters ??
      (event.recordedWriter ? [event.recordedWriter] : undefined);
    const component =
      !writers && modportComponents?.get(temporalTransitionKey(event));
    if (
      component &&
      candidates.some(({ assignment }) => assignment === component.assignment)
    ) {
      candidates = candidates.filter(
        ({ assignment }) =>
          !trace.assignments[assignment].overlappingModportWrite ||
          assignment === component.assignment,
      );
      const { assignment: _assignment, ...measured } = component;
      event.compatibleModportComponent = measured;
    }
    const attributions = writers
      ? writers.map((writer) => {
          const inferred = candidates.find(
            ({ assignment }) => assignment === writer.assignment,
          );
          // Recordings identify the writer even when waveform guards or RHS samples are ambiguous.
          const candidate: (typeof candidates)[number] =
            inferred &&
            inferred.value?.match !== false &&
            (writer.evaluation?.tick ?? event.tick) === event.tick
              ? inferred
              : {
                  assignment: writer.assignment,
                  location: trace.assignments[writer.assignment].location,
                  status: "possible",
                  triggers: [],
                  guards: [],
                };
          return { candidate, writer };
        })
      : candidates.map((candidate) => ({ candidate, writer: undefined }));
    for (const { candidate, writer } of attributions) {
      const sampleTick = writer?.evaluation?.tick ?? event.tick;
      const tick = BigInt(sampleTick);
      // A recorded branch entry bounds the trigger time even if a procedural
      // delay separates the trigger from the evaluated write.
      const triggerTick = Object.values<string>(
        writer?.evaluation?.guardEntryTicks ?? {},
      ).reduce(
        (earliest, entry) =>
          BigInt(entry) < BigInt(earliest) ? entry : earliest,
        sampleTick,
      );
      const original =
        (recordedFieldIds.has(event.signal)
          ? byTarget
              .get(event.signal)
              ?.find(({ id }) => id === candidate.assignment)?.assignment
          : undefined) ?? trace.assignments[candidate.assignment];
      if (original.kind === "taskInput") {
        recordGap({
          signal: event.signal,
          tick: sampleTick,
          use: { target, assignment: candidate.assignment, kind: "data" },
          reason: "unrecordedTaskInput",
        });
        continue;
      }
      const assignment =
        (candidate.targetElement?.status === "selected" ||
          (writer && selectedElements.has(event.signal))) &&
        original.elementValue
          ? { ...original, value: original.elementValue }
          : original;
      const directPort = isDirectTracePort(assignment);
      const port = assignment.port;
      if (
        (port?.toField || assignment.targetField) &&
        !recordedFieldIds.has(event.signal)
      ) {
        recordMissing(event.signal, event.bit, sampleTick, undefined, {
          target,
          assignment: candidate.assignment,
          kind: "data",
        });
        continue;
      }
      const recordedRhs = samplesMatchingRecordedRhs(
        assignment,
        observations,
        writer?.evaluation,
        signalNames,
      );
      if (
        recordedRhs &&
        recordedRhs.samples.length > 1 &&
        writer?.commitOrdinal === event.recordedWriter?.commitOrdinal
      )
        event.recordedRhsCombinations = recordedRhs.matchingCombinations;
      const rhsSamples = new Map<number, { bits: string; match: boolean }[]>(
        candidate.rhsSamples?.map(
          ({ signal, values }) => [signal, values] as const,
        ),
      );
      const driven = view(event.signal, event.bit);
      const change = { tick: event.tick, value: event.value };
      const undelayedDriver =
        !writer &&
        trace.scope === "elaborated" &&
        trace.compilation?.complete !== false &&
        assignment.kind === "continuous" &&
        assignment.delayFreeContinuous &&
        !assignment.hasUnresolvedOperands &&
        !assignment.targetIndex &&
        !assignment.targetElementIndex &&
        !assignment.targetField &&
        assignment.targets.length === 1 &&
        byTarget.get(event.signal)?.length === 1 &&
        !incompleteDrivers.has(event.signal) &&
        !event.initialSample &&
        driven &&
        event.value !== undefined &&
        /^[01xz]+$/i.test(event.value);
      const outputCallbacks = undelayedDriver
        ? callbacksAt(event.signal, event.bit, event.tick)
        : undefined;
      const outputIndex = (event.orderAtTick ?? 1) - 1;
      const outputCallback = outputCallbacks?.[outputIndex]?.ordinal;
      const continuousCause =
        outputCallback === undefined
          ? undefined
          : orderedContinuousCause(
              assignment,
              driven,
              change,
              observations,
              (signal, tick) => callbacksAt(signal, undefined, tick),
              outputCallback,
              outputCallbacks[outputIndex - 1],
            );
      const observedRhs = undelayedDriver
        ? compareSampleCombinations(
            assignment,
            observations,
            event.tick,
            (read) => compareAssignmentValue(assignment, driven, change, read),
            "continuous",
            outputCallback === undefined
              ? undefined
              : (signal) =>
                  callbacksAt(signal, undefined, event.tick)
                    ?.filter(({ ordinal }) => ordinal < outputCallback)
                    .map(({ value }) =>
                      observedBits(value, observations.get(signal)!),
                    ),
          )
        : undefined;
      const compatibleRhs =
        observedRhs &&
        new Map(
          observedRhs.samples.map(
            ({ signal, values }) =>
              [
                signal,
                values.filter(({ match }) => match).map(({ bits }) => bits),
              ] as const,
          ),
        );
      const indexSignals = new Set(
        candidate.targetIndex?.status === "selected"
          ? candidate.targetIndex.inputs
          : undefined,
      );
      if (assignment.targetElementIndex?.op === "signal")
        indexSignals.add(assignment.targetElementIndex.args);
      const recordedElement =
        event.recordedWordWriters &&
        assignment.targetElementIndex?.op === "signal"
          ? {
              signal: assignment.targetElementIndex.args,
              index: selectedElements.get(event.signal),
            }
          : undefined;
      const wordRead = assignment.wordRead;
      const resolvedWords: { signal: number; unordered?: true }[] = [];
      if (
        wordRead &&
        assignment.kind === "continuous" &&
        wordReads.length < maxEdges
      ) {
        const sampled = evaluateTraceValue(wordRead.index, undefined, (id) => {
          indexSignals.add(id);
          return stableOperand(observations.get(id), sampleTick);
        });
        const exact = sampled && traceInteger(sampled.bits, sampled.signed);
        const indexes = new Map<bigint, true | undefined>();
        if (exact !== undefined) {
          indexes.set(exact, undefined);
        } else if (wordRead.index.op === "signal") {
          // A continuous assignment can observe either side of a transition
          // within one waveform tick. Retain each distinct usable index.
          const item = observations.get(wordRead.index.args);
          if (item && !item.projected && !item.historyTruncated) {
            const values = [
              previousValue(item, sampleTick),
              ...item.history
                .filter(({ tick }) => tick === sampleTick)
                .map(({ value }) => value),
            ];
            for (const bits of values) {
              const normalized = observedBits(bits, item);
              const index =
                normalized && item.signed !== undefined
                  ? traceInteger(normalized, item.signed)
                  : undefined;
              if (index !== undefined) indexes.set(index, true);
            }
          }
        }
        for (const [index, unordered] of indexes) {
          const word = wordsByAddress.get(wordRead.signal + ":" + index);
          if (word) resolvedWords.push({ signal: word.id, unordered });
          const key = `${target}:${candidate.assignment}:${index}`;
          if (seenWordReads.has(key) || wordReads.length >= maxEdges) continue;
          seenWordReads.add(key);
          wordReads.push({
            signal: wordRead.signal,
            index: index.toString(),
            tick: sampleTick,
            target,
            assignment: candidate.assignment,
            timing: unordered ? "sameTickUnordered" : undefined,
          });
        }
        if (resolvedWords.length && resolvedWords.length < indexes.size)
          recordMissing(wordRead.signal, undefined, sampleTick, undefined, {
            target,
            assignment: candidate.assignment,
            kind: "data",
          });
      }
      const fieldRead =
        assignment.kind === "continuous" ? assignment.fieldRead : undefined;
      const field =
        fieldRead && fieldsByName.get(fieldRead.signal + ":" + fieldRead.field);
      const portField =
        port?.fromField &&
        fieldsByName.get(assignment.inputs[0]?.signal + ":" + port.fromField);
      if (port?.fromField && !portField) {
        recordMissing(
          assignment.inputs[0]?.signal ?? event.signal,
          undefined,
          sampleTick,
          undefined,
          {
            target,
            assignment: candidate.assignment,
            kind: "data",
          },
        );
        continue;
      }
      const recordedIndex = writer?.targetRange && assignment.targetIndex;
      if (recordedIndex?.op === "signal") indexSignals.add(recordedIndex.args);
      const recordedRange = writer?.attemptedTargetRange ?? writer?.targetRange;
      const recordedPackedIndex =
        recordedIndex?.op === "signal" &&
        recordedRange &&
        Math.abs(recordedRange[0] - recordedRange[1]) + 1 ===
          (assignment.targetIndexedPart?.width ?? 1)
          ? assignment.targetIndexedPart?.ascendingIndices === false
            ? Math.max(...recordedRange)
            : Math.min(...recordedRange)
          : undefined;
      const targetRange =
        writer?.targetRange ??
        candidate.value?.targetRange ??
        assignment.targetRange ??
        span(event.signal);
      const contributingRanges = writer?.contributingRanges;
      const canResolveIndex =
        assignment.kind === "continuous" ||
        assignment.kind === "port" ||
        (candidate.status === "consistentWithObservations" &&
          candidate.value?.match);
      type SelectorCache = Map<
        AssignmentValue,
        ReturnType<typeof evaluateTraceValue>
      >;
      const selectorCaches = {
        index: new Map() as SelectorCache,
        shift: new Map() as SelectorCache,
        condition: new Map() as SelectorCache,
      };
      const conditionSignals = new Set<number>();
      let selectorUsesSameTickSamples = false;
      const evaluation = writer?.evaluation;
      const resolveSelector =
        canResolveIndex || evaluation?.operandValues
          ? (
              selector: AssignmentValue,
              use: "index" | "shift" | "condition",
            ) => {
              if (use === "index" && !canResolveIndex) return;
              const cache = selectorCaches[use];
              if (cache.has(selector)) return cache.get(selector);
              const accessed = new Set<number>();
              const evaluate = (
                samples: readonly { signal: number; bits: string }[] = [],
              ) =>
                evaluateTraceValue(selector, undefined, (id) => {
                  accessed.add(id);
                  const operand = stableOperand(
                    observations.get(id),
                    sampleTick,
                  );
                  const sample = samples.find(({ signal }) => signal === id);
                  return operand && sample
                    ? { ...operand, bits: sample.bits }
                    : operand;
                });
              let evaluated =
                use !== "index" && evaluation?.operandValues
                  ? evaluateTraceValue(selector, undefined, (id) => {
                      accessed.add(id);
                      const signal = signalNames.get(id);
                      const value = recordedOperandValue(
                        evaluation,
                        assignment.instance,
                        signal,
                      );
                      const observation = observations.get(id);
                      if (observation?.real || value === undefined) return;
                      const range =
                        signal?.packedRange ??
                        observation?.partialRange ??
                        span(id);
                      const width = range
                        ? Math.abs(range[0] - range[1]) + 1
                        : observation?.projected
                          ? undefined
                          : observation?.width;
                      if (width === undefined || value.length !== width) return;
                      const bits = normalizeBits(value, width);
                      return (
                        bits && {
                          bits,
                          width,
                          range,
                          signed: signal?.signed ?? observation?.signed,
                        }
                      );
                    })
                  : undefined;
              if (!evaluated && canResolveIndex) evaluated = evaluate();
              if (
                !evaluated &&
                use !== "index" &&
                observedRhs?.matchingCombinations.length
              ) {
                let agreed: ReturnType<typeof evaluateTraceValue>;
                for (const samples of observedRhs.matchingCombinations) {
                  const value = evaluate(samples);
                  if (
                    !value ||
                    (agreed &&
                      (use === "condition"
                        ? truth(value.bits) !== truth(agreed.bits)
                        : value.bits !== agreed.bits))
                  ) {
                    agreed = undefined;
                    break;
                  }
                  agreed = value;
                }
                if (agreed) {
                  evaluated = agreed;
                  selectorUsesSameTickSamples = true;
                }
              }
              const dependencies =
                use === "condition" ? conditionSignals : indexSignals;
              for (const signal of accessed) dependencies.add(signal);
              cache.set(selector, evaluated);
              return evaluated;
            }
          : undefined;
      const selectedBit =
        event.bit ??
        (targetRange?.[0] === targetRange?.[1] ? targetRange?.[0] : undefined);
      const projected = assignment.bitDependencies?.find(
        ({ targetBit }) =>
          targetBit === selectedBit &&
          (event.bit !== undefined ||
            observations.get(event.signal)?.width === 1),
      );
      let bitReads =
        projected &&
        new Map(
          projected.reads.map(({ signal, bits }) => [signal, new Set(bits)]),
        );
      if (
        !bitReads &&
        targetRange &&
        (!assignment.targetIndex ||
          recordedIndex ||
          (canResolveIndex && candidate.targetIndex?.status === "selected"))
      ) {
        const width = Math.abs(targetRange[0] - targetRange[1]) + 1;
        const attempted = writer?.attemptedTargetRange;
        const evaluationWidth = attempted
          ? Math.abs(attempted[0] - attempted[1]) + 1
          : width;
        const rhsRight =
          assignment.kind === "blocking" && attempted
            ? attempted[1]
            : targetRange[1];
        const selectedAssignment = assignment.targetIndex
          ? { ...assignment, targetIndex: undefined }
          : assignment;
        const hasFixedModportMapping =
          assignment.inputs.some(
            (input) =>
              input.kind === "data" &&
              (input.interfaceRange || input.interfaceComponent),
          ) ||
          assignment.hierarchicalTargets?.some(
            (target) => target.interfaceComponent,
          );
        if (event.bit !== undefined) {
          bitReads = dependencies(
            selectedAssignment,
            Math.abs(event.bit - rhsRight),
            resolveSelector,
            evaluationWidth,
          );
        } else if (
          contributingRanges ||
          attempted ||
          hasFixedModportMapping ||
          (canResolveIndex && indexSignals.size) ||
          assignment.inputs.some(
            ({ signal }) => observations.get(signal)?.partialRange,
          ) ||
          hasPackedSelection(assignment.value)
        ) {
          if (width <= 64) {
            const combined = new Map<number, Set<number>>();
            let resolved = true;
            for (let slot = 0; slot < width; slot++) {
              const bit =
                targetRange[1] +
                slot * (targetRange[0] < targetRange[1] ? -1 : 1);
              if (
                contributingRanges &&
                !contributingRanges.some(
                  ([left, right]) =>
                    bit >= Math.min(left, right) &&
                    bit <= Math.max(left, right),
                )
              )
                continue;
              const reads = dependencies(
                selectedAssignment,
                Math.abs(bit - rhsRight),
                resolveSelector,
                evaluationWidth,
              );
              if (!reads) {
                resolved = false;
                break;
              }
              for (const [signal, bits] of reads) {
                const all = combined.get(signal) ?? new Set<number>();
                for (const bit of bits) all.add(bit);
                combined.set(signal, all);
              }
            }
            const narrowsRead = [...combined].some(([signal, bits]) => {
              const observation = observations.get(signal);
              if (observation?.partialRange) return true;
              const width = observation?.width;
              return width !== undefined && bits.size < width;
            });
            if (
              resolved &&
              (contributingRanges ||
                hasFixedModportMapping ||
                indexSignals.size ||
                conditionSignals.size ||
                narrowsRead)
            )
              bitReads = combined;
          }
        }
      }
      const waitCauses = assignment.waitPredicates?.length
        ? observedWaitCauses(
            assignment,
            writer?.evaluation,
            signalNames,
            observations,
            historyBoundary + 1n,
            (id, tick) => observed(id, undefined, tick),
            evidence.recordedValueCallbacks,
          )
        : undefined;
      const guardBits = new Map<TemporalInput, Set<number>>();
      const guardIndexes = new Set<TemporalInput>();
      if (evaluation?.guardEntryValues) {
        for (const guard of assignment.guards ?? []) {
          if (!guard.expression) continue;
          const controlInputs = assignment.inputs.filter(
            (input) =>
              input.kind === "control" &&
              !input.hierarchical &&
              readsGuard(input, guard),
          );
          const read = (id: number) => {
            const subject = signalNames.get(id);
            if (!subject || subject.instance !== assignment.instance) return;
            const bits =
              evaluation.guardEntryValues[
                guardSampleKey(guard, subject.name)
              ]?.toLowerCase();
            if (bits === undefined) return;
            const range = subject.packedRange ?? span(id);
            if (range && Math.abs(range[0] - range[1]) + 1 !== bits.length)
              return;
            return { bits, width: bits.length, range, signed: subject.signed };
          };
          const truth = evaluateGuard(guard.expression, read);
          if (truth === undefined || (truth === 1) !== guard.takenWhenTrue)
            continue;
          const indexes = new Set<number>();
          const reads = dependencies(
            {
              ...assignment,
              hasUnresolvedOperands: false,
              targetIndex: undefined,
              inputs: controlInputs.map((input) => ({
                ...input,
                kind: "data",
              })),
              value: guardReadExpression(guard.expression),
            },
            0,
            (selector) => {
              const resolved = evaluateTraceValue(selector, undefined, read);
              for (const id of resolved?.inputs ?? []) indexes.add(id);
              return resolved;
            },
          );
          if (!reads) continue;
          for (const input of controlInputs) {
            const bits = reads.get(input.signal);
            if (bits && read(input.signal)) guardBits.set(input, bits);
            if (indexes.has(input.signal)) guardIndexes.add(input);
          }
        }
      }
      const dataInputs = assignment.inputs.flatMap((input) =>
        input.kind === "data" && portField
          ? [{ ...input, signal: portField.id, selectedData: true as const }]
          : input.kind === "data" && field
            ? input.signal === fieldRead?.signal
              ? [{ ...input, signal: field.id, selectedData: true as const }]
              : []
            : input.kind === "data" &&
                input.signal === wordRead?.signal &&
                resolvedWords.length
              ? resolvedWords.map(({ signal, unordered }) => ({
                  ...input,
                  signal,
                  selectedData: true as const,
                  wordIndexUnordered: unordered,
                }))
              : [input],
      );
      for (const input of dataInputs) {
        const selectedData = "selectedData" in input || !!port?.toField;
        const parameter = parameters.get(input.signal);
        const subject = signalNames.get(input.signal);
        const enumValue = subject?.enumValue;
        const packageParameter = subject?.packageParameterValue;
        const elaboratedParameter =
          parameter ?? subject?.instanceParameterValue;
        const role = conditionSignals.has(input.signal)
          ? "condition"
          : parameter !== undefined ||
              indexSignals.has(input.signal) ||
              (input.kind === "control" && guardIndexes.has(input)) ||
              isPortIndex(assignment.port, input.signal)
            ? "index"
            : undefined;
        if (
          !role &&
          input.kind === "data" &&
          !assignment.hasUnresolvedOperands &&
          candidate.value?.match &&
          !candidate.value.inputs.includes(input.signal)
        )
          continue;
        const sourceObservation = observations.get(input.signal);
        const wordRange =
          "wordIndexUnordered" in input && event.bit !== undefined
            ? span(input.signal)
            : undefined;
        const readTargetRange =
          targetRange ?? signalNames.get(event.signal)?.packedRange;
        const readBitOffset =
          selectedData &&
          readTargetRange &&
          event.bit !== undefined &&
          event.bit >= Math.min(...readTargetRange) &&
          event.bit <= Math.max(...readTargetRange)
            ? Math.abs(event.bit - readTargetRange[1])
            : undefined;
        const projectedWordBits =
          wordRange &&
          readTargetRange &&
          readBitOffset !== undefined &&
          Math.abs(wordRange[0] - wordRange[1]) ===
            Math.abs(readTargetRange[0] - readTargetRange[1])
            ? new Set([
                wordRange[1] +
                  readBitOffset * (wordRange[0] < wordRange[1] ? -1 : 1),
              ])
            : undefined;
        const selected =
          input.kind === "data"
            ? (projectedWordBits ?? bitReads?.get(input.signal))
            : input.kind === "control" &&
                !input.hierarchical &&
                sourceObservation?.width >
                  (guardBits.get(input)?.size ?? Infinity)
              ? guardBits.get(input)
              : undefined;
        if (input.kind === "data" && bitReads && !selected && !role) continue;
        const bits: (number | undefined)[] =
          selected &&
          (sourceObservation?.range || sourceObservation?.partialRange)
            ? [...selected]
            : [undefined];
        if (role && !bits.includes(undefined)) bits.push(undefined);
        const packedIndex =
          input.kind === "data" &&
          recordedIndex?.op === "signal" &&
          recordedIndex.args === input.signal
            ? recordedPackedIndex
            : undefined;
        const use = {
          target,
          assignment: candidate.assignment,
          kind: input.kind,
          edge: input.kind === "trigger" ? input.edge : undefined,
        };
        const branch =
          input.kind === "control" && !input.hierarchical && !parameter
            ? recordedBranchValue(
                writer?.evaluation,
                assignment,
                input,
                subject,
              )
            : undefined;
        const branchValue = branch?.value;
        const inputTick =
          branch?.tick ?? (input.kind === "trigger" ? triggerTick : sampleTick);
        const inputTime = BigInt(inputTick);
        const capturedOperand =
          branchValue ??
          ((input.kind === "data" || input.kind === "control") &&
          !input.hierarchical &&
          !parameter
            ? recordedOperandValue(
                writer?.evaluation,
                assignment.instance,
                subject,
              )
            : undefined);
        for (const bit of bits) {
          const upstream = view(input.signal, bit);
          const captured =
            capturedOperand === undefined
              ? undefined
              : bit === undefined
                ? capturedOperand
                : sliceTraceBits(
                    capturedOperand,
                    span(input.signal) ?? upstream?.range,
                    bit,
                    bit,
                  );
          const unavailableBits =
            upstream?.partialRange &&
            (bit === undefined ||
              !upstream.range ||
              bit < Math.min(...upstream.range) ||
              bit > Math.max(...upstream.range));
          const projectedDependency =
            upstream?.projected && (bit === undefined || upstream.bit !== bit);
          const usableHistory =
            upstream &&
            !unavailableBits &&
            !projectedDependency &&
            inputTime > historyBoundary &&
            !upstream.historyTruncated;
          if (branch?.tick !== undefined && inputTime <= historyBoundary) {
            recordGap({
              signal: input.signal,
              bit,
              tick: inputTick,
              use,
              reason: "noChangeInWindow",
              value: captured,
              historyCutoff: inputTick,
            });
          } else if (unavailableBits || projectedDependency) {
            recordGap({
              signal: input.signal,
              bit,
              tick: inputTick,
              use,
              reason: unavailableBits
                ? "waveformBitsUnavailable"
                : "projectedDependency",
            });
          } else if (!parameter && !usableHistory) {
            recordMissing(input.signal, bit, inputTick, upstream, use);
          }
          let latest =
            parameter || !usableHistory
              ? []
              : observed(input.signal, bit, inputTime);
          const beforeOrdinal =
            selected && input.kind === "control"
              ? branch?.nextOrdinal
              : packedIndex !== undefined && evaluation?.tick === inputTick
                ? evaluation.ordinal
                : undefined;
          if (beforeOrdinal !== undefined && latest[0]?.tick === inputTick) {
            const callbacks = callbacksAt(input.signal, bit, inputTick);
            if (callbacks)
              latest = latest.filter(
                ({ orderAtTick }) =>
                  callbacks[(orderAtTick ?? 1) - 1].ordinal < beforeOrdinal,
              );
            if (callbacks && !latest.length)
              latest = observed(input.signal, bit, inputTime - 1n);
          }
          const concurrent = latest[0]?.tick === inputTick;
          let stableWithoutChange = false;
          const possibilities: Omit<(typeof nodes)[number], "signal">[] = [];
          if (enumValue) {
            possibilities.push({
              tick: inputTick,
              value: enumValue.bits,
              sampleOnly: true,
              enumConstant: true,
            });
          } else if (packageParameter) {
            possibilities.push({
              tick: inputTick,
              value: packageParameter.bits,
              sampleOnly: true,
              packageParameter: true,
            });
          } else if (elaboratedParameter) {
            possibilities.push({
              tick: inputTick,
              value: elaboratedParameter.bits,
              sampleOnly: true,
              elaboratedParameter: true,
            });
          } else if (usableHistory && input.kind === "trigger") {
            if (concurrent)
              for (const { tick, value, prior, orderAtTick } of latest) {
                if (
                  prior !== undefined &&
                  matchesEdge(prior, value, input.edge)
                )
                  possibilities.push({ tick, value, orderAtTick });
              }
            if (
              !possibilities.length &&
              observeTrigger(input, upstream, inputTick).match === null
            )
              recordGap({
                signal: input.signal,
                bit,
                tick: inputTick,
                use,
                reason: "unprovenTrigger",
              });
          } else if (usableHistory) {
            if (
              concurrent &&
              (input.signal !== event.signal ||
                bit !== event.bit ||
                inputTick !== event.tick)
            ) {
              for (const { prior: _prior, ...sample } of latest)
                possibilities.push(sample);
            }
            const prior = concurrent
              ? observed(input.signal, bit, inputTime - 1n).at(-1)
              : latest.at(-1);
            if (prior) {
              const { prior: _prior, ...sample } = prior;
              possibilities.push(sample);
            } else {
              const stable = concurrent
                ? previousValue(upstream, inputTick)
                : valueAtStableTick(upstream, inputTick);
              if (stable !== undefined) {
                stableWithoutChange = true;
                possibilities.push({
                  tick: inputTick,
                  value: stable,
                  sampleOnly: true,
                  beforeTick: concurrent ? true : undefined,
                });
              } else if (concurrent && latest[0].initialSample) {
                if (captured === undefined)
                  recordGap({
                    signal: input.signal,
                    bit,
                    tick: inputTick,
                    value: latest[0].value,
                    use,
                    reason: "unprovenInitialOrder",
                  });
              } else {
                recordMissing(input.signal, bit, inputTick, upstream, use);
              }
            }
          }
          const recordedSamples =
            input.kind === "data" &&
            recordedRhs?.samples.find(({ signal }) => signal === input.signal);
          const selectedIndex =
            input.signal === recordedElement?.signal && bit === undefined
              ? recordedElement.index
              : bit === undefined
                ? packedIndex
                : undefined;
          const compatibleValues =
            captured !== undefined
              ? new Set([captured])
              : recordedSamples
                ? new Set(
                    recordedSamples.values
                      .filter(({ match }) => match)
                      .map(({ bits }) =>
                        bit === undefined
                          ? bits
                          : sliceTraceBits(bits, upstream?.range, bit, bit),
                      ),
                  )
                : undefined;
          const useRecordedRhs =
            compatibleValues &&
            upstream &&
            possibilities.some((sample) =>
              compatibleValues.has(observedBits(sample.value, upstream)),
            );
          // A direct port transfers the same bits. Other samples of the source
          // cannot explain this transition when the matching sample is present.
          const portTarget = directPort
            ? view(event.signal, event.bit)
            : undefined;
          const portValue =
            portTarget &&
            upstream &&
            !upstream.real &&
            event.bit === bit &&
            upstream.width === portTarget.width
              ? observedBits(event.value, portTarget)
              : undefined;
          const hasMatchingPortSample =
            portValue !== undefined &&
            upstream &&
            possibilities.some(
              (sample) => observedBits(sample.value, upstream) === portValue,
            );
          const rhsValues =
            input.kind === "data" && compatibleRhs?.get(input.signal);
          const observedValues =
            rhsValues &&
            upstream &&
            new Set(
              rhsValues
                .map((value) =>
                  bit === undefined
                    ? value
                    : sliceTraceBits(value, upstream.range, bit, bit),
                )
                .filter((value) => value !== undefined),
            );
          const useObservedRhs =
            observedValues &&
            upstream &&
            possibilities.some(({ value }) =>
              observedValues.has(observedBits(value, upstream)),
            );
          const targetView = selectedData
            ? view(event.signal, event.bit)
            : undefined;
          const targetBits =
            targetView && observedBits(event.value, targetView);
          const sourceRange = port?.toField ? port.fromRange : undefined;
          const targetRange = portField ? port?.toRange : undefined;
          const expected =
            targetBits &&
            (targetRange
              ? sliceTraceBits(targetBits, targetView?.range, ...targetRange)
              : targetBits);
          // The recorder supplies the packed member value in significance
          // order even when it cannot report the member's declared bounds.
          const fieldBitOffset =
            input.signal === field?.id &&
            readTargetRange &&
            readBitOffset !== undefined &&
            upstream?.width ===
              Math.abs(readTargetRange[0] - readTargetRange[1]) + 1
              ? readBitOffset
              : undefined;
          const selectedWidth = sourceRange
            ? Math.abs(sourceRange[0] - sourceRange[1]) + 1
            : fieldBitOffset === undefined
              ? upstream?.width
              : 1;
          const selectedValue =
            expected?.length === selectedWidth ? expected : undefined;
          if (
            selectedData &&
            (selectedValue === undefined ||
              (usableHistory && !possibilities.length))
          )
            recordGap({
              signal: input.signal,
              bit,
              tick: inputTick,
              use,
              reason: "noMatchingOperandChange",
            });
          let recordedSameValueWrite = false;
          if (captured !== undefined && writer?.evaluation) {
            const { ordinal } = writer.evaluation;
            const history =
              branchValue === undefined
                ? operandHistory?.(
                    input.signal,
                    inputTick,
                    ordinal,
                    capturedOperand!,
                    bit,
                  )
                : undefined;
            if (
              useRecordedRhs &&
              usableHistory &&
              history?.every((part) => part.writer)
            ) {
              let newerWrite = false;
              const compatibleHistory = history.every((part) => {
                const change = observed(input.signal, part.bit, inputTime).at(
                  -1,
                );
                if (!change)
                  return (
                    valueAtStableTick(
                      view(input.signal, part.bit),
                      inputTick,
                    ) === part.value
                  );
                if (
                  change.value !== part.value ||
                  BigInt(part.tick) < BigInt(change.tick)
                )
                  return false;
                newerWrite ||= BigInt(part.tick) > BigInt(change.tick);
                return true;
              });
              // A covered write can replace the origin of a held value without
              // producing a new waveform transition.
              recordedSameValueWrite = compatibleHistory && newerWrite;
            }
            if (!useRecordedRhs && latest.length)
              recordGap({
                signal: input.signal,
                bit,
                tick: inputTick,
                use,
                reason: "noMatchingOperandChange",
              });
            if (
              !useRecordedRhs ||
              recordedSameValueWrite ||
              (concurrent && latest[0].initialSample)
            ) {
              const fallback = {
                tick: inputTick,
                sampleOnly: true as const,
                operandEvaluationOrdinal: ordinal,
                ...(branch?.wait
                  ? { waitResumeSample: true as const }
                  : branchValue === undefined
                    ? {}
                    : { branchEntrySample: true as const }),
              };
              possibilities.splice(
                0,
                possibilities.length,
                ...(history
                  ? history.map((part) =>
                      part.writer
                        ? {
                            tick: part.tick,
                            bit: part.bit,
                            value: part.value,
                            executionOnly: true as const,
                            recordedWriter: part.writer,
                          }
                        : { ...fallback, bit: part.bit, value: part.value },
                    )
                  : [{ ...fallback, value: captured }]),
              );
            }
          }
          const candidateSamples =
            selectedIndex === undefined
              ? possibilities
              : possibilities.filter(({ value }) => {
                  const bits = upstream && observedBits(value, upstream);
                  return (
                    bits &&
                    traceInteger(bits, upstream.signed) ===
                      BigInt(selectedIndex)
                  );
                });
          if (
            selectedIndex !== undefined &&
            usableHistory &&
            !candidateSamples.length
          ) {
            recordGap({
              signal: input.signal,
              bit,
              tick: inputTick,
              use,
              reason: "noMatchingOperandChange",
            });
          }
          for (const sample of candidateSamples) {
            const callback =
              outputCallback !== undefined &&
              input.kind === "data" &&
              !sample.initialSample &&
              !sample.sampleOnly &&
              !sample.executionOnly &&
              sample.tick === event.tick
                ? callbacksAt(input.signal, bit, event.tick)?.[
                    (sample.orderAtTick ?? 1) - 1
                  ]
                : undefined;
            if (callback && callback.ordinal >= outputCallback) continue;
            const causedOutput =
              callback &&
              continuousCause?.signal === input.signal &&
              callback.ordinal === continuousCause.ordinal;
            const normalized = upstream && observedBits(sample.value, upstream);
            const waitCause =
              branch?.wait && sample.tick === inputTick && !sample.sampleOnly
                ? waitCauses?.get(input.signal)?.get(inputTick)
                : undefined;
            const enablingChange =
              waitCause && waitCause.orderAtTick === sample.orderAtTick;
            if (
              !enablingChange &&
              selectedIndex === undefined &&
              useRecordedRhs &&
              !sample.executionOnly &&
              normalized !== undefined &&
              !compatibleValues.has(normalized)
            )
              continue;
            if (hasMatchingPortSample && normalized !== portValue) continue;
            if (useObservedRhs && !observedValues.has(normalized)) continue;
            if (
              selectedData &&
              (selectedValue === undefined ||
                (normalized && sourceRange
                  ? sliceTraceBits(normalized, upstream?.range, ...sourceRange)
                  : normalized && fieldBitOffset !== undefined
                    ? normalized.at(-1 - fieldBitOffset)
                    : normalized) !== selectedValue)
            )
              continue;
            const timing =
              ("wordIndexUnordered" in input && input.wordIndexUnordered) ||
              (selectorUsesSameTickSamples &&
                !!bitReads &&
                input.kind === "data") ||
              (!sample.sampleOnly &&
                !sample.executionOnly &&
                sample.tick === inputTick &&
                (input.kind !== "trigger" ||
                  latest.length > 1 ||
                  event.orderAtTick !== undefined))
                ? ("sameTickUnordered" as const)
                : undefined;
            const match = useObservedRhs
              ? true
              : bit === undefined && input.kind === "data"
                ? rhsSamples
                    .get(input.signal)
                    ?.find(({ bits }) => bits === normalized)?.match
                : undefined;
            const properties: TemporalEdgeEvidence = {
              kind: input.kind,
              role: bit === undefined ? role : undefined,
              ...(event.recordedWordWriters && writer
                ? { recordedCommitOrdinal: writer.commitOrdinal }
                : {}),
              confidence:
                (input.kind === "trigger" && inputTick !== sampleTick) ||
                (concurrent && (input.kind !== "trigger" || timing))
                  ? ("possible" as const)
                  : candidate.status,
              timing,
              ...(causedOutput
                ? ({
                    continuousCause: {
                      sourceOrdinal: callback.ordinal,
                      targetOrdinal: outputCallback,
                    },
                    callbackOrder: "sourceBeforeTarget",
                  } as const)
                : {}),
              ...(enablingChange ? waitCause.evidence : {}),
              ...(input.kind === "control" &&
              branch?.guardStart &&
              captured !== undefined &&
              normalized === captured
                ? {
                    branchEntry: {
                      line: branch.guardStart.line + 1,
                      column: branch.guardStart.character + 1,
                      tick: branch.tick,
                      nextOrdinal: branch.nextOrdinal,
                    },
                  }
                : {}),
              ...(recordedSameValueWrite
                ? ({ sourceWriteEvidence: "recordedSameValueWrite" } as const)
                : {}),
              ...(selectedIndex !== undefined
                ? packedIndex !== undefined
                  ? ({ packedIndexEvidence: "recordedTarget" } as const)
                  : ({ arrayIndexEvidence: "recordedTarget" } as const)
                : input.kind === "control" &&
                    captured !== undefined &&
                    (!enablingChange || normalized === captured)
                  ? ({
                      controlSampleEvidence:
                        branchValue === undefined
                          ? "recordedEvaluation"
                          : branch?.wait
                            ? "recordedWaitResume"
                            : "recordedBranchEntry",
                    } as const)
                  : sample.operandEvaluationOrdinal !== undefined ||
                      sample.executionOnly ||
                      (useRecordedRhs && compatibleValues.has(normalized))
                    ? ({
                        rhsSample: "matches",
                        rhsSampleEvidence: "recordedEvaluation",
                      } as const)
                    : useObservedRhs
                      ? {
                          rhsSample: "matches" as const,
                          rhsSampleEvidence: "waveformCombination" as const,
                        }
                      : match === undefined
                        ? {}
                        : {
                            rhsSample: match
                              ? ("matches" as const)
                              : ("differs" as const),
                          }),
            };
            if (
              stableWithoutChange &&
              sample.sampleOnly &&
              sample.operandEvaluationOrdinal === undefined
            ) {
              const cutoff = sample.beforeTick ? inputTime - 1n : inputTime;
              const seed = upstream?.initial;
              const seeded =
                historyBoundary >= 0n &&
                cutoff >= historyBoundary &&
                seed?.value === sample.value &&
                upstream.history.every(
                  ({ tick, value }) =>
                    BigInt(tick) > cutoff || value === sample.value,
                );
              // The reader supplies the last sample before the window. Its
              // timestamp lets equivalent held values share an earlier query.
              const historyCutoff = seeded
                ? seed.tick !== undefined &&
                  BigInt(seed.tick) <= historyBoundary
                  ? seed.tick
                  : historyBoundary.toString()
                : undefined;
              recordGap({
                signal: input.signal,
                bit,
                tick: inputTick,
                reason: "noChangeInWindow",
                value: sample.value,
                historyCutoff,
                use: { ...use, evidence: properties },
              });
            }
            const point = bit === undefined ? sample : { ...sample, bit };
            const key = JSON.stringify([
              nodeKey(input.signal, point),
              target,
              properties,
            ]);
            const previous = seenEdges.get(key);
            if (previous) {
              if (
                previous.assignment !== candidate.assignment &&
                !previous.alsoAssignments?.includes(candidate.assignment)
              )
                (previous.alsoAssignments ??= []).push(candidate.assignment);
              continue;
            }
            const source =
              edges.length < maxEdges ? add(input.signal, point) : undefined;
            if (source === undefined) {
              recordGap({
                signal: input.signal,
                bit,
                tick: sample.tick,
                value: sample.value,
                ...(sample.initialSample ? { initialSample: true } : {}),
                ...(sample.sampleOnly || sample.executionOnly
                  ? { sampleOnly: true as const }
                  : {}),
                ...(sample.orderAtTick === undefined
                  ? {}
                  : { orderAtTick: sample.orderAtTick }),
                use: { ...use, evidence: properties },
                reason: edges.length >= maxEdges ? "edgeBudget" : "nodeBudget",
              });
              continue;
            }
            const edge = {
              source,
              target,
              assignment: candidate.assignment,
              ...properties,
            };
            seenEdges.set(key, edge);
            edges.push(edge);
          }
        }
      }
    }
  }
  return graph(rootNodes);
}
