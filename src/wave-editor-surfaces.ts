// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type * as vscode from "vscode";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import { localizeHtml } from "./shared/localization";
import type { Viewer } from "./viewer";
import type { configureWaveEditorBackend } from "./wave-editor-backend";

interface DockSelection {
  active?: string;
  keys: string[];
  scrollTop: number;
}

export function createWaveEditorSurfaces(
  vscode: typeof import("vscode"),
  context: vscode.ExtensionContext,
  viewer: Viewer,
  panel: vscode.WebviewPanel,
  {
    metadata,
    receive,
    setCurrent,
    refreshSidebar,
  }: {
    metadata(): ReturnType<
      ReturnType<typeof configureWaveEditorBackend>["metadataMessage"]
    >;
    receive(surface: vscode.Webview, message: unknown): Promise<void>;
    setCurrent(viewer: Viewer): void;
    refreshSidebar(): void;
  },
) {
  const { document } = viewer;
  let dock: vscode.WebviewView | undefined;
  let dockActive = false;
  let editorRestore = false;
  let dockSelection: DockSelection | undefined;
  let dockReady = false;
  function stateMessage() {
    return {
      type: "dockState",
      ...metadata(),
      view: document.view ?? document.savedView,
      selection: dockSelection,
      scope: viewer.selectedScope,
      kdb: viewer.kdb?.path,
    };
  }

  function syncEditorSurface() {
    if (panel.visible === false) return;
    if (dockActive) {
      void panel.webview.postMessage({
        type: "dockVisibility",
        docked: true,
      });
    } else if (editorRestore) {
      editorRestore = false;
      void panel.webview.postMessage(stateMessage());
      void panel.webview.postMessage({
        type: "dockVisibility",
        docked: false,
      });
    }
  }

  function syncDockSurface() {
    if (viewer.disposed) return;
    const activate = !!dock?.visible && dockReady;
    if (activate === dockActive) return;
    dockActive = activate;
    if (activate) {
      editorRestore = true;
      setCurrent(viewer);
      void dock.webview.postMessage(stateMessage());
    }
    syncEditorSurface();
    refreshSidebar();
  }

  function mountDock(view: vscode.WebviewView) {
    dock = view;
    dockReady = false;
    const messages = view.webview.onDidReceiveMessage((msg) =>
      receive(view.webview, msg),
    );
    const visibility = view.onDidChangeVisibility(syncDockSurface);
    renderSurface(vscode, context, view.webview, true);
    return () => {
      messages.dispose();
      visibility.dispose();
      if (dock !== view) return;
      dock = undefined;
      dockReady = false;
      syncDockSurface();
    };
  }

  return {
    get panel(): vscode.WebviewPanel {
      if (!dockActive || !dock) return panel;
      const surface = dock;
      return {
        webview: surface.webview,
        get visible() {
          return surface.visible;
        },
        get active() {
          return panel.active;
        },
        get viewColumn() {
          return panel.viewColumn;
        },
        reveal: (_column, preserveFocus) => surface.show(preserveFocus),
        dispose: () => panel.dispose(),
      } as vscode.WebviewPanel;
    },
    syncEditorSurface,
    mountDock,
    acceptDockReady(surface: vscode.Webview) {
      if (dock?.webview === surface) dockReady = true;
      syncDockSurface();
    },
    updateSelection(selection: DockSelection) {
      dockSelection = selection;
    },
    renderEditor: () => renderSurface(vscode, context, panel.webview),
  };
}

function renderSurface(
  vscode: typeof import("vscode"),
  context: vscode.ExtensionContext,
  surface: vscode.Webview,
  bottom = false,
) {
  surface.options = {
    enableScripts: true,
    localResourceRoots: [
      vscode.Uri.joinPath(context.extensionUri, "media"),
      vscode.Uri.joinPath(context.extensionUri, "dist", "webview"),
    ],
  };
  const nonce = crypto.randomBytes(16).toString("hex");
  const resource = (name: string) =>
    surface
      .asWebviewUri(
        vscode.Uri.joinPath(
          context.extensionUri,
          name.endsWith(".js") ? "dist/webview" : "media",
          name,
        ),
      )
      .toString();
  surface.html = localizeHtml(
    fs.readFileSync(context.asAbsolutePath("media/index.html"), "utf8"),
  )
    .replaceAll("{{csp}}", surface.cspSource)
    .replaceAll("{{nonce}}", nonce)
    .replace("{{css}}", resource("wave.css"))
    .replace("{{script}}", resource("wave.js"))
    .replace("<body>", bottom ? '<body data-dock="true">' : "<body>");
}
