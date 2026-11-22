// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type * as vscode from "vscode";
import * as path from "node:path";
import { traceSchematic } from "./rtl-schematic";
import { kdbModuleSchematic, kdbSchematicRoots } from "./kdb-schematic";
import { type TraceProjectSelection } from "./project";
import { readSignalsAt } from "./signal-lookup";
import { VerilatorDesign } from "./verilator";
import { KdbSession, mapPrefix } from "./kdb";
import { type TraceDirection, type VideTraceProject } from "./rtl-trace";
import { discoverVcsRebuild } from "./vide-project-config";
import { bindModuleGenerateBranches } from "./rtl-trace-instances";
import {
  executionMermaidPages,
  executionReport,
  readExecutionEvidence,
  vcsExecutionStatements,
} from "./rtl-execution";
import { mermaidOutput } from "./trace-mermaid";
import { readAdjacentTraceBuildManifest } from "./rtl-build-verification";

import type {
  AnalysisView,
  SelectTraceProject,
  TraceHost,
} from "./wave-analysis-types";
import type { AnalysisProjects } from "./wave-analysis-projects";
import type { AnalysisBindings } from "./wave-analysis-bindings";

export function createAnalysisDesign<V extends AnalysisView>(
  host: TraceHost,
  traceProjectSelection: SelectTraceProject<V>,
  projects: Pick<
    AnalysisProjects<V>,
    | "traceRtlPosition"
    | "openTraceBuildProject"
    | "openSimulationTrace"
    | "traceWaveSignal"
  >,
  bindings: Pick<
    AnalysisBindings<V>,
    "bindTraceObservations" | "focusWaveTrace"
  >,
) {
  const {
    traceRtlPosition,
    openTraceBuildProject,
    openSimulationTrace,
    traceWaveSignal,
  } = projects;
  const { bindTraceObservations, focusWaveTrace } = bindings;

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

  async function readExecutionTrace(
    workspace: string,
    viewer: V | undefined,
    args: Record<string, unknown>,
    operation: AbortSignal,
  ) {
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
      ...(args.detail === "full" ? { report: executionReport(execution) } : {}),
    };
  }

  async function queryDesign(
    workspace: string,
    viewer: V,
    name: string,
    args: Record<string, unknown>,
    operation: AbortSignal,
  ) {
    if (name === "wave_source")
      return sourceLocation(
        viewer,
        String(args.signal),
        String(args.target ?? "declaration"),
      );
    if (name === "wave_module_schematic") {
      const design = viewer.kdb;
      if (!(design instanceof VerilatorDesign || design instanceof KdbSession))
        throw Error("Attach an elaborated Verilator JSON or VCS KDB first.");
      let instance = args.instance as string | undefined;
      const cfg = host.workspace.getConfiguration("waveWorkbench", viewer.uri);
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
        throw Error("Attach a Verilator elaboration tree or a VCS KDB first.");
      }
      operation.throwIfAborted();
      return {
        schemaVersion: 1,
        instance,
        signal,
        statements,
      };
    }
    throw Error("Unknown RTL analysis tool: " + name);
  }

  return {
    queryWaveSchematic,
    moduleSchematicReader,
    sourceLocation,
    readExecutionTrace,
    queryDesign,
  };
}

export type AnalysisDesign<V extends AnalysisView> = ReturnType<
  typeof createAnalysisDesign<V>
>;
