// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { configureLanguage } from "./shared/localization";
import * as vscode from "vscode";
import type { Viewer, WaveDocument } from "./viewer";
import type { VideAnalysisApi } from "./rtl-trace";
import type { ReportError } from "./wave-extension-types";
import { createLiveDebugSession } from "./live-debug-session";
import { createWaveCachePanel } from "./wave-cache";
import { registerWaveDock } from "./wave-dock";
import { registerWaveTclConsole } from "./wave-tcl-console";
import { createWaveAnalysis } from "./wave-analysis";
import { createWaveClipExport } from "./wave-clip-export";
import { registerWaveCommands } from "./wave-commands";
import { createWaveDecoders } from "./wave-decoders";
import { registerWaveEditor } from "./wave-editor";
import { createWaveFiles } from "./wave-files";
import { registerWaveForegroundTools } from "./wave-foreground-tools";
import { createWaveSchematics } from "./wave-schematics";
import { createWaveSidebar } from "./wave-sidebar";
import { createWaveSourceNavigation } from "./wave-source-navigation";
import { createWaveTaskStatus } from "./wave-task-status";
import { createWaveTcl } from "./wave-tcl";
import { createWaveTraceView } from "./wave-trace-view";
import type { WaveToolHandler } from "./wave-tools";
import {
  createTraceProjectSelection,
  registerWaveVideProject,
} from "./wave-vide-project";

export function activate(context: vscode.ExtensionContext) {
  configureLanguage(vscode.env?.language);
  const trackTask = createWaveTaskStatus(vscode, context);
  const output = vscode.window.createOutputChannel("Wave Workbench");
  const projectChanges = new vscode.EventEmitter<
    vscode.CustomDocumentContentChangeEvent<WaveDocument>
  >();
  const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const viewers = new Set<Viewer>();
  let current: Viewer | undefined;
  let sidebar: ReturnType<typeof createWaveSidebar> | undefined;
  let tclConsole: ReturnType<typeof registerWaveTclConsole> | undefined;
  let live: ReturnType<typeof createLiveDebugSession> | undefined;
  let automation: WaveToolHandler | undefined;
  let refreshRtlTarget: (() => void) | undefined;
  const getCurrent = () => current;
  const getLive = () => live?.getLatest();
  const setCurrent = (viewer: Viewer) => {
    current = viewer;
    refreshRtlTarget?.();
  };
  const refreshSidebar = () => {
    refreshRtlTarget?.();
    tclConsole?.refresh();
    return sidebar?.refresh();
  };
  const report: ReportError = (error) => {
    output.appendLine(error.stack || String(error));
    if (!error.sidebarLogged)
      sidebar?.log("ERROR: " + (error.message || String(error)));
    vscode.window.showErrorMessage(
      "Wave Workbench: " + (error.message || error),
    );
  };
  context.subscriptions.push(output, projectChanges);

  const traceProjectSelection = createTraceProjectSelection(context);
  const analyses = createWaveAnalysis<Viewer>(
    {
      file: vscode.Uri.file,
      position: (line, character) => new vscode.Position(line, character),
      cancellation: () => new vscode.CancellationTokenSource(),
      getVide: async () =>
        vscode.extensions
          .getExtension<VideAnalysisApi>("pascal-lab.vide-code-extension")
          ?.activate(),
      workspace: vscode.workspace,
    },
    traceProjectSelection,
    getLive,
    trackTask,
  );
  context.subscriptions.push(analyses);

  const decoders = createWaveDecoders(vscode, { context, output, viewers });
  const source = createWaveSourceNavigation(vscode, {
    context,
    output,
    getCurrent,
    refreshSidebar,
    logSidebar: (message, waveform) => sidebar?.log(message, waveform),
    report,
    sourceLocation: analyses.sourceLocation,
    dumpScope: analyses.dumpScope,
  });
  const files = createWaveFiles(vscode, {
    context,
    output,
    viewers,
    setCurrent,
    traceProjectSelection,
    dropTraceProject: analyses.dropTraceProject,
    invalidateEditorSync: source.invalidateEditorSync,
  });
  const clips = createWaveClipExport(vscode, {
    trackTask,
    decodeWindow: decoders.decodeWindow,
  });
  const tcl = createWaveTcl(vscode, {
    getCurrent,
    getAutomation: () => automation,
    output,
    trackTask,
    logTcl: (viewer, text) => sidebar?.logTcl(viewer, text),
    rememberScript: (script) => sidebar?.rememberScript(script),
    refreshSidebar,
    decodeWindow: decoders.decodeWindow,
    decoderConfigPath: decoders.decoderConfigPath,
    openWaveform: files.openWaveform,
    resolvePath: files.resolvePath,
  });
  sidebar = createWaveSidebar(vscode, {
    context,
    viewers,
    getCurrent,
    setCurrent,
    dumpScope: analyses.dumpScope,
    executeTcl: tcl.executeTcl,
    openKdbSource: source.openKdbSource,
    revealScope: source.revealScope,
  });
  const trace = createWaveTraceView(vscode, {
    context,
    getCurrent,
    analyses,
    output,
    report,
    traceProjectSelection,
    getLive,
    restoreWaveformViewer: files.restoreWaveformViewer,
  });
  const schematics = createWaveSchematics(vscode, {
    context,
    getCurrent,
    output,
    report,
    trackTask,
    traceProjectSelection,
    restoreWaveformViewer: files.restoreWaveformViewer,
    getTraceSnapshot: trace.getTraceSnapshot,
    traceSubject: trace.traceSubject,
    bindTraceObservations: analyses.bindTraceObservations,
    queryWaveSchematic: analyses.queryWaveSchematic,
    moduleSchematicReader: analyses.moduleSchematicReader,
    dumpScope: analyses.dumpScope,
  });
  live = createLiveDebugSession(vscode, {
    context,
    getCurrent,
    workspace,
    output,
    report,
    trackTask,
    clearTraceContinuation: trace.clearTraceContinuation,
    showSignalTrace: trace.showSignalTrace,
  });

  automation = registerWaveForegroundTools(vscode, {
    context,
    getCurrent,
    workspace,
    output,
    trackTask,
    viewers,
    openWaveform: files.openWaveform,
    openProject: files.openProject,
    saveProject: files.saveProject,
    exportClipArtifact: clips.exportClipArtifact,
    includeClipDecoder: clips.includeClipDecoder,
    createAnalysisTools: analyses.tools,
    handleLiveTool: live.handleTool,
    openKdbSource: source.openKdbSource,
    showWaveSchematic: schematics.showWaveSchematic,
    showModuleSchematic: schematics.showModuleSchematic,
    decodeWindow: decoders.decodeWindow,
    decoderConfigPath: decoders.decoderConfigPath,
    listWaveDecoders: decoders.listWaveDecoders,
    executeTclWithLogs: tcl.executeTclWithLogs,
  });

  const dock = registerWaveDock(vscode, context, getCurrent);
  tclConsole = registerWaveTclConsole(
    vscode,
    context,
    getCurrent,
    viewers,
    tcl.executeInteractive,
  );
  registerWaveEditor(vscode, context, {
    liveCaptureFor: (filename) => live?.captureFor(filename),
    trackTask,
    viewers,
    projectChanges,
    output,
    refreshSidebar,
    setCurrent,
    dockWave: dock.show,
    undockWave: dock.remove,
    showTclConsole: tclConsole.show,
    removeCurrent(viewer) {
      dock.remove(viewer);
      trace.clearViewerTrace(viewer);
      analyses.dropTraceProject(viewer);
      if (current === viewer) current = [...viewers].at(-1);
    },
    dropTraceProject: analyses.dropTraceProject,
    scheduleEditorSync: source.scheduleEditorSync,
    refreshTraceCursor: trace.refreshTraceCursor,
    rememberFile: files.rememberFile,
    applyDebugLayout: source.applyDebugLayout,
    executeTcl: tcl.executeTcl,
    openWaveform: files.openWaveform,
    openRecent: files.openRecent,
    selectDecoder: decoders.selectDecoder,
    editDecoderConfig: decoders.editDecoderConfig,
    decoderConfigPath: decoders.decoderConfigPath,
    configureWaveDecoder: decoders.configureWaveDecoder,
    manageWaveDecoders: decoders.manageWaveDecoders,
    materializeDecoderSignal: decoders.materializeDecoderSignal,
    decodeWindow: decoders.decodeWindow,
    updateSidebarTags: sidebar.updateSidebarTags,
    saveActiveProject: files.saveActiveProject,
    saveProject: files.saveProject,
    openProject: files.openProject,
    chooseClipExport: clips.chooseClipExport,
    runScript: tcl.runScript,
    openKdbSource: source.openKdbSource,
    showSignalTrace: trace.showSignalTrace,
    showWaveSchematic: schematics.showWaveSchematic,
    showWaveModuleSchematic: schematics.showWaveModuleSchematic,
    showCurrentTraceSchematic: schematics.showCurrentTraceSchematic,
    sidebarTree: sidebar.sidebarTree,
  });
  registerWaveCommands(vscode, {
    context,
    getCurrent,
    report,
    showCache: createWaveCachePanel(vscode, context, getCurrent, viewers),
    openWaveform: files.openWaveform,
    openRecent: files.openRecent,
    openProject: files.openProject,
    saveActiveProject: files.saveActiveProject,
    applyDebugLayout: source.applyDebugLayout,
    chooseClipExport: clips.chooseClipExport,
    executeTcl: tcl.executeTcl,
    runScript: tcl.runScript,
  });
  refreshRtlTarget = registerWaveVideProject(vscode, {
    context,
    getCurrent,
    workspace,
    report,
    projectChanges,
    readSimulationTrace: analyses.readSimulationTrace,
    dropTraceProject: analyses.dropTraceProject,
    clearViewerTrace: trace.clearViewerTrace,
    openRtlTarget: source.openRtlTarget,
  });
  context.subscriptions.push({
    dispose() {
      for (const v of viewers) {
        v.backend.dispose();
        v.kdb?.dispose();
        v.tcl?.dispose();
      }
    },
  });
}
