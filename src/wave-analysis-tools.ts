// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

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
import type { AnalysisContext } from "./wave-analysis-context";
import type { AnalysisDesign } from "./wave-analysis-design";
import { createTraceGraphs } from "./wave-analysis-graphs";
import { createTraceTool } from "./wave-analysis-trace-tool";

export function createAnalysisTools<V extends AnalysisView>(
  host: TraceHost,
  getLive: GetLiveTrace,
  projects: AnalysisProjects<V>,
  bindings: AnalysisBindings<V>,
  evidence: AnalysisContext<V>,
  design: AnalysisDesign<V>,
  workspace: string,
  findView: (waveform?: unknown) => V | undefined,
  ensureDesign: (viewer: V) => Promise<unknown> = async () => {},
) {
  const graphs = createTraceGraphs();
  const queryTraceTool = createTraceTool(
    host,
    getLive,
    projects,
    bindings,
    evidence,
    graphs,
    workspace,
  );
  async function request(
    name: string,
    args: Record<string, unknown>,
    operation: AbortSignal,
    requestProject: TraceRequestProject,
  ): Promise<unknown> {
    const viewer = findView(args.waveform);
    const pagedGraph =
      args.output === "paged" ||
      (args.output === undefined && args.followAllContinuations === true);
    if (
      pagedGraph &&
      (args.pageSize !== undefined || args.pageCursor !== undefined)
    )
      throw Error(
        "Paged graph output uses wave_trace_graph_page for page bounds.",
      );
    if (name === "wave_trace_graph_page" || name === "wave_trace_graph_path")
      return graphs.queryGraph(name, args, operation);
    if (name === "wave_trace_resume")
      return graphs.resume(args, operation, requestProject, pagedGraph);
    if (name === "wave_execution_trace")
      return design.readExecutionTrace(workspace, viewer, args, operation);
    if (!viewer) throw Error("Open a waveform first");
    await ensureDesign(viewer);
    if (
      name === "wave_source" ||
      name === "wave_module_schematic" ||
      name === "wave_schematic" ||
      name === "wave_execution_map"
    )
      return design.queryDesign(workspace, viewer, name, args, operation);
    if (
      name === "wave_trace_drivers" ||
      name === "wave_trace_loads" ||
      name === "wave_trace_context" ||
      name === "wave_live_trace"
    )
      return queryTraceTool(
        name,
        args,
        viewer,
        operation,
        requestProject,
        pagedGraph,
        request,
      );
    throw Error("Unknown RTL analysis tool: " + name);
  }
  return async (
    name: string,
    args: Record<string, unknown>,
    operation: AbortSignal,
  ) => {
    const requestProject: TraceRequestProject = {};
    try {
      return await request(name, args, operation, requestProject);
    } finally {
      await Promise.all(
        [requestProject.pending, requestProject.build?.pending].map((pending) =>
          pending?.then(
            ({ session }) => session.dispose(),
            () => undefined,
          ),
        ),
      );
    }
  };
}

export function isAnalysisTool(name: string) {
  return (
    name.startsWith("wave_trace_") ||
    [
      "wave_schematic",
      "wave_module_schematic",
      "wave_source",
      "wave_execution_map",
      "wave_execution_trace",
      "wave_live_trace",
    ].includes(name)
  );
}
