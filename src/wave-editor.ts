// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { Viewer, WaveDocument } from "./viewer";
import type { Backend } from "./backend";
import type { Metadata, WaveState } from "./shared/protocol";
import { backendPlan, isFsdb, type FsdbBackend } from "./backend-selection";
import { mapPrefix, type KdbSession } from "./kdb";
import { registerVirtuals, restoreView } from "./view-state";
import * as WaveSignal from "./shared/signals";

interface EditorActions {
  viewers: Set<Viewer>;
  projectChanges: vscode.EventEmitter<
    vscode.CustomDocumentContentChangeEvent<WaveDocument>
  >;
  output: vscode.OutputChannel;
  refreshSidebar(): void;
  setCurrent(viewer: Viewer): void;
  removeCurrent(viewer: Viewer): void;
  scheduleEditorSync(editor?: vscode.TextEditor): void;
  rememberFile(filename: string): Thenable<void>;
  applyDebugLayout(viewer: Viewer): Promise<void>;
  executeTcl(viewer: Viewer, script: string): Promise<unknown>;
  openWaveform(
    candidate?: string | vscode.Uri,
    options?: { picker?: boolean },
  ): Promise<Viewer | undefined>;
  openRecent(): Promise<void>;
  selectDecoder(viewer: Viewer): Promise<void>;
  editDecoderConfig(viewer: Viewer): Promise<void>;
  saveActiveProject(viewer: Viewer): Promise<unknown>;
  openProject(filename?: string): Promise<unknown>;
  chooseClipExport(viewer: Viewer): Promise<unknown>;
  runScript(uri?: vscode.Uri): Promise<unknown>;
  openKdbSource(
    viewer: Viewer,
    fullname: string,
    target: string,
  ): Promise<void>;
  sidebarTree(scope: string, action: string): Promise<unknown>;
}

export function createWaveEditor(
  vscode: typeof import("vscode"),
  context: vscode.ExtensionContext,
  actions: EditorActions,
) {
  const {
    viewers,
    projectChanges,
    output,
    refreshSidebar,
    setCurrent,
    removeCurrent,
    scheduleEditorSync,
    rememberFile,
    applyDebugLayout,
    executeTcl,
    openWaveform,
    openRecent,
    selectDecoder,
    editDecoderConfig,
    saveActiveProject,
    openProject,
    chooseClipExport,
    runScript,
    openKdbSource,
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
    const choosePlan = (choice?: FsdbBackend) =>
      backendPlan(
        context,
        vscode.workspace.getConfiguration("waveWorkbench", document.uri),
        document.uri.fsPath,
        log,
        choice,
      );
    let plan = choosePlan();
    const viewer = {
      document,
      panel,
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
        panel.webview.postMessage({ type: "ui", id, action, payload });
      });
    viewers.add(viewer);
    setCurrent(viewer);
    refreshSidebar();
    panel.onDidChangeViewState(() => {
      if (panel.active) {
        setCurrent(viewer);
        refreshSidebar();
      }
    });
    panel.onDidDispose(() => {
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
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(context.extensionUri, "media"),
        vscode.Uri.joinPath(context.extensionUri, "dist", "webview"),
      ],
    };
    let metaPromise;
    const sendError = (e, origin, request) =>
      panel.webview.postMessage({
        type: "error",
        origin,
        request,
        message: e.message || String(e),
      });
    async function showHierarchy(scope = "") {
      if (!viewer.kdb) return;
      const children = await viewer.kdb.children(scope, viewer.includeOther);
      viewer.treeCache.set(scope, children);
      refreshSidebar();
      await panel.webview.postMessage({
        type: "kdbHierarchy",
        scope,
        children,
      });
    }
    viewer.showHierarchy = showHierarchy;
    viewer.attachKdb = async (suggested, edited = !suggested) => {
      if (viewer.attaching) return viewer.attaching;
      viewer.attaching = (async () => {
        let database = suggested;
        if (!database) {
          const selection = await vscode.window.showOpenDialog({
            title: "选择与当前 FSDB 匹配的 VCS simv.daidir（KDB）",
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
          });
          database = selection?.[0]?.fsPath;
        }
        if (!database) return false;
        const session = plan.createKdb();
        try {
          await session.open(database);
          if (viewer.disposed) {
            session.dispose();
            return false;
          }
          viewer.kdb?.dispose();
          viewer.kdb = session;
          viewer.treeCache.clear();
          viewer.treeExpanded.clear();
          refreshSidebar();
          await context.workspaceState.update(
            `kdb:${document.uri.toString()}`,
            database,
          );
          await panel.webview.postMessage({
            type: "kdbAttached",
            path: session.path,
          });
          await showHierarchy();
          scheduleEditorSync(vscode.window.activeTextEditor);
          if (edited && document.view) {
            document.dirty = true;
            projectChanges.fire({ document });
          }
          return true;
        } catch (e) {
          session.dispose();
          throw e;
        }
      })().finally(() => {
        viewer.attaching = null;
      });
      return viewer.attaching;
    };
    const readMetadata = async (backend: Backend) => {
      const meta = await backend.request("open", { path: document.uri.fsPath });
      if (BigInt(meta.end) > BigInt(Number.MAX_SAFE_INTEGER))
        throw Error(
          "Time range exceeds exact canvas tick precision (2^53). Native backend retains u64 timestamps.",
        );
      await backend.request("cacheConfigure", {
        bytes: (cfg.get<number>("cacheSizeMB") ?? 64) * 1024 * 1024,
      });
      return meta;
    };
    const metadataMessage = (meta: Metadata) => ({
      ...meta,
      backendLabel: plan.label,
      title: path.basename(document.uri.fsPath),
      vide:
        vscode.extensions.getExtension("pascal-lab.vide-code-extension")
          ?.packageJSON.version || null,
    });
    const initialize = async (backend: Backend, prepared?: Metadata) => {
      const meta = prepared ?? (await (metaPromise ??= readMetadata(backend)));
      if (viewer.disposed || backend !== viewer.backend) return;
      viewer.meta = meta;
      refreshSidebar();
      await context.workspaceState.update("lastWaveform", document.uri.fsPath);
      await rememberFile(document.uri.fsPath);
      await applyDebugLayout(viewer);
      await panel.webview.postMessage({
        type: "metadata",
        ...metadataMessage(meta),
      });
      const sibling = path.join(
        path.dirname(document.uri.fsPath),
        "simv.daidir",
      );
      const database =
        document.backup?.kdb ||
        context.workspaceState.get<string>(`kdb:${document.uri.toString()}`) ||
        (fs.existsSync(sibling) ? sibling : null) ||
        cfg.get<string>("kdbPath");
      try {
        if (database && !viewer.kdb) await viewer.attachKdb(database);
        if (!document.dirty) document.savedKdb = viewer.kdb?.path;
        const backup = document.backup;
        if (backup) {
          const restored = await restoreView(backend, backup.view, meta);
          await viewer.ui("restoreView", {
            ...restored,
            projectBaseline: true,
          });
          document.backup = undefined;
        }
      } finally {
        viewer.resolveReady(viewer);
      }
    };
    let switching = false;
    viewer.switchBackend = async (choice) => {
      const next = choosePlan(choice);
      if (
        viewer.meta &&
        !viewer.backend.closed &&
        next.kind === viewer.backendKind
      )
        return next.label;
      if (switching || viewer.running || viewer.attaching)
        throw Error("当前波形正在切换后端、执行 Tcl 或接入 KDB，请稍后再试");
      switching = true;
      let candidate: Backend | undefined;
      let candidateKdb: KdbSession | undefined;
      try {
        await viewer.ready;
        if (viewer.disposed) throw Error("波形窗口已关闭");
        candidate = next.createWave();
        const meta = await readMetadata(candidate);
        const previousMeta = viewer.meta;
        if (
          previousMeta &&
          (meta.start !== previousMeta.start ||
            meta.end !== previousMeta.end ||
            meta.scale !== previousMeta.scale)
        )
          throw Error("两个后端返回的时间范围或单位不同，请重新打开波形");
        const attached = viewer.kdb;
        const roots = new Map<
          string,
          Awaited<ReturnType<KdbSession["children"]>>
        >();
        if (attached) {
          candidateKdb = next.createKdb();
          await candidateKdb.open(attached.path);
          const scopes = new Set(["", ...viewer.treeExpanded]);
          for (const scope of scopes) {
            roots.set(
              scope,
              await candidateKdb.children(scope, viewer.includeOther),
            );
          }
        }
        const view: WaveState | undefined = previousMeta
          ? await viewer.ui("snapshot")
          : undefined;
        const documentView = document.view;
        const restored = view
          ? await restoreView(candidate, view, meta)
          : undefined;
        if (
          viewer.disposed ||
          viewer.kdb !== attached ||
          viewer.attaching ||
          viewer.running ||
          document.view !== documentView
        )
          throw Error("波形或 KDB 会话在切换期间发生了变化，请重试");

        const previousBackend = viewer.backend;
        viewer.backend = candidate;
        viewer.backendKind = next.kind;
        plan = next;
        metaPromise = Promise.resolve(meta);
        candidate = undefined;
        previousBackend.dispose();
        if (candidateKdb) {
          viewer.kdb = candidateKdb;
          viewer.treeCache = roots;
          candidateKdb = undefined;
          attached?.dispose();
        }
        if (!previousMeta) {
          await initialize(viewer.backend, meta);
        } else {
          viewer.meta = meta;
          await panel.webview.postMessage({
            type: "backendChanged",
            ...metadataMessage(meta),
            view: restored,
          });
          if (viewer.kdb) await showHierarchy();
          scheduleEditorSync(vscode.window.activeTextEditor);
          refreshSidebar();
        }
        return next.label;
      } finally {
        candidate?.dispose();
        candidateKdb?.dispose();
        switching = false;
      }
    };
    panel.webview.onDidReceiveMessage(
      async (msg) => {
        const backend = viewer.backend;
        try {
          if (msg.type === "ready") {
            await initialize(backend);
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
                  typeof msg.displayScale === "string"
                    ? msg.displayScale
                    : null,
              };
            }
          } else if (msg.type === "projectState" && msg.view) {
            document.view = msg.view;
            if (msg.baseline) {
              if (!document.dirty) document.savedView = document.view;
            } else {
              document.dirty = true;
              projectChanges.fire({ document });
            }
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
          } else if (msg.type === "openRecent") {
            await openRecent();
          } else if (msg.type === "selectDecoder") {
            await selectDecoder(viewer);
          } else if (msg.type === "editDecoderConfig") {
            await editDecoderConfig(viewer);
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
            await showHierarchy(msg.scope);
          } else if (
            msg.type === "kdbParent" &&
            typeof msg.scope === "string"
          ) {
            if (viewer.kdb)
              await showHierarchy(
                msg.scope ? await viewer.kdb.parent(msg.scope) : "",
              );
          } else if (
            msg.type === "kdbSource" &&
            typeof msg.scope === "string"
          ) {
            await openKdbSource(viewer, msg.scope, msg.target);
          } else if (
            msg.type === "navigateScope" &&
            ["back", "forward"].includes(msg.direction)
          ) {
            setCurrent(viewer);
            await sidebarTree("", msg.direction);
          } else if (
            msg.type === "scopeSignals" &&
            typeof msg.scope === "string"
          ) {
            if (viewer.selectedScope !== msg.scope) {
              viewer.selectedScope = msg.scope;
              refreshSidebar();
            }
            const result = await backend.request("scopeSignals", {
              query: msg.scope,
              offset: Math.max(0, msg.offset || 0),
              limit: 512,
            });
            await panel.webview.postMessage({
              type: "scopeSignals",
              request: msg.request,
              ...result,
            });
          } else if (
            msg.type === "search" &&
            typeof msg.query === "string" &&
            msg.query.length < 1024
          ) {
            const result = await backend.request("search", {
              query: msg.query,
              offset: Number.isSafeInteger(msg.offset) ? msg.offset : 0,
              limit: msg.limit || 512,
            });
            await panel.webview.postMessage({
              type: "searchResult",
              request: msg.request,
              ...result,
            });
          } else if (msg.type === "defineVirtual") {
            const result = await backend.request("defineVirtual", {
              definition: msg.definition,
              name: typeof msg.name === "string" ? msg.name.slice(0, 120) : "",
            });
            await panel.webview.postMessage({
              type: "virtualCreated",
              ...result,
            });
          } else if (
            msg.type === "restore" &&
            Array.isArray(msg.signals) &&
            msg.signals.length <= 100000
          ) {
            await registerVirtuals(backend, msg.virtualDefinitions || []);
            const style = new Map();
            for (const s of msg.signals) {
              if (typeof s === "string") continue;
              const key = WaveSignal.baseKey(s);
              if (!style.has(key)) style.set(key, []);
              style.get(key).push(s);
            }
            const signals = [];
            for (let i = 0; i < msg.signals.length; i += 1000) {
              const chunk = msg.signals
                .slice(i, i + 1000)
                .map((s) =>
                  typeof s === "string"
                    ? { id: s }
                    : { id: s.id, scope: s.scope, name: s.name },
                );
              const described = await backend.request("describe", {
                descriptors: chunk,
              });
              for (const signal of described) {
                const s = style.get(WaveSignal.baseKey(signal))?.shift() || {};
                signals.push(WaveSignal.restore(s, signal));
              }
            }
            await panel.webview.postMessage({ type: "restore", signals });
          } else if (msg.type === "query") {
            if (
              !viewer.meta ||
              !Array.isArray(msg.signals) ||
              msg.signals.length > 64 ||
              !Number.isSafeInteger(msg.start) ||
              !Number.isSafeInteger(msg.end) ||
              msg.start < 0 ||
              msg.end < msg.start
            )
              return;
            const result = await backend.request("query", {
              signals: msg.signals,
              start: String(msg.start),
              end: String(msg.end),
              limit:
                msg.report && Number.isSafeInteger(msg.limit)
                  ? Math.min(
                      cfg.get<number>("eventsPerSignal") || 20000,
                      Math.max(2, Math.min(5000, msg.limit)),
                    )
                  : cfg.get<number>("eventsPerSignal"),
            });
            await panel.webview.postMessage({
              type: "data",
              request: msg.request,
              result,
            });
          } else if (
            msg.type === "copyPaths" &&
            typeof msg.text === "string" &&
            msg.text.length < 16000000
          ) {
            await vscode.env.clipboard.writeText(msg.text);
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
          if (msg.type === "ready") viewer.resolveReady(null);
          output.appendLine(String(e));
          await sendError(e, msg.type, msg.request);
        }
      },
      null,
      context.subscriptions,
    );
    const nonce = crypto.randomBytes(16).toString("hex");
    const resource = (n: string) =>
      panel.webview.asWebviewUri(
        vscode.Uri.joinPath(
          context.extensionUri,
          n.endsWith(".js") ? "dist/webview" : "media",
          n,
        ),
      );
    panel.webview.html = fs
      .readFileSync(context.asAbsolutePath("media/index.html"), "utf8")
      .replaceAll("{{csp}}", panel.webview.cspSource)
      .replaceAll("{{nonce}}", nonce)
      .replace("{{css}}", resource("wave.css").toString())
      .replace("{{script}}", resource("wave.js").toString());
  };
}
