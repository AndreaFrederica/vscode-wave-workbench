// SPDX-License-Identifier: MPL-2.0

import { localize } from "./shared/localization";
import type * as vscode from "vscode";
import type { GetViewer } from "./wave-extension-types";
import type { Viewer } from "./viewer";

const wavePanel = "waveWorkbench.panelWave";

export function registerWaveDock(
  code: typeof vscode,
  context: vscode.ExtensionContext,
  getCurrent: GetViewer,
) {
  let view: vscode.WebviewView | undefined;
  let viewer: Viewer | undefined;
  let unmount: (() => void) | undefined;

  function mount() {
    unmount?.();
    unmount = undefined;
    if (!view) return;
    if (viewer?.mountDock && !viewer.disposed) {
      view.description = viewer.uri.path.split("/").at(-1);
      unmount = viewer.mountDock(view);
    } else {
      view.description = undefined;
      view.webview.html =
        '<!doctype html><html lang="zh-CN"><meta charset="utf-8">' +
        "<p>" +
        localize("打开波形后，使用波形工具栏的「移到底部」。") +
        "</p></html>";
    }
  }

  async function show(target = getCurrent()) {
    if (!target) {
      await code.window.showInformationMessage(localize("先打开波形。"));
      return;
    }
    await target.ready;
    if (target.disposed || !target.meta) return;
    if (target !== viewer) {
      viewer = target;
      mount();
    }
    if (view) view.show(false);
    else await code.commands.executeCommand(wavePanel + ".focus");
  }

  function remove(target: Viewer) {
    if (viewer !== target) return;
    viewer = undefined;
    mount();
  }

  context.subscriptions.push(
    code.window.registerWebviewViewProvider(
      wavePanel,
      {
        resolveWebviewView(next) {
          view = next;
          mount();
          next.onDidDispose(() => {
            if (view !== next) return;
            view = undefined;
            unmount?.();
            unmount = undefined;
          });
        },
      },
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
    code.commands.registerCommand("waveWorkbench.dockWave", () => show()),
    code.commands.registerCommand("waveWorkbench.showPanelTrace", () =>
      code.commands.executeCommand("waveWorkbench.panelTrace.focus"),
    ),
  );
  return { show, remove };
}
