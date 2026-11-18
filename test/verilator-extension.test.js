// SPDX-License-Identifier: MPL-2.0

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");

test("extension host opens Verilator FST, links RTL both ways and reopens a saved project", {
  skip: !process.env.WAVE_TEST_VERILATOR,
}, async (t) => {
  const root = path.resolve(__dirname, "..");
  const fixture = process.env.WAVE_TEST_VERILATOR;
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "wave-verilator-host-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const waveform = path.join(temporary, "renamed.fst");
  const project = path.join(temporary, "debug.waveproj");
  fs.copyFileSync(path.join(fixture, "top.fst"), waveform);
  const uri = (filename) => ({ scheme: "file", fsPath: filename, toString: () => filename });
  const sidebarMessages = [];
  const opened = [];
  const commands = new Map();
  const saved = new Map();
  const disposable = { dispose() {} };
  let provider, sidebarProvider, receiveSidebar, receive, close, document, hover, activeEditor;
  let selectedTree = false;
  let restored;
  let snapshot;
  class EventEmitter {
    event = () => disposable;
    fire() {}
    dispose() {}
  }
  class Position {
    constructor(line, character) { Object.assign(this, { line, character }); }
  }
  class Range {
    constructor(start, end) { Object.assign(this, { start, end }); }
  }
  class MarkdownString {
    value = "";
    appendText(text) { this.value += text; }
    appendMarkdown(text) { this.value += text; }
    appendCodeblock(text) { this.value += text; }
  }
  function rtl(filename) {
    const text = fs.readFileSync(filename, "utf8");
    const lines = text.split("\n");
    return {
      uri: uri(filename), version: 1, languageId: "systemverilog", lineCount: lines.length,
      getText(range) { return range ? lines[range.start.line].slice(range.start.character, range.end.character) : text; },
      lineAt(line) { return { text: lines[line] }; },
      offsetAt(position) { return lines.slice(0, position.line).reduce((n, line) => n + line.length + 1, 0) + position.character; },
      getWordRangeAtPosition(position) {
        const word = /^\w+/.exec(lines[position.line].slice(position.character))[0];
        return new Range(position, new Position(position.line, position.character + word.length));
      },
    };
  }
  const vscode = {
    EventEmitter, Position, Range, Selection: Range, MarkdownString,
    Hover: class { constructor(contents) { this.contents = contents; } },
    Uri: { file: uri, joinPath: (base, ...parts) => uri(path.join(base.fsPath, ...parts)) },
    ViewColumn: { One: 1, Two: 2, Beside: 2 },
    extensions: { getExtension: () => undefined },
    languages: { registerHoverProvider(_selector, service) { hover = service; return disposable; } },
    workspace: {
      getConfiguration: () => ({ get: () => undefined }),
      openTextDocument: async (file) => rtl(file.fsPath),
    },
    window: {
      registerCustomEditorProvider(_id, value) { provider = value; return disposable; },
      registerWebviewViewProvider(_id, value) { sidebarProvider = value; return disposable; },
      onDidChangeActiveTextEditor(handler) { activeEditor = handler; return disposable; },
      createOutputChannel: () => ({ append() {}, appendLine() {}, dispose() {} }),
      showQuickPick: async (values) => values[0],
      showOpenDialog: async () => {
        selectedTree = true;
        return [uri(path.join(fixture, "obj_dir/Vtop.tree.json"))];
      },
      showSaveDialog: async () => uri(project),
      showTextDocument: async (doc) => {
        const editor = { doc, revealRange() {} };
        opened.push(editor);
        return editor;
      },
      showErrorMessage(message) { assert.fail(message); },
    },
    commands: {
      registerCommand(name, handler) { commands.set(name, handler); return disposable; },
      async executeCommand(name, file) {
        if (name === "vscode.openWith") await open(file);
      },
    },
  };
  const extension = { exports: {} };
  const activate = vm.runInThisContext("(function(require,module,exports){" + fs.readFileSync(path.join(root, "dist/extension.js"), "utf8") + "\n})");
  activate((name) => name === "vscode" ? vscode : name.startsWith(".") ? require(path.join(root, "dist", name)) : require(name), extension, extension.exports);
  const context = {
    extensionUri: uri(root), asAbsolutePath: (p) => path.join(root, p), subscriptions: [],
    workspaceState: { get: (key, fallback) => saved.get(key) ?? fallback, update: async (key, value) => saved.set(key, value) },
  };
  extension.exports.activate(context);
  t.after(() => context.subscriptions.forEach((subscription) => subscription.dispose()));
  sidebarProvider.resolveWebviewView({
    visible: true, onDidDispose() {}, onDidChangeVisibility() {},
    webview: { asWebviewUri: (u) => u, onDidReceiveMessage(fn) { receiveSidebar = fn; }, postMessage: async (m) => sidebarMessages.push(m) },
  });
  const messages = [];
  async function open(file) {
    document = await provider.openCustomDocument(file);
    await provider.resolveCustomEditor(document, {
      active: true, visible: true, reveal() {}, onDidChangeViewState: () => disposable,
      onDidDispose(fn) { close = fn; return disposable; },
      webview: {
        asWebviewUri: (u) => u, onDidReceiveMessage(fn) { receive = fn; return disposable; },
        async postMessage(m) {
          messages.push(m);
          if (m.type === "ui") {
            if (m.action === "restoreView") restored = m.payload;
            queueMicrotask(() => receive({ type: "uiResult", id: m.id, result: snapshot }));
          }
        },
      },
    });
    await receive({ type: "ready" });
  }
  await commands.get("waveWorkbench.open")(uri(waveform));
  const meta = messages.find((m) => m.type === "metadata");
  assert.equal(meta.backend, "rust-fst");
  assert.ok(!messages.some((m) => m.type === "kdbAttached"));
  await commands.get("waveWorkbench.attachKdb")();
  assert.ok(selectedTree);
  await receiveSidebar({ type: "tree", scope: "TOP.top", action: "expand" });
  const scope = "TOP.top.u0";
  const pc = meta.signals.find((s) => s.scope === scope && s.name === "pc[3:0]");
  for (const [target, line] of [["declaration", 4], ["instance", 19], ["definition", 4]]) {
    await receive({ type: "source", ...pc, target });
    assert.equal(opened.at(-1).selection.start.line + 1, line);
  }
  await receive({ type: "rtlCursor", tick: 30, displayFactor: 1, displayScale: "ps" });
  const file = path.join(fixture, "fixture.sv");
  const doc = rtl(file);
  const position = new Position(7, doc.lineAt(7).text.indexOf("pc"));
  const tooltip = await hover.provideHover(doc, position, { isCancellationRequested: false });
  assert.match(tooltip.contents.value, /TOP\.top\.u0\.pc/);
  assert.match(tooltip.contents.value, /(?:0x)?F/i);
  const generate = scope + ".stages[0]";
  await receiveSidebar({ type: "tree", scope: generate, action: "select" });
  const generatePosition = new Position(11, doc.lineAt(11).text.indexOf("s ="));
  const generatedTooltip = await hover.provideHover(doc, generatePosition, { isCancellationRequested: false });
  assert.match(generatedTooltip.contents.value, /TOP\.top\.u0\.stages\[0\]\.s/);

  await receiveSidebar({ type: "tree", scope: "TOP.top", action: "select" });
  const editor = { document: doc, selection: { active: position } };
  vscode.window.activeTextEditor = editor;
  activeEditor(editor);
  for (let attempt = 0; attempt < 40 && messages.findLast((m) => m.type === "scopeSelected")?.scope !== scope; attempt++)
    await new Promise((done) => setTimeout(done, 25));
  assert.equal(messages.findLast((m) => m.type === "scopeSelected").scope, scope);

  snapshot = {
    chosen: [{ ...pc, group: "APU", annotation: { tags: ["pc"], note: "counter" } }],
    start: 25, end: 45, cursorA: 30, cursorB: 37, markers: [{ time: 31, name: "overflow" }],
    groupOrder: ["APU"], radix: "hex", collapsedGroups: [], expandedBuses: [], virtualDefinitions: [],
  };
  await provider.saveCustomDocumentAs(document, uri(project), { isCancellationRequested: false });
  assert.equal(JSON.parse(fs.readFileSync(project, "utf8")).designView.selected, scope);
  close();
  saved.delete("kdb:" + waveform);
  await commands.get("waveWorkbench.openProject")(uri(project));
  assert.equal(messages.findLast((m) => m.type === "kdbAttached").path, path.join(fixture, "obj_dir/Vtop.tree.json"));
  assert.equal(restored.cursorA, 30);
  assert.equal(restored.chosen[0].group, "APU");
  assert.deepEqual(restored.chosen[0].annotation, snapshot.chosen[0].annotation);
  assert.ok(sidebarMessages.findLast((m) => m.type === "state")?.tree.some((node) => node.fullname === scope && node.selected));
  close();
});
