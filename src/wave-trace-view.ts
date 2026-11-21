// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { Viewer } from "./viewer";
import type { Signal, WaveState } from "./shared/protocol";
import type * as vscode from "vscode";
import * as path from "node:path";

import { type TraceProjectSelection } from "./project";
import { findSignal } from "./signal-lookup";
import * as WaveSignal from "./shared/signals";
import { mapPrefix } from "./kdb";
import {
  appendContinuationReport,
  automaticTraceContinuationLimit,
  declaredSignalName,
  continuationMermaidPages,
  continuationReport,
  mergeTemporalContinuationGraph,
  followTemporalFrontier,
  TraceContextChanged,
  observationReport,
  selectionText,
  traceSignalScope,
  traceContinuationTimeout,
  temporalTraceReferences,
  temporalWaveformSignals,
  traceReport,
  type TemporalContinuation,
  type TraceDirection,
  type VideTrace,
} from "./rtl-trace";
import {
  mergeStaticContinuationGraph,
  mergedStaticMermaid,
  staticContinuationMermaid,
  staticContinuationReport,
} from "./rtl-static-continuations";

import {
  executionMermaidPages,
  executionReport,
  readExecutionEvidence,
} from "./rtl-execution";
import { mermaidMarkdown } from "./trace-mermaid";
import { LiveTraceSession } from "./rtl-live-trace";
import { createTraceExplorer } from "./trace-explorer";

import type {
  WaveAnalysis,
  GetViewer,
  ReportError,
} from "./wave-extension-types";
import type { createWaveFiles } from "./wave-files";
import {
  continuationOptions,
  continueTraceBatch,
  restoreTraceBatch,
  temporalQuery,
  type ExplorerContinuation,
  type SchematicEvidence,
  type StaticContinuationState,
  type StoredTrace,
  type TraceContinuationState,
  type TraceSnapshot,
} from "./wave-trace-continuation";

type VSCodeApi = typeof vscode;
export function createWaveTraceView(
  vscode: VSCodeApi,
  {
    context,
    getCurrent,
    getLive,
    analyses,
    output,
    report,
    restoreWaveformViewer,
    traceProjectSelection,
  }: {
    context: vscode.ExtensionContext;
    getCurrent: GetViewer;
    getLive: () => LiveTraceSession | undefined;
    analyses: WaveAnalysis;
    output: vscode.OutputChannel;
    report: ReportError;
    restoreWaveformViewer: ReturnType<
      typeof createWaveFiles
    >["restoreWaveformViewer"];
    traceProjectSelection: (
      viewer: Viewer,
    ) => TraceProjectSelection | null | undefined;
  },
) {
  const {
    traceRtlPosition,
    openSimulationTrace,
    traceWaveSignal,
    createContinuationGuard,
    createStaticWalk,
    bindTraceObservations,
    bindStaticFrontier,
    focusWaveTrace,
    traceWaveContext,
    verifyWaveTrace,
    traceExecutionComparisonReport,
    traceLiveContext,
    liveTraceReport,
    dumpScope,
  } = analyses;
  let traceViewer: Viewer | undefined;
  let liveTraceRecording: string | undefined;
  let traceSelection = 0;
  let traceContinuation: ExplorerContinuation | undefined;
  let runningTraceBatch: AbortController | undefined;
  let traceContext:
    | {
        viewer: Viewer;
        result: Awaited<ReturnType<typeof traceWaveSignal>>;
        bindings: Awaited<ReturnType<typeof bindTraceObservations>>;
        backend: Viewer["backend"];
        tick: string;
        executionFile?: string;
        refresh?: AbortController;
      }
    | undefined;
  const traceStorageKey = "rtlTrace.lastResult.v1";
  let traceSnapshot: TraceSnapshot | undefined;
  let traceCursorTimer: ReturnType<typeof setTimeout> | undefined;

  async function saveTraceSnapshot() {
    if (!traceSnapshot) return;
    const {
      wave: _viewer,
      continuation: _checkpoint,
      ...snapshot
    } = traceSnapshot;
    const saved: StoredTrace = snapshot;
    const state = traceContinuation;
    if (state?.checkpoint && state.walk.remaining.length) {
      const { kind, root, walk } = state;
      const continuation = {
        version: 1 as const,
        checkpoint: state.checkpoint,
        report: state.report,
      };
      saved.continuation =
        kind === "static"
          ? { ...continuation, kind, root, walk }
          : { ...continuation, kind, root, walk };
    }
    traceSnapshot.continuation = saved.continuation;
    try {
      await context.workspaceState.update(traceStorageKey, saved);
    } catch (error) {
      output.appendLine("Cannot save RTL Trace: " + String(error));
    }
  }

  function clearTraceContinuation(provider?: "live") {
    if (
      !provider ||
      (traceContinuation?.kind === "temporal" &&
        traceContinuation.root.liveSessionId)
    ) {
      runningTraceBatch?.abort();
      traceContinuation = undefined;
    }
    if (
      traceSnapshot &&
      (!provider || traceSnapshot.combined?.provider.kind === provider)
    )
      traceSnapshot = {
        ...traceSnapshot,
        combined: undefined,
        combinedStatic: undefined,
        continuation: undefined,
      };
    traceExplorer.clearCombined(provider);
  }

  function resetTraceContext() {
    clearTimeout(traceCursorTimer);
    traceContext?.refresh?.abort();
    traceContext = undefined;
    traceSnapshot = undefined;
    clearTraceContinuation();
    traceExplorer.clear();
    return ++traceSelection;
  }

  function traceSubject(trace: VideTrace) {
    const root = trace.signals.find(({ id }) => id === trace.root);
    return (
      root &&
      [
        traceSignalScope(root),
        root.name +
          selectionText(trace.bitSelection?.range, trace.bitSelection?.bit),
      ]
        .filter(Boolean)
        .join(".")
    );
  }

  function traceModeLabel(
    direction: TraceDirection,
    tick?: string,
    scale?: string,
    live = false,
  ) {
    if (tick === undefined)
      return direction === "drivers"
        ? "静态 · 驱动（上游）"
        : "静态 · 负载（下游）";
    const source = live ? "在线时间追踪" : "A 游标 · 时间追踪";
    return `${source} @ ${tick} tick${scale ? `（${scale}/tick）` : ""}`;
  }

  function showWaveEvidence(
    trace: VideTrace,
    direction: TraceDirection,
    evidence?: SchematicEvidence,
    {
      combined,
      combinedStatic,
      wave = traceSnapshot?.wave,
      executionFile = traceSnapshot?.executionFile,
      restored,
    }: Pick<StoredTrace, "combined" | "combinedStatic" | "executionFile"> & {
      wave?: NonNullable<typeof traceSnapshot>["wave"];
      restored?: StoredTrace;
    } = {},
  ) {
    traceSnapshot = {
      trace,
      direction,
      evidence,
      combined,
      combinedStatic,
      waveform:
        wave?.viewer.uri.fsPath ??
        restored?.waveform ??
        traceSnapshot?.waveform,
      fullname: wave?.fullname ?? restored?.fullname ?? traceSnapshot?.fullname,
      executionFile: restored?.executionFile ?? executionFile,
      continuation: restored?.continuation,
      wave,
    };
    const saved = restored ? undefined : saveTraceSnapshot();
    const continuation =
      traceContinuation &&
      (combined ?? combinedStatic) === traceContinuation.combined
        ? traceContinuation
        : restored?.continuation?.version === 1
          ? restored.continuation
          : undefined;
    traceExplorer.show(
      trace,
      direction,
      new Map(
        evidence?.observations.map(({ signal, value, status }) => [
          signal,
          value ?? status,
        ]),
      ),
      evidence?.temporalTrace,
      evidence?.runtimeInputs,
      combined,
      combinedStatic,
      continuation?.kind === "static"
        ? continuation.walk.remaining
        : (continuation?.walk.remaining.length ?? 0),
    );
    traceExplorer.setMessage(
      [
        traceModeLabel(
          direction,
          evidence?.tick,
          evidence?.scale,
          evidence?.provider.kind === "live",
        ),
        traceSnapshot.fullname ?? traceSubject(trace),
        evidence?.provider.liveSessionId &&
          "在线仿真会话 " + evidence.provider.liveSessionId,
        traceSnapshot.waveform
          ? "波形 " + path.basename(traceSnapshot.waveform)
          : "RTL 源码",
        restored && "已恢复的追踪结果",
      ]
        .filter(Boolean)
        .join("\n"),
    );
    return saved;
  }

  async function resumeTraceBatch(request?: TemporalContinuation | string) {
    let state = traceContinuation;
    const snapshot = traceSnapshot;
    const saved = snapshot?.continuation;
    if (
      runningTraceBatch ||
      !(state?.walk.remaining.length || saved?.walk.remaining.length)
    )
      return;
    const selection = traceSelection;
    const assertActive = () => {
      if (
        selection !== traceSelection ||
        (state ? traceContinuation !== state : snapshot !== traceSnapshot)
      )
        throw new TraceContextChanged(
          "The selected trace changed during continuation.",
        );
    };
    const running = new AbortController();
    runningTraceBatch = running;
    const root = state?.root ?? saved?.root;
    const rootSignal = typeof root === "string" ? root : root?.signal;
    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Continuing trace of " + rootSignal,
          cancellable: true,
        },
        async (_progress, token) => {
          const cancel = token.onCancellationRequested(() => running.abort());
          try {
            if (token.isCancellationRequested) running.abort();
            running.signal.throwIfAborted();
            assertActive();
            if (!state && snapshot && saved) {
              const restored = await restoreTraceBatch(
                vscode,
                analyses,
                restoreWaveformViewer,
                snapshot,
                saved,
                token,
                running.signal,
                assertActive,
              );
              assertActive();
              traceViewer = restored.wave.viewer;
              snapshot.wave = restored.wave;
              traceContinuation = state = restored.state;
            }
            if (!state) return;
            await state.assertCurrent();
            const deadline = AbortSignal.timeout(traceContinuationTimeout);
            const { next, appendix } = await continueTraceBatch(
              state,
              running.signal,
              deadline,
              request,
            );
            await state.assertCurrent();
            if (traceContinuation !== state) return;
            const document = await vscode.workspace.openTextDocument({
              language: "markdown",
              content: appendContinuationReport(state.report, appendix),
            });
            if (traceContinuation !== state) return;
            await state.assertCurrent();
            if (traceContinuation !== state) return;
            traceContinuation = next.walk.remaining.length ? next : undefined;
            if (next.kind === "static") {
              await showWaveEvidence(next.initial, next.direction, undefined, {
                combinedStatic: next.combined,
              });
            } else {
              let saved: Promise<void> | undefined;
              if (traceSnapshot) {
                traceSnapshot = { ...traceSnapshot, combined: next.combined };
                saved = saveTraceSnapshot();
              }
              traceExplorer.updateCombined(
                next.combined,
                next.walk.remaining.length,
              );
              await saved;
            }
            if (selection !== traceSelection) return;
            await vscode.window.showTextDocument(document);
          } finally {
            cancel.dispose();
          }
        },
      );
    } catch (error) {
      if (
        !running.signal.aborted &&
        selection === traceSelection &&
        traceContinuation === state
      ) {
        if (error instanceof TraceContextChanged) {
          traceContinuation = undefined;
          if (traceSnapshot) {
            const { trace, direction, evidence, combined, combinedStatic } =
              traceSnapshot;
            await showWaveEvidence(trace, direction, evidence, {
              combined,
              combinedStatic,
            });
          }
        }
        report(error);
      }
    } finally {
      if (runningTraceBatch === running) runningTraceBatch = undefined;
    }
  }

  function refreshTraceCursor(viewer: Viewer, tick: number) {
    const session = traceContext;
    if (!session || session.viewer !== viewer || session.tick === String(tick))
      return;
    if (
      viewer.kdb !== session.result.design ||
      viewer.backend !== session.backend
    ) {
      resetTraceContext();
      return;
    }
    const requested = String(tick);
    clearTraceContinuation();
    session.tick = requested;
    session.refresh?.abort();
    clearTimeout(traceCursorTimer);
    traceCursorTimer = setTimeout(async () => {
      const current = () =>
        traceContext === session &&
        session.tick === requested &&
        !viewer.disposed &&
        viewer.kdb === session.result.design &&
        viewer.backend === session.backend;
      if (!current()) return;
      const refresh = new AbortController();
      session.refresh = refresh;
      try {
        const evidence = await traceWaveContext(
          viewer,
          session.result,
          requested,
          "auto",
          await verifyWaveTrace(viewer, session.result),
          session.bindings,
          refresh.signal,
          session.executionFile,
        );
        if (current())
          await showWaveEvidence(
            session.result.trace,
            "drivers",
            evidence.context,
          );
      } catch (error) {
        if (current() && !refresh.signal.aborted)
          output.appendLine(String(error));
      } finally {
        if (session.refresh === refresh) session.refresh = undefined;
      }
    }, 75);
  }
  const traceExplorer = createTraceExplorer(
    vscode,
    context,
    async (source) => {
      const document = await vscode.workspace.openTextDocument(
        vscode.Uri.parse(source.uri),
      );
      const editor = await vscode.window.showTextDocument(document);
      const position = new vscode.Position(
        source.range.start.line,
        source.range.start.character,
      );
      editor.selection = new vscode.Selection(position, position);
      editor.revealRange(new vscode.Range(position, position));
    },
    async (subject, bit, waveformSignal) => {
      const selection = traceSelection;
      const viewer =
        traceViewer ?? (await restoreWaveformViewer(traceSnapshot?.waveform));
      const scope = subject && traceSignalScope(subject);
      if (!viewer || viewer.disposed || (!waveformSignal && !scope)) return;
      try {
        const name =
          waveformSignal ??
          dumpScope(viewer, scope) +
            "." +
            (bit === undefined
              ? subject.name
              : declaredSignalName(subject.name) +
                selectionText(undefined, bit));
        const backend = viewer.backend;
        const signal = await findSignal(backend, name, ".");
        const currentTrace = () =>
          selection === traceSelection &&
          (traceViewer === viewer ||
            traceSnapshot?.waveform === viewer.uri.fsPath) &&
          !viewer.disposed;
        if (!currentTrace() || backend !== viewer.backend || !signal.supported)
          return;
        if (!viewer.panel.visible)
          viewer.panel.reveal(viewer.panel.viewColumn, true);
        await viewer.ui("batchAdd", { signals: [signal] });
      } catch (error) {
        report(error);
      }
    },
    async ({ instance, name }) => {
      await vscode.env.clipboard.writeText(
        instance ? instance + "." + name : name,
      );
    },
    async (subject, direction, point, packedSelection, continuationSignal) => {
      try {
        const { instance, name, declaration } = subject;
        const selectionAtStart = traceSelection;
        const snapshot = traceSnapshot;
        const viewer =
          traceViewer ?? (await restoreWaveformViewer(snapshot?.waveform));
        if (selectionAtStart !== traceSelection) return;
        if (continuationSignal && viewer && !viewer.disposed) {
          await showSignalTrace(viewer, continuationSignal, direction);
          return;
        }
        if (point) {
          if (!viewer || viewer.disposed || (!instance && !point.continuation))
            return;
          const selection = point.bit === undefined ? "" : `[${point.bit}]`;
          const fullname =
            point.continuation?.signal ??
            dumpScope(viewer, traceSignalScope(subject)) +
              "." +
              name +
              selection;
          const liveSessionId = point.continuation?.liveSessionId;
          if (liveSessionId && getLive()?.id !== liveSessionId)
            throw Error("The live simulation session changed.");
          await showSignalTrace(
            viewer,
            fullname,
            liveSessionId ? "live" : "context",
            point.continuation?.tick ?? point.tick,
            liveSessionId ? liveTraceRecording : snapshot?.executionFile,
            point.continuation?.changeOrder,
          );
          return;
        }
        if (viewer && !viewer.disposed && instance) {
          const fullname =
            dumpScope(viewer, traceSignalScope(subject)) +
            "." +
            (packedSelection ? declaredSignalName(name) : name);
          const dumped = await findSignal(viewer.backend, fullname, ".").catch(
            () => undefined,
          );
          if (dumped) {
            await showSignalTrace(
              viewer,
              fullname + (packedSelection ?? ""),
              direction,
            );
            return;
          }
        }
        if (!declaration)
          throw Error("This signal has no RTL declaration location.");
        const request = resetTraceContext();
        const position = declaration.range.start;
        const uri = vscode.Uri.parse(declaration.uri);
        const selection =
          viewer && !viewer.disposed && traceProjectSelection(viewer);
        const project = selection
          ? await openSimulationTrace(selection, viewer)
          : undefined;
        let trace: VideTrace;
        try {
          const source = await vscode.workspace.openTextDocument(uri);
          if (project && source.isDirty)
            throw Error(
              "Save the RTL declaration before tracing it against a simulation filelist.",
            );
          trace = await traceRtlPosition(
            direction,
            uri,
            new vscode.Position(position.line, position.character),
            project && { includeCompilation: true },
            undefined,
            project?.session,
          );
          if (project) trace.simulationProject = project.projectInfo;
        } finally {
          project?.session.dispose();
        }
        if (request !== traceSelection) return;
        traceViewer = undefined;
        await showWaveEvidence(trace, direction);
        if (request !== traceSelection) return;
        const document = await vscode.workspace.openTextDocument({
          language: "markdown",
          content: traceReport(trace, direction, name),
        });
        await vscode.window.showTextDocument(document);
      } catch (error) {
        report(error);
      }
    },
    async (tick) => {
      try {
        const viewer =
          traceViewer ?? (await restoreWaveformViewer(traceSnapshot?.waveform));
        const time = Number(tick);
        if (!viewer || viewer.disposed) return;
        if (!Number.isSafeInteger(time))
          throw Error(
            "This tick exceeds the waveform viewer's time precision.",
          );
        viewer.panel.reveal(viewer.panel.viewColumn, true);
        await viewer.ui("cursor", { time, reveal: true });
      } catch (error) {
        report(error);
      }
    },
    resumeTraceBatch,
  );

  const restoredTrace =
    context.workspaceState.get<StoredTrace>(traceStorageKey);
  if (restoredTrace?.trace?.schemaVersion === 1) {
    const { trace, direction, evidence, combined, combinedStatic } =
      restoredTrace;
    try {
      showWaveEvidence(trace, direction, evidence, {
        combined,
        combinedStatic,
        restored: restoredTrace,
      });
    } catch (error) {
      output.appendLine("Cannot restore RTL Trace: " + String(error));
    }
  }

  async function showExecutionEvidence(
    evidence: Awaited<ReturnType<typeof readExecutionEvidence>>,
    viewer?: Viewer,
    fullname?: string,
  ) {
    resetTraceContext();
    traceViewer = viewer;
    traceExplorer.showReplay(evidence, !!viewer);
    traceExplorer.setMessage(
      [
        `执行记录回放 · ${evidence.start}–${evidence.end} tick（${evidence.scale}/tick）`,
        fullname,
        viewer ? "波形 " + path.basename(viewer.uri.fsPath) : undefined,
      ]
        .filter(Boolean)
        .join("\n"),
    );
    const content =
      executionReport(evidence) +
      "\n" +
      mermaidMarkdown(executionMermaidPages(evidence)) +
      "\n";
    await vscode.window.showTextDocument(
      await vscode.workspace.openTextDocument({
        language: "markdown",
        content,
      }),
    );
  }

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "waveWorkbench.openExecutionRecording",
      async (
        selected?: vscode.Uri,
        recordedSignal?: string,
        recordedTick?: string,
      ) => {
        try {
          const filename =
            selected ??
            (
              await vscode.window.showOpenDialog({
                title: "Open execution recording",
                filters: { "Execution recording": ["jsonl"] },
              })
            )?.[0];
          if (!filename) return;
          const signal =
            recordedSignal ??
            (await vscode.window.showInputBox({
              prompt: "Full recorded signal path",
              placeHolder: "TOP.testbench.dut.result",
              validateInput: (value) =>
                /^.+\.[^.]+$/.test(value.trim())
                  ? undefined
                  : "Enter the instance and signal.",
            }));
          if (!signal?.trim()) return;
          const tick =
            recordedTick ??
            (await vscode.window.showInputBox({
              prompt: "Replay through this tick",
              validateInput: (value) =>
                /^(?:0|[1-9]\d{0,19})$/.test(value.trim())
                  ? undefined
                  : "Enter an integer tick.",
            }));
          if (!tick?.trim()) return;
          const fullname = signal.trim();
          const separator = fullname.lastIndexOf(".");
          if (separator <= 0 || separator === fullname.length - 1)
            throw Error("Enter the recorded instance and signal.");
          await showExecutionEvidence(
            await readExecutionEvidence(
              filename.fsPath,
              undefined,
              undefined,
              fullname.slice(0, separator),
              fullname.slice(separator + 1),
              tick.trim(),
              tick.trim(),
            ),
            undefined,
            fullname,
          );
        } catch (error) {
          report(error);
        }
      },
    ),
  );

  async function showSignalTrace(
    viewer: Viewer,
    fullname: string,
    mode: TraceDirection | "context" | "recordedContext" | "execution" | "live",
    tick?: string,
    executionFile?: string,
    changeOrder?: number,
    followContinuations = false,
    openReport = true,
  ) {
    if (
      (mode === "execution" || mode === "recordedContext") &&
      !executionFile
    ) {
      if (tick === undefined)
        throw Error("Set cursor A before opening execution evidence.");
      const filename = (
        await vscode.window.showOpenDialog({
          title: "Choose the waveform execution recording",
          filters: { "Execution recording": ["jsonl"] },
          defaultUri: vscode.Uri.file(path.dirname(viewer.uri.fsPath)),
        })
      )?.[0];
      if (!filename || viewer.disposed) return;
      executionFile = filename.fsPath;
    }
    if (mode === "execution") {
      await viewer.ready;
      const signal = await findSignal(viewer.backend, fullname, ".");
      const settings = vscode.workspace.getConfiguration(
        "waveWorkbench",
        viewer.uri,
      );
      const instance = mapPrefix(
        signal.scope,
        settings.get("hierarchyMappings"),
      );
      const evidence = await readExecutionEvidence(
        executionFile!,
        viewer.uri.fsPath,
        viewer.meta.scale,
        instance,
        declaredSignalName(signal.name),
        tick,
        tick,
      );
      await showExecutionEvidence(evidence, viewer, fullname);
      return;
    }
    const direction = mode === "loads" ? "loads" : "drivers";
    const live = mode === "live" ? getLive() : undefined;
    if (mode === "live" && !live)
      throw Error("Start a live simulation harness first.");
    const withContext = mode === "context" || mode === "recordedContext";
    const followStatic =
      followContinuations && (mode === "drivers" || mode === "loads");
    const traceOptions = followContinuations ? continuationOptions : {};
    const request = resetTraceContext();
    const assertActive = () => {
      if (request !== traceSelection)
        throw new TraceContextChanged(
          "The selected trace changed during continuation.",
        );
    };
    traceExplorer.setMessage(
      [
        "正在追踪 · " +
          traceModeLabel(direction, withContext ? tick : undefined),
        fullname,
        "波形 " + path.basename(viewer.uri.fsPath),
      ].join("\n"),
    );
    const startingCursor = viewer.rtlCursor;
    const content = await Promise.resolve(
      vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Tracing " + fullname,
          cancellable: true,
        },
        async (_progress, token) => {
          const continuationDeadline = followContinuations
            ? AbortSignal.timeout(traceContinuationTimeout)
            : undefined;
          let result = await traceWaveSignal(
            viewer,
            direction,
            fullname,
            traceOptions,
            token,
          );
          if (
            !live &&
            !token.isCancellationRequested &&
            (!withContext ||
              followContinuations ||
              result.trace.signals.some((signal) => signal.modportAlias))
          )
            result = await focusWaveTrace(viewer, result, fullname, direction);
          if (
            request !== traceSelection ||
            token.isCancellationRequested ||
            viewer.disposed
          )
            return;
          const backend = viewer.backend;
          const bindings =
            withContext && tick !== undefined
              ? await bindTraceObservations(viewer, result)
              : undefined;
          result = {
            ...result,
            trace: await bindStaticFrontier(viewer, result, bindings?.bindings),
          };
          const sampling = new AbortController();
          const cancelSampling = token.onCancellationRequested(() =>
            sampling.abort(),
          );
          let evidence:
            | Awaited<ReturnType<typeof traceWaveContext>>
            | undefined;
          let liveEvidence:
            | Awaited<ReturnType<typeof traceLiveContext>>
            | undefined;
          let appendix: string | undefined;
          let combinedTemporal:
            | ReturnType<typeof mergeTemporalContinuationGraph>
            | undefined;
          let combinedStatic:
            | ReturnType<typeof mergeStaticContinuationGraph>
            | undefined;
          let continuation: TraceContinuationState | undefined;
          let staticContinuation: StaticContinuationState | undefined;
          try {
            if (live)
              liveEvidence = await traceLiveContext(
                viewer,
                result,
                live,
                sampling.signal,
                undefined,
                executionFile,
                undefined,
                undefined,
                tick,
              );
            else if (bindings && tick !== undefined)
              evidence = await traceWaveContext(
                viewer,
                result,
                tick,
                "auto",
                await verifyWaveTrace(viewer, result),
                bindings,
                sampling.signal,
                executionFile,
                undefined,
                changeOrder === undefined ? undefined : { changeOrder },
              );
            const context = liveEvidence?.context ?? evidence?.context;
            if (followStatic && continuationDeadline) {
              const state = await createStaticWalk(
                viewer,
                fullname,
                result,
                direction,
                traceOptions,
                undefined,
                assertActive,
                true,
              );
              const walk = await state.run(
                automaticTraceContinuationLimit,
                sampling.signal,
                continuationDeadline,
              );
              combinedStatic = mergeStaticContinuationGraph(result.trace, walk);
              appendix = staticContinuationReport(
                direction,
                walk,
                staticContinuationMermaid(fullname, walk),
                mergedStaticMermaid(combinedStatic),
              );
              if (
                walk.remaining.length &&
                !walk.stopReasons.includes("contextChanged")
              )
                staticContinuation = {
                  ...state,
                  kind: "static",
                  root: fullname,
                  initial: result.trace,
                  direction,
                  walk,
                };
            }
            if (continuationDeadline && context && !sampling.signal.aborted) {
              const root = {
                signal: fullname,
                tick: context.tick,
                changeOrder,
                liveSessionId: live?.id,
              };
              const { assertCurrent, checkpoint } =
                await createContinuationGuard(
                  viewer,
                  result,
                  live,
                  executionFile,
                  true,
                );
              const query = temporalQuery(
                vscode,
                analyses,
                viewer,
                assertActive,
                live,
                executionFile,
              );
              const walk = await followTemporalFrontier(
                root,
                context.temporalTrace,
                automaticTraceContinuationLimit,
                sampling.signal,
                continuationDeadline,
                query,
                {
                  assertCurrent,
                  defaultHistoryStart: live ? undefined : "auto",
                },
              );
              const initial = {
                context,
                waveformSignals: temporalWaveformSignals(context),
                ...temporalTraceReferences(result.trace, context.temporalTrace),
              };
              combinedTemporal = mergeTemporalContinuationGraph(initial, walk);
              appendix = continuationReport(
                walk,
                continuationMermaidPages(root, walk),
                combinedTemporal,
              );
              if (
                walk.remaining.length &&
                !walk.stopReasons.includes("contextChanged")
              )
                continuation = {
                  root,
                  initial,
                  walk,
                  query,
                  assertCurrent,
                  checkpoint,
                };
            }
          } finally {
            cancelSampling.dispose();
          }
          if (
            request !== traceSelection ||
            (token.isCancellationRequested && !appendix) ||
            viewer.disposed ||
            backend !== viewer.backend ||
            (live && live !== getLive())
          )
            return;
          if (bindings && tick !== undefined)
            traceContext = {
              viewer,
              result,
              bindings,
              backend,
              tick,
              executionFile,
            };
          traceViewer = viewer;
          liveTraceRecording = live ? executionFile : undefined;
          const baseReport =
            traceReport(result.trace, direction, fullname) +
            (liveEvidence
              ? liveTraceReport(liveEvidence, result.trace)
              : (evidence
                  ? observationReport(evidence.context, result.trace)
                  : "") +
                (evidence?.execution
                  ? executionReport(evidence.execution)
                  : "") +
                traceExecutionComparisonReport(
                  evidence,
                  evidence?.execution?.events,
                ));
          if (continuation && combinedTemporal)
            traceContinuation = {
              ...continuation,
              kind: "temporal",
              combined: combinedTemporal,
              report: baseReport,
            };
          if (staticContinuation && combinedStatic)
            traceContinuation = {
              ...staticContinuation,
              combined: combinedStatic,
              report: baseReport,
            };
          await showWaveEvidence(
            result.trace,
            direction,
            liveEvidence?.context ?? evidence?.context,
            {
              combined: combinedTemporal,
              combinedStatic,
              wave: { viewer, backend, result, fullname },
              executionFile: live ? undefined : executionFile,
            },
          );
          if (
            request === traceSelection &&
            viewer.rtlCursor &&
            viewer.rtlCursor !== startingCursor
          )
            refreshTraceCursor(viewer, viewer.rtlCursor.tick);
          return appendContinuationReport(baseReport, appendix);
        },
      ),
    ).finally(() => {
      if (request === traceSelection && !traceSnapshot)
        traceExplorer.setMessage(undefined);
    });
    if (content === undefined || request !== traceSelection) return;
    if (!openReport) return;
    const document = await vscode.workspace.openTextDocument({
      language: "markdown",
      content,
    });
    await vscode.window.showTextDocument(document);
  }
  for (const direction of ["drivers", "loads"] as const) {
    const command = direction === "drivers" ? "traceDrivers" : "traceLoads";
    context.subscriptions.push(
      vscode.commands.registerCommand("waveWorkbench." + command, async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor)
          return report(Error("Select an RTL signal in the editor."));
        const request = resetTraceContext();
        try {
          const trace = await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: "Tracing RTL " + direction,
              cancellable: true,
            },
            (_progress, token) =>
              traceRtlPosition(
                direction,
                editor.document.uri,
                editor.selection.active,
                undefined,
                token,
              ),
          );
          const document = await vscode.workspace.openTextDocument({
            language: "markdown",
            content: traceReport(trace, direction),
          });
          if (request !== traceSelection) return;
          traceViewer = undefined;
          await showWaveEvidence(trace, direction);
          if (request !== traceSelection) return;
          await vscode.window.showTextDocument(document);
        } catch (error) {
          report(error);
        }
      }),
    );
  }
  for (const [command, mode] of [
    ["traceWaveDrivers", "drivers"],
    ["traceWaveLoads", "loads"],
    ["traceWaveAtCursor", "context"],
  ] as const) {
    context.subscriptions.push(
      vscode.commands.registerCommand("waveWorkbench." + command, async () => {
        try {
          const viewer = getCurrent();
          if (!viewer || viewer.disposed) {
            void vscode.window.showInformationMessage("请先打开一个波形。");
            return;
          }
          await viewer.ready;
          if (viewer.disposed) return;
          if (!viewer.meta) throw Error("当前波形未加载成功。");
          if (!viewer.panel.visible)
            viewer.panel.reveal(viewer.panel.viewColumn, true);
          const selected: Signal | null = await viewer.ui("activeSignal");
          if (viewer.disposed) return;
          if (!selected || !selected.supported || selected.definition) {
            void vscode.window.showInformationMessage(
              "请先在波形中选中一条 RTL 信号。",
            );
            return;
          }
          const name = WaveSignal.label({
            ...selected,
            displayName: undefined,
          });
          const fullname = [selected.scope, name].filter(Boolean).join(".");
          let tick = viewer.rtlCursor?.tick;
          if (mode === "context" && tick === undefined) {
            const view: WaveState = await viewer.ui("snapshot");
            if (viewer.disposed) return;
            tick = view.cursorA;
          }
          await showSignalTrace(
            viewer,
            fullname,
            mode,
            tick === undefined ? undefined : String(tick),
            undefined,
            undefined,
            false,
            false,
          );
        } catch (error) {
          report(error);
        }
      }),
    );
  }

  function clearViewerTrace(viewer: Viewer) {
    if (traceViewer === viewer || traceContext?.viewer === viewer)
      resetTraceContext();
  }

  return {
    showSignalTrace,
    refreshTraceCursor,
    clearTraceContinuation,
    clearViewerTrace,
    getTraceSnapshot: () => traceSnapshot,
    traceSubject,
  };
}
