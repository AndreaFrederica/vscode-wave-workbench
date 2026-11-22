// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { type TraceProjectSelection } from "./project";
import { VerilatorDesign } from "./verilator";
import { KdbSession, mapPrefix } from "./kdb";
import {
  TraceContextChanged,
  type TraceDirection,
  type TraceOptions,
  type VideTraceProject,
} from "./rtl-trace";
import {
  discoverVcsRebuild,
  readSimulationFilelist,
  simulationFilelistsCurrent,
  simulationInputFingerprint,
  traceVideManifest,
  type ElaboratedLibrarySources,
} from "./vide-project-config";
import type { LiveTraceSession } from "./rtl-live-trace";
import {
  readAdjacentTraceBuildManifest,
  vcsPliExecutionGap,
  type TraceBuildManifest,
} from "./rtl-build-verification";

import type {
  AnalysisView,
  GetLiveTrace,
  SelectTraceProject,
  TraceHost,
} from "./wave-analysis-types";
import type { TrackTask } from "./wave-extension-types";
import {
  createStaticAnalysis,
  type ProjectTrace,
} from "./wave-analysis-static";

export type TraceRequestProject = {
  pending?: ReturnType<AnalysisProjects<AnalysisView>["openSimulationTrace"]>;
  build?: {
    identity: string;
    traces: Map<string, ProjectTrace>;
    pending: Promise<{
      session: VideTraceProject;
      inputs: Awaited<ReturnType<typeof simulationInputFingerprint>>[];
    }>;
  };
};

export function createAnalysisProjects<V extends AnalysisView>(
  host: TraceHost,
  traceProjectSelection: SelectTraceProject<V>,
  getLive: GetLiveTrace,
  trackTask: TrackTask,
) {
  const { traceRtlPosition, traceWithProject, clearPortTraceCache } =
    createStaticAnalysis<V>(host);
  const traceProjects = new Map<V, ReturnType<typeof openSimulationTrace>>();

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
          if (batch) clearPortTraceCache(project);
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
      if (scopedProject) clearPortTraceCache(project.session);
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
    if (design && !live) {
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
        if (retainCheckpoint && fs.existsSync(database))
          await addDesignFiles(database);
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

  return {
    traceRtlPosition,
    openTraceBuildProject,
    readSimulationTrace,
    openSimulationTrace,
    traceWaveSignal,
    createContinuationGuard,
    dumpScope,
    dropTraceProject,
    dispose: () =>
      traceProjects.forEach((_, viewer) => dropTraceProject(viewer)),
  };
}

export type AnalysisProjects<V extends AnalysisView> = ReturnType<
  typeof createAnalysisProjects<V>
>;
export type WaveTraceResult = Awaited<
  ReturnType<AnalysisProjects<AnalysisView>["traceWaveSignal"]>
>;
