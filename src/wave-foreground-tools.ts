// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { SchematicGraph } from "./shared/schematic";
import type { Viewer } from "./viewer";
import type * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs";
import { randomUUID } from "node:crypto";

import { isWaveform, type FsdbBackend } from "./backend-selection";
import { loadDecoderProfiles } from "./decoder-config";
import { type DecoderInstance } from "./decoder-runtime/types";
import { serveWaveMcp } from "./mcp";
import { isAnalysisTool } from "./wave-analysis";
import { editWaveView } from "./wave-view-tools";
import {
  runWaveMath,
  type Operation,
  type MathOptions,
} from "./wave-math-runtime";
import { tclWaveTool, type WaveToolHandler } from "./wave-tools";
import { VerilatorDesign } from "./verilator";
import {
  clipFormats,
  collectClip,
  type ClipFormat,
  type ClipOptions,
} from "./wave-clip";
import { KdbSession } from "./kdb";
import { WaveCommands } from "./commands";
import { TclRunner } from "./tcl";

import type {
  WaveAnalysis,
  GetViewer,
  TrackTask,
} from "./wave-extension-types";
import type { createWaveFiles } from "./wave-files";
import type { createWaveDecoders } from "./wave-decoders";
import type { createWaveClipExport } from "./wave-clip-export";
import type { createWaveSchematics } from "./wave-schematics";
import type { createWaveSourceNavigation } from "./wave-source-navigation";
import type { createWaveTcl } from "./wave-tcl";
import type { createLiveDebugSession } from "./live-debug-session";

function isLiveTool(name: string) {
  return (
    name === "wave_live_start" ||
    name === "wave_debug_request" ||
    name === "wave_live_debug" ||
    name === "wave_live_status" ||
    name === "wave_live_control" ||
    name === "wave_live_history" ||
    name === "wave_live_stop"
  );
}

type VSCodeApi = typeof vscode;

export function registerWaveForegroundTools(
  vscode: VSCodeApi,
  {
    context,
    getCurrent,
    workspace,
    output,
    trackTask,
    viewers,
    createAnalysisTools,
    handleLiveTool,
    openKdbSource,
    showWaveSchematic,
    showModuleSchematic,
    openWaveform,
    openProject,
    saveProject,
    decodeWindow,
    decoderConfigPath,
    listWaveDecoders,
    executeTclWithLogs,
    exportClipArtifact,
    includeClipDecoder,
  }: {
    context: vscode.ExtensionContext;
    getCurrent: GetViewer;
    workspace: string | undefined;
    output: vscode.OutputChannel;
    trackTask: TrackTask;
    viewers: Set<Viewer>;
    createAnalysisTools: WaveAnalysis["tools"];
    handleLiveTool: ReturnType<typeof createLiveDebugSession>["handleTool"];
    openKdbSource: ReturnType<
      typeof createWaveSourceNavigation
    >["openKdbSource"];
    showWaveSchematic: ReturnType<
      typeof createWaveSchematics
    >["showWaveSchematic"];
    showModuleSchematic: ReturnType<
      typeof createWaveSchematics
    >["showModuleSchematic"];
    openWaveform: ReturnType<typeof createWaveFiles>["openWaveform"];
    openProject: ReturnType<typeof createWaveFiles>["openProject"];
    saveProject: ReturnType<typeof createWaveFiles>["saveProject"];
    decodeWindow: ReturnType<typeof createWaveDecoders>["decodeWindow"];
    decoderConfigPath: ReturnType<
      typeof createWaveDecoders
    >["decoderConfigPath"];
    listWaveDecoders: ReturnType<typeof createWaveDecoders>["listWaveDecoders"];
    executeTclWithLogs: ReturnType<typeof createWaveTcl>["executeTclWithLogs"];
    exportClipArtifact: ReturnType<
      typeof createWaveClipExport
    >["exportClipArtifact"];
    includeClipDecoder: ReturnType<
      typeof createWaveClipExport
    >["includeClipDecoder"];
  },
) {
  let automation: WaveToolHandler | undefined;
  if (workspace) {
    try {
      const analysisTools = createAnalysisTools(workspace, (filename) =>
        filename
          ? [...viewers].find((viewer) => viewer.uri.fsPath === filename)
          : getCurrent(),
      );
      const withTask =
        (
          handler: (
            name: string,
            args: Record<string, unknown>,
            operation: AbortSignal,
          ) => Promise<unknown>,
        ) =>
        async (
          name: string,
          args: Record<string, unknown>,
          operation: AbortSignal,
        ) => {
          const labels = {
            wave_open: "打开波形",
            wave_clip: "截取波形",
            wave_export: "导出波形",
            wave_tcl: "执行波形 Tcl",
            wave_schematic: "读取原理图",
            wave_save_project: "保存波形工程",
          };
          if (name === "wave_list") return handler(name, args, operation);
          const filename =
            name === "wave_open"
              ? args.path
              : (args.waveform ?? getCurrent()?.uri.fsPath);
          return trackTask(
            labels[name] ?? name,
            typeof filename === "string"
              ? path.resolve(workspace, filename)
              : undefined,
            () => handler(name, args, operation),
          );
        };
      const createAutomation = () =>
        withTask(
          async function request(name, args, operation): Promise<unknown> {
            if (isAnalysisTool(name)) {
              const result = await analysisTools(name, args, operation);
              if (args.show === true) {
                const viewer = args.waveform
                  ? [...viewers].find((v) => v.uri.fsPath === args.waveform)
                  : getCurrent();
                if (name === "wave_source" && viewer)
                  await openKdbSource(
                    viewer,
                    String(args.signal),
                    String(args.target ?? "declaration"),
                  );
                if (
                  name === "wave_module_schematic" &&
                  viewer &&
                  (viewer.kdb instanceof KdbSession ||
                    viewer.kdb instanceof VerilatorDesign)
                )
                  await showModuleSchematic(
                    viewer.kdb,
                    viewer,
                    (result as SchematicGraph).module?.instance,
                  );
                if (name === "wave_schematic" && viewer)
                  await showWaveSchematic(viewer, String(args.signal), {
                    tick: typeof args.tick === "string" ? args.tick : undefined,
                    direction: args.direction === "loads" ? "loads" : "drivers",
                  });
              }
              return result;
            }

            if (isLiveTool(name)) return handleLiveTool(name, args, operation);
            if (name === "wave_list")
              return {
                selected: getCurrent()?.uri.fsPath ?? null,
                views: [...viewers].map((v) => v.uri.fsPath),
              };
            if (name === "wave_open") {
              const filename = path.resolve(workspace, String(args.path));
              if (
                (!isWaveform(filename) && !/\.waveproj$/i.test(filename)) ||
                !fs.existsSync(filename)
              )
                throw Error("Waveform or project not found: " + filename);
              const viewer = /\.waveproj$/i.test(filename)
                ? await openProject(filename)
                : await openWaveform(filename);
              if (!viewer?.meta)
                throw Error(viewer?.openError ?? "Unable to open waveform");
              if (args.backend !== undefined)
                await viewer.switchBackend(args.backend as FsdbBackend);
              const { start, end, scale, total, backend } = viewer.meta;
              return {
                waveform: viewer.uri.fsPath,
                start,
                end,
                scale,
                total,
                backend,
              };
            }
            const viewer = args.waveform
              ? [...viewers].find((v) => v.uri.fsPath === args.waveform)
              : getCurrent();
            if (name === "wave_tcl" && !viewer && !args.waveform) {
              let target: Viewer | undefined;
              const logs: string[] = [];
              const engine = new WaveCommands({
                getViewer: () => target,
                open: async (file) => {
                  target = await openWaveform(path.resolve(workspace, file));
                },
                decodeTransactions: decodeWindow,
                decoderProfiles: (waveform) =>
                  loadDecoderProfiles(decoderConfigPath(waveform)),
              });
              const runner = new TclRunner(
                (command, nodes, directory) => {
                  if (target) target.scriptDirectory = directory;
                  if (command === "waveTool")
                    return Promise.resolve(
                      tclWaveTool(
                        automation!,
                        nodes,
                        undefined,
                        target?.uri.fsPath,
                        operation,
                      ),
                    ).then((result) => {
                      if (nodes[0]?.value === "wave_open")
                        target = getCurrent();
                      return result;
                    });
                  return engine.execute(command, nodes);
                },
                {
                  executable:
                    vscode.workspace
                      .getConfiguration("waveWorkbench")
                      .get<string>("tclshPath") || undefined,
                  log: (text) => {
                    if (logs.length < 500) logs.push(text.slice(0, 4096));
                  },
                },
              );
              const abort = () => runner.dispose();
              operation.addEventListener("abort", abort, { once: true });
              try {
                operation.throwIfAborted();
                return {
                  result: await runner.run(String(args.script), workspace),
                  logs,
                };
              } finally {
                operation.removeEventListener("abort", abort);
                runner.dispose();
              }
            }
            if (!viewer) throw Error("Open a waveform first");
            if (name === "wave_close") {
              if (viewer.running)
                throw Error("A Tcl script is running in this view.");
              viewer.panel.dispose();
              return { waveform: viewer.uri.fsPath, closed: true };
            }
            if (name === "wave_design_attach") {
              operation.throwIfAborted();
              await viewer.ready;
              const design = path.resolve(workspace, String(args.path));
              if (!(await viewer.attachKdb(design, true)))
                throw Error("Could not attach design: " + design);
              return { path: viewer.kdb.path, kind: viewer.kdb.kind };
            }
            if (name === "wave_view") {
              await viewer.ready;
              if (!viewer.panel.visible) viewer.panel.reveal(undefined, true);
              return editWaveView(viewer, args, operation);
            }
            if (name === "wave_search") {
              await viewer.ready;
              return viewer.backend.request("search", {
                query: String(args.query ?? ""),
                offset: Number(args.offset ?? 0),
                limit: Number(args.limit ?? 100),
              });
            }
            if (name === "wave_math") {
              await viewer.ready;
              const result = await runWaveMath(
                {
                  backend: viewer.backend,
                  meta: viewer.meta,
                  filename: viewer.uri.fsPath,
                },
                args.operation as Operation,
                args.signals as string[],
                String(args.start ?? viewer.meta.start),
                String(args.end ?? viewer.meta.end),
                (args.options ?? {}) as MathOptions,
                workspace,
                vscode.workspace.isTrusted,
                operation,
              );
              if ("signal" in result && !viewer.disposed)
                await viewer.panel.webview.postMessage({
                  type: "virtualCreated",
                  ...result,
                });
              if ("path" in result && result.path && args.open === true)
                await openWaveform(result.path);
              return result;
            }
            if (name === "wave_decoder_list") {
              const { definitions, warnings } = await listWaveDecoders(viewer);
              return {
                decoders: [...definitions.values()].map(
                  ({ manifest }) => manifest,
                ),
                warnings,
              };
            }
            if (name === "wave_decoder_query") {
              return decodeWindow(
                viewer,
                {
                  decoderId: String(args.decoderId),
                  bindings: args.bindings as DecoderInstance["bindings"],
                  options: args.options as DecoderInstance["options"],
                },
                String(args.start),
                String(args.end),
                operation,
              );
            }
            if (name === "wave_decoder_attach") {
              const { definitions } = await listWaveDecoders(viewer);
              const definition = definitions.get(String(args.decoderId));
              if (!definition)
                throw Error("Decoder not found or disabled: " + args.decoderId);
              const instance = {
                instanceId: randomUUID(),
                decoderId: definition.manifest.id,
                engine: definition.manifest.engine,
                bindings: args.bindings as DecoderInstance["bindings"],
                options: args.options as DecoderInstance["options"],
              };
              await viewer.ui("decoderAttach", instance);
              return instance;
            }
            if (
              name === "wave_decoder_detach" ||
              name === "wave_decoder_reload" ||
              name === "wave_decoder_status"
            ) {
              await viewer.ready;
              return await viewer.ui(
                name === "wave_decoder_detach"
                  ? "decoderDetach"
                  : name === "wave_decoder_reload"
                    ? "decoderReload"
                    : "decoderStatus",
                { instanceId: args.instanceId },
              );
            }
            if (name === "wave_clip" || name === "wave_export") {
              await viewer.ready;
              if (!viewer.meta) throw Error("Waveform did not load");
              if (!viewer.panel.visible) viewer.panel.reveal(undefined, true);
              const clip = await collectClip(
                viewer,
                args as ClipOptions,
                name === "wave_clip",
              );
              if (name === "wave_clip") {
                await includeClipDecoder(viewer, clip, "json", operation);
                return clip;
              }
              const format = args.format as ClipFormat;
              if (!clipFormats.includes(format))
                throw Error("Unsupported clip format");
              await includeClipDecoder(viewer, clip, format, operation);
              return exportClipArtifact(
                viewer,
                clip,
                format,
                typeof args.path === "string"
                  ? path.resolve(workspace, args.path)
                  : undefined,
              );
            }
            if (name === "wave_save_project") {
              const destination =
                typeof args.path === "string"
                  ? path.resolve(workspace, args.path)
                  : viewer.document.projectPath ||
                    viewer.uri.fsPath.replace(/\.[^.]+$/, "") + ".waveproj";
              const filename = await saveProject(viewer, destination);
              if (viewer.panel.active && viewer.document.dirty)
                await vscode.commands.executeCommand(
                  "workbench.action.files.save",
                );
              return { path: filename };
            }
            if (name !== "wave_tcl")
              throw Error("Unknown Wave Workbench tool: " + name);
            return executeTclWithLogs(viewer, String(args.script));
          },
        );
      automation = createAutomation();
      if (
        vscode.workspace
          .getConfiguration("waveWorkbench")
          .get<boolean>("mcpEnabled")
      )
        context.subscriptions.push(
          serveWaveMcp(workspace, automation, (message) =>
            output.appendLine(String(message)),
          ),
        );
    } catch (error) {
      output.appendLine(String(error));
    }
  }

  return automation;
}
