// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import * as path from "node:path";
import { type TraceProjectSelection } from "./project";
import {
  appendContinuationReport,
  declaredSignalName,
  followTemporalFrontier,
  observationMermaidPages,
  observationReport,
  staticTraceCoverage,
  staticTracePage,
  temporalMermaidOutput,
  temporalContinuationHistoryStart,
  temporalSignalName,
  temporalTraceReferences,
  temporalWaveformSignals,
  traceFeedback,
  traceContinuationTimeout,
  traceMermaidPages,
  traceReport,
  type TraceOptions,
  type TemporalContinuation,
} from "./rtl-trace";
import {
  mergeStaticContinuationGraph,
  mergedStaticMermaid,
  pageStaticContinuationGraph,
  staticContinuationMermaid,
  staticContinuationReport,
  summarizeStaticWalk,
  type StaticWalk,
} from "./rtl-static-continuations";
import { staticGraphSnapshot } from "./rtl-trace-graph-page";
import { executionReport } from "./rtl-execution";
import { mermaidOutput } from "./trace-mermaid";
import { readTraceBuildManifest } from "./rtl-build-verification";

import type {
  AnalysisView,
  GetLiveTrace,
  TraceHost,
} from "./wave-analysis-types";
import type {
  AnalysisProjects,
  TraceRequestProject,
} from "./wave-analysis-projects";
import type { AnalysisBindings } from "./wave-analysis-bindings";
import type { ObservedContext } from "./wave-analysis-observations";
import type { AnalysisContext, LiveContext } from "./wave-analysis-context";
import { continuationLimit, type TraceGraphs } from "./wave-analysis-graphs";
import {
  traceExecutionComparisonReport,
  traceExecutionGraph,
  liveTraceReport,
} from "./wave-analysis-reports";

type AnalysisRequest = (
  name: string,
  args: Record<string, unknown>,
  operation: AbortSignal,
  requestProject: TraceRequestProject,
) => Promise<unknown>;

export function createTraceTool<V extends AnalysisView>(
  host: TraceHost,
  getLive: GetLiveTrace,
  projects: Pick<
    AnalysisProjects<V>,
    "traceWaveSignal" | "createContinuationGuard"
  >,
  bindings: Pick<
    AnalysisBindings<V>,
    "createStaticWalk" | "bindStaticFrontier" | "focusWaveTrace"
  >,
  context: AnalysisContext<V>,
  graphs: TraceGraphs,
  workspace: string,
) {
  const { traceWaveSignal, createContinuationGuard } = projects;
  const { createStaticWalk, bindStaticFrontier, focusWaveTrace } = bindings;
  const { traceWaveContext, verifyWaveTrace, traceLiveContext } = context;
  const { saveGraph, retain, continuationOutput, pagedTemporal } = graphs;

  return async function queryTraceTool(
    name: string,
    args: Record<string, unknown>,
    viewer: V,
    operation: AbortSignal,
    requestProject: TraceRequestProject,
    pagedGraph: boolean,
    request: AnalysisRequest,
  ): Promise<unknown> {
    const live = name === "wave_live_trace" ? getLive() : undefined;
    if (name === "wave_live_trace" && !live)
      throw Error("Start a live simulation harness first.");
    if (
      live &&
      args.liveSessionId !== undefined &&
      args.liveSessionId !== live.id
    )
      throw Error("The live simulation session changed.");
    const anchor = args.continueFrom as
      | (Pick<TemporalContinuation, "signal" | "tick" | "changeOrder"> & {
          historyStart?: string;
        })
      | undefined;
    const requestedFollowLimit = continuationLimit(args);
    const decimalTick = (value: unknown) =>
      typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value);
    if (
      anchor &&
      (typeof anchor.signal !== "string" ||
        !anchor.signal ||
        !decimalTick(anchor.tick) ||
        (anchor.historyStart !== undefined &&
          !decimalTick(anchor.historyStart)) ||
        (anchor.changeOrder !== undefined &&
          (!Number.isSafeInteger(anchor.changeOrder) ||
            anchor.changeOrder < 1)))
    )
      throw Error(
        "continueFrom requires a signal and decimal tick, with optional changeOrder and historyStart.",
      );
    if (anchor && requestedFollowLimit !== undefined)
      throw Error(
        "Choose either continueFrom or an automatic continuation budget.",
      );
    if (
      anchor?.historyStart !== undefined &&
      BigInt(anchor.historyStart) > BigInt(anchor.tick)
    )
      throw Error(
        "The continuation history must start at or before its transition.",
      );
    const followLimit = anchor ? 1 : requestedFollowLimit;
    const continuationDeadline =
      followLimit === undefined
        ? undefined
        : AbortSignal.timeout(traceContinuationTimeout);
    const direction = name === "wave_trace_loads" ? "loads" : "drivers";
    const signal = String(args.signal);
    const filelist =
      typeof args.filelist === "string"
        ? path.resolve(workspace, args.filelist)
        : undefined;
    const videManifest =
      typeof args.videManifest === "string"
        ? path.resolve(workspace, args.videManifest)
        : undefined;
    const buildManifest =
      typeof args.buildManifest === "string"
        ? await readTraceBuildManifest(
            path.resolve(workspace, args.buildManifest),
          )
        : undefined;
    operation.throwIfAborted();
    const cancellation = host.cancellation();
    const cancel = () => cancellation.cancel();
    operation.addEventListener("abort", cancel, { once: true });
    const expand = args.expandReachable === true;
    const traceOptions: TraceOptions = {
      maxDepth:
        (args.maxDepth as number | undefined) ?? (expand ? 256 : undefined),
      maxSignals:
        (args.maxSignals as number | undefined) ?? (expand ? 4096 : undefined),
      maxAssignments:
        (args.maxAssignments as number | undefined) ??
        (expand ? 4096 : undefined),
      includeCompilation:
        buildManifest || followLimit !== undefined ? true : undefined,
    };
    const override: TraceProjectSelection | undefined = filelist
      ? {
          filelist,
          workingDirectory:
            typeof args.simulationDirectory === "string"
              ? path.resolve(workspace, args.simulationDirectory)
              : path.dirname(filelist),
        }
      : videManifest
        ? { videManifest }
        : undefined;
    const limits = {
      nodes: args.maxTemporalNodes as number | undefined,
      edges: args.maxTemporalEdges as number | undefined,
      gaps: args.maxTemporalGaps as number | undefined,
      changeOrder: args.changeOrder as number | undefined,
    };
    let result = await traceWaveSignal(
      viewer,
      direction,
      signal,
      traceOptions,
      cancellation.token,
      override,
      buildManifest,
      requestProject,
    ).finally(() => {
      operation.removeEventListener("abort", cancel);
      cancellation.dispose();
    });
    operation.throwIfAborted();
    if (!live) result = await focusWaveTrace(viewer, result, signal, direction);
    operation.throwIfAborted();
    const trace = await bindStaticFrontier(viewer, result);
    operation.throwIfAborted();
    result = { ...result, trace };
    const { instance } = result;
    const feedbackEdges = traceFeedback(trace);
    const staticCoverage = staticTraceCoverage(trace);
    const verification = live
      ? undefined
      : await verifyWaveTrace(viewer, result);
    operation.throwIfAborted();
    let staticAppendix: string | undefined;
    const staticOutput: {
      continuationCursor?: string;
      staticContinuationWalk?: StaticWalk;
      staticContinuationGraph?: ReturnType<typeof mergeStaticContinuationGraph>;
      staticContinuationMermaid?: string;
      staticContinuationMermaidPages?: string[];
      staticContinuationGraphMermaid?: string;
      staticContinuationGraphMermaidPages?: string[];
    } = {};
    const staticQuery =
      name === "wave_trace_drivers" || name === "wave_trace_loads";
    const graphOnly = staticQuery && args.output === "graph";
    const paginating =
      args.pageSize !== undefined || args.pageCursor !== undefined;
    let staticWalk: StaticWalk | undefined;
    if (staticQuery && followLimit !== undefined && continuationDeadline) {
      const state = await createStaticWalk(
        viewer,
        signal,
        result,
        direction,
        traceOptions,
        override,
      );
      staticWalk = await state.run(
        followLimit,
        operation,
        continuationDeadline,
        undefined,
        requestProject,
      );
      operation.throwIfAborted();
      if (args.pageCursor === undefined)
        staticOutput.continuationCursor = retain({
          ...state,
          kind: "static",
          root: signal,
          initial: trace,
          direction,
          instance,
          walk: staticWalk,
          waveform: viewer.uri.fsPath,
        });
    }
    if (staticQuery && pagedGraph) {
      const bitExpressions = new Map();
      const graph = mergeStaticContinuationGraph(
        trace,
        staticWalk,
        bitExpressions,
      );
      return {
        output: "paged",
        signal,
        instance,
        direction,
        buildVerification: verification,
        continuationCursor: staticOutput.continuationCursor,
        graphSnapshot: saveGraph(
          staticGraphSnapshot(graph),
          {
            format: args.format,
            fullReport: args.detail === "full",
            staticTrace: { graph, direction, bitExpressions },
            mermaid: () => mergedStaticMermaid(graph),
            report: (pages) =>
              appendContinuationReport(
                traceReport(
                  trace,
                  direction,
                  signal,
                  feedbackEdges,
                  staticCoverage,
                ),
                staticWalk &&
                  staticContinuationReport(
                    direction,
                    staticWalk,
                    staticContinuationMermaid(signal, staticWalk),
                    pages(),
                  ),
              ),
          },
          staticWalk,
        ),
        ...(staticWalk
          ? {
              continuation: {
                queried: staticWalk.segments.length,
                remaining: staticWalk.remaining.length,
                stopReasons: staticWalk.stopReasons,
              },
            }
          : {}),
      };
    }
    if (graphOnly) {
      operation.throwIfAborted();
      const combined = mergeStaticContinuationGraph(trace, staticWalk);
      const { graph, page } = paginating
        ? pageStaticContinuationGraph(
            combined,
            direction,
            signal,
            args.pageSize as number | undefined,
            args.pageCursor as string | undefined,
          )
        : { graph: combined, page: undefined };
      const diagram =
        args.format === "mermaid" ? mergedStaticMermaid(graph) : undefined;
      return {
        output: "graph",
        signal,
        instance,
        direction,
        staticCoverage,
        continuationCursor: staticOutput.continuationCursor,
        staticContinuationGraph: graph,
        page,
        ...(verification ? { buildVerification: verification } : {}),
        ...(staticWalk
          ? {
              staticContinuationWalk: summarizeStaticWalk(staticWalk),
            }
          : {}),
        ...(diagram
          ? mermaidOutput("staticContinuationGraphMermaid", diagram)
          : {}),
        ...(args.detail === "full"
          ? {
              report: appendContinuationReport(
                traceReport(
                  trace,
                  direction,
                  signal,
                  feedbackEdges,
                  staticCoverage,
                ),
                staticWalk
                  ? staticContinuationReport(
                      direction,
                      staticWalk,
                      staticContinuationMermaid(signal, staticWalk),
                      mergedStaticMermaid(combined),
                    )
                  : undefined,
              ),
            }
          : {}),
      };
    }
    if (staticWalk) {
      staticOutput.staticContinuationWalk = staticWalk;
      const combined = mergeStaticContinuationGraph(trace, staticWalk);
      staticOutput.staticContinuationGraph = combined;
      if (args.format === "mermaid" || args.detail === "full") {
        const diagrams = staticContinuationMermaid(signal, staticWalk);
        const merged = mergedStaticMermaid(combined);
        if (args.format === "mermaid")
          Object.assign(
            staticOutput,
            mermaidOutput("staticContinuationMermaid", diagrams),
            mermaidOutput("staticContinuationGraphMermaid", merged),
          );
        if (args.detail === "full")
          staticAppendix = staticContinuationReport(
            direction,
            staticWalk,
            diagrams,
            merged,
          );
      }
    }
    if (paginating) {
      const paged = staticTracePage(
        trace,
        direction,
        signal,
        args.pageSize as number | undefined,
        args.pageCursor as string | undefined,
      );
      const { assignmentOffset, assignmentCount } = paged.page;
      const feedback = feedbackEdges.flatMap((edge) =>
        edge.assignment >= assignmentOffset &&
        edge.assignment < assignmentOffset + assignmentCount
          ? [
              {
                ...edge,
                assignment: edge.assignment - assignmentOffset,
              },
            ]
          : [],
      );
      return {
        ...paged.trace,
        signal,
        instance,
        direction,
        staticCoverage,
        ...staticOutput,
        ...(verification ? { buildVerification: verification } : {}),
        feedbackEdges: feedback,
        page: paged.page,
        ...(args.format === "mermaid"
          ? mermaidOutput("mermaid", traceMermaidPages(paged.trace, feedback))
          : {}),
        ...(args.detail === "full"
          ? {
              report: appendContinuationReport(
                traceReport(
                  paged.trace,
                  direction,
                  signal,
                  feedback,
                  staticCoverage,
                ),
                staticAppendix,
              ),
            }
          : {}),
      };
    }
    const reportOnly = args.output === "report";
    const temporalOnly =
      args.output === "temporal" ||
      (args.output === undefined && followLimit !== undefined);
    const fullReport = reportOnly || args.detail === "full";
    const temporalOutput = (
      context: ObservedContext["context"] | LiveContext["context"],
    ) => {
      const {
        schemaVersion,
        tick,
        historyStart,
        historyEnd,
        scale,
        provider,
        mode,
        sourceMatch,
        selectedTransition,
        temporalTrace,
        observations,
        runtimeInputs,
        runtimeInputSource,
        runtimeMismatches,
        waveformBindings,
      } = context;
      return {
        output: "temporal",
        ...temporalTraceReferences(trace, temporalTrace),
        waveformSignals: temporalWaveformSignals(context),
        context: {
          schemaVersion,
          tick,
          historyStart,
          historyEnd,
          scale,
          provider,
          mode,
          sourceMatch,
          selectedTransition,
          temporalTrace,
          observations: observations.filter(
            ({ signal }) => signal === trace.root,
          ),
          runtimeInputs,
          runtimeInputSource,
          runtimeMismatches,
          waveformBindings,
        },
      };
    };
    const follow = async (
      context: Parameters<typeof temporalOutput>[0],
      rootReport: () => string,
    ) => {
      if (followLimit === undefined || !continuationDeadline) {
        if (pagedGraph) {
          return {
            graphSnapshot: pagedTemporal(
              temporalOutput(context),
              args.format,
              fullReport,
              rootReport,
            ),
            walkReport: undefined,
          };
        }
        return { walkReport: undefined };
      }
      const root = {
        signal,
        tick: context.tick,
        changeOrder: limits.changeOrder,
        liveSessionId: live?.id,
      };
      const recording =
        typeof args.executionLog === "string"
          ? path.resolve(workspace, args.executionLog)
          : undefined;
      const { assertCurrent } = await createContinuationGuard(
        viewer,
        result,
        live,
        recording,
      );
      const initial = temporalOutput(context);
      const defaultHistoryStart = args.historyStart as string | undefined;
      const graph = initial.context.temporalTrace;
      let selected: TemporalContinuation[] | undefined;
      if (anchor) {
        const matches = graph?.nodes.flatMap((point, index) => {
          const waveform = initial.waveformSignals[point.signal];
          if (
            !waveform ||
            index === 0 ||
            point.sampleOnly ||
            point.executionOnly ||
            point.initialSample ||
            point.value === undefined ||
            point.tick !== anchor.tick ||
            (anchor.changeOrder !== undefined &&
              (point.orderAtTick ?? 1) !== anchor.changeOrder)
          )
            return [];
          const name = temporalSignalName(waveform, point.bit);
          return name === anchor.signal ||
            (point.bit === undefined &&
              declaredSignalName(name) === anchor.signal)
            ? [{ index, point, name }]
            : [];
        });
        if (matches?.length !== 1 || !graph)
          throw Error(
            "Select a unique upstream waveform transition from the first graph.",
          );
        const [{ index, point, name }] = matches;
        const continuation = {
          signal: name,
          tick: point.tick,
          changeOrder: point.orderAtTick,
          liveSessionId: live?.id,
          historyStart: anchor.historyStart,
        };
        selected = [continuation];
        initial.context.temporalTrace = {
          ...graph,
          gaps: [
            ...graph.gaps,
            {
              signal: point.signal,
              bit: point.bit,
              tick: point.tick,
              value: point.value,
              orderAtTick: point.orderAtTick,
              reason: "selectedContinuation",
              anchor: index,
              continuation,
            },
          ],
        };
      }
      const query = async (
        continuation: TemporalContinuation,
        abort: AbortSignal,
        batchProject: TraceRequestProject,
      ) => {
        const historyStart = temporalContinuationHistoryStart(
          continuation,
          defaultHistoryStart,
        );
        const reply = await request(
          name,
          {
            ...args,
            changeOrder: undefined,
            ...continuation,
            historyStart,
            waveform: viewer.uri.fsPath,
            output: "temporal",
            detail: undefined,
            format: undefined,
            followContinuations: undefined,
            followAllContinuations: undefined,
            continueFrom: undefined,
          },
          abort,
          batchProject,
        );
        return reply as ReturnType<typeof temporalOutput>;
      };
      const walk = await followTemporalFrontier(
        root,
        initial.context.temporalTrace,
        followLimit,
        operation,
        anchor
          ? AbortSignal.timeout(traceContinuationTimeout)
          : continuationDeadline,
        (point, abort) => query(point, abort, requestProject),
        { assertCurrent, defaultHistoryStart, selected },
      );
      operation.throwIfAborted();
      if (pagedGraph) {
        return {
          graphSnapshot: pagedTemporal(
            initial,
            args.format,
            fullReport,
            rootReport,
            { root, walk },
          ),
          continuationCursor: retain({
            kind: "temporal",
            root,
            initial,
            rootReport,
            waveform: viewer.uri.fsPath,
            walk,
            assertCurrent,
            defaultHistoryStart,
            query,
          }),
          continuation: {
            queried: walk.segments.length,
            remaining: walk.remaining.length,
            stopReasons: walk.stopReasons,
          },
          walkReport: undefined,
        };
      }
      return {
        ...continuationOutput(
          root,
          initial,
          walk,
          args.format === "mermaid",
          fullReport,
        ),
        continuationCursor: retain({
          kind: "temporal",
          root,
          initial,
          rootReport,
          waveform: viewer.uri.fsPath,
          walk,
          assertCurrent,
          defaultHistoryStart,
          query,
        }),
      };
    };
    if (live) {
      const evidence = await traceLiveContext(
        viewer,
        result,
        live,
        operation,
        args.historyStart as string | undefined,
        typeof args.executionLog === "string"
          ? path.resolve(workspace, args.executionLog)
          : undefined,
        expand,
        limits,
        args.tick as string | undefined,
      );
      const {
        context,
        buildVerification,
        execution,
        executionCoverage,
        replayMatch: executionReplayMatch,
        executionAssignments,
        executionTransitions,
        upstreamExecution,
      } = evidence;
      const report = () =>
        traceReport(trace, "drivers", signal, feedbackEdges, staticCoverage) +
        liveTraceReport(evidence, trace);
      const { walkReport, ...continuations } = await follow(context, report);
      if (pagedGraph)
        return {
          output: "paged",
          signal,
          instance,
          tick: context.tick,
          liveSessionId: live.id,
          buildVerification,
          executionCoverage,
          executionReplayMatch,
          ...continuations,
        };
      return {
        ...(temporalOnly
          ? temporalOutput(context)
          : reportOnly
            ? {}
            : {
                ...trace,
                feedbackEdges,
                context,
                execution,
                executionAssignments,
                executionTransitions,
                upstreamExecution,
              }),
        signal,
        instance,
        liveSessionId: live.id,
        staticCoverage,
        buildVerification,
        executionCoverage,
        executionReplayMatch,
        ...continuations,
        ...(reportOnly
          ? {
              tick: context.tick,
              temporalCoverage: context.temporalTrace?.coverage,
            }
          : {}),
        ...(args.format === "mermaid"
          ? {
              ...(!temporalOnly
                ? mermaidOutput(
                    "mermaid",
                    traceMermaidPages(trace, feedbackEdges),
                  )
                : {}),
              ...(execution.length || upstreamExecution?.length
                ? mermaidOutput(
                    "executionMermaid",
                    traceExecutionGraph(execution, upstreamExecution),
                  )
                : {}),
              ...(context.temporalTrace
                ? temporalMermaidOutput(
                    context.temporalTrace,
                    context,
                    undefined,
                    trace.signals,
                  )
                : {}),
            }
          : {}),
        ...(fullReport
          ? {
              report: appendContinuationReport(report(), walkReport),
            }
          : {}),
      };
    }
    const evidence =
      name === "wave_trace_context"
        ? await traceWaveContext(
            viewer,
            result,
            String(args.tick),
            args.historyStart as string | undefined,
            verification,
            undefined,
            operation,
            typeof args.executionLog === "string"
              ? path.resolve(workspace, args.executionLog)
              : undefined,
            expand,
            limits,
          )
        : undefined;
    const {
      context,
      execution,
      executionAssignments,
      executionTransitions,
      upstreamExecution,
    } = evidence ?? {};
    const report = () =>
      traceReport(trace, direction, signal, feedbackEdges, staticCoverage) +
      (context ? observationReport(context, trace) : "") +
      (execution ? executionReport(execution) : "") +
      traceExecutionComparisonReport(evidence, execution?.events);
    const { walkReport, ...continuations } = context
      ? await follow(context, report)
      : { walkReport: undefined };
    if (pagedGraph && context)
      return {
        output: "paged",
        signal,
        instance,
        direction,
        tick: context.tick,
        buildVerification: verification,
        ...continuations,
      };
    return {
      ...(temporalOnly && context
        ? temporalOutput(context)
        : reportOnly
          ? {}
          : {
              ...trace,
              feedbackEdges,
              context,
              execution,
              ...(executionAssignments?.length ? { executionAssignments } : {}),
              ...(executionTransitions?.length ? { executionTransitions } : {}),
              ...(upstreamExecution?.length ? { upstreamExecution } : {}),
            }),
      direction,
      signal,
      instance,
      staticCoverage,
      ...staticOutput,
      ...continuations,
      ...(verification ? { buildVerification: verification } : {}),
      ...(reportOnly
        ? {
            tick: context?.tick,
            temporalCoverage: context?.temporalTrace?.coverage,
            selectedTransition: context?.selectedTransition,
          }
        : {}),
      ...(execution && args.format === "mermaid"
        ? mermaidOutput(
            "executionMermaid",
            traceExecutionGraph(execution.events, upstreamExecution),
          )
        : {}),
      ...(context && args.format === "mermaid"
        ? {
            ...(!temporalOnly
              ? mermaidOutput(
                  "observationMermaid",
                  observationMermaidPages(context),
                )
              : {}),
            ...(context.temporalTrace
              ? temporalMermaidOutput(
                  context.temporalTrace,
                  context,
                  new Map(
                    executionTransitions?.flatMap(
                      ({ links }) =>
                        links?.map(
                          ({ node, ordinal }) => [node, ordinal] as const,
                        ) ?? [],
                    ),
                  ),
                  trace.signals,
                )
              : {}),
          }
        : {}),
      ...(args.format === "mermaid" && !temporalOnly
        ? mermaidOutput("mermaid", traceMermaidPages(trace, feedbackEdges))
        : {}),
      ...(fullReport
        ? {
            report: appendContinuationReport(
              report(),
              walkReport ?? staticAppendix,
            ),
          }
        : {}),
    };
  };
}
