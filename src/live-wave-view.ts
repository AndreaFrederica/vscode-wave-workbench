// SPDX-License-Identifier: MPL-2.0

import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import type * as vscode from "vscode";
import type { LiveTraceSession } from "./rtl-live-trace";

export const liveWaveViewId = "waveWorkbench.liveWave";

export class LiveWaveView
  implements vscode.WebviewViewProvider, vscode.Disposable
{
  private session?: LiveTraceSession;
  private unsubscribe?: () => void;
  private view?: vscode.WebviewView;
  private ready = false;
  private timer?: ReturnType<typeof setTimeout>;
  private posted?: {
    sessionId: string;
    revision: number;
    state: string;
    failure?: string;
  };
  private sending = false;
  private pending = false;

  constructor(
    private readonly code: typeof vscode,
    private readonly context: vscode.ExtensionContext,
  ) {}

  setSession(session: LiveTraceSession) {
    if (this.session === session) return;
    this.unsubscribe?.();
    this.session?.disposeWaveHistory();
    this.session = session;
    this.unsubscribe = session.onWaveUpdate(() => this.schedule());
    this.schedule();
  }

  async show() {
    if (this.view) this.view.show(true);
    else
      await this.code.commands.executeCommand(liveWaveViewId + ".focus", {
        preserveFocus: true,
      });
  }

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    this.ready = false;
    this.posted = undefined;
    const { code, context } = this;
    const media = code.Uri.joinPath(context.extensionUri, "media");
    const scripts = code.Uri.joinPath(context.extensionUri, "dist", "webview");
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [media, scripts],
    };
    const nonce = randomBytes(16).toString("hex");
    view.webview.html = readFileSync(
      context.asAbsolutePath("media/live-wave.html"),
      "utf8",
    )
      .replaceAll("{{csp}}", view.webview.cspSource)
      .replaceAll("{{nonce}}", nonce)
      .replace(
        "{{css}}",
        view.webview
          .asWebviewUri(code.Uri.joinPath(media, "live-wave.css"))
          .toString(),
      )
      .replace(
        "{{script}}",
        view.webview
          .asWebviewUri(code.Uri.joinPath(scripts, "live-wave.js"))
          .toString(),
      );

    const messages = view.webview.onDidReceiveMessage((message) => {
      if (this.view !== view) return;
      if (message?.type === "ready") {
        this.ready = true;
        this.posted = undefined;
        this.schedule();
      } else if (message?.type === "readWindow") {
        void this.readWindow(view, message);
      }
    });
    const visibility = view.onDidChangeVisibility(() => {
      if (view.visible) this.schedule();
    });
    view.onDidDispose(() => {
      messages.dispose();
      visibility.dispose();
      if (this.view === view) {
        this.view = undefined;
        this.ready = false;
        this.posted = undefined;
      }
    });
  }

  private schedule() {
    if (!this.view?.visible || !this.ready) return;
    if (this.sending) {
      this.pending = true;
      return;
    }
    this.timer ??= setTimeout(() => {
      this.timer = undefined;
      void this.publish();
    }, 80);
  }

  private async publish() {
    const { session, view } = this;
    if (!session || !view?.visible || !this.ready) return;
    const previous = this.posted;
    const update = session.waveUpdate();
    if (
      previous?.sessionId === session.id &&
      previous.revision === update.revision &&
      previous.state === update.state &&
      previous.failure === update.failure
    )
      return;
    this.sending = true;
    try {
      if (
        (await view.webview.postMessage({ type: "liveWave", ...update })) &&
        this.view === view &&
        this.posted === previous
      ) {
        const { sessionId, revision, state, failure } = update;
        this.posted = { sessionId, revision, state, failure };
      }
    } catch {
      // The next visible webview syncs from retained samples after a disposal.
    } finally {
      this.sending = false;
      if (this.pending) {
        this.pending = false;
        this.schedule();
      }
    }
  }

  private async readWindow(
    view: vscode.WebviewView,
    message: {
      sessionId: string;
      request: number;
      start: string;
      end: string;
      cursor: string;
    },
  ) {
    const session = this.session;
    const { sessionId, request } = message;
    const validTick = (value: unknown) =>
      typeof value === "string" && /^\d{1,20}$/.test(value);
    if (
      !session ||
      session.id !== sessionId ||
      !Number.isSafeInteger(request) ||
      ![message.start, message.end, message.cursor].every(validTick)
    )
      return;
    const start = BigInt(message.start);
    const end = BigInt(message.end);
    if (end < start) return;
    const prefix = { type: "liveWaveWindow", sessionId, request };
    const reply = await session
      .readWaveWindow(start, end, BigInt(message.cursor))
      .catch((error: unknown) => ({
        error: error instanceof Error ? error.message : String(error),
      }));
    if (this.session === session && this.view === view) {
      try {
        await view.webview.postMessage({ ...prefix, ...reply });
      } catch {
        // Closing the view can cancel an in-flight response.
      }
    }
  }

  dispose() {
    clearTimeout(this.timer);
    this.unsubscribe?.();
    this.session?.disposeWaveHistory();
    this.view = undefined;
    this.session = undefined;
  }
}
