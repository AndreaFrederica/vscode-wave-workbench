// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { isFsdb } from "./backend-selection";
import * as WaveSignal from "./shared/signals";
import { KdbSession } from "./kdb";
import { declaredSignalName } from "./rtl-trace";
import { readTraceObservations } from "./rtl-trace-observations";
import { traceRuntimeInputs } from "./rtl-runtime-inputs";
import {
  buildTemporalTrace,
  traceAssignmentCandidates,
  traceCursorWriters,
  type ObservedTraceWord,
  type RecordedOperandHistory,
  type RecordedValueCallbacks,
  type RecordedTraceField,
  type TemporalLimits,
} from "./rtl-trace-candidates";
import {
  annotateRecordedValueChanges,
  attachRecordedTaskTransfers,
  reconcileRecordedWordHistory,
  correlateExecutionTransitions,
  ExecutionRecordingIdentityError,
  linkExecutionAssignments,
  matchRecordedModportComponents,
  preserveDumpedTransitionEvidence,
  readExecutionEvidenceBatch,
  reachedWriteEvents,
  recordedCursorWrite,
  recordedOperandHistory,
  recordedWriters,
  restoreRecordedSignalHistory,
} from "./rtl-execution";
import {
  LIVE_EXECUTION_BUFFER_LIMIT,
  LiveTraceSession,
  matchLiveExecution,
} from "./rtl-live-trace";
import {
  type verifyLiveTraceBuild,
  type verifyTraceBuild,
} from "./rtl-build-verification";

import type {
  AnalysisView,
  GetLiveTrace,
  TraceHost,
} from "./wave-analysis-types";
import type { WaveTraceResult } from "./wave-analysis-projects";
import type { AnalysisBindings, TraceBindings } from "./wave-analysis-bindings";

export function createAnalysisObservations<V extends AnalysisView>(
  host: TraceHost,
  getLive: GetLiveTrace,
  bindings: Pick<
    AnalysisBindings<V>,
    | "withElaboratedPackedRanges"
    | "bindObservedTraceWords"
    | "readRecordedTraceFields"
  >,
) {
  const {
    withElaboratedPackedRanges,
    bindObservedTraceWords,
    readRecordedTraceFields,
  } = bindings;

  async function traceObservedContext(
    viewer: V,
    result: WaveTraceResult,
    evidence: Awaited<ReturnType<typeof readTraceObservations>>,
    { bindings, issues, packedRanges }: TraceBindings,
    verification?:
      | Awaited<ReturnType<typeof verifyTraceBuild>>
      | ReturnType<typeof verifyLiveTraceBuild>,
    operation?: AbortSignal,
    executionFile?: string,
    live?: LiveTraceSession,
    expandReachable?: boolean,
    runtimeMismatches?: string[],
    limits?: TemporalLimits,
  ) {
    const { design, instance, signal } = result;
    const trace = withElaboratedPackedRanges(result.trace, packedRanges);
    function buildObservedTrace(
      ...args: Parameters<typeof buildTemporalTrace>
    ) {
      const [trace, evidence, ...options] = args;
      return buildTemporalTrace(
        trace,
        {
          ...evidence,
          bindingIssues: issues,
          externalPliCallbacks: !!verification?.vcsPli?.length,
        },
        ...options,
      );
    }
    const waveformBindings = new Map(bindings);
    const mismatched =
      verification?.status === "mismatched" ||
      trace.frontier.some(
        ({ reason }) => reason === "unverifiedVcsParameterPath",
      );
    const readRecording =
      executionFile &&
      (!live ||
        (verification &&
          "executionReplayEligible" in verification &&
          verification.executionReplayEligible &&
          !runtimeMismatches?.length));
    let temporalTrace = mismatched
      ? undefined
      : buildObservedTrace(
          trace,
          evidence,
          undefined,
          expandReachable,
          undefined,
          limits,
        );
    let words: ObservedTraceWord[] | undefined;
    const initialWordReads = temporalTrace?.wordReads ?? [];
    if (!live && temporalTrace?.wordReads?.length) {
      const extra = await bindObservedTraceWords(
        viewer,
        result,
        temporalTrace.wordReads,
        operation,
      );
      if (extra.words.length) {
        for (const [id, binding] of extra.bindings)
          waveformBindings.set(id, binding);
        const sampledWords = await readTraceObservations(
          viewer.backend,
          viewer.meta,
          extra.bindings,
          evidence.historyEnd,
          evidence.historyStart,
          undefined,
          undefined,
          operation,
        );
        words = extra.words;
        evidence = {
          ...evidence,
          observations: [
            ...evidence.observations,
            ...sampledWords.observations,
          ],
        };
        temporalTrace = buildObservedTrace(
          trace,
          evidence,
          undefined,
          expandReachable,
          undefined,
          limits,
          words,
        );
      }
    }
    let fields: RecordedTraceField[] | undefined;
    if (!live && executionFile && temporalTrace) {
      const recorded = await readRecordedTraceFields(
        viewer,
        trace,
        instance,
        temporalTrace,
        evidence,
        executionFile,
        operation,
      );
      if (recorded.fields.length) {
        fields = recorded.fields;
        evidence = {
          ...evidence,
          observations: [...evidence.observations, ...recorded.observations],
        };
        temporalTrace = buildObservedTrace(
          trace,
          evidence,
          undefined,
          expandReachable,
          undefined,
          limits,
          words,
          fields,
        );
        const priorWords = new Set(
          words?.map(({ array, index }) => array + ":" + index),
        );
        if (
          temporalTrace.wordReads?.some(
            ({ signal, index }) => !priorWords.has(signal + ":" + index),
          )
        ) {
          const extra = await bindObservedTraceWords(
            viewer,
            result,
            [...initialWordReads, ...temporalTrace.wordReads],
            operation,
          );
          if (extra.words.length) {
            const samples = await readTraceObservations(
              viewer.backend,
              viewer.meta,
              extra.bindings,
              evidence.historyEnd,
              evidence.historyStart,
              undefined,
              undefined,
              operation,
            );
            const priorIds = new Set(words?.map(({ id }) => id));
            words = extra.words;
            evidence = {
              ...evidence,
              observations: [
                ...evidence.observations.filter(
                  ({ signal }) => !priorIds.has(signal),
                ),
                ...samples.observations,
              ],
            };
            temporalTrace = buildObservedTrace(
              trace,
              evidence,
              undefined,
              expandReachable,
              undefined,
              limits,
              words,
              fields,
            );
          }
        }
      }
    }
    const rootIndex = trace.signals.find(
      ({ id }) => id === trace.root,
    )?.selectedElement;
    const rootSignal = declaredSignalName(signal.name);
    const rootWord: ObservedTraceWord | undefined =
      rootIndex === undefined || live || !(design instanceof KdbSession)
        ? undefined
        : {
            id: trace.root,
            array: trace.root,
            index: String(rootIndex),
            name: rootSignal,
            instance,
          };
    const replayWords = rootWord ? [rootWord, ...(words ?? [])] : words;
    const wordChanges = new Map<
      number,
      NonNullable<ReturnType<typeof reconcileRecordedWordHistory>>["changes"]
    >();
    if (!live && executionFile && temporalTrace && replayWords?.length) {
      const observations = new Map(
        evidence.observations.map((item) => [item.signal, item]),
      );
      const recordings = await readExecutionEvidenceBatch(
        executionFile,
        viewer.uri.fsPath,
        evidence.scale,
        replayWords.map(({ instance, name: signal }) => ({ instance, signal })),
        viewer.meta.start,
        evidence.historyEnd,
        256,
        operation,
      );
      for (const [index, recording] of recordings.entries()) {
        const observation = observations.get(replayWords[index].id);
        if (!observation) continue;
        const refined = reconcileRecordedWordHistory(
          observation,
          recording,
          evidence.historyStart,
          evidence.historyEnd,
        );
        if (!refined) continue;
        const cursorSamples = observation.cursorSamples;
        observations.set(observation.signal, {
          ...observation,
          history: refined.history,
          ...(cursorSamples &&
            !cursorSamples.truncated && {
              cursorSamples: {
                ...cursorSamples,
                events: refined.history.filter(
                  ({ tick }) => tick === evidence.tick,
                ),
              },
            }),
        });
        wordChanges.set(observation.signal, refined.changes);
      }
      if (wordChanges.size) {
        evidence = { ...evidence, observations: [...observations.values()] };
        temporalTrace = buildObservedTrace(
          trace,
          evidence,
          undefined,
          expandReachable,
          undefined,
          limits,
          words,
          fields,
        );
      }
    }
    const sampled = new Set(
      readRecording
        ? evidence.observations.flatMap(({ signal, history }) =>
            history.length ? [signal] : [],
          )
        : [],
    );
    if (readRecording && temporalTrace)
      for (const assignment of trace.assignments)
        for (const input of assignment.inputs)
          if (input.kind === "data" && !input.hierarchical)
            sampled.add(input.signal);
    const selected: {
      id: number;
      instance: string;
      signal: string;
      word?: ObservedTraceWord;
    }[] = [
      { id: trace.root, instance, signal: rootSignal },
      ...trace.signals
        .flatMap((entry) =>
          entry.id !== trace.root && sampled.has(entry.id) && entry.instance
            ? [{ id: entry.id, instance: entry.instance, signal: entry.name }]
            : [],
        )
        .sort((left, right) => left.id - right.id),
      ...(!live
        ? (words ?? []).map((word) => ({
            id: word.id,
            instance: word.instance,
            signal: word.name,
            word,
          }))
        : []),
    ];
    let replayIdentityMismatch = false;
    const [execution, ...upstream] = readRecording
      ? await readExecutionEvidenceBatch(
          executionFile,
          viewer.uri.fsPath,
          evidence.scale,
          selected.map(({ instance, signal }) => ({ instance, signal })),
          evidence.historyStart,
          evidence.tick,
          live ? LIVE_EXECUTION_BUFFER_LIMIT : undefined,
          operation,
        ).catch((error: unknown) => {
          if (!live || !(error instanceof ExecutionRecordingIdentityError))
            throw error;
          replayIdentityMismatch = true;
          return [];
        })
      : [];
    operation?.throwIfAborted();
    if (live && live !== getLive())
      throw Error("The live simulation session changed.");
    if (viewer.disposed || viewer.kdb !== design)
      throw Error("The waveform design changed during trace sampling.");
    const replayMatch =
      live && executionFile
        ? {
            status: execution
              ? matchLiveExecution(
                  execution,
                  live.executionWindow(
                    instance,
                    selected[0].signal,
                    evidence.historyStart,
                    evidence.tick,
                    LIVE_EXECUTION_BUFFER_LIMIT,
                  ),
                  true,
                )
              : replayIdentityMismatch
                ? ("recordingIdentityMismatch" as const)
                : runtimeMismatches?.length
                  ? ("runtimeInputsDiffer" as const)
                  : ("buildUnverified" as const),
            upstream: upstream.flatMap((recording, index) => {
              if (
                !recording.coverage.declared &&
                !recording.observationCoverage
              )
                return [];
              const { id, instance, signal } = selected[index + 1];
              return [
                {
                  id,
                  instance,
                  signal,
                  status: matchLiveExecution(
                    recording,
                    live.executionWindow(
                      instance,
                      signal,
                      evidence.historyStart,
                      evidence.tick,
                      LIVE_EXECUTION_BUFFER_LIMIT,
                    ),
                    false,
                  ),
                },
              ];
            }),
          }
        : undefined;
    const dirtySources = new Set(
      host.workspace.textDocuments.flatMap((document) =>
        document.uri.scheme === "file" && document.isDirty
          ? [document.uri.fsPath]
          : [],
      ),
    );
    const executionAssignments =
      execution &&
      !mismatched &&
      (!replayMatch || replayMatch.status === "matched")
        ? linkExecutionAssignments(
            trace,
            execution,
            dirtySources,
            trace.root,
            rootWord,
          )
        : undefined;
    const upstreamRecordings = upstream.flatMap((recording, index) => {
      if (
        !recording.coverage.declared &&
        !recording.observationCoverage &&
        !recording.events.some((event) => event.kind === "signal-value-changed")
      )
        return [];
      const target = selected[index + 1];
      const { id, instance, signal } = target;
      if (
        replayMatch &&
        replayMatch.upstream.find((entry) => entry.id === id)?.status !==
          "matched"
      )
        return [];
      return [
        {
          id,
          instance,
          signal,
          word: target.word !== undefined,
          recording,
          assignments: linkExecutionAssignments(
            trace,
            recording,
            dirtySources,
            id,
            target.word,
          ),
        },
      ];
    });
    const waveformEvidence = evidence;
    const recordings = new Map([
      ...(execution ? [[trace.root, execution] as const] : []),
      ...upstreamRecordings.map(
        ({ id, recording }) => [id, recording] as const,
      ),
    ]);
    const valueCallbackCache = new Map<
      number,
      Map<string, { ordinal: number; value: string }[]>
    >();
    const recordedValueCallbacks: RecordedValueCallbacks = (id, tick) => {
      const recording = recordings.get(id);
      if (
        !recording ||
        recording.waveformMatch !== "verified" ||
        recording.observationCoverage?.status !== "complete" ||
        BigInt(tick) < BigInt(recording.start) ||
        BigInt(tick) > BigInt(recording.end)
      )
        return;
      let byTick = valueCallbackCache.get(id);
      if (!byTick) {
        byTick = new Map();
        for (const event of recording.events) {
          if (
            event.kind !== "signal-value-changed" ||
            event.value === undefined
          )
            continue;
          const slot = byTick.get(event.tick) ?? [];
          slot.push({ ordinal: event.ordinal, value: event.value });
          byTick.set(event.tick, slot);
        }
        valueCallbackCache.set(id, byTick);
      }
      return byTick.get(tick) ?? [];
    };
    const canRestoreHistory = live
      ? replayMatch?.status === "matched"
      : isFsdb(viewer.uri.fsPath);
    if (
      canRestoreHistory &&
      temporalTrace &&
      execution &&
      design instanceof KdbSession
    ) {
      const restored = restoreRecordedSignalHistory(
        evidence,
        new Map(
          [...recordings].filter(
            ([id]) => bindings.has(id) && id !== rootWord?.id,
          ),
        ),
      );
      if (restored) {
        evidence = restored;
        temporalTrace = buildObservedTrace(
          trace,
          evidence,
          undefined,
          expandReachable,
          undefined,
          limits,
          words,
          fields,
        );
      }
    }
    const compare = (
      graph: NonNullable<typeof temporalTrace>,
      samples = evidence,
    ) => {
      const reached = new Map<number, Set<number | undefined>>();
      for (const point of graph.nodes) {
        if (
          point.signal === trace.root ||
          (point.sampleOnly && point.operandEvaluationOrdinal === undefined)
        )
          continue;
        const bits = reached.get(point.signal) ?? new Set<number | undefined>();
        bits.add(point.bit);
        reached.set(point.signal, bits);
      }
      return {
        root:
          execution && executionAssignments
            ? correlateExecutionTransitions(
                trace.root,
                samples,
                graph,
                execution,
                executionAssignments,
                { word: rootWord !== undefined },
              )
            : undefined,
        upstream: upstreamRecordings.flatMap((entry) =>
          [...(reached.get(entry.id) ?? [])].map((bit) => ({
            ...entry,
            bit,
            transitions: correlateExecutionTransitions(
              entry.id,
              samples,
              graph,
              entry.recording,
              entry.assignments,
              { compareCursor: false, bit, word: entry.word },
            ),
          })),
        ),
      };
    };
    const operandHistories = new Map(
      upstreamRecordings.flatMap(({ id, recording, assignments }) => {
        const resolve = recordedOperandHistory(
          recording,
          assignments,
          dirtySources,
        );
        return resolve ? [[id, resolve] as const] : [];
      }),
    );
    const operandHistory: RecordedOperandHistory = (
      id,
      tick,
      ordinal,
      value,
      bit,
    ) => operandHistories.get(id)?.(tick, ordinal, value, bit);
    const cursorWrite =
      execution && executionAssignments && limits?.changeOrder === undefined
        ? recordedCursorWrite(
            trace,
            evidence,
            execution,
            executionAssignments,
            dirtySources,
          )
        : undefined;
    const callbackDriven =
      execution &&
      trace.assignments.some(
        ({ delayFreeContinuous }) => delayFreeContinuous,
      ) &&
      [execution, ...upstreamRecordings.map(({ recording }) => recording)].some(
        ({ observationCoverage }) => observationCoverage?.status === "complete",
      );
    if (
      temporalTrace &&
      (callbackDriven ||
        (cursorWrite &&
          BigInt(cursorWrite.tick) <= BigInt(evidence.historyEnd)))
    )
      temporalTrace = buildObservedTrace(
        trace,
        { ...evidence, recordedValueCallbacks },
        undefined,
        expandReachable,
        operandHistory,
        limits,
        words,
        fields,
        cursorWrite,
      );
    let comparisons =
      temporalTrace && execution ? compare(temporalTrace) : undefined;
    if (temporalTrace && comparisons && execution) {
      const attributed = new Map() as ReturnType<typeof recordedWriters>;
      const components = new Map() as ReturnType<
        typeof matchRecordedModportComponents
      >;
      const canMatchComponents =
        design instanceof KdbSession &&
        !mismatched &&
        (!live || replayMatch?.status === "matched") &&
        trace.assignments.some(
          ({ overlappingModportWrite }) => overlappingModportWrite,
        );
      const maxPasses = 8;
      for (let pass = 0; ; pass++) {
        operation?.throwIfAborted();
        const writers = recordedWriters(
          temporalTrace,
          comparisons.root ?? [],
          execution.events,
          dirtySources,
          executionAssignments,
          execution.coverage.declared?.start,
          rootWord?.id,
        );
        for (const {
          transitions,
          recording,
          assignments,
        } of comparisons.upstream)
          for (const [key, writer] of recordedWriters(
            temporalTrace,
            transitions,
            recording.events,
            dirtySources,
            assignments,
            recording.coverage.declared?.start,
          ))
            writers.set(key, writer);
        const nextComponents = canMatchComponents
          ? matchRecordedModportComponents(
              trace,
              evidence,
              temporalTrace,
              [
                ...(comparisons.root ?? []),
                ...comparisons.upstream.flatMap(
                  ({ transitions }) => transitions,
                ),
              ],
              recordings,
              dirtySources,
            )
          : undefined;
        if (
          [...writers.keys()].every((key) => attributed.has(key)) &&
          (!nextComponents ||
            [...nextComponents.keys()].every((key) => components.has(key)))
        )
          break;
        if (pass === maxPasses) {
          temporalTrace.coverage.status = "partial";
          temporalTrace.coverage.reasons.push("recordedAttributionBudget");
          break;
        }
        for (const [key, writer] of writers) attributed.set(key, writer);
        for (const [key, component] of nextComponents ?? [])
          components.set(key, component);
        temporalTrace = buildObservedTrace(
          trace,
          { ...evidence, recordedValueCallbacks },
          attributed,
          expandReachable,
          operandHistory,
          limits,
          words,
          fields,
          cursorWrite,
          components,
        );
        comparisons = compare(temporalTrace);
      }
      if (evidence !== waveformEvidence) {
        const dumped = compare(temporalTrace, waveformEvidence);
        if (comparisons.root && dumped.root)
          comparisons.root = preserveDumpedTransitionEvidence(
            comparisons.root,
            dumped.root,
          );
        const replayed = new Map(
          comparisons.upstream.map((entry) => [
            entry.id + ":" + (entry.bit ?? "*"),
            entry.transitions,
          ]),
        );
        comparisons.upstream = dumped.upstream.map((entry) => ({
          ...entry,
          transitions: preserveDumpedTransitionEvidence(
            replayed.get(entry.id + ":" + (entry.bit ?? "*")) ?? [],
            entry.transitions,
          ),
        }));
      }
      annotateRecordedValueChanges(temporalTrace, [
        ...(comparisons.root ?? []),
        ...comparisons.upstream.flatMap(({ transitions }) => transitions),
      ]);
    }
    if (!live && executionFile && temporalTrace)
      await attachRecordedTaskTransfers(
        executionFile,
        viewer.uri.fsPath,
        evidence.scale,
        evidence.tick,
        trace,
        temporalTrace,
        dirtySources,
        operation,
      );
    if (temporalTrace && wordChanges.size) {
      for (const node of temporalTrace.nodes) {
        if (node.bit !== undefined || node.sampleOnly || node.executionOnly)
          continue;
        const changes = wordChanges.get(node.signal)?.get(node.tick);
        const sample = changes?.[(node.orderAtTick ?? 1) - 1];
        if (sample) node.valueChangeOrdinal = sample.ordinal;
        if (changes && changes.length > 1) node.recordedWordChanges = changes;
      }
      annotateRecordedValueChanges(temporalTrace, []);
    }
    if (temporalTrace) {
      const observations = new Map(
        evidence.observations.map((item) => [item.signal, item]),
      );
      const dumpedWords = new Set(words?.map(({ id }) => id));
      for (const gap of temporalTrace.gaps) {
        const historyCutoff =
          !live &&
          gap.historyCutoff !== undefined &&
          BigInt(gap.historyCutoff) >= BigInt(viewer.meta.start)
            ? gap.historyCutoff
            : undefined;
        if (
          gap.sampleOnly ||
          (historyCutoff === undefined &&
            gap.reason !== "nodeBudget" &&
            gap.reason !== "edgeBudget" &&
            gap.reason !== "staticBudget") ||
          (!bindings.has(gap.signal) && !dumpedWords.has(gap.signal))
        )
          continue;
        const observation = observations.get(gap.signal);
        if (observation?.status !== "observed") continue;
        const binding = bindings.get(gap.signal);
        const path =
          live && binding
            ? binding.scope +
              "." +
              WaveSignal.label({ ...binding, displayName: undefined })
            : observation.waveformSignal;
        const at = {
          tick: historyCutoff ?? gap.tick,
          ...(historyCutoff === undefined
            ? {}
            : { historyStart: "auto" as const }),
          ...(live ? { liveSessionId: live.id } : {}),
          ...(gap.orderAtTick !== undefined &&
          (!live || gap.use?.evidence?.waitResumeCause === "orderedCallbacks")
            ? { changeOrder: gap.orderAtTick }
            : {}),
        };
        if (
          gap.bit === undefined ||
          observation.projected ||
          (observation.width === 1 && !observation.range)
        ) {
          gap.continuation = { signal: path, ...at };
        } else if (
          observation.range &&
          gap.bit >= Math.min(...observation.range) &&
          gap.bit <= Math.max(...observation.range)
        ) {
          gap.continuation = {
            signal: declaredSignalName(path) + "[" + gap.bit + "]",
            ...at,
          };
        }
      }
    }
    const upstreamExecution = comparisons?.upstream
      .filter(({ transitions }) => transitions.length)
      .map(
        ({
          id,
          instance,
          signal,
          bit,
          recording,
          assignments,
          transitions,
        }) => {
          const ordinals = new Set(
            transitions.flatMap(
              ({ callbackOrdinals }) => callbackOrdinals ?? [],
            ),
          );
          const statementEvents = recording.events.filter(
            ({ kind }) => kind === "assignment-entered",
          );
          const writeEvents = reachedWriteEvents(
            recording.events,
            transitions,
            bit,
          );
          for (const { valueChangeOrdinal } of writeEvents)
            if (valueChangeOrdinal !== undefined)
              ordinals.add(valueChangeOrdinal);
          return {
            id,
            instance,
            signal,
            bit,
            coverage: recording.coverage,
            ...(recording.observationCoverage
              ? { observationCoverage: recording.observationCoverage }
              : {}),
            assignments,
            transitions,
            ...(ordinals.size
              ? {
                  callbackEvents: recording.events.filter(({ ordinal }) =>
                    ordinals.has(ordinal),
                  ),
                }
              : {}),
            ...(statementEvents.length ? { statementEvents } : {}),
            ...(writeEvents.length ? { writeEvents } : {}),
          };
        },
      );
    const runtimeInputs =
      verification && !mismatched && result.buildManifest
        ? await traceRuntimeInputs(
            result.buildManifest,
            trace,
            live?.runtimeInputs(),
          )
        : [];
    operation?.throwIfAborted();
    if (live && live !== getLive())
      throw Error("The live simulation session changed.");
    if (viewer.disposed || viewer.kdb !== design)
      throw Error("The waveform design changed during trace sampling.");
    const changeOrder = limits?.changeOrder;
    const selectedNode =
      changeOrder === undefined ? undefined : temporalTrace?.nodes[0];
    if (changeOrder !== undefined && !selectedNode)
      throw Error(
        "The selected signal change is unavailable at tick " +
          evidence.tick +
          ".",
      );
    const selectedTransition = selectedNode && {
      signal: selectedNode.signal,
      tick: selectedNode.tick,
      value: selectedNode.value,
      orderAtTick: selectedNode.orderAtTick ?? 1,
    };
    const { wholeRoot: _wholeRoot, ...observations } = waveformEvidence;
    const waveformSelections: Record<string, string> = {};
    for (const { signal, bit } of temporalTrace?.nodes ?? []) {
      const binding = waveformBindings.get(signal);
      if (!binding?.supported) continue;
      const name =
        bit !== undefined &&
        binding.bitOffset === undefined &&
        binding.width > 1
          ? declaredSignalName(binding.name) + "[" + bit + "]"
          : WaveSignal.label({ ...binding, displayName: undefined });
      waveformSelections[signal + ":" + (bit ?? "")] = [binding.scope, name]
        .filter(Boolean)
        .join(".");
    }
    return {
      context: {
        ...observations,
        schemaVersion: 1 as const,
        provider: live
          ? {
              kind: "live" as const,
              sampling: "endOfSlot" as const,
              liveSessionId: live.id,
            }
          : {
              kind: "waveform" as const,
              sampling: viewer.meta.supportsOrderedHistory
                ? ("orderedChanges" as const)
                : ("waveformChanges" as const),
            },
        mode: "observations" as const,
        sourceMatch: verification?.status ?? ("unverified" as const),
        sourceVerification: verification,
        ...(selectedTransition ? { selectedTransition } : {}),
        ...(runtimeInputs.length
          ? {
              runtimeInputs,
              runtimeInputSource: live
                ? ("liveLaunch" as const)
                : ("runManifest" as const),
            }
          : {}),
        ...(runtimeMismatches ? { runtimeMismatches } : {}),
        assignmentCandidates: mismatched
          ? undefined
          : traceAssignmentCandidates(trace, evidence),
        cursorWriters: mismatched
          ? undefined
          : traceCursorWriters(trace, evidence),
        temporalTrace,
        waveformBindings: waveformSelections,
        unmapped: trace.signals
          .filter(
            ({ id, enumValue, enumValueUnavailable }) =>
              !enumValue && !enumValueUnavailable && !bindings.has(id),
          )
          .map(({ id }) => id),
      },
      execution,
      replayMatch,
      executionAssignments,
      executionTransitions: comparisons?.root,
      cursorWrite,
      upstreamExecution,
    };
  }

  return { traceObservedContext };
}

export type AnalysisObservations<V extends AnalysisView> = ReturnType<
  typeof createAnalysisObservations<V>
>;
export type ObservedContext = Awaited<
  ReturnType<AnalysisObservations<AnalysisView>["traceObservedContext"]>
>;
