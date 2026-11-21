// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type * as vscode from "vscode";
import * as path from "node:path";
import type { Backend } from "./backend";
import type { backendPlan, FsdbBackend } from "./backend-selection";
import type { DesignSession } from "./kdb";
import type { Metadata, WaveState } from "./shared/protocol";
import { restoreView } from "./view-state";
import type { Viewer, WaveDocument } from "./viewer";
import { cacheBudgets } from "./wave-cache";
import { configureWaveDesign } from "./wave-design";
import type { TrackTask } from "./wave-extension-types";

type WaveBackendPlan = ReturnType<typeof backendPlan>;

interface BackendActions {
  context: vscode.ExtensionContext;
  cfg: vscode.WorkspaceConfiguration;
  log(message: string): void;
  trackTask: TrackTask;
  refreshSidebar(): void;
  scheduleEditorSync(editor?: vscode.TextEditor): void;
  projectChanges: vscode.EventEmitter<
    vscode.CustomDocumentContentChangeEvent<WaveDocument>
  >;
  rememberFile(filename: string): Thenable<void>;
  applyDebugLayout(viewer: Viewer): Promise<void>;
}

export function configureWaveEditorBackend(
  vscode: typeof import("vscode"),
  viewer: Viewer,
  choosePlan: (choice?: FsdbBackend) => WaveBackendPlan,
  initialPlan: WaveBackendPlan,
  actions: BackendActions,
) {
  const {
    context,
    cfg,
    log,
    trackTask,
    refreshSidebar,
    scheduleEditorSync,
    projectChanges,
    rememberFile,
    applyDebugLayout,
  } = actions;
  const { document } = viewer;
  let plan = initialPlan;
  let preference = cfg.get<FsdbBackend>("fsdbBackend") ?? "auto";
  let initialOpen: ReturnType<typeof readWithFallback> | undefined;

  const { openKdb, restoreInitialDesign } = configureWaveDesign(
    vscode,
    viewer,
    {
      context,
      cfg,
      choosePlan,
      getBackendSelection: () => ({ plan, preference }),
      log,
      trackTask,
      refreshSidebar,
      scheduleEditorSync,
      projectChanges,
    },
  );
  const readMetadata = async (backend: Backend) => {
    const meta = await backend.request("open", { path: document.uri.fsPath });
    for (const warning of meta.warnings ?? []) log(warning + "\n");
    if (BigInt(meta.end) > BigInt(Number.MAX_SAFE_INTEGER))
      throw Error(
        "Time range exceeds exact canvas tick precision (2^53). Native backend retains u64 timestamps.",
      );
    await backend.request(
      "cacheConfigure",
      cacheBudgets(
        vscode.workspace.getConfiguration("waveWorkbench", document.uri),
      ),
    );
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
    await viewer.panel.webview.postMessage({
      type: "metadata",
      ...metadataMessage(meta),
    });
    try {
      await restoreInitialDesign();
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
        await viewer.panel.webview.postMessage({
          type: "backendChanged",
          ...metadataMessage(meta),
          view: restored,
        });
        if (viewer.kdb) await viewer.showHierarchy();
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

  async function openInitial(backend: Backend) {
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
    viewer.backend = opened.backend;
    viewer.backendKind = plan.kind;
    return opened;
  }
  return { openInitial, initialize, metadataMessage };
}
