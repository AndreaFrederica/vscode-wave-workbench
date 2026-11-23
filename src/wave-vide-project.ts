// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { Viewer, WaveDocument } from "./viewer";
import type * as vscode from "vscode";
import * as path from "node:path";

import { type TraceProjectSelection } from "./project";
import { localize } from "./shared/localization";
import {
  readRtlProjectBinding,
  type RtlNavigationTarget,
} from "./rtl-project-binding";
import type { createWaveSourceNavigation } from "./wave-source-navigation";

import { previewVideManifest } from "./vide-project-config";

import type {
  WaveAnalysis,
  GetViewer,
  ReportError,
} from "./wave-extension-types";
import type { createWaveTraceView } from "./wave-trace-view";
function traceProjectKey(viewer: Viewer) {
  return "videTraceProject:" + viewer.uri.toString();
}

export function createTraceProjectSelection(context: vscode.ExtensionContext) {
  return function traceProjectSelection(viewer: Viewer) {
    const selection = viewer.document.traceProject;
    return selection === undefined
      ? context.workspaceState?.get<TraceProjectSelection | null>(
          traceProjectKey(viewer),
        )
      : selection;
  };
}

type VSCodeApi = typeof vscode;

export function registerWaveVideProject(
  vscode: VSCodeApi,
  {
    context,
    getCurrent,
    workspace,
    report,
    projectChanges,
    readSimulationTrace,
    dropTraceProject,
    clearViewerTrace,
    openRtlTarget,
  }: {
    context: vscode.ExtensionContext;
    getCurrent: GetViewer;
    workspace: string | undefined;
    report: ReportError;
    projectChanges: vscode.EventEmitter<
      vscode.CustomDocumentContentChangeEvent<WaveDocument>
    >;
    readSimulationTrace: WaveAnalysis["readSimulationTrace"];
    dropTraceProject: WaveAnalysis["dropTraceProject"];
    clearViewerTrace: ReturnType<
      typeof createWaveTraceView
    >["clearViewerTrace"];
    openRtlTarget: ReturnType<
      typeof createWaveSourceNavigation
    >["openRtlTarget"];
  },
) {
  const switchCommand = "waveWorkbench.switchRtlTarget";
  const status = vscode.window.createStatusBarItem?.(
    "waveWorkbench.rtlTarget",
    vscode.StatusBarAlignment?.Left ?? 1,
    50,
  );
  const label = (target: RtlNavigationTarget) =>
    localize(target === "design" ? "原版 RTL" : "仿真 TB");
  const activeTarget = (viewer: Viewer) =>
    viewer.document.rtlBinding?.target ?? "design";
  const opposite = (target: RtlNavigationTarget): RtlNavigationTarget =>
    target === "design" ? "testbench" : "design";
  function refreshRtlTarget() {
    if (!status) return;
    const viewer = getCurrent();
    if (!viewer?.document.rtlBinding || viewer.disposed) {
      status.hide();
      return;
    }
    const target = activeTarget(viewer);
    status.text = "$(symbol-module) " + label(target);
    status.tooltip = localize("切换到 {0}", label(opposite(target)));
    status.show();
  }
  if (status) {
    status.name = localize("波形工程 RTL 目标");
    status.command = switchCommand;
    context.subscriptions.push(status, projectChanges.event(refreshRtlTarget));
  }
  let switching = false;
  context.subscriptions.push(
    vscode.commands.registerCommand(
      switchCommand,
      async (requested?: RtlNavigationTarget) => {
        const viewer = getCurrent();
        const binding = viewer?.document.rtlBinding;
        if (!binding || viewer.disposed || switching) return;
        if (
          requested !== undefined &&
          requested !== "design" &&
          requested !== "testbench"
        )
          return;
        const target = requested ?? opposite(activeTarget(viewer));
        const design = viewer.kdb;
        const valid = () =>
          !viewer.disposed &&
          getCurrent() === viewer &&
          viewer.document.rtlBinding === binding &&
          viewer.kdb === design;
        switching = true;
        try {
          await openRtlTarget(viewer, binding, target, valid);
          if (valid() && target !== activeTarget(viewer)) {
            viewer.document.rtlBinding = { ...binding, target };
            viewer.document.dirty = true;
            projectChanges.fire({ document: viewer.document });
          }
        } catch (error) {
          if (valid()) report(error);
        } finally {
          switching = false;
        }
      },
    ),
    vscode.commands.registerCommand(
      "waveWorkbench.configureRtlBinding",
      async () => {
        try {
          const viewer = getCurrent();
          if (!viewer || viewer.disposed) throw Error("Open a waveform first.");
          await viewer.ready;
          const previous = viewer.document.rtlBinding;
          const edit = localize("设置 RTL 与 TB 绑定");
          if (previous) {
            const choice = await vscode.window.showQuickPick([
              edit,
              localize("移除绑定"),
            ]);
            if (!choice) return;
            if (choice !== edit) {
              update(undefined);
              return;
            }
          }
          const root = path.dirname(
            viewer.document.projectPath || viewer.uri.fsPath,
          );
          async function folder(title: string, current?: string) {
            return (
              await vscode.window.showOpenDialog({
                title: localize(title),
                defaultUri: vscode.Uri.file(current ?? root),
                canSelectFiles: false,
                canSelectFolders: true,
                canSelectMany: false,
              })
            )?.[0]?.fsPath;
          }
          const designRoot = await folder(
            "选择原版 RTL 工程目录",
            previous?.designRoot,
          );
          if (!designRoot) return;
          const testbenchRoot = await folder(
            "选择 TB 工程目录",
            previous?.testbenchRoot,
          );
          if (!testbenchRoot) return;
          const dutInstance = await vscode.window.showInputBox({
            prompt: localize("输入设计数据库中的完整 DUT 实例路径"),
            value: previous?.dutInstance || viewer.selectedScope,
            validateInput: (value) =>
              value.trim() ? undefined : localize("请输入 DUT 实例路径"),
          });
          if (dutInstance === undefined) return;
          const waveformScope = await vscode.window.showInputBox({
            prompt: localize(
              "输入波形中的 DUT 层次路径，与实例路径相同时可留空",
            ),
            value: previous?.waveformScope,
          });
          if (waveformScope === undefined) return;
          update(
            readRtlProjectBinding(
              {
                designRoot,
                testbenchRoot,
                dutInstance: dutInstance.trim(),
                waveformScope: waveformScope.trim() || undefined,
                target: previous?.target,
                sourcePathMappings: previous?.sourcePathMappings,
              },
              root,
            ),
          );

          function update(binding: ReturnType<typeof readRtlProjectBinding>) {
            if (
              viewer.disposed ||
              JSON.stringify(viewer.document.rtlBinding) ===
                JSON.stringify(binding)
            )
              return;
            viewer.document.rtlBinding = binding;
            viewer.sourceInstances.clear();
            viewer.syncedEditor = undefined;
            dropTraceProject(viewer);
            clearViewerTrace(viewer);
            viewer.document.dirty = true;
            projectChanges.fire({ document: viewer.document });
          }
        } catch (error) {
          report(error);
        }
      },
    ),
    vscode.commands.registerCommand("waveWorkbench.videStatus", () => {
      const ext = vscode.extensions.getExtension(
        "pascal-lab.vide-code-extension",
      );
      vscode.window.showInformationMessage(
        ext
          ? `Vide ${ext.packageJSON.version} detected. KDB resolves source locations; Vide handles RTL editing without a competing HDL language server.`
          : "Vide is optional. Install pascal-lab.vide-code-extension for HDL editing.",
      );
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "waveWorkbench.previewVideProject",
      async (selected?: vscode.Uri, directory?: string) => {
        try {
          const viewer = getCurrent();
          const filelist =
            selected ??
            (
              await vscode.window.showOpenDialog({
                title: "Select the simulation filelist",
                filters: { Filelists: ["f", "F", "flist"] },
              })
            )?.[0];
          if (!filelist) return;
          const root =
            vscode.workspace.getWorkspaceFolder?.(filelist)?.uri.fsPath ??
            workspace ??
            path.dirname(filelist.fsPath);
          const buildDirectory =
            directory ??
            (await vscode.window.showInputBox({
              prompt: "Simulator working directory for relative filelist paths",
              value: path.dirname(filelist.fsPath),
            }));
          if (!buildDirectory) return;
          if (viewer && !viewer.disposed) await viewer.ready;
          const manifest = await readSimulationTrace(
            {
              filelist: filelist.fsPath,
              workingDirectory: path.resolve(root, buildDirectory),
            },
            viewer?.disposed ? undefined : viewer,
          );
          const document = await vscode.workspace.openTextDocument({
            language: "toml",
            content: previewVideManifest(manifest),
          });
          await vscode.window.showTextDocument(document);
        } catch (error) {
          report(error);
        }
      },
    ),
    vscode.commands.registerCommand(
      "waveWorkbench.useVideProject",
      async (selected?: vscode.Uri, directory?: string) => {
        try {
          const viewer = getCurrent();
          if (!viewer || viewer.disposed) throw Error("Open a waveform first.");
          const key = traceProjectKey(viewer);
          async function setSelection(
            selection: TraceProjectSelection | null | undefined,
          ) {
            if (viewer.disposed) return;
            if (viewer.document.projectPath) {
              if (selection === undefined)
                await context.workspaceState.update(key, undefined);
              if (viewer.disposed) return;
              viewer.document.traceProject = selection;
              viewer.document.dirty = true;
              projectChanges.fire({ document: viewer.document });
            } else {
              await context.workspaceState.update(key, selection);
            }
            dropTraceProject(viewer);
            clearViewerTrace(viewer);
          }
          if (!selected) {
            const action = await vscode.window.showQuickPick([
              "Choose simulation filelist",
              "Choose existing vide.toml",
              "Use automatic build manifest",
              "Use workspace VIDE project",
            ]);
            if (!action) return;
            if (action === "Use automatic build manifest") {
              await setSelection(undefined);
              return;
            }
            if (action === "Use workspace VIDE project") {
              await setSelection(null);
              return;
            }
            if (action === "Choose existing vide.toml") {
              selected = (
                await vscode.window.showOpenDialog({
                  title: "Select the existing vide.toml",
                  filters: { "VIDE project": ["toml"] },
                })
              )?.[0];
              if (!selected) return;
            }
          }
          if (selected && path.extname(selected.fsPath) === ".toml") {
            if (path.basename(selected.fsPath) !== "vide.toml")
              throw Error("Select a file named vide.toml.");
            await setSelection({ videManifest: selected.fsPath });
            return;
          }
          const filelist =
            selected ??
            (
              await vscode.window.showOpenDialog({
                title: "Select the simulation filelist",
                filters: { Filelists: ["f", "F", "flist"] },
              })
            )?.[0];
          if (!filelist) return;
          const workingDirectory =
            directory ??
            (await vscode.window.showInputBox({
              prompt: "Simulator working directory for relative filelist paths",
              value: path.dirname(filelist.fsPath),
            }));
          if (!workingDirectory || viewer.disposed) return;
          const selection = {
            filelist: filelist.fsPath,
            workingDirectory: path.resolve(
              path.dirname(filelist.fsPath),
              workingDirectory,
            ),
          };
          await setSelection(selection);
          void vscode.window.showInformationMessage(
            "Simulation filelist selected for " +
              path.basename(viewer.uri.fsPath),
          );
        } catch (error) {
          report(error);
        }
      },
    ),
  );
  return refreshRtlTarget;
}
