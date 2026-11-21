// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { localize } from "./shared/localization";
import type * as vscode from "vscode";

import {
  backendChoices,
  backendSetting,
  isFsdb,
  isShm,
  shmBackendChoices,
  type WaveBackend,
} from "./backend-selection";
import { quote } from "./commands";

import type { GetViewer, ReportError } from "./wave-extension-types";
import type { createWaveFiles } from "./wave-files";
import type { createWaveClipExport } from "./wave-clip-export";
import type { createWaveSourceNavigation } from "./wave-source-navigation";
import type { createWaveTcl } from "./wave-tcl";

type VSCodeApi = typeof vscode;

export function registerWaveCommands(
  vscode: VSCodeApi,
  {
    context,
    getCurrent,
    report,
    showCache,
    applyDebugLayout,
    openWaveform,
    openRecent,
    openProject,
    saveActiveProject,
    chooseClipExport,
    executeTcl,
    runScript,
  }: {
    context: vscode.ExtensionContext;
    getCurrent: GetViewer;
    report: ReportError;
    showCache: () => void;
    applyDebugLayout: ReturnType<
      typeof createWaveSourceNavigation
    >["applyDebugLayout"];
    openWaveform: ReturnType<typeof createWaveFiles>["openWaveform"];
    openRecent: ReturnType<typeof createWaveFiles>["openRecent"];
    openProject: ReturnType<typeof createWaveFiles>["openProject"];
    saveActiveProject: ReturnType<typeof createWaveFiles>["saveActiveProject"];
    chooseClipExport: ReturnType<
      typeof createWaveClipExport
    >["chooseClipExport"];
    executeTcl: ReturnType<typeof createWaveTcl>["executeTcl"];
    runScript: ReturnType<typeof createWaveTcl>["runScript"];
  },
) {
  for (const [id, handler] of Object.entries({
    debugLayout: () => applyDebugLayout(getCurrent(), true),
    configureLayout: async () => {
      const config = vscode.workspace.getConfiguration(
        "waveWorkbench",
        getCurrent()?.uri,
      );
      const autoSplit = config.get<boolean>("autoSplit") === true;
      const choice = await vscode.window.showQuickPick(
        [
          { label: localize("保持当前布局"), value: false, picked: !autoSplit },
          {
            label: localize("自动分屏"),
            description: localize(
              "打开波形或从波形跳转源码时，上方代码、下方波形",
            ),
            value: true,
            picked: autoSplit,
          },
        ],
        { title: localize("波形编辑器布局") },
      );
      if (!choice) return;
      await config.update(
        "autoSplit",
        choice.value,
        vscode.workspace.workspaceFolders?.length
          ? vscode.ConfigurationTarget.Workspace
          : vscode.ConfigurationTarget.Global,
      );
    },
    open: (uri) => openWaveform(uri),
    openPicker: () => openWaveform(undefined, { picker: true }),
    openRecent,
    selectBackend: async () => {
      const viewer = getCurrent();
      const cfg = vscode.workspace.getConfiguration(
        "waveWorkbench",
        viewer?.uri,
      );
      const filename = viewer?.uri.fsPath ?? "";
      const shm = isShm(filename);
      const setting = backendSetting(filename);
      const choices = shm ? shmBackendChoices : backendChoices;
      const preference = cfg.get<WaveBackend>(setting, "auto");
      const selection = await vscode.window.showQuickPick(
        choices.map((choice) => ({
          ...choice,
          label: localize(choice.label),
          description: localize(choice.description),
          picked: choice.value === preference,
          detail:
            viewer?.backendKind === choice.value
              ? localize("当前波形正在使用")
              : undefined,
        })),
        {
          title: localize(
            shm ? "选择 SHM / PSFXL 后端" : "选择 FSDB / KDB 后端",
          ),
        },
      );
      if (!selection) return;
      const label =
        viewer && (shm || isFsdb(filename))
          ? await viewer.switchBackend(selection.value)
          : selection.label;
      await cfg.update(
        setting,
        selection.value,
        vscode.workspace.workspaceFolders?.length
          ? vscode.ConfigurationTarget.Workspace
          : vscode.ConfigurationTarget.Global,
      );
      await vscode.window.showInformationMessage(`Wave Workbench · ${label}`);
    },
    openLast: () =>
      openWaveform(context.workspaceState.get<string>("lastWaveform")),
    runScript: (uri) => runScript(uri),
    exportClip: () => chooseClipExport(getCurrent()),
    saveProject: () => saveActiveProject(getCurrent()),
    openProject: (uri) => openProject(uri?.fsPath),
    runTcl: async () => {
      if (!getCurrent()) await openWaveform();
      if (!getCurrent()) return;
      const script = await vscode.window.showInputBox({
        title: "nWave Tcl",
        prompt: localize("输入 wv* 命令；waveHelp 查看支持列表"),
        placeHolder: "wvZoomAll; wvSetCursor 20",
      });
      if (script) await executeTcl(getCurrent(), script);
    },
    fit: () => executeTcl(getCurrent(), "wvZoomAll"),
    zoomIn: () => executeTcl(getCurrent(), "wvZoomIn"),
    zoomOut: () => executeTcl(getCurrent(), "wvZoomOut"),
    nextEdge: () => executeTcl(getCurrent(), "wvSearchNext"),
    previousEdge: () => executeTcl(getCurrent(), "wvSearchPrev"),
    setCursor: async () => {
      const value = await vscode.window.showInputBox({
        title: "nWave Set Cursor",
        prompt: localize("时间（当前窗口单位）"),
      });
      if (value) await executeTcl(getCurrent(), `wvSetCursor ${quote(value)}`);
    },
    setMarker: async () => {
      const value = await vscode.window.showInputBox({
        title: "nWave Set Marker",
        prompt: localize("时间（当前窗口单位）"),
      });
      if (value) await executeTcl(getCurrent(), `wvSetMarker ${quote(value)}`);
    },
    cacheStats: showCache,
    saveSignals: async () => {
      if (!getCurrent()) throw new Error("Open a waveform first");
      const uri = await vscode.window.showSaveDialog({
        filters: { "Replayable nWave Tcl": ["tcl"] },
      });
      if (uri)
        await executeTcl(getCurrent(), `wvSaveSignal ${quote(uri.fsPath)}`);
    },
    restoreSignals: async () => {
      const uri = (
        await vscode.window.showOpenDialog({
          filters: { "nWave Tcl": ["tcl", "rc"] },
          canSelectMany: false,
        })
      )?.[0];
      if (uri)
        await executeTcl(getCurrent(), `wvRestoreSignal ${quote(uri.fsPath)}`);
    },
  }))
    context.subscriptions.push(
      vscode.commands.registerCommand(
        "waveWorkbench." + id,
        async (...args) => {
          try {
            return await (handler as (...args: any[]) => unknown)(...args);
          } catch (e) {
            report(e);
          }
        },
      ),
    );
  if (vscode.window.createStatusBarItem) {
    const item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      80,
    );
    item.text = "$(pulse) 波形";
    item.tooltip = "Wave Workbench：一键打开默认或上次波形（Ctrl+Alt+W）";
    item.command = "waveWorkbench.open";
    item.show();
    context.subscriptions.push(item);
  }
  context.subscriptions.push(
    vscode.commands.registerCommand("waveWorkbench.attachKdb", async () => {
      try {
        if (getCurrent()) await getCurrent().attachKdb();
        else
          vscode.window.showInformationMessage(
            "Open a waveform before attaching its KDB.",
          );
      } catch (e) {
        report(e);
      }
    }),
  );
}
