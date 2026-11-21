// SPDX-License-Identifier: MPL-2.0

import { localize } from "../shared/localization";
import type {
  TclConsoleConfig,
  TclConsoleEntry,
  TclConsoleState,
  TclSignalSuggestions,
} from "../shared/tcl-console";
import {
  createTclEditor,
  monaco,
  registerTclCompletions,
} from "./tcl-console-editor";

const vscode = acquireVsCodeApi();
const sessions = document.querySelector<HTMLSelectElement>("#session")!;
const transcript = document.querySelector<HTMLDivElement>("#transcript")!;
const filter = document.querySelector<HTMLInputElement>("#filter")!;
const prompt = document.querySelector<HTMLSpanElement>("#prompt")!;
const run = document.querySelector<HTMLButtonElement>("#run")!;
const clear = document.querySelector<HTMLButtonElement>("#clear")!;
const copy = document.querySelector<HTMLButtonElement>("#copy")!;
const { editor, applyStyle } = createTclEditor(
  document.querySelector("#command")!,
);
const drafts = new Map<number, { text: string; continuation: boolean }>();
const pending = new Map<number, number>();
const signalRequests = new Map<
  number,
  (signals: TclSignalSuggestions["signals"]) => void
>();
const outputRows = new Map<number, HTMLElement>();
let state: TclConsoleState | undefined;
let config: TclConsoleConfig | undefined;
let request = 0;
let historyIndex = 0;
let historyDraft = "";
let continuation = false;
let sessionSignature = "";
let visibleEntries: TclConsoleEntry[] = [];
let following = true;
let previousHeight = transcript.clientHeight;

function makeRow(entry: TclConsoleEntry) {
  if (entry.json) {
    const details = document.createElement("details");
    details.className = "entry result";
    const summary = document.createElement("summary");
    summary.textContent = localize("JSON 结果");
    details.append(summary);
    details.addEventListener("toggle", () => {
      if (!details.open || details.childElementCount > 1) return;
      const content = document.createElement("pre");
      try {
        content.textContent = JSON.stringify(JSON.parse(entry.text), null, 2);
      } catch {
        content.textContent = entry.text;
      }
      details.append(content);
    });
    return details;
  }
  const row = document.createElement("p");
  row.className = "entry " + entry.kind;
  row.textContent = (entry.kind === "command" ? "› " : "") + entry.text;
  return row;
}

function atBottom() {
  return (
    transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight <=
    16
  );
}

function renderOutput(reset = false) {
  const query = filter.value.trim().toLowerCase();
  const entries = (state?.entries ?? []).filter(
    ({ text }) => !query || text.toLowerCase().includes(query),
  );
  copy.disabled = entries.length === 0;
  if (
    !reset &&
    entries.length === visibleEntries.length &&
    entries.every((entry, index) => entry.id === visibleEntries[index].id)
  )
    return;
  visibleEntries = entries;

  const follow = reset || following;
  const top = transcript.getBoundingClientRect().top;
  const anchor = follow
    ? undefined
    : [...outputRows.values()].find(
        (row) => row.getBoundingClientRect().bottom > top,
      );
  const offset = anchor ? anchor.getBoundingClientRect().top - top : 0;
  const remaining = new Set(entries.map(({ id }) => id));
  for (const [id, row] of outputRows) {
    if (remaining.has(id)) continue;
    row.remove();
    outputRows.delete(id);
  }
  transcript.querySelector(".empty")?.remove();
  if (entries.length === 0) {
    const hint = document.createElement("p");
    hint.className = "entry empty";
    hint.textContent =
      state?.active === undefined
        ? localize("打开一个波形以使用 Tcl 控制台。")
        : query && state.entries.length
          ? localize("没有匹配的输出。")
          : localize("输入 waveHelp 查看可用命令。");
    transcript.append(hint);
    return;
  }
  const added = document.createDocumentFragment();
  for (const entry of entries) {
    if (outputRows.has(entry.id)) continue;
    const row = makeRow(entry);
    outputRows.set(entry.id, row);
    added.append(row);
  }
  transcript.append(added);
  if (follow) transcript.scrollTop = transcript.scrollHeight;
  else if (anchor?.isConnected)
    transcript.scrollTop += anchor.getBoundingClientRect().top - top - offset;
  following = atBottom();
}

function setCommand(text: string) {
  editor.setValue(text);
  const position = editor.getModel()!.getPositionAt(text.length);
  editor.setPosition(position);
  editor.revealPosition(position);
}

const canBrowseUp = editor.createContextKey<boolean>("waveTclHistoryUp", false);
const canBrowseDown = editor.createContextKey<boolean>(
  "waveTclHistoryDown",
  false,
);
function updateHistoryKeys() {
  const position = editor.getPosition()!;
  const selection = editor.getSelection()!;
  const available =
    !continuation && selection.isEmpty() && !!state?.history.length;
  canBrowseUp.set(available && position.lineNumber === 1);
  canBrowseDown.set(
    available &&
      historyIndex < state!.history.length &&
      position.lineNumber === editor.getModel()!.getLineCount(),
  );
}
editor.onDidChangeCursorSelection(updateHistoryKeys);
editor.onDidChangeModelContent(updateHistoryKeys);

function render(next: TclConsoleState) {
  const changed = !state || next.active !== state.active;
  const active = next.active;
  if (changed) {
    if (state?.active !== undefined)
      drafts.set(state.active, { text: editor.getValue(), continuation });
    const draft = active === undefined ? undefined : drafts.get(active);
    historyDraft = "";
    historyIndex = next.history.length;
    continuation = draft?.continuation ?? false;
    setCommand(draft?.text ?? "");
  } else if (historyIndex === state?.history.length) {
    historyIndex = next.history.length;
  }
  state = next;
  if (
    active !== undefined &&
    next.completion &&
    pending.get(active) === next.completion.request
  ) {
    pending.delete(active);
    continuation = next.completion.incomplete;
    historyIndex = next.history.length;
    if (continuation) {
      setReadOnly(false);
      const model = editor.getModel()!;
      const end = model.getPositionAt(model.getValueLength());
      editor.pushUndoStop();
      editor.executeEdits(
        "tcl-continuation",
        [
          {
            range: monaco.Range.fromPositions(end),
            text: "\n",
          },
        ],
        [
          monaco.Selection.fromPositions({
            lineNumber: end.lineNumber + 1,
            column: 1,
          }),
        ],
      );
      editor.pushUndoStop();
    } else setCommand("");
  }

  const nextSessions = JSON.stringify(next.sessions);
  if (sessionSignature !== nextSessions) {
    sessionSignature = nextSessions;
    const options = next.sessions.map((session) => {
      const option = new Option(session.name, String(session.id));
      option.title = session.path;
      return option;
    });
    const placeholder = new Option(localize("选择波形会话"), "");
    placeholder.disabled = options.length > 0;
    sessions.replaceChildren(placeholder, ...options);
    const available = new Set(next.sessions.map(({ id }) => id));
    for (const id of drafts.keys()) if (!available.has(id)) drafts.delete(id);
    for (const id of pending.keys()) if (!available.has(id)) pending.delete(id);
  }
  sessions.value = active === undefined ? "" : String(active);
  sessions.disabled = next.sessions.length === 0;
  setReadOnly(active === undefined || next.running || pending.has(active));
  clear.disabled = active === undefined || next.entries.length === 0;
  prompt.textContent = continuation ? "…" : "›";
  updateHistoryKeys();
  renderOutput(changed);
}

function setReadOnly(readOnly: boolean) {
  editor.updateOptions({ readOnly });
  run.disabled = readOnly;
}

function submit() {
  const active = state?.active;
  const source = editor.getValue();
  if (active === undefined || run.disabled || !source.trim()) return;
  pending.set(active, ++request);
  setReadOnly(true);
  vscode.postMessage({ type: "run", session: active, request, source });
}

function browseHistory(direction: number) {
  const history = state!.history;
  if (historyIndex === history.length) historyDraft = editor.getValue();
  historyIndex = Math.max(
    0,
    Math.min(history.length, historyIndex + direction),
  );
  setCommand(history[historyIndex] ?? historyDraft);
  if (direction < 0)
    editor.setPosition({
      lineNumber: 1,
      column: editor.getModel()!.getLineMaxColumn(1),
    });
  updateHistoryKeys();
}

const inputAvailable =
  "editorTextFocus && !editorReadonly && !isComposing && !suggestWidgetVisible";
editor.addCommand(monaco.KeyCode.Enter, submit, inputAvailable);
editor.addCommand(
  monaco.KeyMod.Shift | monaco.KeyCode.Enter,
  () => {
    editor.trigger("keyboard", "type", { text: "\n" });
  },
  "editorTextFocus && !editorReadonly && !isComposing",
);
editor.addCommand(
  monaco.KeyCode.UpArrow,
  () => browseHistory(-1),
  inputAvailable + " && waveTclHistoryUp",
);
editor.addCommand(
  monaco.KeyCode.DownArrow,
  () => browseHistory(1),
  inputAvailable + " && waveTclHistoryDown",
);

registerTclCompletions(
  () => config,
  (prefix, token) => {
    const active = state?.active;
    if (active === undefined || token.isCancellationRequested)
      return Promise.resolve([]);
    return new Promise((resolve) => {
      const id = ++request;
      const cancel = token.onCancellationRequested(() => finish([]));
      function finish(signals: TclSignalSuggestions["signals"]) {
        cancel.dispose();
        signalRequests.delete(id);
        resolve(signals);
      }
      signalRequests.set(id, finish);
      vscode.postMessage({
        type: "signals",
        session: active,
        request: id,
        prefix,
      });
    });
  },
);

new MutationObserver(() => applyStyle(config)).observe(document.body, {
  attributes: true,
  attributeFilter: ["class", "data-vscode-theme-id"],
});
new ResizeObserver(() => {
  const height = transcript.clientHeight;
  if (height === previousHeight) return;
  previousHeight = height;
  if (following) transcript.scrollTop = transcript.scrollHeight;
}).observe(transcript);
transcript.addEventListener("scroll", () => {
  following = atBottom();
});
filter.addEventListener("input", () => {
  // Rebuild in order when a wider filter restores previously hidden rows.
  outputRows.clear();
  transcript.replaceChildren();
  renderOutput(true);
});
window.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
    event.preventDefault();
    filter.focus();
    filter.select();
  } else if (event.key === "Escape" && document.activeElement === filter) {
    filter.value = "";
    filter.dispatchEvent(new Event("input"));
    editor.focus();
  }
});
run.addEventListener("click", () => {
  submit();
  editor.focus();
});
sessions.addEventListener("change", () =>
  vscode.postMessage({ type: "select", session: Number(sessions.value) }),
);
clear.addEventListener("click", () =>
  vscode.postMessage({ type: "clear", session: state?.active }),
);
copy.addEventListener("click", () =>
  vscode.postMessage({
    type: "copy",
    text: visibleEntries
      .map(({ kind, text }) => (kind === "command" ? "› " : "") + text)
      .join("\n"),
  }),
);
window.addEventListener(
  "message",
  (
    event: MessageEvent<
      | TclConsoleState
      | TclConsoleConfig
      | TclSignalSuggestions
      | { type: "focus" }
    >,
  ) => {
    const message = event.data;
    if (message.type === "state") render(message);
    else if (message.type === "config") {
      config = message;
      applyStyle(config);
    } else if (message.type === "signals")
      signalRequests.get(message.request)?.(message.signals);
    else if (message.type === "focus") editor.focus();
  },
);
applyStyle();
vscode.postMessage({ type: "ready" });
