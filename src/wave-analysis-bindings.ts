// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { BackendProtocol, Signal } from "./shared/protocol";
import * as path from "node:path";
import { type TraceProjectSelection } from "./project";
import { findRtlSignals, fsdbGenerateScope } from "./signal-lookup";
import { isMissingKdbDeclaration, mapPrefix } from "./kdb";
import {
  declaredSignalName,
  TraceContextChanged,
  selectionText,
  isStaticBudgetStop,
  traceSignalScope,
  packedStructPorts,
  type TraceDirection,
  type TraceOptions,
  type VideTrace,
} from "./rtl-trace";
import {
  followStaticFrontier,
  type StaticWalk,
} from "./rtl-static-continuations";
import {
  readTraceObservations,
  tracePackedSelection,
} from "./rtl-trace-observations";
import { focusPackedTrace, hasPackedSelection } from "./rtl-trace-bits";
import {
  buildTemporalTrace,
  type ObservedTraceWord,
  type RecordedTraceField,
  type TraceBindingIssue,
} from "./rtl-trace-candidates";
import { readExecutionEvidenceBatch } from "./rtl-execution";

import type { AnalysisView, TraceHost } from "./wave-analysis-types";
import type {
  AnalysisProjects,
  TraceRequestProject,
  WaveTraceResult,
} from "./wave-analysis-projects";

export function createAnalysisBindings<V extends AnalysisView>(
  host: TraceHost,
  projects: Pick<
    AnalysisProjects<V>,
    "dumpScope" | "traceWaveSignal" | "createContinuationGuard"
  >,
) {
  const { dumpScope, traceWaveSignal, createContinuationGuard } = projects;
  type Matches = BackendProtocol["matchNames"]["result"];
  const traceNames = new WeakMap<
    NonNullable<V["meta"]>,
    Map<string, Promise<Matches>>
  >();

  function matchTraceNames(viewer: V, query: string, names: string[]) {
    const meta = viewer.meta;
    if (!meta) return viewer.backend.request("matchNames", { query, names });
    let cache = traceNames.get(meta);
    if (!cache) traceNames.set(meta, (cache = new Map()));
    const key = JSON.stringify([query, [...names].sort()]);
    const existing = cache.get(key);
    if (existing) {
      cache.delete(key);
      cache.set(key, existing);
      return existing;
    }
    const matches = viewer.backend.request("matchNames", { query, names });
    cache.set(key, matches);
    if (cache.size > 256) cache.delete(cache.keys().next().value!);
    const discard = () => {
      if (cache.get(key) === matches) cache.delete(key);
    };
    void matches.then((result) => {
      if (result.truncated) discard();
    }, discard);
    return matches;
  }

  async function bindTraceObservations(
    viewer: V,
    result: Pick<WaveTraceResult, "instance" | "design" | "signal"> & {
      trace: Pick<VideTrace, "root" | "signals">;
    },
    selected?: ReadonlySet<number>,
  ) {
    const { trace, instance, design, signal } = result;
    const bindings = new Map([[trace.root, signal]]);
    const packedRanges = new Map<number, [number, number]>();
    const dirtyUris = new Set(
      host.workspace.textDocuments
        .filter((document) => document.isDirty)
        .map((document) => document.uri.toString()),
    );
    const issues = new Map<number, TraceBindingIssue>();
    const byInstance = new Map<string, VideTrace["signals"]>();
    for (const candidate of trace.signals) {
      if (
        candidate.id === trace.root ||
        candidate.enumValue ||
        candidate.enumValueUnavailable ||
        candidate.packageParameterValue ||
        candidate.packageParameterValueUnavailable ||
        candidate.instanceParameter ||
        candidate.parameterValue ||
        (selected && !selected.has(candidate.id))
      )
        continue;
      if (!candidate.declaration) {
        issues.set(candidate.id, "missingDeclaration");
        continue;
      }
      const scope = traceSignalScope(candidate, instance);
      const group = byInstance.get(scope) ?? [];
      group.push(candidate);
      byInstance.set(scope, group);
    }
    const config = host.workspace.getConfiguration("waveWorkbench", viewer.uri);
    const sourceMappings =
      config.get<Record<string, string>>("sourcePathMappings");
    // VCS can encode a generate scope as a prefix of the VCD variable name.
    const matchVcdPaths =
      design.kind === "kdb" && viewer.meta?.backend === "rust-vcd";
    for (const [instance, candidates] of byInstance) {
      const dump = dumpScope(viewer, instance);
      const alias = design.kind === "kdb" ? fsdbGenerateScope(dump) : dump;
      for (let offset = 0; offset < candidates.length; offset += 64) {
        const batch = candidates.slice(offset, offset + 64);
        const names = [...new Set(batch.map(({ name }) => name))];
        const { matches } = await matchTraceNames(
          viewer,
          matchVcdPaths ? "" : dump,
          matchVcdPaths ? names.map((name) => dump + "." + name) : names,
        );
        const aliasNames =
          matchVcdPaths || alias === dump
            ? []
            : names.filter((name) => !Object.hasOwn(matches, name));
        const aliases = aliasNames.length
          ? (await matchTraceNames(viewer, alias, aliasNames)).matches
          : undefined;
        for (const candidate of batch) {
          const full = dump + "." + candidate.name;
          const lookup = matchVcdPaths ? full : candidate.name;
          const dumped = Object.hasOwn(matches, lookup)
            ? matches[lookup]
            : aliases && Object.hasOwn(aliases, candidate.name)
              ? aliases[candidate.name]
              : undefined;
          const scoped = dumped?.filter((entry) =>
            matchVcdPaths
              ? entry.scope +
                  "." +
                  declaredSignalName(entry.name).replace(/^\\/, "") ===
                full
              : entry.scope === dump || entry.scope === alias,
          );
          const exact = scoped?.filter((entry) => entry.supported);
          if (exact?.length !== 1) {
            issues.set(
              candidate.id,
              !scoped?.length
                ? "waveformMissing"
                : exact?.length
                  ? "waveformAmbiguous"
                  : "waveformUnsupported",
            );
            continue;
          }
          const designPath =
            instance +
            "." +
            (matchVcdPaths
              ? candidate.name
              : declaredSignalName(exact[0].name));
          const object = await design.resolve(designPath).catch((error) => {
            if (!isMissingKdbDeclaration(error)) throw error;
            return undefined;
          });
          if (!object) {
            issues.set(candidate.id, "designObjectMissing");
            continue;
          }
          if (!object.file || object.line < 1) {
            issues.set(candidate.id, "designLocationMissing");
            continue;
          }
          if (
            (object.instance !== instance &&
              !(
                candidate.lexicalScope?.length &&
                object.fullname === designPath &&
                instance.startsWith(object.instance + ".")
              )) ||
            object.line !== candidate.declaration!.range.start.line + 1
          ) {
            issues.set(candidate.id, "declarationMismatch");
            continue;
          }
          const mapped = path.resolve(
            path.dirname(design.path),
            mapPrefix(object.file, sourceMappings),
          );
          if (host.file(mapped).toString() === candidate.declaration!.uri) {
            bindings.set(candidate.id, exact[0]);
            if (
              object.packedRange &&
              !candidate.packedRange &&
              !object.interfaceRange &&
              !dirtyUris.has(candidate.declaration!.uri)
            )
              packedRanges.set(candidate.id, object.packedRange);
          } else issues.set(candidate.id, "declarationMismatch");
        }
      }
    }
    return { bindings, issues, packedRanges };
  }

  function withElaboratedPackedRanges(
    trace: VideTrace,
    ranges: ReadonlyMap<number, [number, number]>,
  ): VideTrace {
    if (
      !ranges.size ||
      trace.frontier.some(
        ({ reason }) =>
          reason === "mismatchedDesign" ||
          reason === "unverifiedVcsParameterPath",
      )
    )
      return trace;
    return {
      ...trace,
      signals: trace.signals.map((signal) => {
        const packedRange = ranges.get(signal.id);
        return packedRange ? { ...signal, packedRange } : signal;
      }),
    };
  }

  async function bindStaticFrontier(
    viewer: V,
    result: WaveTraceResult,
    existingBindings?: ReadonlyMap<number, Signal>,
  ) {
    const { trace, design } = result;
    const selected = new Set(
      trace.frontier
        .filter(({ reason }) => isStaticBudgetStop(reason))
        .map(({ signal }) => signal),
    );
    if (!selected.size) return trace;
    const backend = viewer.backend;
    const bindings =
      existingBindings ??
      (await bindTraceObservations(viewer, result, selected)).bindings;
    if (viewer.disposed || viewer.backend !== backend || viewer.kdb !== design)
      throw Error("The waveform design changed during the trace query.");
    const frontier = trace.frontier.flatMap<VideTrace["frontier"][number]>(
      (item) => {
        if (!isStaticBudgetStop(item.reason)) return [item];
        const binding = bindings.get(item.signal);
        if (!binding?.supported) return [{ ...item, continuation: null }];
        const { bit, projected, range } = tracePackedSelection(binding);
        const base = binding.scope + "." + declaredSignalName(binding.name);
        const projectedBit = projected ? (bit ?? binding.bitOffset) : undefined;
        if (!item.bits?.length) {
          const signal =
            projectedBit === undefined
              ? base
              : base + selectionText(undefined, projectedBit);
          return [{ ...item, continuation: { signal } }];
        }
        const [first, last] = range ?? [binding.width - 1, 0];
        const available = (index: number) =>
          projectedBit === undefined
            ? index >= Math.min(first, last) && index <= Math.max(first, last)
            : index === projectedBit;
        const bits = item.bits.filter(available);
        const missing = item.bits.filter((index) => !available(index));
        return [
          ...(bits.length
            ? [{ ...item, bits, continuation: { signal: base, bits } }]
            : []),
          ...(missing.length
            ? [{ ...item, bits: missing, continuation: null }]
            : []),
        ];
      },
    );
    return { ...trace, frontier };
  }

  async function focusWaveTrace(
    viewer: V,
    result: WaveTraceResult,
    fullname: string,
    direction: TraceDirection,
  ) {
    const { bit, range, projected } = tracePackedSelection(result.signal);
    const match = /\[\s*(-?\d+)\s*:\s*(-?\d+)\s*\]$/.exec(fullname);
    const alias = result.interfaceRange;
    const matchesAlias =
      range &&
      alias &&
      range[0] === alias[0] &&
      range[1] === alias[1] &&
      Math.abs(alias[0] - alias[1]) + 1 === result.signal.width;
    let selection: number | [number, number] | undefined =
      bit ?? (matchesAlias ? alias : undefined);
    if (match && !projected) {
      const left = Number(match[1]);
      const right = Number(match[2]);
      if (
        !range ||
        Math.abs(range[0] - range[1]) + 1 !== result.signal.width ||
        !Number.isSafeInteger(left) ||
        !Number.isSafeInteger(right) ||
        left < Math.min(...range) ||
        left > Math.max(...range) ||
        right < Math.min(...range) ||
        right > Math.max(...range) ||
        (left - right) * (range[0] - range[1]) < 0
      )
        throw Error(
          "Packed selection does not match the dumped range for " + fullname,
        );
      // An exact declaration suffix is also a canonical name for the whole bus.
      if (left !== range[0] || right !== range[1]) selection = [left, right];
    }
    if (
      selection === undefined &&
      (direction !== "drivers" ||
        projected ||
        result.signal.width !== 1 ||
        !result.trace.assignments.some(({ value }) =>
          hasPackedSelection(value),
        ))
    )
      return result;
    const { bindings, packedRanges } = await bindTraceObservations(
      viewer,
      result,
    );
    if (viewer.disposed || viewer.kdb !== result.design)
      throw Error("The waveform design changed during the trace query.");
    return {
      ...result,
      trace: focusPackedTrace(
        withElaboratedPackedRanges(result.trace, packedRanges),
        selection,
        direction,
        bindings,
      ),
    };
  }

  function traceSignedness(trace: VideTrace) {
    const signedness = new Map<number, boolean>();
    for (const { id, signed } of trace.signals)
      if (signed !== undefined) signedness.set(id, signed);
    return signedness;
  }

  async function bindObservedTraceWords(
    viewer: V,
    result: WaveTraceResult,
    reads: NonNullable<ReturnType<typeof buildTemporalTrace>["wordReads"]>,
    operation?: AbortSignal,
  ) {
    const { trace, design, instance } = result;
    const signals = new Map(trace.signals.map((signal) => [signal.id, signal]));
    const mappings = host.workspace
      .getConfiguration("waveWorkbench", viewer.uri)
      .get<Record<string, string>>("sourcePathMappings");
    let id = trace.signals.reduce(
      (max, signal) => Math.max(max, signal.id + 1),
      0,
    );
    const bindings = new Map<number, Signal>();
    const words: ObservedTraceWord[] = [];
    const visited = new Set<string>();
    for (const { signal, index } of reads) {
      operation?.throwIfAborted();
      const key = signal + ":" + index;
      if (visited.has(key)) continue;
      if (visited.size >= 64) break;
      visited.add(key);
      const candidate = signals.get(signal);
      if (!candidate?.declaration || !Number.isSafeInteger(Number(index)))
        continue;
      const scope = candidate.instance ?? instance;
      const name = candidate.name + "[" + index + "]";
      const dump = dumpScope(viewer, scope);
      const found = await findRtlSignals(viewer.backend, dump, name);
      const binding = found.signals.find(
        (entry) =>
          entry.bitOffset === undefined &&
          declaredSignalName(entry.name) === name &&
          (entry.scope === dump ||
            entry.scope === dump + "." + candidate.name ||
            (design.kind === "kdb" && entry.scope === fsdbGenerateScope(dump))),
      );
      if (!binding) continue;
      const location = await design
        .resolve(scope + "." + name)
        .catch((error) => {
          if (!isMissingKdbDeclaration(error)) throw error;
          return undefined;
        });
      if (
        !location?.file ||
        location.instance !== scope ||
        location.line !== candidate.declaration.range.start.line + 1
      )
        continue;
      const source = path.resolve(
        path.dirname(design.path),
        mapPrefix(location.file, mappings),
      );
      if (host.file(source).toString() !== candidate.declaration.uri) continue;
      words.push({ id, array: signal, index, name, instance: scope });
      bindings.set(id++, binding);
    }
    return { words, bindings };
  }

  async function readRecordedTraceFields(
    viewer: V,
    trace: VideTrace,
    instance: string,
    graph: ReturnType<typeof buildTemporalTrace>,
    evidence: Awaited<ReturnType<typeof readTraceObservations>>,
    filename: string,
    operation?: AbortSignal,
  ) {
    const reached = new Set(graph.nodes.map(({ signal }) => signal));
    const signals = new Map(trace.signals.map((signal) => [signal.id, signal]));
    // Waveform words and execution log fields use separate ranges of IDs.
    let id =
      trace.signals.reduce((max, signal) => Math.max(max, signal.id + 1), 0) +
      64;
    const requested = new Map<string, RecordedTraceField>();
    function request(signalId: number, field: string) {
      const signal = signals.get(signalId);
      if (!signal?.declaration || requested.size >= 64) return;
      const scope = signal.instance ?? instance;
      const key = signalId + ":" + field;
      if (!requested.has(key))
        requested.set(key, {
          signal: signalId,
          field,
          id: id++,
          instance: scope,
          name: signal.name + "." + field,
        });
    }
    for (const { kind, targets, fieldRead } of trace.assignments) {
      if (
        kind === "continuous" &&
        fieldRead &&
        targets.some((target) => reached.has(target))
      )
        request(fieldRead.signal, fieldRead.field);
    }
    const ports = new Map<number, number[]>();
    for (const { target, source } of packedStructPorts(trace)) {
      const incoming = ports.get(target) ?? [];
      incoming.push(source);
      ports.set(target, incoming);
    }
    for (const { signal, field } of requested.values())
      for (const source of ports.get(signal) ?? []) request(source, field);
    for (const { inputs, port } of trace.assignments)
      if (port?.fromField && inputs.length === 1)
        request(inputs[0].signal, port.fromField);
    for (const { signal, field } of requested.values())
      for (const source of ports.get(signal) ?? []) request(source, field);
    const selected = [...requested.values()];
    if (!selected.length) return { fields: [], observations: [] };
    const recordings = await readExecutionEvidenceBatch(
      filename,
      viewer.uri.fsPath,
      evidence.scale,
      selected.map(({ instance: scope, name, field }) => ({
        instance: scope + "." + name.slice(0, -(field.length + 1)),
        signal: field,
      })),
      viewer.meta.start,
      evidence.tick,
      256,
      operation,
    );
    const fields: RecordedTraceField[] = [];
    const observations: typeof evidence.observations = [];
    const start = BigInt(evidence.historyStart);
    const end = BigInt(evidence.historyEnd);
    for (const [index, recording] of recordings.entries()) {
      if (
        recording.observationCoverage?.status !== "complete" ||
        recording.waveformMatch !== "verified"
      )
        continue;
      const values = recording.events.flatMap(({ kind, tick, value }) =>
        kind === "signal-value-changed" && value !== undefined
          ? [{ tick, value }]
          : [],
      );
      const first = values[0];
      const latest = values.at(-1);
      if (
        !first ||
        !latest ||
        values.some(({ value }) => value.length !== first.value.length)
      )
        continue;
      const field = selected[index];
      const initial = values.findLast(({ tick }) => BigInt(tick) < start);
      const history = values.filter(
        ({ tick }) => BigInt(tick) >= start && BigInt(tick) <= end,
      );
      fields.push(field);
      observations.push({
        signal: field.id,
        waveformSignal: field.instance + "." + field.name,
        value: latest.value,
        width: first.value.length,
        real: undefined,
        signed: undefined,
        projected: false,
        bit: undefined,
        range: undefined,
        status: "observed",
        initial,
        history,
        historyTruncated: false,
        historyLimitedToTransition: undefined,
        cursorSamples: undefined,
      });
    }
    return { fields, observations };
  }

  async function createStaticWalk(
    viewer: V,
    root: string,
    result: WaveTraceResult,
    direction: TraceDirection,
    options: TraceOptions,
    override?: TraceProjectSelection,
    assertActive?: () => void,
    retainCheckpoint = false,
  ) {
    const guard = await createContinuationGuard(
      viewer,
      result,
      undefined,
      undefined,
      retainCheckpoint,
    );
    const assertCurrent = async () => {
      assertActive?.();
      await guard.assertCurrent();
    };
    const compilationIdentity = (trace: VideTrace) =>
      trace.compilation &&
      JSON.stringify({
        ...trace.compilation,
        files: [...trace.compilation.files].sort(),
      });
    const compilation = compilationIdentity(result.trace);
    const run = (
      limit: number,
      operation: AbortSignal,
      deadline: AbortSignal,
      previous?: StaticWalk["segments"],
      requestProject?: TraceRequestProject,
      selected?: readonly string[],
    ) =>
      followStaticFrontier(
        root,
        result.trace,
        limit,
        operation,
        deadline,
        async (signal, abort) => {
          const cancellation = host.cancellation();
          const cancel = () => cancellation.cancel();
          abort.throwIfAborted();
          abort.addEventListener("abort", cancel, { once: true });
          try {
            const next = await focusWaveTrace(
              viewer,
              await traceWaveSignal(
                viewer,
                direction,
                signal,
                options,
                cancellation.token,
                override,
                result.buildManifest,
                requestProject,
              ),
              signal,
              direction,
            );
            // VIDE revisions are scoped to a language server process.
            const sameContext =
              next.analysisProject === result.analysisProject
                ? next.trace.revision === result.trace.revision
                : compilation !== undefined &&
                  compilationIdentity(next.trace) === compilation;
            if (!sameContext)
              throw new TraceContextChanged(
                "The RTL analysis context changed during continuation.",
              );
            return await bindStaticFrontier(viewer, next);
          } finally {
            abort.removeEventListener("abort", cancel);
            cancellation.dispose();
          }
        },
        assertCurrent,
        previous,
        selected,
      );
    return { run, assertCurrent, checkpoint: guard.checkpoint };
  }

  return {
    bindTraceObservations,
    bindStaticFrontier,
    focusWaveTrace,
    withElaboratedPackedRanges,
    traceSignedness,
    bindObservedTraceWords,
    readRecordedTraceFields,
    createStaticWalk,
  };
}

export type AnalysisBindings<V extends AnalysisView> = ReturnType<
  typeof createAnalysisBindings<V>
>;

export type TraceBindings = Awaited<
  ReturnType<AnalysisBindings<AnalysisView>["bindTraceObservations"]>
>;
