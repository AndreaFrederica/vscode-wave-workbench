// SPDX-License-Identifier: MPL-2.0

import { createHash } from "node:crypto";
import { createReadStream, type BigIntStats } from "node:fs";
import { open, readFile, realpath, stat } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { VideTrace } from "./rtl-trace";
import {
  temporalTransitionKey,
  type buildTemporalTrace,
  type ObservedTraceWord,
  type RecordedCursorWrite,
  type RecordedModportComponent,
  type RecordedWriter,
  type RecordedWordAttribution,
  type RecordedWordWriter,
} from "./rtl-trace-candidates";
import type { readTraceObservations } from "./rtl-trace-observations";
import {
  evaluateTraceValue,
  normalizeBits,
  sliceTraceBits,
  traceInteger,
} from "./rtl-trace-values";
import { createMermaidFlowchart } from "./trace-mermaid";
import { codeOnly, vcsGuardEntry, vscOperandExpression } from "./rtl-selection";

const tickPattern = /^(?:0|[1-9]\d{0,19})$/;
const hashPattern = /^[a-f0-9]{64}$/;

export async function vcsExecutionStatements(
  trace: VideTrace,
  instance: string,
  signal: string,
  dirtyFiles: ReadonlySet<string>,
  captureOperands = false,
  captureGuards = false,
  captureGuardEntry = false,
) {
  const target = /^([A-Za-z_$][\w$]*)(?:\[(-?(?:0|[1-9]\d*))\])?$/.exec(signal);
  if (!target)
    throw Error("Choose a direct VCS signal or a concrete array word.");
  const [, name, word] = target;
  if (
    word !== undefined &&
    (!validExecutionRange([Number(word), Number(word)]) ||
      String(Number(word)) !== word ||
      trace.signals.find(({ id }) => id === trace.root)?.selectedElement !==
        Number(word))
  )
    throw Error(
      "The VCS design does not bind this signal to the selected array word.",
    );
  const digest = (value: string | Buffer) =>
    createHash("sha256").update(value).digest("hex");
  const sources = new Map<
    string,
    Promise<{ hash: string; code: string; text: string; starts: number[] }>
  >();
  const signals = new Map(trace.signals.map((entry) => [entry.id, entry]));
  const statements = [];
  for (const assignment of trace.assignments) {
    const { instance: owner, kind, location, process, targets } = assignment;
    const arrayIndex = assignment.targetElementIndex;
    const part =
      assignment.hierarchicalTargets?.length === 1
        ? assignment.hierarchicalTargets[0]
        : undefined;
    const value = assignment.value;
    const modport =
      word === undefined &&
      owner &&
      kind === "blocking" &&
      part?.signal === trace.root &&
      part.interfaceComponent &&
      part.interfacePath &&
      /^[A-Za-z_][\w$]*\.[A-Za-z_][\w$]*$/.test(part.interfacePath) &&
      value?.op === "slice" &&
      value.args[0].op === "cast" &&
      !assignment.hasUnresolvedOperands
        ? {
            owner,
            lhs: part.interfacePath,
            component: part.interfaceComponent[0],
            width: value.args[0].args[0],
            rhsRange: [value.args[1], value.args[2]] as [number, number],
          }
        : undefined;
    if (
      (!modport && owner !== instance) ||
      !targets.includes(trace.root) ||
      !process ||
      process.uri !== location.uri ||
      !location.uri.startsWith("file:") ||
      (kind !== "blocking" && kind !== "nonblocking") ||
      (word !== undefined &&
        (kind !== "nonblocking" || !arrayIndex || assignment.targetIndex))
    )
      continue;
    const file = fileURLToPath(location.uri);
    if (dirtyFiles.has(file))
      throw Error("Save the RTL source before generating its execution map.");
    let sourceFile = sources.get(file);
    if (!sourceFile) {
      sourceFile = readFile(file).then((bytes) => {
        const text = bytes.toString("utf8");
        return {
          hash: digest(bytes),
          code: codeOnly(text),
          text,
          starts: [
            0,
            ...Array.from(text.matchAll(/\n/g), ({ index }) => index + 1),
          ],
        };
      });
      sources.set(file, sourceFile);
    }
    const { hash, code, text, starts } = await sourceFile;
    const { line, character } = location.range.start;
    const start = starts[line] + character;
    if (modport) {
      const left =
        /^([A-Za-z_][\w$]*)\s*\.\s*([A-Za-z_][\w$]*)\s*(?==(?!=))/.exec(
          code.slice(start),
        );
      if (!left || left[1] + "." + left[2] !== modport.lhs) continue;
      const offset = start + left[0].length;
      const end = code.indexOf(";", offset + 1);
      if (
        end < 0 ||
        !/^\s*[A-Za-z_][\w$]*\s*$/.test(code.slice(offset + 1, end))
      )
        continue;
      const operatorLine =
        line + (code.slice(start, offset).match(/\n/g)?.length ?? 0);
      const source = {
        file,
        line: line + 1,
        column: character + 1,
        sha256: hash,
      };
      const operator = {
        file,
        line: operatorLine + 1,
        column: offset - starts[operatorLine] + 1,
      };
      const position = process.range.start;
      statements.push({
        kind,
        source,
        operator,
        modport,
        targetRange: assignment.targetRange,
        processId: digest(
          JSON.stringify([
            modport.owner,
            hash,
            position.line + 1,
            position.character + 1,
          ]),
        ),
        statementId: digest(
          JSON.stringify([
            instance,
            signal,
            kind,
            hash,
            source.line,
            source.column,
            modport.component,
          ]),
        ),
      });
      continue;
    }
    if (!code.startsWith(name, start)) continue;
    const token = kind === "blocking" ? "=" : "<=";
    let suffix = code.slice(start + name.length);
    let arrayElement: { selector: string } | undefined;
    let arraySelectionLength = 0;
    if (word !== undefined) {
      const selection = /^\s*\[\s*([A-Za-z_$][\w$]*|-?\d+)\s*\]/.exec(suffix);
      if (!selection) continue;
      const selector = selection[1];
      if (arrayIndex?.op === "signal") {
        if (signals.get(arrayIndex.args)?.name !== selector) continue;
      } else if (arrayIndex?.op === "literal") {
        const literal = evaluateTraceValue(
          arrayIndex,
          undefined,
          () => undefined,
        );
        if (
          selector !== word ||
          !literal ||
          traceInteger(literal.bits, literal.signed)?.toString() !== word
        )
          continue;
      } else continue;
      arrayElement = { selector };
      arraySelectionLength = selection[0].length;
      suffix = suffix.slice(arraySelectionLength);
    }
    const selection = /^\s*\[\s*(-?\d+)\s*(?::\s*(-?\d+)\s*)?\]/.exec(suffix);
    const dynamic =
      kind === "nonblocking" && assignment.targetIndex
        ? /^\s*\[\s*([A-Za-z_$][\w$]*)\s*(?:([+-]):\s*(\d+)\s*)?\]/.exec(suffix)
        : undefined;
    const targetIndexedPart = dynamic?.[2]
      ? assignment.targetIndexedPart
      : undefined;
    if (
      dynamic?.[2] &&
      (!targetIndexedPart ||
        targetIndexedPart.width !== Number(dynamic[3]) ||
        targetIndexedPart.ascendingIndices !== (dynamic[2] === "+"))
    )
      continue;
    const targetRange: [number, number] | undefined = selection
      ? [Number(selection[1]), Number(selection[2] ?? selection[1])]
      : undefined;
    if (
      targetRange &&
      (!validExecutionRange(targetRange) ||
        assignment.targetRange?.[0] !== targetRange[0] ||
        assignment.targetRange?.[1] !== targetRange[1])
    )
      continue;
    const selectionLength = (selection ?? dynamic)?.[0].length ?? 0;
    const spaces = /^\s*/.exec(suffix.slice(selectionLength))[0];
    const offset =
      start +
      name.length +
      arraySelectionLength +
      selectionLength +
      spaces.length;
    if (!code.startsWith(token, offset) || code[offset + token.length] === "=")
      continue;
    let sampleOperands: string[] | undefined;
    const canCaptureGuards = assignment.guards?.some(
      ({ expression }) =>
        (captureGuardEntry && arrayElement) ||
        (expression !== undefined && expression !== null),
    );
    const guardNames =
      kind === "nonblocking" &&
      !dynamic &&
      canCaptureGuards &&
      (captureGuards || (captureGuardEntry && arrayElement))
        ? [
            ...new Set(
              assignment.inputs.flatMap(({ kind, signal, hierarchical }) => {
                const input = signals.get(signal);
                return kind === "control" &&
                  !hierarchical &&
                  input &&
                  input.instance === owner &&
                  !input.parameterValue &&
                  /^[A-Za-z_][\w$]{0,63}$/.test(input.name)
                  ? [input.name]
                  : [];
              }),
            ),
          ]
        : [];
    const guardEntries = [];
    if (
      captureGuardEntry &&
      arrayElement &&
      guardNames.length &&
      guardNames.length <= 8
    ) {
      for (const guard of assignment.guards ?? []) {
        const { start: first, end: last } = guard.location.range;
        if (!last || guard.location.uri !== location.uri) continue;
        const from = starts[first.line] + first.character;
        const to = starts[last.line] + last.character;
        if (!vcsGuardEntry(code, from, to, start, guard.takenWhenTrue))
          continue;
        const names = [
          ...new Set(
            assignment.inputs.flatMap((input) => {
              if (
                input.kind !== "control" ||
                input.hierarchical ||
                input.location.uri !== location.uri
              )
                return [];
              const { line, character } = input.location.range.start;
              const index = starts[line] + character;
              const name = signals.get(input.signal)?.name;
              return name &&
                guardNames.includes(name) &&
                index >= from &&
                index < to &&
                (
                  "g" +
                  (first.line + 1) +
                  "_" +
                  (first.character + 1) +
                  (guard.takenWhenTrue ? "_" : "f_") +
                  name
                ).length <= 64
                ? [name]
                : [];
            }),
          ),
        ].sort();
        if (names.length)
          guardEntries.push({
            first: { line: first.line + 1, column: first.character + 1 },
            last: { line: last.line + 1, column: last.character + 1 },
            names,
            ...(!guard.takenWhenTrue ? { takenWhenTrue: false as const } : {}),
          });
      }
    }
    if (
      captureOperands &&
      kind === "nonblocking" &&
      !dynamic &&
      !arrayElement &&
      assignment.value &&
      (!assignment.hasUnresolvedOperands || assignment.unresolvedControlOnly)
    ) {
      const end = code.indexOf(";", offset + token.length);
      const expression =
        end >= 0
          ? vscOperandExpression(text.slice(offset + token.length, end))
          : undefined;
      if (expression) {
        const inputs = assignment.inputs.filter(
          (input) => input.kind === "data",
        );
        const bound = new Set(
          inputs.flatMap((input) => {
            const operand = signals.get(input.signal);
            return !input.hierarchical &&
              operand?.instance === owner &&
              !operand.parameterValue
              ? [operand.name]
              : [];
          }),
        );
        if (
          inputs.length === expression.names.length &&
          expression.names.every((name) => bound.has(name))
        )
          sampleOperands = expression.names;
      }
    }
    const guardsFit =
      guardNames.length > 0 &&
      new Set([...(sampleOperands ?? []), ...guardNames]).size <= 8;
    const operatorLine =
      line + (code.slice(start, offset).match(/\n/g)?.length ?? 0);
    const source = {
      file,
      line: line + 1,
      column: character + 1,
      sha256: hash,
    };
    const operator = {
      file,
      line: operatorLine + 1,
      column: offset - starts[operatorLine] + 1,
    };
    const position = process.range.start;
    statements.push({
      kind,
      source,
      operator,
      ...(targetRange ? { targetRange } : {}),
      ...(arrayElement ? { arrayElement } : {}),
      ...(dynamic ? { targetIndex: dynamic[1] } : {}),
      ...(targetIndexedPart ? { targetIndexedPart } : {}),
      ...(sampleOperands ? { sampleOperands } : {}),
      ...(guardsFit ? { sampleGuards: guardNames } : {}),
      ...(guardEntries.length &&
      guardEntries.reduce((count, entry) => count + entry.names.length, 0) <= 8
        ? { guardEntries }
        : {}),
      processId: digest(
        JSON.stringify([
          instance,
          hash,
          position.line + 1,
          position.character + 1,
        ]),
      ),
      statementId: digest(
        JSON.stringify([
          instance,
          signal,
          kind,
          hash,
          source.line,
          source.column,
        ]),
      ),
    });
  }
  return statements;
}
type EventKind =
  | "process-trigger"
  | "branch-taken"
  | "assignment-entered"
  | "assignment-evaluated"
  | "assignment-committed"
  | "assignment-unobserved"
  | "assignment-superseded"
  | "signal-value-changed";

type WriteKind = "blocking" | "nonblocking";

type ExternalStep = {
  statementId: string;
  operation: string;
  value?: string;
};

export interface ExecutionEvent {
  tick: string;
  ordinal: number;
  instance: string;
  processId?: string;
  statementId?: string;
  statementSite?: { file: string; line: number };
  kind: EventKind;
  signal?: string;
  targetRange?: [number, number];
  targetPackedRange?: [number, number];
  value?: string;
  writeKind?: WriteKind;
  timing?: "end-of-slot" | "simulator-commit";
  evaluationOrdinal?: number;
  replacementOrdinal?: number;
  externalSteps?: ExternalStep[];
  operandValues?: Record<string, string>;
  guardEntryValues?: Record<string, string>;
}

function validExecutionRange(value: unknown): value is [number, number] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    value.every(
      (index) =>
        Number.isInteger(index) && index >= -2147483648 && index <= 2147483647,
    ) &&
    Math.abs(value[0] - value[1]) < 4096
  );
}

function rangeWithin(
  range: readonly [number, number],
  layout: readonly [number, number],
) {
  const direction = layout[0] <= layout[1] ? 1 : -1;
  return (
    (range[0] - layout[0]) * direction >= 0 &&
    (range[1] - range[0]) * direction >= 0 &&
    (layout[1] - range[1]) * direction >= 0
  );
}

interface SourceStatement {
  file: string;
  line: number;
  column: number;
  sha256?: string;
}

type SourceIdentity = "matched" | "changed" | "missing" | "unverified";
type ResolvedSource = SourceStatement & { identity?: SourceIdentity };
export type ResolvedExternalStep = ExternalStep & { source: ResolvedSource };
type ResolvedEvent = ExecutionEvent & {
  source?: ResolvedSource;
  resolvedExternalSteps?: ResolvedExternalStep[];
};

interface TaskTransferProbes {
  instance: string;
  signal: string;
  input: string;
  inputIndex: string;
  write: string;
  writeIndex: string;
  fileReads: string[];
}

export type RecordedTaskTransfer = {
  index: number;
  input: { tick: string; ordinal: number; source: ResolvedSource };
  write: { tick: string; ordinal: number; source: ResolvedSource };
  reads: (ResolvedExternalStep & { tick: string; ordinal: number })[];
};

export function isTaskTransferProbes(
  value: unknown,
): value is TaskTransferProbes {
  if (!value || typeof value !== "object") return false;
  const probes = value as TaskTransferProbes;
  const name = "[A-Za-z_$][\\w$]*(?:\\[-?\\d+\\])?";
  const instance = new RegExp("^" + name + "(?:\\." + name + ")*$");
  const ids = [
    probes.input,
    probes.inputIndex,
    probes.write,
    probes.writeIndex,
  ];
  return (
    typeof probes.instance === "string" &&
    instance.test(probes.instance) &&
    typeof probes.signal === "string" &&
    /^[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*$/.test(probes.signal) &&
    ids.every((id) => typeof id === "string" && hashPattern.test(id)) &&
    new Set(ids).size === ids.length &&
    Array.isArray(probes.fileReads) &&
    probes.fileReads.length > 0 &&
    probes.fileReads.length <= 16 &&
    probes.fileReads.every(
      (id) => typeof id === "string" && /^[\w.-]{1,128}$/.test(id),
    )
  );
}

interface ExecutionCoverage {
  start: string;
  instance: string;
  signal: string;
  writers: string[];
}

interface ExecutionHeader {
  schemaVersion: 1;
  format: "wave-workbench-execution";
  buildId: string;
  waveformSha256: string;
  scale: string;
  statements: Record<string, SourceStatement>;
  coverage?: ExecutionCoverage | ExecutionCoverage[];
  observationCoverage?: { start: string; signals: ExecutionSignal[] };
  taskTransferProbes?: TaskTransferProbes;
}

interface ReplayCheckpoint {
  offset: number;
  tick: bigint;
  ordinal: number;
  contiguous: boolean;
  signals: {
    latestCommit?: ResolvedEvent;
    lastUnobservedOrdinal?: number;
    unexpectedWriters: string[];
  }[];
}

export type ExecutionSignal = { instance: string; signal: string };

const executionSignalKey = ({ instance, signal }: ExecutionSignal) =>
  JSON.stringify([instance, signal]);

export class ExecutionRecordingIdentityError extends Error {}

type ReplaySignal = {
  target: ExecutionSignal;
  coverage?: ExecutionCoverage;
  latestCommit?: ResolvedEvent;
  lastUnobservedOrdinal?: number;
  unobservedInWindow?: boolean;
  unexpectedWriters: Set<string>;
  cursorWriters: Set<string>;
  events: ResolvedEvent[];
  evaluations: Map<number, ExecutionEvent>;
  truncated: boolean;
};

const replayIndex = new Map<
  string,
  {
    fingerprint: string;
    header: ExecutionHeader;
    checkpoints: ReplayCheckpoint[];
  }
>();

const eventKinds = new Set<EventKind>([
  "process-trigger",
  "branch-taken",
  "assignment-entered",
  "assignment-evaluated",
  "assignment-committed",
  "assignment-unobserved",
  "assignment-superseded",
  "signal-value-changed",
]);

function isCoverage(value: unknown): value is ExecutionCoverage {
  const entry = value as ExecutionCoverage;
  return (
    !!entry &&
    typeof entry.start === "string" &&
    tickPattern.test(entry.start) &&
    typeof entry.instance === "string" &&
    !!entry.instance &&
    typeof entry.signal === "string" &&
    !!entry.signal &&
    Array.isArray(entry.writers) &&
    entry.writers.length > 0 &&
    entry.writers.every((writer) => typeof writer === "string" && !!writer)
  );
}

export function isObservationCoverage(
  value: unknown,
): value is NonNullable<ExecutionHeader["observationCoverage"]> {
  const entry = value as ExecutionHeader["observationCoverage"];
  return (
    !!entry &&
    typeof entry.start === "string" &&
    tickPattern.test(entry.start) &&
    Array.isArray(entry.signals) &&
    entry.signals.length > 0 &&
    entry.signals.length <= 64 &&
    entry.signals.every(
      (signal) =>
        !!signal &&
        typeof signal.instance === "string" &&
        !!signal.instance &&
        typeof signal.signal === "string" &&
        !!signal.signal,
    ) &&
    new Set(entry.signals.map(executionSignalKey)).size === entry.signals.length
  );
}

function isHeader(value: unknown): value is ExecutionHeader {
  const header = value as ExecutionHeader;
  return (
    !!header &&
    header.format === "wave-workbench-execution" &&
    header.schemaVersion === 1 &&
    typeof header.buildId === "string" &&
    header.buildId.length > 0 &&
    typeof header.waveformSha256 === "string" &&
    hashPattern.test(header.waveformSha256) &&
    typeof header.scale === "string" &&
    !!header.statements &&
    !Array.isArray(header.statements) &&
    typeof header.statements === "object" &&
    Object.values(header.statements).every(
      (source) =>
        !!source &&
        typeof source.file === "string" &&
        source.file.length > 0 &&
        Number.isSafeInteger(source.line) &&
        source.line > 0 &&
        Number.isSafeInteger(source.column) &&
        source.column > 0 &&
        (source.sha256 === undefined ||
          (typeof source.sha256 === "string" &&
            hashPattern.test(source.sha256))),
    ) &&
    (header.coverage === undefined ||
      (Array.isArray(header.coverage)
        ? header.coverage.every(isCoverage) &&
          new Set(
            header.coverage.map(({ instance, signal }) =>
              JSON.stringify([instance, signal]),
            ),
          ).size === header.coverage.length
        : isCoverage(header.coverage))) &&
    (header.observationCoverage === undefined ||
      isObservationCoverage(header.observationCoverage)) &&
    (header.taskTransferProbes === undefined ||
      isTaskTransferProbes(header.taskTransferProbes))
  );
}

function finishesEvaluation(event: ExecutionEvent) {
  return (
    event.kind === "assignment-committed" ||
    event.kind === "assignment-superseded" ||
    event.kind === "assignment-unobserved"
  );
}

function isExternalStep(value: unknown): value is ExternalStep {
  const step = value as ExternalStep;
  return (
    !!step &&
    typeof step.statementId === "string" &&
    /^[\w.-]{1,128}$/.test(step.statementId) &&
    typeof step.operation === "string" &&
    /^[ -~]{1,128}$/.test(step.operation) &&
    (step.value === undefined ||
      (typeof step.value === "string" && /^[01xz]{1,4096}$/i.test(step.value)))
  );
}

export function isExecutionEvent(value: unknown): value is ExecutionEvent {
  const event = value as ExecutionEvent;
  if (
    !(
      !!event &&
      typeof event.tick === "string" &&
      tickPattern.test(event.tick) &&
      Number.isSafeInteger(event.ordinal) &&
      event.ordinal >= 0 &&
      typeof event.instance === "string" &&
      event.instance.length > 0 &&
      !Object.hasOwn(event, "resolvedExternalSteps") &&
      eventKinds.has(event.kind)
    )
  )
    return false;
  if (event.targetRange !== undefined) {
    if (
      (!finishesEvaluation(event) && event.kind !== "assignment-evaluated") ||
      !validExecutionRange(event.targetRange) ||
      (event.value !== undefined &&
        (typeof event.value !== "string" ||
          event.value.length !==
            Math.abs(event.targetRange[0] - event.targetRange[1]) + 1))
    )
      return false;
  }
  if (
    event.targetPackedRange !== undefined &&
    (event.kind !== "assignment-committed" ||
      !event.targetRange ||
      !validExecutionRange(event.targetPackedRange) ||
      !rangeWithin(event.targetRange, event.targetPackedRange))
  )
    return false;
  for (const [field, values] of [
    ["operands", event.operandValues],
    ["guards", event.guardEntryValues],
  ] as const) {
    if (values === undefined) continue;
    if (
      event.kind !== "assignment-evaluated" ||
      !values ||
      typeof values !== "object" ||
      Array.isArray(values)
    )
      return false;
    const entries = Object.entries(values);
    if (
      !entries.length ||
      entries.length > 8 ||
      !entries.every(
        ([name, bits]) =>
          /^[A-Za-z_][\w$]{0,63}$/.test(name) &&
          (field !== "guards" ||
            /^g[1-9]\d*_[1-9]\d*f?_[A-Za-z_][\w$]*$/.test(name)) &&
          typeof bits === "string" &&
          /^[01xz]{1,4096}$/i.test(bits),
      )
    )
      return false;
  }
  if (event.kind === "assignment-entered") {
    const site = event.statementSite;
    return (
      typeof event.statementId === "string" &&
      /^vcs-\d+$/.test(event.statementId) &&
      !!site &&
      typeof site.file === "string" &&
      site.file.length > 0 &&
      site.file.length <= 4096 &&
      !site.file.includes("\0") &&
      Number.isSafeInteger(site.line) &&
      site.line > 0 &&
      (event.signal === undefined ||
        (typeof event.signal === "string" && !!event.signal)) &&
      (event.writeKind === "blocking" || event.writeKind === "nonblocking") &&
      event.processId === undefined &&
      event.value === undefined &&
      event.timing === undefined &&
      event.evaluationOrdinal === undefined &&
      event.replacementOrdinal === undefined &&
      event.externalSteps === undefined
    );
  }
  if (event.statementSite !== undefined) return false;
  if (event.kind === "signal-value-changed")
    return (
      typeof event.signal === "string" &&
      !!event.signal &&
      typeof event.value === "string" &&
      /^[01xz]+$/i.test(event.value) &&
      event.processId === undefined &&
      event.statementId === undefined &&
      event.writeKind === undefined &&
      event.timing === undefined &&
      event.evaluationOrdinal === undefined &&
      event.replacementOrdinal === undefined &&
      event.externalSteps === undefined
    );
  return (
    typeof event.processId === "string" &&
    event.processId.length > 0 &&
    (event.kind === "process-trigger" ||
      (typeof event.statementId === "string" &&
        event.statementId.length > 0)) &&
    (event.signal === undefined || typeof event.signal === "string") &&
    ((event.kind !== "assignment-evaluated" && !finishesEvaluation(event)) ||
      !!event.signal) &&
    (event.value === undefined ||
      (typeof event.value === "string" && /^[01xz]+$/i.test(event.value))) &&
    (event.externalSteps === undefined ||
      (event.kind === "assignment-evaluated" &&
        Array.isArray(event.externalSteps) &&
        event.externalSteps.length > 0 &&
        event.externalSteps.length <= 64 &&
        event.externalSteps.every(isExternalStep))) &&
    (event.writeKind === undefined ||
      event.writeKind === "blocking" ||
      event.writeKind === "nonblocking") &&
    (event.timing === undefined ||
      (event.kind === "assignment-committed" &&
        (event.timing === "end-of-slot" ||
          (event.timing === "simulator-commit" &&
            event.writeKind === "nonblocking")))) &&
    (event.kind === "assignment-superseded"
      ? event.writeKind === "nonblocking" &&
        event.value === undefined &&
        Number.isSafeInteger(event.replacementOrdinal) &&
        event.replacementOrdinal! > event.evaluationOrdinal! &&
        event.replacementOrdinal! < event.ordinal
      : event.replacementOrdinal === undefined) &&
    (event.kind !== "assignment-unobserved" ||
      ((event.writeKind === "blocking" || event.writeKind === "nonblocking") &&
        event.value === undefined)) &&
    (!finishesEvaluation(event) ||
      (Number.isSafeInteger(event.evaluationOrdinal) &&
        event.evaluationOrdinal! >= 0 &&
        event.evaluationOrdinal! < event.ordinal))
  );
}

const fileHashes = new Map<
  string,
  { fingerprint: string; hash: Promise<string> }
>();

function hashFingerprint(info: BigIntStats) {
  return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(":");
}

export async function waveformHash(file: string) {
  const filename = await realpath(file);
  const info = await stat(filename, { bigint: true });
  if (!info.isFile())
    throw Error("Expected a regular file for SHA-256 verification.");
  const fingerprint = hashFingerprint(info);
  const cached = fileHashes.get(filename);
  if (cached?.fingerprint === fingerprint) return cached.hash;
  const hash = (async () => {
    const handle = await open(filename);
    try {
      if (hashFingerprint(await handle.stat({ bigint: true })) !== fingerprint)
        throw Error("File changed before SHA-256 verification.");
      const digest = createHash("sha256");
      for await (const chunk of handle.createReadStream({ autoClose: false }))
        digest.update(chunk);
      if (
        hashFingerprint(await handle.stat({ bigint: true })) !== fingerprint ||
        hashFingerprint(await stat(filename, { bigint: true })) !== fingerprint
      )
        throw Error("File changed during SHA-256 verification.");
      return digest.digest("hex");
    } finally {
      await handle.close();
    }
  })();
  fileHashes.set(filename, { fingerprint, hash });
  if (fileHashes.size > 32) fileHashes.delete(fileHashes.keys().next().value!);
  try {
    return await hash;
  } catch (error) {
    if (fileHashes.get(filename)?.hash === hash) fileHashes.delete(filename);
    throw error;
  }
}

async function executionSourceIdentity(
  statement: SourceStatement,
): Promise<SourceIdentity> {
  if (!statement.sha256) return "unverified";
  try {
    if (!(await stat(statement.file)).isFile()) return "unverified";
    return (await waveformHash(statement.file)) === statement.sha256
      ? "matched"
      : "changed";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? "missing"
      : "unverified";
  }
}

async function* executionLines(
  file: string,
  start: number,
  operation?: AbortSignal,
) {
  const stream = createReadStream(file, { start, signal: operation });
  const maxLine = 4 * 1024 * 1024;
  let pending: Buffer = Buffer.alloc(0);
  let offset = start;
  for await (const bytes of stream) {
    operation?.throwIfAborted();
    const block = pending.length
      ? Buffer.concat([pending, bytes])
      : (bytes as Buffer);
    let from = 0;
    for (let end = block.indexOf(10); end >= 0; end = block.indexOf(10, from)) {
      if (end - from > maxLine)
        throw Error("Execution trace record is too large.");
      offset += end - from + 1;
      yield { line: block.toString("utf8", from, end), offset };
      from = end + 1;
    }
    pending = block.subarray(from);
    if (pending.length > maxLine)
      throw Error("Execution trace record is too large.");
  }
  if (pending.length)
    yield { line: pending.toString("utf8"), offset: offset + pending.length };
}

export function reconcileRecordedWordHistory(
  observation: Awaited<
    ReturnType<typeof readTraceObservations>
  >["observations"][number],
  recording: Awaited<ReturnType<typeof readExecutionEvidence>>,
  start: string,
  end: string,
) {
  if (
    observation.projected ||
    observation.historyTruncated ||
    recording.truncated ||
    recording.waveformMatch !== "verified" ||
    recording.observationCoverage?.status !== "complete"
  )
    return;
  const width = observation.width;
  const callbackSamples = recording.events.flatMap((event) =>
    event.kind === "signal-value-changed" && BigInt(event.tick) <= BigInt(end)
      ? [
          {
            tick: event.tick,
            value: normalizeBits(event.value, width),
            ordinal: event.ordinal,
          },
        ]
      : [],
  );
  if (
    !callbackSamples.length ||
    callbackSamples.some(({ value }) => value === undefined)
  )
    return;
  const initial = callbackSamples.findLast(
    ({ tick }) => BigInt(tick) < BigInt(start),
  );
  const history = callbackSamples.filter(
    ({ tick }) => BigInt(tick) >= BigInt(start),
  );
  const normalizedInitial = normalizeBits(observation.initial?.value, width);
  if (
    (initial && initial.value !== normalizedInitial) ||
    (!initial && observation.initial && recording.start !== start)
  )
    return;
  const waveform = observation.history.map(({ tick, value }) => ({
    tick,
    value: normalizeBits(value, width),
  }));
  if (waveform.some(({ value }) => value === undefined)) return;

  function slotChanges<T extends { tick: string; value?: string }>(
    samples: T[],
  ) {
    const slots = new Map<string, T[]>();
    let prior = normalizedInitial;
    for (const sample of samples) {
      const { tick, value } = sample;
      if (value === prior) continue;
      const changes = slots.get(tick) ?? [];
      changes.push(sample);
      slots.set(tick, changes);
      prior = value;
    }
    return slots;
  }
  const recordedChanges = slotChanges(history);
  const dumpedChanges = slotChanges(waveform);
  const restoredTicks = new Set<string>();
  const ticks = [
    ...new Set([...recordedChanges.keys(), ...dumpedChanges.keys()]),
  ].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
  let prior = normalizedInitial;
  for (const tick of ticks) {
    const recorded = recordedChanges.get(tick) ?? [];
    const dumped = dumpedChanges.get(tick) ?? [];
    const finalValue = recorded.at(-1)?.value ?? prior;
    if (finalValue !== (dumped.at(-1)?.value ?? prior)) return;
    let index = 0;
    // Some readers keep a subset of a slot's changes. Each retained transition
    // must be present in the same order before adding any missing callbacks.
    for (const { value } of dumped) {
      const match = recorded.findIndex(
        (sample, offset) => offset >= index && sample.value === value,
      );
      if (match < 0) return;
      index = match + 1;
    }
    if (recorded.length > dumped.length) restoredTicks.add(tick);
    prior = finalValue;
  }
  if (!restoredTicks.size) return;
  const changes = new Map(
    [...recordedChanges].map(([tick, samples]) => [
      tick,
      samples
        .filter(
          (sample) => sample !== history[0] || normalizedInitial !== undefined,
        )
        .map(({ ordinal, value }) => ({ ordinal, value: value! })),
    ]),
  );
  return {
    history: history.map(({ tick, value }) => ({ tick, value })),
    changes,
    restoredTicks,
  };
}

export function restoreRecordedSignalHistory(
  evidence: Awaited<ReturnType<typeof readTraceObservations>>,
  recordings: ReadonlyMap<
    number,
    Awaited<ReturnType<typeof readExecutionEvidence>>
  >,
) {
  let wholeRoot = evidence.wholeRoot;
  let restored = false;
  const observations = evidence.observations.map((item) => {
    const recording = recordings.get(item.signal);
    const whole = item.projected ? wholeRoot : item;
    const bit = item.bit;
    if (
      !recording ||
      !whole ||
      whole.signal !== item.signal ||
      item.status !== "observed" ||
      item.historyTruncated ||
      item.historyLimitedToTransition ||
      (item.projected && (bit === undefined || item.width !== 1))
    )
      return item;
    const refined = reconcileRecordedWordHistory(
      whole,
      recording,
      evidence.historyStart,
      evidence.historyEnd,
    );
    if (!refined) return item;
    // Commit replay owns slots with a recorded commit for this signal.
    if (
      recording.events.some(
        ({ tick, kind }) =>
          kind === "assignment-committed" && refined.restoredTicks.has(tick),
      )
    )
      return item;
    function withHistory(
      observation: typeof item,
      history: typeof refined.history,
    ) {
      const cursor = observation.cursorSamples;
      return {
        ...observation,
        history,
        ...(cursor &&
          !cursor.truncated &&
          evidence.historyEnd === evidence.tick && {
            cursorSamples: {
              ...cursor,
              events: history.filter(({ tick }) => tick === evidence.tick),
            },
          }),
      };
    }
    if (!item.projected || bit === undefined) {
      restored = true;
      return withHistory(item, refined.history);
    }
    const projected = refined.history.map(({ tick, value }) => ({
      tick,
      value: value && sliceTraceBits(value, whole.range, bit, bit),
    }));
    if (projected.some(({ value }) => value === undefined)) return item;
    wholeRoot = withHistory(whole, refined.history);
    restored = true;
    return withHistory(item, projected);
  });
  return restored ? { ...evidence, observations, wholeRoot } : undefined;
}

export async function attachRecordedTaskTransfers(
  filename: string,
  waveform: string,
  scale: string,
  tick: string,
  trace: VideTrace,
  graph: ReturnType<typeof buildTemporalTrace>,
  dirtySources: ReadonlySet<string>,
  operation?: AbortSignal,
) {
  const file = await realpath(filename);
  const fingerprint = hashFingerprint(await stat(file, { bigint: true }));
  const end = BigInt(tick);
  let header: ExecutionHeader | undefined;
  let ordinal = 0;
  let lastTick = 0n;
  let complete = false;
  const events = new Map<number, ExecutionEvent>();
  const callbacks = new Map<string, ExecutionEvent[]>();
  const probes = new Set<string>();
  let callbackInstance = "";
  let callbackSignal = "";
  let retained = 0;
  for await (const { line } of executionLines(file, 0, operation)) {
    if (!line.trim()) continue;
    const data = JSON.parse(line);
    if (!header) {
      if (!isHeader(data)) throw Error("Unsupported execution trace header.");
      if (!data.taskTransferProbes) return;
      header = data;
      if (
        header.scale !== scale ||
        header.waveformSha256 !== (await waveformHash(waveform))
      )
        throw new ExecutionRecordingIdentityError(
          "Execution task recording does not match the waveform.",
        );
      const config = data.taskTransferProbes;
      for (const id of [
        config.input,
        config.inputIndex,
        config.write,
        config.writeIndex,
      ])
        probes.add(id);
      callbackInstance = config.instance + "." + config.signal.split(".")[0];
      callbackSignal = config.signal.split(".")[1];
      if (
        !header.observationCoverage?.signals.some(
          ({ instance, signal }) =>
            instance === callbackInstance && signal === callbackSignal,
        )
      )
        return;
      continue;
    }
    if (data?.type === "end") {
      complete =
        data.eventCount === ordinal &&
        typeof data.tick === "string" &&
        tickPattern.test(data.tick) &&
        BigInt(data.tick) >= lastTick &&
        BigInt(data.tick) >= end;
      break;
    }
    if (
      !isExecutionEvent(data) ||
      data.ordinal !== ordinal++ ||
      BigInt(data.tick) < lastTick
    )
      return;
    lastTick = BigInt(data.tick);
    if (lastTick > end) {
      complete = true;
      break;
    }
    const config = header.taskTransferProbes!;
    if (
      data.kind === "signal-value-changed" &&
      data.instance === callbackInstance &&
      data.signal === callbackSignal
    ) {
      const samples = callbacks.get(data.tick) ?? [];
      samples.push(data);
      callbacks.set(data.tick, samples);
      retained++;
    }
    if (
      data.instance === config.instance &&
      (probes.has(data.statementId ?? "") ||
        data.externalSteps?.some((step) =>
          config.fileReads.includes(step.statementId),
        ) ||
        (data.evaluationOrdinal !== undefined &&
          events.has(data.evaluationOrdinal)))
    ) {
      events.set(data.ordinal, data);
      retained++;
    }
    if (retained > 32768) return;
  }
  if (
    !header?.taskTransferProbes ||
    !complete ||
    fingerprint !== hashFingerprint(await stat(file, { bigint: true }))
  )
    return;
  const config = header.taskTransferProbes;
  const sources = new Map<string, Promise<ResolvedSource | undefined>>();
  function resolveSource(id: string) {
    let pending = sources.get(id);
    if (!pending) {
      pending = (async () => {
        const mapping = header!.statements[id];
        if (!mapping) return;
        const source = {
          ...mapping,
          file: path.resolve(path.dirname(file), mapping.file),
        };
        if (
          !dirtySources.has(source.file) &&
          (await executionSourceIdentity(source)) === "matched"
        )
          return { ...source, identity: "matched" as const };
      })();
      sources.set(id, pending);
    }
    return pending;
  }
  const [
    inputSource,
    writeSource,
    inputIndexSource,
    writeIndexSource,
    ...readSources
  ] = await Promise.all(
    [
      config.input,
      config.write,
      config.inputIndex,
      config.writeIndex,
      ...config.fileReads,
    ].map(resolveSource),
  );
  if (
    !inputSource ||
    !writeSource ||
    !inputIndexSource ||
    !writeIndexSource ||
    readSources.some((source) => !source)
  )
    return;
  const field = graph.recordedFieldSignals?.find(
    ({ instance, name }) =>
      instance === config.instance && name === config.signal,
  );
  if (!field) return;
  function containsSource(
    location: VideTrace["assignments"][number]["location"],
    source: ResolvedSource,
  ) {
    const { start, end } = location.range;
    return (
      location.uri.startsWith("file:") &&
      fileURLToPath(location.uri) === source.file &&
      start.line === source.line - 1 &&
      start.character <= source.column - 1 &&
      (!end || end.line > start.line || end.character > source.column - 1)
    );
  }
  const writers = trace.assignments.filter(
    (assignment) =>
      assignment.instance === config.instance &&
      assignment.kind === "blocking" &&
      assignment.targetField?.signal === field.signal &&
      assignment.targetField.field === field.field &&
      assignment.fieldValue?.op === "signal" &&
      containsSource(assignment.location, writeSource),
  );
  const formal =
    writers.length === 1 && writers[0].fieldValue?.op === "signal"
      ? writers[0].fieldValue.args
      : undefined;
  if (
    formal === undefined ||
    !trace.assignments.some(
      (assignment) =>
        assignment.kind === "taskInput" &&
        assignment.instance === config.instance &&
        assignment.targets.includes(formal) &&
        containsSource(assignment.location, inputSource),
    )
  )
    return;

  function collect(statement: string, marker: string) {
    const transfers = new Map<
      number,
      { commit: ExecutionEvent; evaluation: ExecutionEvent } | null
    >();
    for (const commit of events.values()) {
      if (
        commit.statementId !== statement ||
        commit.kind !== "assignment-committed"
      )
        continue;
      const evaluation = events.get(commit.evaluationOrdinal ?? -1);
      const indexEvaluation = events.get(commit.ordinal + 1);
      const indexCommit = events.get(commit.ordinal + 2);
      if (
        evaluation?.kind !== "assignment-evaluated" ||
        evaluation.statementId !== statement ||
        evaluation.tick !== commit.tick ||
        !evaluation.value ||
        evaluation.value !== commit.value ||
        indexEvaluation?.kind !== "assignment-evaluated" ||
        indexEvaluation.statementId !== marker ||
        indexCommit?.kind !== "assignment-committed" ||
        indexCommit.statementId !== marker ||
        indexCommit.evaluationOrdinal !== indexEvaluation.ordinal ||
        indexEvaluation.tick !== commit.tick ||
        indexCommit.tick !== commit.tick ||
        !indexCommit.value ||
        indexEvaluation.value !== indexCommit.value ||
        !/^[01]{1,32}$/.test(indexCommit.value)
      )
        continue;
      const index = Number.parseInt(indexCommit.value, 2);
      transfers.set(
        index,
        transfers.has(index) ? null : { commit, evaluation },
      );
    }
    return transfers;
  }
  const inputs = collect(config.input, config.inputIndex);
  const writes = collect(config.write, config.writeIndex);
  const outcomes = new Map<number, ExecutionEvent | null>();
  for (const event of events.values()) {
    if (!finishesEvaluation(event) || event.evaluationOrdinal === undefined)
      continue;
    const evaluation = event.evaluationOrdinal;
    outcomes.set(evaluation, outcomes.has(evaluation) ? null : event);
  }
  const bytes = new Map<
    number,
    {
      step: RecordedTaskTransfer["reads"][number];
      commitOrdinal: number;
    } | null
  >();
  for (const event of events.values()) {
    if (event.kind !== "assignment-evaluated") continue;
    const commit = outcomes.get(event.ordinal);
    if (
      commit?.kind !== "assignment-committed" ||
      commit.statementId !== event.statementId ||
      commit.processId !== event.processId ||
      commit.signal !== event.signal ||
      commit.tick !== event.tick ||
      commit.value !== event.value
    )
      continue;
    for (const step of event.externalSteps ?? []) {
      const source = readSources[config.fileReads.indexOf(step.statementId)];
      if (!source || !step.value || !/^[01]{8}$/.test(step.value)) continue;
      const offset = Number(
        /^\$fgetc at byte (\d+)$/.exec(step.operation)?.[1],
      );
      if (Number.isSafeInteger(offset))
        bytes.set(
          offset,
          bytes.has(offset)
            ? null
            : {
                step: {
                  ...step,
                  tick: event.tick,
                  ordinal: event.ordinal,
                  source,
                },
                commitOrdinal: commit.ordinal,
              },
        );
    }
  }
  const transfersByCallback = new Map<number, RecordedTaskTransfer | null>();
  for (const [index, write] of writes) {
    const input = inputs.get(index);
    const value = input?.evaluation.value;
    if (
      !write ||
      !input ||
      !value ||
      value !== write.evaluation.value ||
      input.commit.ordinal >= write.evaluation.ordinal ||
      value.length % 8 ||
      index < value.length / 8
    )
      continue;
    const samples = callbacks.get(write.commit.tick);
    const callback = samples?.filter(
      ({ ordinal, value: observed }) =>
        ordinal > write.evaluation.ordinal &&
        ordinal < write.commit.ordinal &&
        normalizeBits(observed, value.length) === value,
    );
    if (callback?.length !== 1) continue;
    const byteWrites = Array.from({ length: value.length / 8 }, (_, lane) =>
      bytes.get(index - value.length / 8 + lane),
    );
    if (
      byteWrites.some(
        (read) => !read || read.commitOrdinal >= input.evaluation.ordinal,
      )
    )
      continue;
    const reads = byteWrites.flatMap((read) => (read ? [read.step] : []));
    if (
      [...reads]
        .reverse()
        .map((read) => read.value)
        .join("") !== value
    )
      continue;
    const callbackOrdinal = callback[0].ordinal;
    transfersByCallback.set(
      callbackOrdinal,
      transfersByCallback.has(callbackOrdinal)
        ? null
        : {
            index,
            input: {
              tick: input.commit.tick,
              ordinal: input.commit.ordinal,
              source: inputSource,
            },
            write: {
              tick: write.commit.tick,
              ordinal: write.commit.ordinal,
              source: writeSource,
            },
            reads,
          },
    );
  }
  for (const node of graph.nodes) {
    if (node.signal !== field.id || node.bit !== undefined || node.sampleOnly)
      continue;
    const samples = callbacks.get(node.tick);
    if (!samples || (node.orderAtTick === undefined && samples.length !== 1))
      continue;
    const callback = samples[(node.orderAtTick ?? 1) - 1];
    if (
      !callback?.value ||
      normalizeBits(node.value, callback.value.length) !== callback.value
    )
      continue;
    const transfer = transfersByCallback.get(callback.ordinal);
    if (transfer) node.recordedTaskTransfer = transfer;
  }
}

export async function readExecutionEvidence(
  filename: string,
  waveform: string | undefined,
  scale: string | undefined,
  instance: string,
  signal: string,
  start: string,
  end: string,
  limit = 256,
  operation?: AbortSignal,
) {
  const [evidence] = await readExecutionEvidenceBatch(
    filename,
    waveform,
    scale,
    [{ instance, signal }],
    start,
    end,
    limit,
    operation,
  );
  return evidence;
}

export async function readExecutionEvidenceBatch(
  filename: string,
  waveform: string | undefined,
  scale: string | undefined,
  targets: readonly ExecutionSignal[],
  start: string,
  end: string,
  limit = 256,
  operation?: AbortSignal,
) {
  operation?.throwIfAborted();
  if (
    !tickPattern.test(start) ||
    !tickPattern.test(end) ||
    BigInt(start) > BigInt(end)
  ) {
    throw Error("Invalid execution trace tick window.");
  }
  const source = await realpath(filename);
  const info = await stat(source, { bigint: true });
  if (!info.isFile()) throw Error("Execution trace must be a regular file.");
  const lower = BigInt(start);
  const upper = BigInt(end);
  const fingerprint = hashFingerprint(info);
  const indexKey = JSON.stringify([source, targets]);
  const stored = replayIndex.get(indexKey);
  const checkpoint =
    stored?.fingerprint === fingerprint
      ? stored.checkpoints.findLast((entry) => entry.tick < lower)
      : undefined;
  const checkpoints: ReplayCheckpoint[] = [];
  let indexedOffset = checkpoint?.offset ?? 0;
  let header = checkpoint ? stored?.header : undefined;
  let lastTick = checkpoint?.tick ?? -1n;
  let lastOrdinal = checkpoint?.ordinal ?? -1;
  let checkedThrough: bigint | undefined;
  let contiguous = checkpoint?.contiguous ?? true;
  const signals: ReplaySignal[] = targets.map((target, index) => ({
    target,
    latestCommit: checkpoint?.signals[index]?.latestCommit,
    lastUnobservedOrdinal: checkpoint?.signals[index]?.lastUnobservedOrdinal,
    unexpectedWriters: new Set(checkpoint?.signals[index]?.unexpectedWriters),
    cursorWriters: new Set(),
    events: [],
    evaluations: new Map(),
    truncated: false,
  }));
  const byInstance = new Map<string, ReplaySignal[]>();
  const bySignal = new Map<string, Map<string, ReplaySignal[]>>();
  let observedSignals: Set<string> | undefined;
  for (const signal of signals) {
    const { instance, signal: name } = signal.target;
    const scope = byInstance.get(instance) ?? [];
    scope.push(signal);
    byInstance.set(instance, scope);
    const names = bySignal.get(instance) ?? new Map<string, ReplaySignal[]>();
    const matches = names.get(name) ?? [];
    matches.push(signal);
    names.set(name, matches);
    bySignal.set(instance, names);
  }
  const verifyHeader = async (data: ExecutionHeader) => {
    observedSignals =
      data.observationCoverage &&
      new Set(data.observationCoverage.signals.map(executionSignalKey));
    if (scale !== undefined && data.scale !== scale)
      throw new ExecutionRecordingIdentityError(
        "Execution trace uses a different waveform time unit.",
      );
    if (waveform && data.waveformSha256 !== (await waveformHash(waveform)))
      throw new ExecutionRecordingIdentityError(
        "Execution trace waveform hash mismatch.",
      );
    const entries = Array.isArray(data.coverage)
      ? data.coverage
      : data.coverage
        ? [data.coverage]
        : [];
    for (const entry of entries)
      for (const signal of bySignal.get(entry.instance)?.get(entry.signal) ??
        [])
        signal.coverage = entry;
  };
  if (header) await verifyHeader(header);
  const addCheckpoint = (offset: number) => {
    if (
      offset - indexedOffset < 256 * 1024 ||
      signals.some(({ evaluations }) => evaluations.size)
    )
      return;
    indexedOffset = offset;
    checkpoints.push({
      offset,
      tick: lastTick,
      ordinal: lastOrdinal,
      contiguous,
      signals: signals.map(
        ({ latestCommit, lastUnobservedOrdinal, unexpectedWriters }) => ({
          latestCommit,
          lastUnobservedOrdinal,
          unexpectedWriters: [...unexpectedWriters],
        }),
      ),
    });
    if (checkpoints.length > 128) checkpoints.shift();
  };
  for await (const { line, offset } of executionLines(
    source,
    indexedOffset,
    operation,
  )) {
    if (!line.trim()) continue;
    const data: unknown = JSON.parse(line);
    if (!header) {
      if (!isHeader(data)) throw Error("Unsupported execution trace header.");
      header = data;
      await verifyHeader(data);
      continue;
    }
    if (
      data &&
      typeof data === "object" &&
      "type" in data &&
      data.type === "end"
    ) {
      if (
        !("tick" in data) ||
        typeof data.tick !== "string" ||
        !tickPattern.test(data.tick) ||
        !("eventCount" in data) ||
        typeof data.eventCount !== "number" ||
        !Number.isSafeInteger(data.eventCount) ||
        data.eventCount < lastOrdinal + 1 ||
        BigInt(data.tick) < lastTick
      )
        throw Error("Invalid execution trace completion record.");
      contiguous &&= data.eventCount === lastOrdinal + 1;
      checkedThrough = BigInt(data.tick);
      break;
    }
    if (!isExecutionEvent(data)) throw Error("Invalid execution event.");
    const tick = BigInt(data.tick);
    if (
      data.kind === "signal-value-changed" &&
      observedSignals &&
      (!observedSignals.has(
        executionSignalKey({ instance: data.instance, signal: data.signal }),
      ) ||
        tick < BigInt(header.observationCoverage.start))
    )
      throw Error(
        "Value-change callback is outside its declared observation coverage.",
      );
    if (tick < lastTick || data.ordinal <= lastOrdinal)
      throw Error("Execution events are out of order.");
    contiguous &&= data.ordinal === lastOrdinal + 1;
    if (tick > upper) {
      checkedThrough = tick - 1n;
      break;
    }
    lastTick = tick;
    lastOrdinal = data.ordinal;
    const matching =
      data.signal === undefined
        ? data.kind === "assignment-entered"
          ? undefined
          : byInstance.get(data.instance)
        : bySignal.get(data.instance)?.get(data.signal);
    // Keep the root stream and the outcomes or callbacks for reachable signals.
    const relevant = matching?.filter(
      (signal) =>
        signal === signals[0] ||
        data.kind === "signal-value-changed" ||
        data.kind === "assignment-entered" ||
        (signal.coverage &&
          (data.signal !== undefined ||
            signal.coverage.writers.includes(data.processId))),
    );
    if (!relevant?.length) {
      addCheckpoint(offset);
      continue;
    }
    const sources = header.statements;
    const resolveSource = (statementId: string): ResolvedSource => {
      if (!Object.hasOwn(sources, statementId))
        throw Error("Execution event has no statement source mapping.");
      const statement = sources[statementId];
      return {
        ...statement,
        file: path.resolve(path.dirname(source), statement.file),
      };
    };
    const recordedEvent: ResolvedEvent = {
      ...data,
      source:
        data.statementId && data.kind !== "assignment-entered"
          ? resolveSource(data.statementId)
          : undefined,
      ...(data.externalSteps
        ? {
            resolvedExternalSteps: data.externalSteps.map((step) => ({
              ...step,
              source: resolveSource(step.statementId),
            })),
          }
        : {}),
    };
    for (const signal of relevant) {
      const {
        coverage,
        cursorWriters,
        events,
        evaluations,
        unexpectedWriters,
      } = signal;
      if (
        coverage &&
        tick >= BigInt(coverage.start) &&
        (data.kind === "assignment-evaluated" || finishesEvaluation(data)) &&
        !coverage.writers.includes(data.processId)
      )
        unexpectedWriters.add(data.processId);
      if (data.kind === "assignment-evaluated") {
        evaluations.set(data.ordinal, data);
        if (evaluations.size > 4096)
          throw Error("Too many pending execution evaluations for one signal.");
      } else if (finishesEvaluation(data)) {
        const evaluation = evaluations.get(data.evaluationOrdinal!);
        if (data.kind === "assignment-superseded") {
          const replacement = evaluations.get(data.replacementOrdinal!);
          if (
            (replacement &&
              (replacement.writeKind !== "nonblocking" ||
                replacement.signal !== data.signal ||
                replacement.tick !== data.tick)) ||
            (!replacement && contiguous)
          )
            throw Error(
              "Execution overwrite has no matching replacement evaluation.",
            );
        }
        if (
          evaluation &&
          (evaluation.statementId !== data.statementId ||
            evaluation.processId !== data.processId ||
            evaluation.signal !== data.signal ||
            evaluation.writeKind !== data.writeKind ||
            evaluation.targetRange?.[0] !== data.targetRange?.[0] ||
            evaluation.targetRange?.[1] !== data.targetRange?.[1] ||
            (data.writeKind === "blocking" && evaluation.tick !== data.tick) ||
            (data.value !== undefined &&
              evaluation.value !== undefined &&
              data.value.toLowerCase() !== evaluation.value.toLowerCase()))
        ) {
          throw Error("Execution outcome does not match its evaluation.");
        }
        if (!evaluation && contiguous)
          throw Error(
            "Execution outcome cannot be associated with its evaluation.",
          );
        evaluations.delete(data.evaluationOrdinal!);
        if (data.kind === "assignment-committed")
          signal.latestCommit = recordedEvent;
        if (
          data.kind === "assignment-unobserved" &&
          coverage &&
          tick >= BigInt(coverage.start)
        ) {
          signal.lastUnobservedOrdinal = data.ordinal;
          if (tick >= lower) signal.unobservedInWindow = true;
        }
      }
      if (tick === upper && data.kind === "process-trigger")
        cursorWriters.add(data.processId);
      if (tick < lower) continue;
      if (events.length >= limit) {
        signal.truncated = true;
        continue;
      }
      events.push(recordedEvent);
    }
    addCheckpoint(offset);
  }
  operation?.throwIfAborted();
  if (!header) throw Error("Execution trace is empty.");
  if (hashFingerprint(await stat(source, { bigint: true })) !== fingerprint)
    throw Error("Execution recording changed during playback.");
  operation?.throwIfAborted();
  if (checkpoints.length) {
    const current = replayIndex.get(indexKey);
    const merged = new Map(
      (current?.fingerprint === fingerprint ? current.checkpoints : []).map(
        (entry) => [entry.offset, entry],
      ),
    );
    for (const entry of checkpoints) merged.set(entry.offset, entry);
    replayIndex.set(indexKey, {
      fingerprint,
      header,
      checkpoints: [...merged.values()]
        .sort((a, b) => a.offset - b.offset)
        .slice(-128),
    });
    if (replayIndex.size > 16)
      replayIndex.delete(replayIndex.keys().next().value!);
  }
  const sourceIdentities = new Map<string, Promise<SourceIdentity>>();
  operation?.throwIfAborted();
  const buildId = header.buildId;
  const scaleOfRecording = header.scale;
  const results = await Promise.all(
    signals.map(async (signal) => {
      const {
        coverage,
        cursorWriters,
        events,
        evaluations,
        latestCommit,
        truncated,
        unexpectedWriters,
      } = signal;
      const gaps = [];
      if (!coverage) gaps.push("coverageUndeclared");
      if (coverage && BigInt(coverage.start) > upper)
        gaps.push("outsideCoverage");
      if (checkedThrough === undefined || checkedThrough < upper)
        gaps.push("recordingEndsBeforeCursor");
      if (!contiguous) gaps.push("missingEventOrdinals");
      if (unexpectedWriters.size) gaps.push("undeclaredWriter");
      if (evaluations.size) gaps.push("pendingEvaluation");
      if (
        signal.unobservedInWindow ||
        (signal.lastUnobservedOrdinal ?? -1) > (latestCommit?.ordinal ?? -1)
      )
        gaps.push("unobservedCommit");
      const completeForCursor = coverage && !gaps.length;
      const observationStart = observedSignals?.has(
        executionSignalKey(signal.target),
      )
        ? header.observationCoverage.start
        : undefined;
      const observationGaps = gaps.filter(
        (gap) =>
          gap === "recordingEndsBeforeCursor" || gap === "missingEventOrdinals",
      );
      if (observationStart !== undefined && BigInt(observationStart) > lower)
        observationGaps.push("outsideCoverage");
      if (truncated) observationGaps.push("responseTruncated");
      const cursor =
        completeForCursor &&
        latestCommit &&
        BigInt(latestCommit.tick) >= BigInt(coverage.start)
          ? {
              status:
                latestCommit.tick === end
                  ? ("committed" as const)
                  : ("held" as const),
              latestCommit: {
                ...latestCommit,
                source: latestCommit.source && { ...latestCommit.source },
              },
              triggeredWriters: [...cursorWriters].filter((writer) =>
                coverage.writers.includes(writer),
              ),
            }
          : undefined;
      await Promise.all(
        [...events, ...(cursor ? [cursor.latestCommit] : [])]
          .flatMap(({ source, resolvedExternalSteps }) => [
            ...(source ? [source] : []),
            ...(resolvedExternalSteps?.map(({ source }) => source) ?? []),
          ])
          .map(async (source) => {
            const key = JSON.stringify([source.file, source.sha256]);
            let identity = sourceIdentities.get(key);
            if (!identity) {
              identity = executionSourceIdentity(source);
              sourceIdentities.set(key, identity);
            }
            source.identity = await identity;
          }),
      );
      return {
        schemaVersion: 1 as const,
        buildId,
        scale: scaleOfRecording,
        waveformMatch: waveform
          ? ("verified" as const)
          : ("unverified" as const),
        start,
        end,
        events,
        truncated,
        scannedAfterOrdinal: checkpoint?.ordinal,
        cursor,
        ...(observationStart === undefined
          ? {}
          : {
              observationCoverage: {
                status: observationGaps.length
                  ? ("partial" as const)
                  : ("complete" as const),
                start: observationStart,
                checkedThrough: checkedThrough?.toString(),
                gaps: observationGaps,
              },
            }),
        coverage: {
          status: completeForCursor
            ? ("complete" as const)
            : ("partial" as const),
          declared: coverage,
          checkedThrough: checkedThrough?.toString(),
          gaps,
          unexpectedWriters: [...unexpectedWriters],
          pendingEvaluations: evaluations.size,
        },
      };
    }),
  );
  operation?.throwIfAborted();
  return results;
}

const clean = (value: string) =>
  value.replace(/[\\*_`#[\]<>|]/g, "\\$&").replace(/[\r\n]/g, " ");
export function executionEventLines(events: readonly ResolvedEvent[]) {
  return events.flatMap((event) => {
    const source =
      event.source &&
      clean(event.source.file) +
        " L" +
        event.source.line +
        " C" +
        event.source.column +
        " · Source " +
        event.source.identity;
    const site = event.statementSite;
    return [
      "- Tick " +
        event.tick +
        " · Order " +
        event.ordinal +
        " · " +
        event.kind +
        " · " +
        clean(event.instance) +
        (event.signal ? "." + clean(event.signal) : "") +
        (event.processId ? " · " + clean(event.processId) : "") +
        (site ? " · " + clean(event.statementId) : "") +
        (event.writeKind ? " · " + event.writeKind : "") +
        (event.targetRange ? " · Target " + event.targetRange.join(":") : "") +
        (event.timing ? " · " + event.timing : "") +
        (event.value === undefined ? "" : " · " + event.value) +
        (event.evaluationOrdinal === undefined
          ? ""
          : " · Evaluation " + event.evaluationOrdinal) +
        (event.replacementOrdinal === undefined
          ? ""
          : " · Replacement " + event.replacementOrdinal) +
        (source
          ? " · " + source
          : site
            ? " · " + clean(site.file) + " L" + site.line
            : ""),
      ...Object.entries(event.operandValues ?? {}).map(
        ([name, bits]) =>
          "  - Captured operand · " + clean(name) + " = " + bits,
      ),
      ...(event.externalSteps ?? []).map((step, index) => {
        const source = event.resolvedExternalSteps?.[index]?.source;
        return (
          "  - External execution · " +
          externalStepText(step) +
          (source
            ? " · " +
              clean(source.file) +
              " L" +
              source.line +
              " · Source " +
              source.identity
            : " · Statement " + step.statementId)
        );
      }),
    ];
  });
}

export function externalStepText(step: ExternalStep) {
  return (
    clean(step.operation) + (step.value === undefined ? "" : " = " + step.value)
  );
}

export function executionReport(
  evidence: Awaited<ReturnType<typeof readExecutionEvidence>>,
) {
  const lines = [
    "",
    "## Recorded execution",
    "",
    (evidence.waveformMatch === "verified"
      ? "Waveform hash verified"
      : "Recording-only playback · Waveform identity unverified") +
      " · Build " +
      clean(evidence.buildId),
    "",
  ];
  if (evidence.cursor) {
    const { status, latestCommit } = evidence.cursor;
    if (status === "held")
      lines.push(
        "The recorded signal held through tick " +
          evidence.end +
          " · Last commit at tick " +
          latestCommit.tick,
        "",
      );
    else if (status === "committed")
      lines.push("Recorded commit at cursor tick " + evidence.end, "");
  }
  if (evidence.coverage.gaps.length)
    lines.push(
      "Execution coverage gaps · " + evidence.coverage.gaps.join(", "),
      "",
    );
  if (evidence.observationCoverage) {
    const coverage = evidence.observationCoverage;
    lines.push(
      "Value-change observation coverage · " +
        coverage.status +
        (coverage.checkedThrough
          ? " · Checked through tick " + coverage.checkedThrough
          : ""),
      ...(coverage.gaps.length
        ? ["Observation coverage gaps · " + coverage.gaps.join(", ")]
        : []),
      "",
    );
    if (
      coverage.status === "complete" &&
      !evidence.events.some((event) => event.kind === "signal-value-changed")
    )
      lines.push("No value-change callbacks in the requested window.", "");
  }
  lines.push(...executionEventLines(evidence.events));
  if (evidence.truncated)
    lines.push("", "Execution events reached the report budget.");
  return lines.join("\n") + "\n";
}

export function linkExecutionAssignments(
  trace: VideTrace,
  evidence: Awaited<ReturnType<typeof readExecutionEvidence>>,
  dirtySources?: ReadonlySet<string>,
  target = trace.root,
  word?: ObservedTraceWord,
) {
  const assignments = new Map<string, number[]>();
  trace.assignments.forEach(
    ({ targets, location, instance, targetElementIndex }, index) => {
      if (
        !targets.includes(word?.array ?? target) ||
        !location.uri.startsWith("file:") ||
        (word && (instance !== word.instance || !targetElementIndex))
      )
        return;
      if (word && targetElementIndex?.op === "literal") {
        const literal = evaluateTraceValue(
          targetElementIndex,
          undefined,
          () => undefined,
        );
        if (
          !literal ||
          traceInteger(literal.bits, literal.signed)?.toString() !== word.index
        )
          return;
      }
      const { line, character } = location.range.start;
      const key = JSON.stringify([
        fileURLToPath(location.uri),
        line + 1,
        character + 1,
      ]);
      const matches = assignments.get(key) ?? [];
      matches.push(index);
      assignments.set(key, matches);
    },
  );
  const events = new Map(
    evidence.events.map((event) => [event.ordinal, event]),
  );
  const latest = evidence.cursor?.latestCommit;
  if (latest) events.set(latest.ordinal, latest);
  const links = [];
  for (const event of events.values()) {
    const source = event.source;
    if (
      source?.identity !== "matched" ||
      dirtySources?.has(source.file) ||
      (word &&
        (event.instance !== word.instance || event.signal !== word.name)) ||
      (event.kind !== "assignment-evaluated" && !finishesEvaluation(event))
    )
      continue;
    const key = JSON.stringify([source.file, source.line, source.column]);
    const matches = assignments.get(key)?.filter((id) => {
      const assignment = trace.assignments[id];
      return (
        (!event.writeKind || assignment.kind === event.writeKind) &&
        (!event.targetRange ||
          (assignment.targetIndex !== undefined &&
            Math.abs(event.targetRange[0] - event.targetRange[1]) + 1 ===
              (assignment.targetIndexedPart?.width ?? 1)) ||
          (assignment.targetRange?.[0] === event.targetRange[0] &&
            assignment.targetRange?.[1] === event.targetRange[1]))
      );
    });
    if (matches?.length === 1)
      links.push({
        assignment: matches[0],
        tick: event.tick,
        ordinal: event.ordinal,
        kind: event.kind,
      });
  }
  return links.sort((left, right) => left.ordinal - right.ordinal);
}

export function executionAssignmentReport(
  links: ReturnType<typeof linkExecutionAssignments>,
) {
  if (!links.length) return "";
  return [
    "",
    "## RTL assignments correlated with recorded execution",
    "",
    ...links.map(
      ({ assignment, tick, ordinal, kind }) =>
        "- Tick " +
        tick +
        " · Order " +
        ordinal +
        " · " +
        kind +
        " · RTL assignment " +
        (assignment + 1),
    ),
    "",
  ].join("\n");
}

export function correlateExecutionTransitions(
  root: number,
  evidence: Awaited<ReturnType<typeof readTraceObservations>>,
  temporal: ReturnType<typeof buildTemporalTrace>,
  execution: Awaited<ReturnType<typeof readExecutionEvidence>>,
  assignments: ReturnType<typeof linkExecutionAssignments>,
  options: { compareCursor?: boolean; bit?: number; word?: boolean } = {},
) {
  let observation = evidence.observations.find(({ signal }) => signal === root);
  const bit = options.bit ?? observation?.bit;
  if (observation?.status === "unavailable") observation = undefined;
  if (observation && bit !== undefined && !observation.projected) {
    const { range, width } = observation;
    if (!range || Math.abs(range[0] - range[1]) + 1 !== width) return [];
    const project = (sample: { tick: string; value?: string }) => {
      const bits = normalizeBits(sample.value, width);
      return {
        tick: sample.tick,
        value: bits && sliceTraceBits(bits, range, bit, bit),
      };
    };
    observation = {
      ...observation,
      width: 1,
      bit,
      projected: true,
      initial: observation.initial && project(observation.initial),
      history: observation.history.map(project),
      cursorSamples: observation.cursorSamples && {
        ...observation.cursorSamples,
        initial:
          observation.cursorSamples.initial &&
          project(observation.cursorSamples.initial),
        events: observation.cursorSamples.events.map(project),
      },
    };
  }
  const nodesByTick = new Map<
    string,
    Array<{ id: number; orderAtTick?: number; value?: string }>
  >();
  for (const [id, point] of temporal.nodes.entries()) {
    if (point.signal !== root || point.bit !== bit || point.sampleOnly)
      continue;
    const nodes = nodesByTick.get(point.tick) ?? [];
    if (!point.executionOnly)
      nodes.push({ id, orderAtTick: point.orderAtTick, value: point.value });
    nodesByTick.set(point.tick, nodes);
  }
  const ticks = new Set(nodesByTick.keys());
  if (options.compareCursor !== false) ticks.add(evidence.tick);
  const assignmentsByOrdinal = new Map(
    assignments.map(({ ordinal, assignment }) => [ordinal, assignment]),
  );
  const comparisons = [];
  const unobservedTicks = new Set(
    execution.events
      .filter(
        ({ kind, targetRange }) =>
          kind === "assignment-unobserved" &&
          (bit === undefined ||
            !targetRange ||
            (bit >= Math.min(...targetRange) &&
              bit <= Math.max(...targetRange))),
      )
      .map(({ tick }) => tick),
  );
  for (const tick of unobservedTicks) ticks.add(tick);
  const commitWindowVerified = hasWriteEventCoverage(execution.coverage);
  for (const tick of ticks) {
    const nodes = nodesByTick.get(tick) ?? [];
    const commits = execution.events.filter(
      (event) => event.tick === tick && event.kind === "assignment-committed",
    );
    const callbacks = commits.length
      ? []
      : execution.events.filter(
          (event) =>
            event.tick === tick && event.kind === "signal-value-changed",
        );
    const observationCoverage = execution.observationCoverage;
    const callbackMode =
      callbacks.length > 0 || (!commits.length && !!observationCoverage);
    const sampled =
      tick === evidence.tick ? observation?.cursorSamples : undefined;
    const prior = sampled
      ? sampled.initial
      : (observation?.history.findLast(
          (event) => BigInt(event.tick) < BigInt(tick),
        ) ?? observation?.initial);
    const samples =
      sampled?.events ??
      observation?.history.filter((event) => event.tick === tick) ??
      [];
    const width = observation?.width ?? 0;
    const initial = normalizeBits(prior?.value, width);
    let observed = initial;
    const waveformValues: string[] = [];
    let unknownSample = initial === undefined;
    for (const sample of samples) {
      const value = normalizeBits(sample.value, width);
      if (value === undefined) unknownSample = true;
      else if (observed !== undefined && value !== observed)
        waveformValues.push(value);
      observed = value;
    }
    if (
      !waveformValues.length &&
      !commits.length &&
      !callbacks.length &&
      !nodes.length &&
      !unobservedTicks.has(tick) &&
      !(callbackMode && tick === evidence.tick)
    )
      continue;
    const base = {
      tick,
      waveformValues,
      commitOrdinals: commits.map(({ ordinal }) => ordinal),
    };
    const coverage = execution.coverage.declared;
    const callbackOrdinals = callbacks.map(({ ordinal }) => ordinal);
    const completeCallbacks = observationCoverage
      ? BigInt(tick) >= BigInt(observationCoverage.start) &&
        observationCoverage.gaps.every((gap) => gap === "outsideCoverage")
      : callbacks.length > 0 &&
        execution.coverage.gaps?.every((gap) => gap === "coverageUndeclared") &&
        execution.coverage.checkedThrough !== undefined &&
        BigInt(execution.coverage.checkedThrough) >= BigInt(tick);
    const layout = observation?.range;
    const partialWord =
      options.word &&
      bit === undefined &&
      layout &&
      Math.abs(layout[0] - layout[1]) + 1 === width &&
      completeCallbacks &&
      unobservedTicks.has(tick) &&
      commits.length > 0;
    if (
      !observation ||
      (sampled ? sampled.truncated : observation.historyTruncated) ||
      unknownSample ||
      execution.truncated ||
      execution.waveformMatch !== "verified" ||
      (callbackMode
        ? !completeCallbacks
        : !commitWindowVerified ||
          (unobservedTicks.has(tick) && !partialWord) ||
          !coverage ||
          BigInt(tick) < BigInt(coverage.start)) ||
      BigInt(tick) < BigInt(execution.start)
    ) {
      comparisons.push({
        ...base,
        ...(callbackMode ? { callbackOrdinals } : {}),
        status: "incomplete" as const,
      });
      continue;
    }
    // The packed layout translates recorded whole-signal values to the selected bit.
    const recordedValue = (
      event: ExecutionEvent,
      previous: string | undefined,
    ) => {
      if (event.targetRange) {
        if (!event.value || !previous || !observation.range) return undefined;
        const [first, last] = event.targetRange;
        const value = event.value.toLowerCase();
        if (observation.projected) {
          if (bit === undefined) return undefined;
          const projected = sliceTraceBits(value, event.targetRange, bit, bit);
          return projected ?? previous;
        }
        if (
          sliceTraceBits(previous, observation.range, first, last) === undefined
        )
          return undefined;
        const offset = Math.abs(first - observation.range[0]);
        return (
          previous.slice(0, offset) +
          value +
          previous.slice(offset + value.length)
        );
      }
      if (!observation.projected)
        return normalizeBits(event.value, observation.width);
      if (observation.bit === undefined || !observation.range) return undefined;
      const [left, right] = observation.range;
      const bits = normalizeBits(event.value, Math.abs(left - right) + 1);
      return (
        bits &&
        sliceTraceBits(
          bits,
          observation.range,
          observation.bit,
          observation.bit,
        )
      );
    };
    let previous = initial;
    const changes = [];
    let unknownValue = previous === undefined;
    for (const event of callbackMode ? callbacks : commits) {
      const value = recordedValue(event, previous);
      if (value === undefined) unknownValue = true;
      if (value !== previous) changes.push({ event, value });
      previous = value;
    }
    if (partialWord) {
      const wordCallbacks = execution.events.filter(
        (event) => event.tick === tick && event.kind === "signal-value-changed",
      );
      const observedValues = wordCallbacks.map(({ value }) =>
        normalizeBits(value, width),
      );
      const end = nodes.find(
        (node) =>
          (node.orderAtTick ?? 1) === waveformValues.length &&
          normalizeBits(node.value, width) === observed,
      );
      if (
        !unknownValue &&
        initial !== undefined &&
        end &&
        observed !== undefined &&
        observedValues.at(-1) === observed &&
        observedValues.every((value) => value !== undefined) &&
        commits.every(
          (event) =>
            event.writeKind === "blocking" ||
            (event.writeKind === "nonblocking" &&
              event.timing === "simulator-commit"),
        )
      ) {
        const touched = execution.events.filter(
          (event) =>
            event.tick === tick && event.kind === "assignment-unobserved",
        );
        const commitValues = changes.map(({ value }) => value);
        const sequenceAt = (values: (string | undefined)[], offset: number) => {
          let prior = initial[offset];
          const sequence = [];
          for (const value of values) {
            const bitValue = value?.[offset];
            if (bitValue !== prior) sequence.push(bitValue);
            prior = bitValue!;
          }
          return sequence.join("");
        };
        const excluded = Array.from(observed).flatMap((_, offset) => {
          const index = layout[0] + offset * (layout[0] <= layout[1] ? 1 : -1);
          return touched.some(
            ({ targetRange }) =>
              !targetRange ||
              !rangeWithin(targetRange, layout) ||
              (index >= Math.min(...targetRange) &&
                index <= Math.max(...targetRange)),
          ) ||
            sequenceAt(commitValues, offset) !==
              sequenceAt(observedValues, offset)
            ? [offset]
            : [];
        });
        if (excluded.length < width) {
          comparisons.push({
            ...base,
            status: "partiallyMatched" as const,
            wordSnapshot: {
              node: end.id,
              ordinal: Math.max(
                commits.at(-1)!.ordinal,
                wordCallbacks.at(-1)!.ordinal,
              ),
              layout,
              excluded,
            },
          });
          continue;
        }
      }
      comparisons.push({ ...base, status: "incomplete" as const });
      continue;
    }
    const values = changes.map(({ value }) => value);
    const sequenceMatches =
      values.length === waveformValues.length &&
      values.every((value, index) => value === waveformValues[index]);
    const matchedNodes =
      sequenceMatches && !unknownValue
        ? changes.flatMap(({ event, value }, index) => {
            const node = nodes.find(
              (point) => (point.orderAtTick ?? 1) === index + 1,
            );
            return node && normalizeBits(node.value, width) === value
              ? [{ node: node.id, ordinal: event.ordinal }]
              : [];
          })
        : [];
    if (callbackMode) {
      comparisons.push({
        ...base,
        callbackOrdinals,
        ...(matchedNodes.length ? { callbackLinks: matchedNodes } : {}),
        recordedChangeValues: values,
        status: unknownValue
          ? ("incomplete" as const)
          : sequenceMatches
            ? ("valueChangesMatch" as const)
            : ("valueChangesDiffer" as const),
      });
      continue;
    }
    if (unknownValue) {
      comparisons.push({ ...base, status: "incomplete" as const });
    } else if (!sequenceMatches) {
      comparisons.push({
        ...base,
        status: "sequenceDiffers" as const,
        recordedChangeValues: values,
      });
    } else if (
      commits.some(
        (event) =>
          event.writeKind === "nonblocking" &&
          event.timing !== "simulator-commit",
      )
    ) {
      comparisons.push({ ...base, status: "approximateCommitTiming" as const });
    } else {
      comparisons.push({
        ...base,
        status: "matched" as const,
        links: matchedNodes.map(({ node, ordinal }) => ({
          node,
          ordinal,
          assignment: assignmentsByOrdinal.get(ordinal),
        })),
      });
    }
  }
  return comparisons;
}

export function annotateRecordedValueChanges(
  temporal: ReturnType<typeof buildTemporalTrace>,
  comparisons: readonly ExecutionTransitionComparison[],
) {
  for (const { callbackLinks, restoredFromCallbacks } of comparisons) {
    for (const { node, ordinal } of callbackLinks ?? []) {
      temporal.nodes[node].valueChangeOrdinal = ordinal;
      if (restoredFromCallbacks)
        temporal.nodes[node].restoredFromCallbacks = true;
    }
  }
  for (const edge of temporal.edges) {
    if (edge.timing !== "sameTickUnordered") continue;
    const source = temporal.nodes[edge.source].valueChangeOrdinal;
    const target = temporal.nodes[edge.target].valueChangeOrdinal;
    if (source === undefined || target === undefined || source === target)
      continue;
    edge.callbackOrder =
      source < target ? "sourceBeforeTarget" : "sourceAfterTarget";
  }
}

type ExecutionTransitionComparison = ReturnType<
  typeof correlateExecutionTransitions
>[number] & {
  restoredFromCallbacks?: true;
};

export function preserveDumpedTransitionEvidence(
  replay: ReturnType<typeof correlateExecutionTransitions>,
  dumped: ReturnType<typeof correlateExecutionTransitions>,
): ExecutionTransitionComparison[] {
  const byTick = new Map(
    replay.map((comparison) => [comparison.tick, comparison]),
  );
  return dumped.map((comparison) => {
    const restored = byTick.get(comparison.tick);
    if (
      comparison.status !== "valueChangesDiffer" ||
      restored?.status !== "valueChangesMatch" ||
      !restored.callbackLinks?.length
    )
      return comparison;
    return {
      ...comparison,
      restoredFromCallbacks: true,
      callbackLinks: restored.callbackLinks,
    };
  });
}

export function matchRecordedModportComponents(
  trace: VideTrace,
  evidence: Awaited<ReturnType<typeof readTraceObservations>>,
  temporal: ReturnType<typeof buildTemporalTrace>,
  comparisons: ReturnType<typeof correlateExecutionTransitions>,
  recordings: ReadonlyMap<
    number,
    Awaited<ReturnType<typeof readExecutionEvidence>>
  >,
  dirtySources: ReadonlySet<string>,
) {
  const matches = new Map<string, RecordedModportComponent>();
  const components = new Map<number, number[]>();
  trace.assignments.forEach(({ overlappingModportWrite, targets }, id) => {
    if (!overlappingModportWrite || targets.length !== 1) return;
    const entries = components.get(targets[0]) ?? [];
    entries.push(id);
    components.set(targets[0], entries);
  });
  if (!components.size) return matches;

  const observations = new Map(
    evidence.observations.map((item) => [item.signal, item]),
  );
  if (evidence.wholeRoot) observations.set(trace.root, evidence.wholeRoot);
  const callbacks = new Map<number, ExecutionEvent[]>();
  const evaluations = new Map<number, Map<number, ResolvedEvent[]>>();
  function componentEvaluations(id: number) {
    if (!evaluations.has(id)) {
      const entries = new Map<number, ResolvedEvent[]>();
      const recording = recordings.get(id);
      if (
        recording?.events.some(({ kind }) => kind === "assignment-evaluated")
      ) {
        const events = new Map(
          recording.events.map((event) => [event.ordinal, event]),
        );
        for (const link of linkExecutionAssignments(
          trace,
          recording,
          dirtySources,
          id,
        )) {
          if (link.kind !== "assignment-evaluated") continue;
          const group = entries.get(link.assignment) ?? [];
          group.push(events.get(link.ordinal)!);
          entries.set(link.assignment, group);
        }
      }
      evaluations.set(id, entries);
    }
    return evaluations.get(id)!;
  }
  function windowSeed(id: number) {
    if (recordings.get(id)?.start === evidence.historyStart)
      return observations.get(id)?.initial?.value;
  }
  function changes(id: number) {
    if (callbacks.has(id)) return callbacks.get(id);
    const recording = recordings.get(id);
    if (
      recording?.waveformMatch !== "verified" ||
      recording.truncated ||
      recording.observationCoverage?.status !== "complete"
    )
      return;
    const events = recording.events.filter(
      ({ kind }) => kind === "signal-value-changed",
    );
    callbacks.set(id, events);
    return events;
  }

  for (const { status, callbackLinks } of comparisons) {
    if (status !== "valueChangesMatch" || !callbackLinks) continue;
    for (const { node, ordinal } of callbackLinks) {
      const point = temporal.nodes[node];
      const candidates = components.get(point.signal);
      const target = observations.get(point.signal);
      const bit = point.bit;
      if (!candidates || !target?.range) continue;
      const targetChanges = changes(point.signal);
      const index =
        targetChanges?.findIndex((event) => event.ordinal === ordinal) ?? -1;
      if (!targetChanges || index < 0) continue;
      const previous = (
        targetChanges[index - 1]?.value ?? windowSeed(point.signal)
      )?.toLowerCase();
      const current = targetChanges[index].value?.toLowerCase();
      if (
        !previous ||
        !current ||
        current.length !== target.width ||
        previous.length !== target.width
      )
        continue;

      // A callback observes storage. Compare the whole changed word against
      // each component without inferring the simulator's evaluation order.
      const group = candidates.filter((id) => {
        const range = trace.assignments[id].targetRange;
        return range && (bit === undefined || rangeWithin([bit, bit], range));
      });
      if (group.length < 2) continue;
      const first = trace.assignments[group[0]];
      const source = first.location.uri;
      if (
        !source.startsWith("file:") ||
        dirtySources.has(fileURLToPath(source))
      )
        continue;
      const site = first.location.range.start;
      const sourceEvaluations = componentEvaluations(point.signal);
      const measured = new Map(
        group.map((assignment) => [
          assignment,
          sourceEvaluations
            .get(assignment)
            ?.filter(
              ({ tick, ordinal: evaluation, value }) =>
                tick === point.tick &&
                evaluation < ordinal &&
                value !== undefined,
            ) ?? [],
        ]),
      );
      const coverage = recordings.get(point.signal)?.coverage;
      const measuredGroup =
        coverage?.declared &&
        coverage.checkedThrough !== undefined &&
        BigInt(coverage.declared.start) <= BigInt(point.tick) &&
        BigInt(coverage.checkedThrough) >= BigInt(point.tick) &&
        coverage.gaps.every((gap) => gap === "unobservedCommit") &&
        [...measured.values()].every((events) => events.length > 0);
      let supported = true;
      const compatible: RecordedModportComponent[] = [];
      for (const assignment of group) {
        const candidate = trace.assignments[assignment];
        const range = candidate.targetRange!;
        const [operand] = candidate.inputs;
        const { value, location } = candidate;
        const prior = sliceTraceBits(previous, target.range, ...range);
        const next = sliceTraceBits(current, target.range, ...range);
        if (
          candidate.kind !== "blocking" ||
          candidate.hasUnresolvedOperands ||
          candidate.instance !== first.instance ||
          location.uri !== source ||
          location.range.start.line !== site.line ||
          location.range.start.character !== site.character ||
          candidate.hierarchicalTargets?.length !== 1 ||
          !candidate.hierarchicalTargets[0].interfaceComponent ||
          candidate.inputs.length !== 1 ||
          operand?.kind !== "data" ||
          operand.hierarchical ||
          value?.op !== "slice" ||
          !prior ||
          !next
        ) {
          supported = false;
          break;
        }
        const offset = Math.abs(range[0] - target.range[0]);
        if (
          previous.slice(0, offset) +
            next +
            previous.slice(offset + next.length) !==
          current
        )
          continue;
        const matching = measured
          .get(assignment)!
          .filter(({ value }) => value?.toLowerCase() === next);
        const match = {
          assignment,
          ordinal,
          range,
          ...(matching.length === 1
            ? { evaluationOrdinal: matching[0].ordinal }
            : {}),
        };
        if (measuredGroup) {
          if (matching.length) compatible.push(match);
          continue;
        }
        const layout = observations.get(operand.signal);
        const inputChanges = changes(operand.signal);
        const sameTick = inputChanges?.filter(
          ({ tick }) => tick === point.tick,
        );
        const before =
          inputChanges?.findLast(
            ({ tick }) => BigInt(tick) < BigInt(point.tick),
          )?.value ?? windowSeed(operand.signal);
        if (
          !layout ||
          layout.projected ||
          before === undefined ||
          !sameTick ||
          sameTick.length > 64
        ) {
          supported = false;
          break;
        }
        const samples = [before, ...sameTick.map(({ value }) => value)].map(
          (bits) => {
            if (bits?.length !== layout.width) return undefined;
            return evaluateTraceValue(value, next.length, (id) =>
              id === operand.signal
                ? {
                    bits,
                    width: layout.width,
                    signed: layout.signed,
                    range: layout.range,
                  }
                : undefined,
            )?.bits;
          },
        );
        if (samples.some((value) => value === undefined)) {
          supported = false;
          break;
        }
        if (samples.includes(next)) compatible.push(match);
      }
      if (supported && compatible.length === 1)
        matches.set(temporalTransitionKey(point), compatible[0]);
    }
  }
  return matches;
}

export function reachedWriteEvents(
  events: readonly ResolvedEvent[],
  comparisons: ReturnType<typeof correlateExecutionTransitions>,
  bit?: number,
) {
  const ticks = new Set(comparisons.map(({ tick }) => tick));
  const ordinals = new Set<number>();
  for (const event of events) {
    if (
      !ticks.has(event.tick) ||
      (event.kind !== "assignment-evaluated" && !finishesEvaluation(event))
    )
      continue;
    const range = event.targetRange;
    if (
      bit !== undefined &&
      range &&
      (bit < Math.min(...range) || bit > Math.max(...range))
    )
      continue;
    ordinals.add(event.ordinal);
    if (event.evaluationOrdinal !== undefined)
      ordinals.add(event.evaluationOrdinal);
    if (event.replacementOrdinal !== undefined)
      ordinals.add(event.replacementOrdinal);
  }
  return events.filter(({ ordinal }) => ordinals.has(ordinal));
}

export function executionTransitionReport(
  comparisons: readonly ExecutionTransitionComparison[],
  signal?: string,
) {
  if (!comparisons.length) return "";
  const messages = {
    matched: "Recorded commits match the waveform changes.",
    partiallyMatched:
      "Recorded commits match the unaffected bits at the end of this time slot.",
    incomplete:
      "The available waveform or execution history leaves this tick unresolved.",
    sequenceDiffers:
      "The recorded commit changes differ from the waveform changes.",
    approximateCommitTiming:
      "The matching sequence includes writes sampled at the end of the time slot.",
    valueChangesMatch:
      "The simulator's value-change callbacks match the waveform changes.",
    valueChangesDiffer:
      "The simulator's value-change callbacks differ from the waveform changes.",
  };
  return [
    "",
    (comparisons.some(({ callbackOrdinals }) => callbackOrdinals !== undefined)
      ? "## Waveform and simulator value changes"
      : "## Waveform changes and recorded commits") +
      (signal === undefined ? "" : " for " + clean(signal)),
    "",
    ...comparisons.flatMap(
      ({
        tick,
        status,
        waveformValues,
        commitOrdinals,
        callbackOrdinals,
        callbackLinks,
        restoredFromCallbacks,
        recordedChangeValues,
        links,
      }) => [
        "- Tick " + tick + " · " + messages[status],
        ...(restoredFromCallbacks
          ? [
              "  - Time graph restored ordered changes from the verified callbacks.",
            ]
          : []),
        ...(waveformValues.length
          ? ["  - Waveform changes · " + waveformValues.join(" → ")]
          : []),
        ...(recordedChangeValues?.length
          ? ["  - Recorded changes · " + recordedChangeValues.join(" → ")]
          : []),
        ...(commitOrdinals.length
          ? ["  - Recorded commit ordinals · " + commitOrdinals.join(", ")]
          : []),
        ...(callbackOrdinals?.length
          ? [
              "  - Value-change callback ordinals · " +
                callbackOrdinals.join(", "),
            ]
          : []),
        ...(callbackLinks ?? []).map(
          ({ node, ordinal }) =>
            "  - Time graph node " +
            node +
            " · Value-change callback " +
            ordinal,
        ),
        ...(links ?? []).map(
          ({ node, ordinal, assignment }) =>
            "  - Time graph node " +
            node +
            " · Commit " +
            ordinal +
            (assignment === undefined
              ? ""
              : " · RTL assignment " + (assignment + 1)),
        ),
      ],
    ),
    "",
  ].join("\n");
}

export function recordedWriters(
  temporal: ReturnType<typeof buildTemporalTrace>,
  comparisons: ReturnType<typeof correlateExecutionTransitions>,
  events: readonly ResolvedEvent[],
  dirtySources?: ReadonlySet<string>,
  assignments: ReturnType<typeof linkExecutionAssignments> = [],
  coverageStart?: string,
  rootWordId?: number,
) {
  const byOrdinal = new Map(events.map((event) => [event.ordinal, event]));
  const writers = new Map<string, RecordedWriter | RecordedWordAttribution>();
  const words = new Set(temporal.wordSignals?.map(({ id }) => id));
  if (rootWordId !== undefined) words.add(rootWordId);
  const byAssignment = new Map(
    assignments.map(({ ordinal, assignment }) => [ordinal, assignment]),
  );
  const outcomes = words.size
    ? events.filter(
        ({ kind, tick }) =>
          (kind === "assignment-committed" ||
            kind === "assignment-unobserved") &&
          (coverageStart === undefined ||
            BigInt(tick) >= BigInt(coverageStart)),
      )
    : [];
  const unobserved = new Map<string, ResolvedEvent[]>();
  for (const event of outcomes) {
    if (event.kind !== "assignment-unobserved") continue;
    const pending = unobserved.get(event.tick) ?? [];
    pending.push(event);
    unobserved.set(event.tick, pending);
  }
  for (const comparison of comparisons) {
    const snapshot = comparison.wordSnapshot;
    const links = snapshot
      ? [
          {
            node: snapshot.node,
            ordinal: snapshot.ordinal,
            assignment: undefined,
          },
        ]
      : (comparison.links ?? []);
    for (const { node, ordinal, assignment } of links) {
      if (assignment === undefined && !snapshot) continue;
      const commit = byOrdinal.get(ordinal);
      const evaluation =
        commit?.evaluationOrdinal === undefined
          ? undefined
          : byOrdinal.get(commit.evaluationOrdinal);
      const point = temporal.nodes[node];
      const key = temporalTransitionKey(point);
      const writer =
        assignment === undefined
          ? undefined
          : recordedWriter(
              assignment,
              ordinal,
              commit,
              evaluation,
              dirtySources,
            );
      const layout = snapshot?.layout ?? commit?.targetPackedRange;
      if (
        (snapshot || comparison.status === "matched") &&
        words.has(point.signal) &&
        point.bit === undefined &&
        layout &&
        point.value &&
        normalizeBits(point.value, Math.abs(layout[0] - layout[1]) + 1) ===
          point.value
      ) {
        const remaining = new Set(
          Array.from(point.value, (_, offset) => offset),
        );
        const unresolved = new Set<number>(snapshot?.excluded);
        for (const offset of unresolved) remaining.delete(offset);
        const wordWriters: RecordedWordWriter[] = [];
        let currentTick: string | undefined;
        const offsets = (range: [number, number] | undefined) => {
          if (!range || !rangeWithin(range, layout)) return [...remaining];
          const first = Math.abs(range[0] - layout[0]);
          const last = Math.abs(range[1] - layout[0]);
          return [...remaining].filter(
            (offset) => offset >= first && offset <= last,
          );
        };
        const direction = layout[0] <= layout[1] ? 1 : -1;
        const ranges = (selected: Iterable<number>) => {
          const result: [number, number][] = [];
          for (const offset of [...selected].sort(
            (left, right) => left - right,
          )) {
            const bit = layout[0] + offset * direction;
            const previous = result.at(-1);
            if (previous && bit === previous[1] + direction) previous[1] = bit;
            else result.push([bit, bit]);
          }
          return result;
        };
        for (
          let index = outcomes.length - 1;
          index >= 0 && remaining.size;
          index--
        ) {
          const part = outcomes[index];
          if (part.ordinal > ordinal) continue;
          if (part.tick !== currentTick) {
            currentTick = part.tick;
            // Unobserved outcomes can follow commits from the same slot. They
            // hide only the bits those writes could have reached.
            for (const loss of unobserved.get(currentTick) ?? [])
              for (const offset of offsets(loss.targetRange)) {
                remaining.delete(offset);
                unresolved.add(offset);
              }
          }
          if (part.kind !== "assignment-committed") continue;
          const selected = offsets(part.targetRange);
          if (!selected.length) continue;
          const mapped = byAssignment.get(part.ordinal);
          const evaluated =
            part.evaluationOrdinal === undefined
              ? undefined
              : byOrdinal.get(part.evaluationOrdinal);
          const range = part.targetRange ?? layout;
          const first = Math.abs(range[0] - layout[0]);
          const value = part.value?.toLowerCase();
          const confirmed =
            mapped !== undefined &&
            evaluated?.kind === "assignment-evaluated" &&
            evaluated.ordinal < part.ordinal &&
            byAssignment.get(evaluated.ordinal) === mapped &&
            (part.writeKind === "blocking" ||
              (part.writeKind === "nonblocking" &&
                part.timing === "simulator-commit")) &&
            (!part.targetPackedRange ||
              (part.targetPackedRange[0] === layout[0] &&
                part.targetPackedRange[1] === layout[1])) &&
            rangeWithin(range, layout) &&
            value?.length === Math.abs(range[0] - range[1]) + 1;
          const surviving = [];
          for (const offset of selected) {
            remaining.delete(offset);
            if (confirmed && point.value[offset] === value?.[offset - first])
              surviving.push(offset);
            else unresolved.add(offset);
          }
          if (mapped !== undefined && surviving.length) {
            const entry: RecordedWordWriter = recordedWriter(
              mapped,
              part.ordinal,
              part,
              evaluated,
              dirtySources,
            );
            if (surviving.length !== value?.length)
              entry.contributingRanges = ranges(surviving);
            wordWriters.push(entry);
          }
        }
        for (const offset of remaining) unresolved.add(offset);
        if (wordWriters.length || snapshot) {
          writers.set(key, {
            writer,
            wordWriters: wordWriters.reverse(),
            unresolved: ranges(unresolved),
          });
          continue;
        }
      }
      if (writer) writers.set(key, writer);
    }
  }
  return writers;
}

function recordedWriter(
  assignment: number,
  ordinal: number,
  commit?: ResolvedEvent,
  evaluation?: ResolvedEvent,
  dirtySources?: ReadonlySet<string>,
): RecordedWriter {
  const externalSteps = evaluation?.resolvedExternalSteps?.map((step) =>
    dirtySources?.has(step.source.file)
      ? {
          ...step,
          source: { ...step.source, identity: "changed" as const },
        }
      : step,
  );
  return {
    assignment,
    commitOrdinal: ordinal,
    ...(commit?.targetRange ? { targetRange: commit.targetRange } : {}),
    ...(evaluation
      ? {
          evaluation: {
            ordinal: evaluation.ordinal,
            tick: evaluation.tick,
            ...(evaluation.value !== undefined
              ? { value: evaluation.value }
              : {}),
            ...(evaluation.operandValues
              ? { operandValues: evaluation.operandValues }
              : {}),
            ...(evaluation.guardEntryValues
              ? { guardEntryValues: evaluation.guardEntryValues }
              : {}),
            ...(externalSteps ? { externalSteps } : {}),
          },
        }
      : {}),
  };
}

export function hasWriteEventCoverage(
  coverage: Awaited<ReturnType<typeof readExecutionEvidence>>["coverage"],
) {
  return (
    coverage.status === "complete" ||
    (coverage.gaps?.length === 1 && coverage.gaps[0] === "unobservedCommit")
  );
}

export function recordedCursorWrite(
  trace: VideTrace,
  evidence: Awaited<ReturnType<typeof readTraceObservations>>,
  recording: Awaited<ReturnType<typeof readExecutionEvidence>>,
  links: ReturnType<typeof linkExecutionAssignments>,
  dirtySources?: ReadonlySet<string>,
): RecordedCursorWrite | undefined {
  const commit = recording.cursor?.latestCommit;
  if (
    recording.waveformMatch !== "verified" ||
    recording.coverage.status !== "complete" ||
    recording.truncated ||
    commit?.kind !== "assignment-committed" ||
    (commit.writeKind !== "blocking" &&
      !(
        commit.writeKind === "nonblocking" &&
        commit.timing === "simulator-commit"
      ))
  )
    return;
  const root = evidence.observations.find(
    ({ signal }) => signal === trace.root,
  );
  if (root?.status !== "observed" || !root.value) return;

  const overlapsRoot = (event: ResolvedEvent) =>
    !root.projected ||
    root.bit === undefined ||
    !event.targetRange ||
    rangeWithin([root.bit, root.bit], event.targetRange);
  if (
    recording.events.some(
      (event) =>
        event.tick === commit.tick &&
        event.ordinal !== commit.ordinal &&
        (event.kind === "assignment-committed" ||
          event.kind === "signal-value-changed") &&
        overlapsRoot(event),
    )
  )
    return;

  const target = commit.targetRange;
  const layout = root.range;
  let value: string | undefined;
  if (root.projected) {
    if (root.bit === undefined || !layout) return;
    const range = target ?? layout;
    if (!rangeWithin(range, layout)) return;
    const bits = normalizeBits(commit.value, Math.abs(range[0] - range[1]) + 1);
    value = bits && sliceTraceBits(bits, range, root.bit, root.bit);
  } else {
    if (
      target &&
      (layout
        ? target[0] !== layout[0] || target[1] !== layout[1]
        : root.width !== 1 || target[0] !== target[1])
    )
      return;
    value = normalizeBits(commit.value, root.width);
  }
  if (value === undefined || root.value !== value) return;

  const assignment = links.find(
    ({ ordinal }) => ordinal === commit.ordinal,
  )?.assignment;
  const evaluation = recording.events.find(
    ({ ordinal }) => ordinal === commit.evaluationOrdinal,
  );
  if (
    assignment === undefined ||
    evaluation?.kind !== "assignment-evaluated" ||
    !links.some(
      ({ ordinal, assignment: id }) =>
        ordinal === evaluation.ordinal && id === assignment,
    )
  )
    return;
  return {
    tick: commit.tick,
    value,
    writer: recordedWriter(
      assignment,
      commit.ordinal,
      commit,
      evaluation,
      dirtySources,
    ),
  };
}

export function recordedOperandHistory(
  recording: Awaited<ReturnType<typeof readExecutionEvidence>>,
  links: ReturnType<typeof linkExecutionAssignments>,
  dirtySources?: ReadonlySet<string>,
) {
  const declared = recording.coverage.declared;
  if (
    recording.waveformMatch !== "verified" ||
    recording.truncated ||
    !hasWriteEventCoverage(recording.coverage) ||
    !declared
  )
    return;
  const commits = recording.events.filter(
    (event) => event.kind === "assignment-committed",
  );
  const unobserved = recording.events.filter(
    (event) => event.kind === "assignment-unobserved",
  );
  if (recording.coverage.status !== "complete" && !unobserved.length) return;
  const layout = commits.find(
    ({ targetPackedRange }) => targetPackedRange,
  )?.targetPackedRange;
  const width = layout && Math.abs(layout[0] - layout[1]) + 1;
  if (
    commits.some(
      (event) =>
        !event.value ||
        !event.writeKind ||
        (event.writeKind === "nonblocking" &&
          event.timing !== "simulator-commit") ||
        (width !== undefined &&
          !event.targetRange &&
          event.value.length !== width) ||
        (event.targetRange &&
          (!layout || !rangeWithin(event.targetRange, layout))) ||
        (event.targetPackedRange &&
          (event.targetPackedRange[0] !== layout?.[0] ||
            event.targetPackedRange[1] !== layout?.[1])),
    )
  )
    return;
  const byOrdinal = new Map(
    recording.events.map((event) => [event.ordinal, event]),
  );
  const assignments = new Map(
    links.map(({ ordinal, assignment }) => [ordinal, assignment]),
  );
  return (tick: string, ordinal: number, value: string, bit?: number) => {
    const time = BigInt(tick);
    if (
      time < BigInt(declared.start) ||
      (width !== undefined && value.length !== width) ||
      (bit !== undefined && (!layout || !rangeWithin([bit, bit], layout)))
    )
      return;
    const earlier = commits.filter((event) => event.ordinal < ordinal);
    const possibleLosses = unobserved.filter(
      (event) =>
        BigInt(event.tick) <= time && event.evaluationOrdinal! < ordinal,
    );
    // An outcome callback can follow the operand read. A single pending
    // write of a different value is excluded by the captured operand.
    const pending = commits.filter(
      (event) =>
        event.tick === tick &&
        event.ordinal > ordinal &&
        event.evaluationOrdinal! < ordinal,
    );
    const recover = (captured: string, index?: number) => {
      const partValue = (event: ResolvedEvent) => {
        const bits = event.value!.toLowerCase();
        return index === undefined
          ? bits
          : sliceTraceBits(bits, event.targetRange ?? layout, index, index);
      };
      const commit = earlier.findLast(
        (event) => partValue(event) !== undefined,
      );
      if (
        !commit ||
        BigInt(commit.tick) >= time ||
        BigInt(commit.tick) < BigInt(declared.start) ||
        partValue(commit) !== captured
      )
        return;
      // A confirmed write in a later tick supersedes the uncertainty for its
      // own bits. Outcomes within one tick can be reported out of store order.
      if (
        possibleLosses.some(
          (loss) =>
            BigInt(loss.tick) >= BigInt(commit.tick) &&
            (index === undefined ||
              !loss.targetRange ||
              (index >= Math.min(...loss.targetRange) &&
                index <= Math.max(...loss.targetRange))),
        )
      )
        return;
      const pendingValues = pending
        .map(partValue)
        .filter((part) => part !== undefined);
      if (pendingValues.length > 1 || pendingValues.includes(captured)) return;
      const assignment = assignments.get(commit.ordinal);
      const evaluation = byOrdinal.get(commit.evaluationOrdinal!);
      if (
        assignment === undefined ||
        evaluation?.kind !== "assignment-evaluated" ||
        assignments.get(evaluation.ordinal) !== assignment
      )
        return;
      return recordedWriter(
        assignment,
        commit.ordinal,
        commit,
        evaluation,
        dirtySources,
      );
    };
    if (!layout) {
      const writer = recover(value);
      return writer
        ? [{ tick: byOrdinal.get(writer.commitOrdinal)!.tick, value, writer }]
        : undefined;
    }
    const direction = layout[0] <= layout[1] ? 1 : -1;
    const bits =
      bit === undefined
        ? Array.from(
            { length: value.length },
            (_, offset) => layout[0] + offset * direction,
          )
        : [bit];
    const parts = bits.map((index) => {
      const captured = value[Math.abs(index - layout[0])];
      const writer = recover(captured, index);
      return {
        tick: writer ? byOrdinal.get(writer.commitOrdinal)!.tick : tick,
        bit: index,
        value: captured,
        writer,
      };
    });
    return parts.some(({ writer }) => writer) ? parts : undefined;
  };
}

export function executionMermaid(evidence: {
  events: readonly ResolvedEvent[];
}) {
  return executionMermaidPages(evidence)[0];
}

export function executionMermaidPages(evidence: {
  events: readonly ResolvedEvent[];
}) {
  const graph = createMermaidFlowchart();
  const processSteps = new Map<string, ExecutionEvent>();
  const visible = new Set(evidence.events.map(({ ordinal }) => ordinal));
  let lastCommit: number | undefined;
  for (const event of evidence.events) {
    const label = [
      event.tick,
      event.ordinal,
      event.kind,
      event.timing,
      event.targetRange && "[" + event.targetRange.join(":") + "]",
      event.signal && event.instance + "." + event.signal,
      event.kind !== "signal-value-changed" ? event.statementId : undefined,
      event.statementSite &&
        path.basename(event.statementSite.file) +
          ":" +
          event.statementSite.line,
      event.value,
    ]
      .filter((part) => part !== undefined)
      .join(" · ");
    graph.node("e" + event.ordinal, label);
  }
  const lastSignalChanges = new Map<string, number>();
  let lastCallback: { signal: string; ordinal: number } | undefined;
  let previous: ResolvedEvent | undefined;
  for (const event of evidence.events) {
    const node = "e" + event.ordinal;
    if (
      previous &&
      ((previous.kind === "assignment-entered" &&
        event.kind === "signal-value-changed") ||
        (previous.kind === "signal-value-changed" &&
          event.kind === "assignment-entered") ||
        (previous.kind === "assignment-entered" &&
          event.kind === "assignment-entered"))
    )
      graph.edge(
        "e" + previous.ordinal,
        node,
        event.ordinal === previous.ordinal + 1
          ? "next recorded callback"
          : "later recorded callback",
        true,
      );
    previous = event;
    if (event.kind === "assignment-entered") continue;
    if (event.kind === "signal-value-changed") {
      const signal = JSON.stringify([event.instance, event.signal]);
      const previous = lastSignalChanges.get(signal);
      if (previous !== undefined)
        graph.edge("e" + previous, node, "next value change", true);
      if (lastCallback && lastCallback.signal !== signal)
        graph.edge(
          "e" + lastCallback.ordinal,
          node,
          event.ordinal === lastCallback.ordinal + 1
            ? "next recorded callback"
            : "later recorded callback",
          true,
        );
      lastSignalChanges.set(signal, event.ordinal);
      lastCallback = { signal, ordinal: event.ordinal };
      continue;
    }
    let previousStep: string | undefined;
    for (const [index, step] of (event.externalSteps ?? []).entries()) {
      const stepNode = node + "_external" + index;
      const identity = event.resolvedExternalSteps?.[index]?.source.identity;
      graph.node(
        stepNode,
        step.operation +
          (step.value === undefined ? "" : " = " + step.value) +
          (identity === undefined ? "" : " · Source " + identity),
      );
      if (previousStep)
        graph.edge(previousStep, stepNode, "next recorded step");
      previousStep = stepNode;
    }
    if (previousStep) graph.edge(previousStep, node, "external execution");
    const process = JSON.stringify([
      event.instance,
      event.processId,
      event.tick,
    ]);
    const predecessor = finishesEvaluation(event)
      ? event.evaluationOrdinal
      : event.kind === "process-trigger"
        ? undefined
        : processSteps.get(process)?.ordinal;
    if (predecessor !== undefined && visible.has(predecessor)) {
      graph.edge(
        "e" + predecessor,
        node,
        event.kind === "assignment-unobserved"
          ? "outcome unobserved"
          : undefined,
      );
    }
    if (
      event.replacementOrdinal !== undefined &&
      visible.has(event.replacementOrdinal)
    )
      graph.edge("e" + event.replacementOrdinal, node, "supersedes", true);
    if (!finishesEvaluation(event)) processSteps.set(process, event);
    if (event.kind === "assignment-committed") {
      if (lastCommit !== undefined)
        graph.edge("e" + lastCommit, node, "next commit", true);
      lastCommit = event.ordinal;
    }
  }
  return graph.pages();
}
