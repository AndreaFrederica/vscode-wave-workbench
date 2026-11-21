// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { localize } from "./shared/localization";
import type { Viewer } from "./viewer";
import type * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs";

import { loadDecoderProfiles } from "./decoder-config";
import { tclWaveTool, type WaveToolHandler } from "./wave-tools";
import { WaveCommands, HELP, quote } from "./commands";
import { TclRunner } from "./tcl";

import type { GetViewer, TrackTask } from "./wave-extension-types";
import type { createWaveFiles } from "./wave-files";
import type { createWaveDecoders } from "./wave-decoders";

type VSCodeApi = typeof vscode;
type InteractiveTcl = {
  signal: AbortSignal;
  write: (text: string) => void;
  structured?: (text: string) => void;
};

const structuredCommands = new Set([
  "waveView",
  "waveFindSignals",
  "waveGetEvents",
  "waveMeasureAnalog",
  "waveDecodeEvents",
  "waveDecodeTransactions",
  "waveTool",
]);

export function createWaveTcl(
  vscode: VSCodeApi,
  {
    getCurrent,
    getAutomation,
    output,
    trackTask,
    logTcl,
    rememberScript,
    refreshSidebar,
    decodeWindow,
    decoderConfigPath,
    openWaveform,
    resolvePath,
  }: {
    getCurrent: GetViewer;
    getAutomation: () => WaveToolHandler | undefined;
    output: vscode.OutputChannel;
    trackTask: TrackTask;
    logTcl: (viewer: Viewer | null, text: string) => void;
    rememberScript: (script: string) => void;
    refreshSidebar: () => void;
    decodeWindow: ReturnType<typeof createWaveDecoders>["decodeWindow"];
    decoderConfigPath: ReturnType<
      typeof createWaveDecoders
    >["decoderConfigPath"];
    openWaveform: ReturnType<typeof createWaveFiles>["openWaveform"];
    resolvePath: ReturnType<typeof createWaveFiles>["resolvePath"];
  },
) {
  const tclOutput = new Map<Viewer, string[]>();
  const consoles = new Map<Viewer, InteractiveTcl>();
  async function executeTcl(
    viewer: Viewer,
    script: string,
    directory?: string,
  ) {
    return trackTask(localize("执行波形 Tcl"), viewer?.uri.fsPath, () =>
      runTcl(viewer, script, directory),
    );
  }

  async function runTcl(
    viewer: Viewer,
    script: string,
    directory?: string,
    interactive?: InteractiveTcl,
  ) {
    if (!interactive) rememberScript(script);
    if (!viewer) {
      if (script.trim() === "waveHelp") {
        logTcl(null, HELP);
        return HELP;
      }
      throw new Error(localize("先打开波形，再执行 nWave Tcl 命令"));
    }
    if (viewer.running)
      throw new Error(localize("当前波形已有 Tcl 指令正在执行"));
    if (viewer.panel.visible === false)
      viewer.panel.reveal(viewer.panel.viewColumn, true);
    await viewer.ready;
    interactive?.signal.throwIfAborted();
    if (viewer.running)
      throw new Error(localize("当前波形已有 Tcl 指令正在执行"));
    if (viewer.disposed || !viewer.meta)
      throw new Error(localize("波形未加载成功，请重新打开"));
    if (!viewer.tcl || viewer.tcl.closed) {
      let target = viewer;
      const engine = new WaveCommands({
        getViewer: () => target,
        decoderProfiles: (viewer) =>
          loadDecoderProfiles(decoderConfigPath(viewer)),
        decodeTransactions: decodeWindow,
        open: async (file) => {
          const filename = resolvePath(
            file,
            target.scriptDirectory || path.dirname(target.uri.fsPath),
          );
          if (!fs.existsSync(filename))
            throw new Error("Waveform not found: " + filename);
          const next = await openWaveform(filename);
          if (!next) throw new Error("Waveform open was cancelled");
          target = next;
        },
        scope: async (name) => {
          if (!target.kdb && !(await target.attachKdb()))
            throw new Error("No KDB attached");
          await target.showHierarchy(name);
        },
      });
      function executeCommand(
        name: string,
        args: Parameters<WaveCommands["execute"]>[1],
      ) {
        if (name === "waveTool") {
          const automation = getAutomation();
          if (!automation)
            throw Error("Wave Workbench requires an open workspace.");
          return Promise.resolve(
            tclWaveTool(automation, args, undefined, target.uri.fsPath),
          ).then((result) => {
            if (args[0]?.value === "wave_open" && getCurrent())
              target = getCurrent();
            return result;
          });
        }
        return engine.execute(name, args);
      }
      viewer.tcl = new TclRunner(
        async (name, args, dir) => {
          target.scriptDirectory = dir;
          const result = await executeCommand(name, args);
          if (structuredCommands.has(name))
            consoles.get(viewer)?.structured?.(result);
          return result;
        },
        {
          executable:
            vscode.workspace
              .getConfiguration("waveWorkbench")
              .get<string>("tclshPath") || undefined,
          log: (text) => {
            const lines = tclOutput.get(viewer);
            if (lines && lines.length < 500) lines.push(text.slice(0, 4096));
            consoles.get(viewer)?.write(text);
            output.appendLine(text);
            logTcl(viewer, text);
          },
        },
      );
    }
    const runner = viewer.tcl;
    const interrupt = () => runner.dispose();
    viewer.running = true;
    refreshSidebar();
    try {
      if (interactive) {
        if (!(await runner.isComplete(script))) return undefined;
        interactive.signal.throwIfAborted();
        rememberScript(script);
        interactive.signal.addEventListener("abort", interrupt, { once: true });
        consoles.set(viewer, interactive);
      }
      logTcl(viewer, "> " + script);
      const result = await runner.run(
        script,
        directory || path.dirname(viewer.uri.fsPath),
      );
      logTcl(viewer, result || "OK");
      return result;
    } catch (e) {
      logTcl(
        viewer,
        interactive?.signal.aborted
          ? localize("Tcl 已中断")
          : "ERROR: " + e.message,
      );
      e.sidebarLogged = true;
      throw e;
    } finally {
      if (interactive) {
        interactive.signal.removeEventListener("abort", interrupt);
        consoles.delete(viewer);
      }
      viewer.running = false;
      refreshSidebar();
    }
  }
  async function runScript(uri?: vscode.Uri) {
    uri ||= (
      await vscode.window.showOpenDialog({
        title: localize("运行 nWave Tcl / RC 脚本"),
        filters: { Scripts: ["tcl", "rc"] },
        canSelectMany: false,
      })
    )?.[0];
    if (!uri) return;
    if (!getCurrent()) await openWaveform();
    if (!getCurrent()) return;
    return executeTcl(
      getCurrent(),
      `source ${quote(uri.fsPath)}`,
      path.dirname(uri.fsPath),
    );
  }

  async function executeTclWithLogs(viewer: Viewer, script: string) {
    if (viewer.running || tclOutput.has(viewer))
      throw Error("A Tcl script is running in this view");
    const logs: string[] = [];
    tclOutput.set(viewer, logs);
    try {
      const result = await executeTcl(viewer, script);
      return { result, logs };
    } finally {
      tclOutput.delete(viewer);
    }
  }

  const executeInteractive = (
    viewer: Viewer,
    script: string,
    interactive: InteractiveTcl,
  ) => runTcl(viewer, script, undefined, interactive);

  return { executeTcl, executeTclWithLogs, executeInteractive, runScript };
}
