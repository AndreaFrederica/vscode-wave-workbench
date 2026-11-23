// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { Viewer } from "./viewer";
import type * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs";

import { isWaveform } from "./backend-selection";
import { restoreView } from "./view-state";
import {
  designSnapshot,
  readWaveProject,
  saveWaveProject,
  type TraceProjectSelection,
} from "./project";

import type { WaveAnalysis } from "./wave-extension-types";

type VSCodeApi = typeof vscode;

export function createWaveFiles(
  vscode: VSCodeApi,
  {
    context,
    output,
    viewers,
    setCurrent,
    traceProjectSelection,
    dropTraceProject,
    invalidateEditorSync,
  }: {
    context: vscode.ExtensionContext;
    output: vscode.OutputChannel;
    viewers: Set<Viewer>;
    setCurrent: (viewer: Viewer) => void;
    traceProjectSelection: (
      viewer: Viewer,
    ) => TraceProjectSelection | null | undefined;
    dropTraceProject: WaveAnalysis["dropTraceProject"];
    invalidateEditorSync: () => void;
  },
) {
  const resolvePath = (file: string, base?: string) =>
    path.isAbsolute(file)
      ? file
      : path.resolve(
          base ||
            vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ||
            process.cwd(),
          file,
        );
  const previousWaveform = context.workspaceState.get<string>("lastWaveform");
  let recentFiles = context.workspaceState.get<string[]>(
    "recentWaveFiles",
    previousWaveform ? [previousWaveform] : [],
  );
  function rememberFile(filename: string) {
    recentFiles = [
      filename,
      ...recentFiles.filter((entry) => entry !== filename),
    ].slice(0, 20);
    return context.workspaceState.update("recentWaveFiles", recentFiles);
  }
  async function openRecent() {
    const entries = await Promise.all(
      recentFiles.map(async (filename) => ({
        label: path.basename(filename),
        description: path.dirname(filename),
        filename,
        exists: await fs.promises.stat(filename).then(
          (info) => info.isFile(),
          () => false,
        ),
      })),
    );
    const available = entries.filter((entry) => entry.exists);
    if (!available.length) {
      await vscode.window.showInformationMessage("没有可打开的最近波形文件");
      return;
    }
    const selection = await vscode.window.showQuickPick(available, {
      title: "最近打开的波形和工程",
      placeHolder: "选择 FSDB、FST、VCD 或波形工程",
      matchOnDescription: true,
    });
    if (!selection) return;
    if (/\.waveproj$/i.test(selection.filename))
      await openProject(selection.filename);
    else await openWaveform(selection.filename);
  }
  async function openWaveform(
    candidate?: string | vscode.Uri,
    { picker = false } = {},
  ) {
    let filename =
      typeof candidate === "string" ? candidate : candidate?.fsPath;
    if (filename && !isWaveform(filename)) filename = undefined;
    if (!filename && !picker)
      filename =
        vscode.workspace
          .getConfiguration("waveWorkbench")
          .get("defaultWaveform") || context.workspaceState.get("lastWaveform");
    if (filename) {
      filename = resolvePath(filename);
      if (!fs.existsSync(filename)) filename = undefined;
    }
    if (!filename)
      filename = (
        await vscode.window.showOpenDialog({
          title: "打开波形",
          filters: {
            Waveforms: [
              "fsdb",
              "fst",
              "vcd",
              "dsn",
              "trn",
              "psfxl",
              "dat",
              "psfbin",
              "psf",
              "ac",
              "dc",
              "noise",
              "info",
              "pz",
              "xf",
              "stb",
              "sparam",
              "sweep",
              "sp",
              "wdb",
              "wlf",
              "raw",
              "psfascii",
              "tran",
            ],
          },
          canSelectMany: false,
        })
      )?.[0]?.fsPath;
    if (!filename) return;
    if (/\.shm$/i.test(filename)) {
      const files = await fs.promises.readdir(filename);
      const designs = files.filter((file) => /\.dsn$/i.test(file));
      const preferredDesign = designs.find(
        (file) => path.parse(file).name === path.parse(filename).name,
      );
      const component =
        preferredDesign ??
        (designs.length === 1 ? designs[0] : undefined) ??
        (designs.length === 0
          ? (files.find((file) => /\.psfxl$/i.test(file)) ??
            files.find((file) => /\.tran\.dat$/i.test(file)))
          : undefined);
      if (!component) throw Error("无法确定 SHM 波形的 DSN 或 PSFXL 组件");
      filename = path.join(filename, component);
    }
    const uri = vscode.Uri.file(filename);
    await context.workspaceState.update("lastWaveform", filename);
    const findViewer = () =>
      [...viewers].find((v) => v.uri.fsPath === filename);
    let viewer = findViewer();
    if (!viewer) {
      await vscode.commands.executeCommand(
        "vscode.openWith",
        uri,
        "waveWorkbench.viewer",
      );
      viewer = findViewer();
    }
    if (viewer) {
      viewer.panel.reveal?.();
      await viewer.ready;
      if (viewer.meta && !viewer.disposed) await rememberFile(filename);
      return viewer;
    }
  }
  async function saveProject(
    viewer: Viewer,
    filename?: string,
    cancellation?: vscode.CancellationToken,
  ) {
    if (!viewer) throw new Error("先打开波形");
    await viewer.ready;
    const document = viewer.document;
    filename ||=
      document.projectPath ||
      (
        await vscode.window.showSaveDialog({
          title: "保存波形工程",
          defaultUri: vscode.Uri.file(
            viewer.uri.fsPath.replace(/\.[^.]+$/, "") + ".waveproj",
          ),
          filters: { "Wave Workbench": ["waveproj"] },
        })
      )?.fsPath;
    if (!filename || cancellation?.isCancellationRequested) return;
    if (!/\.waveproj$/i.test(filename)) filename += ".waveproj";
    const view = viewer.panel.visible
      ? await viewer.ui("snapshot")
      : document.view || document.savedView;
    if (!view) throw Error("波形视图尚未就绪");
    const design = viewer.kdb;
    const verilator = design?.kind === "verilator";
    const designView = designSnapshot(viewer);
    const traceProject = traceProjectSelection(viewer);
    const rtlBinding = document.rtlBinding;
    if (cancellation?.isCancellationRequested) return;
    await saveWaveProject(
      filename,
      viewer.uri.fsPath,
      view,
      verilator ? undefined : design?.path,
      verilator ? design.path : undefined,
      designView,
      traceProject,
      rtlBinding,
    );
    document.projectPath = filename;
    document.savedView = view;
    document.savedKdb = design?.path;
    document.savedDesignView = designView;
    document.traceProject = document.savedTraceProject = traceProject;
    document.savedRtlBinding = rtlBinding;
    await rememberFile(filename);
    return filename;
  }
  async function saveActiveProject(viewer: Viewer) {
    if (!viewer) throw Error("先打开波形");
    viewer.panel.reveal(viewer.panel.viewColumn);
    await vscode.commands.executeCommand("workbench.action.files.save");
  }
  async function openProject(filename?: string) {
    filename ||= (
      await vscode.window.showOpenDialog({
        filters: { "Wave Workbench": ["waveproj"] },
        canSelectMany: false,
      })
    )?.[0]?.fsPath;
    if (!filename) return;
    const project = await readWaveProject(filename);
    if (!isWaveform(project.waveform) || !fs.existsSync(project.waveform))
      throw Error("Waveform not found: " + project.waveform);
    const viewer = await openWaveform(project.waveform);
    if (!viewer) throw Error("无法打开工程的波形");
    const document = viewer.document;
    if (document.dirty) {
      const choice = await vscode.window.showWarningMessage(
        "当前波形有未保存的工程改动。",
        { modal: true },
        "保存工程",
        "不保存",
      );
      if (choice === "保存工程") {
        await saveActiveProject(viewer);
        if (document.dirty) return;
      } else if (choice !== "不保存") return;
    }
    const view = await restoreView(viewer.backend, project.view, viewer.meta);
    document.rtlBinding = document.savedRtlBinding = project.rtlBinding;
    viewer.sourceInstances.clear();
    viewer.syncedEditor = undefined;
    invalidateEditorSync();
    const database = project.verilator || project.kdb;
    if (
      database &&
      (!viewer.kdb || path.resolve(viewer.kdb.path) !== database)
    ) {
      if (fs.existsSync(database)) await viewer.attachKdb(database, false);
      else {
        output.appendLine(
          "Wave project design database not found: " + database,
        );
        void vscode.window.showWarningMessage(
          "波形工程找不到设计数据库 " + database,
        );
      }
    }
    if (
      viewer.kdb &&
      (!database || viewer.kdb.path === database) &&
      (project.designView || project.rtlBinding)
    ) {
      invalidateEditorSync();
      await viewer.restoreDesignView(
        project.designView ?? {
          selected: project.rtlBinding!.dutInstance,
          expanded: [],
          includeOther: false,
        },
      );
    }
    await viewer.ui("restoreView", { ...view, projectBaseline: true });
    document.projectPath = filename;
    document.savedView = document.view || view;
    document.savedKdb = viewer.kdb?.path;
    document.savedDesignView = designSnapshot(viewer);
    document.traceProject = document.savedTraceProject = project.traceProject;
    dropTraceProject(viewer);
    await rememberFile(filename);
    setCurrent(viewer);
    if (document.dirty) await saveActiveProject(viewer);
    return viewer;
  }
  async function restoreWaveformViewer(filename: string | undefined) {
    if (!filename || !isWaveform(filename) || !fs.existsSync(filename)) return;
    const existing = [...viewers].find(
      (viewer) => !viewer.disposed && viewer.uri.fsPath === filename,
    );
    if (existing) {
      await existing.ready;
      if (!existing.disposed && !existing.openError) return existing;
    }
    return openWaveform(filename);
  }

  return {
    resolvePath,
    openWaveform,
    openRecent,
    saveProject,
    saveActiveProject,
    openProject,
    rememberFile,
    restoreWaveformViewer,
  };
}
