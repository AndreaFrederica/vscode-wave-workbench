// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Viewer, WaveDocument } from "./viewer";
import { restoreView } from "./view-state";
import { designSnapshot } from "./project";

type DocumentMethods = Omit<
  vscode.CustomEditorProvider<WaveDocument>,
  "resolveCustomEditor"
>;

export function createWaveDocuments(
  api: typeof vscode,
  viewers: Set<Viewer>,
  projectChanges: vscode.EventEmitter<
    vscode.CustomDocumentContentChangeEvent<WaveDocument>
  >,
  saveProject: (
    viewer: Viewer,
    filename?: string,
    cancellation?: vscode.CancellationToken,
  ) => Promise<string>,
  refreshSidebar: () => void,
): DocumentMethods {
  return {
    onDidChangeCustomDocument: projectChanges.event,
    async openCustomDocument(uri, openContext) {
      const backupId = openContext?.backupId;
      const backup: WaveDocument["backup"] = backupId
        ? JSON.parse(await fs.promises.readFile(backupId, "utf8"))
        : undefined;
      return {
        uri,
        backup,
        projectPath: backup?.projectPath,
        savedView: backup?.savedView,
        savedKdb: backup?.savedKdb,
        savedDesignView: backup?.savedDesignView,
        dirty: !!backup,
        dispose() {},
      };
    },
    async saveCustomDocument(document, cancellation) {
      const viewer = [...viewers].find((view) => view.document === document);
      if (!viewer || cancellation.isCancellationRequested)
        throw new api.CancellationError();
      if (
        !(
          document.projectPath &&
          document.view &&
          document.view === document.savedView &&
          viewer.kdb?.path === document.savedKdb &&
          JSON.stringify(designSnapshot(viewer)) ===
            JSON.stringify(document.savedDesignView)
        )
      ) {
        if (!(await saveProject(viewer, undefined, cancellation)))
          throw new api.CancellationError();
      }
      document.dirty = false;
      await viewer.panel.webview.postMessage({
        type: "projectSaved",
        view: document.savedView,
      });
    },
    async saveCustomDocumentAs(document, destination, cancellation) {
      if (
        destination.scheme !== "file" ||
        !/\.waveproj$/i.test(destination.fsPath)
      )
        throw Error("请选择 .waveproj 作为工程文件扩展名");
      const viewer = [...viewers].find((view) => view.document === document);
      if (
        !viewer ||
        !(await saveProject(viewer, destination.fsPath, cancellation))
      )
        throw new api.CancellationError();
      document.dirty = false;
      await viewer.panel.webview.postMessage({
        type: "projectSaved",
        view: document.savedView,
      });
    },
    async revertCustomDocument(document) {
      const viewer = [...viewers].find((view) => view.document === document);
      if (!viewer || !document.savedView) return;
      const restored = await restoreView(
        viewer.backend,
        document.savedView,
        viewer.meta,
      );
      if (document.savedKdb !== viewer.kdb?.path) {
        if (document.savedKdb) await viewer.attachKdb(document.savedKdb, false);
        else {
          viewer.kdb?.dispose();
          viewer.kdb = null;
          viewer.treeCache.clear();
          viewer.treeExpanded.clear();
          refreshSidebar();
          await viewer.panel.webview.postMessage({ type: "kdbDetached" });
        }
      }
      await viewer.restoreDesignView?.(document.savedDesignView);
      await viewer.ui("restoreView", { ...restored, projectBaseline: true });
      document.dirty = false;
    },
    async backupCustomDocument(document, { destination }, cancellation) {
      const viewer = [...viewers].find((view) => view.document === document);
      const view = document.view || document.backup?.view;
      if (!view || cancellation.isCancellationRequested)
        throw new api.CancellationError();
      const filename = destination.fsPath;
      await fs.promises.mkdir(path.dirname(filename), { recursive: true });
      const backup: WaveDocument["backup"] = {
        view,
        kdb: viewer?.kdb?.path,
        designView: viewer && designSnapshot(viewer),
        savedView: document.savedView,
        savedKdb: document.savedKdb,
        savedDesignView: document.savedDesignView,
        projectPath: document.projectPath,
      };
      await fs.promises.writeFile(filename, JSON.stringify(backup), {
        mode: 0o600,
      });
      return {
        id: filename,
        delete: () => {
          void fs.promises.rm(filename, { force: true }).catch(() => {});
        },
      };
    },
  };
}
