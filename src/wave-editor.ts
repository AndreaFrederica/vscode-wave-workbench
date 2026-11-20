import { measureAnalog, thresholdSamples } from "./shared/analog";
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
import { loadDecoderCatalog, saveDecoderProfile } from "./decoder-config";
import type { DecoderInstance, DecodeResult } from "./decoder-runtime/types";
import type { BackendProtocol } from "./shared/protocol";
import { backendPlan, isFsdb, type FsdbBackend } from "./backend-selection";
import { mapPrefix, type DesignSession } from "./kdb";
import {
  findVerilatorTree,
  VerilatorDesign,
  verilatorTreeFile,
} from "./verilator";
import {
  exportXceliumHdl,
  readHdlIndex,
  shmDirectory,
  shmSourceIndex,
  VendorHdlDesign,
} from "./vendor-hdl";
import { registerVirtuals, restoreView } from "./view-state";
import * as WaveSignal from "./shared/signals";
import { mathActions, showWaveMath } from "./wave-math-editor";

interface EditorActions {
  trackTask<T>(
    label: string,
    filename: string | undefined,
    work: () => Promise<T>,
  ): Promise<T>;
  viewers: Set<Viewer>;
  projectChanges: vscode.EventEmitter<
    vscode.CustomDocumentContentChangeEvent<WaveDocument>
  >;
  output: vscode.OutputChannel;
  refreshSidebar(): void;
  setCurrent(viewer: Viewer): void;
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
  selectDecoder(viewer: Viewer): Promise<void>;
  editDecoderConfig(viewer: Viewer): Promise<void>;
  decoderConfigPath(viewer: Viewer): string | undefined;
  configureWaveDecoder(viewer: Viewer): Promise<void>;
  manageWaveDecoders(viewer: Viewer): Promise<void>;
  materializeDecoderSignal(
    viewer: Viewer,
    instance: DecoderInstance,
  ): Promise<BackendProtocol["defineVirtual"]["result"] | undefined>;
  decodeWindow(
    viewer: Viewer,
    instance: DecoderInstance,
    start: string,
    end: string,
    signal?: AbortSignal,
  ): Promise<DecodeResult>;
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
  showWaveSchematic(
    viewer: Viewer,
    signal: string,
    tick?: string,
    direction?: "drivers" | "loads",
  ): Promise<void>;
  showWaveModuleSchematic(viewer: Viewer, signal?: string): Promise<void>;
  showCurrentTraceSchematic(viewer: Viewer): Promise<void>;
  sidebarTree(scope: string, action: string): Promise<unknown>;
}

export function createWaveEditor(
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
    removeCurrent,
    scheduleEditorSync,
    refreshTraceCursor,
    rememberFile,
    applyDebugLayout,
    executeTcl,
    openWaveform,
    openRecent,
    selectDecoder,
    editDecoderConfig,
    decoderConfigPath,
    configureWaveDecoder,
    manageWaveDecoders,
    materializeDecoderSignal,
    decodeWindow,
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
    const decoderQueries = new Map<string, AbortController>();
    panel.onDidDispose(() => {
      for (const query of decoderQueries.values()) query.abort();
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
    let preference = cfg.get<FsdbBackend>("fsdbBackend") ?? "auto";
    let initialOpen: ReturnType<typeof readWithFallback> | undefined;
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
    viewer.restoreDesignView = async (view) => {
      if (!viewer.kdb || !view) return;
      const session = viewer.kdb;
      viewer.includeOther = view.includeOther;
      viewer.treeExpanded.clear();
      viewer.treeCache.clear();
      await showHierarchy();
      const scopes = new Set(view.expanded);
      let selected = view.selected
        ? await session.resolve(view.selected).catch(() => undefined)
        : undefined;
      if (selected && selected.fullname !== selected.instance)
        selected = undefined;
      const visited = new Set<string>();
      for (let scope = selected?.fullname; scope && !visited.has(scope); ) {
        visited.add(scope);
        const parent = await session.parent(scope);
        if (parent) scopes.add(parent);
        scope = parent;
      }
      for (const scope of scopes) {
        if (!scope || viewer.kdb !== session || viewer.disposed) continue;
        const record = await session.resolve(scope).catch(() => undefined);
        if (!record || record.fullname !== record.instance) continue;
        viewer.treeExpanded.add(scope);
        await showHierarchy(scope);
      }
      if (viewer.kdb !== session || viewer.disposed) return;
      viewer.selectedScope = selected?.fullname || "";
      viewer.revealScope = viewer.selectedScope;
      viewer.revealId = (viewer.revealId || 0) + 1;
      refreshSidebar();
      await panel.webview.postMessage({
        type: "scopeSelected",
        scope: viewer.selectedScope,
      });
    };
    const openKdb = async (
      database: string,
      selected: ReturnType<typeof choosePlan>,
      choice: FsdbBackend,
    ) => {
      const mappings = cfg.get<Record<string, string>>("sourcePathMappings");
      if (
        /\.wdb$/i.test(document.uri.fsPath) &&
        database === document.uri.fsPath
      )
        return VendorHdlDesign.open(
          database,
          await viewer.backend.request("hdlLocations", {}),
          mappings,
        );
      if (/\.hdl\.json$/i.test(database))
        return VendorHdlDesign.open(
          database,
          await readHdlIndex(database),
          mappings,
        );
      if (verilatorTreeFile(database)) {
        const directory = path.dirname(database);
        const sourceDirectories = [
          vscode.workspace.getWorkspaceFolder?.(document.uri)?.uri.fsPath,
          path.dirname(document.uri.fsPath),
          directory,
          path.dirname(directory),
        ].filter(Boolean);
        return VerilatorDesign.open(
          database,
          viewer.meta?.signals || [],
          sourceDirectories,
        );
      }
      const session = selected.createKdb();
      try {
        await session.open(database);
        return session;
      } catch (error) {
        session.dispose();
        if (
          choice !== "auto" ||
          selected.kdbKind !== "verdi" ||
          viewer.disposed
        )
          throw error;
        log(`Verdi KDB open failed; trying WaveBench Reader: ${error}\n`);
        const fallback = choosePlan("independent").createKdb();
        try {
          await fallback.open(database);
          return fallback;
        } catch (fallbackError) {
          fallback.dispose();
          throw Error(`Verdi: ${error}\nWaveBench Reader: ${fallbackError}`);
        }
      }
    };
    viewer.attachKdb = async (suggested, edited = !suggested) => {
      if (viewer.attaching) return viewer.attaching;
      viewer.attaching = (async () => {
        let database = suggested;
        if (!database) {
          const shm = shmDirectory(document.uri.fsPath);
          const xceliumIndex = "从 Xcelium 仿真快照生成 HDL 索引";
          const recordedWdb = "读取 WDB 的 HDL 调试位置";
          const choices = ["Verilator elaboration JSON", "KDB"];
          if (shm) choices.unshift(xceliumIndex, "SHM HDL 索引文件");
          if (/\.wdb$/i.test(document.uri.fsPath)) choices.unshift(recordedWdb);
          const kind = isFsdb(document.uri.fsPath)
            ? "KDB"
            : await vscode.window.showQuickPick(choices, {
                placeHolder: "选择设计数据库类型",
              });
          if (!kind) return false;
          if (kind === recordedWdb) {
            database = document.uri.fsPath;
          } else if (shm && kind === xceliumIndex) {
            const candidates = [
              path.dirname(shm),
              path.dirname(path.dirname(shm)),
            ];
            const suggested = candidates.find((candidate) =>
              fs.existsSync(path.join(candidate, "xcelium.d")),
            );
            const folder = await vscode.window.showOpenDialog({
              title: "选择原 Xcelium 仿真运行目录",
              canSelectFolders: true,
              canSelectFiles: false,
              canSelectMany: false,
              defaultUri: vscode.Uri.file(suggested ?? candidates[0]),
            });
            if (!folder?.[0]) return false;
            database = shmSourceIndex(shm)!;
            await trackTask("读取 Xcelium HDL 源码位置", shm, () =>
              exportXceliumHdl(
                context.asAbsolutePath("native/xcelium_hdl.c"),
                cfg.get<string>("xceliumHome") || process.env.XCELIUM_HOME,
                folder[0].fsPath,
                database!,
              ),
            );
          } else {
            const selection = await vscode.window.showOpenDialog(
              kind === "KDB"
                ? {
                    title: "选择 VCS simv.daidir（KDB）",
                    canSelectFiles: false,
                    canSelectFolders: true,
                    canSelectMany: false,
                  }
                : {
                    title:
                      kind === "SHM HDL 索引文件"
                        ? "选择 SHM .hdl.json"
                        : "选择 Verilator .tree.json",
                    filters: { "Verilator JSON": ["json"] },
                    canSelectMany: false,
                  },
            );
            database = selection?.[0]?.fsPath;
            if (
              database &&
              kind === "Verilator elaboration JSON" &&
              !verilatorTreeFile(database)
            )
              throw Error("请选择 Verilator --json-only 生成的 .tree.json");
          }
        }
        if (!database) return false;
        const session = await openKdb(database, plan, preference);
        try {
          if (viewer.disposed) {
            session.dispose();
            return false;
          }
          viewer.kdb?.dispose();
          viewer.kdb = session;
          viewer.treeCache.clear();
          viewer.treeExpanded.clear();
          viewer.sourceInstances.clear();
          viewer.selectedScope = "";
          viewer.revealScope = "";
          viewer.scopeHistory = [];
          viewer.scopeIndex = -1;
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
    const readWithFallback = async (
      preferred: ReturnType<typeof choosePlan>,
      backend: Backend,
      choice: FsdbBackend,
    ) => {
      try {
        return { plan: preferred, backend, meta: await readMetadata(backend) };
      } catch (verdiError) {
        if (choice !== "auto" || preferred.kind !== "verdi" || viewer.disposed)
          throw verdiError;
        log(`Verdi open failed; trying WaveBench Reader: ${verdiError}\n`);
        backend.dispose();
        const fallback = choosePlan("independent");
        const reader = fallback.createWave();
        try {
          return {
            plan: fallback,
            backend: reader,
            meta: await readMetadata(reader),
          };
        } catch (readerError) {
          reader.dispose();
          throw Error(`Verdi: ${verdiError}\nWaveBench Reader: ${readerError}`);
        }
      }
    };
    const metadataMessage = (meta: Metadata) => ({
      ...meta,
      backendLabel: plan.label,
      title: path.basename(document.uri.fsPath),
      vide:
        vscode.extensions.getExtension("pascal-lab.vide-code-extension")
          ?.packageJSON.version || null,
    });
    const initialize = async (backend: Backend, meta: Metadata) => {
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
      const tree = cfg.get<string>("verilatorTreePath");
      const configuredTree =
        tree &&
        path.resolve(
          vscode.workspace.getWorkspaceFolder?.(document.uri)?.uri.fsPath ||
            path.dirname(document.uri.fsPath),
          tree,
        );
      const sourceIndex = shmSourceIndex(document.uri.fsPath);
      const ownDesign = /\.wdb$/i.test(document.uri.fsPath)
        ? document.uri.fsPath
        : sourceIndex && fs.existsSync(sourceIndex)
          ? sourceIndex
          : undefined;
      const savedDatabase =
        document.backup?.kdb ||
        context.workspaceState.get<string>(`kdb:${document.uri.toString()}`);
      const otherDesign =
        !savedDatabase &&
        !ownDesign &&
        !sourceIndex &&
        ((!isFsdb(document.uri.fsPath) &&
          (configuredTree || (await findVerilatorTree(document.uri.fsPath)))) ||
          (fs.existsSync(sibling) ? sibling : null) ||
          cfg.get<string>("kdbPath"));
      const database = savedDatabase || ownDesign || otherDesign;
      try {
        if (database && !viewer.kdb)
          await viewer.attachKdb(database).catch((error) => {
            if (database !== ownDesign || savedDatabase) throw error;
            log("HDL source metadata unavailable: " + String(error) + "\n");
          });
        if (!document.dirty) document.savedKdb = viewer.kdb?.path;
        const backup = document.backup;
        if (backup) {
          await viewer.restoreDesignView(backup.designView);
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
      let next = choosePlan(choice);
      if (
        viewer.meta &&
        !viewer.backend.closed &&
        next.kind === viewer.backendKind
      ) {
        preference = choice;
        return next.label;
      }
      if (switching || viewer.running || viewer.attaching)
        throw Error("当前波形正在切换后端、执行 Tcl 或接入 KDB，请稍后再试");
      switching = true;
      let candidate: Backend | undefined;
      let candidateKdb: DesignSession | undefined;
      try {
        await viewer.ready;
        if (viewer.disposed) throw Error("波形窗口已关闭");
        candidate = next.createWave();
        const opened = await readWithFallback(next, candidate, choice);
        candidate = opened.backend;
        next = opened.plan;
        const { meta } = opened;
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
          Awaited<ReturnType<DesignSession["children"]>>
        >();
        if (attached) {
          candidateKdb = await openKdb(attached.path, next, choice);
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
        preference = choice;
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
        let backend = viewer.backend;
        try {
          if (msg.type === "ready") {
            if (viewer.meta) {
              await initialize(backend, viewer.meta);
              return;
            }
            await trackTask("打开波形", viewer.uri.fsPath, async () => {
              const opened = await (initialOpen ??= readWithFallback(
                plan,
                backend,
                preference,
              ));
              if (viewer.disposed) {
                opened.backend.dispose();
                return;
              }
              plan = opened.plan;
              backend = opened.backend;
              viewer.backend = backend;
              viewer.backendKind = plan.kind;
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
                  typeof msg.displayScale === "string"
                    ? msg.displayScale
                    : null,
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
          } else if (msg.type === "configureWaveDecoder") {
            await configureWaveDecoder(viewer);
          } else if (msg.type === "manageWaveDecoders") {
            await manageWaveDecoders(viewer);
          } else if (msg.type === "materializeDecoderSignal") {
            const result = await materializeDecoderSignal(viewer, msg.instance);
            if (result)
              await panel.webview.postMessage({
                type: "virtualCreated",
                ...result,
              });
          } else if (msg.type === "cancelWaveDecoder") {
            decoderQueries.get(msg.instanceId)?.abort();
          } else if (msg.type === "queryWaveDecoder") {
            const id = msg.instance?.instanceId;
            if (typeof id !== "string" || id.length > 64)
              throw Error("Invalid decoder instance.");
            decoderQueries.get(id)?.abort();
            const controller = new AbortController();
            decoderQueries.set(id, controller);
            try {
              const decoded = await decodeWindow(
                viewer,
                msg.instance,
                msg.start,
                msg.end,
                controller.signal,
              );
              if (!controller.signal.aborted)
                await panel.webview.postMessage({
                  type: "waveDecoderResult",
                  instanceId: id,
                  request: msg.request,
                  decoded,
                });
            } catch (error) {
              if (!controller.signal.aborted)
                await panel.webview.postMessage({
                  type: "waveDecoderResult",
                  instanceId: id,
                  request: msg.request,
                  error: error.message,
                });
            } finally {
              if (decoderQueries.get(id) === controller)
                decoderQueries.delete(id);
            }
          } else if (msg.type === "decoderCatalog") {
            const legacy = decoderConfigPath(viewer);
            await panel.webview.postMessage({
              type: "decoderCatalog",
              ...(await loadDecoderCatalog(legacy)),
              workspaceAvailable: !!legacy,
            });
          } else if (msg.type === "saveDecoderProfile") {
            try {
              const legacy = decoderConfigPath(viewer);
              if (!legacy) throw Error("请先打开工作区文件夹");
              const profile = await saveDecoderProfile(
                legacy,
                msg.group,
                msg.original,
                msg.edited,
                (filename) => {
                  if (
                    vscode.workspace.textDocuments.some(
                      (document) =>
                        document.isDirty && document.uri.fsPath === filename,
                    )
                  )
                    throw Error(
                      "规则文件在编辑器中有未保存的修改，请先保存该文件",
                    );
                },
              );
              await panel.webview.postMessage({
                type: "decoderProfileSaved",
                request: msg.request,
                profile,
              });
            } catch (error) {
              await panel.webview.postMessage({
                type: "decoderProfileSaved",
                request: msg.request,
                error: error.message,
              });
            }
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
                typeof msg.request === "string" &&
                msg.request.startsWith("uart:") &&
                msg.signals.length === 1
                  ? 100000
                  : msg.report && Number.isSafeInteger(msg.limit)
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
          } else if (
            msg.type === "rtlSchematic" &&
            typeof msg.signal === "string"
          ) {
            await showWaveSchematic(
              viewer,
              msg.signal,
              typeof msg.tick === "string" ? msg.tick : undefined,
              msg.direction === "loads" ? "loads" : "drivers",
            );
          } else if (msg.type === "rtlTraceSchematic") {
            await showCurrentTraceSchematic(viewer);
          } else if (msg.type === "rtlModuleSchematic") {
            if (msg.signal === undefined || typeof msg.signal === "string")
              await showWaveModuleSchematic(viewer, msg.signal);
          } else if (msg.type === "waveMath" && mathActions.includes(msg.operation)) {
            await showWaveMath(
              vscode, viewer, msg.operation, msg.signals, msg.range,
              (work) => trackTask(msg.operation === "fft" ? "计算 FFT" : "计算派生波形", viewer.uri.fsPath, work),
              (uri) => openWaveform(uri),
            );
          } else if (msg.type === "analogOperation") {
            const id = msg.id;
            if (typeof id !== "string") return;
            const [signal] = await backend.request("describe", {
              descriptors: [{ id, scope: msg.scope, name: msg.name }],
            });
            if (!signal?.real || !signal.supported)
              throw Error("请选择一条实数信号。");
            if (msg.operation === "unit") {
              const unit = await vscode.window.showInputBox({
                title: "设置实数单位",
                prompt: "输入显示单位，留空可清除",
                value:
                  typeof msg.unit === "string" ? msg.unit.slice(0, 24) : "",
                validateInput: (unit) =>
                  unit.trim().length > 24 ? "单位最多 24 字符。" : undefined,
              });
              if (unit !== undefined && viewer.backend === backend)
                await panel.webview.postMessage({
                  type: "analogUnit",
                  signal,
                  unit: unit.trim(),
                });
            } else if (msg.operation === "measure") {
              if (
                typeof msg.start !== "string" ||
                typeof msg.end !== "string" ||
                !/^\d+$/.test(msg.start) ||
                !/^\d+$/.test(msg.end)
              )
                return;
              const { start, end } = msg;
              const block = (
                await backend.request("query", {
                  signals: [id],
                  start,
                  end,
                  limit: 100000,
                })
              )[id];
              if (block.truncated)
                throw Error("测量区间采样过多，请缩小 A/B 范围。");
              const result = measureAnalog(
                block.events,
                BigInt(start),
                BigInt(end),
              );
              const unit =
                typeof msg.unit === "string" && msg.unit.length <= 24
                  ? msg.unit
                  : "";
              const text = (value: number | null) =>
                value === null
                  ? "—"
                  : [Number(value.toPrecision(7)), unit]
                      .filter((item) => item !== "")
                      .join(" ");
              vscode.window.showInformationMessage(
                `${signal.name}  Min ${text(result.min)}  Max ${text(result.max)}  Vpp ${text(result.peakToPeak)}  Mean ${text(result.mean)}  RMS ${text(result.rms)}  覆盖 ${result.coveredTicks}/${result.durationTicks} tick`,
              );
            } else if (msg.operation === "threshold") {
              const value = await vscode.window.showInputBox({
                title: "生成带滞回的数字波形",
                prompt: "输入低阈值和高阈值，用逗号分隔",
                value: "0.3, 0.7",
              });
              if (value === undefined || viewer.backend !== backend) return;
              const thresholds = value.split(",").map((s) => s.trim());
              if (thresholds.length !== 2 || thresholds.some((s) => !s))
                throw Error("请输入两个阈值。");
              const [low, high] = thresholds.map(Number);
              const { start, end } = viewer.meta;
              const block = (
                await backend.request("query", {
                  signals: [id],
                  start,
                  end,
                  limit: 100000,
                })
              )[id];
              if (block.truncated) throw Error("实数波形超过全波形处理上限。");
              const samples = thresholdSamples(block.events, low, high);
              if (!samples.length || samples.length > 4096)
                throw Error("派生信号的采样数超出范围。");
              if (BigInt(samples[0][0]) > BigInt(start))
                samples.unshift([start, "x"]);
              const result = await backend.request("defineVirtual", {
                name: signal.name + " 滞回",
                definition: {
                  op: "samples",
                  inputs: [],
                  width: 1,
                  source: ("threshold:" + id + ":" + signal.name).slice(0, 120),
                  samples,
                },
              });
              await panel.webview.postMessage({
                type: "virtualCreated",
                ...result,
              });
            }
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
          if (msg.type === "ready") {
            if (!viewer.meta)
              viewer.openError = e instanceof Error ? e.message : String(e);
            viewer.resolveReady(null);
          }
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
