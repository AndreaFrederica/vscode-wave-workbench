// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type * as vscode from "vscode";
import { isDeepStrictEqual } from "node:util";

import type { Viewer } from "./viewer";
import type { LiveTraceSession } from "./rtl-live-trace";
import type { WaveAnalysis } from "./wave-extension-types";
import type { createWaveFiles } from "./wave-files";
import { simulationFilelistsCurrent } from "./vide-project-config";
import {
  automaticTraceContinuationLimit,
  continuationMermaidPages,
  continuationReport,
  followTemporalFrontier,
  mergeTemporalContinuationGraph,
  temporalTraceReferences,
  temporalWaveformSignals,
  TraceContextChanged,
  type ContinuationTrace,
  type ContinuationWalk,
  type TemporalContinuation,
  type TraceDirection,
  type VideTrace,
} from "./rtl-trace";
import {
  mergeStaticContinuationGraph,
  mergedStaticMermaid,
  staticContinuationMermaid,
  staticContinuationReport,
  type StaticWalk,
} from "./rtl-static-continuations";

type VSCodeApi = typeof vscode;
type ContinuationCheckpoint = NonNullable<
  Awaited<ReturnType<WaveAnalysis["createContinuationGuard"]>>["checkpoint"]
>;
export const continuationOptions = {
  maxSignals: 512,
  maxAssignments: 1024,
  includeCompilation: true,
};

export type TraceContinuationState = {
  root: TemporalContinuation;
  initial: ContinuationTrace;
  walk: ContinuationWalk;
  assertCurrent: () => Promise<void>;
  checkpoint?: ContinuationCheckpoint;
  query: (
    point: TemporalContinuation,
    abort: AbortSignal,
  ) => Promise<ContinuationTrace>;
};
export type StaticContinuationState = Awaited<
  ReturnType<WaveAnalysis["createStaticWalk"]>
> & {
  kind: "static";
  root: string;
  initial: VideTrace;
  direction: TraceDirection;
  walk: StaticWalk;
};
export type ExplorerContinuation = (
  | (TraceContinuationState & {
      kind: "temporal";
      combined: ReturnType<typeof mergeTemporalContinuationGraph>;
    })
  | (StaticContinuationState & {
      combined: ReturnType<typeof mergeStaticContinuationGraph>;
    })
) & {
  report: string;
};
export type SchematicEvidence = Pick<
  Awaited<ReturnType<WaveAnalysis["traceWaveContext"]>>["context"],
  | "observations"
  | "temporalTrace"
  | "runtimeInputs"
  | "runtimeInputSource"
  | "tick"
  | "scale"
  | "provider"
  | "waveformBindings"
>;
export type StoredTrace = {
  trace: VideTrace;
  direction: TraceDirection;
  evidence?: SchematicEvidence;
  combined?: ReturnType<typeof mergeTemporalContinuationGraph>;
  combinedStatic?: ReturnType<typeof mergeStaticContinuationGraph>;
  waveform?: string;
  fullname?: string;
  executionFile?: string;
  continuation?: {
    version: 1;
    checkpoint: ContinuationCheckpoint;
    report: string;
  } & (
    | { kind: "static"; root: string; walk: StaticWalk }
    | { kind: "temporal"; root: TemporalContinuation; walk: ContinuationWalk }
  );
};

type TraceWave = {
  viewer: Viewer;
  fullname: string;
  backend: Viewer["backend"];
  result: Awaited<ReturnType<WaveAnalysis["traceWaveSignal"]>>;
};
export type TraceSnapshot = StoredTrace & { wave?: TraceWave };
export function temporalQuery(
  vscode: VSCodeApi,
  {
    traceWaveSignal,
    focusWaveTrace,
    traceLiveContext,
    traceWaveContext,
    verifyWaveTrace,
  }: WaveAnalysis,
  viewer: Viewer,
  assertActive: () => void,
  live?: LiveTraceSession,
  executionFile?: string,
): TraceContinuationState["query"] {
  return async (point, abort) => {
    assertActive();
    const cancellation = new vscode.CancellationTokenSource();
    const cancel = () => cancellation.cancel();
    abort.addEventListener("abort", cancel, { once: true });
    try {
      abort.throwIfAborted();
      let next = await traceWaveSignal(
        viewer,
        "drivers",
        point.signal,
        continuationOptions,
        cancellation.token,
      );
      abort.throwIfAborted();
      if (!live)
        next = await focusWaveTrace(viewer, next, point.signal, "drivers");
      const continued = live
        ? await traceLiveContext(
            viewer,
            next,
            live,
            abort,
            undefined,
            executionFile,
            undefined,
            undefined,
            point.tick,
          )
        : await traceWaveContext(
            viewer,
            next,
            point.tick,
            "auto",
            await verifyWaveTrace(viewer, next),
            undefined,
            abort,
            executionFile,
            undefined,
            { changeOrder: point.changeOrder },
          );
      abort.throwIfAborted();
      return {
        context: continued.context,
        waveformSignals: temporalWaveformSignals(continued.context),
        ...temporalTraceReferences(next.trace, continued.context.temporalTrace),
      };
    } finally {
      abort.removeEventListener("abort", cancel);
      cancellation.dispose();
    }
  };
}

export async function restoreTraceBatch(
  vscode: VSCodeApi,
  analyses: WaveAnalysis,
  restoreWaveformViewer: ReturnType<
    typeof createWaveFiles
  >["restoreWaveformViewer"],
  snapshot: TraceSnapshot,
  saved: NonNullable<StoredTrace["continuation"]>,
  token: vscode.CancellationToken,
  signal: AbortSignal,
  assertActive: () => void,
): Promise<{ state: ExplorerContinuation; wave: TraceWave }> {
  const {
    traceWaveSignal,
    focusWaveTrace,
    bindTraceObservations,
    bindStaticFrontier,
    createContinuationGuard,
    createStaticWalk,
  } = analyses;
  const changed = () =>
    new TraceContextChanged(
      "The saved trace's waveform, RTL or simulation context changed. Start a new trace.",
    );
  if (!(await simulationFilelistsCurrent(saved.checkpoint.inputs)))
    throw changed();
  assertActive();
  signal.throwIfAborted();
  const viewer = await restoreWaveformViewer(snapshot.waveform);
  assertActive();
  signal.throwIfAborted();
  if (!viewer || viewer.disposed || !viewer.meta)
    throw Error("Reopen the waveform to continue this trace.");
  const fullname = saved.kind === "static" ? saved.root : saved.root.signal;
  let result = await traceWaveSignal(
    viewer,
    snapshot.direction,
    fullname,
    continuationOptions,
    token,
  );
  result = await focusWaveTrace(viewer, result, fullname, snapshot.direction);
  const bindings =
    saved.kind === "temporal"
      ? await bindTraceObservations(viewer, result)
      : undefined;
  result = {
    ...result,
    trace: await bindStaticFrontier(viewer, result, bindings?.bindings),
  };
  const comparable = ({ revision: _revision, ...trace }: VideTrace) =>
    JSON.parse(JSON.stringify(trace));
  if (!isDeepStrictEqual(comparable(result.trace), comparable(snapshot.trace)))
    throw changed();
  const verify = async (
    state: Awaited<ReturnType<typeof createContinuationGuard>>,
  ) => {
    if (state.checkpoint?.identity !== saved.checkpoint.identity)
      throw changed();
    await state.assertCurrent();
    assertActive();
    signal.throwIfAborted();
  };
  let restored: ExplorerContinuation;
  if (saved.kind === "static" && snapshot.combinedStatic) {
    const state = await createStaticWalk(
      viewer,
      fullname,
      result,
      snapshot.direction,
      continuationOptions,
      undefined,
      assertActive,
      true,
    );
    await verify(state);
    restored = {
      ...state,
      report: saved.report,
      kind: "static",
      root: saved.root,
      initial: snapshot.trace,
      direction: snapshot.direction,
      walk: saved.walk,
      combined: snapshot.combinedStatic,
    };
  } else if (
    saved.kind === "temporal" &&
    snapshot.evidence &&
    snapshot.combined
  ) {
    const evidence = snapshot.evidence;
    const state = await createContinuationGuard(
      viewer,
      result,
      undefined,
      snapshot.executionFile,
      true,
    );
    await verify(state);
    restored = {
      ...state,
      report: saved.report,
      kind: "temporal",
      root: saved.root,
      initial: {
        context: evidence,
        waveformSignals: temporalWaveformSignals(evidence),
        ...temporalTraceReferences(snapshot.trace, evidence.temporalTrace),
      },
      walk: saved.walk,
      query: temporalQuery(
        vscode,
        analyses,
        viewer,
        assertActive,
        undefined,
        snapshot.executionFile,
      ),
      combined: snapshot.combined,
    };
  } else {
    throw changed();
  }
  return {
    state: restored,
    wave: { viewer, backend: viewer.backend, result, fullname },
  };
}

export async function continueTraceBatch(
  state: ExplorerContinuation,
  signal: AbortSignal,
  deadline: AbortSignal,
  request?: TemporalContinuation | string,
) {
  let next: ExplorerContinuation;
  let appendix: string;
  if (state.kind === "static") {
    const selected = typeof request === "string" ? [request] : undefined;
    const walk = await state.run(
      selected ? 1 : automaticTraceContinuationLimit,
      signal,
      deadline,
      state.walk.segments,
      undefined,
      selected,
    );
    const combined = mergeStaticContinuationGraph(state.initial, walk);
    next = { ...state, walk, combined };
    appendix = staticContinuationReport(
      state.direction,
      walk,
      staticContinuationMermaid(state.root, walk),
      mergedStaticMermaid(combined),
    );
  } else {
    const selected =
      request && typeof request !== "string" ? [request] : undefined;
    const walk = await followTemporalFrontier(
      state.root,
      state.initial.context.temporalTrace,
      selected ? 1 : automaticTraceContinuationLimit,
      signal,
      deadline,
      state.query,
      {
        assertCurrent: state.assertCurrent,
        previous: state.walk.segments,
        defaultHistoryStart: state.root.liveSessionId ? undefined : "auto",
        selected,
      },
    );
    const combined = mergeTemporalContinuationGraph(state.initial, walk);
    next = { ...state, walk, combined };
    appendix = continuationReport(
      walk,
      continuationMermaidPages(state.root, walk),
      combined,
    );
  }
  return { next, appendix };
}
