// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  isFsdb,
  type backendPlan,
  type WaveBackend,
} from "./backend-selection";
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
import type { TrackTask } from "./wave-extension-types";
import type { Viewer, WaveDocument } from "./viewer";

type WaveBackendPlan = ReturnType<typeof backendPlan>;

export function configureWaveDesign(
  vscode: typeof import("vscode"),
  viewer: Viewer,
  {
    context,
    cfg,
    choosePlan,
    getBackendSelection,
    log,
    trackTask,
    refreshSidebar,
    scheduleEditorSync,
    projectChanges,
  }: {
    context: vscode.ExtensionContext;
    cfg: vscode.WorkspaceConfiguration;
    choosePlan(choice: WaveBackend): WaveBackendPlan;
    getBackendSelection(): { plan: WaveBackendPlan; preference: WaveBackend };
    log(message: string): void;
    trackTask: TrackTask;
    refreshSidebar(): void;
    scheduleEditorSync(editor?: vscode.TextEditor): void;
    projectChanges: vscode.EventEmitter<
      vscode.CustomDocumentContentChangeEvent<WaveDocument>
    >;
  },
) {
  const { document, panel } = viewer;
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
  async function openKdb(
    database: string,
    selected: ReturnType<typeof backendPlan>,
    choice: WaveBackend,
    backend = viewer.backend,
    meta = viewer.meta,
  ) {
    const mappings = cfg.get<Record<string, string>>("sourcePathMappings");
    if (
      database === document.uri.fsPath &&
      (/\.wdb$/i.test(database) ||
        meta?.backend === "rust-independent-shm" ||
        meta?.backend === "shm-lib")
    )
      return VendorHdlDesign.open(
        database,
        await backend.request("hdlLocations", {}),
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
        meta?.signals || [],
        sourceDirectories,
      );
    }
    const session = selected.createKdb();
    try {
      await session.open(database);
      return session;
    } catch (error) {
      session.dispose();
      if (choice !== "auto" || selected.kdbKind !== "verdi" || viewer.disposed)
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
  }
  viewer.attachKdb = async (suggested, edited = !suggested) => {
    if (viewer.attaching) return viewer.attaching;
    viewer.attaching = (async () => {
      let database = suggested;
      if (!database) {
        const shm = shmDirectory(document.uri.fsPath);
        const xceliumIndex = "从 Xcelium 仿真快照生成 HDL 索引";
        const recordedWdb = "读取 WDB 的 HDL 调试位置";
        const choices = ["Verilator elaboration JSON", "KDB"];
        const recordedShm = "读取 SHM 的设计层级";
        if (shm) choices.unshift(xceliumIndex, "SHM HDL 索引文件");
        if (
          ["rust-independent-shm", "shm-lib"].includes(viewer.meta?.backend) &&
          shm
        )
          choices.unshift(recordedShm);
        if (/\.wdb$/i.test(document.uri.fsPath)) choices.unshift(recordedWdb);
        const kind = isFsdb(document.uri.fsPath)
          ? "KDB"
          : await vscode.window.showQuickPick(choices, {
              placeHolder: "选择设计数据库类型",
            });
        if (!kind) return false;
        if (kind === recordedWdb || kind === recordedShm) {
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
          if (viewer.meta?.backend === "rust-independent-shm")
            database = document.uri.fsPath;
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
      const { plan, preference } = getBackendSelection();
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

  async function restoreInitialDesign() {
    const sibling = path.join(path.dirname(document.uri.fsPath), "simv.daidir");
    const tree = cfg.get<string>("verilatorTreePath");
    const configuredTree =
      tree &&
      path.resolve(
        vscode.workspace.getWorkspaceFolder?.(document.uri)?.uri.fsPath ||
          path.dirname(document.uri.fsPath),
        tree,
      );
    const sourceIndex = shmSourceIndex(document.uri.fsPath);
    const ownDesign =
      /\.wdb$/i.test(document.uri.fsPath) ||
      (sourceIndex &&
        ["rust-independent-shm", "shm-lib"].includes(viewer.meta?.backend) &&
        /\.(shm|trn|dsn)$/i.test(document.uri.fsPath))
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
    if (database && !viewer.kdb)
      await viewer.attachKdb(database).catch((error) => {
        if (database !== ownDesign || savedDatabase) throw error;
        log("HDL source metadata unavailable: " + String(error) + "\n");
      });
    if (!document.dirty) document.savedKdb = viewer.kdb?.path;
  }

  return { openKdb, restoreInitialDesign };
}
