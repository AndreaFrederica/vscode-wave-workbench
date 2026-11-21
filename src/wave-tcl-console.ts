// SPDX-License-Identifier: MPL-2.0

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { HELP, quote, WAVE_COMMAND_OPTIONS } from "./commands";
import { toolDefinitions } from "./wave-tools";
import { normalName } from "./signal-lookup";
import type * as vscode from "vscode";
import { localize, localizeHtml } from "./shared/localization";
import type {
  TclConsoleCompletion,
  TclConsoleConfig,
  TclConsoleEntry,
  TclConsoleState,
  TclSignalSuggestions,
} from "./shared/tcl-console";
import type { Viewer } from "./viewer";
import type { GetViewer } from "./wave-extension-types";
import type { createWaveTcl } from "./wave-tcl";

const viewId = "waveWorkbench.panelTcl";
const maxScriptSize = 1024 * 1024;
const maxEntrySize = 32 * 1024;
const supportedCommands = [
  ...new Set(HELP.match(/\b(?:wv|wave|src)[A-Z]\w*/g)),
  "waveHelp",
];
const tools = [
  "list",
  ...toolDefinitions
    .map(({ name }) => name)
    .filter((name) => name !== "wave_tcl"),
];
type Evaluate = ReturnType<typeof createWaveTcl>["executeInteractive"];

interface ConsoleSession {
  id: number;
  entries: TclConsoleEntry[];
  history: string[];
  running: boolean;
  revision: number;
  completion?: TclConsoleCompletion;
}

export function registerWaveTclConsole(
  code: typeof vscode,
  context: vscode.ExtensionContext,
  getCurrent: GetViewer,
  viewers: ReadonlySet<Viewer>,
  evaluate: Evaluate,
) {
  const sessions = new WeakMap<Viewer, ConsoleSession>();
  let selected: Viewer | undefined;
  let view: vscode.WebviewView | undefined;
  let signature = "";
  let sequence = 0;
  let entryId = 0;
  let promptFocus = false;

  function session(viewer: Viewer) {
    let state = sessions.get(viewer);
    if (!state) {
      state = {
        id: ++sequence,
        entries: [],
        history: [],
        running: false,
        revision: 0,
      };
      sessions.set(viewer, state);
    }
    return state;
  }

  function current() {
    if (selected?.meta && !selected.disposed) return selected;
    const active = getCurrent();
    return active?.meta && !active.disposed ? active : undefined;
  }

  function refresh(force = false) {
    if (!view?.visible) return;
    const active = current();
    const focused = active ? session(active) : undefined;
    const available = [...viewers]
      .filter((viewer) => viewer.meta && !viewer.disposed)
      .map((viewer) => ({
        id: session(viewer).id,
        name: basename(viewer.uri.fsPath),
        path: viewer.uri.fsPath,
      }));
    const next = JSON.stringify([available, focused?.id, focused?.revision]);
    if (!force && next === signature) return;
    signature = next;
    const message: TclConsoleState = {
      type: "state",
      sessions: available,
      active: focused?.id,
      running: focused?.running ?? false,
      entries: focused?.entries ?? [],
      history: focused?.history ?? [],
      completion: focused?.completion,
    };
    void view.webview.postMessage(message);
  }

  function append(
    state: ConsoleSession,
    kind: TclConsoleEntry["kind"],
    text: string,
    json?: true,
  ) {
    state.entries.push({
      id: ++entryId,
      kind,
      text: text.slice(0, maxEntrySize),
      json,
    });
    if (state.entries.length > 300)
      state.entries.splice(0, state.entries.length - 300);
    let bytes = 0;
    for (let i = state.entries.length - 1; i >= 0; i--) {
      bytes += Buffer.byteLength(state.entries[i].text);
      if (bytes > 256 * 1024) {
        state.entries.splice(0, i + 1);
        break;
      }
    }
    state.revision++;
    refresh();
  }

  async function run(viewer: Viewer, source: string, request: number) {
    const state = session(viewer);
    if (state.running) return;
    state.running = true;
    state.revision++;
    refresh();
    let incomplete = false;
    let recorded = false;
    function recordCommand() {
      if (recorded) return;
      recorded = true;
      if (
        Buffer.byteLength(source) <= 32 * 1024 &&
        state.history.at(-1) !== source
      ) {
        state.history.push(source);
        let bytes = 0;
        for (let i = state.history.length - 1; i >= 0; i--) {
          bytes += Buffer.byteLength(state.history[i]);
          if (bytes > 128 * 1024 || state.history.length - i > 100) {
            state.history.splice(0, i + 1);
            break;
          }
        }
      }
      append(state, "command", source);
    }

    try {
      if (Buffer.byteLength(source) > maxScriptSize)
        throw Error(localize("Tcl 脚本超过 1 MiB。"));
      const structured = new Set<string>();
      const result = await evaluate(viewer, source, {
        signal: new AbortController().signal,
        structured: (text) => {
          if (
            structured.size < 16 &&
            text.length <= maxEntrySize &&
            /^(?:\{|\[)/.test(text)
          )
            structured.add(text);
        },
        write: (text) => {
          recordCommand();
          append(state, "output", text);
        },
      });
      incomplete = result === undefined;
      if (!incomplete) {
        recordCommand();
        if (result)
          append(
            state,
            "result",
            result,
            structured.has(result) ? true : undefined,
          );
      }
    } catch (error) {
      recordCommand();
      append(
        state,
        "error",
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      state.running = false;
      state.completion = { request, incomplete };
      state.revision++;
      refresh();
    }
  }

  function configure(surface: vscode.WebviewView) {
    const config = code.workspace.getConfiguration("debug.console");
    const fontFamily = config.get<string>("fontFamily");
    const message: TclConsoleConfig = {
      type: "config",
      fontFamily: fontFamily === "default" ? undefined : fontFamily,
      fontSize: config.get<number>("fontSize"),
      lineHeight: config.get<number>("lineHeight"),
      commands: supportedCommands,
      options: WAVE_COMMAND_OPTIONS,
      tools,
    };
    void surface.webview.postMessage(message);
  }

  async function suggestSignals(
    surface: vscode.WebviewView,
    viewer: Viewer,
    request: number,
    prefix: string,
  ) {
    const message: TclSignalSuggestions = {
      type: "signals",
      request,
      signals: [],
    };
    try {
      const { signals } = await viewer.backend.request("search", {
        query: normalName(prefix),
        limit: 50,
      });
      const seen = new Set<string>();
      for (const signal of signals) {
        const name = normalName(signal.name, ".");
        const fullname = signal.scope ? signal.scope + "." + name : name;
        if (!signal.supported || seen.has(fullname)) continue;
        seen.add(fullname);
        const slashPath = prefix.startsWith("/") || prefix.includes("/");
        const label = slashPath
          ? "/" + fullname.replaceAll(".", "/")
          : fullname;
        message.signals.push({
          label,
          detail: signal.scope,
          insertText: /^[\w./:@+-]+$/.test(label) ? label : quote(label),
        });
      }
    } catch {
      // The backend may close while a completion is in flight.
    }
    if (view === surface) {
      if (current() !== viewer) message.signals = [];
      void surface.webview.postMessage(message);
    }
  }

  function focusPrompt() {
    if (!promptFocus || !view?.visible) return;
    void view.webview.postMessage({ type: "focus" }).then((sent) => {
      if (sent) promptFocus = false;
    });
  }

  async function show(viewer = getCurrent()) {
    if (viewer && !viewer.disposed) selected = viewer;
    promptFocus = true;
    if (view) {
      view.show(false);
      refresh(true);
      focusPrompt();
    } else {
      await code.commands.executeCommand(viewId + ".focus");
    }
  }

  const media = code.Uri.joinPath(context.extensionUri, "media");
  const built = code.Uri.joinPath(context.extensionUri, "dist", "webview");
  context.subscriptions.push(
    code.window.registerWebviewViewProvider(
      viewId,
      {
        resolveWebviewView(surface) {
          view = surface;
          surface.webview.options = {
            enableScripts: true,
            localResourceRoots: [media, built],
          };
          const uri = (root: vscode.Uri, name: string) =>
            surface.webview
              .asWebviewUri(code.Uri.joinPath(root, name))
              .toString();
          const nonce = randomBytes(16).toString("hex");
          const chinese = /^zh(?:-|$)/i.test(code.env.language);
          const nls = chinese
            ? `<script nonce="${nonce}" src="${uri(built, "tcl-editor-zh-cn.js")}"></script>`
            : "";
          surface.webview.html = localizeHtml(
            readFileSync(
              context.asAbsolutePath("media/tcl-console.html"),
              "utf8",
            ),
          )
            .replaceAll("{{csp}}", surface.webview.cspSource)
            .replaceAll("{{nonce}}", nonce)
            .replace("{{nls}}", nls)
            .replace("{{editorCss}}", uri(built, "tcl-console.css"))
            .replace("{{worker}}", uri(built, "tcl-editor-worker.js"))
            .replace("{{css}}", uri(media, "tcl-console.css"))
            .replace("{{script}}", uri(built, "tcl-console.js"));
          const messages = surface.webview.onDidReceiveMessage((message) => {
            if (view !== surface) return;
            if (message?.type === "ready") {
              configure(surface);
              refresh(true);
              focusPrompt();
            } else if (message?.type === "copy") {
              if (
                typeof message.text === "string" &&
                Buffer.byteLength(message.text) <= 270 * 1024
              )
                void code.env.clipboard.writeText(message.text);
            } else if (message?.type === "select") {
              const target = [...viewers].find(
                (viewer) => session(viewer).id === message.session,
              );
              if (target?.meta && !target.disposed) selected = target;
              refresh(true);
            } else {
              const active = current();
              if (!active || session(active).id !== message?.session) return;
              if (
                message.type === "signals" &&
                typeof message.prefix === "string" &&
                message.prefix.length <= 256 &&
                Number.isSafeInteger(message.request)
              ) {
                void suggestSignals(
                  surface,
                  active,
                  message.request,
                  message.prefix,
                );
              } else if (message.type === "clear") {
                const state = session(active);
                state.entries.length = 0;
                state.revision++;
                refresh();
              } else if (
                message.type === "run" &&
                typeof message.source === "string" &&
                message.source.trim() &&
                Number.isSafeInteger(message.request)
              ) {
                void run(active, message.source, message.request);
              }
            }
          });
          const visibility = surface.onDidChangeVisibility(() => {
            refresh(true);
            focusPrompt();
          });
          const settings = code.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration("debug.console")) configure(surface);
          });
          surface.onDidDispose(() => {
            settings.dispose();
            messages.dispose();
            visibility.dispose();
            if (view === surface) view = undefined;
          });
        },
      },
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
    code.commands.registerCommand("waveWorkbench.showTclConsole", () => show()),
  );
  return { show, refresh };
}
