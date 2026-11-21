// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { Viewer, WaveDocument } from "./viewer";
import type * as vscode from "vscode";
import * as path from "node:path";

import { type TraceProjectSelection } from "./project";

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
  },
) {
  context.subscriptions.push(
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
}
