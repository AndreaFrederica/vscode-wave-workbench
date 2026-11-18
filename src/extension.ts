// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { Viewer, WaveDocument } from "./viewer";
import type {
  ClipContext,
  Signal,
  Location,
  Metadata,
  WaveClip,
  TagState,
  WaveState,
} from "./shared/protocol";
import { normalizeTagColors, tagStyle } from "./shared/tags";
import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs";
import { createWaveDocuments } from "./wave-documents";
import { createWaveEditor } from "./wave-editor";
import {
  backendChoices,
  backendPlan,
  isFsdb,
  type FsdbBackend,
} from "./backend-selection";
import { compareBackends } from "./backend-comparison";
import {
  identifiers,
  resolveSelection,
  codeOnly,
  portConnection,
} from "./rtl-selection";
import { restoreView } from "./view-state";
import { readWaveProject, saveWaveProject } from "./project";
import { createDecoderGroup, loadDecoderProfiles } from "./decoder-config";
import {
  builtinProfiles,
  decodeWord,
  supportsProfile,
} from "./shared/decoders";
import { findRtlSignals, readSignalsAt } from "./signal-lookup";
import { serveWaveMcp } from "./mcp";
import {
  clipFormats,
  collectClip,
  serializeClip,
  type ClipFormat,
  type ClipOptions,
} from "./wave-clip";
import * as WaveSignal from "./shared/signals";
import { mapPrefix } from "./kdb";
import { Sidebar } from "./sidebar";
import { WaveCommands, HELP, formatValue, quote } from "./commands";
import { moduleAt, commonScope, SourceFiles } from "./source-sync";
import { TclRunner } from "./tcl";

function rtlValue(raw: string, width: number) {
  const shown =
    width > 1 && /^[01xz]+$/i.test(raw)
      ? "0x" + formatValue(raw, width, "Hex", true)
      : raw;
  return shown.length > 256 ? shown.slice(0, 256) + "…" : shown;
}

function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel("Wave Workbench");
  context.subscriptions.push(output);
  const viewers = new Set<Viewer>();
  const projectChanges = new vscode.EventEmitter<
    vscode.CustomDocumentContentChangeEvent<WaveDocument>
  >();
  context.subscriptions.push(projectChanges);
  let current: Viewer, sidebar: Sidebar;
  const tclOutput = new Map<Viewer, string[]>();
  let syncTimer: ReturnType<typeof setTimeout>,
    syncGeneration = 0,
    suppressEditorSync = 0;
  const sourceFiles = new SourceFiles();
  const sidebarTags = new WeakMap<
    Viewer,
    { signature: string; state: TagState }
  >();
  function updateSidebarTags(viewer: Viewer, view: WaveState) {
    const mappings = vscode.workspace
      .getConfiguration("waveWorkbench", viewer.uri)
      .get<Record<string, string>>("hierarchyMappings");
    const state: TagState = {
      tagStyle: tagStyle(view.tagStyle),
      tagColors: normalizeTagColors(view.tagColors),
      taggedSignals: view.chosen.flatMap((signal) => {
        if (!signal.annotation?.tags.length) return [];
        const { id, scope, name, displayName, bitOffset } = signal;
        return [
          {
            id,
            scope,
            name,
            displayName,
            bitOffset,
            instanceScope: mapPrefix(scope, mappings),
            tags: signal.annotation.tags,
          },
        ];
      }),
    };
    const signature = JSON.stringify(state);
    if (sidebarTags.get(viewer)?.signature === signature) return;
    sidebarTags.set(viewer, { signature, state });
    if (viewer === current) sidebar.refresh();
  }
  function dumpScope(viewer: Viewer, scope: string) {
    const mappings =
      vscode.workspace
        .getConfiguration("waveWorkbench", viewer.uri)
        .get<Record<string, string>>("hierarchyMappings") || {};
    return mapPrefix(
      scope,
      Object.fromEntries(
        Object.entries(mappings).map(([dump, kdb]) => [kdb, dump]),
      ),
    );
  }
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
  async function sourceInstances(
    viewer: Viewer,
    file: string,
    module: string,
    valid: () => boolean,
  ) {
    const session = viewer.kdb;
    const cfg = vscode.workspace.getConfiguration("waveWorkbench", viewer.uri);
    const candidates = await session.instances(module);
    const matches: Location[] = [];
    for (const candidate of candidates) {
      if (!valid()) return [];
      const record = candidate.definitionFile
        ? candidate
        : await session.resolve(candidate.fullname);
      if (!record?.definitionFile) continue;
      const mapped = mapPrefix(
        record.definitionFile,
        cfg.get("sourcePathMappings"),
      );
      const definition = path.resolve(path.dirname(session.path), mapped);
      if (sourceFiles.same(file, definition)) matches.push(candidate);
    }
    return matches;
  }
  const rtlDocuments = new WeakMap<
    vscode.TextDocument,
    { version: number; text: string; code: string }
  >();
  async function connectedInstance(
    viewer: Viewer,
    parent: string,
    name: string,
    file: string,
    line: number,
    valid: () => boolean,
  ) {
    const session = viewer.kdb;
    const mappings = vscode.workspace
      .getConfiguration("waveWorkbench", viewer.uri)
      .get<Record<string, string>>("sourcePathMappings");
    async function matches(fullname: string) {
      const record = await session.resolve(fullname).catch((error) => {
        if (!String(error.message).startsWith("KDB object not found:"))
          throw error;
        return undefined;
      });
      return (
        valid() &&
        record?.fullname === fullname &&
        ["npiModule", "npiInterface"].includes(record.kind) &&
        record.line === line &&
        !!record.file &&
        sourceFiles.same(
          file,
          path.resolve(
            path.dirname(session.path),
            mapPrefix(record.file, mappings),
          ),
        )
      );
    }
    const direct = parent + "." + name;
    if (await matches(direct)) return direct;
    const scopes = [parent];
    const candidates: string[] = [];
    for (const scope of scopes) {
      if (!valid()) return;
      for (const child of await session.children(scope, true)) {
        if (child.kind === "npiGenScope") scopes.push(child.fullname);
        else if (
          child.fullname !== direct &&
          child.fullname.endsWith("." + name) &&
          ["npiModule", "npiInterface"].includes(child.kind) &&
          (await matches(child.fullname))
        )
          candidates.push(child.fullname);
      }
    }
    return candidates.length === 1
      ? candidates[0]
      : candidates.find(
          (scope) =>
            viewer.selectedScope === scope ||
            viewer.selectedScope.startsWith(scope + "."),
        );
  }
  async function provideRtlHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ) {
    const viewer = current;
    if (!viewer?.meta || !viewer.kdb || !viewer.rtlCursor) return;
    const session = viewer.kdb;
    const cursor = viewer.rtlCursor;
    const selectedScope = viewer.selectedScope;
    const valid = () =>
      !token.isCancellationRequested &&
      current === viewer &&
      !viewer.disposed &&
      viewer.kdb === session &&
      viewer.rtlCursor === cursor &&
      viewer.selectedScope === selectedScope;
    if (!valid()) return;

    let source = rtlDocuments.get(document);
    if (source?.version !== document.version) {
      const text = document.getText();
      source = { version: document.version, text, code: codeOnly(text) };
      rtlDocuments.set(document, source);
    }
    const nameRange = document.getWordRangeAtPosition(
      position,
      /[A-Za-z_$][\w$]*/,
    );
    if (!nameRange) return;
    const start = document.offsetAt(nameRange.start);
    const end = document.offsetAt(nameRange.end);
    const name = document.getText(nameRange);
    if (source.code.slice(start, end) !== name || identifiers(name)[0] !== name)
      return;
    const line = document.lineAt(position.line).text;
    const before = line.slice(0, nameRange.start.character).trimEnd();
    const after = line.slice(nameRange.end.character);
    const connection = portConnection(source.text, source.code, start, end);
    if (
      !connection?.portAtCursor &&
      (/(?:[.`\\]|::)$/.test(before) || /^\s*(?:::|\.|\()/.test(after))
    )
      return;
    const indices = /^(?:\s*\[\s*-?\d+\s*\])*/.exec(after)[0];
    const target = name + indices.replace(/\s/g, "");
    const module = moduleAt(source.text, position.line);
    if (!module) return;

    const file = document.uri.fsPath;
    const matches = await sourceInstances(viewer, file, module, valid);
    if (!valid() || !matches.length) return;
    const selected = matches
      .filter(
        ({ fullname }) =>
          selectedScope === fullname ||
          selectedScope.startsWith(fullname + "."),
      )
      .sort((a, b) => b.fullname.length - a.fullname.length)[0];
    const remembered = viewer.sourceInstances.get(file);
    const best = Math.max(
      ...matches.map(({ fullname }) => commonScope(fullname, selectedScope)),
    );
    const closest = matches.filter(
      ({ fullname }) => commonScope(fullname, selectedScope) === best,
    );
    const instance =
      selected ||
      closest.find(({ fullname }) => fullname === remembered) ||
      (closest.length === 1 ? closest[0] : undefined);
    if (!instance)
      return new vscode.Hover(
        "Wave Workbench · 请在波形侧边栏选择要查看的实例",
        nameRange,
      );

    const scope = dumpScope(viewer, instance.fullname);
    const child =
      connection &&
      (await connectedInstance(
        viewer,
        instance.fullname,
        connection.instance,
        file,
        document.positionAt(connection.instanceOffset).line + 1,
        valid,
      ));
    if (!valid() || (connection?.portAtCursor && !child)) return;
    const targets =
      connection && child
        ? [
            { scope: dumpScope(viewer, child), name: connection.port },
            ...(connection.actual ? [{ scope, name: connection.actual }] : []),
          ]
        : [{ scope, name: target }];
    if (connection && !connection.portAtCursor) targets.reverse();
    const groups = await Promise.all(
      targets.map(async (target) => ({
        ...target,
        ...(await findRtlSignals(viewer.backend, target.scope, target.name)),
      })),
    );
    const signals = groups.flatMap((group) => group.signals);
    if (!valid() || !signals.length) return;
    const values = await readSignalsAt(viewer.backend, signals, cursor.tick);
    if (!valid() || values.every((value) => value === undefined)) return;
    const unit = cursor.displayScale || viewer.meta.scale;
    const time = Number((cursor.tick / cursor.displayFactor).toPrecision(15));
    const markdown = new vscode.MarkdownString();
    markdown.appendMarkdown("**Wave Workbench · 游标 A**\n\n");
    markdown.appendText(
      `${time} × ${unit} · ${path.basename(viewer.uri.fsPath)}`,
    );
    markdown.appendMarkdown("\n\n");
    const [signal] = signals;
    if (groups.length > 1 || signals.length > 1 || groups[0].partial) {
      let offset = 0;
      for (const group of groups) {
        const rows = group.signals.map((member, index) => {
          const value = values[offset + index];
          return `${member.name} = ${value === undefined ? "—" : rtlValue(value, member.width)}`;
        });
        offset += group.signals.length;
        if (!rows.length) continue;
        markdown.appendCodeblock(
          [`${group.scope}.${group.name}`, ...rows].join("\n"),
          "text",
        );
        if (group.partial) markdown.appendText("仅显示部分已记录元素");
      }
      return new vscode.Hover(markdown, nameRange);
    }
    const [raw] = values;
    const style = viewer.document.view?.chosen.find(
      (entry) => WaveSignal.key(entry) === WaveSignal.key(signal),
    );
    const decoded =
      viewer.document.view?.showDecodedValues !== false &&
      style?.decoder &&
      decodeWord(style.decoder, raw, signal.width);
    markdown.appendCodeblock(
      `${signal.scope}.${WaveSignal.label(signal)}`,
      "text",
    );
    const bits = /^[01xz]+$/i.test(raw);
    markdown.appendText(`值  ${rtlValue(raw, signal.width)}`);
    if (bits && signal.width > 1 && signal.width <= 128) {
      markdown.appendMarkdown("\n\n");
      markdown.appendText(
        "Binary  " + formatValue(raw, signal.width, "Bin", true),
      );
    }
    if (decoded) {
      markdown.appendMarkdown("\n\n");
      markdown.appendText("解码  " + decoded);
    }
    if (style?.annotation) {
      markdown.appendMarkdown("\n\n");
      markdown.appendText(
        style.annotation.tags.map((tag) => "#" + tag).join(" "),
      );
      if (style.annotation.note) {
        markdown.appendMarkdown("\n\n");
        markdown.appendText(style.annotation.note);
      }
    }
    return new vscode.Hover(markdown, nameRange);
  }
  const rtlLanguages = ["systemverilog", "verilog"];
  if (vscode.languages?.registerHoverProvider)
    context.subscriptions.push(
      vscode.languages.registerHoverProvider(
        [...rtlLanguages, { pattern: "**/*.{sv,svh,v,vh}" }],
        {
          async provideHover(document, position, token) {
            try {
              return await provideRtlHover(document, position, token);
            } catch (error) {
              if (
                !token.isCancellationRequested &&
                !String(error.message).startsWith("Dumped signal not found:")
              )
                output.appendLine("RTL hover: " + error.message);
            }
          },
        },
      ),
    );
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
      !rtlLanguages.includes(doc.languageId)
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
    const remembered = viewer.sourceInstances.get(file);
    const matches = await sourceInstances(viewer, file, module, valid);
    matches.sort(
      (a, b) =>
        Number(b.fullname === remembered) - Number(a.fullname === remembered) ||
        commonScope(b.fullname, viewer.selectedScope) -
          commonScope(a.fullname, viewer.selectedScope),
    );
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
        backend: v.backendKind,
        running: !!v.running,
      })),
      activeId: current?.uri.toString() || "",
      tree: treeRows(current),
      scope: current?.selectedScope || "",
      includeOther: !!current?.includeOther,
      revealScope: current?.revealScope || "",
      revealId: current?.revealId || 0,
      tagState: current && sidebarTags.get(current)?.state,
    }),
    tree: sidebarTree,
    scopeSignals: async (m) => {
      const viewer = current;
      if (!viewer?.meta)
        return { scope: m.scope, total: 0, signals: [], offset: 0 };
      const result = await viewer.backend.request("scopeSignals", {
        query: dumpScope(viewer, m.scope),
        offset: Math.max(0, m.offset || 0),
        limit: Number.isInteger(m.limit)
          ? Math.max(1, Math.min(512, m.limit))
          : 512,
      });
      return { ...result, scope: m.scope };
    },
    taggedFocus: async (reference) => {
      const viewer = current;
      const signal =
        viewer &&
        sidebarTags
          .get(viewer)
          ?.state.taggedSignals.find(
            (entry) => WaveSignal.key(entry) === WaveSignal.key(reference),
          );
      if (!signal) return;
      viewer.panel.reveal(vscode.ViewColumn.Two ?? 2, true);
      await viewer.ui("selectSignals", { signals: [signal], reveal: true });
      if (
        viewer.kdb &&
        signal.instanceScope &&
        !signal.instanceScope.startsWith("$")
      )
        await revealScope(
          viewer,
          signal.instanceScope,
          () => current === viewer && !viewer.disposed,
        );
    },
    tagAppearance: async (options) => {
      const viewer = current;
      if (!viewer?.meta) return;
      if (!viewer.panel.visible)
        viewer.panel.reveal(vscode.ViewColumn.Two ?? 2, true);
      await viewer.ui("tagAppearance", options);
    },
    addSignals: async (signals, editAnnotation) => {
      const viewer = current;
      if (!viewer) return;
      const resolved = await viewer.backend.request("describe", {
        descriptors: signals.slice(0, 100000),
      });
      await viewer.panel.webview.postMessage({
        type: "sidebarAdd",
        signals: resolved.filter((s) => s.supported),
        editAnnotation,
      });
      viewer.panel.reveal(vscode.ViewColumn.Two ?? 2, !editAnnotation);
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
          "openRecent",
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
  const previousWaveform = context.workspaceState.get<string>("lastWaveform");
  let recentFiles = context.workspaceState.get<string[]>(
    "recentWaveFiles",
    previousWaveform ? [previousWaveform] : [],
  );
  function rememberFile(filename: string) {
    recentFiles = [
      filename,
      ...recentFiles.filter((entry) => entry !== filename),
    ].slice(0, 20);
    return context.workspaceState.update("recentWaveFiles", recentFiles);
  }
  async function openRecent() {
    const entries = await Promise.all(
      recentFiles.map(async (filename) => ({
        label: path.basename(filename),
        description: path.dirname(filename),
        filename,
        exists: await fs.promises.stat(filename).then(
          (info) => info.isFile(),
          () => false,
        ),
      })),
    );
    const available = entries.filter((entry) => entry.exists);
    if (!available.length) {
      await vscode.window.showInformationMessage("没有可打开的最近波形文件");
      return;
    }
    const selection = await vscode.window.showQuickPick(available, {
      title: "最近打开的波形和工程",
      placeHolder: "选择 FSDB、VCD 或波形工程",
      matchOnDescription: true,
    });
    if (!selection) return;
    if (/\.waveproj$/i.test(selection.filename))
      await openProject(selection.filename);
    else await openWaveform(selection.filename);
  }
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
    const findViewer = () =>
      [...viewers].find((v) => v.uri.fsPath === filename);
    let viewer = findViewer();
    if (!viewer) {
      await vscode.commands.executeCommand(
        "vscode.openWith",
        uri,
        "waveWorkbench.viewer",
      );
      viewer = findViewer();
    }
    if (viewer) {
      viewer.panel.reveal?.();
      await viewer.ready;
      if (viewer.meta && !viewer.disposed) await rememberFile(filename);
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
        decoderProfiles: (viewer) =>
          loadDecoderProfiles(decoderConfigPath(viewer)),
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
              .get<string>("tclshPath") || undefined,
          log: (text) => {
            const lines = tclOutput.get(viewer);
            if (lines && lines.length < 500) lines.push(text.slice(0, 4096));
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
  async function saveProject(
    viewer: Viewer,
    filename?: string,
    cancellation?: vscode.CancellationToken,
  ) {
    if (!viewer) throw new Error("先打开波形");
    await viewer.ready;
    const document = viewer.document;
    filename ||=
      document.projectPath ||
      (
        await vscode.window.showSaveDialog({
          title: "保存波形工程",
          defaultUri: vscode.Uri.file(
            viewer.uri.fsPath.replace(/\.[^.]+$/, "") + ".waveproj",
          ),
          filters: { "Wave Workbench": ["waveproj"] },
        })
      )?.fsPath;
    if (!filename || cancellation?.isCancellationRequested) return;
    if (!/\.waveproj$/i.test(filename)) filename += ".waveproj";
    const view = viewer.panel.visible
      ? await viewer.ui("snapshot")
      : document.view || document.savedView;
    if (!view) throw Error("波形视图尚未就绪");
    const kdb = viewer.kdb?.path;
    if (cancellation?.isCancellationRequested) return;
    await saveWaveProject(filename, viewer.uri.fsPath, view, kdb);
    document.projectPath = filename;
    document.savedView = view;
    document.savedKdb = kdb;
    await rememberFile(filename);
    return filename;
  }
  async function saveActiveProject(viewer: Viewer) {
    if (!viewer) throw Error("先打开波形");
    viewer.panel.reveal(viewer.panel.viewColumn);
    await vscode.commands.executeCommand("workbench.action.files.save");
  }
  function decoderConfigPath(viewer: Viewer) {
    const root = (
      vscode.workspace.getWorkspaceFolder?.(viewer.uri) ??
      vscode.workspace.workspaceFolders?.[0]
    )?.uri.fsPath;
    return root ? path.join(root, ".vscode", "wave-decoders.json") : undefined;
  }
  async function editDecoderConfig(viewer: Viewer) {
    const legacy = decoderConfigPath(viewer);
    if (!legacy) throw Error("请先打开工作区文件夹");
    const filename = await createDecoderGroup(legacy);
    await vscode.window.showTextDocument(
      await vscode.workspace.openTextDocument(filename),
    );
  }
  async function selectDecoder(viewer: Viewer) {
    const signal: Signal = await viewer.ui("activeSignal");
    if (!signal) throw Error("请先选中一个信号");
    const profiles = await loadDecoderProfiles(decoderConfigPath(viewer));
    const choices = [
      { label: "直接显示原始值", description: "", profile: undefined },
      ...profiles
        .filter((p) => supportsProfile(p, signal.width))
        .map((profile) => ({
          label: profile.label,
          description:
            (builtinProfiles.some((preset) => preset.id === profile.id)
              ? "内置预设"
              : "工作区规则") +
            " · " +
            profile.id,
          detail: signal.decoder?.id === profile.id ? "当前配置" : undefined,
          profile,
        })),
    ];
    const pick = await vscode.window.showQuickPick(choices, {
      title: "信号解码 · " + WaveSignal.label(signal),
      placeHolder: "选择与信号位宽匹配的解码规则",
    });
    if (pick) await viewer.ui("setDecoder", { signal, profile: pick.profile });
  }
  async function openProject(filename?: string) {
    filename ||= (
      await vscode.window.showOpenDialog({
        filters: { "Wave Workbench": ["waveproj"] },
        canSelectMany: false,
      })
    )?.[0]?.fsPath;
    if (!filename) return;
    const project = await readWaveProject(filename);
    if (
      !/\.(fsdb|vcd)$/i.test(project.waveform) ||
      !fs.existsSync(project.waveform)
    )
      throw Error("Waveform not found: " + project.waveform);
    const viewer = await openWaveform(project.waveform);
    if (!viewer) throw Error("无法打开工程的波形");
    const document = viewer.document;
    if (document.dirty) {
      const choice = await vscode.window.showWarningMessage(
        "当前波形有未保存的工程改动。",
        { modal: true },
        "保存工程",
        "不保存",
      );
      if (choice === "保存工程") {
        await saveActiveProject(viewer);
        if (document.dirty) return;
      } else if (choice !== "不保存") return;
    }
    const view = await restoreView(viewer.backend, project.view, viewer.meta);
    if (
      project.kdb &&
      (!viewer.kdb || path.resolve(viewer.kdb.path) !== project.kdb)
    ) {
      if (fs.existsSync(project.kdb)) await viewer.attachKdb(project.kdb);
      else output.appendLine("Wave project KDB not found: " + project.kdb);
    }
    await viewer.ui("restoreView", { ...view, projectBaseline: true });
    document.projectPath = filename;
    document.savedView = document.view || view;
    document.savedKdb = viewer.kdb?.path;
    await rememberFile(filename);
    current = viewer;
    if (document.dirty) await saveActiveProject(viewer);
    return viewer;
  }
  async function exportClipArtifact(
    viewer: Viewer,
    clip: WaveClip,
    format: ClipFormat,
    filename?: string,
    exclusive = true,
  ) {
    const summary = {
      format,
      waveform: clip.waveform,
      timescale: clip.timescale,
      start: clip.start,
      end: clip.end,
      signalCount: clip.traces.length,
      truncated: clip.truncated,
    };
    if (!filename && format !== "png")
      throw Error("A path is required for this format");
    if (filename && path.extname(filename).toLowerCase() !== "." + format)
      throw Error("The file extension must match the export format");
    if (filename && path.resolve(filename) === path.resolve(viewer.uri.fsPath))
      throw Error("Choose a destination different from the source waveform");
    if (format === "vcd" && clip.truncated)
      throw Error(
        "The waveform segment exceeds the event limit. Choose a shorter interval to export VCD.",
      );

    const png: string | undefined =
      format === "png" ? await viewer.ui("renderClipImage", clip) : undefined;
    if (!filename) return { ...summary, imagePng: png };
    const data =
      format === "png"
        ? Buffer.from(png, "base64")
        : serializeClip(clip, format);
    await fs.promises.writeFile(filename, data, {
      flag: exclusive ? "wx" : "w",
    });
    return { ...summary, path: filename };
  }

  async function chooseClipExport(viewer: Viewer) {
    if (!viewer) throw Error("先打开波形");
    await viewer.ready;
    if (!viewer.meta) throw Error("波形未加载成功");
    const view: ClipContext = await viewer.ui("clipContext");
    const options = [
      { label: "当前可见时间窗口", range: "view" as const },
      ...(view.cursorB !== null && view.cursorA !== view.cursorB
        ? [{ label: "游标 A 到 B", range: "cursors" as const }]
        : []),
    ];
    const scope = await vscode.window.showQuickPick(
      [
        {
          label: "已选信号",
          description: `${view.selected.length} 个`,
          signals: view.selected,
        },
        {
          label: "当前显示的信号",
          description: `${view.displayed.length} 个`,
          signals: view.displayed,
        },
      ],
      { placeHolder: "选择要截取的信号" },
    );
    if (!scope) return;
    const interval = await vscode.window.showQuickPick(options, {
      placeHolder: "选择截取的时间范围",
    });
    if (!interval) return;
    const kind = await vscode.window.showQuickPick(
      [
        { label: "PNG 图片", format: "png" as const },
        { label: "CSV 事件表", format: "csv" as const },
        { label: "JSON 波形数据", format: "json" as const },
        { label: "VCD 波形片段", format: "vcd" as const },
      ],
      { placeHolder: "选择导出格式" },
    );
    if (!kind) return;

    const clip = await collectClip(viewer, { range: interval.range }, false, {
      ...view,
      selected: scope.signals,
    });
    const destination = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(
        path.join(
          path.dirname(viewer.uri.fsPath),
          `wave-${clip.start}-${clip.end}.${kind.format}`,
        ),
      ),
      filters: { [kind.label]: [kind.format] },
    });
    if (!destination) return;
    await exportClipArtifact(
      viewer,
      clip,
      kind.format,
      destination.fsPath,
      false,
    );
    vscode.window.showInformationMessage(
      clip.truncated
        ? "波形已导出。部分信号达到事件上限，文件中已标记。"
        : "波形片段已导出。",
    );
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
  const refreshSidebar = () => sidebar.refresh();
  const provider: vscode.CustomEditorProvider<WaveDocument> = {
    ...createWaveDocuments(
      vscode,
      viewers,
      projectChanges,
      saveProject,
      refreshSidebar,
    ),
    resolveCustomEditor: createWaveEditor(vscode, context, {
      viewers,
      projectChanges,
      output,
      refreshSidebar,
      setCurrent(viewer) {
        current = viewer;
      },
      removeCurrent(viewer) {
        if (current === viewer) current = [...viewers].at(-1);
      },
      scheduleEditorSync,
      rememberFile,
      applyDebugLayout,
      executeTcl,
      openWaveform,
      openRecent,
      selectDecoder,
      editDecoderConfig,
      decoderConfigPath,
      updateSidebarTags,
      saveActiveProject,
      openProject,
      chooseClipExport,
      runScript,
      openKdbSource,
      sidebarTree,
    }),
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
    openRecent,
    compareBackends: async () => {
      const viewer = current;
      if (!viewer || !isFsdb(viewer.uri.fsPath))
        throw Error("先打开 FSDB 波形");
      await viewer.ready;
      if (!viewer.meta) throw Error("波形未加载成功");
      const view: ClipContext = await viewer.ui("clipContext");
      const selection = await vscode.window.showQuickPick(
        [
          { label: "当前视窗", range: "view" as const },
          ...(view.cursorB !== null && view.cursorB !== view.cursorA
            ? [{ label: "游标 A 到 B", range: "cursors" as const }]
            : []),
        ],
        { placeHolder: "选择后端对比的时间范围" },
      );
      if (!selection) return;
      const cfg = vscode.workspace.getConfiguration(
        "waveWorkbench",
        viewer.uri,
      );
      const log = (message: string) => output.append(message);
      const plans = [
        backendPlan(context, cfg, viewer.uri.fsPath, log, "verdi"),
        backendPlan(context, cfg, viewer.uri.fsPath, log, "independent"),
      ] as const;
      const content = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "正在对比 FSDB 后端",
        },
        () =>
          compareBackends(
            plans,
            viewer.uri.fsPath,
            view,
            selection.range,
            viewer.kdb?.path,
            cfg.get<Record<string, string>>("hierarchyMappings"),
          ),
      );
      const doc = await vscode.workspace.openTextDocument({
        language: "markdown",
        content,
      });
      await vscode.window.showTextDocument(doc, {
        viewColumn: vscode.ViewColumn.Beside,
      });
    },
    selectBackend: async () => {
      const viewer = current;
      const cfg = vscode.workspace.getConfiguration(
        "waveWorkbench",
        viewer?.uri,
      );
      const preference = cfg.get<FsdbBackend>("fsdbBackend", "auto");
      const selection = await vscode.window.showQuickPick(
        backendChoices.map((choice) => ({
          ...choice,
          picked: choice.value === preference,
          detail:
            viewer?.backendKind === choice.value
              ? "当前波形正在使用"
              : undefined,
        })),
        { title: "选择 FSDB / KDB 后端" },
      );
      if (!selection) return;
      const label =
        viewer && isFsdb(viewer.uri.fsPath)
          ? await viewer.switchBackend(selection.value)
          : selection.label;
      await cfg.update(
        "fsdbBackend",
        selection.value,
        vscode.workspace.workspaceFolders?.length
          ? vscode.ConfigurationTarget.Workspace
          : vscode.ConfigurationTarget.Global,
      );
      await vscode.window.showInformationMessage(`Wave Workbench · ${label}`);
    },
    openLast: () =>
      openWaveform(context.workspaceState.get<string>("lastWaveform")),
    runScript: (uri) => runScript(uri),
    exportClip: () => chooseClipExport(current),
    saveProject: () => saveActiveProject(current),
    openProject: (uri) => openProject(uri?.fsPath),
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
        `波形缓存 · ${stats.entries} 块，${(stats.bytes / 1048576).toFixed(1)} / ${(stats.budget / 1048576).toFixed(0)} MiB，命中 ${stats.hits}，实际读取 ${stats.reads} 次`,
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
    let scope = dumpScope(
      viewer,
      viewer.sourceInstances.get(editor.document.uri?.fsPath) || "",
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
  const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (
    workspace &&
    process.platform !== "win32" &&
    vscode.workspace
      .getConfiguration("waveWorkbench")
      .get<boolean>("mcpEnabled")
  ) {
    try {
      context.subscriptions.push(
        serveWaveMcp(
          workspace,
          async (name, args) => {
            if (name === "wave_list")
              return {
                selected: current?.uri.fsPath ?? null,
                views: [...viewers].map((v) => v.uri.fsPath),
              };
            if (name === "wave_open") {
              const filename = path.resolve(workspace, String(args.path));
              if (
                !/\.(fsdb|vcd|waveproj)$/i.test(filename) ||
                !fs.existsSync(filename)
              )
                throw Error("Waveform or project not found: " + filename);
              const viewer = /\.waveproj$/i.test(filename)
                ? await openProject(filename)
                : await openWaveform(filename);
              if (!viewer) throw Error("Unable to open waveform");
              return { waveform: viewer.uri.fsPath, scale: viewer.meta.scale };
            }
            const viewer = args.waveform
              ? [...viewers].find((v) => v.uri.fsPath === args.waveform)
              : current;
            if (!viewer) throw Error("Open a waveform first");
            if (name === "wave_clip" || name === "wave_export") {
              await viewer.ready;
              if (!viewer.meta) throw Error("Waveform did not load");
              if (!viewer.panel.visible) viewer.panel.reveal(undefined, true);
              const clip = await collectClip(
                viewer,
                args as ClipOptions,
                name === "wave_clip",
              );
              if (name === "wave_clip") return clip;
              const format = args.format as ClipFormat;
              if (!clipFormats.includes(format))
                throw Error("Unsupported clip format");
              return exportClipArtifact(
                viewer,
                clip,
                format,
                typeof args.path === "string"
                  ? path.resolve(workspace, args.path)
                  : undefined,
              );
            }
            if (name === "wave_save_project") {
              const filename = await saveProject(
                viewer,
                path.resolve(workspace, String(args.path)),
              );
              return { path: filename };
            }
            if (viewer.running || tclOutput.has(viewer))
              throw Error("A Tcl script is running in this view");
            const logs: string[] = [];
            tclOutput.set(viewer, logs);
            try {
              const result = await executeTcl(viewer, String(args.script));
              return { result, logs };
            } finally {
              tclOutput.delete(viewer);
            }
          },
          (message) => output.appendLine(String(message)),
        ),
      );
    } catch (error) {
      output.appendLine(String(error));
    }
  }
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
