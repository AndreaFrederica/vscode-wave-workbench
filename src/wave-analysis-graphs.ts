// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { randomUUID } from "node:crypto";
import {
  selectTracePathNodes,
  traceGraphPaths,
  tracePathReport,
} from "./rtl-trace-path";
import {
  isBitPathSelector,
  staticBitMermaid,
  staticBitPaths,
  staticBitReport,
} from "./rtl-static-bit-path";
import {
  staticTracePaths,
  staticPathReport,
  type StaticPathGraph,
} from "./rtl-static-path";
import {
  appendContinuationReport,
  automaticTraceContinuationLimit,
  continuationMermaidPages,
  continuationReport,
  combinedTemporalMermaid,
  mergeTemporalContinuationGraph,
  followTemporalFrontier,
  TraceContextChanged,
  traceContinuationTimeout,
  traceReport,
  type TraceDirection,
  type VideTrace,
  type ContinuationTrace,
  type ContinuationWalk,
  type TemporalContinuation,
} from "./rtl-trace";
import {
  mergeStaticContinuationGraph,
  mergedStaticMermaid,
  staticContinuationMermaid,
  staticContinuationReport,
  summarizeStaticWalk,
  type StaticWalk,
} from "./rtl-static-continuations";
import {
  staticGraphSnapshot,
  temporalGraphSnapshot,
  traceGraphPage,
} from "./rtl-trace-graph-page";
import { mermaidOutput } from "./trace-mermaid";

import type { AnalysisView } from "./wave-analysis-types";
import type { TraceRequestProject } from "./wave-analysis-projects";
import type { AnalysisBindings } from "./wave-analysis-bindings";

type TraceContinuationState = {
  root: TemporalContinuation;
  initial: ContinuationTrace;
  rootReport: () => string;
  walk: ContinuationWalk;
  assertCurrent: () => Promise<void>;
  defaultHistoryStart?: string;
  query: (
    point: TemporalContinuation,
    abort: AbortSignal,
    requestProject: TraceRequestProject,
  ) => Promise<ContinuationTrace>;
};
type StaticContinuationState = Awaited<
  ReturnType<AnalysisBindings<AnalysisView>["createStaticWalk"]>
> & {
  kind: "static";
  root: string;
  initial: VideTrace;
  direction: TraceDirection;
  walk: StaticWalk;
};

// A single request can visit many shallow frontiers while preserving the existing resume protocol.
export function continuationLimit(
  args: Record<string, unknown>,
  fallback?: number,
) {
  const requested = args.followContinuations as number | undefined;
  const minimum = fallback === undefined ? 0 : 1;
  if (
    requested !== undefined &&
    (!Number.isInteger(requested) || requested < minimum || requested > 8)
  )
    throw Error(`followContinuations must be an integer from ${minimum} to 8.`);
  if (args.followAllContinuations === true) {
    if (requested !== undefined)
      throw Error(
        "Choose either followAllContinuations or followContinuations.",
      );
    return automaticTraceContinuationLimit;
  }
  return requested ?? fallback;
}

function continuationSections(walk: StaticWalk | ContinuationWalk) {
  return {
    frontier: walk.remaining,
    queryFailures: walk.segments.filter((entry) => "error" in entry),
  };
}

export function createTraceGraphs() {
  type RetainedContinuation = (
    | (TraceContinuationState & { kind: "temporal" })
    | (StaticContinuationState & { instance: string })
  ) & {
    waveform: string;
    busy?: boolean;
  };
  const retained = new Map<string, RetainedContinuation>();
  const graphs = new Map<
    string,
    {
      sections: Record<string, readonly unknown[]>;
      temporal?: Parameters<typeof traceGraphPaths>[0];
      staticTrace?: {
        graph: StaticPathGraph;
        direction: TraceDirection;
        bitExpressions?: Parameters<typeof staticBitPaths>[5];
      };
      mermaid: () => readonly string[];
      report: () => readonly string[];
    }
  >();
  function saveGraph(
    snapshot:
      | ReturnType<typeof staticGraphSnapshot>
      | ReturnType<typeof temporalGraphSnapshot>,
    options: {
      format: unknown;
      fullReport: boolean;
      temporal?: Parameters<typeof traceGraphPaths>[0];
      staticTrace?: {
        graph: StaticPathGraph;
        direction: TraceDirection;
        bitExpressions?: Parameters<typeof staticBitPaths>[5];
      };
      mermaid: () => string[];
      report: (pages: () => string[]) => string;
    },
    walk?: StaticWalk | ContinuationWalk,
  ) {
    const sections: Record<string, readonly unknown[]> = {
      ...snapshot.sections,
      ...(walk ? continuationSections(walk) : {}),
    };
    let pages: string[] | undefined;
    const mermaid = () => (pages ??= options.mermaid());
    const report = () =>
      options.report(mermaid).match(/[\s\S]{1,32768}/gu) ?? [];
    if (options.format === "mermaid") sections.mermaid = mermaid();
    if (options.fullReport) sections.report = report();
    if (graphs.size >= 4) graphs.delete(graphs.keys().next().value!);
    const graphCursor = process.pid + "." + randomUUID();
    graphs.set(graphCursor, {
      sections,
      mermaid,
      report,
      temporal: options.temporal,
      staticTrace: options.staticTrace,
    });
    return {
      graphCursor,
      kind: snapshot.kind,
      metadata: snapshot.metadata,
      sections: Object.fromEntries(
        Object.entries(sections).map(([name, items]) => [name, items.length]),
      ),
      deferredSections: ["mermaid", "report"].filter(
        (section) => !Object.hasOwn(sections, section),
      ),
    };
  }
  const retain = (state: RetainedContinuation) => {
    if (
      !state.walk.remaining.length ||
      state.walk.stopReasons.includes("contextChanged")
    )
      return undefined;
    if (retained.size >= 4) {
      const replace = [...retained].find(([, entry]) => !entry.busy);
      if (!replace) return undefined;
      retained.delete(replace[0]);
    }
    const cursor = process.pid + "." + randomUUID();
    retained.set(cursor, state);
    return cursor;
  };
  const continuationOutput = (
    root: TemporalContinuation,
    initial: ContinuationTrace,
    walk: ContinuationWalk,
    mermaid: boolean,
    report: boolean,
  ) => {
    const diagrams =
      report || mermaid ? continuationMermaidPages(root, walk) : [];
    const combined = mergeTemporalContinuationGraph(initial, walk);
    const combinedPages =
      report || mermaid ? combinedTemporalMermaid(combined) : [];
    return {
      continuationWalk: walk,
      temporalContinuationGraph: combined,
      ...(mermaid
        ? {
            ...mermaidOutput("continuationMermaid", diagrams),
            ...mermaidOutput("temporalContinuationMermaid", combinedPages),
          }
        : {}),
      walkReport: report
        ? continuationReport(walk, diagrams, combined, undefined, combinedPages)
        : undefined,
    };
  };
  function pagedTemporal(
    initial: ContinuationTrace,
    format: unknown,
    fullReport: boolean,
    rootReport: () => string,
    continuation?: { root: TemporalContinuation; walk: ContinuationWalk },
  ) {
    const walk = continuation?.walk ?? {
      segments: [],
      links: [],
      remaining: [],
      stopReasons: [],
    };
    const graph = mergeTemporalContinuationGraph(initial, walk);
    return saveGraph(
      temporalGraphSnapshot(graph),
      {
        format,
        fullReport,
        temporal: graph,
        mermaid: () => combinedTemporalMermaid(graph),
        report: (pages) =>
          appendContinuationReport(
            rootReport(),
            continuation &&
              continuationReport(
                walk,
                continuationMermaidPages(continuation.root, walk),
                graph,
                undefined,
                pages(),
              ),
          ),
      },
      continuation?.walk,
    );
  }

  function queryGraph(
    name: string,
    args: Record<string, unknown>,
    operation: AbortSignal,
  ) {
    operation.throwIfAborted();
    const graphCursor = String(args.graphCursor);
    const graph = graphs.get(graphCursor);
    if (!graph)
      throw Error("This trace graph cursor is unavailable. Start a new trace.");
    if (name === "wave_trace_graph_path") {
      const mode = args.mode === "all" ? "all" : "shortest";
      const ids = (args.nodeIds as number[] | undefined) ?? [];
      const selectors = (args.nodeSelectors as unknown[] | undefined) ?? [];
      if (graph.staticTrace) {
        const { graph: parent, direction, bitExpressions } = graph.staticTrace;
        if (selectors.some(isBitPathSelector)) {
          if (ids.length)
            throw Error("Use bit selectors alone for a static bit path.");
          const result = staticBitPaths(
            parent,
            direction,
            selectors,
            mode,
            operation,
            bitExpressions,
          );
          const snapshot = staticGraphSnapshot(result.graph);
          const bitSnapshot = {
            ...snapshot,
            sections: { ...snapshot.sections, bitEdges: result.edges },
          };
          const graphSnapshot = saveGraph(bitSnapshot, {
            format: args.format,
            fullReport: args.detail === "full",
            mermaid: () => staticBitMermaid(result),
            report: (pages) => staticBitReport(result, pages()),
          });
          return {
            graphSnapshot,
            paths: result.paths,
            pathScope: "recordedBits",
            assignmentsWithoutBitMappings: result.assignmentsWithoutBitMappings,
            mode,
            direction,
          };
        }
        const selection = staticTracePaths(
          parent,
          direction,
          ids,
          selectors,
          mode,
          operation,
        );
        const focused = selection.graph;
        const graphSnapshot = saveGraph(staticGraphSnapshot(focused), {
          format: args.format,
          fullReport: args.detail === "full",
          staticTrace: { graph: focused, direction, bitExpressions },
          mermaid: () => mergedStaticMermaid(focused),
          report: (pages) => staticPathReport(selection, direction, pages()),
        });
        return {
          graphSnapshot,
          paths: selection.paths,
          mode,
          direction,
          pathScope: "declaration",
          ...(selection.matches.length ? { matches: selection.matches } : {}),
        };
      }
      if (!graph.temporal)
        throw Error("Select a paged RTL trace graph snapshot.");
      if (selectors.some(isBitPathSelector))
        throw Error(
          "Use the full waveform signal path, including any bit index, for a time graph selector.",
        );
      const { nodeIds, matches } = selectTracePathNodes(
        graph.temporal,
        ids,
        selectors,
        operation,
      );
      const selection = traceGraphPaths(
        graph.temporal,
        nodeIds,
        operation,
        mode,
      );
      const { paths, graph: focused } = selection;
      const graphSnapshot = saveGraph(temporalGraphSnapshot(focused), {
        format: args.format,
        fullReport: args.detail === "full",
        temporal: focused,
        mermaid: () => combinedTemporalMermaid(focused),
        report: (pages) => tracePathReport(selection, pages()),
      });
      return {
        graphSnapshot,
        paths,
        mode: selection.mode,
        ...(matches.length ? { matches } : {}),
      };
    }
    const section = String(args.section);
    const { sections } = graph;
    if (section === "mermaid" || section === "report")
      sections[section] ??= graph[section]();
    if (!Object.hasOwn(sections, section))
      throw Error("This section is unavailable in the graph snapshot.");
    const page = traceGraphPage(
      sections[section],
      Number(args.offset ?? 0),
      Number(args.limit ?? 64),
    );
    return { graphCursor, section, ...page };
  }

  async function resume(
    args: Record<string, unknown>,
    operation: AbortSignal,
    requestProject: TraceRequestProject,
    pagedGraph: boolean,
  ) {
    const cursor = String(args.continuationCursor);
    const state = retained.get(cursor);
    if (!state)
      throw Error(
        "This trace continuation cursor is unavailable. Start a new trace.",
      );
    if (state.busy) throw Error("This trace continuation is already running.");
    const indices = args.frontierIndices as number[] | undefined;
    if (indices !== undefined) {
      if (
        args.followContinuations !== undefined ||
        args.followAllContinuations === true
      )
        throw Error(
          "Choose either frontierIndices or an automatic continuation budget.",
        );
      const { remaining } = state.walk;
      if (
        !Array.isArray(indices) ||
        indices.length < 1 ||
        indices.length > 8 ||
        new Set(indices).size !== indices.length ||
        indices.some(
          (index) =>
            !Number.isSafeInteger(index) ||
            index < 0 ||
            index >= remaining.length,
        )
      )
        throw Error(
          "Choose one to eight distinct indices from the current frontier.",
        );
    }
    const limit = indices?.length ?? continuationLimit(args, 4)!;
    if (
      (state.kind === "static" && args.output === "temporal") ||
      (state.kind === "temporal" && args.output === "graph")
    )
      throw Error(
        "Use the output mode matching the original trace or select report.",
      );
    state.busy = true;
    try {
      await state.assertCurrent();
      operation.throwIfAborted();
      const deadline = AbortSignal.timeout(traceContinuationTimeout);
      const reportOnly = args.output === "report";
      if (state.kind === "static") {
        const walk = await state.run(
          limit,
          operation,
          deadline,
          state.walk.segments,
          requestProject,
          indices?.map((index) => state.walk.remaining[index]),
        );
        await state.assertCurrent();
        operation.throwIfAborted();
        const bitExpressions = pagedGraph ? new Map() : undefined;
        const graph = mergeStaticContinuationGraph(
          state.initial,
          walk,
          bitExpressions,
        );
        const fullReport = reportOnly || args.detail === "full";
        const buildReport = (pages: () => string[]) =>
          appendContinuationReport(
            traceReport(state.initial, state.direction, state.root),
            staticContinuationReport(
              state.direction,
              walk,
              staticContinuationMermaid(state.root, walk),
              pages(),
            ),
          );
        if (pagedGraph) {
          const graphSnapshot = saveGraph(
            staticGraphSnapshot(graph),
            {
              format: args.format,
              fullReport,
              staticTrace: {
                graph,
                direction: state.direction,
                bitExpressions,
              },
              mermaid: () => mergedStaticMermaid(graph),
              report: buildReport,
            },
            walk,
          );
          retained.delete(cursor);
          return {
            output: "paged",
            waveform: state.waveform,
            signal: state.root,
            instance: state.instance,
            direction: state.direction,
            graphSnapshot,
            continuationCursor: retain({
              ...state,
              walk,
              busy: false,
            }),
            continuation: {
              queried: walk.segments.length,
              remaining: walk.remaining.length,
              stopReasons: walk.stopReasons,
            },
          };
        }
        const graphMermaid =
          fullReport || args.format === "mermaid"
            ? mergedStaticMermaid(graph)
            : [];
        const report = fullReport ? buildReport(() => graphMermaid) : undefined;
        const diagrams =
          args.format === "mermaid"
            ? mermaidOutput("staticContinuationGraphMermaid", graphMermaid)
            : undefined;
        retained.delete(cursor);
        return {
          output: reportOnly ? "report" : "graph",
          waveform: state.waveform,
          signal: state.root,
          instance: state.instance,
          direction: state.direction,
          continuationCursor: retain({
            ...state,
            walk,
            busy: false,
          }),
          ...(reportOnly
            ? {
                staticContinuationCoverage: {
                  status: walk.status,
                  stopReasons: walk.stopReasons,
                  remaining: walk.remaining.length,
                },
              }
            : {
                staticContinuationGraph: graph,
                staticContinuationWalk: summarizeStaticWalk(walk),
              }),
          ...diagrams,
          report,
        };
      }
      const walk = await followTemporalFrontier(
        state.root,
        state.initial.context.temporalTrace,
        limit,
        operation,
        deadline,
        (point, abort) => state.query(point, abort, requestProject),
        {
          assertCurrent: state.assertCurrent,
          previous: state.walk.segments,
          defaultHistoryStart: state.defaultHistoryStart,
          selected: indices?.map((index) => state.walk.remaining[index]),
        },
      );
      await state.assertCurrent();
      operation.throwIfAborted();
      if (pagedGraph) {
        const graphSnapshot = pagedTemporal(
          state.initial,
          args.format,
          args.detail === "full",
          state.rootReport,
          { root: state.root, walk },
        );
        retained.delete(cursor);
        return {
          output: "paged",
          waveform: state.waveform,
          signal: state.root.signal,
          tick: state.root.tick,
          liveSessionId: state.root.liveSessionId,
          graphSnapshot,
          continuationCursor: retain({
            ...state,
            walk,
            busy: false,
          }),
          continuation: {
            queried: walk.segments.length,
            remaining: walk.remaining.length,
            stopReasons: walk.stopReasons,
          },
        };
      }
      const { walkReport, ...output } = continuationOutput(
        state.root,
        state.initial,
        walk,
        args.format === "mermaid",
        reportOnly || args.detail === "full",
      );
      retained.delete(cursor);
      const continuationCursor = retain({
        ...state,
        walk,
        busy: false,
      });
      return {
        output: reportOnly ? "report" : "temporal",
        waveform: state.waveform,
        signal: state.root.signal,
        tick: state.root.tick,
        liveSessionId: state.root.liveSessionId,
        continuationCursor,
        ...(reportOnly
          ? {
              temporalCoverage: output.temporalContinuationGraph.coverage,
              continuationStopReasons: walk.stopReasons,
            }
          : output),
        ...(walkReport
          ? {
              report: appendContinuationReport(state.rootReport(), walkReport),
            }
          : {}),
        ...(reportOnly && args.format === "mermaid"
          ? {
              continuationMermaid: output.continuationMermaid,
              continuationMermaidPages: output.continuationMermaidPages,
              temporalContinuationMermaid: output.temporalContinuationMermaid,
              temporalContinuationMermaidPages:
                output.temporalContinuationMermaidPages,
            }
          : {}),
      };
    } catch (error) {
      if (error instanceof TraceContextChanged) retained.delete(cursor);
      throw error;
    } finally {
      state.busy = false;
    }
  }

  return {
    saveGraph,
    retain,
    continuationOutput,
    pagedTemporal,
    queryGraph,
    resume,
  };
}

export type TraceGraphs = ReturnType<typeof createTraceGraphs>;
