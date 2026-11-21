// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type * as vscode from "vscode";
import type { Viewer, WaveDocument } from "./viewer";
import {
  createWaveDocuments,
  type WaveDocumentActions,
} from "./wave-documents";
import type { WaveState } from "./shared/protocol";
import { backendPlan, type WaveBackend } from "./backend-selection";
import { mapPrefix } from "./kdb";
import { configureWaveEditorBackend } from "./wave-editor-backend";
import { createWaveEditorSurfaces } from "./wave-editor-surfaces";
import {
  createWaveEditorDecoders,
  type WaveEditorDecoderActions,
} from "./wave-editor-decoders";
import type { TrackTask } from "./wave-extension-types";
import { handleWaveOperation } from "./wave-editor-operations";
import { createWaveEditorQueries } from "./wave-editor-queries";
import type { createWaveSchematics } from "./wave-schematics";

interface EditorActions
  extends WaveEditorDecoderActions,
    Pick<
      ReturnType<typeof createWaveSchematics>,
      | "showWaveSchematic"
      | "showWaveModuleSchematic"
      | "showCurrentTraceSchematic"
    > {
  trackTask: TrackTask;
  viewers: Set<Viewer>;
  projectChanges: vscode.EventEmitter<
    vscode.CustomDocumentContentChangeEvent<WaveDocument>
  >;
  output: vscode.OutputChannel;
  refreshSidebar(): void;
  setCurrent(viewer: Viewer): void;
  dockWave(viewer: Viewer): Promise<void>;
  undockWave(viewer: Viewer): void;
  showTclConsole(viewer: Viewer): Promise<void>;
  removeCurrent(viewer: Viewer): void;
  scheduleEditorSync(editor?: vscode.TextEditor): void;
  refreshTraceCursor(viewer: Viewer, tick: number): void;
  rememberFile(filename: string): Thenable<void>;
  applyDebugLayout(viewer: Viewer): Promise<void>;
  executeTcl(viewer: Viewer, script: string): Promise<unknown>;
  openWaveform(
    candidate?: string | vscode.Uri,
    options?: { picker?: boolean },
  ): Promise<Viewer | undefined>;
  openRecent(): Promise<void>;
  updateSidebarTags(viewer: Viewer, view: WaveState): void;
  saveActiveProject(viewer: Viewer): Promise<unknown>;
  openProject(filename?: string): Promise<unknown>;
  chooseClipExport(viewer: Viewer): Promise<unknown>;
  runScript(uri?: vscode.Uri): Promise<unknown>;
  openKdbSource(
    viewer: Viewer,
    fullname: string,
    target: string,
  ): Promise<void>;
  showSignalTrace(
    viewer: Viewer,
    signal: string,
    mode: "drivers" | "loads" | "context" | "recordedContext" | "execution",
    tick?: string,
    executionFile?: string,
    changeOrder?: number,
    followContinuations?: boolean,
  ): Promise<void>;
  sidebarTree(scope: string, action: string): Promise<unknown>;
}

export function registerWaveEditor(
  vscode: typeof import("vscode"),
  context: vscode.ExtensionContext,
  actions: EditorActions & WaveDocumentActions,
) {
  const provider: vscode.CustomEditorProvider<WaveDocument> = {
    ...createWaveDocuments(vscode, actions),
    resolveCustomEditor: createWaveEditor(vscode, context, actions),
  };
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      "waveWorkbench.viewer",
      provider,
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false,
      },
    ),
  );
}

function createWaveEditor(
  vscode: typeof import("vscode"),
  context: vscode.ExtensionContext,
  actions: EditorActions,
) {
  const {
    trackTask,
    viewers,
    projectChanges,
    output,
    refreshSidebar,
    setCurrent,
    dockWave,
    undockWave,
    showTclConsole,
    removeCurrent,
    scheduleEditorSync,
    refreshTraceCursor,
    rememberFile,
    applyDebugLayout,
    executeTcl,
    openWaveform,
    openRecent,
    updateSidebarTags,
    saveActiveProject,
    openProject,
    chooseClipExport,
    runScript,
    openKdbSource,
    showSignalTrace,
    showWaveSchematic,
    showWaveModuleSchematic,
    showCurrentTraceSchematic,
    sidebarTree,
  } = actions;
  return async function resolveCustomEditor(
    document: WaveDocument,
    panel: vscode.WebviewPanel,
  ) {
    const cfg = vscode.workspace.getConfiguration(
      "waveWorkbench",
      document.uri,
    );
    const log = (message: string) => output.append(message);
    const choosePlan = (choice?: WaveBackend) =>
      backendPlan(
        context,
        vscode.workspace.getConfiguration("waveWorkbench", document.uri),
        document.uri.fsPath,
        log,
        choice,
      );
    const plan = choosePlan();
    const viewer = {
      document,
      get panel() {
        return surfaces.panel;
      },
      backend: plan.createWave(),
      backendKind: plan.kind,
      meta: null,
      uri: document.uri,
      kdb: null,
      treeCache: new Map(),
      treeExpanded: new Set(),
      sourceInstances: new Map(),
      selectedScope: "",
      scopeHistory: [],
      scopeIndex: -1,
      pendingUI: new Map(),
      uiSequence: 0,
    } as Viewer;
    const surfaces = createWaveEditorSurfaces(vscode, context, viewer, panel, {
      metadata: () => metadataMessage(viewer.meta),
      receive,
      setCurrent,
      refreshSidebar,
    });
    viewer.ready = new Promise((resolve) => {
      viewer.resolveReady = resolve;
    });
    viewer.ui = (action, payload = {}) =>
      new Promise((resolve, reject) => {
        if (viewer.disposed) {
          reject(new Error("Wave window is closed"));
          return;
        }
        const id = ++viewer.uiSequence;
        const timer = setTimeout(() => {
          viewer.pendingUI.delete(id);
          reject(new Error("Wave view did not respond to " + action));
        }, 30000);
        viewer.pendingUI.set(id, { resolve, reject, timer });
        const surface = viewer.panel.webview;
        void surface.postMessage({ type: "ui", id, action, payload }).then(
          (sent) => {
            if (sent !== false || !viewer.pendingUI.delete(id)) return;
            clearTimeout(timer);
            reject(Error("波形视图当前不可用"));
          },
          (error) => {
            if (!viewer.pendingUI.delete(id)) return;
            clearTimeout(timer);
            reject(error);
          },
        );
      });
    viewers.add(viewer);
    setCurrent(viewer);
    refreshSidebar();
    panel.onDidChangeViewState(() => {
      surfaces.syncEditorSurface();
      if (panel.active) {
        setCurrent(viewer);
        refreshSidebar();
      }
    });
    const decoders = createWaveEditorDecoders(vscode, viewer, actions);
    panel.onDidDispose(() => {
      decoders.dispose();
      viewer.disposed = true;
      viewer.resolveReady(null);
      viewer.backend.dispose();
      viewer.kdb?.dispose();
      viewer.tcl?.dispose();
      for (const p of viewer.pendingUI.values()) {
        clearTimeout(p.timer);
        p.reject(new Error("Wave window closed"));
      }
      viewer.pendingUI.clear();
      viewers.delete(viewer);
      removeCurrent(viewer);
      refreshSidebar();
    });
    const sendError = (surface: vscode.Webview, e, origin, request) =>
      surface.postMessage({
        type: "error",
        origin,
        request,
        message: e.message || String(e),
      });
    const { openInitial, initialize, metadataMessage } =
      configureWaveEditorBackend(vscode, viewer, choosePlan, plan, {
        context,
        cfg,
        log,
        trackTask,
        refreshSidebar,
        scheduleEditorSync,
        projectChanges,
        rememberFile,
        applyDebugLayout,
      });
    const receiveQuery = createWaveEditorQueries(viewer, cfg, refreshSidebar);
    async function receive(surface: vscode.Webview, msg) {
      let backend = viewer.backend;
      try {
        if (msg.type === "ready" && surface !== panel.webview) {
          surfaces.acceptDockReady(surface);
          return;
        }
        if (msg.type === "undockWave") {
          undockWave(viewer);
          panel.reveal(panel.viewColumn);
          surfaces.syncEditorSurface();
          return;
        }
        if (surface !== viewer.panel.webview && msg.type !== "uiResult") return;
        const decoderRequest = decoders.receive(surface, msg);
        if (decoderRequest) return await decoderRequest;
        const query = receiveQuery(backend, surface, msg);
        if (query) return await query;
        if (msg.type === "dockWave") {
          document.view = await viewer.ui("snapshot");
          await dockWave(viewer);
        } else if (msg.type === "showTclConsole") {
          await showTclConsole(viewer);
        } else if (msg.type === "ready") {
          if (viewer.meta) {
            await initialize(backend, viewer.meta);
            return;
          }
          await trackTask("打开波形", viewer.uri.fsPath, async () => {
            const opened = await openInitial(backend);
            if (!opened) return;
            backend = opened.backend;
            await initialize(backend, opened.meta);
          });
        } else if (msg.type === "rtlCursor") {
          if (
            viewer.meta &&
            Number.isSafeInteger(msg.tick) &&
            msg.tick >= Number(viewer.meta.start) &&
            msg.tick <= Number(viewer.meta.end) &&
            Number.isFinite(msg.displayFactor) &&
            msg.displayFactor > 0
          ) {
            viewer.rtlCursor = {
              tick: msg.tick,
              displayFactor: msg.displayFactor,
              displayScale:
                typeof msg.displayScale === "string" ? msg.displayScale : null,
            };
            refreshTraceCursor(viewer, msg.tick);
          }
        } else if (msg.type === "projectState" && msg.view) {
          document.view = msg.view;
          updateSidebarTags(viewer, document.view);
          if (msg.baseline) {
            if (!document.dirty) document.savedView = document.view;
          } else {
            document.dirty = true;
            projectChanges.fire({ document });
          }
        } else if (msg.type === "dockSelection" && Array.isArray(msg.keys)) {
          surfaces.updateSelection(msg);
        } else if (msg.type === "uiResult") {
          const p = viewer.pendingUI.get(msg.id);
          if (p) {
            viewer.pendingUI.delete(msg.id);
            clearTimeout(p.timer);
            if (msg.error) p.reject(new Error(msg.error));
            else p.resolve(msg.result);
          }
        } else if (
          msg.type === "executeTcl" &&
          typeof msg.script === "string"
        ) {
          await executeTcl(viewer, msg.script);
        } else if (msg.type === "openWaveform") {
          await openWaveform(undefined, { picker: true });
        } else if (msg.type === "selectBackend") {
          setCurrent(viewer);
          await vscode.commands.executeCommand("waveWorkbench.selectBackend");
        } else if (msg.type === "openRecent") {
          await openRecent();
        } else if (msg.type === "saveProject") {
          await saveActiveProject(viewer);
        } else if (msg.type === "openProject") {
          await openProject();
        } else if (msg.type === "exportClip") {
          await chooseClipExport(viewer);
        } else if (msg.type === "runScript") {
          await runScript();
        } else if (msg.type === "attachKdb") {
          await viewer.attachKdb();
        } else if (
          msg.type === "kdbChildren" &&
          typeof msg.scope === "string"
        ) {
          await viewer.showHierarchy(msg.scope);
        } else if (msg.type === "kdbParent" && typeof msg.scope === "string") {
          if (viewer.kdb)
            await viewer.showHierarchy(
              msg.scope ? await viewer.kdb.parent(msg.scope) : "",
            );
        } else if (msg.type === "kdbSource" && typeof msg.scope === "string") {
          await openKdbSource(viewer, msg.scope, msg.target);
        } else if (
          msg.type === "navigateScope" &&
          ["back", "forward"].includes(msg.direction)
        ) {
          setCurrent(viewer);
          await sidebarTree("", msg.direction);
        } else if (
          msg.type === "copyPaths" &&
          typeof msg.text === "string" &&
          msg.text.length < 16000000
        ) {
          await vscode.env.clipboard.writeText(msg.text);
        } else if (
          msg.type === "rtlSchematic" &&
          typeof msg.signal === "string"
        ) {
          await showWaveSchematic(viewer, msg.signal, {
            tick: typeof msg.tick === "string" ? msg.tick : undefined,
            direction: msg.direction === "loads" ? "loads" : "drivers",
          });
        } else if (msg.type === "rtlTraceSchematic") {
          await showCurrentTraceSchematic(viewer);
        } else if (msg.type === "rtlModuleSchematic") {
          if (msg.signal === undefined || typeof msg.signal === "string")
            await showWaveModuleSchematic(viewer, msg.signal);
        } else if (
          msg.type === "waveMath" ||
          msg.type === "measureWave" ||
          msg.type === "analogOperation"
        ) {
          await handleWaveOperation(
            vscode,
            viewer,
            backend,
            surface,
            msg,
            trackTask,
            openWaveform,
          );
        } else if (
          msg.type === "rtlTrace" &&
          typeof msg.signal === "string" &&
          (msg.mode === "drivers" ||
            msg.mode === "loads" ||
            msg.mode === "context" ||
            msg.mode === "recordedContext" ||
            msg.mode === "execution")
        ) {
          await showSignalTrace(
            viewer,
            msg.signal,
            msg.mode,
            typeof msg.tick === "string" ? msg.tick : undefined,
            undefined,
            undefined,
            (msg.mode === "context" ||
              msg.mode === "drivers" ||
              msg.mode === "loads") &&
              msg.followContinuations === true,
          );
        } else if (msg.type === "source") {
          if (String(msg.id).startsWith("@virtual:")) {
            vscode.window.showInformationMessage(
              "虚拟信号没有独立 RTL 声明；请在输入信号行定位源码。",
            );
            return;
          }

          const signal = (
            await backend.request("describe", {
              signals: [String(msg.id)],
              query: `${msg.scope}.${msg.name}`,
            })
          )[0];
          if (signal) {
            const fullname = mapPrefix(
              `${signal.scope}.${signal.name.replace(/\s*\[\s*-?\d+\s*:\s*-?\d+\s*\]$/, "")}`,
              cfg.get("hierarchyMappings"),
            );
            await openKdbSource(viewer, fullname, msg.target);
          }
        }
      } catch (e) {
        if (backend !== viewer.backend) return;
        if (msg.type === "ready" && surface === panel.webview) {
          if (!viewer.meta)
            viewer.openError = e instanceof Error ? e.message : String(e);
          viewer.resolveReady(null);
        }
        output.appendLine(String(e));
        await sendError(surface, e, msg.type, msg.request);
      }
    }
    viewer.mountDock = surfaces.mountDock;
    panel.webview.onDidReceiveMessage(
      (msg) => receive(panel.webview, msg),
      null,
      context.subscriptions,
    );
    surfaces.renderEditor();
  };
}
