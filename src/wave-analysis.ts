// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type {
  AnalysisView,
  GetLiveTrace,
  SelectTraceProject,
  TraceHost,
} from "./wave-analysis-types";
import type { TrackTask } from "./wave-extension-types";
import { createAnalysisProjects } from "./wave-analysis-projects";
import { createAnalysisBindings } from "./wave-analysis-bindings";
import { createAnalysisObservations } from "./wave-analysis-observations";
import { createAnalysisContext } from "./wave-analysis-context";
import { createAnalysisDesign } from "./wave-analysis-design";
import { createAnalysisTools } from "./wave-analysis-tools";
import {
  traceExecutionComparisonReport,
  liveTraceReport,
} from "./wave-analysis-reports";

export type { TraceHost } from "./wave-analysis-types";
export { isAnalysisTool } from "./wave-analysis-tools";

export function createWaveAnalysis<V extends AnalysisView>(
  host: TraceHost,
  traceProjectSelection: SelectTraceProject<V>,
  getLive: GetLiveTrace,
  trackTask: TrackTask,
) {
  const projects = createAnalysisProjects(
    host,
    traceProjectSelection,
    getLive,
    trackTask,
  );
  const bindings = createAnalysisBindings(host, projects);
  const observations = createAnalysisObservations(host, getLive, bindings);
  const evidence = createAnalysisContext(host, getLive, bindings, observations);
  const design = createAnalysisDesign(
    host,
    traceProjectSelection,
    projects,
    bindings,
  );

  return {
    traceRtlPosition: projects.traceRtlPosition,
    openTraceBuildProject: projects.openTraceBuildProject,
    readSimulationTrace: projects.readSimulationTrace,
    openSimulationTrace: projects.openSimulationTrace,
    traceWaveSignal: projects.traceWaveSignal,
    createContinuationGuard: projects.createContinuationGuard,
    createStaticWalk: bindings.createStaticWalk,
    bindTraceObservations: bindings.bindTraceObservations,
    bindStaticFrontier: bindings.bindStaticFrontier,
    focusWaveTrace: bindings.focusWaveTrace,
    traceWaveContext: evidence.traceWaveContext,
    verifyWaveTrace: evidence.verifyWaveTrace,
    traceExecutionComparisonReport,
    traceLiveContext: evidence.traceLiveContext,
    liveTraceReport,
    queryWaveSchematic: design.queryWaveSchematic,
    moduleSchematicReader: design.moduleSchematicReader,
    sourceLocation: design.sourceLocation,
    dumpScope: projects.dumpScope,
    dropTraceProject: projects.dropTraceProject,
    tools: (
      workspace: string,
      findView: (waveform?: unknown) => V | undefined,
      ensureDesign?: (viewer: V) => Promise<unknown>,
    ) =>
      createAnalysisTools(
        host,
        getLive,
        projects,
        bindings,
        evidence,
        design,
        workspace,
        findView,
        ensureDesign,
      ),
    dispose: projects.dispose,
  };
}
