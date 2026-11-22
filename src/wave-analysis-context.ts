// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { isFsdb } from "./backend-selection";
import { KdbSession } from "./kdb";
import { declaredSignalName } from "./rtl-trace";
import { readTraceObservations } from "./rtl-trace-observations";
import { type TemporalLimits } from "./rtl-trace-candidates";
import { LiveTraceSession } from "./rtl-live-trace";
import {
  verifyLiveTraceBuild,
  verifyTraceBuild,
} from "./rtl-build-verification";

import type {
  AnalysisView,
  GetLiveTrace,
  TraceHost,
} from "./wave-analysis-types";
import type { WaveTraceResult } from "./wave-analysis-projects";
import type { AnalysisBindings, TraceBindings } from "./wave-analysis-bindings";
import type { AnalysisObservations } from "./wave-analysis-observations";

export function createAnalysisContext<V extends AnalysisView>(
  host: TraceHost,
  getLive: GetLiveTrace,
  bindings: Pick<
    AnalysisBindings<V>,
    "bindTraceObservations" | "traceSignedness"
  >,
  observations: AnalysisObservations<V>,
) {
  const { bindTraceObservations, traceSignedness } = bindings;
  const { traceObservedContext } = observations;

  async function traceWaveContext(
    viewer: V,
    result: WaveTraceResult,
    tick: string,
    historyStart?: string,
    verification?: Awaited<ReturnType<typeof verifyTraceBuild>>,
    bindingResult?: TraceBindings,
    operation?: AbortSignal,
    executionFile?: string,
    expandReachable?: boolean,
    limits?: TemporalLimits,
  ) {
    const { trace } = result;
    bindingResult ??= await bindTraceObservations(viewer, result);
    const observations = (anchor?: string) =>
      readTraceObservations(
        viewer.backend,
        viewer.meta,
        bindingResult.bindings,
        tick,
        historyStart,
        trace.root,
        traceSignedness(trace),
        operation,
        anchor,
      );
    const context = (
      evidence: Awaited<ReturnType<typeof readTraceObservations>>,
    ) =>
      traceObservedContext(
        viewer,
        result,
        evidence,
        bindingResult,
        verification,
        operation,
        executionFile,
        undefined,
        expandReachable,
        undefined,
        limits,
      );
    const evidence = await observations();
    const replayAfterHistory =
      historyStart === "auto" &&
      executionFile &&
      result.design instanceof KdbSession &&
      isFsdb(viewer.uri.fsPath) &&
      verification?.status !== "mismatched" &&
      BigInt(evidence.historyEnd) < BigInt(tick);
    if (replayAfterHistory && limits?.changeOrder !== undefined)
      return context(await observations(tick));
    const original = await context(evidence);
    if (replayAfterHistory) {
      const recording = original.execution;
      if (recording?.observationCoverage?.status === "complete") {
        const changes = recording.events.filter(
          ({ kind, tick }) =>
            kind === "signal-value-changed" &&
            BigInt(tick) > BigInt(evidence.historyEnd),
        );
        const latest = changes.findLast(
          ({ tick }, index) => changes[index - 1]?.tick === tick,
        )?.tick;
        if (latest) {
          const centered = await context(await observations(latest));
          if (
            centered.context.temporalTrace?.nodes.some(
              (node) =>
                node.signal === trace.root && node.restoredFromCallbacks,
            )
          )
            return centered;
        }
      }
    }
    const anchor = original.cursorWrite?.tick;
    if (
      historyStart !== "auto" ||
      !anchor ||
      BigInt(anchor) <= BigInt(evidence.historyEnd)
    )
      return original;
    const centered = await context(await observations(anchor));
    return centered.context.temporalTrace?.nodes[0]?.sameValueWrite
      ? centered
      : original;
  }

  function verifyWaveTrace(viewer: V, result: WaveTraceResult) {
    if (!result.buildManifest) return undefined;
    return verifyTraceBuild(
      result.buildManifest,
      viewer.uri.fsPath,
      result.trace.compilation,
      new Map(
        host.workspace.textDocuments
          .filter(
            (document) => document.uri.scheme === "file" && document.isDirty,
          )
          .map((document) => [document.uri.fsPath, document.getText()]),
      ),
      result.trace.simulationProject?.limitations,
      result.design.verilatorArtifacts,
    );
  }

  async function traceLiveContext(
    viewer: V,
    result: WaveTraceResult,
    live: LiveTraceSession,
    operation: AbortSignal,
    historyStart?: string,
    executionFile?: string,
    expandReachable?: boolean,
    limits?: TemporalLimits,
    tick?: string,
  ) {
    const bindingResult = await bindTraceObservations(viewer, result);
    const verification = await verifyWaveTrace(viewer, result);
    operation.throwIfAborted();
    if (live !== getLive()) throw Error("The live simulation session changed.");
    if (viewer.disposed || viewer.kdb !== result.design)
      throw Error("The waveform design changed during live trace sampling.");
    const { trace, instance } = result;
    const paths = new Map(
      trace.signals.map((node) => [
        node.id,
        (node.instance ?? instance) + "." + node.name,
      ]),
    );
    const sampled = live.observations(
      paths,
      historyStart,
      traceSignedness(trace),
      bindingResult.bindings,
      tick,
      trace.root,
    );
    const buildVerification = verifyLiveTraceBuild(
      result.buildManifest,
      verification,
      live.status().harnessSha256,
      sampled.scale,
      viewer.meta.scale,
      result.design.verilatorArtifacts,
      trace.frontier.some(({ reason }) => reason === "mismatchedDesign"),
    );
    const runtimeMismatches = result.buildManifest?.runtime
      ? await live.runtimeDifferences(result.buildManifest.runtime)
      : undefined;
    operation.throwIfAborted();
    if (live !== getLive()) throw Error("The live simulation session changed.");
    const { events, coverage: executionCoverage } = live.executionWindow(
      instance,
      declaredSignalName(result.signal.name),
      historyStart ?? sampled.historyStart,
      sampled.tick,
    );
    const evidence = await traceObservedContext(
      viewer,
      result,
      sampled,
      bindingResult,
      buildVerification,
      operation,
      executionFile,
      live,
      expandReachable,
      runtimeMismatches,
      limits,
    );
    return {
      ...evidence,
      context: { ...evidence.context, mode: "live" as const },
      execution: events,
      executionCoverage,
      buildVerification,
    };
  }

  return { traceWaveContext, verifyWaveTrace, traceLiveContext };
}

export type AnalysisContext<V extends AnalysisView> = ReturnType<
  typeof createAnalysisContext<V>
>;
export type LiveContext = Awaited<
  ReturnType<AnalysisContext<AnalysisView>["traceLiveContext"]>
>;
