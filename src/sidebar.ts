// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type * as VSCode from "vscode";
import type {
  Signal,
  Location,
  SearchResult,
  TaggedSignal,
  TagState,
} from "./shared/protocol";
interface Hooks {
  state: () => {
    sessions: unknown[];
    activeId: string;
    tree: Location[];
    scope?: string;
    includeOther?: boolean;
    revealScope?: string;
    revealId?: number;
    tagState?: TagState;
  };
  visibility?: (visible: boolean) => void;
  tree: (scope: string, action: string) => Promise<void>;
  scopeSignals?: (m: {
    scope: string;
    offset?: number;
    limit?: number;
  }) => Promise<SearchResult>;
  addSignals?: (signals: Signal[], editAnnotation?: boolean) => Promise<void>;
  taggedFocus?: (signal: TaggedSignal) => Promise<void>;
  tagAppearance?: (options: {
    style?: string;
    tag?: string;
    color?: string;
  }) => Promise<void>;
  select: (id: string) => void;
  execute: (script: string) => Promise<unknown>;
  action: (action: string) => Promise<void>;
}
import * as fs from "node:fs";
import * as crypto from "node:crypto";
class Sidebar implements VSCode.WebviewViewProvider {
  vscode: typeof VSCode;
  context: VSCode.ExtensionContext;
  hooks: Hooks;
  logs: { text: string; session: string }[];
  history: string[];
  executing: number;
  view: VSCode.WebviewView;
  constructor(
    vscode: typeof VSCode,
    context: VSCode.ExtensionContext,
    hooks: Hooks,
  ) {
    Object.assign(this, { vscode, context, hooks });
    this.logs = [];
    this.history = [];
    this.executing = 0;
  }
  remember(script: string) {
    this.history = this.history.filter((s) => s !== script);
    this.history.push(script);
    this.history = this.history.slice(-50);
    while (this.history.reduce((n, s) => n + s.length, 0) > 64000)
      this.history.shift();
  }
  log(text: unknown, session = "") {
    this.logs.push({ text: String(text).slice(-16000), session });
    while (
      this.logs.length > 150 ||
      this.logs.reduce((n, x) => n + x.text.length, 0) > 64000
    )
      this.logs.shift();
    this.refresh();
  }
  refresh() {
    this.hooks.visibility?.(!!this.view?.visible);
    return this.view?.webview.postMessage({
      type: "state",
      executing: this.executing,
      ...this.hooks.state(),
      logs: this.logs,
      history: this.history,
    });
  }
  resolveWebviewView(view: VSCode.WebviewView) {
    this.view = view;
    const { vscode, context } = this;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(context.extensionUri, "media"),
        vscode.Uri.joinPath(context.extensionUri, "dist", "webview"),
      ],
    };
    const nonce = crypto.randomBytes(16).toString("hex");
    const resource = (name: string) =>
      view.webview
        .asWebviewUri(
          vscode.Uri.joinPath(
            context.extensionUri,
            name.endsWith(".js") ? "dist/webview" : "media",
            name,
          ),
        )
        .toString();
    view.webview.html = fs
      .readFileSync(context.asAbsolutePath("media/sidebar.html"), "utf8")
      .replaceAll("{{csp}}", view.webview.cspSource)
      .replaceAll("{{nonce}}", nonce)
      .replace("{{css}}", resource("sidebar.css"))
      .replace("{{script}}", resource("sidebar.js"));
    view.onDidDispose(() => {
      if (this.view === view) {
        this.view = null;
        this.hooks.visibility?.(false);
      }
    });
    view.onDidChangeVisibility(() => this.refresh());
    view.webview.onDidReceiveMessage(async (m) => {
      let executing = false;
      try {
        if (
          ["scopePage", "instanceSignals"].includes(m.type) &&
          typeof m.scope === "string"
        ) {
          const result = await this.hooks.scopeSignals?.(m);
          if (result)
            await view.webview.postMessage({
              type: m.type,
              request: m.request,
              ...result,
            });
        } else if (m.type === "addSignals" && Array.isArray(m.signals))
          await this.hooks.addSignals?.(m.signals, m.editAnnotation === true);
        else if (m.type === "taggedFocus" && m.signal)
          await this.hooks.taggedFocus?.(m.signal);
        else if (m.type === "tagAppearance")
          await this.hooks.tagAppearance?.({
            style: m.style,
            tag: m.tag,
            color: m.color,
          });
        else if (m.type === "ready") await this.refresh();
        else if (m.type === "select" && typeof m.id === "string") {
          this.hooks.select(m.id);
          await this.refresh();
        } else if (
          m.type === "tree" &&
          typeof m.scope === "string" &&
          ["expand", "select", "source", "back", "forward", "mode"].includes(
            m.action,
          )
        )
          await this.hooks.tree(m.scope, m.action);
        else if (
          m.type === "execute" &&
          typeof m.script === "string" &&
          m.script.trim()
        ) {
          if (Buffer.byteLength(m.script) > 1024 * 1024)
            throw new Error("Script size exceeds 1 MiB");
          const script = m.script.trim();
          executing = true;
          this.executing++;
          this.remember(script);
          await this.hooks.execute(script);
        } else if (m.type === "action" && typeof m.action === "string")
          await this.hooks.action(m.action);
        else if (m.type === "clear") {
          this.logs = [];
          await this.refresh();
        }
      } catch (e) {
        if (m.type === "instanceSignals")
          await view.webview.postMessage({
            type: m.type,
            scope: m.scope,
            request: m.request,
            error: true,
          });
        if (!e.sidebarLogged) this.log("ERROR: " + e.message);
      } finally {
        if (executing) this.executing--;
        await this.refresh();
        if (m.type === "execute")
          await view.webview.postMessage({ type: "complete" });
      }
    });
  }
}
export { Sidebar };
