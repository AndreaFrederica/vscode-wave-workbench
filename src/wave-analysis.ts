// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { Viewer } from "./viewer";
import type { Signal, Location } from "./shared/protocol";

import type * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { traceSchematic } from "./rtl-schematic";
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
import { kdbModuleSchematic, kdbSchematicRoots } from "./kdb-schematic";
import { fileURLToPath } from "node:url";

import { isFsdb } from "./backend-selection";
import { codeOnly } from "./rtl-selection";

import { type TraceProjectSelection } from "./project";

import {
  findRtlSignals,
  findSignal,
  fsdbGenerateScope,
  kdbGenerateScope,
  readSignalsAt,
} from "./signal-lookup";

import { VerilatorDesign } from "./verilator";

import * as WaveSignal from "./shared/signals";
import { isMissingKdbDeclaration, KdbSession, mapPrefix } from "./kdb";

import {
  appendContinuationReport,
  automaticTraceContinuationLimit,
  declarationColumns,
  declaredSignalName,
  continuationMermaidPages,
  continuationReport,
  combinedTemporalMermaid,
  mergeTemporalContinuationGraph,
  followTemporalFrontier,
  TraceContextChanged,
  observationMermaidPages,
  observationReport,
  queryTrace,
  selectionText,
  staticTraceCoverage,
  isStaticBudgetStop,
  traceSignalScope,
  staticTracePage,
  temporalMermaidOutput,
  temporalContinuationHistoryStart,
  temporalTraceReferences,
  temporalWaveformSignals,
  packedStructPorts,
  traceFeedback,
  traceContinuationTimeout,
  traceMermaidPages,
  traceReport,
  UnresolvedTraceSignal,
  type TraceDirection,
  type TraceOptions,
  type VideTrace,
  type VideAnalysisApi,
  type VideTraceProject,
  type ContinuationTrace,
  type ContinuationWalk,
  type TemporalContinuation,
} from "./rtl-trace";
import {
  followStaticFrontier,
  mergeStaticContinuationGraph,
  mergedStaticMermaid,
  pageStaticContinuationGraph,
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
import {
  readTraceObservations,
  tracePackedSelection,
} from "./rtl-trace-observations";
import { focusPackedTrace, hasPackedSelection } from "./rtl-trace-bits";
import {
  discoverVcsRebuild,
  readSimulationFilelist,
  simulationFilelistsCurrent,
  simulationInputFingerprint,
  traceVideManifest,
  type ElaboratedLibrarySources,
} from "./vide-project-config";
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
  type TraceBindingIssue,
} from "./rtl-trace-candidates";
import {
  bindModuleGenerateBranches,
  expandInstanceTrace,
  seedModportAlias,
  type TracePortQuery,
} from "./rtl-trace-instances";
import {
  annotateRecordedValueChanges,
  attachRecordedTaskTransfers,
  reconcileRecordedWordHistory,
  correlateExecutionTransitions,
  executionAssignmentReport,
  executionMermaidPages,
  executionEventLines,
  ExecutionRecordingIdentityError,
  executionReport,
  executionTransitionReport,
  linkExecutionAssignments,
  matchRecordedModportComponents,
  preserveDumpedTransitionEvidence,
  readExecutionEvidence,
  readExecutionEvidenceBatch,
  reachedWriteEvents,
  recordedCursorWrite,
  recordedOperandHistory,
  recordedWriters,
  restoreRecordedSignalHistory,
  vcsExecutionStatements,
} from "./rtl-execution";
import { mermaidMarkdown, mermaidOutput } from "./trace-mermaid";
import {
  LIVE_EXECUTION_BUFFER_LIMIT,
  LiveTraceSession,
  matchLiveExecution,
} from "./rtl-live-trace";

import {
  readAdjacentTraceBuildManifest,
  readTraceBuildManifest,
  vcsPliExecutionGap,
  verilatorArtifactMismatches,
  verifyLiveTraceBuild,
  verifyTraceBuild,
  type TraceBuildManifest,
} from "./rtl-build-verification";

type AnalysisView = Pick<
  Viewer,
  "uri" | "disposed" | "backend" | "meta" | "kdb"
> &
  Partial<Pick<Viewer, "backendKind">> & { ready: Promise<unknown> };

export interface TraceHost {
  file(filename: string): vscode.Uri;
  position(line: number, character: number): vscode.Position;
  cancellation(): vscode.CancellationTokenSource;
  getVide(): PromiseLike<VideAnalysisApi | undefined>;
  workspace: {
    getConfiguration(
      section: string,
      uri?: vscode.Uri,
    ): Pick<vscode.WorkspaceConfiguration, "get">;
    openTextDocument(
      uri: vscode.Uri,
    ): PromiseLike<
      Pick<
        vscode.TextDocument,
        "uri" | "lineCount" | "lineAt" | "isDirty" | "version"
      >
    >;
    readonly textDocuments: ReadonlyArray<
      Pick<vscode.TextDocument, "uri" | "isDirty" | "version" | "getText">
    >;
  };
}

export function createWaveAnalysis<V extends AnalysisView>(
  host: TraceHost,
  traceProjectSelection: (
    viewer: V,
  ) => TraceProjectSelection | null | undefined,
  getLive: () => LiveTraceSession | undefined,
  trackTask: <T>(
    label: string,
    waveform: string,
    run: () => Promise<T>,
  ) => Promise<T>,
) {
  const traceProjects = new Map<V, ReturnType<typeof openSimulationTrace>>();
  type TraceRequestProject = {
    pending?: ReturnType<typeof openSimulationTrace>;
    build?: {
      identity: string;
      traces: Map<string, Awaited<ReturnType<typeof traceWithProject>>>;
      pending: Promise<{
        session: VideTraceProject;
        inputs: Awaited<ReturnType<typeof simulationInputFingerprint>>[];
      }>;
    };
  };
  const portTraceCache = new WeakMap<
    VideTraceProject,
    { revision: string; traces: Map<string, VideTrace> }
  >();
  const dropTraceProject = (viewer: V) => {
    const project = traceProjects.get(viewer);
    traceProjects.delete(viewer);
    void project?.then(
      ({ session }) => session.dispose(),
      () => undefined,
    );
  };
  function dumpScope(viewer: V, scope: string) {
    const mappings =
      host.workspace
        .getConfiguration("waveWorkbench", viewer.uri)
        .get<Record<string, string>>("hierarchyMappings") || {};
    return mapPrefix(
      scope,
      Object.fromEntries(
        Object.entries(mappings).map(([dump, kdb]) => [kdb, dump]),
      ),
    );
  }
  async function traceRtlPosition(
    direction: TraceDirection,
    uri: vscode.Uri,
    position: vscode.Position,
    options?: TraceOptions,
    token?: vscode.CancellationToken,
    project?: VideTraceProject,
  ) {
    const params = {
      textDocument: { uri: uri.toString() },
      position: { line: position.line, character: position.character },
      options,
    };
    if (project) {
      return queryTrace(
        { version: 1, capabilities: { staticTraceVersion: 1 }, ...project },
        direction,
        params,
        token,
      );
    }
    return queryTrace(await host.getVide(), direction, params, token);
  }

  async function openVideTraceProject(
    config: Parameters<typeof traceVideManifest>[0],
  ) {
    const api = await host.getVide();
    if (!api?.openTraceProject)
      throw Error(
        "The active VIDE extension needs simulation project support.",
      );
    return api.openTraceProject(traceVideManifest(config));
  }

  function openTraceBuildProject(buildManifest: TraceBuildManifest) {
    return openVideTraceProject({
      sources: buildManifest.roots.map((path) => ({ path })),
      compilationUnits: buildManifest.compilation_units,
      compilationUnitOptions: buildManifest.compilation_unit_options,
      sourceLibraries: buildManifest.source_libraries,
      libraryMaps: buildManifest.library_maps,
      libraryFiles: (buildManifest.library_files ?? []).map((path) => ({
        path,
      })),
      includeDirectories: buildManifest.include_dirs,
      defines: buildManifest.defines,
      topModules: buildManifest.top_modules,
      parameterOverrides: buildManifest.parameter_overrides ?? [],
      defaultTimescale: buildManifest.default_timescale,
      externalSystemCalls: [
        ...new Set(buildManifest.vcs_pli?.flatMap(({ calls }) => calls ?? [])),
      ],
    });
  }

  type SimulationFilelistSelection =
    | Extract<TraceProjectSelection, { filelist: string }>
    | NonNullable<Awaited<ReturnType<typeof discoverVcsRebuild>>>;

  async function readSimulationTrace(
    selection: SimulationFilelistSelection,
    viewer?: V,
    design = viewer?.kdb,
  ) {
    const sourceMappings = host.workspace
      .getConfiguration("waveWorkbench", viewer?.uri)
      .get<Record<string, string>>("sourcePathMappings");
    let librarySources: ElaboratedLibrarySources | undefined;
    if (design instanceof VerilatorDesign || design instanceof KdbSession) {
      const files = () =>
        design instanceof VerilatorDesign
          ? design.librarySourceFiles
          : design.moduleSourceFiles();
      librarySources = {
        kind: design.kind,
        files: async () =>
          (await files()).map((file) =>
            path.resolve(
              design.kind === "kdb"
                ? selection.workingDirectory
                : path.dirname(design.path),
              mapPrefix(file, sourceMappings),
            ),
          ),
      };
    }
    return readSimulationFilelist(
      selection.filelist,
      selection.workingDirectory,
      librarySources,
      "rebuild" in selection ? selection.rebuild : undefined,
    );
  }

  async function openSimulationTrace(
    selection:
      | Extract<TraceProjectSelection, { videManifest: string }>
      | SimulationFilelistSelection,
    viewer?: V,
    design = viewer?.kdb,
  ) {
    if ("videManifest" in selection) {
      const api = await host.getVide();
      if (!api?.openTraceProjectFile)
        throw Error(
          "The active VIDE extension needs existing trace project support.",
        );
      return {
        session: await api.openTraceProjectFile(selection.videManifest),
        projectInfo: {
          ...selection,
          workingDirectory: path.dirname(selection.videManifest),
          limitations: [],
        },
        inputs: [],
        design,
      };
    }
    const manifest = await readSimulationTrace(selection, viewer, design);
    if (!manifest.sources.length && !manifest.libraryFiles.length)
      throw Error("The filelist contains no RTL sources.");
    if (
      "rebuild" in selection &&
      ![...manifest.sources, ...manifest.libraryFiles].some(
        ({ sha256 }) => sha256,
      )
    )
      throw Error("VCS rebuild metadata points to unavailable source files.");
    return {
      session: await openVideTraceProject(manifest),
      projectInfo: {
        filelist: selection.filelist,
        workingDirectory: selection.workingDirectory,
        ...("rebuild" in selection ? { vcsRebuild: true } : {}),
        limitations: manifest.vcsPli?.length
          ? [...manifest.unsupported, vcsPliExecutionGap]
          : manifest.unsupported,
        ...(manifest.vcsPli?.length ? { vcsPli: manifest.vcsPli } : {}),
        unverifiedVcsParameterPaths: manifest.unverifiedVcsParameterPaths,
        ...(manifest.libraryMaps ? { libraryMaps: manifest.libraryMaps } : {}),
        ...(design &&
        design.kind !== "vendor-hdl" &&
        manifest.resolvedLibraryFiles.length
          ? {
              resolvedLibraryFiles: {
                design: design.path,
                kind: design.kind,
                files: manifest.resolvedLibraryFiles,
              },
            }
          : {}),
      },
      inputs: [...manifest.filelists, ...manifest.sourceFingerprints],
      design,
    };
  }

  async function traceWaveSignal(
    viewer: V,
    direction: TraceDirection,
    fullname: string,
    options: TraceOptions,
    token?: vscode.CancellationToken,
    override?: TraceProjectSelection,
    buildManifest?: TraceBuildManifest,
    requestProject?: TraceRequestProject,
  ) {
    return trackTask(
      direction === "drivers" ? "追踪驱动" : "追踪负载",
      viewer.uri.fsPath,
      () =>
        resolveTraceWaveSignal(
          viewer,
          direction,
          fullname,
          options,
          token,
          override,
          buildManifest,
          requestProject,
        ),
    );
  }

  async function resolveTraceWaveSignal(
    viewer: V,
    direction: TraceDirection,
    fullname: string,
    options: TraceOptions,
    token?: vscode.CancellationToken,
    override?: TraceProjectSelection,
    buildManifest?: TraceBuildManifest,
    requestProject?: TraceRequestProject,
  ) {
    await viewer.ready;
    if (token?.isCancellationRequested)
      throw Error("The RTL trace was cancelled.");
    const configuredSelection = traceProjectSelection(viewer);
    const configuredIdentity = JSON.stringify(configuredSelection);
    const design = viewer.kdb;
    const backend = viewer.backend;
    const selectionCurrent = () =>
      !viewer.disposed &&
      viewer.backend === backend &&
      viewer.kdb === design &&
      configuredIdentity === JSON.stringify(traceProjectSelection(viewer));
    let selection:
      | TraceProjectSelection
      | Awaited<ReturnType<typeof discoverVcsRebuild>>
      | null = override ?? configuredSelection;
    if (selection === undefined) {
      buildManifest ??= await readAdjacentTraceBuildManifest(viewer.uri.fsPath);
      if (!buildManifest && viewer.kdb?.kind === "kdb")
        selection = await discoverVcsRebuild(viewer.kdb.path);
    } else if (selection && !buildManifest) {
      // An explicit compilation project also provides a recovery path for an invalid sidecar.
      buildManifest = await readAdjacentTraceBuildManifest(
        viewer.uri.fsPath,
      ).catch(() => undefined);
    }
    if (!selection) {
      if (
        !buildManifest?.roots.length &&
        !buildManifest?.library_files?.length
      ) {
        const result = await traceWithProject(
          viewer,
          direction,
          fullname,
          options,
          token,
          undefined,
          buildManifest,
        );
        return { ...result, buildManifest };
      }
      let scoped = requestProject?.build;
      if (requestProject) {
        const identity = JSON.stringify(buildManifest);
        if (scoped && scoped.identity !== identity)
          throw new TraceContextChanged(
            "The trace build manifest changed during continuation.",
          );
        scoped ??= requestProject.build = {
          identity,
          traces: new Map(),
          pending: (async () => {
            const manifest = buildManifest;
            const files = new Set([
              viewer.uri.fsPath,
              manifest.filename,
              ...manifest.roots,
              ...manifest.files.map(({ path }) => path),
              ...manifest.include_dirs,
              ...(manifest.library_files ?? []),
              ...(manifest.library_maps ?? []),
              ...(manifest.compilation_unit_options ?? []).flatMap(
                ({ include_dirs }) => include_dirs ?? [],
              ),
            ]);
            const inputs = await Promise.all(
              [...files].map(simulationInputFingerprint),
            );
            return { session: await openTraceBuildProject(manifest), inputs };
          })(),
        };
      }
      const batch = await scoped?.pending;
      const project =
        batch?.session ?? (await openTraceBuildProject(buildManifest));
      const validateBatch = async () => {
        if (
          batch &&
          (project.closed ||
            !selectionCurrent() ||
            !(await simulationFilelistsCurrent(batch.inputs)) ||
            !selectionCurrent())
        )
          throw new TraceContextChanged(
            "The trace build inputs changed during continuation.",
          );
      };
      try {
        await validateBatch();
        // The enclosing batch validates the same build and can revisit a
        // signal at several ticks. Only its RTL trace is shared across ticks.
        const key = JSON.stringify([direction, fullname, options]);
        let result = scoped?.traces.get(key);
        if (!result) {
          if (batch) portTraceCache.delete(project);
          result = await traceWithProject(
            viewer,
            direction,
            fullname,
            { ...options, includeCompilation: true },
            token,
            project,
            buildManifest,
          );
        }
        await validateBatch();
        if (token?.isCancellationRequested)
          throw Error("The RTL trace was cancelled.");
        scoped?.traces.set(key, result);
        return {
          ...result,
          buildManifest,
          trace: {
            ...result.trace,
            simulationProject: {
              buildManifest: buildManifest.filename,
              workingDirectory: path.dirname(buildManifest.filename),
              limitations: [
                ...(buildManifest.unsupported ?? []),
                ...(buildManifest.vcs_pli?.length ? [vcsPliExecutionGap] : []),
              ],
              ...(buildManifest.vcs_pli?.length
                ? {
                    vcsPli: buildManifest.vcs_pli.map(({ table, library }) => ({
                      table: table.path,
                      library: library?.path,
                    })),
                  }
                : {}),
            },
          },
        };
      } finally {
        if (!batch) project.dispose();
      }
    }
    if (!override && !selectionCurrent())
      throw Error(
        "The simulation filelist selection changed during the trace query.",
      );
    const rebuild = "rebuild" in selection ? selection.rebuild : undefined;
    // Each MCP batch owns its explicit filelist session. A resumed batch opens
    // a new session after validating the retained trace's input fingerprints.
    const scopedProject =
      override && "filelist" in override ? requestProject : undefined;
    const reused = scopedProject?.pending;
    let pending = override ? reused : traceProjects.get(viewer);
    if (!pending) {
      pending = openSimulationTrace(selection, viewer);
      if (scopedProject) scopedProject.pending = pending;
      else if (!override) traceProjects.set(viewer, pending);
    }
    try {
      let project: Awaited<ReturnType<typeof openSimulationTrace>>;
      for (;;) {
        try {
          project = await pending;
        } catch (error) {
          if (
            !rebuild ||
            !("filelist" in selection) ||
            token?.isCancellationRequested
          )
            throw error;
          if (
            !(await simulationFilelistsCurrent(rebuild.inputs)) ||
            !selectionCurrent()
          )
            throw Error(
              "The simulation inputs changed during the trace query.",
            );
          if (traceProjects.get(viewer) === pending) dropTraceProject(viewer);
          const result = await traceWithProject(
            viewer,
            direction,
            fullname,
            options,
            token,
          );
          if (
            !(await simulationFilelistsCurrent(rebuild.inputs)) ||
            !selectionCurrent()
          )
            throw Error(
              "The simulation inputs changed during the trace query.",
            );
          result.trace.simulationProject = {
            filelist: selection.filelist,
            workingDirectory: selection.workingDirectory,
            vcsRebuild: true,
            limitations: [
              error instanceof Error ? error.message : String(error),
            ],
          };
          return { ...result, buildManifest, simulationInputs: rebuild.inputs };
        }
        if (override) {
          if (scopedProject && pending === reused) {
            if (!(await simulationFilelistsCurrent(project.inputs)))
              throw new TraceContextChanged(
                "The simulation filelist or RTL changed during continuation.",
              );
            if (project.session.closed) {
              pending = openSimulationTrace(selection, viewer);
              scopedProject.pending = pending;
              continue;
            }
          }
          break;
        }
        if (token?.isCancellationRequested)
          throw Error("The RTL trace was cancelled.");
        const current = await simulationFilelistsCurrent(project.inputs);
        const latest = traceProjects.get(viewer);
        if (!latest || !selectionCurrent())
          throw Error(
            "The simulation filelist selection changed during the trace query.",
          );
        if (latest !== pending) {
          pending = latest;
          continue;
        }
        if (
          current &&
          !project.session.closed &&
          ("filelist" in selection
            ? "filelist" in project.projectInfo &&
              project.projectInfo.filelist === selection.filelist &&
              project.projectInfo.workingDirectory ===
                selection.workingDirectory
            : "videManifest" in project.projectInfo &&
              project.projectInfo.videManifest === selection.videManifest) &&
          project.design === viewer.kdb
        )
          break;
        if (rebuild) {
          if (
            !(await simulationFilelistsCurrent(rebuild.inputs)) ||
            !selectionCurrent()
          )
            throw Error(
              "The simulation inputs changed during the trace query.",
            );
          const refreshed = traceProjects.get(viewer);
          if (refreshed !== pending) {
            if (!refreshed)
              throw Error(
                "The simulation filelist selection changed during the trace query.",
              );
            pending = refreshed;
            continue;
          }
        }
        dropTraceProject(viewer);
        pending = openSimulationTrace(selection, viewer);
        traceProjects.set(viewer, pending);
      }
      if (project.design !== viewer.kdb)
        throw Error("The waveform design changed during the trace query.");
      // Keep port lookups local to each segment of an explicit filelist trace.
      if (scopedProject) portTraceCache.delete(project.session);
      const result = await traceWithProject(
        viewer,
        direction,
        fullname,
        { ...options, includeCompilation: true },
        token,
        project.session,
        buildManifest,
        "unverifiedVcsParameterPaths" in project.projectInfo &&
          Boolean(project.projectInfo.unverifiedVcsParameterPaths?.length),
      );
      if (
        !(await simulationFilelistsCurrent(project.inputs)) ||
        (!override &&
          (traceProjects.get(viewer) !== pending || !selectionCurrent())) ||
        project.design !== viewer.kdb
      ) {
        const message = "The simulation inputs changed during the trace query.";
        if (scopedProject) throw new TraceContextChanged(message);
        throw Error(message);
      }
      result.trace.simulationProject = project.projectInfo;
      return { ...result, buildManifest, simulationInputs: project.inputs };
    } catch (error) {
      if (
        !override &&
        !token?.isCancellationRequested &&
        traceProjects.get(viewer) === pending
      )
        dropTraceProject(viewer);
      throw error;
    } finally {
      if (override && !scopedProject)
        void pending.then(
          ({ session }) => session.dispose(),
          () => undefined,
        );
    }
  }

  async function createContinuationGuard(
    viewer: V,
    result: Awaited<ReturnType<typeof traceWaveSignal>>,
    live: LiveTraceSession | undefined,
    executionFile?: string,
    retainCheckpoint = false,
  ) {
    const backend = viewer.backend;
    const project = traceProjects.get(viewer);
    const selection = JSON.stringify(traceProjectSelection(viewer));
    const mappingIdentity = () => {
      const config = host.workspace.getConfiguration(
        "waveWorkbench",
        viewer.uri,
      );
      return JSON.stringify([
        config.get("hierarchyMappings"),
        config.get("sourcePathMappings"),
      ]);
    };
    const mappings = mappingIdentity();
    const inputs = new Map(
      "simulationInputs" in result
        ? result.simulationInputs.map((input) => [input.path, input] as const)
        : [],
    );
    const files = new Set([
      viewer.uri.fsPath,
      result.buildManifest?.filename ?? viewer.uri.fsPath + ".wave-build.json",
      ...(result.trace.compilation?.files
        .filter((uri) => uri.startsWith("file:"))
        .map((uri) => fileURLToPath(uri)) ?? []),
      ...(result.trace.compilation?.libraryMaps
        ?.filter((uri) => uri.startsWith("file:"))
        .map((uri) => fileURLToPath(uri)) ?? []),
      ...(result.buildManifest?.files.map(({ path }) => path) ?? []),
      ...(result.buildManifest?.vcs_pli?.flatMap(({ table, library }) =>
        library ? [table.path, library.path] : [table.path],
      ) ?? []),
    ]);
    if (result.buildManifest?.vcs_trace_library)
      files.add(result.buildManifest.vcs_trace_library.path);
    if (executionFile) files.add(executionFile);
    const projectInfo = result.trace.simulationProject;
    if (projectInfo && "videManifest" in projectInfo)
      files.add(projectInfo.videManifest);
    const design = result.design;
    if (retainCheckpoint && design && !live) {
      files.add(design.path);
      if (design.kind === "verilator")
        files.add(design.path.replace(/\.json$/i, ".meta.json"));
      if (design.kind === "kdb") {
        const database = path.join(design.path, "kdb.elab++");
        files.add(path.join(design.path, "simv.kdb"));
        files.add(path.join(design.path, "vcs_rebuild"));
        files.add(database);
        const addDesignFiles = async (directory: string) => {
          const entries = await fs.promises.readdir(directory, {
            withFileTypes: true,
          });
          for (const entry of entries) {
            const filename = path.join(directory, entry.name);
            files.add(filename);
            if (entry.isDirectory()) await addDesignFiles(filename);
          }
        };
        if (fs.existsSync(database)) await addDesignFiles(database);
      }
    }
    const openEdits = () =>
      JSON.stringify(
        host.workspace.textDocuments
          .filter(
            (document) =>
              document.isDirty &&
              document.uri.scheme === "file" &&
              (files.has(document.uri.fsPath) ||
                inputs.has(document.uri.fsPath)),
          )
          .map((document) => [document.uri.fsPath, document.version])
          .sort(),
      );
    const edits = openEdits();
    for (const input of await Promise.all(
      [...files]
        .filter((file) => !inputs.has(file))
        .map(simulationInputFingerprint),
    ))
      inputs.set(input.path, input);
    const fingerprints = [...inputs.values()];
    const current = () =>
      !viewer.disposed &&
      viewer.backend === backend &&
      viewer.kdb === result.design &&
      (!live || live === getLive()) &&
      project === traceProjects.get(viewer) &&
      selection === JSON.stringify(traceProjectSelection(viewer)) &&
      mappingIdentity() === mappings &&
      openEdits() === edits;
    const assertCurrent = async () => {
      if (
        !current() ||
        !(await simulationFilelistsCurrent(fingerprints)) ||
        !current()
      )
        throw new TraceContextChanged(
          "The waveform, RTL or simulation context changed during continuation.",
        );
    };
    const checkpoint =
      retainCheckpoint && !live && edits === "[]" && result.trace.compilation
        ? {
            inputs: fingerprints,
            identity: createHash("sha256")
              .update(
                JSON.stringify([
                  viewer.uri.fsPath,
                  viewer.backendKind,
                  design?.kind,
                  design?.path,
                  executionFile,
                  selection,
                  mappings,
                  fingerprints.sort((left, right) =>
                    left.path.localeCompare(right.path),
                  ),
                ]),
              )
              .digest("hex"),
          }
        : undefined;
    return { assertCurrent, checkpoint };
  }

  async function createStaticWalk(
    viewer: V,
    root: string,
    result: Awaited<ReturnType<typeof traceWaveSignal>>,
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

  async function traceWithProject(
    viewer: V,
    direction: TraceDirection,
    fullname: string,
    options: TraceOptions,
    token?: vscode.CancellationToken,
    project?: VideTraceProject,
    buildManifest?: TraceBuildManifest,
    unverifiedVcsParameterPaths = false,
  ) {
    if (token?.isCancellationRequested)
      throw Error("The RTL trace was cancelled.");
    await viewer.ready;
    let signal = await findSignal(viewer.backend, fullname, ".");
    const design = viewer.kdb;
    if (!design) throw Error("Attach a design database to the waveform first.");
    const cfg = host.workspace.getConfiguration("waveWorkbench", viewer.uri);
    const sourcePath = (file: string) =>
      path.resolve(
        path.dirname(design.path),
        mapPrefix(file, cfg.get("sourcePathMappings")),
      );
    const mappedScope = mapPrefix(signal.scope, cfg.get("hierarchyMappings"));
    const scope =
      design.kind === "kdb" ? kdbGenerateScope(mappedScope) : mappedScope;
    const name = declaredSignalName(signal.name);
    let resolveFailure: unknown;
    let record = await design.resolve(scope + "." + name).catch((error) => {
      resolveFailure = error;
      return undefined;
    });
    let compound: Location[] | undefined;
    if (!record || record.kind === "npiMpPort" || record.kind === "npiRefObj") {
      if (design.interfaceMembers) {
        const members = await design
          .interfaceMembers(scope, name)
          .catch((error) => {
            resolveFailure ??= error;
            return [];
          });
        if (members.length > 1) compound = members;
        record = members[0] ?? record;
      } else if (design.interfaceMember) {
        const member = await design
          .interfaceMember(scope, name)
          .catch((error) => {
            resolveFailure ??= error;
            return undefined;
          });
        if (member) record = member;
      }
    }
    if (!record && resolveFailure) throw resolveFailure;
    let declarationName = signal.name;
    if (
      record?.instance &&
      record.fullname.startsWith(record.instance + ".") &&
      (record.fullname !== scope + "." + name ||
        (design.kind === "kdb" &&
          viewer.meta?.backend === "rust-vcd" &&
          record.instance.startsWith(scope + ".")))
    )
      declarationName = record.fullname.slice(record.instance.length + 1);
    if (!record?.file || !Number.isInteger(record.line) || record.line < 1) {
      throw Error("No RTL declaration location for " + fullname);
    }
    let aliasDeclaration:
      | VideTrace["assignments"][number]["location"]
      | undefined;
    let alias = record.interfaceRange;
    if (compound) {
      const width = signal.sourceWidth ?? signal.width;
      const source = record.interfaceDeclaration;
      const partsWidth = compound.reduce(
        (sum, member) => sum + (member.interfaceWidth ?? 0),
        0,
      );
      if (
        !source ||
        width !== partsWidth ||
        compound.some(
          (member) =>
            member.instance !== record.instance ||
            !member.fullname.startsWith(member.instance + ".") ||
            !member.interfaceWidth ||
            member.interfaceDeclaration?.file !== source.file ||
            member.interfaceDeclaration.line !== source.line,
        )
      )
        throw Error(
          "The dumped modport alias does not match its elaborated members: " +
            fullname,
        );
      const document = await host.workspace.openTextDocument(
        host.file(sourcePath(source.file)),
      );
      const line = source.line - 1;
      if (document.isDirty || line < 0 || line >= document.lineCount)
        throw Error("Could not verify the RTL declaration for " + fullname);
      const code = codeOnly(document.lineAt(line).text);
      const columns = declarationColumns(code, name).filter(
        (column) =>
          code.slice(0, column).trimEnd().endsWith(".") &&
          code
            .slice(column + name.length)
            .trimStart()
            .startsWith("("),
      );
      if (columns.length !== 1)
        throw Error(
          "Could not locate the RTL modport declaration for " + fullname,
        );
      aliasDeclaration = {
        uri: document.uri.toString(),
        range: { start: { line, character: columns[0] } },
      };
      alias = [width - 1, 0];
      const packed = tracePackedSelection(signal).range;
      if (packed && (packed[0] !== alias[0] || packed[1] !== alias[1]))
        throw Error(
          "The dumped range does not match the modport alias: " + fullname,
        );
      signal = { ...signal, packedRange: alias };
    } else if (
      alias &&
      alias[0] === alias[1] &&
      signal.width === 1 &&
      signal.bitOffset === undefined &&
      !tracePackedSelection(signal).range
    ) {
      signal = { ...signal, packedRange: alias };
    }
    const genericTypes = new Map<
      string,
      Promise<TraceOptions["genericInterfaces"]>
    >();
    function genericInterfaces(instance: string) {
      let pending = genericTypes.get(instance);
      if (!pending) {
        pending = readGenericInterfaces(instance);
        genericTypes.set(instance, pending);
      }
      return pending;
    }
    async function readGenericInterfaces(instance: string) {
      const types = await design
        .genericInterfaceTypes?.(instance)
        .catch(() => undefined);
      if (!types?.length) return;
      async function position(file: string, oneBased: number, name: string) {
        const uri = host.file(sourcePath(file));
        const document = await host.workspace.openTextDocument(uri).then(
          (document) => document,
          () => undefined,
        );
        const line = oneBased - 1;
        if (
          !document ||
          document.isDirty ||
          line < 0 ||
          line >= document.lineCount
        )
          return;
        const columns = declarationColumns(document.lineAt(line).text, name);
        if (columns.length === 1)
          return {
            textDocument: { uri: uri.toString() },
            position: { line, character: columns[0] },
          };
      }
      const bindings: NonNullable<TraceOptions["genericInterfaces"]> = [];
      for (const type of types) {
        const [formal, actual] = await Promise.all([
          position(type.formalFile, type.formalLine, type.formal),
          position(type.interfaceFile, type.interfaceLine, type.interface),
        ]);
        if (formal && actual)
          bindings.push({ formal, interface: actual, modport: type.modport });
      }
      return bindings.length ? bindings : undefined;
    }
    const file = sourcePath(record.file);
    const document = await host.workspace.openTextDocument(host.file(file));
    if (project && document.isDirty)
      throw Error(
        "Save the RTL declaration before tracing it against a simulation build.",
      );
    const line = record.line - 1;
    if (line >= document.lineCount)
      throw Error("RTL declaration is outside " + file);
    const columns = declarationColumns(
      document.lineAt(line).text,
      declarationName,
    );
    let character: number | undefined;
    let local: VideTrace | undefined;
    for (const column of columns) {
      const candidate = await traceRtlPosition(
        direction,
        document.uri,
        host.position(line, column),
        {
          ...options,
          maxDepth: compound ? 0 : options.maxDepth,
          genericInterfaces: await genericInterfaces(record.instance),
        },
        token,
        project,
      ).catch((error) => {
        if (columns.length > 1 && error instanceof UnresolvedTraceSignal)
          return;
        throw error;
      });
      if (
        candidate &&
        (columns.length === 1 ||
          matchesTraceDeclaration(candidate, document.uri, line, column))
      ) {
        local = candidate;
        character = column;
        break;
      }
    }
    if (!local || character === undefined)
      throw Error("Could not locate the RTL declaration for " + fullname);
    let cache = project && portTraceCache.get(project);
    if (project && cache?.revision !== local.revision) {
      cache = { revision: local.revision, traces: new Map() };
      portTraceCache.set(project, cache);
    }
    let reusedPortTrace = false;
    const designMatches = !verilatorArtifactMismatches(
      buildManifest?.verilatorArtifacts,
      design.verilatorArtifacts,
    ).length;
    const sourceUri = (file: string) => host.file(sourcePath(file)).toString();
    const query: TracePortQuery = async (
      port,
      depth,
      queryDirection = direction,
      site,
    ) => {
      if (
        token?.isCancellationRequested ||
        viewer.disposed ||
        design !== viewer.kdb
      ) {
        throw Error("The waveform trace was cancelled or the design changed.");
      }
      const location =
        site ??
        (await design
          .resolve(port.instance + "." + port.signal)
          .catch((error) => {
            if (!isMissingKdbDeclaration(error)) throw error;
            return undefined;
          }));
      if (
        !location?.file ||
        location.line < 1 ||
        (!("interfacePath" in location) && location.instance !== port.instance)
      )
        return;
      const filename = sourcePath(location.file);
      const doc = await host.workspace
        .openTextDocument(host.file(filename))
        .then(
          (document) => document,
          async (error: unknown) => {
            try {
              await fs.promises.stat(filename);
            } catch (failure) {
              if ((failure as NodeJS.ErrnoException).code === "ENOENT") return;
            }
            throw error;
          },
        );
      if (!doc) return;
      if (project && doc.isDirty)
        throw Error(
          "Save the connected RTL declaration before tracing it against a simulation build.",
        );
      const line = location.line - 1;
      if (line >= doc.lineCount) return;
      const text = doc.lineAt(line).text;
      const interfacePath =
        site && "interfacePath" in site ? site.interfacePath : undefined;
      const [formalElement, member] = interfacePath?.split(".") ?? [];
      const element = formalElement?.match(/\[-?\d+\]$/)?.[0];
      const formal = element
        ? formalElement.slice(0, -element.length)
        : formalElement;
      const interfaceMember = element ? element + "." + member : member;
      const columns =
        site && "column" in site
          ? [
              Buffer.from(text)
                .subarray(0, site.column - 1)
                .toString("utf8").length,
            ]
          : declarationColumns(text, formal ?? port.signal);
      const portOptions = {
        ...options,
        maxDepth: depth,
        interfaceMember,
        interfaceBacking: interfaceMember ? port.signal : undefined,
        genericInterfaces: await genericInterfaces(location.instance),
      };
      for (const column of columns) {
        const position = host.position(line, column);
        const key = JSON.stringify([
          queryDirection,
          doc.uri.toString(),
          doc.version,
          line,
          column,
          portOptions,
        ]);
        let result = cache?.traces.get(key);
        if (result) {
          reusedPortTrace = true;
        } else {
          try {
            result = await traceRtlPosition(
              queryDirection,
              doc.uri,
              position,
              portOptions,
              token,
              project,
            );
          } catch (error) {
            if (
              (interfaceMember || columns.length > 1) &&
              error instanceof UnresolvedTraceSignal
            )
              continue;
            throw error;
          }
          if (cache && result.revision === cache.revision) {
            if (cache.traces.size >= 128) {
              const oldest = cache.traces.keys().next();
              if (!oldest.done) cache.traces.delete(oldest.value);
            }
            cache.traces.set(key, result);
          }
        }
        if (
          result.signals.find(({ id }) => id === result.root)?.name ===
            port.signal &&
          (site ||
            columns.length === 1 ||
            matchesTraceDeclaration(result, doc.uri, line, column))
        )
          return result;
      }
    };
    const instance = compound ? scope : record.instance;
    const initial =
      compound && aliasDeclaration
        ? await seedModportAlias(
            local,
            { instance, signal: name },
            aliasDeclaration,
            compound,
            direction,
            options,
            sourceUri,
            query,
          )
        : local;
    const element = /^(.*)\[\s*(-?\d+)\s*\]$/.exec(name);
    const rootName = initial.signals.find(
      ({ id }) => id === initial.root,
    )?.name;
    const elementIndex =
      element?.[1] === rootName && element ? Number(element[2]) : undefined;
    const trace = await expandInstanceTrace(
      initial,
      instance,
      design,
      direction,
      options,
      sourceUri,
      query,
      design.kind === "kdb" && unverifiedVcsParameterPaths
        ? "unverifiedVcsParameterPath"
        : designMatches,
      elementIndex !== undefined && Number.isSafeInteger(elementIndex)
        ? elementIndex
        : undefined,
    );
    if (
      record.packedRange &&
      !alias &&
      designMatches &&
      !unverifiedVcsParameterPaths &&
      !document.isDirty &&
      matchesTraceDeclaration(local, document.uri, line, character)
    ) {
      const root = trace.signals.find(({ id }) => id === trace.root);
      if (root && !root.packedRange) root.packedRange = record.packedRange;
    }
    if (reusedPortTrace) {
      const current = await traceRtlPosition(
        direction,
        document.uri,
        host.position(line, character),
        { maxDepth: 0 },
        token,
        project,
      );
      if (current.revision !== local.revision)
        throw Error("RTL changed during the instance trace.");
    }
    if (
      token?.isCancellationRequested ||
      viewer.disposed ||
      design !== viewer.kdb
    ) {
      throw Error("The waveform design changed during the trace query.");
    }
    return {
      trace,
      instance,
      signal,
      design,
      interfaceRange: alias,
      analysisProject: project,
    };
  }

  function matchesTraceDeclaration(
    trace: VideTrace,
    uri: vscode.Uri,
    line: number,
    character: number,
  ) {
    const declaration = trace.signals.find(
      ({ id }) => id === trace.root,
    )?.declaration;
    return (
      declaration?.uri === uri.toString() &&
      declaration.range.start.line === line &&
      declaration.range.start.character === character
    );
  }

  async function bindTraceObservations(
    viewer: V,
    result: Pick<
      Awaited<ReturnType<typeof traceWaveSignal>>,
      "instance" | "design" | "signal"
    > & {
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
        const { matches } = await viewer.backend.request("matchNames", {
          query: matchVcdPaths ? "" : dump,
          names: matchVcdPaths ? names.map((name) => dump + "." + name) : names,
        });
        const aliasNames =
          matchVcdPaths || alias === dump
            ? []
            : names.filter((name) => !Object.hasOwn(matches, name));
        const aliases = aliasNames.length
          ? (
              await viewer.backend.request("matchNames", {
                query: alias,
                names: aliasNames,
              })
            ).matches
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
    result: Awaited<ReturnType<typeof traceWaveSignal>>,
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
    result: Awaited<ReturnType<typeof traceWaveSignal>>,
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
    result: Awaited<ReturnType<typeof traceWaveSignal>>,
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

  async function traceWaveContext(
    viewer: V,
    result: Awaited<ReturnType<typeof traceWaveSignal>>,
    tick: string,
    historyStart?: string,
    verification?: Awaited<ReturnType<typeof verifyTraceBuild>>,
    bindingResult?: Awaited<ReturnType<typeof bindTraceObservations>>,
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

  async function traceObservedContext(
    viewer: V,
    result: Awaited<ReturnType<typeof traceWaveSignal>>,
    evidence: Awaited<ReturnType<typeof readTraceObservations>>,
    {
      bindings,
      issues,
      packedRanges,
    }: Awaited<ReturnType<typeof bindTraceObservations>>,
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
  function verifyWaveTrace(
    viewer: V,
    result: Awaited<ReturnType<typeof traceWaveSignal>>,
  ) {
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

  function traceExecutionComparisonReport(
    evidence:
      | Pick<
          Awaited<ReturnType<typeof traceObservedContext>>,
          "executionAssignments" | "executionTransitions" | "upstreamExecution"
        >
      | undefined,
    events: Awaited<ReturnType<typeof readExecutionEvidence>>["events"] = [],
  ) {
    const { executionAssignments, executionTransitions, upstreamExecution } =
      evidence ?? {};
    let report = "";
    if (executionAssignments?.length)
      report += executionAssignmentReport(executionAssignments);
    if (executionTransitions?.length)
      report += executionTransitionReport(executionTransitions);
    for (const { transitions, instance, signal, bit } of upstreamExecution ??
      [])
      report += executionTransitionReport(
        transitions,
        instance + "." + signal + selectionText(undefined, bit),
      );
    const upstreamWrites = mergeExecutionEvents(
      [],
      (upstreamExecution ?? []).map(({ writeEvents }) => writeEvents ?? []),
    );
    if (upstreamWrites.length)
      report +=
        "\n## Upstream write events\n\n" +
        executionEventLines(upstreamWrites).join("\n") +
        "\n";
    if (
      upstreamExecution?.some(
        ({ callbackEvents, statementEvents, writeEvents }) =>
          callbackEvents?.length ||
          statementEvents?.length ||
          writeEvents?.length,
      )
    )
      report +=
        "\n## Root and upstream execution order\n\n" +
        mermaidMarkdown(traceExecutionGraph(events, upstreamExecution)) +
        "\n";
    return report;
  }
  function mergeExecutionEvents(
    selected: Awaited<ReturnType<typeof readExecutionEvidence>>["events"],
    upstream: readonly (typeof selected)[],
  ) {
    const events = new Map(selected.map((event) => [event.ordinal, event]));
    for (const group of upstream)
      for (const event of group)
        if (!events.has(event.ordinal)) events.set(event.ordinal, event);
    return [...events.values()].sort(
      (left, right) => left.ordinal - right.ordinal,
    );
  }
  function traceExecutionGraph(
    selected: Awaited<ReturnType<typeof readExecutionEvidence>>["events"],
    upstream: Awaited<
      ReturnType<typeof traceObservedContext>
    >["upstreamExecution"],
  ) {
    const groups = (upstream ?? []).flatMap(
      ({ callbackEvents, statementEvents, writeEvents }) => [
        callbackEvents ?? [],
        statementEvents ?? [],
        writeEvents ?? [],
      ],
    );
    return executionMermaidPages({
      events: mergeExecutionEvents(selected, groups),
    });
  }
  async function traceLiveContext(
    viewer: V,
    result: Awaited<ReturnType<typeof traceWaveSignal>>,
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

  function liveTraceReport(
    evidence: Awaited<ReturnType<typeof traceLiveContext>>,
    trace: VideTrace,
  ) {
    const { context, replayMatch, executionCoverage, execution } = evidence;
    const report = [
      observationReport(context, trace),
      ...(replayMatch
        ? [
            "## Live event replay verification",
            "",
            "- Selected signal · " + replayMatch.status,
            ...replayMatch.upstream.map(
              ({ instance, signal, status }) =>
                "- " + instance + "." + signal + " · " + status,
            ),
            "",
          ]
        : []),
      traceExecutionComparisonReport(evidence, execution),
      "## Live execution coverage",
      "",
      "- Live session · " + context.provider.liveSessionId,
      executionCoverage.available
        ? "Recorded events available."
        : "The harness did not declare execution events.",
      "- Missing sequence numbers in the session · " +
        executionCoverage.missingOrdinals,
      "- Events omitted from this response · " +
        executionCoverage.responseOmitted,
      ...(executionCoverage.olderEventsDiscarded
        ? ["- The retained event buffer omits part of the requested window."]
        : []),
      "",
    ];
    if (execution.length)
      report.push(
        "## Live execution events",
        "",
        ...executionEventLines(execution),
        "",
      );
    return "\n" + report.join("\n");
  }

  async function queryWaveSchematic(
    viewer: V,
    fullname: string,
    tick: string | undefined,
    direction: TraceDirection,
    token?: vscode.CancellationToken,
  ) {
    await viewer.ready;
    const backend = viewer.backend;
    const raw = await traceWaveSignal(
      viewer,
      direction,
      fullname,
      { maxSignals: 96, maxAssignments: 96 },
      token,
    );
    const result = await focusWaveTrace(viewer, raw, fullname, direction);
    if (
      token?.isCancellationRequested ||
      viewer.disposed ||
      viewer.backend !== backend
    )
      return;
    const model = traceSchematic(result.trace);
    const { bindings } = await bindTraceObservations(viewer, result);
    if (
      token?.isCancellationRequested ||
      viewer.disposed ||
      viewer.backend !== backend
    )
      return;
    const mapped = new Map(
      model.graph.nodes.flatMap((node) => {
        const signal = bindings.get(model.signalNodes.get(node.id)!);
        return signal?.supported ? [[node.id, signal] as const] : [];
      }),
    );
    for (const node of model.graph.nodes) node.wave = mapped.has(node.id);
    const targets = [...mapped];
    if (
      tick &&
      /^\d+$/.test(tick) &&
      Number.isSafeInteger(Number(tick)) &&
      BigInt(tick) >= BigInt(viewer.meta.start) &&
      BigInt(tick) <= BigInt(viewer.meta.end)
    ) {
      for (let index = 0; index < targets.length; index += 64) {
        const batch = targets.slice(index, index + 64);
        if (
          token?.isCancellationRequested ||
          viewer.disposed ||
          viewer.backend !== backend
        )
          return;
        const values = await readSignalsAt(
          backend,
          batch.map(([, signal]) => signal),
          Number(tick),
        ).catch(() => []);
        batch.forEach(([id], offset) => {
          const value = values[offset];
          const node = model.graph.nodes.find((node) => node.id === id)!;
          if (value !== undefined)
            node.detail = [node.detail, value].filter(Boolean).join(" · ");
        });
      }
    }
    return { ...model, mapped };
  }

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
    ReturnType<typeof createStaticWalk>
  > & {
    kind: "static";
    root: string;
    initial: VideTrace;
    direction: TraceDirection;
    walk: StaticWalk;
  };
  function moduleSchematicReader(
    design: VerilatorDesign | KdbSession,
    viewer?: V,
    waveformPath?: string,
    savedSelection?: TraceProjectSelection | null,
  ) {
    let logicProject:
      | Promise<{ session?: VideTraceProject; directory: string }>
      | undefined;
    const openLogicProject = async (kdb: KdbSession) => {
      const selected = viewer ? traceProjectSelection(viewer) : savedSelection;
      const directory = path.dirname(kdb.path);
      if (selected) {
        const project = await openSimulationTrace(selected, viewer, kdb);
        return {
          session: project.session,
          directory: project.projectInfo.workingDirectory,
        };
      }
      if (selected !== null) {
        const manifest =
          waveformPath && (await readAdjacentTraceBuildManifest(waveformPath));
        if (
          manifest &&
          (manifest.roots.length || manifest.library_files?.length)
        )
          return {
            session: await openTraceBuildProject(manifest),
            directory: path.dirname(manifest.filename),
          };
        const rebuild = await discoverVcsRebuild(kdb.path);
        if (rebuild) {
          const project = await openSimulationTrace(rebuild, viewer, kdb);
          return {
            session: project.session,
            directory: rebuild.workingDirectory,
          };
        }
      }
      return { directory };
    };
    const readModule = (instance?: string, token?: vscode.CancellationToken) =>
      design instanceof VerilatorDesign
        ? design.moduleSchematic(instance)
        : kdbModuleSchematic(design, instance!, async (scope) => {
            if (!scope.definitionFile) throw Error("KDB 缺少模块源码位置");
            if (!logicProject) {
              const pending = openLogicProject(design);
              logicProject = pending;
              void pending.catch(() => {
                if (logicProject === pending) logicProject = undefined;
              });
            }
            const { session, directory } = await logicProject;
            const mappings = host.workspace
              .getConfiguration("waveWorkbench", viewer?.uri)
              .get<Record<string, string>>("sourcePathMappings");
            const sourceUri = (file: string) =>
              host.file(path.resolve(directory, mapPrefix(file, mappings)));
            const trace = await traceRtlPosition(
              "drivers",
              sourceUri(scope.definitionFile),
              host.position(0, 0),
              {
                module: scope.module,
                maxAssignments: 2048,
                maxSignals: 2048,
              },
              token,
              session,
            );
            if (trace.scope !== "module")
              throw Error("当前 VIDE 版本缺少模块逻辑查询");
            return bindModuleGenerateBranches(
              trace,
              scope.fullname,
              design,
              (file) => sourceUri(file).toString(),
            );
          });
    const closeLogicProject = () => {
      void logicProject?.then(
        ({ session }) => session?.dispose(),
        () => undefined,
      );
    };
    return { readModule, closeLogicProject };
  }

  async function sourceLocation(
    viewer: V,
    fullname: string,
    target = "declaration",
  ) {
    const design = viewer.kdb;
    if (!design) throw Error("Attach a design database first.");
    const cfg = host.workspace.getConfiguration("waveWorkbench", viewer.uri);
    const mapped = mapPrefix(fullname, cfg.get("hierarchyMappings"));
    let record = await design.resolve(mapped);
    if (
      target === "instance" &&
      record?.instance &&
      record.instance !== record.fullname
    )
      record = await design.resolve(record.instance);
    let file = target === "definition" ? record?.definitionFile : record?.file;
    const line =
      target === "definition" ? record?.definitionLine : record?.line;
    if (!file || !Number.isInteger(line) || line < 1)
      throw new Error(`No ${target} source location for ${fullname}.`);
    file = mapPrefix(file, cfg.get("sourcePathMappings"));
    if (!path.isAbsolute(file))
      file = path.resolve(path.dirname(viewer.kdb.path), file);
    const doc = await host.workspace.openTextDocument(host.file(file));
    if (line > doc.lineCount)
      throw new Error(
        `HDL line ${line} is outside ${file}; verify source snapshot/path mappings.`,
      );
    return { file, line, record };
  }

  // A single request can visit many shallow frontiers while preserving the existing resume protocol.
  function continuationLimit(args: Record<string, unknown>, fallback?: number) {
    const requested = args.followContinuations as number | undefined;
    const minimum = fallback === undefined ? 0 : 1;
    if (
      requested !== undefined &&
      (!Number.isInteger(requested) || requested < minimum || requested > 8)
    )
      throw Error(
        `followContinuations must be an integer from ${minimum} to 8.`,
      );
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

  function tools(
    workspace: string,
    findView: (waveform?: unknown) => V | undefined,
    ensureDesign: (viewer: V) => Promise<unknown> = async () => {},
  ) {
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
          ? continuationReport(
              walk,
              diagrams,
              combined,
              undefined,
              combinedPages,
            )
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
      if (
        name === "wave_trace_graph_page" ||
        name === "wave_trace_graph_path"
      ) {
        operation.throwIfAborted();
        const graphCursor = String(args.graphCursor);
        const graph = graphs.get(graphCursor);
        if (!graph)
          throw Error(
            "This trace graph cursor is unavailable. Start a new trace.",
          );
        if (name === "wave_trace_graph_path") {
          const mode = args.mode === "all" ? "all" : "shortest";
          const ids = (args.nodeIds as number[] | undefined) ?? [];
          const selectors = (args.nodeSelectors as unknown[] | undefined) ?? [];
          if (graph.staticTrace) {
            const {
              graph: parent,
              direction,
              bitExpressions,
            } = graph.staticTrace;
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
                assignmentsWithoutBitMappings:
                  result.assignmentsWithoutBitMappings,
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
              report: (pages) =>
                staticPathReport(selection, direction, pages()),
            });
            return {
              graphSnapshot,
              paths: selection.paths,
              mode,
              direction,
              pathScope: "declaration",
              ...(selection.matches.length
                ? { matches: selection.matches }
                : {}),
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
      if (name === "wave_trace_resume") {
        const cursor = String(args.continuationCursor);
        const state = retained.get(cursor);
        if (!state)
          throw Error(
            "This trace continuation cursor is unavailable. Start a new trace.",
          );
        if (state.busy)
          throw Error("This trace continuation is already running.");
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
            const report = fullReport
              ? buildReport(() => graphMermaid)
              : undefined;
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
                  report: appendContinuationReport(
                    state.rootReport(),
                    walkReport,
                  ),
                }
              : {}),
            ...(reportOnly && args.format === "mermaid"
              ? {
                  continuationMermaid: output.continuationMermaid,
                  continuationMermaidPages: output.continuationMermaidPages,
                  temporalContinuationMermaid:
                    output.temporalContinuationMermaid,
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
      if (name === "wave_execution_trace") {
        if (args.recordingOnly === true && args.waveform)
          throw Error("Recording-only playback cannot also select a waveform.");
        if (args.waveform && !viewer)
          throw Error("Open the selected waveform first.");
        const selected = args.recordingOnly === true ? undefined : viewer;
        await selected?.ready;
        const tick = String(args.tick);
        const execution = await readExecutionEvidence(
          path.resolve(workspace, String(args.executionLog)),
          selected?.uri.fsPath,
          selected?.meta.scale,
          String(args.instance),
          String(args.signal),
          String(args.historyStart ?? tick),
          tick,
          undefined,
          operation,
        );
        return {
          ...execution,
          ...(args.format === "mermaid"
            ? mermaidOutput("mermaid", executionMermaidPages(execution))
            : {}),
          ...(args.detail === "full"
            ? { report: executionReport(execution) }
            : {}),
        };
      }
      if (!viewer) throw Error("Open a waveform first");
      await ensureDesign(viewer);
      if (name === "wave_source")
        return sourceLocation(
          viewer,
          String(args.signal),
          String(args.target ?? "declaration"),
        );
      if (name === "wave_module_schematic") {
        const design = viewer.kdb;
        if (
          !(design instanceof VerilatorDesign || design instanceof KdbSession)
        )
          throw Error("Attach an elaborated Verilator JSON or VCS KDB first.");
        let instance = args.instance as string | undefined;
        const cfg = host.workspace.getConfiguration(
          "waveWorkbench",
          viewer.uri,
        );
        if (args.signal !== undefined) {
          if (instance) throw Error("Specify either instance or signal.");
          const record = await design.resolve(
            mapPrefix(String(args.signal), cfg.get("hierarchyMappings")),
          );
          if (!record?.instance)
            throw Error("No elaborated instance for " + args.signal);
          instance = record.instance;
        }
        if (!instance && design instanceof KdbSession) {
          const roots = await kdbSchematicRoots(design);
          if (roots.length !== 1)
            throw Error(
              "Choose a KDB root: " +
                roots.map(({ fullname }) => fullname).join(", "),
            );
          instance = roots[0].fullname;
        }
        const reader = moduleSchematicReader(design, viewer, viewer.uri.fsPath);
        const cancellation = host.cancellation();
        const cancel = () => cancellation.cancel();
        operation.addEventListener("abort", cancel, { once: true });
        try {
          operation.throwIfAborted();
          const graph = await reader.readModule(instance, cancellation.token);
          operation.throwIfAborted();
          return graph;
        } finally {
          operation.removeEventListener("abort", cancel);
          cancellation.dispose();
          reader.closeLogicProject();
        }
      }
      if (name === "wave_schematic") {
        const cancel = host.cancellation();
        const abort = () => cancel.cancel();
        operation.addEventListener("abort", abort, { once: true });
        if (operation.aborted) abort();
        try {
          const model = await queryWaveSchematic(
            viewer,
            String(args.signal),
            typeof args.tick === "string" ? args.tick : undefined,
            args.direction === "loads" ? "loads" : "drivers",
            cancel.token,
          );
          operation.throwIfAborted();
          if (!model)
            throw Error("The waveform changed during the schematic query.");
          return {
            ...model.graph,
            nodes: model.graph.nodes.map((node) => ({
              ...node,
              location: model.locations.get(node.id),
              signal: model.mapped.get(node.id),
            })),
          };
        } finally {
          operation.removeEventListener("abort", abort);
          cancel.dispose();
        }
      }
      if (name === "wave_execution_map") {
        await viewer.ready;
        const design = viewer.kdb;
        const instance = String(args.instance);
        const signal = String(args.signal);
        const captureOperands = args.captureOperands === true;
        const captureGuards = args.captureGuards === true;
        const captureGuardEntry = args.captureGuardEntry === true;
        let statements;
        if (design instanceof VerilatorDesign) {
          if (captureOperands || captureGuards || captureGuardEntry)
            throw Error(
              "Automatic operand and guard capture in execution maps requires a VCS KDB.",
            );
          statements = await design.executionStatements(instance, signal);
        } else if (design instanceof KdbSession) {
          const cancellation = host.cancellation();
          const cancel = () => cancellation.cancel();
          operation.throwIfAborted();
          operation.addEventListener("abort", cancel, { once: true });
          try {
            const result = await traceWaveSignal(
              viewer,
              "drivers",
              instance + "." + signal,
              { maxDepth: 1 },
              cancellation.token,
            );
            statements = await vcsExecutionStatements(
              result.trace,
              instance,
              signal,
              new Set(
                host.workspace.textDocuments
                  .filter(
                    (document) =>
                      document.uri.scheme === "file" && document.isDirty,
                  )
                  .map((document) => document.uri.fsPath),
              ),
              captureOperands,
              captureGuards,
              captureGuardEntry,
            );
          } finally {
            operation.removeEventListener("abort", cancel);
            cancellation.dispose();
          }
        } else {
          throw Error(
            "Attach a Verilator elaboration tree or a VCS KDB first.",
          );
        }
        operation.throwIfAborted();
        return {
          schemaVersion: 1,
          instance,
          signal,
          statements,
        };
      }
      if (
        name === "wave_trace_drivers" ||
        name === "wave_trace_loads" ||
        name === "wave_trace_context" ||
        name === "wave_live_trace"
      ) {
        const live = name === "wave_live_trace" ? getLive() : undefined;
        if (name === "wave_live_trace" && !live)
          throw Error("Start a live simulation harness first.");
        if (
          live &&
          args.liveSessionId !== undefined &&
          args.liveSessionId !== live.id
        )
          throw Error("The live simulation session changed.");
        const followLimit = continuationLimit(args);
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
            (args.maxSignals as number | undefined) ??
            (expand ? 4096 : undefined),
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
        if (!live)
          result = await focusWaveTrace(viewer, result, signal, direction);
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
          staticContinuationGraph?: ReturnType<
            typeof mergeStaticContinuationGraph
          >;
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
              ? mermaidOutput(
                  "mermaid",
                  traceMermaidPages(paged.trace, feedback),
                )
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
          context:
            | Awaited<ReturnType<typeof traceObservedContext>>["context"]
            | Awaited<ReturnType<typeof traceLiveContext>>["context"],
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
              },
              abort,
              batchProject,
            );
            return reply as ReturnType<typeof temporalOutput>;
          };
          const walk = await followTemporalFrontier(
            root,
            context.temporalTrace,
            followLimit,
            operation,
            continuationDeadline,
            (point, abort) => query(point, abort, requestProject),
            { assertCurrent, defaultHistoryStart },
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
            traceReport(
              trace,
              "drivers",
              signal,
              feedbackEdges,
              staticCoverage,
            ) + liveTraceReport(evidence, trace);
          const { walkReport, ...continuations } = await follow(
            context,
            report,
          );
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
                  ...(executionAssignments?.length
                    ? { executionAssignments }
                    : {}),
                  ...(executionTransitions?.length
                    ? { executionTransitions }
                    : {}),
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
      }
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
          [requestProject.pending, requestProject.build?.pending].map(
            (pending) =>
              pending?.then(
                ({ session }) => session.dispose(),
                () => undefined,
              ),
          ),
        );
      }
    };
  }

  return {
    traceRtlPosition,
    openTraceBuildProject,
    readSimulationTrace,
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
    queryWaveSchematic,
    moduleSchematicReader,
    sourceLocation,
    dumpScope,
    dropTraceProject,
    tools,
    dispose: () =>
      traceProjects.forEach((_, viewer) => dropTraceProject(viewer)),
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
