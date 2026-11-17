// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { Viewer } from "./viewer";
import type { Signal, Location, Metadata } from "./shared/protocol";
import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs";
import * as crypto from "node:crypto";
import { identifiers, resolveSelection, codeOnly } from "./rtl-selection";
import { registerVirtuals } from "./view-state";
import * as WaveSignal from "./shared/signals";
import { Backend } from "./backend";
import { KdbSession, mapPrefix } from "./kdb";
import { Sidebar } from "./sidebar";
import { WaveCommands, HELP, quote } from "./commands";
import { moduleAt, commonScope, SourceFiles } from "./source-sync";
import { TclRunner } from "./tcl";
function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel("Wave Workbench");
  context.subscriptions.push(output);
  const viewers = new Set<Viewer>();
  let current: Viewer, sidebar: Sidebar;
  let syncTimer: ReturnType<typeof setTimeout>,
    syncGeneration = 0,
    suppressEditorSync = 0;
  const sourceFiles = new SourceFiles();
  const report = (e) => {
    output.appendLine(e.stack || String(e));
    if (!e.sidebarLogged) sidebar?.log("ERROR: " + (e.message || String(e)));
    vscode.window.showErrorMessage(`Wave Workbench: ${e.message || e}`);
  };
  async function revealScope(viewer: Viewer, scope, valid = () => true) {
    const session = viewer.kdb,
      parents = [];
    let node = scope;
    const seen = new Set();
    while (node && !seen.has(node) && parents.length < 256) {
      seen.add(node);
      const parent = await session.parent(node);
      parents.unshift(parent);
      node = parent;
    }
    for (const parent of parents) {
      if (!valid()) return;
      const rows = await session.children(parent, viewer.includeOther);
      if (!valid()) return;
      viewer.treeCache.set(parent, rows);
      if (parent) viewer.treeExpanded.add(parent);
    }
    if (!valid()) return;
    viewer.selectedScope = scope;
    if (scope !== viewer.scopeHistory[viewer.scopeIndex]) {
      viewer.scopeHistory = viewer.scopeHistory.slice(0, viewer.scopeIndex + 1);
      viewer.scopeHistory.push(scope);
      viewer.scopeIndex = viewer.scopeHistory.length - 1;
    }
    viewer.revealScope = scope;
    viewer.revealId = (viewer.revealId || 0) + 1;
    sidebar.refresh();
    await viewer.panel.webview.postMessage({ type: "scopeSelected", scope });
  }
  async function syncEditor(
    editor: vscode.TextEditor | undefined,
    generation: number,
  ) {
    const viewer = current,
      doc = editor?.document;
    if (
      !viewer?.kdb ||
      !doc?.uri?.fsPath ||
      typeof doc.getText !== "function" ||
      !["systemverilog", "verilog"].includes(doc.languageId)
    )
      return;
    const session = viewer.kdb,
      valid = () =>
        generation === syncGeneration &&
        current === viewer &&
        !viewer.disposed &&
        viewer.kdb === session;
    const file = doc.uri.fsPath,
      module = moduleAt(doc.getText(), editor.selection?.active?.line || 0);
    if (!module) return;
    const stamp = file + ":" + doc.version + ":" + module;
    if (
      viewer.syncedEditor === stamp &&
      viewer.selectedScope === viewer.sourceInstances.get(file)
    )
      return;
    let candidates = await session.instances(module);
    if (!valid() || !candidates.length) return;
    const cfg = vscode.workspace.getConfiguration("waveWorkbench", viewer.uri);
    const remembered = viewer.sourceInstances.get(file);
    candidates = [...candidates].sort(
      (a, b) =>
        Number(b.fullname === remembered) - Number(a.fullname === remembered) ||
        commonScope(b.fullname, viewer.selectedScope) -
          commonScope(a.fullname, viewer.selectedScope),
    );
    const matches = [];
    for (const candidate of candidates) {
      if (!valid()) return;
      const record = candidate.definitionFile
        ? candidate
        : await session.resolve(candidate.fullname);
      let definition = mapPrefix(
        record.definitionFile,
        cfg.get("sourcePathMappings"),
      );
      if (!definition) continue;
      if (!path.isAbsolute(definition))
        definition = path.resolve(path.dirname(session.path), definition);
      if (sourceFiles.same(file, definition)) matches.push(candidate);
    }
    if (!valid() || !matches.length) return;
    let choice = matches.find((n) => n.fullname === remembered) || matches[0];
    const best = commonScope(choice.fullname, viewer.selectedScope),
      tied = matches.filter(
        (n) => commonScope(n.fullname, viewer.selectedScope) === best,
      );
    if (!matches.some((n) => n.fullname === remembered) && tied.length > 1) {
      choice = (
        await vscode.window.showQuickPick(
          tied.map((n) => ({
            label: n.fullname,
            description: n.module,
            instance: n,
          })),
          {
            placeHolder: "此 RTL 对应多个实例，选择侧边栏要跟随的实例",
            ignoreFocusOut: true,
          },
        )
      )?.instance;
      if (!valid() || !choice) return;
    }
    viewer.sourceInstances.set(file, choice.fullname);
    viewer.syncedEditor = stamp;
    if (choice.kind === "npiInterface" && !viewer.includeOther) {
      viewer.includeOther = true;
      viewer.treeCache.clear();
    }
    await revealScope(viewer, choice.fullname, valid);
  }
  function scheduleEditorSync(editor: vscode.TextEditor | undefined) {
    const generation = ++syncGeneration;
    clearTimeout(syncTimer);
    if (suppressEditorSync || !editor) return;
    syncTimer = setTimeout(
      () =>
        syncEditor(editor, generation).catch((e) =>
          output.appendLine("RTL follow: " + e.message),
        ),
      150,
    );
  }
  if (vscode.window.onDidChangeActiveTextEditor)
    context.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor(scheduleEditorSync),
    );
  if (vscode.window.onDidChangeTextEditorSelection)
    context.subscriptions.push(
      vscode.window.onDidChangeTextEditorSelection((e) => {
        if (e.textEditor === vscode.window.activeTextEditor)
          scheduleEditorSync(e.textEditor);
      }),
    );
  context.subscriptions.push({
    dispose() {
      clearTimeout(syncTimer);
      ++syncGeneration;
    },
  });
  async function applyDebugLayout(viewer: Viewer, force = false) {
    if (!viewer) return;
    if (!viewer.debugLayout || force) {
      const sourceEditor = vscode.window.visibleTextEditors?.find((e) =>
        ["systemverilog", "verilog"].includes(e.document.languageId),
      );
      await vscode.commands.executeCommand("vscode.setEditorLayout", {
        orientation: 1,
        groups: [{ size: 0.6 }, { size: 0.4 }],
      });
      viewer.debugLayout = true;
      if (sourceEditor)
        await vscode.window.showTextDocument(sourceEditor.document, {
          viewColumn: vscode.ViewColumn.One ?? 1,
          preserveFocus: true,
        });
    }
    viewer.panel.reveal(vscode.ViewColumn.Two ?? 2, true);
    await vscode.commands.executeCommand("waveWorkbench.control.focus");
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
    const viewer = current;
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
  sidebar = new Sidebar(vscode, context, {
    state: () => ({
      sessions: [...viewers].map((v) => ({
        id: v.uri.toString(),
        title: path.basename(v.uri.fsPath),
        ready: !!v.meta,
        kdb: v.kdb?.path || "",
        running: !!v.running,
      })),
      activeId: current?.uri.toString() || "",
      tree: treeRows(current),
      scope: current?.selectedScope || "",
      includeOther: !!current?.includeOther,
      revealScope: current?.revealScope || "",
      revealId: current?.revealId || 0,
    }),
    tree: sidebarTree,
    scopeSignals: async (m) => {
      if (!current?.meta)
        return { scope: m.scope, total: 0, signals: [], offset: 0 };
      return current.backend.request("scopeSignals", {
        query: m.scope,
        offset: Math.max(0, m.offset || 0),
        limit: 512,
      });
    },
    addSignals: async (signals) => {
      const viewer = current;
      if (!viewer) return;
      const resolved = await viewer.backend.request("describe", {
        descriptors: signals.slice(0, 100000),
      });
      await viewer.panel.webview.postMessage({
        type: "sidebarAdd",
        signals: resolved.filter((s) => s.supported),
      });
      viewer.panel.reveal(vscode.ViewColumn.Two ?? 2, true);
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
      if (target) current = target;
    },
    execute: (script) => executeTcl(current, script),
    action: async (action) => {
      if (
        ![
          "open",
          "openPicker",
          "attachKdb",
          "runScript",
          "cacheStats",
          "debugLayout",
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
  const resolvePath = (file: string, base?: string) =>
    path.isAbsolute(file)
      ? file
      : path.resolve(
          base ||
            vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ||
            process.cwd(),
          file,
        );
  async function openWaveform(
    candidate?: string | vscode.Uri,
    { picker = false } = {},
  ) {
    let filename =
      typeof candidate === "string" ? candidate : candidate?.fsPath;
    if (filename && !/\.(fsdb|vcd)$/i.test(filename)) filename = undefined;
    if (!filename && !picker)
      filename =
        vscode.workspace
          .getConfiguration("waveWorkbench")
          .get("defaultWaveform") || context.workspaceState.get("lastWaveform");
    if (filename) {
      filename = resolvePath(filename);
      if (!fs.existsSync(filename)) filename = undefined;
    }
    if (!filename)
      filename = (
        await vscode.window.showOpenDialog({
          title: "打开 FSDB / VCD（自动接入同目录 KDB）",
          filters: { Waveforms: ["fsdb", "vcd"] },
          canSelectMany: false,
        })
      )?.[0]?.fsPath;
    if (!filename) return;
    const uri = vscode.Uri.file(filename);
    await context.workspaceState.update("lastWaveform", filename);
    await vscode.commands.executeCommand(
      "vscode.openWith",
      uri,
      "waveWorkbench.viewer",
    );
    const viewer = [...viewers].find((v) => v.uri.fsPath === filename);
    if (viewer) {
      viewer.panel.reveal?.();
      await viewer.ready;
      return viewer;
    }
  }
  async function executeTcl(
    viewer: Viewer,
    script: string,
    directory?: string,
  ) {
    sidebar.remember(script);
    if (!viewer) {
      if (script.trim() === "waveHelp") {
        logTcl(null, HELP);
        return HELP;
      }
      throw new Error("先打开波形，再执行 nWave Tcl 命令");
    }
    if (viewer.running) throw new Error("当前波形已有 Tcl 指令正在执行");
    if (viewer.panel.visible === false)
      viewer.panel.reveal(vscode.ViewColumn.Two ?? 2, true);
    await viewer.ready;
    if (viewer.running) throw new Error("当前波形已有 Tcl 指令正在执行");
    if (viewer.disposed || !viewer.meta)
      throw new Error("波形未加载成功，请重新打开");
    if (!viewer.tcl) {
      let target = viewer;
      const engine = new WaveCommands({
        getViewer: () => target,
        open: async (file) => {
          const filename = resolvePath(
            file,
            target.scriptDirectory || path.dirname(target.uri.fsPath),
          );
          if (!fs.existsSync(filename))
            throw new Error("Waveform not found: " + filename);
          const next = await openWaveform(filename);
          if (!next) throw new Error("Waveform open was cancelled");
          target = next;
        },
        scope: async (name) => {
          if (!target.kdb && !(await target.attachKdb()))
            throw new Error("No KDB attached");
          await target.showHierarchy(name);
        },
      });
      viewer.tcl = new TclRunner(
        (name, args, dir) => {
          target.scriptDirectory = dir;
          return engine.execute(name, args);
        },
        {
          executable:
            vscode.workspace
              .getConfiguration("waveWorkbench")
              .get<string>("tclshPath") || "/usr/bin/tclsh",
          log: (text) => {
            output.appendLine(text);
            logTcl(viewer, text);
          },
        },
      );
    }
    viewer.running = true;
    logTcl(viewer, "> " + script);
    sidebar.refresh();
    try {
      const result = await viewer.tcl.run(
        script,
        directory || path.dirname(viewer.uri.fsPath),
      );
      logTcl(viewer, result || "OK");
      return result;
    } catch (e) {
      logTcl(viewer, "ERROR: " + e.message);
      e.sidebarLogged = true;
      throw e;
    } finally {
      viewer.running = false;
      sidebar.refresh();
    }
  }
  async function runScript(uri?: vscode.Uri) {
    uri ||= (
      await vscode.window.showOpenDialog({
        title: "运行 nWave Tcl / RC 脚本",
        filters: { Scripts: ["tcl", "rc"] },
        canSelectMany: false,
      })
    )?.[0];
    if (!uri) return;
    if (!current) await openWaveform();
    if (!current) return;
    return executeTcl(
      current,
      `source ${quote(uri.fsPath)}`,
      path.dirname(uri.fsPath),
    );
  }
  async function openKdbSource(
    viewer: Viewer,
    fullname: string,
    target = "declaration",
  ) {
    if (!viewer.kdb && !(await viewer.attachKdb())) return;
    let record = await viewer.kdb.resolve(fullname);
    if (
      target === "instance" &&
      record.instance &&
      record.instance !== record.fullname
    )
      record = await viewer.kdb.resolve(record.instance);
    let file = target === "definition" ? record.definitionFile : record.file;
    const line = target === "definition" ? record.definitionLine : record.line;
    if (!file || !Number.isInteger(line) || line < 1)
      throw new Error(`KDB has no ${target} source location for ${fullname}.`);
    const cfg = vscode.workspace.getConfiguration("waveWorkbench", viewer.uri);
    file = mapPrefix(file, cfg.get("sourcePathMappings"));
    if (!path.isAbsolute(file))
      file = path.resolve(path.dirname(viewer.kdb.path), file);
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    if (line > doc.lineCount)
      throw new Error(
        `KDB line ${line} is outside ${file}; verify source snapshot/path mappings.`,
      );
    let editor;
    suppressEditorSync++;
    ++syncGeneration;
    clearTimeout(syncTimer);
    try {
      await applyDebugLayout(viewer);
      editor = await vscode.window.showTextDocument(doc, {
        viewColumn: vscode.ViewColumn.One ?? 1,
      });
    } finally {
      suppressEditorSync--;
    }
    const position = new vscode.Position(line - 1, 0);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(new vscode.Range(position, position));
    const editorScope =
      target === "instance"
        ? await viewer.kdb.parent(record.instance || record.fullname)
        : record.instance || fullname;
    viewer.sourceInstances.set(file, editorScope);
    if (typeof doc.getText === "function")
      viewer.syncedEditor =
        file + ":" + doc.version + ":" + moduleAt(doc.getText(), line - 1);
    viewer.selectedScope = editorScope;
    await viewer.panel.webview.postMessage({
      type: "scopeSelected",
      scope: editorScope,
    });
    sidebar.refresh();
    output.appendLine(`KDB ${record.fullname} -> ${file}:${line} (${target})`);
  }
  const provider: vscode.CustomReadonlyEditorProvider = {
    async openCustomDocument(uri) {
      return { uri, dispose() {} };
    },
    async resolveCustomEditor(document, panel) {
      const cfg = vscode.workspace.getConfiguration(
        "waveWorkbench",
        document.uri,
      );
      const home =
        cfg.get<string>("verdiHome") ||
        process.env.VERDI_HOME ||
        process.env.NOVAS_HOME;
      const binary =
        cfg.get<string>("backendPath") ||
        context.asAbsolutePath(
          `bin/wave-backend${process.platform === "win32" ? ".exe" : ""}`,
        );
      const env = { ...process.env };
      if (home) env.VERDI_HOME = home;
      const backend = new Backend(binary, {
        env,
        onLog: (s) => output.append(s),
      });
      const viewer = {
        panel,
        backend,
        meta: null,
        uri: document.uri,
        kdb: null,
        treeCache: new Map(),
        treeExpanded: new Set(),
        sourceInstances: new Map(),
        selectedScope: "",
        scopeHistory: [],
        scopeIndex: -1,
        pendingUI: new Map(),
        uiSequence: 0,
      } as Viewer;
      viewer.ready = new Promise((resolve) => {
        viewer.resolveReady = resolve;
      });
      viewer.ui = (action, payload = {}) =>
        new Promise((resolve, reject) => {
          if (viewer.disposed) {
            reject(new Error("Wave window is closed"));
            return;
          }
          const id = ++viewer.uiSequence;
          const timer = setTimeout(() => {
            viewer.pendingUI.delete(id);
            reject(new Error("Wave view did not respond to " + action));
          }, 30000);
          viewer.pendingUI.set(id, { resolve, reject, timer });
          panel.webview.postMessage({ type: "ui", id, action, payload });
        });
      viewers.add(viewer);
      current = viewer;
      sidebar.refresh();
      panel.onDidChangeViewState(() => {
        if (panel.active) {
          current = viewer;
          sidebar.refresh();
        }
      });
      panel.onDidDispose(() => {
        viewer.disposed = true;
        viewer.resolveReady(null);
        backend.dispose();
        viewer.kdb?.dispose();
        viewer.tcl?.dispose();
        for (const p of viewer.pendingUI.values()) {
          clearTimeout(p.timer);
          p.reject(new Error("Wave window closed"));
        }
        viewer.pendingUI.clear();
        viewers.delete(viewer);
        if (current === viewer) current = [...viewers].at(-1);
        sidebar.refresh();
      });
      panel.webview.options = {
        enableScripts: true,
        localResourceRoots: [
          vscode.Uri.joinPath(context.extensionUri, "media"),
          vscode.Uri.joinPath(context.extensionUri, "dist", "webview"),
        ],
      };
      let metaPromise;
      const sendError = (e, origin, request) =>
        panel.webview.postMessage({
          type: "error",
          origin,
          request,
          message: e.message || String(e),
        });
      async function showHierarchy(scope = "") {
        if (!viewer.kdb) return;
        const children = await viewer.kdb.children(scope, viewer.includeOther);
        viewer.treeCache.set(scope, children);
        sidebar.refresh();
        await panel.webview.postMessage({
          type: "kdbHierarchy",
          scope,
          children,
        });
      }
      viewer.showHierarchy = showHierarchy;
      viewer.attachKdb = async (suggested) => {
        if (viewer.attaching) return viewer.attaching;
        viewer.attaching = (async () => {
          let database = suggested;
          if (!database) {
            const selection = await vscode.window.showOpenDialog({
              title: "选择与当前 FSDB 匹配的 VCS simv.daidir（KDB）",
              canSelectFiles: false,
              canSelectFolders: true,
              canSelectMany: false,
            });
            database = selection?.[0]?.fsPath;
          }
          if (!database) return false;
          const session = new KdbSession(binary, home, (s) => output.append(s));
          try {
            await session.open(database);
            if (viewer.disposed) {
              session.dispose();
              return false;
            }
            viewer.kdb?.dispose();
            viewer.kdb = session;
            viewer.treeCache.clear();
            viewer.treeExpanded.clear();
            sidebar.refresh();
            await context.workspaceState.update(
              `kdb:${document.uri.toString()}`,
              database,
            );
            await panel.webview.postMessage({
              type: "kdbAttached",
              path: session.path,
            });
            await showHierarchy();
            scheduleEditorSync(vscode.window.activeTextEditor);
            return true;
          } catch (e) {
            session.dispose();
            throw e;
          }
        })().finally(() => {
          viewer.attaching = null;
        });
        return viewer.attaching;
      };
      panel.webview.onDidReceiveMessage(
        async (msg) => {
          try {
            if (msg.type === "ready") {
              metaPromise ||= backend.request("open", {
                path: document.uri.fsPath,
              });
              const meta = await metaPromise;
              await backend.request("cacheConfigure", {
                bytes: (cfg.get<number>("cacheSizeMB") ?? 64) * 1024 * 1024,
              });
              viewer.meta = meta;
              sidebar.refresh();
              await context.workspaceState.update(
                "lastWaveform",
                document.uri.fsPath,
              );
              if (BigInt(meta.end) > BigInt(Number.MAX_SAFE_INTEGER))
                throw new Error(
                  "Time range exceeds exact canvas tick precision (2^53). Native backend retains u64 timestamps.",
                );
              await applyDebugLayout(viewer);
              await panel.webview.postMessage({
                type: "metadata",
                ...meta,
                title: path.basename(document.uri.fsPath),
                vide:
                  vscode.extensions.getExtension(
                    "pascal-lab.vide-code-extension",
                  )?.packageJSON.version || null,
              });
              const sibling = path.join(
                path.dirname(document.uri.fsPath),
                "simv.daidir",
              );
              const database =
                cfg.get<string>("kdbPath") ||
                context.workspaceState.get(`kdb:${document.uri.toString()}`) ||
                (fs.existsSync(sibling) ? sibling : null);
              try {
                if (database && !viewer.kdb) await viewer.attachKdb(database);
              } finally {
                viewer.resolveReady(viewer);
              }
            } else if (msg.type === "uiResult") {
              const p = viewer.pendingUI.get(msg.id);
              if (p) {
                viewer.pendingUI.delete(msg.id);
                clearTimeout(p.timer);
                if (msg.error) p.reject(new Error(msg.error));
                else p.resolve(msg.result);
              }
            } else if (
              msg.type === "executeTcl" &&
              typeof msg.script === "string"
            ) {
              await executeTcl(viewer, msg.script);
            } else if (msg.type === "openWaveform") {
              await openWaveform(undefined, { picker: true });
            } else if (msg.type === "runScript") {
              await runScript();
            } else if (msg.type === "attachKdb") {
              await viewer.attachKdb();
            } else if (
              msg.type === "kdbChildren" &&
              typeof msg.scope === "string"
            ) {
              await showHierarchy(msg.scope);
            } else if (
              msg.type === "kdbParent" &&
              typeof msg.scope === "string"
            ) {
              if (viewer.kdb)
                await showHierarchy(
                  msg.scope ? await viewer.kdb.parent(msg.scope) : "",
                );
            } else if (
              msg.type === "kdbSource" &&
              typeof msg.scope === "string"
            ) {
              await openKdbSource(viewer, msg.scope, msg.target);
            } else if (
              msg.type === "navigateScope" &&
              ["back", "forward"].includes(msg.direction)
            ) {
              current = viewer;
              await sidebarTree("", msg.direction);
            } else if (
              msg.type === "scopeSignals" &&
              typeof msg.scope === "string"
            ) {
              if (viewer.selectedScope !== msg.scope) {
                viewer.selectedScope = msg.scope;
                sidebar.refresh();
              }
              const result = await backend.request("scopeSignals", {
                query: msg.scope,
                offset: Math.max(0, msg.offset || 0),
                limit: 512,
              });
              await panel.webview.postMessage({
                type: "scopeSignals",
                request: msg.request,
                ...result,
              });
            } else if (
              msg.type === "search" &&
              typeof msg.query === "string" &&
              msg.query.length < 1024
            ) {
              const result = await backend.request("search", {
                query: msg.query,
                offset: Number.isSafeInteger(msg.offset) ? msg.offset : 0,
                limit: msg.limit || 512,
              });
              await panel.webview.postMessage({
                type: "searchResult",
                request: msg.request,
                ...result,
              });
            } else if (msg.type === "defineVirtual") {
              const result = await backend.request("defineVirtual", {
                definition: msg.definition,
                name:
                  typeof msg.name === "string" ? msg.name.slice(0, 120) : "",
              });
              await panel.webview.postMessage({
                type: "virtualCreated",
                ...result,
              });
            } else if (
              msg.type === "restore" &&
              Array.isArray(msg.signals) &&
              msg.signals.length <= 100000
            ) {
              await registerVirtuals(backend, msg.virtualDefinitions || []);
              const style = new Map();
              for (const s of msg.signals) {
                if (typeof s === "string") continue;
                const key = WaveSignal.baseKey(s);
                if (!style.has(key)) style.set(key, []);
                style.get(key).push(s);
              }
              const signals = [];
              for (let i = 0; i < msg.signals.length; i += 1000) {
                const chunk = msg.signals
                  .slice(i, i + 1000)
                  .map((s) =>
                    typeof s === "string"
                      ? { id: s }
                      : { id: s.id, scope: s.scope, name: s.name },
                  );
                const described = await backend.request("describe", {
                  descriptors: chunk,
                });
                for (const signal of described) {
                  const s =
                    style.get(WaveSignal.baseKey(signal))?.shift() || {};
                  signals.push(WaveSignal.restore(s, signal));
                }
              }
              await panel.webview.postMessage({ type: "restore", signals });
            } else if (msg.type === "query") {
              if (
                !viewer.meta ||
                !Array.isArray(msg.signals) ||
                msg.signals.length > 64 ||
                !Number.isSafeInteger(msg.start) ||
                !Number.isSafeInteger(msg.end) ||
                msg.start < 0 ||
                msg.end < msg.start
              )
                return;
              const result = await backend.request("query", {
                signals: msg.signals,
                start: String(msg.start),
                end: String(msg.end),
                limit:
                  msg.report && Number.isSafeInteger(msg.limit)
                    ? Math.min(
                        cfg.get<number>("eventsPerSignal") || 20000,
                        Math.max(2, Math.min(5000, msg.limit)),
                      )
                    : cfg.get<number>("eventsPerSignal"),
              });
              await panel.webview.postMessage({
                type: "data",
                request: msg.request,
                result,
              });
            } else if (
              msg.type === "copyPaths" &&
              typeof msg.text === "string" &&
              msg.text.length < 16000000
            ) {
              await vscode.env.clipboard.writeText(msg.text);
            } else if (msg.type === "source") {
              if (String(msg.id).startsWith("@virtual:")) {
                vscode.window.showInformationMessage(
                  "虚拟信号没有独立 RTL 声明；请在输入信号行定位源码。",
                );
                return;
              }

              const signal = (
                await backend.request("describe", {
                  signals: [String(msg.id)],
                  query: `${msg.scope}.${msg.name}`,
                })
              )[0];
              if (signal) {
                const fullname = mapPrefix(
                  `${signal.scope}.${signal.name.replace(/\s*\[\s*-?\d+\s*:\s*-?\d+\s*\]$/, "")}`,
                  cfg.get("hierarchyMappings"),
                );
                await openKdbSource(viewer, fullname, msg.target);
              }
            }
          } catch (e) {
            if (msg.type === "ready") viewer.resolveReady(null);
            output.appendLine(String(e));
            await sendError(e, msg.type, msg.request);
          }
        },
        null,
        context.subscriptions,
      );
      const nonce = crypto.randomBytes(16).toString("hex");
      const resource = (n: string) =>
        panel.webview.asWebviewUri(
          vscode.Uri.joinPath(
            context.extensionUri,
            n.endsWith(".js") ? "dist/webview" : "media",
            n,
          ),
        );
      panel.webview.html = fs
        .readFileSync(context.asAbsolutePath("media/index.html"), "utf8")
        .replaceAll("{{csp}}", panel.webview.cspSource)
        .replaceAll("{{nonce}}", nonce)
        .replace("{{css}}", resource("wave.css").toString())
        .replace("{{script}}", resource("wave.js").toString());
    },
  };
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      "waveWorkbench.viewer",
      provider,
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false,
      },
    ),
  );
  for (const [id, handler] of Object.entries({
    debugLayout: () => applyDebugLayout(current, true),
    open: (uri) => openWaveform(uri),
    openPicker: () => openWaveform(undefined, { picker: true }),
    openLast: () => openWaveform(),
    runScript: (uri) => runScript(uri),
    runTcl: async () => {
      if (!current) await openWaveform();
      if (!current) return;
      const script = await vscode.window.showInputBox({
        title: "nWave Tcl",
        prompt: "输入 wv* 命令；waveHelp 查看支持列表",
        placeHolder: "wvZoomAll; wvSetCursor 20",
      });
      if (script) await executeTcl(current, script);
    },
    fit: () => executeTcl(current, "wvZoomAll"),
    zoomIn: () => executeTcl(current, "wvZoomIn"),
    zoomOut: () => executeTcl(current, "wvZoomOut"),
    nextEdge: () => executeTcl(current, "wvSearchNext"),
    previousEdge: () => executeTcl(current, "wvSearchPrev"),
    setCursor: async () => {
      const value = await vscode.window.showInputBox({
        title: "nWave Set Cursor",
        prompt: "时间（当前窗口单位）",
      });
      if (value) await executeTcl(current, `wvSetCursor ${quote(value)}`);
    },
    setMarker: async () => {
      const value = await vscode.window.showInputBox({
        title: "nWave Set Marker",
        prompt: "时间（当前窗口单位）",
      });
      if (value) await executeTcl(current, `wvSetMarker ${quote(value)}`);
    },
    cacheStats: async () => {
      if (!current) throw new Error("Open a waveform first");
      const stats = await current.backend.request("cacheStats");
      output.appendLine(JSON.stringify(stats, null, 2));
      vscode.window.showInformationMessage(
        `Rust 波形缓存：${stats.entries} 块，${(stats.bytes / 1048576).toFixed(1)} / ${(stats.budget / 1048576).toFixed(0)} MiB，命中 ${stats.hits}，实际读取 ${stats.reads} 次`,
      );
    },
    saveSignals: async () => {
      if (!current) throw new Error("Open a waveform first");
      const uri = await vscode.window.showSaveDialog({
        filters: { "Replayable nWave Tcl": ["tcl"] },
      });
      if (uri) await executeTcl(current, `wvSaveSignal ${quote(uri.fsPath)}`);
    },
    restoreSignals: async () => {
      const uri = (
        await vscode.window.showOpenDialog({
          filters: { "nWave Tcl": ["tcl", "rc"] },
          canSelectMany: false,
        })
      )?.[0];
      if (uri)
        await executeTcl(current, `wvRestoreSignal ${quote(uri.fsPath)}`);
    },
  }))
    context.subscriptions.push(
      vscode.commands.registerCommand(
        "waveWorkbench." + id,
        async (...args) => {
          try {
            return await (handler as (...args: any[]) => unknown)(...args);
          } catch (e) {
            report(e);
          }
        },
      ),
    );
  if (vscode.window.createStatusBarItem) {
    const item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      80,
    );
    item.text = "$(pulse) 波形";
    item.tooltip = "Wave Workbench：一键打开默认或上次波形（Ctrl+Alt+W）";
    item.command = "waveWorkbench.open";
    item.show();
    context.subscriptions.push(item);
  }
  async function addRtlSelection() {
    const editor = vscode.window.activeTextEditor,
      viewer = current;
    if (!editor || !viewer?.meta) {
      vscode.window.showInformationMessage("先打开波形，再在 RTL 中选择代码。");
      return;
    }
    const ranges = (editor.selections || [editor.selection])
      .map((r) =>
        r.isEmpty
          ? editor.document.getWordRangeAtPosition(r.active, /[\\\w$]+/)
          : r,
      )
      .filter(Boolean);
    if (
      editor.document.languageId &&
      typeof editor.document.getText === "function"
    ) {
      const text = editor.document.getText();
      const modules = new Set(
        ranges
          .flatMap((r) => [
            moduleAt(text, r.start?.line || 0),
            moduleAt(
              text,
              r.end?.character === 0 && r.end.line > (r.start?.line || 0)
                ? r.end.line - 1
                : r.end?.line || 0,
            ),
          ])
          .filter(Boolean),
      );
      if (modules.size > 1)
        throw Error("选区跨越多个 module/interface，请按模块分批添加");
    }
    const fullCode = editor.document.offsetAt
      ? codeOnly(editor.document.getText())
      : null;
    const names = [
      ...new Set(
        ranges.flatMap((r) =>
          identifiers(
            fullCode === null
              ? editor.document.getText(r)
              : fullCode.slice(
                  editor.document.offsetAt(r.start),
                  editor.document.offsetAt(r.end),
                ),
          ),
        ),
      ),
    ];
    if (names.length > 10000)
      throw Error("选区标识符超过 10000 个，请分批添加");
    if (!names.length) {
      vscode.window.showInformationMessage("选区中没有可匹配的信号标识符。");
      return;
    }
    clearTimeout(syncTimer);
    await syncEditor(editor, ++syncGeneration);
    if (viewer.disposed || current !== viewer) return;
    let scope = viewer.sourceInstances.get(editor.document.uri?.fsPath) || "";
    const mappings =
      vscode.workspace
        .getConfiguration("waveWorkbench", viewer.uri)
        .get("hierarchyMappings") || {};
    scope = mapPrefix(
      scope,
      Object.fromEntries(Object.entries(mappings).map(([a, b]) => [b, a])),
    );
    let result = await resolveSelection(viewer.backend, names, scope);
    if (!scope) {
      const scopes = new Map();
      for (const s of [
        ...result.signals,
        ...result.ambiguous.flatMap((v) => v.matches),
      ])
        scopes.set(s.scope, (scopes.get(s.scope) || 0) + 1);
      if (scopes.size) {
        const choice = await vscode.window.showQuickPick(
          [...scopes]
            .sort((a, b) => b[1] - a[1])
            .map(([scope, count]) => ({
              label: scope,
              description: count + " 个候选匹配",
              scope,
            })),
          {
            placeHolder: "选择这段 RTL 对应的 dump 实例（整批使用同一个实例）",
          },
        );
        if (!choice) return;
        scope = choice.scope;
        result = await resolveSelection(viewer.backend, names, scope);
      }
    }
    if (viewer.disposed || current !== viewer) return;
    if (result.truncated) {
      output.appendLine(
        "RTL batch: 匹配结果超过上限，请使用 KDB 选定实例后重试。",
      );
      vscode.window.showInformationMessage(
        "匹配结果被截断；请先从 KDB 树选定对应实例后重试。",
      );
      return;
    }
    let added = 0,
      duplicates = 0;
    if (result.signals.length) {
      viewer.panel.reveal(vscode.ViewColumn.Two ?? 2, true);
      const summary = await viewer.ui("batchAdd", { signals: result.signals });
      added = summary.added;
      duplicates = summary.duplicates;
    }
    const message = `RTL 批量添加：新增 ${added}，已存在 ${duplicates}，未匹配 ${result.missing.length}，歧义 ${result.ambiguous.length}`;
    output.appendLine(
      message +
        "\n实例：" +
        (scope || "未确定") +
        "\n未匹配（含类型/未 dump 对象）：" +
        result.missing.join(", ") +
        "\n歧义：" +
        result.ambiguous.map((v) => v.name).join(", "),
    );
    sidebar.log(message, viewer.uri.fsPath);
    vscode.window.showInformationMessage(message);
  }
  context.subscriptions.push(
    vscode.commands.registerCommand("waveWorkbench.addSelection", () =>
      addRtlSelection().catch(report),
    ),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("waveWorkbench.videStatus", () => {
      const ext = vscode.extensions.getExtension(
        "pascal-lab.vide-code-extension",
      );
      vscode.window.showInformationMessage(
        ext
          ? `Vide ${ext.packageJSON.version} detected. KDB resolves source locations; Vide handles RTL editing without a competing HDL language server.`
          : "Vide is optional. Install pascal-lab.vide-code-extension for HDL editing.",
      );
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("waveWorkbench.attachKdb", async () => {
      try {
        if (current) await current.attachKdb();
        else
          vscode.window.showInformationMessage(
            "Open a waveform before attaching its KDB.",
          );
      } catch (e) {
        report(e);
      }
    }),
  );
  context.subscriptions.push({
    dispose() {
      for (const v of viewers) {
        v.backend.dispose();
        v.kdb?.dispose();
        v.tcl?.dispose();
      }
    },
  });
}
export { activate };
