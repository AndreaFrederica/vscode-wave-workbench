// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { Viewer } from "./viewer";
import type { Location } from "./shared/protocol";
import type * as vscode from "vscode";
import * as path from "node:path";

import { identifiers, resolveSelection, codeOnly } from "./rtl-selection";
import {
  belongsToBoundDut,
  inDirectory,
  resolveBoundSource,
  rtlSourceTarget,
  type RtlNavigationTarget,
  type RtlProjectBinding,
} from "./rtl-project-binding";
import { moduleAt, commonScope, SourceFiles } from "./source-sync";
import { registerWaveRtlHover } from "./wave-rtl-hover";

import type {
  WaveAnalysis,
  GetViewer,
  ReportError,
} from "./wave-extension-types";
type VSCodeApi = typeof vscode;

export function createWaveSourceNavigation(
  vscode: VSCodeApi,
  {
    context,
    output,
    getCurrent,
    refreshSidebar,
    logSidebar,
    report,
    sourceLocation,
    dumpScope,
  }: {
    context: vscode.ExtensionContext;
    output: vscode.OutputChannel;
    getCurrent: GetViewer;
    refreshSidebar: () => void;
    logSidebar: (message: string, waveform: string) => void;
    report: ReportError;
    sourceLocation: WaveAnalysis["sourceLocation"];
    dumpScope: WaveAnalysis["dumpScope"];
  },
) {
  let syncTimer: ReturnType<typeof setTimeout>,
    syncGeneration = 0,
    suppressEditorSync = 0;
  const sourceFiles = new SourceFiles();
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
    refreshSidebar();
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
    const binding = viewer.document.rtlBinding;
    const candidates = await session.instances(module);
    const matches: Location[] = [];
    for (const candidate of candidates) {
      if (!valid()) return [];
      const record = candidate.definitionFile
        ? candidate
        : await session.resolve(candidate.fullname);
      if (!record?.definitionFile) continue;
      const definition = resolveBoundSource(
        record.definitionFile,
        path.dirname(session.path),
        binding,
        cfg.get("sourcePathMappings"),
      );
      if (
        sourceFiles.same(file, definition) &&
        belongsToBoundDut(binding, definition, candidate.fullname)
      )
        matches.push(candidate);
    }
    return matches;
  }
  const rtlLanguages = ["systemverilog", "verilog"];
  registerWaveRtlHover(vscode, {
    context,
    output,
    languages: rtlLanguages,
    getCurrent,
    sourceFiles,
    sourceInstances,
    dumpScope,
  });

  async function syncEditor(
    editor: vscode.TextEditor | undefined,
    generation: number,
  ) {
    const viewer = getCurrent(),
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
        getCurrent() === viewer &&
        !viewer.disposed &&
        viewer.kdb === session;
    const file = doc.uri.fsPath,
      module = moduleAt(doc.getText(), editor.selection?.active?.line || 0);
    if (!module) return;
    const binding = viewer.document.rtlBinding;
    const side = binding && rtlSourceTarget(binding, file);
    if (side && side !== (binding.target ?? "design")) return;
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
  function invalidateEditorSync() {
    ++syncGeneration;
    clearTimeout(syncTimer);
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
  function autoSplit(viewer: Viewer) {
    return (
      vscode.workspace
        .getConfiguration("waveWorkbench", viewer.uri)
        .get<boolean>("autoSplit") === true
    );
  }

  async function applyDebugLayout(viewer: Viewer, force = false) {
    if (!viewer || (!force && !autoSplit(viewer))) return;
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
  async function openKdbSource(
    viewer: Viewer,
    fullname: string,
    target = "declaration",
  ) {
    if (!viewer.kdb && !(await viewer.attachKdb())) return;
    const location = await sourceLocation(viewer, fullname, target);
    const { record } = location;
    const editorScope =
      target === "instance"
        ? await viewer.kdb.parent(record.instance || record.fullname)
        : record.instance || fullname;
    await showKdbSource(viewer, location, editorScope, target);
  }

  async function openRtlTarget(
    viewer: Viewer,
    binding: RtlProjectBinding,
    target: RtlNavigationTarget,
    valid: () => boolean,
  ) {
    const design = viewer.kdb;
    if (!design) return;
    let instance = binding.dutInstance;
    if (target === "testbench") {
      const ancestors = new Set<string>([instance]);
      while (valid() && (instance = await design.parent(instance))) {
        if (ancestors.has(instance)) break;
        ancestors.add(instance);
        const location = await sourceLocation(
          viewer,
          instance,
          "definition",
          false,
        ).catch(() => undefined);
        if (
          location &&
          inDirectory(location.file, binding.testbenchRoot) &&
          valid()
        ) {
          await showKdbSource(viewer, location, instance, "definition");
          await revealScope(viewer, instance, valid);
          return;
        }
      }
      if (valid())
        throw Error(
          "No testbench ancestor of " +
            binding.dutInstance +
            " has a definition in " +
            binding.testbenchRoot +
            ".",
        );
      return;
    }
    const location = await sourceLocation(
      viewer,
      instance,
      "definition",
      false,
    );
    if (!valid()) return;
    if (!inDirectory(location.file, binding.designRoot))
      throw Error(
        "The DUT definition is outside the original RTL directory: " +
          location.file,
      );
    await showKdbSource(viewer, location, instance, "definition");
    await revealScope(viewer, instance, valid);
  }

  async function showKdbSource(
    viewer: Viewer,
    { file, line, record }: Awaited<ReturnType<WaveAnalysis["sourceLocation"]>>,
    editorScope: string,
    target: string,
  ) {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    let editor;
    suppressEditorSync++;
    invalidateEditorSync();
    try {
      const split = autoSplit(viewer);
      if (split) await applyDebugLayout(viewer);
      const existing = vscode.window.visibleTextEditors?.find(
        (candidate) => candidate.document.uri.toString() === doc.uri.toString(),
      );
      editor = await vscode.window.showTextDocument(doc, {
        viewColumn: split
          ? (vscode.ViewColumn.One ?? 1)
          : (existing?.viewColumn ??
            viewer.panel.viewColumn ??
            vscode.ViewColumn.Active),
      });
    } finally {
      suppressEditorSync--;
    }
    const position = new vscode.Position(line - 1, 0);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(new vscode.Range(position, position));
    viewer.sourceInstances.set(file, editorScope);
    if (typeof doc.getText === "function")
      viewer.syncedEditor =
        file + ":" + doc.version + ":" + moduleAt(doc.getText(), line - 1);
    viewer.selectedScope = editorScope;
    await viewer.panel.webview.postMessage({
      type: "scopeSelected",
      scope: editorScope,
    });
    refreshSidebar();
    output.appendLine(`HDL ${record.fullname} -> ${file}:${line} (${target})`);
  }

  async function addRtlSelection() {
    const editor = vscode.window.activeTextEditor,
      viewer = getCurrent();
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
    if (viewer.disposed || getCurrent() !== viewer) return;
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
    if (viewer.disposed || getCurrent() !== viewer) return;
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
      viewer.panel.reveal(viewer.panel.viewColumn, true);
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
    logSidebar(message, viewer.uri.fsPath);
    vscode.window.showInformationMessage(message);
  }
  context.subscriptions.push(
    vscode.commands.registerCommand("waveWorkbench.addSelection", () =>
      addRtlSelection().catch(report),
    ),
  );

  return {
    revealScope,
    scheduleEditorSync,
    invalidateEditorSync,
    applyDebugLayout,
    openKdbSource,
    openRtlTarget,
  };
}
