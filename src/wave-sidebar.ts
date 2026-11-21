// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { Viewer } from "./viewer";
import type { TagState, WaveState } from "./shared/protocol";
import { normalizeTagColors, tagStyle } from "./shared/tags";
import type * as vscode from "vscode";
import * as path from "node:path";

import * as WaveSignal from "./shared/signals";
import { mapPrefix } from "./kdb";
import { Sidebar } from "./sidebar";

import type { WaveAnalysis, GetViewer } from "./wave-extension-types";
import type { createWaveSourceNavigation } from "./wave-source-navigation";

type VSCodeApi = typeof vscode;

export function createWaveSidebar(
  vscode: VSCodeApi,
  {
    context,
    getCurrent,
    setCurrent,
    viewers,
    dumpScope,
    executeTcl,
    openKdbSource,
    revealScope,
  }: {
    context: vscode.ExtensionContext;
    getCurrent: GetViewer;
    setCurrent: (viewer: Viewer) => void;
    viewers: Set<Viewer>;
    dumpScope: WaveAnalysis["dumpScope"];
    executeTcl: (viewer: Viewer, script: string) => Promise<string>;
    openKdbSource: ReturnType<
      typeof createWaveSourceNavigation
    >["openKdbSource"];
    revealScope: ReturnType<typeof createWaveSourceNavigation>["revealScope"];
  },
) {
  const sidebarTags = new WeakMap<
    Viewer,
    { signature: string; state: TagState }
  >();
  function updateSidebarTags(viewer: Viewer, view: WaveState) {
    const mappings = vscode.workspace
      .getConfiguration("waveWorkbench", viewer.uri)
      .get<Record<string, string>>("hierarchyMappings");
    const state: TagState = {
      tagStyle: tagStyle(view.tagStyle),
      tagColors: normalizeTagColors(view.tagColors),
      taggedSignals: view.chosen.flatMap((signal) => {
        if (!signal.annotation?.tags.length) return [];
        const { id, scope, name, displayName, bitOffset } = signal;
        return [
          {
            id,
            scope,
            name,
            displayName,
            bitOffset,
            instanceScope: mapPrefix(scope, mappings),
            tags: signal.annotation.tags,
          },
        ];
      }),
    };
    const signature = JSON.stringify(state);
    if (sidebarTags.get(viewer)?.signature === signature) return;
    sidebarTags.set(viewer, { signature, state });
    if (viewer === getCurrent()) sidebar.refresh();
  }
  function logTcl(viewer: Viewer | null, text: string) {
    viewer?.panel.webview.postMessage({ type: "commandLog", text });
    sidebar?.log(text, viewer?.uri.fsPath || "");
  }
  function treeRows(viewer: Viewer) {
    const rows = [];
    if (!viewer) return rows;
    function visit(scope: string, depth: number) {
      for (const node of viewer.treeCache.get(scope) || []) {
        rows.push({
          ...node,
          depth,
          expanded: viewer.treeExpanded.has(node.fullname),
          selected: node.fullname === viewer.selectedScope,
        });
        if (viewer.treeExpanded.has(node.fullname))
          visit(node.fullname, depth + 1);
      }
    }
    visit("", 0);
    return rows;
  }
  async function sidebarTree(scope: string, action: string) {
    const viewer = getCurrent();
    if (!viewer) return;
    if (!viewer.kdb && !(await viewer.attachKdb())) return;
    if (action === "mode") {
      viewer.includeOther = scope === "all";
      viewer.treeCache.clear();
      viewer.treeExpanded.clear();
      await viewer.showHierarchy();
      return;
    }
    if (action === "back" || action === "forward") {
      const index = viewer.scopeIndex + (action === "back" ? -1 : 1);
      if (index < 0 || index >= viewer.scopeHistory.length) return;
      viewer.scopeIndex = index;
      scope = viewer.scopeHistory[index];
    }
    if (action === "expand") {
      if (viewer.treeExpanded.has(scope)) viewer.treeExpanded.delete(scope);
      else {
        if (!viewer.treeCache.has(scope))
          viewer.treeCache.set(
            scope,
            await viewer.kdb.children(scope, viewer.includeOther),
          );
        viewer.treeExpanded.add(scope);
      }
      sidebar.refresh();
    } else {
      if (
        !["back", "forward"].includes(action) &&
        scope !== viewer.scopeHistory[viewer.scopeIndex]
      ) {
        viewer.scopeHistory = viewer.scopeHistory.slice(
          0,
          viewer.scopeIndex + 1,
        );
        viewer.scopeHistory.push(scope);
        viewer.scopeIndex = viewer.scopeHistory.length - 1;
      }
      viewer.selectedScope = scope;
      sidebar.refresh();
      await viewer.panel.webview.postMessage({ type: "scopeSelected", scope });
      const node = [...viewer.treeCache.values()]
        .flat()
        .find((n) => n.fullname === scope);
      await openKdbSource(
        viewer,
        scope,
        node && node.kind !== "npiModule" ? "declaration" : "definition",
      );
    }
  }
  const sidebar = new Sidebar(vscode, context, {
    state: () => {
      const current = getCurrent();
      return {
        sessions: [...viewers].map((v) => ({
          id: v.uri.toString(),
          title: path.basename(v.uri.fsPath),
          ready: !!v.meta,
          kdb: v.kdb?.path || "",
          backend: v.backendKind,
          running: !!v.running,
        })),
        activeId: current?.uri.toString() || "",
        tree: treeRows(current),
        scope: current?.selectedScope || "",
        includeOther: !!current?.includeOther,
        revealScope: current?.revealScope || "",
        revealId: current?.revealId || 0,
        tagState: current && sidebarTags.get(current)?.state,
      };
    },
    tree: sidebarTree,
    searchSignals: async (query, offset) => {
      const viewer = getCurrent();
      if (!viewer?.meta) return { signals: [], offset, total: 0 };
      return viewer.backend.request("search", { query, offset, limit: 32 });
    },
    scopeSignals: async (m) => {
      const viewer = getCurrent();
      if (!viewer?.meta)
        return { scope: m.scope, total: 0, signals: [], offset: 0 };
      const result = await viewer.backend.request("scopeSignals", {
        query: dumpScope(viewer, m.scope),
        offset: Math.max(0, m.offset || 0),
        limit: Number.isInteger(m.limit)
          ? Math.max(1, Math.min(512, m.limit))
          : 512,
      });
      return { ...result, scope: m.scope };
    },
    taggedFocus: async (reference) => {
      const viewer = getCurrent();
      const signal =
        viewer &&
        sidebarTags
          .get(viewer)
          ?.state.taggedSignals.find(
            (entry) => WaveSignal.key(entry) === WaveSignal.key(reference),
          );
      if (!signal) return;
      viewer.panel.reveal(viewer.panel.viewColumn, true);
      await viewer.ui("selectSignals", { signals: [signal], reveal: true });
      if (
        viewer.kdb &&
        signal.instanceScope &&
        !signal.instanceScope.startsWith("$")
      )
        await revealScope(
          viewer,
          signal.instanceScope,
          () => getCurrent() === viewer && !viewer.disposed,
        );
    },
    tagAppearance: async (options) => {
      const viewer = getCurrent();
      if (!viewer?.meta) return;
      if (!viewer.panel.visible)
        viewer.panel.reveal(viewer.panel.viewColumn, true);
      await viewer.ui("tagAppearance", options);
    },
    addSignals: async (signals, editAnnotation) => {
      const viewer = getCurrent();
      if (!viewer) return;
      const resolved = await viewer.backend.request("describe", {
        descriptors: signals.slice(0, 100000),
      });
      await viewer.panel.webview.postMessage({
        type: "sidebarAdd",
        signals: resolved.filter((s) => s.supported),
        editAnnotation,
      });
      viewer.panel.reveal(viewer.panel.viewColumn, !editAnnotation);
    },
    visibility: (visible) => {
      for (const viewer of viewers)
        viewer.panel.webview.postMessage({
          type: "sidebarVisibility",
          visible,
        });
    },
    select: (id) => {
      const target = [...viewers].find((v) => v.uri.toString() === id);
      if (target) setCurrent(target);
    },
    execute: (script) => executeTcl(getCurrent(), script),
    action: async (action) => {
      if (
        ![
          "open",
          "openPicker",
          "openRecent",
          "openProject",
          "saveProject",
          "attachKdb",
          "runScript",
          "showTclConsole",
          "cacheStats",
          "debugLayout",
          "configureLayout",
        ].includes(action)
      )
        throw new Error("Unknown sidebar action");
      await vscode.commands.executeCommand("waveWorkbench." + action);
    },
  });
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      "waveWorkbench.control",
      sidebar,
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("waveWorkbench.showSidebar", () =>
      vscode.commands.executeCommand("waveWorkbench.control.focus"),
    ),
  );

  return {
    refresh: () => sidebar.refresh(),
    log: (message: string, waveform?: string) => sidebar.log(message, waveform),
    rememberScript: (script: string) => sidebar.remember(script),
    logTcl,
    sidebarTree,
    updateSidebarTags,
  };
}
