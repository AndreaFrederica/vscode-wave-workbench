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
type Observation = Evidence["observations"][number];
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
  | "truncated"
  | "noChangeInWindow"
  | "noMatchingOperandChange"
  | "projectedDependency"
  | "unprovenTrigger"
  | "unrecordedTaskInput";
export type TemporalEdgeEvidence = {
  kind: TemporalInput["kind"];
  role?: "index";
  confidence: "possible" | "consistentWithObservations";
  timing?: "sameTickUnordered";
  callbackOrder?: "sourceBeforeTarget" | "sourceAfterTarget";
  rhsSample?: "matches" | "differs";
  rhsSampleEvidence?: "recordedEvaluation";
  sourceWriteEvidence?: "recordedSameValueWrite";
  controlSampleEvidence?: "recordedEvaluation";
  recordedCommitOrdinal?: number;
  arrayIndexEvidence?: "recordedTarget";
};
export type TemporalGap = {
  signal: number;
  bit?: number;
  tick: string;
  value?: string;
  reason: MissingReason | "nodeBudget" | "edgeBudget" | "staticBudget";
  anchor?: number;
  sampleOnly?: true;
  orderAtTick?: number;
  historyCutoff?: string;
  continuation?: {
    signal: string;
    tick: string;
    changeOrder?: number;
    liveSessionId?: string;
    historyStart?: "auto";
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
  evaluation?: {
    ordinal: number;
    tick: string;
    value?: string;
    operandValues?: Record<string, string>;
    guardEntryValues?: Record<string, string>;
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
}: {
  signal: number;
  bit?: number;
  tick: string;
  orderAtTick?: number;
}) {
  return signal + ":" + (bit ?? "*") + "@" + tick + ":" + (orderAtTick ?? 1);
}
type Truth = 0 | 1 | "x";

function evaluateGuard(
  expr: GuardExpression,
  read: (signal: number) => TraceOperand | undefined,
): Truth | undefined {
  switch (expr.op) {
    case "signal":
      return truth(read(expr.args)?.bits);
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

function previousValue(observation: Observation, tick: string) {
  const previous = observation.history.findLast(
    (event) => BigInt(event.tick) < BigInt(tick),
  );
  return previous ? previous.value : observation.initial?.value;
}

function valueAtStableTick(observation: Observation | undefined, tick: string) {
  if (!observation || observation.historyTruncated) return undefined;
  const before = previousValue(observation, tick);
  if (
    before === undefined ||
    observation.history.some(
      (event) => event.tick === tick && event.value !== before,
    )
  )
    return undefined;
  return before;
}

function stableOperand(observation: Observation | undefined, tick: string) {
  if (!observation || observation.projected || observation.real) return undefined;
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
  const range = root.range;
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
  if (!expression || (root.projected && root.bit === undefined))
    return undefined;
  const evaluatedRange = targetRange ?? root.range;
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
  recorded = false,
) {
  const alternatives: {
    signal: number;
    values: Set<string>;
    matching: Set<string>;
  }[] = [];
  const matchingCombinations: { signal: number; bits: string }[][] = [];
  let combinations = 1;
  const inputs = new Set(
    assignment.inputs
      .filter(({ kind }) => kind === "data")
      .map(({ signal }) => signal),
  );
  for (const signal of inputs) {
    const observation = observations.get(signal);
    if (!observation) {
      if (recorded) return;
      continue;
    }
    const samples = observation.history.filter(
      (sample) => sample.tick === tick,
    );
    if (!samples.length && !recorded) continue;
    if (observation.projected || observation.historyTruncated) return;
    const before = observedBits(previousValue(observation, tick), observation);
    if (before === undefined || (recorded && !/^[01]+$/.test(before))) return;
    const values = new Set([before]);
    for (const sample of samples) {
      const bits = observedBits(sample.value, observation);
      if (bits === undefined || (recorded && !/^[01]+$/.test(bits))) return;
      values.add(bits);
    }
    if (values.size < 2) continue;
    combinations *= values.size;
    if (combinations > 32) return;
    alternatives.push({ signal, values, matching: new Set() });
  }
  if (!alternatives.length) return;

  const sampled = new Map<number, string>();
  const read = (signal: number) => {
    const operand = stableOperand(observations.get(signal), tick);
    if (!operand) return;
    return { ...operand, bits: sampled.get(signal) ?? operand.bits };
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
      if (recorded)
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
    true,
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

type RecordedChange = {
  tick: string;
  value: string;
  prior: string;
  orderAtTick?: number;
};

function recordedChanges(observation: Observation) {
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
  return groups;
}

function changesAtOrBefore(
  groups: ReturnType<typeof recordedChanges>,
  cutoff: bigint,
) {
  return groups.findLast((group) => group.tick <= cutoff)?.changes ?? [];
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

function fullObservations(evidence: Evidence) {
  const observations = new Map(
    evidence.observations.map((signal) => [signal.signal, signal]),
  );
  if (evidence.wholeRoot)
    observations.set(evidence.wholeRoot.signal, evidence.wholeRoot);
  return observations;
}

export function traceAssignmentCandidates(
  trace: VideTrace,
  evidence: Evidence,
) {
  return candidatesAt(
    directDrivers(trace),
    fullObservations(evidence),
    trace.root,
    BigInt(evidence.tick),
    undefined,
    evidence.observations.find(({ signal }) => signal === trace.root),
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
  signal: number,
  cutoff: bigint,
  changes?: readonly RecordedChange[],
  root = observations.get(signal),
  selectedElement?: number,
) {
  changes ??= root ? changesAtOrBefore(recordedChanges(root), cutoff) : [];
  const change = changes.at(-1);
  if (!root || !change)
    return { status: "noObservedChange" as const, candidates: [] };
  const multipleChangesAtTick = changes.length > 1;
  const point = { tick: change.tick, value: change.value };
  return {
    status: "observedChange" as const,
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
    const contradicted =
      indexExcluded ||
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
    [...fullObservations(evidence).values()].map((item) => [
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
    root,
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
  changeOrder?: number;
};

export function buildTemporalTrace(
  trace: VideTrace,
  evidence: Evidence,
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
  const observations = fullObservations(evidence);
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
  function view(signal: number, bit?: number) {
    if (signal === trace.root && rootView?.bit === bit && rootView?.projected)
      return rootView;
    const whole = observations.get(signal);
    if (!whole || bit === undefined || whole.projected) return whole;
    const key = selectionKey(signal, bit);
    const existing = views.get(key);
    if (existing) return existing;
    const project = (bits?: string) => {
      const normalized = observedBits(bits, whole);
      return normalized && sliceTraceBits(normalized, span(signal), bit, bit);
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
    orderAtTick?: number;
    beforeTick?: true;
    elaboratedParameter?: true;
    recordedWriter?: RecordedWriter;
    recordedWordWriters?: RecordedWordWriter[];
    recordedWordUnresolved?: [number, number][];
    operandEvaluationOrdinal?: number;
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
  const gaps = new Map<string, TemporalGap>();
  const anchoredBits = new Map<number, Set<number | undefined>>();
  let gapsTruncated = false;
  const recordGap = (gap: TemporalGap) => {
    const selection = selectionKey(gap.signal, gap.bit);
    if (gap.reason === "nodeBudget" || gap.reason === "edgeBudget") {
      frontier.add(gap.signal);
    } else if (gap.reason !== "staticBudget") {
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
      gap.orderAtTick,
      gap.historyCutoff,
      gap.anchor,
    ].join("/");
    if (gaps.has(key)) return;
    if (gaps.size < maxEdges) gaps.set(key, gap);
    else gapsTruncated = true;
  };
  const recordMissing = (
    signal: number,
    bit: number | undefined,
    tick: string,
    observation?: Observation,
    use?: TemporalGap["use"],
  ) => {
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
    ];
    return {
      schemaVersion: 1 as const,
      nodes,
      edges,
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
      history = observation ? recordedChanges(observation) : [];
      changeHistories.set(key, history);
    }
    return changesAtOrBefore(history, cutoff);
  };
  const rootChanges = observed(
    trace.root,
    rootView?.bit,
    BigInt(evidence.tick),
  );
  const requestedChanges =
    limits?.changeOrder === undefined
      ? rootChanges
      : rootChanges.filter(
          ({ tick, orderAtTick }) =>
            tick === evidence.tick && (orderAtTick ?? 1) === limits.changeOrder,
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
    trace.root,
    BigInt(evidence.tick),
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
            ? "operand:" + event.operandEvaluationOrdinal
            : event.beforeTick
              ? "before"
              : "sample"
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
  for (const { tick, value, orderAtTick } of heldWrite
    ? []
    : [...requestedChanges].reverse()) {
    const id = add(trace.root, {
      tick,
      value,
      orderAtTick,
      ...(rootView?.bit === undefined ? {} : { bit: rootView.bit }),
    });
    if (id === undefined) {
      recordGap({
        signal: trace.root,
        bit: rootView?.bit,
        tick,
        value,
        reason: "nodeBudget",
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
            event.signal,
            BigInt(event.tick),
            observed(event.signal, event.bit, BigInt(event.tick)),
            view(event.signal, event.bit),
            selectedElements.get(event.signal),
          );
    let candidates = traceCandidates.candidates.filter(
      ({ status, value }) =>
        status !== "contradictedByObservations" &&
        value?.targetChanged !== false,
    );
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
      const resolvedIndexes = new Map<AssignmentValue, bigint | undefined>();
      const resolveIndex = canResolveIndex
        ? (index: AssignmentValue) => {
            if (resolvedIndexes.has(index)) return resolvedIndexes.get(index);
            const accessed = new Set<number>();
            const evaluated = evaluateTraceValue(index, undefined, (id) => {
              accessed.add(id);
              return stableOperand(observations.get(id), sampleTick);
            });
            for (const signal of evaluated?.inputs ?? accessed)
              indexSignals.add(signal);
            const resolved =
              evaluated && traceInteger(evaluated.bits, evaluated.signed);
            resolvedIndexes.set(index, resolved);
            return resolved;
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
            Math.abs(event.bit - targetRange[1]),
            resolveIndex,
          );
        } else if (
          contributingRanges ||
          hasFixedModportMapping ||
          (resolveIndex && indexSignals.size) ||
          hasPackedSelection(assignment.value)
        ) {
          const width = Math.abs(targetRange[0] - targetRange[1]) + 1;
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
                slot,
                resolveIndex,
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
              const width = observations.get(signal)?.width;
              return width !== undefined && bits.size < width;
            });
            if (
              resolved &&
              (contributingRanges ||
                hasFixedModportMapping ||
                indexSignals.size ||
                narrowsRead)
            )
              bitReads = combined;
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
        const isIndex =
          parameter !== undefined ||
          indexSignals.has(input.signal) ||
          isPortIndex(assignment.port, input.signal);
        if (
          !isIndex &&
          input.kind === "data" &&
          !assignment.hasUnresolvedOperands &&
          candidate.value?.match &&
          !candidate.value.inputs.includes(input.signal)
        )
          continue;
        const selected =
          input.kind === "data" ? bitReads?.get(input.signal) : undefined;
        if (input.kind === "data" && bitReads && !selected && !isIndex)
          continue;
        const bits: (number | undefined)[] =
          selected && observations.get(input.signal)?.range
            ? [...selected]
            : [undefined];
        if (isIndex && !bits.includes(undefined)) bits.push(undefined);
        const use = {
          target,
          assignment: candidate.assignment,
          kind: input.kind,
          edge: input.kind === "trigger" ? input.edge : undefined,
        };
        const capturedOperand =
          (input.kind === "data" || input.kind === "control") &&
          !input.hierarchical &&
          !parameter
            ? recordedOperandValue(
                writer?.evaluation,
                assignment.instance,
                signalNames.get(input.signal),
              )
            : undefined;
        for (const bit of bits) {
          const upstream = view(input.signal, bit);
          const projectedDependency =
            upstream?.projected && (bit === undefined || upstream.bit !== bit);
          const usableHistory =
            upstream && !projectedDependency && !upstream.historyTruncated;
          if (projectedDependency) {
            recordGap({
              signal: input.signal,
              bit,
              tick: sampleTick,
              use,
              reason: "projectedDependency",
            });
          } else if (!parameter && !usableHistory) {
            recordMissing(input.signal, bit, sampleTick, upstream, use);
          }
          const latest =
            parameter || !usableHistory
              ? []
              : observed(input.signal, bit, tick);
          const concurrent = latest[0]?.tick === sampleTick;
          let stableWithoutChange = false;
          const possibilities: Omit<(typeof nodes)[number], "signal">[] = [];
          if (parameter) {
            possibilities.push({
              tick: sampleTick,
              value: parameter.bits,
              sampleOnly: true,
              elaboratedParameter: true,
            });
          } else if (usableHistory && input.kind === "trigger") {
            if (concurrent)
              for (const { tick, value, prior, orderAtTick } of latest) {
                if (matchesEdge(prior, value, input.edge) === true)
                  possibilities.push({ tick, value, orderAtTick });
              }
            if (
              !possibilities.length &&
              observeTrigger(input, upstream, sampleTick).match === null
            )
              recordGap({
                signal: input.signal,
                bit,
                tick: sampleTick,
                use,
                reason: "unprovenTrigger",
              });
          } else if (usableHistory) {
            if (
              concurrent &&
              (input.signal !== event.signal ||
                bit !== event.bit ||
                sampleTick !== event.tick)
            ) {
              for (const { tick, value, orderAtTick } of latest)
                possibilities.push({ tick, value, orderAtTick });
            }
            const prior = concurrent
              ? observed(input.signal, bit, tick - 1n).at(-1)
              : latest.at(-1);
            if (prior) {
              const { tick, value, orderAtTick } = prior;
              possibilities.push({ tick, value, orderAtTick });
            } else {
              const stable = concurrent
                ? previousValue(upstream, sampleTick)
                : valueAtStableTick(upstream, sampleTick);
              if (stable !== undefined) {
                stableWithoutChange = true;
                possibilities.push({
                  tick: sampleTick,
                  value: stable,
                  sampleOnly: true,
                  beforeTick: concurrent ? true : undefined,
                });
              } else {
                recordMissing(input.signal, bit, sampleTick, upstream, use);
              }
            }
          }
          const recordedSamples =
            input.kind === "data" &&
            recordedRhs?.samples.find(({ signal }) => signal === input.signal);
          const captured =
            capturedOperand === undefined
              ? undefined
              : bit === undefined
                ? capturedOperand
                : sliceTraceBits(capturedOperand, upstream?.range, bit, bit);
          const selectedIndex =
            input.signal === recordedElement?.signal && bit === undefined
              ? recordedElement.index
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
          const portTarget = directPort ? view(event.signal, event.bit) : undefined;
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
              (sample) =>
                observedBits(sample.value, upstream) === portValue,
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
          const selectedWidth = sourceRange
            ? Math.abs(sourceRange[0] - sourceRange[1]) + 1
            : upstream?.width;
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
              tick: sampleTick,
              use,
              reason: "noMatchingOperandChange",
            });
          let recordedSameValueWrite = false;
          if (captured !== undefined && writer?.evaluation) {
            const { ordinal } = writer.evaluation;
            const history = operandHistory?.(
              input.signal,
              sampleTick,
              ordinal,
              capturedOperand!,
              bit,
            );
            if (
              useRecordedRhs &&
              usableHistory &&
              history?.every((part) => part.writer)
            ) {
              let newerWrite = false;
              const compatibleHistory = history.every((part) => {
                const change = observed(input.signal, part.bit, tick).at(-1);
                if (!change)
                  return (
                    valueAtStableTick(
                      view(input.signal, part.bit),
                      sampleTick,
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
                tick: sampleTick,
                use,
                reason: "noMatchingOperandChange",
              });
            if (!useRecordedRhs || recordedSameValueWrite) {
              const fallback = {
                tick: sampleTick,
                sampleOnly: true as const,
                operandEvaluationOrdinal: ordinal,
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
              tick: sampleTick,
              use,
              reason: "noMatchingOperandChange",
            });
          }
          for (const sample of candidateSamples) {
            const normalized =
              upstream && observedBits(sample.value, upstream);
            if (
              selectedIndex === undefined &&
              useRecordedRhs &&
              !sample.executionOnly &&
              normalized !== undefined &&
              !compatibleValues.has(normalized)
            )
              continue;
            if (hasMatchingPortSample && normalized !== portValue) continue;
            if (
              selectedData &&
              (selectedValue === undefined ||
                (sourceRange && normalized
                  ? sliceTraceBits(normalized, upstream?.range, ...sourceRange)
                  : normalized) !== selectedValue)
            )
              continue;
            const timing =
              ("wordIndexUnordered" in input && input.wordIndexUnordered) ||
              (!sample.sampleOnly &&
                !sample.executionOnly &&
                sample.tick === sampleTick &&
                (input.kind !== "trigger" ||
                  latest.length > 1 ||
                  event.orderAtTick !== undefined))
                ? ("sameTickUnordered" as const)
                : undefined;
            const match =
              bit === undefined && input.kind === "data"
                ? rhsSamples
                    .get(input.signal)
                    ?.find(({ bits }) => bits === normalized)?.match
                : undefined;
            const properties: TemporalEdgeEvidence = {
              kind: input.kind,
              role:
                isIndex && bit === undefined ? ("index" as const) : undefined,
              ...(event.recordedWordWriters && writer
                ? { recordedCommitOrdinal: writer.commitOrdinal }
                : {}),
              confidence:
                concurrent && (input.kind !== "trigger" || timing)
                  ? ("possible" as const)
                  : candidate.status,
              timing,
              ...(recordedSameValueWrite
                ? ({ sourceWriteEvidence: "recordedSameValueWrite" } as const)
                : {}),
              ...(selectedIndex !== undefined
                ? ({ arrayIndexEvidence: "recordedTarget" } as const)
                : input.kind === "control" && captured !== undefined
                  ? ({ controlSampleEvidence: "recordedEvaluation" } as const)
                  : sample.operandEvaluationOrdinal !== undefined ||
                      sample.executionOnly ||
                      (useRecordedRhs && compatibleValues.has(normalized))
                    ? ({
                        rhsSample: "matches",
                        rhsSampleEvidence: "recordedEvaluation",
                      } as const)
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
              const cutoff = sample.beforeTick ? tick - 1n : tick;
              const seeded =
                historyBoundary >= 0n &&
                cutoff >= historyBoundary &&
                upstream?.initial?.value === sample.value &&
                upstream?.history.every(
                  ({ tick, value }) =>
                    BigInt(tick) > cutoff || value === sample.value,
                );
              recordGap({
                signal: input.signal,
                bit,
                tick: sampleTick,
                reason: "noChangeInWindow",
                value: sample.value,
                historyCutoff: seeded ? historyBoundary.toString() : undefined,
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
