// SPDX-License-Identifier: MPL-2.0

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { spawn } = require("node:child_process");
const { createHash } = require("node:crypto");
const { pathToFileURL } = require("node:url");

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
  const traceCalls = [];
  const runningTrace = Promise.withResolvers();
  const cancelledTrace = Promise.withResolvers();
  const managedConfigs = [];
  let managedDisposals = 0;
  const source = path.join(fixture, "fixture.sv");
  const compilation = {
    roots: [pathToFileURL(source).href],
    files: [pathToFileURL(source).href],
    includeDirs: [],
    topModules: ["top"],
    defines: ["MODE=1"],
    parameterOverrides: ["Width=4"],
    complete: true,
  };
  const analysisReply = {
    schemaVersion: 1, revision: "7", scope: "file", root: 0,
    signals: [
      { id: 0, name: "pc", declaration: null },
      { id: 1, name: "clk", declaration: {
        uri: path.join(fixture, "fixture.sv"), range: { start: { line: 3, character: 48 } },
      } },
      { id: 2, name: "not_dumped", declaration: null },
    ],
    assignments: [{
      kind: "nonblocking", targets: [0], inputs: [{
        signal: 1, kind: "trigger", edge: "rising",
        location: { uri: "file:///fixture.sv", range: { start: { line: 6, character: 19 } } },
      }],
      location: { uri: "file:///fixture.sv", range: { start: { line: 7, character: 4 } } },
      hasUnresolvedOperands: false,
    }],
    frontier: [], diagnostics: ["localAssignmentCoverage"],
  };
  let provider, sidebarProvider, traceTree, receiveSidebar, receive, close, document, hover, activeEditor;
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
    CancellationTokenSource: class {
      listeners = new Set();
      token = {
        isCancellationRequested: false,
        onCancellationRequested: (listener) => {
          this.listeners.add(listener);
          return { dispose: () => this.listeners.delete(listener) };
        },
      };
      cancel() {
        this.token.isCancellationRequested = true;
        for (const listener of this.listeners) listener();
      }
      dispose() { this.listeners.clear(); }
    },
    Hover: class { constructor(contents) { this.contents = contents; } },
    TreeItem: class { constructor(label, state) { Object.assign(this, { label, state }); } },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    Uri: { file: uri, joinPath: (base, ...parts) => uri(path.join(base.fsPath, ...parts)) },
    ViewColumn: { One: 1, Two: 2, Beside: 2 },
    ProgressLocation: { Notification: 15 },
    extensions: { getExtension: () => ({ packageJSON: { version: "1.3.0" }, activate: async () => ({
      version: 1, capabilities: { staticTraceVersion: 1 },
      traceDrivers: async (params, token) => {
        traceCalls.push(params);
        if (params.options?.maxDepth === 137) {
          await new Promise((resolve) => {
            token.onCancellationRequested(resolve);
            runningTrace.resolve();
          });
          cancelledTrace.resolve(token.isCancellationRequested);
        }
        return analysisReply;
      },
      openTraceProject: async (configuration) => {
        managedConfigs.push(configuration);
        return {
          traceDrivers: async () => ({ ...analysisReply, compilation }),
          dispose() { managedDisposals++; },
        };
      },
    }) }) },
    languages: { registerHoverProvider(_selector, service) { hover = service; return disposable; } },
    debug: {
      registerDebugConfigurationProvider: () => disposable,
      registerDebugAdapterDescriptorFactory: () => disposable,
    },
    workspace: {
      workspaceFolders: process.platform === "win32" ? [] : [{ uri: uri(temporary) }],
      textDocuments: [],
      getConfiguration: () => ({ get: (key) => key === "mcpEnabled" ? true : undefined }),
      openTextDocument: async (file) => file.language === "markdown" ? file : rtl(file.fsPath),
    },
    window: {
      registerWebviewPanelSerializer: () => disposable,
      registerCustomEditorProvider(_id, value) { provider = value; return disposable; },
      registerWebviewViewProvider(id, value) { if (id === "waveWorkbench.control") sidebarProvider = value; return disposable; },
      registerTreeDataProvider(_id, value) { traceTree = value; return disposable; },
      onDidChangeActiveTextEditor(handler) { activeEditor = handler; return disposable; },
      createOutputChannel: () => ({ append() {}, appendLine() {}, dispose() {} }),
      showQuickPick: async (values) => values[0],
      showOpenDialog: async () => {
        selectedTree = true;
        return [uri(path.join(fixture, "obj_dir/Vtop.tree.json"))];
      },
      showSaveDialog: async () => uri(project),
      withProgress: async (_options, task) => {
        const source = new vscode.CancellationTokenSource();
        try { return await task({}, source.token); }
        finally { source.dispose(); }
      },
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
  assert.ok(meta, JSON.stringify(messages.filter((m) => m.type === "error")));
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

  await commands.get("waveWorkbench.traceDrivers")();
  assert.equal(traceCalls.at(-1).position.line, 7);
  assert.match(opened.at(-1).doc.content, /flowchart LR/);
  assert.match(opened.at(-1).doc.content, /fixture\.sv.*L8/);
  await receive({ type: "rtlTrace", signal: scope + ".pc", mode: "context", tick: "30" });
  assert.match(opened.at(-1).doc.content, /Waveform observations/);
  assert.match(opened.at(-1).doc.content, /Window \d+–29 ticks/);
  assert.match(opened.at(-1).doc.content, /Cursor values sampled at tick 30/);
  const timeline = traceTree.getChildren().find(({ kind }) => kind === "timeline");
  assert.equal(traceTree.getTreeItem(timeline).label, "Observed transitions");
  const transition = traceTree.getChildren(timeline).find(({ point }) => point?.tick === "29");
  const jump = traceTree.getTreeItem(transition).command;
  await commands.get(jump.command)(...jump.arguments);
  assert.deepEqual(messages.findLast(({ action }) => action === "cursor").payload, { time: 29, reveal: true });
  const [transitionSource] = traceTree.getChildren(transition);
  const openSource = traceTree.getTreeItem(transitionSource).command;
  assert.equal(openSource.command, "waveWorkbench.traceOpenSource");
  assert.equal(openSource.arguments[0].range.start.line, 7);
  const [upstreamSample] = traceTree.getChildren(transitionSource);
  assert.equal(upstreamSample.kind, "transition");
  assert.equal(traceTree.getTreeItem(upstreamSample).command.command, "waveWorkbench.traceJumpToTick");
  const beforeRefresh = traceCalls.length;
  for (const tick of [52, 46, 40]) {
    await receive({ type: "rtlCursor", tick, displayFactor: 1, displayScale: "ps" });
  }
  const currentTransition = () => traceTree.getChildren(timeline)[0]?.point?.tick;
  for (let attempt = 0; attempt < 40 && currentTransition() !== "39"; attempt++)
    await new Promise((done) => setTimeout(done, 25));
  assert.equal(currentTransition(), "39");
  assert.equal(traceCalls.length, beforeRefresh);
  const previousTraceCount = traceCalls.length;
  const selectedSignal = traceTree.getChildren().find(({ kind }) => kind === "signal");
  assert(selectedSignal);
  await commands.get("waveWorkbench.traceFromSignal")(selectedSignal);
  assert.ok(traceCalls.length > previousTraceCount);
  assert.match(opened.at(-1).doc.content, /RTL trace of .*pc/);
  const previousJumpCount = messages.filter(({ action }) => action === "cursor").length;
  await commands.get(jump.command)(...jump.arguments);
  assert.equal(messages.filter(({ action }) => action === "cursor").length, previousJumpCount);
  const executionDirectory = process.env.WAVE_TEST_EXECUTION_TRACE;
  if (executionDirectory) {
    await commands.get("waveWorkbench.openExecutionRecording")(
      uri(path.join(executionDirectory, "execution.jsonl")),
      "TOP.trace_tb.dut.owner_q", "7",
    );
    const execution = traceTree.getChildren()[0];
    assert.equal(traceTree.getTreeItem(execution).label, "Recorded execution");
    const recorded = traceTree.getChildren(execution).find(({ event }) => event.kind === "assignment-committed");
    assert.match(traceTree.getTreeItem(recorded).description, /Tick 7/);
    const source = traceTree.getTreeItem(traceTree.getChildren(recorded)[0]);
    assert.equal(source.command.command, "waveWorkbench.traceOpenSource");
    assert.match(source.label, /RTL source · L\d+/);
  }

  if (process.platform !== "win32") {
    const digest = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    const relativeSource = path.relative(temporary, source);
    fs.writeFileSync(path.join(temporary, "trace.build.json"), JSON.stringify({
      schemaVersion: 1, format: "wave-workbench-build", waveformSha256: digest(waveform),
      roots: [relativeSource], files: [{ path: relativeSource, sha256: digest(source) }],
      include_dirs: [], top_modules: ["top"], defines: ["MODE=1"], parameter_overrides: ["Width=4"],
    }));
    const mcp = spawn(process.execPath, [path.join(root, "dist/mcp.js"), temporary]);
    t.after(() => mcp.kill());
    let output = "";
    mcp.stdout.setEncoding("utf8").on("data", (data) => { output += data; });
    const complete = new Promise((resolve, reject) => {
      mcp.on("error", reject);
      mcp.on("close", (code) => code === 0 ? resolve() : reject(Error("MCP exited with " + code)));
    });
    const pagedCalls = [
      ["wave_trace_drivers", { signal: scope + ".pc" }],
      ["wave_trace_context", { signal: scope + ".pc", tick: "30", historyStart: "28" }],
    ];
    mcp.stdin.end([
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: {
        name: "wave_trace_drivers",
        arguments: { signal: scope + ".pc", format: "mermaid", detail: "full", maxDepth: 9 },
      } },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: {
        name: "wave_trace_context",
        arguments: { signal: scope + ".pc", tick: "30", historyStart: "28", format: "mermaid", detail: "full" },
      } },
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: {
        name: "wave_trace_context",
        arguments: { signal: scope + ".pc", tick: "30", detail: "full", buildManifest: "trace.build.json" },
      } },
      { jsonrpc: "2.0", id: 6, method: "tools/call", params: {
        name: "wave_trace_drivers",
        arguments: { signal: scope + ".pc", detail: "full", buildManifest: "trace.build.json", pageSize: 32 },
      } },
      ...pagedCalls.flatMap(([name, args], index) => [false, true].map((eager, variant) => ({
        jsonrpc: "2.0", id: 7 + 2 * index + variant, method: "tools/call",
        params: {
          name,
          arguments: { ...args, output: "paged", ...(eager ? { format: "mermaid", detail: "full" } : {}) },
        },
      }))),
    ].map((request) => JSON.stringify(request) + "\n").join(""));
    await complete;
    const responses = new Map(output.trim().split("\n").map((line) => {
      const reply = JSON.parse(line);
      return [reply.id, reply];
    }));
    const data = (id) => {
      const { result } = responses.get(id);
      assert.ok(!result.isError, result.content[0].text);
      return JSON.parse(result.content[0].text);
    };
    const comparePages = [];
    for (let index = 0; index < pagedCalls.length; index++) {
      const { graphSnapshot: deferred, continuationCursor } = data(7 + 2 * index);
      const { graphSnapshot: eager } = data(8 + 2 * index);
      assert.equal(continuationCursor, undefined);
      assert.deepEqual(deferred.deferredSections, ["mermaid", "report"]);
      assert.deepEqual(eager.deferredSections, []);
      for (const section of ["mermaid", "report"]) {
        assert.equal(deferred.sections[section], undefined);
        comparePages.push([section, deferred.graphCursor, eager.graphCursor]);
      }
    }
    const pages = spawn(process.execPath, [path.join(root, "dist/mcp.js"), temporary]);
    t.after(() => pages.kill());
    let pageOutput = "";
    pages.stdout.setEncoding("utf8").on("data", (data) => { pageOutput += data; });
    const pagesExited = new Promise((resolve, reject) => {
      pages.on("error", reject);
      pages.on("close", (code) => code === 0 ? resolve() : reject(Error("MCP exited with " + code)));
    });
    pages.stdin.end(comparePages.flatMap(([section, ...cursors], index) => cursors.map((graphCursor, variant) =>
      JSON.stringify({ jsonrpc: "2.0", id: 20 + 2 * index + variant, method: "tools/call", params: {
        name: "wave_trace_graph_page", arguments: { graphCursor, section, offset: 0, limit: 128 },
      } }) + "\n",
    )).join(""));
    await pagesExited;
    for (const line of pageOutput.trim().split("\n")) {
      const reply = JSON.parse(line);
      responses.set(reply.id, reply);
    }
    for (let index = 0; index < comparePages.length; index++) {
      const { graphCursor: _deferred, ...deferred } = data(20 + index * 2);
      const { graphCursor: _eager, ...eager } = data(21 + index * 2);
      assert.ok(deferred.total > 0);
      assert.deepEqual(deferred, eager);
    }
    const [list, reply, contextReply, managedReply] = [1, 2, 3, 4].map((id) => responses.get(id));
    const waiting = spawn(process.execPath, [path.join(root, "dist/mcp.js"), temporary]);
    t.after(() => waiting.kill());
    let cancelOutput = "";
    waiting.stdout.setEncoding("utf8").on("data", (data) => { cancelOutput += data; });
    const exited = new Promise((resolve, reject) => {
      waiting.on("error", reject);
      waiting.on("close", (code) => code === 0 ? resolve() : reject(Error("MCP exited with " + code)));
    });
    const send = (payload) => JSON.stringify({ jsonrpc: "2.0", ...payload }) + "\n";
    waiting.stdin.write(send({
      id: 5, method: "tools/call", params: {
        name: "wave_trace_drivers",
        arguments: { signal: scope + ".pc", maxDepth: 137 },
      },
    }));
    await runningTrace.promise;
    waiting.stdin.end(send({ method: "notifications/cancelled", params: { requestId: 5 } }) +
      send({ id: 6, method: "ping" }));
    assert.equal(await cancelledTrace.promise, true);
    await exited;
    assert.deepEqual(JSON.parse(cancelOutput), { jsonrpc: "2.0", id: 6, result: {} });
    assert.ok(list.result.tools.some(({ name }) => name === "wave_trace_drivers"));
    assert.ok(!reply.result.isError, reply.result.content[0].text);
    const result = JSON.parse(reply.result.content[0].text);
    assert.ok(traceCalls.some(({ position, options }) => position.line === 3 && options.maxDepth === 9));
    assert.equal(result.instance, scope);
    assert.match(result.mermaid, /flowchart LR/);
    assert.match(result.report, /RTL trace of TOP\.top\.u0\.pc/);
    assert.ok(!contextReply.result.isError, contextReply.result.content[0].text);
    const contextResult = JSON.parse(contextReply.result.content[0].text);
    assert.equal(contextResult.context.mode, "observations");
    assert.equal(contextResult.context.sourceMatch, "unverified");
    assert.equal(contextResult.context.observations[0].value, "1111");
    assert.equal(contextResult.context.observations[0].history.at(-1).tick, "29");
    assert.ok(contextResult.context.observations.some(({ signal }) => signal === 1));
    assert.ok(contextResult.context.unmapped.includes(2));
    assert.equal(contextResult.context.assignmentCandidates.status, "observedChange");
    assert.equal(contextResult.context.assignmentCandidates.candidates[0].status, "consistentWithObservations");
    assert.match(contextResult.observationMermaid, /subgraph g0/);
    assert.ok(contextResult.context.temporalTrace.edges.some((edge) => edge.kind === "trigger"));
    assert.match(contextResult.temporalMermaid, /trigger evidence/);
    assert.match(contextResult.report, /Waveform observations/);
    assert.match(contextResult.report, /Candidate assignments for the observed change/);
    assert.ok(!managedReply.result.isError, managedReply.result.content[0].text);
    const managed = JSON.parse(managedReply.result.content[0].text);
    assert.equal(managed.context.sourceVerification.status, "matched");
    assert.equal(managed.simulationProject.buildManifest, path.join(temporary, "trace.build.json"));
    assert.match(managed.report, /Simulation build manifest/);
    const staticManagedReply = responses.get(6);
    assert.ok(!staticManagedReply.result.isError, staticManagedReply.result.content[0].text);
    const staticManaged = JSON.parse(staticManagedReply.result.content[0].text);
    assert.deepEqual(staticManaged.simulationProject, managed.simulationProject);
    assert.equal(staticManaged.buildVerification.status, "matched");
    assert.equal(staticManaged.assignments.length, managed.assignments.length);
    assert.match(staticManaged.report, /Simulation build manifest/);
    assert.equal(managedConfigs.length, 2);
    assert.equal(managedConfigs[0], managedConfigs[1]);
    assert.ok(managedConfigs[0].includes("source_files = " + JSON.stringify([source])));
    assert.ok(managedConfigs[0].includes('defines = ["MODE=1"]'));
    assert.ok(managedConfigs[0].includes('parameter_overrides = ["Width=4"]'));
    assert.equal(managedDisposals, 2);
  }

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
