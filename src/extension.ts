// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { SchematicGraph } from "./shared/schematic";
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
import { randomUUID } from "node:crypto";
import { traceSchematic, traceTimeSchematic } from "./rtl-schematic";
import { kdbModuleSchematic, kdbSchematicRoots } from "./kdb-schematic";
import { fileURLToPath } from "node:url";
import { createWaveDocuments } from "./wave-documents";
import { createWaveEditor } from "./wave-editor";
import {
  backendChoices,
  backendPlan,
  isFsdb,
  isWaveform,
  type FsdbBackend,
} from "./backend-selection";
import {
  identifiers,
  resolveSelection,
  codeOnly,
  portConnection,
} from "./rtl-selection";
import { restoreView } from "./view-state";
import {
  designSnapshot,
  readWaveProject,
  saveWaveProject,
  type TraceProjectSelection,
} from "./project";
import { createDecoderGroup, loadDecoderProfiles } from "./decoder-config";
import {
  createScriptDecoder,
  decoderRegistry,
  type DecoderDefinition,
} from "./decoder-runtime/registry";
import { DecoderScheduler } from "./decoder-runtime/scheduler";
import { idPattern, type DecoderInstance } from "./decoder-runtime/types";
import {
  builtinProfiles,
  decodeWord,
  supportsProfile,
} from "./shared/decoders";
import {
  findRtlSignals,
  findSignal,
  fsdbGenerateScope,
  kdbGenerateScope,
  readSignalsAt,
} from "./signal-lookup";
import { serveWaveMcp } from "./mcp";
import { createWaveTaskStatus } from "./wave-task-status";
import { VerilatorDesign, verilatorTreeFile } from "./verilator";
import {
  clipFormats,
  collectClip,
  serializeClip,
  type ClipFormat,
  type ClipOptions,
} from "./wave-clip";
import * as WaveSignal from "./shared/signals";
import { isMissingKdbDeclaration, KdbSession, mapPrefix } from "./kdb";
import { Sidebar } from "./sidebar";
import { WaveCommands, HELP, formatValue, quote } from "./commands";
import { moduleAt, commonScope, SourceFiles } from "./source-sync";
import { TclRunner } from "./tcl";
import {
  appendContinuationReport,
  declarationColumns,
  declaredSignalName,
  continuationMermaidPages,
  continuationReport,
  combinedTemporalMermaid,
  mergeTemporalContinuationGraph,
  followTemporalFrontier,
  TraceContextChanged,
  observationMermaidPages,
  observationReport,
  queryTrace,
  selectionText,
  staticTraceCoverage,
  isStaticBudgetStop,
  traceSignalScope,
  staticTracePage,
  temporalMermaidOutput,
  temporalTraceReferences,
  temporalWaveformSignals,
  packedStructPorts,
  traceFeedback,
  traceMermaidPages,
  traceReport,
  UnresolvedTraceSignal,
  type TraceDirection,
  type TraceOptions,
  type VideTrace,
  type VideAnalysisApi,
  type VideTraceProject,
  type ContinuationTrace,
  type ContinuationWalk,
  type TemporalContinuation,
} from "./rtl-trace";
import {
  followStaticFrontier,
  mergeStaticContinuationGraph,
  mergedStaticMermaid,
  pageStaticContinuationGraph,
  staticContinuationMermaid,
  staticContinuationReport,
  summarizeStaticWalk,
  type StaticWalk,
} from "./rtl-static-continuations";
import {
  staticGraphSnapshot,
  temporalGraphSnapshot,
  traceGraphPage,
} from "./rtl-trace-graph-page";
import {
  readTraceObservations,
  tracePackedSelection,
} from "./rtl-trace-observations";
import { focusPackedTrace, hasPackedSelection } from "./rtl-trace-bits";
import {
  discoverVcsRebuild,
  previewVideManifest,
  readSimulationFilelist,
  simulationFilelistsCurrent,
  simulationInputFingerprint,
  traceVideManifest,
  type ElaboratedLibrarySources,
} from "./vide-project-config";
import { traceRuntimeInputs } from "./rtl-runtime-inputs";
import {
  buildTemporalTrace,
  traceAssignmentCandidates,
  traceCursorWriters,
  type ObservedTraceWord,
  type RecordedOperandHistory,
  type RecordedTraceField,
  type TemporalLimits,
} from "./rtl-trace-candidates";
import {
  bindModuleGenerateBranches,
  expandInstanceTrace,
  seedModportAlias,
  type TracePortQuery,
} from "./rtl-trace-instances";
import {
  annotateRecordedValueChanges,
  attachRecordedTaskTransfers,
  reconcileRecordedWordHistory,
  correlateExecutionTransitions,
  executionAssignmentReport,
  executionMermaidPages,
  executionEventLines,
  ExecutionRecordingIdentityError,
  executionReport,
  executionTransitionReport,
  linkExecutionAssignments,
  matchRecordedModportComponents,
  preserveDumpedTransitionEvidence,
  readExecutionEvidence,
  readExecutionEvidenceBatch,
  reachedWriteEvents,
  recordedCursorWrite,
  recordedOperandHistory,
  recordedWriters,
  restoreRecordedSignalHistory,
  vcsExecutionStatements,
} from "./rtl-execution";
import { mermaidMarkdown, mermaidOutput } from "./trace-mermaid";
import {
  isStatementEventKind,
  isVcsLiveSignal,
  LIVE_EXECUTION_BUFFER_LIMIT,
  LiveTraceSession,
  matchLiveExecution,
  parseLiveLaunch,
  type LiveLaunchOptions,
} from "./rtl-live-trace";
import { createTraceExplorer } from "./trace-explorer";
import {
  readAdjacentTraceBuildManifest,
  readTraceBuildManifest,
  verilatorArtifactMismatches,
  verifyLiveTraceBuild,
  verifyTraceBuild,
  type TraceBuildManifest,
} from "./rtl-build-verification";

function rtlValue(raw: string, width: number) {
  const shown =
    width > 1 && /^[01xz]+$/i.test(raw)
      ? "0x" + formatValue(raw, width, "Hex", true)
      : raw;
  return shown.length > 256 ? shown.slice(0, 256) + "…" : shown;
}

function activate(context: vscode.ExtensionContext) {
  const trackTask = createWaveTaskStatus(vscode, context);
  const decoderScheduler = new DecoderScheduler(
    context.asAbsolutePath(
      "bin/wave-backend-independent" +
        (process.platform === "win32" ? ".exe" : ""),
    ),
  );
  const output = vscode.window.createOutputChannel("Wave Workbench");
  context.subscriptions.push(output);
  const viewers = new Set<Viewer>();
  const decoderFileWatch = vscode.workspace.createFileSystemWatcher?.(
    "**/wave-decoders/{lua,javascript}/**/*",
  );
  if (decoderFileWatch) {
    let reloadTimer: ReturnType<typeof setTimeout> | undefined;
    const reload = (uri: vscode.Uri) => {
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => {
        const root = vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath;
        for (const viewer of viewers) {
          const config = decoderConfigPath(viewer);
          if (
            viewer.disposed ||
            !viewer.meta ||
            (root && config && path.dirname(path.dirname(config)) !== root)
          )
            continue;
          void viewer.ui("decoderRefresh").catch(() => {});
        }
      }, 150);
    };
    context.subscriptions.push(
      decoderFileWatch,
      decoderFileWatch.onDidCreate(reload),
      decoderFileWatch.onDidChange(reload),
      decoderFileWatch.onDidDelete(reload),
      { dispose: () => clearTimeout(reloadTimer) },
    );
  }
  const traceProjects = new Map<
    Viewer,
    ReturnType<typeof openSimulationTrace>
  >();
  const portTraceCache = new WeakMap<
    VideTraceProject,
    { revision: string; traces: Map<string, VideTrace> }
  >();
  const traceProjectKey = (viewer: Viewer) =>
    "videTraceProject:" + viewer.uri.toString();
  function traceProjectSelection(viewer: Viewer) {
    const selection = viewer.document.traceProject;
    return selection === undefined
      ? context.workspaceState?.get<TraceProjectSelection | null>(
          traceProjectKey(viewer),
        )
      : selection;
  }
  const dropTraceProject = (viewer: Viewer) => {
    const project = traceProjects.get(viewer);
    traceProjects.delete(viewer);
    void project?.then(
      ({ session }) => session.dispose(),
      () => undefined,
    );
  };
  context.subscriptions.push({
    dispose: () =>
      traceProjects.forEach((_, viewer) => dropTraceProject(viewer)),
  });
  const projectChanges = new vscode.EventEmitter<
    vscode.CustomDocumentContentChangeEvent<WaveDocument>
  >();
  context.subscriptions.push(projectChanges);
  let current: Viewer, sidebar: Sidebar;
  let liveTrace: LiveTraceSession | undefined;
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
    if (
      !connection &&
      session.kind === "verilator" &&
      !groups[0].signals.length &&
      selectedScope.startsWith(instance.fullname + ".")
    ) {
      const selected = await session.resolve(selectedScope);
      if (["npiGenScope", "npiNamedBegin"].includes(selected?.kind)) {
        const scope = dumpScope(viewer, selectedScope);
        groups[0] = {
          scope,
          name: target,
          ...(await findRtlSignals(viewer.backend, scope, target)),
        };
      }
    }
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
      placeHolder: "选择 FSDB、FST、VCD 或波形工程",
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
    if (filename && !isWaveform(filename)) filename = undefined;
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
          title: "打开波形",
          filters: { Waveforms: ["fsdb", "fst", "vcd"] },
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
    return trackTask("执行波形 Tcl", viewer?.uri.fsPath, () =>
      runTcl(viewer, script, directory),
    );
  }

  async function runTcl(viewer: Viewer, script: string, directory?: string) {
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
        decodeTransactions: decodeWindow,
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
    const design = viewer.kdb;
    const verilator = design?.kind === "verilator";
    const designView = designSnapshot(viewer);
    const traceProject = traceProjectSelection(viewer);
    if (cancellation?.isCancellationRequested) return;
    await saveWaveProject(
      filename,
      viewer.uri.fsPath,
      view,
      verilator ? undefined : design?.path,
      verilator ? design.path : undefined,
      designView,
      traceProject,
    );
    document.projectPath = filename;
    document.savedView = view;
    document.savedKdb = design?.path;
    document.savedDesignView = designView;
    document.traceProject = document.savedTraceProject = traceProject;
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
  async function listWaveDecoders(viewer: Viewer) {
    const config = decoderConfigPath(viewer);
    const root = config && path.dirname(path.dirname(config));
    return decoderRegistry(
      await loadDecoderProfiles(config),
      vscode.workspace.isTrusted ? root : undefined,
    );
  }
  async function decodeWindow(
    viewer: Viewer,
    instance: DecoderInstance,
    start: string,
    end: string,
    signal?: AbortSignal,
  ) {
    await viewer.ready;
    const { definitions } = await listWaveDecoders(viewer);
    const definition = definitions.get(instance.decoderId);
    if (!definition)
      throw Error("Decoder not found or disabled: " + instance.decoderId);
    if (
      instance.engine !== undefined &&
      instance.engine !== definition.manifest.engine
    )
      throw Error("The saved decoder engine no longer matches its definition.");
    const backend = viewer.backend;
    const meta = viewer.meta;
    if (
      !instance.bindings ||
      typeof instance.bindings !== "object" ||
      Array.isArray(instance.bindings) ||
      Object.keys(instance.bindings).some(
        (id) => !definition.manifest.inputs.some((input) => input.id === id),
      )
    )
      throw Error("Invalid decoder signal binding.");
    const bindings = await Promise.all(
      definition.manifest.inputs.map(async ({ id, width, required, real }) => {
        const name = instance.bindings[id];
        if (name === undefined && required === false) return null;
        if (typeof name !== "string" || !name || name.length > 1024)
          throw Error("Bind decoder input " + id);
        const bound = await findSignal(backend, name);
        if (!!bound.real !== !!real)
          throw Error("Incompatible signal type for decoder input " + id);
        if (
          bound.width < 1 ||
          bound.width > 4096 ||
          (width !== undefined && bound.width !== width)
        )
          throw Error("Incompatible width for decoder input " + id);
        return bound;
      }),
    );
    if (!bindings.some(Boolean))
      throw Error("Select at least one waveform signal.");
    const decoded = await decoderScheduler.decode({
      provider: { backend, meta },
      definition,
      bindings,
      options: instance.options,
      start,
      end,
      signal,
    });
    if (viewer.disposed || viewer.backend !== backend || viewer.meta !== meta)
      throw Error("The waveform changed during decoder replay.");
    return decoded;
  }
  async function configureWaveDecoder(viewer: Viewer) {
    const { definitions, warnings } = await listWaveDecoders(viewer);
    for (const warning of warnings) output.appendLine(warning);
    const choice = await vscode.window.showQuickPick(
      [...definitions.values()].map(({ manifest }) => ({
        label: manifest.name,
        description: manifest.engine + " · " + manifest.version,
        manifest,
      })),
      { placeHolder: "选择波形事务解码器" },
    );
    if (!choice) return;
    const selected: Signal | undefined = await viewer.ui("activeSignal");
    const bindings: Record<string, string> = {};
    for (const input of choice.manifest.inputs) {
      const name = await vscode.window.showInputBox({
        prompt: "绑定输入 " + input.id,
        value: selected ? selected.scope + "." + selected.name : "",
        validateInput: (value) =>
          !value.trim() && input.required !== false
            ? "输入波形信号路径"
            : undefined,
      });
      if (name === undefined) return;
      if (name.trim()) bindings[input.id] = name.trim();
    }
    const options = await vscode.window.showInputBox({
      prompt: "解码参数（JSON 对象）",
      value: JSON.stringify(choice.manifest.options ?? {}),
      validateInput(value) {
        try {
          const object = JSON.parse(value);
          return !object || typeof object !== "object" || Array.isArray(object)
            ? "请输入 JSON 对象"
            : undefined;
        } catch {
          return "无效的 JSON";
        }
      },
    });
    if (options === undefined) return;
    await viewer.ui("decoderAttach", {
      instanceId: randomUUID(),
      decoderId: choice.manifest.id,
      engine: choice.manifest.engine,
      bindings,
      options: JSON.parse(options),
    });
  }
  async function manageWaveDecoders(viewer: Viewer) {
    if (!vscode.workspace.isTrusted)
      throw Error("请在可信工作区管理脚本解码器。");
    const config = decoderConfigPath(viewer);
    if (!config) throw Error("请先打开工作区文件夹。");
    const root = path.dirname(path.dirname(config));
    const { definitions, warnings } = await listWaveDecoders(viewer);
    for (const warning of warnings) output.appendLine(warning);
    const action = await vscode.window.showQuickPick(
      [
        { label: "新建", id: "create" },
        { label: "复制", id: "copy" },
        { label: "编辑入口脚本", id: "script" },
        { label: "编辑清单", id: "manifest" },
        { label: "移到回收站", id: "trash" },
      ],
      { title: "管理脚本解码器" },
    );
    if (!action) return;
    let source: DecoderDefinition | undefined;
    if (action.id !== "create") {
      const choice = await vscode.window.showQuickPick(
        [...definitions.values()]
          .filter((definition) => definition.directory)
          .map((definition) => ({
            label: definition.manifest.name,
            description: definition.manifest.id,
            definition,
          })),
        { placeHolder: "选择工作区脚本解码器" },
      );
      if (!choice) return;
      source = choice.definition;
      if (action.id === "trash") {
        const confirmed = await vscode.window.showWarningMessage(
          "将 " + source.manifest.id + " 移到回收站？",
          { modal: true },
          "移到回收站",
        );
        if (confirmed)
          await vscode.workspace.fs.delete(vscode.Uri.file(source.directory!), {
            recursive: true,
            useTrash: true,
          });
        return;
      }
      if (action.id !== "copy") {
        const filename =
          action.id === "manifest"
            ? path.join(source.directory!, "decoder.json")
            : source.filename!;
        await vscode.window.showTextDocument(vscode.Uri.file(filename));
        return;
      }
    }
    const engine =
      source?.manifest.engine ??
      (await vscode.window.showQuickPick(["lua", "javascript"], {
        placeHolder: "选择脚本引擎",
      }));
    if (engine !== "lua" && engine !== "javascript") return;
    const id = await vscode.window.showInputBox({
      prompt: "解码器 ID",
      value: source ? source.manifest.id + ".copy" : "custom.",
      validateInput: (value) =>
        !idPattern.test(value)
          ? "请输入有效的解码器 ID"
          : definitions.has(value)
            ? "解码器 ID 已存在"
            : undefined,
    });
    if (!id) return;
    const filename = await createScriptDecoder(root, engine, id, source);
    await vscode.window.showTextDocument(vscode.Uri.file(filename));
  }
  async function materializeDecoderSignal(
    viewer: Viewer,
    instance: DecoderInstance,
  ) {
    await viewer.ready;
    const backend = viewer.backend;
    const { start, end } = viewer.meta;
    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "计算完整波形的虚拟信号",
        cancellable: true,
      },
      async (_progress, token) => {
        const controller = new AbortController();
        const cancel = token.onCancellationRequested(() => controller.abort());
        if (token.isCancellationRequested) controller.abort();
        try {
          return await decodeWindow(
            viewer,
            instance,
            start,
            String(BigInt(end) + 1n),
            controller.signal,
          );
        } catch (error) {
          if (!controller.signal.aborted) throw error;
        } finally {
          cancel.dispose();
        }
      },
    );
    if (!result) return;
    if (result.truncated) throw Error("解码结果达到容量上限。");
    const outputs = new Map<
      string,
      { width: number; samples: Map<string, string> }
    >();
    for (const { id, width, tick, value } of result.virtualSamples ?? []) {
      const output = outputs.get(id) ?? {
        width,
        samples: new Map<string, string>(),
      };
      if (output.width !== width)
        throw Error("虚拟信号 " + id + " 的位宽发生变化。");
      output.samples.set(tick, value);
      outputs.set(id, output);
    }
    if (!outputs.size) throw Error("此解码器没有输出虚拟信号采样。");
    const choice = await vscode.window.showQuickPick(
      [...outputs].map(([label, output]) => ({ label, output })),
      { placeHolder: "选择虚拟信号" },
    );
    if (!choice || viewer.disposed || viewer.backend !== backend) return;
    const { width, samples } = choice.output;
    if (!samples.has(start)) samples.set(start, "x".repeat(width));
    return backend.request("defineVirtual", {
      name: choice.label,
      definition: {
        op: "samples",
        inputs: [],
        width,
        source: instance.instanceId + "." + choice.label,
        samples: [...samples].sort(([left], [right]) =>
          BigInt(left) < BigInt(right) ? -1 : 1,
        ),
      },
    });
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
    if (!isWaveform(project.waveform) || !fs.existsSync(project.waveform))
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
    const database = project.verilator || project.kdb;
    if (
      database &&
      (!viewer.kdb || path.resolve(viewer.kdb.path) !== database)
    ) {
      if (fs.existsSync(database)) await viewer.attachKdb(database, false);
      else {
        output.appendLine(
          "Wave project design database not found: " + database,
        );
        void vscode.window.showWarningMessage(
          "波形工程找不到设计数据库 " + database,
        );
      }
    }
    if (database && viewer.kdb?.path === database && project.designView) {
      ++syncGeneration;
      clearTimeout(syncTimer);
      await viewer.restoreDesignView(project.designView);
    }
    await viewer.ui("restoreView", { ...view, projectBaseline: true });
    document.projectPath = filename;
    document.savedView = document.view || view;
    document.savedKdb = viewer.kdb?.path;
    document.savedDesignView = designSnapshot(viewer);
    document.traceProject = document.savedTraceProject = project.traceProject;
    dropTraceProject(viewer);
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

    const clip = await trackTask("截取波形", viewer.uri.fsPath, async () => {
      const result = await collectClip(
        viewer,
        { range: interval.range },
        false,
        {
          ...view,
          selected: scope.signals,
        },
      );
      await includeClipDecoder(viewer, result, kind.format);
      return result;
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
    await trackTask(
      `导出波形 ${kind.format.toUpperCase()}`,
      viewer.uri.fsPath,
      () =>
        exportClipArtifact(
          viewer,
          clip,
          kind.format,
          destination.fsPath,
          false,
        ),
    );
    vscode.window.showInformationMessage(
      clip.truncated
        ? "波形已导出。部分信号达到事件上限，文件中已标记。"
        : "波形片段已导出。",
    );
  }

  async function includeClipDecoder(
    viewer: Viewer,
    clip: WaveClip,
    format: ClipFormat,
    signal?: AbortSignal,
  ) {
    if (format !== "png" && format !== "json") return;
    const view: WaveState = await viewer.ui("snapshot");
    for (const instance of view?.decoderInstances ?? []) {
      let result;
      try {
        result = await decodeWindow(
          viewer,
          instance,
          clip.start,
          String(BigInt(clip.end) + 1n),
          signal,
        );
      } catch (error) {
        signal?.throwIfAborted();
        result = {
          transactions: [],
          warnings: [String(error)],
          truncated: true,
        };
      }
      (clip.decoders ??= []).push({ id: instance.decoderId, result });
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
      record?.instance &&
      record.instance !== record.fullname
    )
      record = await viewer.kdb.resolve(record.instance);
    let file = target === "definition" ? record?.definitionFile : record?.file;
    const line =
      target === "definition" ? record?.definitionLine : record?.line;
    if (!file || !Number.isInteger(line) || line < 1)
      throw new Error(`No ${target} source location for ${fullname}.`);
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

  async function traceRtlPosition(
    direction: TraceDirection,
    uri: vscode.Uri,
    position: vscode.Position,
    options?: TraceOptions,
    token?: vscode.CancellationToken,
    project?: VideTraceProject,
  ) {
    const params = {
      textDocument: { uri: uri.toString() },
      position: { line: position.line, character: position.character },
      options,
    };
    if (project) {
      return queryTrace(
        { version: 1, capabilities: { staticTraceVersion: 1 }, ...project },
        direction,
        params,
        token,
      );
    }
    const vide = vscode.extensions.getExtension<VideAnalysisApi>(
      "pascal-lab.vide-code-extension",
    );
    return queryTrace(await vide?.activate(), direction, params, token);
  }

  async function openVideTraceProject(
    config: Parameters<typeof traceVideManifest>[0],
  ) {
    const api = await vscode.extensions
      .getExtension<VideAnalysisApi>("pascal-lab.vide-code-extension")
      ?.activate();
    if (!api?.openTraceProject)
      throw Error(
        "The active VIDE extension needs simulation project support.",
      );
    return api.openTraceProject(traceVideManifest(config));
  }

  function openTraceBuildProject(buildManifest: TraceBuildManifest) {
    return openVideTraceProject({
      sources: buildManifest.roots.map((path) => ({ path })),
      compilationUnits: buildManifest.compilation_units,
      compilationUnitOptions: buildManifest.compilation_unit_options,
      sourceLibraries: buildManifest.source_libraries,
      libraryMaps: buildManifest.library_maps,
      libraryFiles: (buildManifest.library_files ?? []).map((path) => ({
        path,
      })),
      includeDirectories: buildManifest.include_dirs,
      defines: buildManifest.defines,
      topModules: buildManifest.top_modules,
      parameterOverrides: buildManifest.parameter_overrides ?? [],
    });
  }

  type SimulationFilelistSelection =
    | Extract<TraceProjectSelection, { filelist: string }>
    | NonNullable<Awaited<ReturnType<typeof discoverVcsRebuild>>>;

  async function readSimulationTrace(
    selection: SimulationFilelistSelection,
    viewer?: Viewer,
    design = viewer?.kdb,
  ) {
    const sourceMappings = vscode.workspace
      .getConfiguration("waveWorkbench", viewer?.uri)
      .get<Record<string, string>>("sourcePathMappings");
    let librarySources: ElaboratedLibrarySources | undefined;
    if (design instanceof VerilatorDesign || design instanceof KdbSession) {
      const files = () =>
        design instanceof VerilatorDesign
          ? design.librarySourceFiles
          : design.moduleSourceFiles();
      librarySources = {
        kind: design.kind,
        files: async () =>
          (await files()).map((file) =>
            path.resolve(
              design.kind === "kdb"
                ? selection.workingDirectory
                : path.dirname(design.path),
              mapPrefix(file, sourceMappings),
            ),
          ),
      };
    }
    return readSimulationFilelist(
      selection.filelist,
      selection.workingDirectory,
      librarySources,
      "rebuild" in selection ? selection.rebuild : undefined,
    );
  }

  async function openSimulationTrace(
    selection:
      | Extract<TraceProjectSelection, { videManifest: string }>
      | SimulationFilelistSelection,
    viewer?: Viewer,
    design = viewer?.kdb,
  ) {
    if ("videManifest" in selection) {
      const api = await vscode.extensions
        .getExtension<VideAnalysisApi>("pascal-lab.vide-code-extension")
        ?.activate();
      if (!api?.openTraceProjectFile)
        throw Error(
          "The active VIDE extension needs existing trace project support.",
        );
      return {
        session: await api.openTraceProjectFile(selection.videManifest),
        projectInfo: {
          ...selection,
          workingDirectory: path.dirname(selection.videManifest),
          limitations: [],
        },
        inputs: [],
        design,
      };
    }
    const manifest = await readSimulationTrace(selection, viewer, design);
    if (!manifest.sources.length && !manifest.libraryFiles.length)
      throw Error("The filelist contains no RTL sources.");
    if (
      "rebuild" in selection &&
      ![...manifest.sources, ...manifest.libraryFiles].some(
        ({ sha256 }) => sha256,
      )
    )
      throw Error("VCS rebuild metadata points to unavailable source files.");
    return {
      session: await openVideTraceProject(manifest),
      projectInfo: {
        filelist: selection.filelist,
        workingDirectory: selection.workingDirectory,
        ...("rebuild" in selection ? { vcsRebuild: true } : {}),
        limitations: manifest.unsupported,
        unverifiedVcsParameterPaths: manifest.unverifiedVcsParameterPaths,
        ...(manifest.libraryMaps ? { libraryMaps: manifest.libraryMaps } : {}),
        ...(design && manifest.resolvedLibraryFiles.length
          ? {
              resolvedLibraryFiles: {
                design: design.path,
                kind: design.kind,
                files: manifest.resolvedLibraryFiles,
              },
            }
          : {}),
      },
      inputs: [...manifest.filelists, ...manifest.sourceFingerprints],
      design,
    };
  }

  async function traceWaveSignal(
    viewer: Viewer,
    direction: TraceDirection,
    fullname: string,
    options: TraceOptions,
    token?: vscode.CancellationToken,
    override?: TraceProjectSelection,
    buildManifest?: TraceBuildManifest,
  ) {
    return trackTask(
      direction === "drivers" ? "追踪驱动" : "追踪负载",
      viewer.uri.fsPath,
      () =>
        resolveTraceWaveSignal(
          viewer,
          direction,
          fullname,
          options,
          token,
          override,
          buildManifest,
        ),
    );
  }

  async function resolveTraceWaveSignal(
    viewer: Viewer,
    direction: TraceDirection,
    fullname: string,
    options: TraceOptions,
    token?: vscode.CancellationToken,
    override?: TraceProjectSelection,
    buildManifest?: TraceBuildManifest,
  ) {
    await viewer.ready;
    if (token?.isCancellationRequested)
      throw Error("The RTL trace was cancelled.");
    const configuredSelection = traceProjectSelection(viewer);
    const configuredIdentity = JSON.stringify(configuredSelection);
    const design = viewer.kdb;
    const backend = viewer.backend;
    const selectionCurrent = () =>
      !viewer.disposed &&
      viewer.backend === backend &&
      viewer.kdb === design &&
      configuredIdentity === JSON.stringify(traceProjectSelection(viewer));
    let selection:
      | TraceProjectSelection
      | Awaited<ReturnType<typeof discoverVcsRebuild>>
      | null = override ?? configuredSelection;
    if (selection === undefined) {
      buildManifest ??= await readAdjacentTraceBuildManifest(viewer.uri.fsPath);
      if (!buildManifest && viewer.kdb?.kind === "kdb")
        selection = await discoverVcsRebuild(viewer.kdb.path);
    } else if (selection && !buildManifest) {
      // An explicit compilation project also provides a recovery path for an invalid sidecar.
      buildManifest = await readAdjacentTraceBuildManifest(
        viewer.uri.fsPath,
      ).catch(() => undefined);
    }
    if (!selection) {
      if (
        !buildManifest?.roots.length &&
        !buildManifest?.library_files?.length
      ) {
        const result = await traceWithProject(
          viewer,
          direction,
          fullname,
          options,
          token,
          undefined,
          buildManifest,
        );
        return { ...result, buildManifest };
      }
      const project = await openTraceBuildProject(buildManifest);
      try {
        const result = await traceWithProject(
          viewer,
          direction,
          fullname,
          { ...options, includeCompilation: true },
          token,
          project,
          buildManifest,
        );
        result.trace.simulationProject = {
          buildManifest: buildManifest.filename,
          workingDirectory: path.dirname(buildManifest.filename),
          limitations: buildManifest.unsupported ?? [],
        };
        return { ...result, buildManifest };
      } finally {
        project.dispose();
      }
    }
    if (!override && !selectionCurrent())
      throw Error(
        "The simulation filelist selection changed during the trace query.",
      );
    const rebuild = "rebuild" in selection ? selection.rebuild : undefined;
    let pending = override ? undefined : traceProjects.get(viewer);
    if (!pending) {
      pending = openSimulationTrace(selection, viewer);
      if (!override) traceProjects.set(viewer, pending);
    }
    try {
      let project: Awaited<ReturnType<typeof openSimulationTrace>>;
      for (;;) {
        try {
          project = await pending;
        } catch (error) {
          if (
            !rebuild ||
            !("filelist" in selection) ||
            token?.isCancellationRequested
          )
            throw error;
          if (
            !(await simulationFilelistsCurrent(rebuild.inputs)) ||
            !selectionCurrent()
          )
            throw Error(
              "The simulation inputs changed during the trace query.",
            );
          if (traceProjects.get(viewer) === pending) dropTraceProject(viewer);
          const result = await traceWithProject(
            viewer,
            direction,
            fullname,
            options,
            token,
          );
          if (
            !(await simulationFilelistsCurrent(rebuild.inputs)) ||
            !selectionCurrent()
          )
            throw Error(
              "The simulation inputs changed during the trace query.",
            );
          result.trace.simulationProject = {
            filelist: selection.filelist,
            workingDirectory: selection.workingDirectory,
            vcsRebuild: true,
            limitations: [
              error instanceof Error ? error.message : String(error),
            ],
          };
          return { ...result, buildManifest, simulationInputs: rebuild.inputs };
        }
        if (override) break;
        if (token?.isCancellationRequested)
          throw Error("The RTL trace was cancelled.");
        const current = await simulationFilelistsCurrent(project.inputs);
        const latest = traceProjects.get(viewer);
        if (!latest || !selectionCurrent())
          throw Error(
            "The simulation filelist selection changed during the trace query.",
          );
        if (latest !== pending) {
          pending = latest;
          continue;
        }
        if (
          current &&
          !project.session.closed &&
          ("filelist" in selection
            ? "filelist" in project.projectInfo &&
              project.projectInfo.filelist === selection.filelist &&
              project.projectInfo.workingDirectory ===
                selection.workingDirectory
            : "videManifest" in project.projectInfo &&
              project.projectInfo.videManifest === selection.videManifest) &&
          project.design === viewer.kdb
        )
          break;
        if (rebuild) {
          if (
            !(await simulationFilelistsCurrent(rebuild.inputs)) ||
            !selectionCurrent()
          )
            throw Error(
              "The simulation inputs changed during the trace query.",
            );
          const refreshed = traceProjects.get(viewer);
          if (refreshed !== pending) {
            if (!refreshed)
              throw Error(
                "The simulation filelist selection changed during the trace query.",
              );
            pending = refreshed;
            continue;
          }
        }
        dropTraceProject(viewer);
        pending = openSimulationTrace(selection, viewer);
        traceProjects.set(viewer, pending);
      }
      if (project.design !== viewer.kdb)
        throw Error("The waveform design changed during the trace query.");
      const result = await traceWithProject(
        viewer,
        direction,
        fullname,
        { ...options, includeCompilation: true },
        token,
        project.session,
        buildManifest,
        "unverifiedVcsParameterPaths" in project.projectInfo &&
          Boolean(project.projectInfo.unverifiedVcsParameterPaths?.length),
      );
      if (
        !(await simulationFilelistsCurrent(project.inputs)) ||
        (!override &&
          (traceProjects.get(viewer) !== pending || !selectionCurrent())) ||
        project.design !== viewer.kdb
      )
        throw Error("The simulation inputs changed during the trace query.");
      result.trace.simulationProject = project.projectInfo;
      return { ...result, buildManifest, simulationInputs: project.inputs };
    } catch (error) {
      if (
        !override &&
        !token?.isCancellationRequested &&
        traceProjects.get(viewer) === pending
      )
        dropTraceProject(viewer);
      throw error;
    } finally {
      if (override)
        void pending.then(
          ({ session }) => session.dispose(),
          () => undefined,
        );
    }
  }

  async function createContinuationGuard(
    viewer: Viewer,
    result: Awaited<ReturnType<typeof traceWaveSignal>>,
    live: LiveTraceSession | undefined,
    executionFile?: string,
  ) {
    const backend = viewer.backend;
    const project = traceProjects.get(viewer);
    const selection = JSON.stringify(traceProjectSelection(viewer));
    const mappingIdentity = () => {
      const config = vscode.workspace.getConfiguration(
        "waveWorkbench",
        viewer.uri,
      );
      return JSON.stringify([
        config.get("hierarchyMappings"),
        config.get("sourcePathMappings"),
      ]);
    };
    const mappings = mappingIdentity();
    const inputs = new Map(
      "simulationInputs" in result
        ? result.simulationInputs.map((input) => [input.path, input] as const)
        : [],
    );
    const files = new Set([
      viewer.uri.fsPath,
      result.buildManifest?.filename ?? viewer.uri.fsPath + ".wave-build.json",
      ...(result.trace.compilation?.files
        .filter((uri) => uri.startsWith("file:"))
        .map((uri) => fileURLToPath(uri)) ?? []),
      ...(result.trace.compilation?.libraryMaps
        ?.filter((uri) => uri.startsWith("file:"))
        .map((uri) => fileURLToPath(uri)) ?? []),
      ...(result.buildManifest?.files.map(({ path }) => path) ?? []),
    ]);
    if (executionFile) files.add(executionFile);
    const projectInfo = result.trace.simulationProject;
    if (projectInfo && "videManifest" in projectInfo)
      files.add(projectInfo.videManifest);
    const openEdits = () =>
      JSON.stringify(
        vscode.workspace.textDocuments
          .filter(
            (document) =>
              document.isDirty &&
              document.uri.scheme === "file" &&
              (files.has(document.uri.fsPath) ||
                inputs.has(document.uri.fsPath)),
          )
          .map((document) => [document.uri.fsPath, document.version])
          .sort(),
      );
    const edits = openEdits();
    for (const input of await Promise.all(
      [...files]
        .filter((file) => !inputs.has(file))
        .map(simulationInputFingerprint),
    ))
      inputs.set(input.path, input);
    const fingerprints = [...inputs.values()];
    const current = () =>
      !viewer.disposed &&
      viewer.backend === backend &&
      viewer.kdb === result.design &&
      (!live || live === liveTrace) &&
      project === traceProjects.get(viewer) &&
      selection === JSON.stringify(traceProjectSelection(viewer)) &&
      mappingIdentity() === mappings &&
      openEdits() === edits;
    return async () => {
      if (
        !current() ||
        !(await simulationFilelistsCurrent(fingerprints)) ||
        !current()
      )
        throw new TraceContextChanged(
          "The waveform, RTL or simulation context changed during continuation.",
        );
    };
  }

  async function createStaticWalk(
    viewer: Viewer,
    root: string,
    result: Awaited<ReturnType<typeof traceWaveSignal>>,
    direction: TraceDirection,
    options: TraceOptions,
    override?: TraceProjectSelection,
    assertActive?: () => void,
  ) {
    const guard = await createContinuationGuard(viewer, result, undefined);
    const assertCurrent = async () => {
      assertActive?.();
      await guard();
    };
    const compilationIdentity = (trace: VideTrace) =>
      trace.compilation &&
      JSON.stringify({
        ...trace.compilation,
        files: [...trace.compilation.files].sort(),
      });
    const compilation = compilationIdentity(result.trace);
    const run = (
      limit: number,
      operation: AbortSignal,
      deadline: AbortSignal,
      previous?: StaticWalk["segments"],
    ) =>
      followStaticFrontier(
        root,
        result.trace,
        limit,
        operation,
        deadline,
        async (signal, abort) => {
          const cancellation = new vscode.CancellationTokenSource();
          const cancel = () => cancellation.cancel();
          abort.throwIfAborted();
          abort.addEventListener("abort", cancel, { once: true });
          try {
            const next = await focusWaveTrace(
              viewer,
              await traceWaveSignal(
                viewer,
                direction,
                signal,
                options,
                cancellation.token,
                override,
                result.buildManifest,
              ),
              signal,
              direction,
            );
            // VIDE revisions are scoped to a language server process.
            const sameContext =
              next.analysisProject === result.analysisProject
                ? next.trace.revision === result.trace.revision
                : compilation !== undefined &&
                  compilationIdentity(next.trace) === compilation;
            if (!sameContext)
              throw new TraceContextChanged(
                "The RTL analysis context changed during continuation.",
              );
            return await bindStaticFrontier(viewer, next);
          } finally {
            abort.removeEventListener("abort", cancel);
            cancellation.dispose();
          }
        },
        assertCurrent,
        previous,
      );
    return { run, assertCurrent };
  }

  async function traceWithProject(
    viewer: Viewer,
    direction: TraceDirection,
    fullname: string,
    options: TraceOptions,
    token?: vscode.CancellationToken,
    project?: VideTraceProject,
    buildManifest?: TraceBuildManifest,
    unverifiedVcsParameterPaths = false,
  ) {
    if (token?.isCancellationRequested)
      throw Error("The RTL trace was cancelled.");
    await viewer.ready;
    let signal = await findSignal(viewer.backend, fullname, ".");
    const design = viewer.kdb;
    if (!design) throw Error("Attach a design database to the waveform first.");
    const cfg = vscode.workspace.getConfiguration("waveWorkbench", viewer.uri);
    const sourcePath = (file: string) =>
      path.resolve(
        path.dirname(design.path),
        mapPrefix(file, cfg.get("sourcePathMappings")),
      );
    const mappedScope = mapPrefix(signal.scope, cfg.get("hierarchyMappings"));
    const scope =
      design.kind === "kdb" ? kdbGenerateScope(mappedScope) : mappedScope;
    const name = declaredSignalName(signal.name);
    let resolveFailure: unknown;
    let record = await design.resolve(scope + "." + name).catch((error) => {
      resolveFailure = error;
      return undefined;
    });
    let compound: Location[] | undefined;
    if (!record || record.kind === "npiMpPort" || record.kind === "npiRefObj") {
      if (design.interfaceMembers) {
        const members = await design
          .interfaceMembers(scope, name)
          .catch((error) => {
            resolveFailure ??= error;
            return [];
          });
        if (members.length > 1) compound = members;
        record = members[0] ?? record;
      } else if (design.interfaceMember) {
        const member = await design
          .interfaceMember(scope, name)
          .catch((error) => {
            resolveFailure ??= error;
            return undefined;
          });
        if (member) record = member;
      }
    }
    if (!record && resolveFailure) throw resolveFailure;
    let declarationName = signal.name;
    if (
      record?.instance &&
      record.fullname !== scope + "." + name &&
      record.fullname.startsWith(record.instance + ".")
    )
      declarationName = record.fullname.slice(record.instance.length + 1);
    if (!record?.file || !Number.isInteger(record.line) || record.line < 1) {
      throw Error("No RTL declaration location for " + fullname);
    }
    let aliasDeclaration:
      | VideTrace["assignments"][number]["location"]
      | undefined;
    let alias = record.interfaceRange;
    if (compound) {
      const width = signal.sourceWidth ?? signal.width;
      const source = record.interfaceDeclaration;
      const partsWidth = compound.reduce(
        (sum, member) => sum + (member.interfaceWidth ?? 0),
        0,
      );
      if (
        !source ||
        width !== partsWidth ||
        compound.some(
          (member) =>
            member.instance !== record.instance ||
            !member.fullname.startsWith(member.instance + ".") ||
            !member.interfaceWidth ||
            member.interfaceDeclaration?.file !== source.file ||
            member.interfaceDeclaration.line !== source.line,
        )
      )
        throw Error(
          "The dumped modport alias does not match its elaborated members: " +
            fullname,
        );
      const document = await vscode.workspace.openTextDocument(
        vscode.Uri.file(sourcePath(source.file)),
      );
      const line = source.line - 1;
      if (document.isDirty || line < 0 || line >= document.lineCount)
        throw Error("Could not verify the RTL declaration for " + fullname);
      const code = codeOnly(document.lineAt(line).text);
      const columns = declarationColumns(code, name).filter(
        (column) =>
          code.slice(0, column).trimEnd().endsWith(".") &&
          code
            .slice(column + name.length)
            .trimStart()
            .startsWith("("),
      );
      if (columns.length !== 1)
        throw Error(
          "Could not locate the RTL modport declaration for " + fullname,
        );
      aliasDeclaration = {
        uri: document.uri.toString(),
        range: { start: { line, character: columns[0] } },
      };
      alias = [width - 1, 0];
      const packed = tracePackedSelection(signal).range;
      if (packed && (packed[0] !== alias[0] || packed[1] !== alias[1]))
        throw Error(
          "The dumped range does not match the modport alias: " + fullname,
        );
      signal = { ...signal, packedRange: alias };
    } else if (
      alias &&
      alias[0] === alias[1] &&
      signal.width === 1 &&
      signal.bitOffset === undefined &&
      !tracePackedSelection(signal).range
    ) {
      signal = { ...signal, packedRange: alias };
    }
    const genericTypes = new Map<
      string,
      Promise<TraceOptions["genericInterfaces"]>
    >();
    function genericInterfaces(instance: string) {
      let pending = genericTypes.get(instance);
      if (!pending) {
        pending = readGenericInterfaces(instance);
        genericTypes.set(instance, pending);
      }
      return pending;
    }
    async function readGenericInterfaces(instance: string) {
      const types = await design
        .genericInterfaceTypes?.(instance)
        .catch(() => undefined);
      if (!types?.length) return;
      async function position(file: string, oneBased: number, name: string) {
        const uri = vscode.Uri.file(sourcePath(file));
        const document = await vscode.workspace.openTextDocument(uri).then(
          (document) => document,
          () => undefined,
        );
        const line = oneBased - 1;
        if (
          !document ||
          document.isDirty ||
          line < 0 ||
          line >= document.lineCount
        )
          return;
        const columns = declarationColumns(document.lineAt(line).text, name);
        if (columns.length === 1)
          return {
            textDocument: { uri: uri.toString() },
            position: { line, character: columns[0] },
          };
      }
      const bindings: NonNullable<TraceOptions["genericInterfaces"]> = [];
      for (const type of types) {
        const [formal, actual] = await Promise.all([
          position(type.formalFile, type.formalLine, type.formal),
          position(type.interfaceFile, type.interfaceLine, type.interface),
        ]);
        if (formal && actual)
          bindings.push({ formal, interface: actual, modport: type.modport });
      }
      return bindings.length ? bindings : undefined;
    }
    const file = sourcePath(record.file);
    const document = await vscode.workspace.openTextDocument(
      vscode.Uri.file(file),
    );
    if (project && document.isDirty)
      throw Error(
        "Save the RTL declaration before tracing it against a simulation build.",
      );
    const line = record.line - 1;
    if (line >= document.lineCount)
      throw Error("RTL declaration is outside " + file);
    const columns = declarationColumns(
      document.lineAt(line).text,
      declarationName,
    );
    let character: number | undefined;
    let local: VideTrace | undefined;
    for (const column of columns) {
      const candidate = await traceRtlPosition(
        direction,
        document.uri,
        new vscode.Position(line, column),
        {
          ...options,
          maxDepth: compound ? 0 : options.maxDepth,
          genericInterfaces: await genericInterfaces(record.instance),
        },
        token,
        project,
      ).catch((error) => {
        if (columns.length > 1 && error instanceof UnresolvedTraceSignal)
          return;
        throw error;
      });
      if (
        candidate &&
        (columns.length === 1 ||
          matchesTraceDeclaration(candidate, document.uri, line, column))
      ) {
        local = candidate;
        character = column;
        break;
      }
    }
    if (!local || character === undefined)
      throw Error("Could not locate the RTL declaration for " + fullname);
    let cache = project && portTraceCache.get(project);
    if (project && cache?.revision !== local.revision) {
      cache = { revision: local.revision, traces: new Map() };
      portTraceCache.set(project, cache);
    }
    let reusedPortTrace = false;
    const designMatches = !verilatorArtifactMismatches(
      buildManifest?.verilatorArtifacts,
      design.verilatorArtifacts,
    ).length;
    const sourceUri = (file: string) =>
      vscode.Uri.file(sourcePath(file)).toString();
    const query: TracePortQuery = async (
      port,
      depth,
      queryDirection = direction,
      site,
    ) => {
      if (
        token?.isCancellationRequested ||
        viewer.disposed ||
        design !== viewer.kdb
      ) {
        throw Error("The waveform trace was cancelled or the design changed.");
      }
      const location =
        site ??
        (await design
          .resolve(port.instance + "." + port.signal)
          .catch((error) => {
            if (!isMissingKdbDeclaration(error)) throw error;
            return undefined;
          }));
      if (
        !location?.file ||
        location.line < 1 ||
        (!("interfacePath" in location) && location.instance !== port.instance)
      )
        return;
      const filename = sourcePath(location.file);
      const doc = await vscode.workspace
        .openTextDocument(vscode.Uri.file(filename))
        .then(
          (document) => document,
          async (error: unknown) => {
            try {
              await fs.promises.stat(filename);
            } catch (failure) {
              if ((failure as NodeJS.ErrnoException).code === "ENOENT") return;
            }
            throw error;
          },
        );
      if (!doc) return;
      if (project && doc.isDirty)
        throw Error(
          "Save the connected RTL declaration before tracing it against a simulation build.",
        );
      const line = location.line - 1;
      if (line >= doc.lineCount) return;
      const text = doc.lineAt(line).text;
      const interfacePath =
        site && "interfacePath" in site ? site.interfacePath : undefined;
      const [formalElement, member] = interfacePath?.split(".") ?? [];
      const element = formalElement?.match(/\[-?\d+\]$/)?.[0];
      const formal = element
        ? formalElement.slice(0, -element.length)
        : formalElement;
      const interfaceMember = element ? element + "." + member : member;
      const columns =
        site && "column" in site
          ? [
              Buffer.from(text)
                .subarray(0, site.column - 1)
                .toString("utf8").length,
            ]
          : declarationColumns(text, formal ?? port.signal);
      const portOptions = {
        ...options,
        maxDepth: depth,
        interfaceMember,
        interfaceBacking: interfaceMember ? port.signal : undefined,
        genericInterfaces: await genericInterfaces(location.instance),
      };
      for (const column of columns) {
        const position = new vscode.Position(line, column);
        const key = JSON.stringify([
          queryDirection,
          doc.uri.toString(),
          doc.version,
          line,
          column,
          portOptions,
        ]);
        let result = cache?.traces.get(key);
        if (result) {
          reusedPortTrace = true;
        } else {
          try {
            result = await traceRtlPosition(
              queryDirection,
              doc.uri,
              position,
              portOptions,
              token,
              project,
            );
          } catch (error) {
            if (
              (interfaceMember || columns.length > 1) &&
              error instanceof UnresolvedTraceSignal
            )
              continue;
            throw error;
          }
          if (cache && result.revision === cache.revision) {
            if (cache.traces.size >= 128) {
              const oldest = cache.traces.keys().next();
              if (!oldest.done) cache.traces.delete(oldest.value);
            }
            cache.traces.set(key, result);
          }
        }
        if (
          result.signals.find(({ id }) => id === result.root)?.name ===
            port.signal &&
          (site ||
            columns.length === 1 ||
            matchesTraceDeclaration(result, doc.uri, line, column))
        )
          return result;
      }
    };
    const instance = compound ? scope : record.instance;
    const initial =
      compound && aliasDeclaration
        ? await seedModportAlias(
            local,
            { instance, signal: name },
            aliasDeclaration,
            compound,
            direction,
            options,
            sourceUri,
            query,
          )
        : local;
    const element = /^(.*)\[\s*(-?\d+)\s*\]$/.exec(name);
    const rootName = initial.signals.find(
      ({ id }) => id === initial.root,
    )?.name;
    const elementIndex =
      element?.[1] === rootName && element ? Number(element[2]) : undefined;
    const trace = await expandInstanceTrace(
      initial,
      instance,
      design,
      direction,
      options,
      sourceUri,
      query,
      design.kind === "kdb" && unverifiedVcsParameterPaths
        ? "unverifiedVcsParameterPath"
        : designMatches,
      elementIndex !== undefined && Number.isSafeInteger(elementIndex)
        ? elementIndex
        : undefined,
    );
    if (reusedPortTrace) {
      const current = await traceRtlPosition(
        direction,
        document.uri,
        new vscode.Position(line, character),
        { maxDepth: 0 },
        token,
        project,
      );
      if (current.revision !== local.revision)
        throw Error("RTL changed during the instance trace.");
    }
    if (
      token?.isCancellationRequested ||
      viewer.disposed ||
      design !== viewer.kdb
    ) {
      throw Error("The waveform design changed during the trace query.");
    }
    return {
      trace,
      instance,
      signal,
      design,
      interfaceRange: alias,
      analysisProject: project,
    };
  }

  function matchesTraceDeclaration(
    trace: VideTrace,
    uri: vscode.Uri,
    line: number,
    character: number,
  ) {
    const declaration = trace.signals.find(
      ({ id }) => id === trace.root,
    )?.declaration;
    return (
      declaration?.uri === uri.toString() &&
      declaration.range.start.line === line &&
      declaration.range.start.character === character
    );
  }

  async function bindTraceObservations(
    viewer: Viewer,
    result: Pick<
      Awaited<ReturnType<typeof traceWaveSignal>>,
      "instance" | "design" | "signal"
    > & {
      trace: Pick<VideTrace, "root" | "signals">;
    },
    selected?: ReadonlySet<number>,
  ) {
    const { trace, instance, design, signal } = result;
    const bindings = new Map([[trace.root, signal]]);
    const byInstance = new Map<string, VideTrace["signals"]>();
    for (const candidate of trace.signals) {
      if (
        candidate.id === trace.root ||
        !candidate.declaration ||
        (selected && !selected.has(candidate.id))
      )
        continue;
      const scope = traceSignalScope(candidate, instance);
      const group = byInstance.get(scope) ?? [];
      group.push(candidate);
      byInstance.set(scope, group);
    }
    const config = vscode.workspace.getConfiguration(
      "waveWorkbench",
      viewer.uri,
    );
    const sourceMappings =
      config.get<Record<string, string>>("sourcePathMappings");
    for (const [instance, candidates] of byInstance) {
      const dump = dumpScope(viewer, instance);
      const alias = design.kind === "kdb" ? fsdbGenerateScope(dump) : dump;
      for (let offset = 0; offset < candidates.length; offset += 64) {
        const batch = candidates.slice(offset, offset + 64);
        const names = [...new Set(batch.map(({ name }) => name))];
        const { matches } = await viewer.backend.request("matchNames", {
          query: dump,
          names,
        });
        const aliasNames =
          alias === dump
            ? []
            : names.filter((name) => !Object.hasOwn(matches, name));
        const aliases = aliasNames.length
          ? (
              await viewer.backend.request("matchNames", {
                query: alias,
                names: aliasNames,
              })
            ).matches
          : undefined;
        for (const candidate of batch) {
          const dumped = Object.hasOwn(matches, candidate.name)
            ? matches[candidate.name]
            : aliases && Object.hasOwn(aliases, candidate.name)
              ? aliases[candidate.name]
              : undefined;
          const exact = dumped?.filter(
            (entry) =>
              entry.supported &&
              (entry.scope === dump || entry.scope === alias),
          );
          if (exact?.length !== 1) continue;
          const object = await design
            .resolve(instance + "." + declaredSignalName(exact[0].name))
            .catch((error) => {
              if (!isMissingKdbDeclaration(error)) throw error;
              return undefined;
            });
          if (
            !object?.file ||
            (object.instance !== instance &&
              !(
                candidate.lexicalScope?.length &&
                object.fullname ===
                  instance + "." + declaredSignalName(exact[0].name) &&
                instance.startsWith(object.instance + ".")
              )) ||
            object.line !== candidate.declaration!.range.start.line + 1
          )
            continue;
          const mapped = path.resolve(
            path.dirname(design.path),
            mapPrefix(object.file, sourceMappings),
          );
          if (vscode.Uri.file(mapped).toString() === candidate.declaration!.uri)
            bindings.set(candidate.id, exact[0]);
        }
      }
    }
    return bindings;
  }

  async function bindStaticFrontier(
    viewer: Viewer,
    result: Awaited<ReturnType<typeof traceWaveSignal>>,
    existingBindings?: ReadonlyMap<number, Signal>,
  ) {
    const { trace, design } = result;
    const selected = new Set(
      trace.frontier
        .filter(({ reason }) => isStaticBudgetStop(reason))
        .map(({ signal }) => signal),
    );
    if (!selected.size) return trace;
    const backend = viewer.backend;
    const bindings =
      existingBindings ??
      (await bindTraceObservations(viewer, result, selected));
    if (viewer.disposed || viewer.backend !== backend || viewer.kdb !== design)
      throw Error("The waveform design changed during the trace query.");
    const frontier = trace.frontier.map((item) => {
      if (!isStaticBudgetStop(item.reason)) return item;
      const binding = bindings.get(item.signal);
      if (!binding?.supported) return { ...item, continuation: null };
      const { bit, projected, range } = tracePackedSelection(binding);
      const base = binding.scope + "." + declaredSignalName(binding.name);
      const projectedBit = projected ? (bit ?? binding.bitOffset) : undefined;
      if (!item.bits?.length) {
        const signal =
          projectedBit === undefined
            ? base
            : base + selectionText(undefined, projectedBit);
        return { ...item, continuation: { signal } };
      }
      const [first, last] = range ?? [binding.width - 1, 0];
      const bits = item.bits.filter((index) =>
        projectedBit === undefined
          ? index >= Math.min(first, last) && index <= Math.max(first, last)
          : index === projectedBit,
      );
      return {
        ...item,
        continuation: bits.length ? { signal: base, bits } : null,
      };
    });
    return { ...trace, frontier };
  }

  async function focusWaveTrace(
    viewer: Viewer,
    result: Awaited<ReturnType<typeof traceWaveSignal>>,
    fullname: string,
    direction: TraceDirection,
  ) {
    const { bit, range, projected } = tracePackedSelection(result.signal);
    const match = /\[\s*(-?\d+)\s*:\s*(-?\d+)\s*\]$/.exec(fullname);
    const alias = result.interfaceRange;
    const matchesAlias =
      range &&
      alias &&
      range[0] === alias[0] &&
      range[1] === alias[1] &&
      Math.abs(alias[0] - alias[1]) + 1 === result.signal.width;
    let selection: number | [number, number] | undefined =
      bit ?? (matchesAlias ? alias : undefined);
    if (match && !projected) {
      const left = Number(match[1]);
      const right = Number(match[2]);
      if (
        !range ||
        Math.abs(range[0] - range[1]) + 1 !== result.signal.width ||
        !Number.isSafeInteger(left) ||
        !Number.isSafeInteger(right) ||
        left < Math.min(...range) ||
        left > Math.max(...range) ||
        right < Math.min(...range) ||
        right > Math.max(...range) ||
        (left - right) * (range[0] - range[1]) < 0
      )
        throw Error(
          "Packed selection does not match the dumped range for " + fullname,
        );
      // An exact declaration suffix is also a canonical name for the whole bus.
      if (left !== range[0] || right !== range[1]) selection = [left, right];
    }
    if (
      selection === undefined &&
      (direction !== "drivers" ||
        projected ||
        result.signal.width !== 1 ||
        !result.trace.assignments.some(({ value }) =>
          hasPackedSelection(value),
        ))
    )
      return result;
    const bindings = await bindTraceObservations(viewer, result);
    if (viewer.disposed || viewer.kdb !== result.design)
      throw Error("The waveform design changed during the trace query.");
    return {
      ...result,
      trace: focusPackedTrace(result.trace, selection, direction, bindings),
    };
  }

  function traceSignedness(trace: VideTrace) {
    const signedness = new Map<number, boolean>();
    for (const { id, signed } of trace.signals)
      if (signed !== undefined) signedness.set(id, signed);
    return signedness;
  }

  async function bindObservedTraceWords(
    viewer: Viewer,
    result: Awaited<ReturnType<typeof traceWaveSignal>>,
    reads: NonNullable<ReturnType<typeof buildTemporalTrace>["wordReads"]>,
    operation?: AbortSignal,
  ) {
    const { trace, design, instance } = result;
    const signals = new Map(trace.signals.map((signal) => [signal.id, signal]));
    const mappings = vscode.workspace
      .getConfiguration("waveWorkbench", viewer.uri)
      .get<Record<string, string>>("sourcePathMappings");
    let id = trace.signals.reduce(
      (max, signal) => Math.max(max, signal.id + 1),
      0,
    );
    const bindings = new Map<number, Signal>();
    const words: ObservedTraceWord[] = [];
    const visited = new Set<string>();
    for (const { signal, index } of reads) {
      operation?.throwIfAborted();
      const key = signal + ":" + index;
      if (visited.has(key)) continue;
      if (visited.size >= 64) break;
      visited.add(key);
      const candidate = signals.get(signal);
      if (!candidate?.declaration || !Number.isSafeInteger(Number(index)))
        continue;
      const scope = candidate.instance ?? instance;
      const name = candidate.name + "[" + index + "]";
      const dump = dumpScope(viewer, scope);
      const found = await findRtlSignals(viewer.backend, dump, name);
      const binding = found.signals.find(
        (entry) =>
          entry.bitOffset === undefined &&
          declaredSignalName(entry.name) === name &&
          (entry.scope === dump ||
            entry.scope === dump + "." + candidate.name ||
            (design.kind === "kdb" && entry.scope === fsdbGenerateScope(dump))),
      );
      if (!binding) continue;
      const location = await design
        .resolve(scope + "." + name)
        .catch((error) => {
          if (!isMissingKdbDeclaration(error)) throw error;
          return undefined;
        });
      if (
        !location?.file ||
        location.instance !== scope ||
        location.line !== candidate.declaration.range.start.line + 1
      )
        continue;
      const source = path.resolve(
        path.dirname(design.path),
        mapPrefix(location.file, mappings),
      );
      if (vscode.Uri.file(source).toString() !== candidate.declaration.uri)
        continue;
      words.push({ id, array: signal, index, name, instance: scope });
      bindings.set(id++, binding);
    }
    return { words, bindings };
  }

  async function readRecordedTraceFields(
    viewer: Viewer,
    trace: VideTrace,
    instance: string,
    graph: ReturnType<typeof buildTemporalTrace>,
    evidence: Awaited<ReturnType<typeof readTraceObservations>>,
    filename: string,
    operation?: AbortSignal,
  ) {
    const reached = new Set(graph.nodes.map(({ signal }) => signal));
    const signals = new Map(trace.signals.map((signal) => [signal.id, signal]));
    // Waveform words and execution log fields use separate ranges of IDs.
    let id =
      trace.signals.reduce((max, signal) => Math.max(max, signal.id + 1), 0) +
      64;
    const requested = new Map<string, RecordedTraceField>();
    function request(signalId: number, field: string) {
      const signal = signals.get(signalId);
      if (!signal?.declaration || requested.size >= 64) return;
      const scope = signal.instance ?? instance;
      const key = signalId + ":" + field;
      if (!requested.has(key))
        requested.set(key, {
          signal: signalId,
          field,
          id: id++,
          instance: scope,
          name: signal.name + "." + field,
        });
    }
    for (const { kind, targets, fieldRead } of trace.assignments) {
      if (
        kind === "continuous" &&
        fieldRead &&
        targets.some((target) => reached.has(target))
      )
        request(fieldRead.signal, fieldRead.field);
    }
    const ports = new Map<number, number[]>();
    for (const { target, source } of packedStructPorts(trace)) {
      const incoming = ports.get(target) ?? [];
      incoming.push(source);
      ports.set(target, incoming);
    }
    for (const { signal, field } of requested.values())
      for (const source of ports.get(signal) ?? []) request(source, field);
    for (const { inputs, port } of trace.assignments)
      if (port?.fromField && inputs.length === 1)
        request(inputs[0].signal, port.fromField);
    for (const { signal, field } of requested.values())
      for (const source of ports.get(signal) ?? []) request(source, field);
    const selected = [...requested.values()];
    if (!selected.length) return { fields: [], observations: [] };
    const recordings = await readExecutionEvidenceBatch(
      filename,
      viewer.uri.fsPath,
      evidence.scale,
      selected.map(({ instance: scope, name, field }) => ({
        instance: scope + "." + name.slice(0, -(field.length + 1)),
        signal: field,
      })),
      viewer.meta.start,
      evidence.tick,
      256,
      operation,
    );
    const fields: RecordedTraceField[] = [];
    const observations: typeof evidence.observations = [];
    const start = BigInt(evidence.historyStart);
    const end = BigInt(evidence.historyEnd);
    for (const [index, recording] of recordings.entries()) {
      if (
        recording.observationCoverage?.status !== "complete" ||
        recording.waveformMatch !== "verified"
      )
        continue;
      const values = recording.events.flatMap(({ kind, tick, value }) =>
        kind === "signal-value-changed" && value !== undefined
          ? [{ tick, value }]
          : [],
      );
      const first = values[0];
      const latest = values.at(-1);
      if (
        !first ||
        !latest ||
        values.some(({ value }) => value.length !== first.value.length)
      )
        continue;
      const field = selected[index];
      const initial = values.findLast(({ tick }) => BigInt(tick) < start);
      const history = values.filter(
        ({ tick }) => BigInt(tick) >= start && BigInt(tick) <= end,
      );
      fields.push(field);
      observations.push({
        signal: field.id,
        waveformSignal: field.instance + "." + field.name,
        value: latest.value,
        width: first.value.length,
        signed: undefined,
        projected: false,
        bit: undefined,
        range: undefined,
        status: "observed",
        initial,
        history,
        historyTruncated: false,
        historyLimitedToTransition: undefined,
        cursorSamples: undefined,
      });
    }
    return { fields, observations };
  }

  async function traceWaveContext(
    viewer: Viewer,
    result: Awaited<ReturnType<typeof traceWaveSignal>>,
    tick: string,
    historyStart?: string,
    verification?: Awaited<ReturnType<typeof verifyTraceBuild>>,
    bindings?: Awaited<ReturnType<typeof bindTraceObservations>>,
    operation?: AbortSignal,
    executionFile?: string,
    expandReachable?: boolean,
    limits?: TemporalLimits,
  ) {
    const { trace } = result;
    bindings ??= await bindTraceObservations(viewer, result);
    const observations = (anchor?: string) =>
      readTraceObservations(
        viewer.backend,
        viewer.meta,
        bindings,
        tick,
        historyStart,
        trace.root,
        traceSignedness(trace),
        operation,
        anchor,
      );
    const context = (
      evidence: Awaited<ReturnType<typeof readTraceObservations>>,
    ) =>
      traceObservedContext(
        viewer,
        result,
        evidence,
        bindings,
        verification,
        operation,
        executionFile,
        undefined,
        expandReachable,
        undefined,
        limits,
      );
    const evidence = await observations();
    const replayAfterHistory =
      historyStart === "auto" &&
      executionFile &&
      result.design instanceof KdbSession &&
      isFsdb(viewer.uri.fsPath) &&
      verification?.status !== "mismatched" &&
      BigInt(evidence.historyEnd) < BigInt(tick);
    if (replayAfterHistory && limits?.changeOrder !== undefined)
      return context(await observations(tick));
    const original = await context(evidence);
    if (replayAfterHistory) {
      const recording = original.execution;
      if (recording?.observationCoverage?.status === "complete") {
        const changes = recording.events.filter(
          ({ kind, tick }) =>
            kind === "signal-value-changed" &&
            BigInt(tick) > BigInt(evidence.historyEnd),
        );
        const latest = changes.findLast(
          ({ tick }, index) => changes[index - 1]?.tick === tick,
        )?.tick;
        if (latest) {
          const centered = await context(await observations(latest));
          if (
            centered.context.temporalTrace?.nodes.some(
              (node) =>
                node.signal === trace.root && node.restoredFromCallbacks,
            )
          )
            return centered;
        }
      }
    }
    const anchor = original.cursorWrite?.tick;
    if (
      historyStart !== "auto" ||
      !anchor ||
      BigInt(anchor) <= BigInt(evidence.historyEnd)
    )
      return original;
    const centered = await context(await observations(anchor));
    return centered.context.temporalTrace?.nodes[0]?.sameValueWrite
      ? centered
      : original;
  }

  async function traceObservedContext(
    viewer: Viewer,
    result: Awaited<ReturnType<typeof traceWaveSignal>>,
    evidence: Awaited<ReturnType<typeof readTraceObservations>>,
    bindings: Awaited<ReturnType<typeof bindTraceObservations>>,
    verification?:
      | Awaited<ReturnType<typeof verifyTraceBuild>>
      | ReturnType<typeof verifyLiveTraceBuild>,
    operation?: AbortSignal,
    executionFile?: string,
    live?: LiveTraceSession,
    expandReachable?: boolean,
    runtimeMismatches?: string[],
    limits?: TemporalLimits,
  ) {
    const { trace, design, instance, signal } = result;
    const mismatched =
      verification?.status === "mismatched" ||
      trace.frontier.some(
        ({ reason }) => reason === "unverifiedVcsParameterPath",
      );
    const readRecording =
      executionFile &&
      (!live ||
        (verification?.status === "matched" && !runtimeMismatches?.length));
    let temporalTrace = mismatched
      ? undefined
      : buildTemporalTrace(
          trace,
          evidence,
          undefined,
          expandReachable,
          undefined,
          limits,
        );
    let words: ObservedTraceWord[] | undefined;
    const initialWordReads = temporalTrace?.wordReads ?? [];
    if (!live && temporalTrace?.wordReads?.length) {
      const extra = await bindObservedTraceWords(
        viewer,
        result,
        temporalTrace.wordReads,
        operation,
      );
      if (extra.words.length) {
        const sampledWords = await readTraceObservations(
          viewer.backend,
          viewer.meta,
          extra.bindings,
          evidence.historyEnd,
          evidence.historyStart,
          undefined,
          undefined,
          operation,
        );
        words = extra.words;
        evidence = {
          ...evidence,
          observations: [
            ...evidence.observations,
            ...sampledWords.observations,
          ],
        };
        temporalTrace = buildTemporalTrace(
          trace,
          evidence,
          undefined,
          expandReachable,
          undefined,
          limits,
          words,
        );
      }
    }
    let fields: RecordedTraceField[] | undefined;
    if (!live && executionFile && temporalTrace) {
      const recorded = await readRecordedTraceFields(
        viewer,
        trace,
        instance,
        temporalTrace,
        evidence,
        executionFile,
        operation,
      );
      if (recorded.fields.length) {
        fields = recorded.fields;
        evidence = {
          ...evidence,
          observations: [...evidence.observations, ...recorded.observations],
        };
        temporalTrace = buildTemporalTrace(
          trace,
          evidence,
          undefined,
          expandReachable,
          undefined,
          limits,
          words,
          fields,
        );
        const priorWords = new Set(
          words?.map(({ array, index }) => array + ":" + index),
        );
        if (
          temporalTrace.wordReads?.some(
            ({ signal, index }) => !priorWords.has(signal + ":" + index),
          )
        ) {
          const extra = await bindObservedTraceWords(
            viewer,
            result,
            [...initialWordReads, ...temporalTrace.wordReads],
            operation,
          );
          if (extra.words.length) {
            const samples = await readTraceObservations(
              viewer.backend,
              viewer.meta,
              extra.bindings,
              evidence.historyEnd,
              evidence.historyStart,
              undefined,
              undefined,
              operation,
            );
            const priorIds = new Set(words?.map(({ id }) => id));
            words = extra.words;
            evidence = {
              ...evidence,
              observations: [
                ...evidence.observations.filter(
                  ({ signal }) => !priorIds.has(signal),
                ),
                ...samples.observations,
              ],
            };
            temporalTrace = buildTemporalTrace(
              trace,
              evidence,
              undefined,
              expandReachable,
              undefined,
              limits,
              words,
              fields,
            );
          }
        }
      }
    }
    const rootIndex = trace.signals.find(
      ({ id }) => id === trace.root,
    )?.selectedElement;
    const rootSignal = declaredSignalName(signal.name);
    const rootWord: ObservedTraceWord | undefined =
      rootIndex === undefined || live || !(design instanceof KdbSession)
        ? undefined
        : {
            id: trace.root,
            array: trace.root,
            index: String(rootIndex),
            name: rootSignal,
            instance,
          };
    const replayWords = rootWord ? [rootWord, ...(words ?? [])] : words;
    const wordChanges = new Map<
      number,
      NonNullable<ReturnType<typeof reconcileRecordedWordHistory>>["changes"]
    >();
    if (!live && executionFile && temporalTrace && replayWords?.length) {
      const observations = new Map(
        evidence.observations.map((item) => [item.signal, item]),
      );
      const recordings = await readExecutionEvidenceBatch(
        executionFile,
        viewer.uri.fsPath,
        evidence.scale,
        replayWords.map(({ instance, name: signal }) => ({ instance, signal })),
        viewer.meta.start,
        evidence.historyEnd,
        256,
        operation,
      );
      for (const [index, recording] of recordings.entries()) {
        const observation = observations.get(replayWords[index].id);
        if (!observation) continue;
        const refined = reconcileRecordedWordHistory(
          observation,
          recording,
          evidence.historyStart,
          evidence.historyEnd,
        );
        if (!refined) continue;
        const cursorSamples = observation.cursorSamples;
        observations.set(observation.signal, {
          ...observation,
          history: refined.history,
          ...(cursorSamples &&
            !cursorSamples.truncated && {
              cursorSamples: {
                ...cursorSamples,
                events: refined.history.filter(
                  ({ tick }) => tick === evidence.tick,
                ),
              },
            }),
        });
        wordChanges.set(observation.signal, refined.changes);
      }
      if (wordChanges.size) {
        evidence = { ...evidence, observations: [...observations.values()] };
        temporalTrace = buildTemporalTrace(
          trace,
          evidence,
          undefined,
          expandReachable,
          undefined,
          limits,
          words,
          fields,
        );
      }
    }
    const sampled = new Set(
      readRecording
        ? evidence.observations.flatMap(({ signal, history }) =>
            history.length ? [signal] : [],
          )
        : [],
    );
    if (readRecording && temporalTrace)
      for (const assignment of trace.assignments)
        for (const input of assignment.inputs)
          if (input.kind === "data" && !input.hierarchical)
            sampled.add(input.signal);
    const selected: {
      id: number;
      instance: string;
      signal: string;
      word?: ObservedTraceWord;
    }[] = [
      { id: trace.root, instance, signal: rootSignal },
      ...trace.signals
        .flatMap((entry) =>
          entry.id !== trace.root && sampled.has(entry.id) && entry.instance
            ? [{ id: entry.id, instance: entry.instance, signal: entry.name }]
            : [],
        )
        .sort((left, right) => left.id - right.id),
      ...(!live
        ? (words ?? []).map((word) => ({
            id: word.id,
            instance: word.instance,
            signal: word.name,
            word,
          }))
        : []),
    ];
    let replayIdentityMismatch = false;
    const [execution, ...upstream] = readRecording
      ? await readExecutionEvidenceBatch(
          executionFile,
          viewer.uri.fsPath,
          evidence.scale,
          selected.map(({ instance, signal }) => ({ instance, signal })),
          evidence.historyStart,
          evidence.tick,
          live ? LIVE_EXECUTION_BUFFER_LIMIT : undefined,
          operation,
        ).catch((error: unknown) => {
          if (!live || !(error instanceof ExecutionRecordingIdentityError))
            throw error;
          replayIdentityMismatch = true;
          return [];
        })
      : [];
    operation?.throwIfAborted();
    if (live && live !== liveTrace)
      throw Error("The live simulation session changed.");
    if (viewer.disposed || viewer.kdb !== design)
      throw Error("The waveform design changed during trace sampling.");
    const replayMatch =
      live && executionFile
        ? {
            status: execution
              ? matchLiveExecution(
                  execution,
                  live.executionWindow(
                    instance,
                    selected[0].signal,
                    evidence.historyStart,
                    evidence.tick,
                    LIVE_EXECUTION_BUFFER_LIMIT,
                  ),
                  true,
                )
              : replayIdentityMismatch
                ? ("recordingIdentityMismatch" as const)
                : runtimeMismatches?.length
                  ? ("runtimeInputsDiffer" as const)
                  : ("buildUnverified" as const),
            upstream: upstream.flatMap((recording, index) => {
              if (
                !recording.coverage.declared &&
                !recording.observationCoverage
              )
                return [];
              const { id, instance, signal } = selected[index + 1];
              return [
                {
                  id,
                  instance,
                  signal,
                  status: matchLiveExecution(
                    recording,
                    live.executionWindow(
                      instance,
                      signal,
                      evidence.historyStart,
                      evidence.tick,
                      LIVE_EXECUTION_BUFFER_LIMIT,
                    ),
                    false,
                  ),
                },
              ];
            }),
          }
        : undefined;
    const dirtySources = new Set(
      vscode.workspace.textDocuments.flatMap((document) =>
        document.uri.scheme === "file" && document.isDirty
          ? [document.uri.fsPath]
          : [],
      ),
    );
    const executionAssignments =
      execution &&
      !mismatched &&
      (!replayMatch || replayMatch.status === "matched")
        ? linkExecutionAssignments(
            trace,
            execution,
            dirtySources,
            trace.root,
            rootWord,
          )
        : undefined;
    const upstreamRecordings = upstream.flatMap((recording, index) => {
      if (
        !recording.coverage.declared &&
        !recording.observationCoverage &&
        !recording.events.some((event) => event.kind === "signal-value-changed")
      )
        return [];
      const target = selected[index + 1];
      const { id, instance, signal } = target;
      if (
        replayMatch &&
        replayMatch.upstream.find((entry) => entry.id === id)?.status !==
          "matched"
      )
        return [];
      return [
        {
          id,
          instance,
          signal,
          word: target.word !== undefined,
          recording,
          assignments: linkExecutionAssignments(
            trace,
            recording,
            dirtySources,
            id,
            target.word,
          ),
        },
      ];
    });
    const waveformEvidence = evidence;
    const recordings = new Map([
      ...(execution ? [[trace.root, execution] as const] : []),
      ...upstreamRecordings.map(
        ({ id, recording }) => [id, recording] as const,
      ),
    ]);
    const canRestoreHistory = live
      ? replayMatch?.status === "matched"
      : isFsdb(viewer.uri.fsPath);
    if (
      canRestoreHistory &&
      temporalTrace &&
      execution &&
      design instanceof KdbSession
    ) {
      const restored = restoreRecordedSignalHistory(
        evidence,
        new Map(
          [...recordings].filter(
            ([id]) => bindings.has(id) && id !== rootWord?.id,
          ),
        ),
      );
      if (restored) {
        evidence = restored;
        temporalTrace = buildTemporalTrace(
          trace,
          evidence,
          undefined,
          expandReachable,
          undefined,
          limits,
          words,
          fields,
        );
      }
    }
    const compare = (
      graph: NonNullable<typeof temporalTrace>,
      samples = evidence,
    ) => {
      const reached = new Map<number, Set<number | undefined>>();
      for (const point of graph.nodes) {
        if (
          point.signal === trace.root ||
          (point.sampleOnly && point.operandEvaluationOrdinal === undefined)
        )
          continue;
        const bits = reached.get(point.signal) ?? new Set<number | undefined>();
        bits.add(point.bit);
        reached.set(point.signal, bits);
      }
      return {
        root:
          execution && executionAssignments
            ? correlateExecutionTransitions(
                trace.root,
                samples,
                graph,
                execution,
                executionAssignments,
                { word: rootWord !== undefined },
              )
            : undefined,
        upstream: upstreamRecordings.flatMap((entry) =>
          [...(reached.get(entry.id) ?? [])].map((bit) => ({
            ...entry,
            bit,
            transitions: correlateExecutionTransitions(
              entry.id,
              samples,
              graph,
              entry.recording,
              entry.assignments,
              { compareCursor: false, bit, word: entry.word },
            ),
          })),
        ),
      };
    };
    const operandHistories = new Map(
      upstreamRecordings.flatMap(({ id, recording, assignments }) => {
        const resolve = recordedOperandHistory(
          recording,
          assignments,
          dirtySources,
        );
        return resolve ? [[id, resolve] as const] : [];
      }),
    );
    const operandHistory: RecordedOperandHistory = (
      id,
      tick,
      ordinal,
      value,
      bit,
    ) => operandHistories.get(id)?.(tick, ordinal, value, bit);
    const cursorWrite =
      execution && executionAssignments && limits?.changeOrder === undefined
        ? recordedCursorWrite(
            trace,
            evidence,
            execution,
            executionAssignments,
            dirtySources,
          )
        : undefined;
    if (
      temporalTrace &&
      cursorWrite &&
      BigInt(cursorWrite.tick) <= BigInt(evidence.historyEnd)
    )
      temporalTrace = buildTemporalTrace(
        trace,
        evidence,
        undefined,
        expandReachable,
        operandHistory,
        limits,
        words,
        fields,
        cursorWrite,
      );
    let comparisons =
      temporalTrace && execution ? compare(temporalTrace) : undefined;
    if (temporalTrace && comparisons && execution) {
      const attributed = new Map() as ReturnType<typeof recordedWriters>;
      const components = new Map() as ReturnType<
        typeof matchRecordedModportComponents
      >;
      const canMatchComponents =
        design instanceof KdbSession &&
        !mismatched &&
        (!live || replayMatch?.status === "matched") &&
        trace.assignments.some(
          ({ overlappingModportWrite }) => overlappingModportWrite,
        );
      const maxPasses = 8;
      for (let pass = 0; ; pass++) {
        operation?.throwIfAborted();
        const writers = recordedWriters(
          temporalTrace,
          comparisons.root ?? [],
          execution.events,
          dirtySources,
          executionAssignments,
          execution.coverage.declared?.start,
          rootWord?.id,
        );
        for (const {
          transitions,
          recording,
          assignments,
        } of comparisons.upstream)
          for (const [key, writer] of recordedWriters(
            temporalTrace,
            transitions,
            recording.events,
            dirtySources,
            assignments,
            recording.coverage.declared?.start,
          ))
            writers.set(key, writer);
        const nextComponents = canMatchComponents
          ? matchRecordedModportComponents(
              trace,
              evidence,
              temporalTrace,
              [
                ...(comparisons.root ?? []),
                ...comparisons.upstream.flatMap(
                  ({ transitions }) => transitions,
                ),
              ],
              recordings,
              dirtySources,
            )
          : undefined;
        if (
          [...writers.keys()].every((key) => attributed.has(key)) &&
          (!nextComponents ||
            [...nextComponents.keys()].every((key) => components.has(key)))
        )
          break;
        if (pass === maxPasses) {
          temporalTrace.coverage.status = "partial";
          temporalTrace.coverage.reasons.push("recordedAttributionBudget");
          break;
        }
        for (const [key, writer] of writers) attributed.set(key, writer);
        for (const [key, component] of nextComponents ?? [])
          components.set(key, component);
        temporalTrace = buildTemporalTrace(
          trace,
          evidence,
          attributed,
          expandReachable,
          operandHistory,
          limits,
          words,
          fields,
          cursorWrite,
          components,
        );
        comparisons = compare(temporalTrace);
      }
      if (evidence !== waveformEvidence) {
        const dumped = compare(temporalTrace, waveformEvidence);
        if (comparisons.root && dumped.root)
          comparisons.root = preserveDumpedTransitionEvidence(
            comparisons.root,
            dumped.root,
          );
        const replayed = new Map(
          comparisons.upstream.map((entry) => [
            entry.id + ":" + (entry.bit ?? "*"),
            entry.transitions,
          ]),
        );
        comparisons.upstream = dumped.upstream.map((entry) => ({
          ...entry,
          transitions: preserveDumpedTransitionEvidence(
            replayed.get(entry.id + ":" + (entry.bit ?? "*")) ?? [],
            entry.transitions,
          ),
        }));
      }
      annotateRecordedValueChanges(temporalTrace, [
        ...(comparisons.root ?? []),
        ...comparisons.upstream.flatMap(({ transitions }) => transitions),
      ]);
    }
    if (!live && executionFile && temporalTrace)
      await attachRecordedTaskTransfers(
        executionFile,
        viewer.uri.fsPath,
        evidence.scale,
        evidence.tick,
        trace,
        temporalTrace,
        dirtySources,
        operation,
      );
    if (temporalTrace && wordChanges.size) {
      for (const node of temporalTrace.nodes) {
        if (node.bit !== undefined || node.sampleOnly || node.executionOnly)
          continue;
        const changes = wordChanges.get(node.signal)?.get(node.tick);
        const sample = changes?.[(node.orderAtTick ?? 1) - 1];
        if (sample) node.valueChangeOrdinal = sample.ordinal;
        if (changes && changes.length > 1) node.recordedWordChanges = changes;
      }
      annotateRecordedValueChanges(temporalTrace, []);
    }
    if (temporalTrace) {
      const observations = new Map(
        evidence.observations.map((item) => [item.signal, item]),
      );
      const dumpedWords = new Set(words?.map(({ id }) => id));
      for (const gap of temporalTrace.gaps) {
        const historyCutoff =
          !live &&
          gap.historyCutoff !== undefined &&
          BigInt(gap.historyCutoff) >= BigInt(viewer.meta.start)
            ? gap.historyCutoff
            : undefined;
        if (
          gap.sampleOnly ||
          (historyCutoff === undefined &&
            gap.reason !== "nodeBudget" &&
            gap.reason !== "edgeBudget" &&
            gap.reason !== "staticBudget") ||
          (!bindings.has(gap.signal) && !dumpedWords.has(gap.signal))
        )
          continue;
        const observation = observations.get(gap.signal);
        if (observation?.status !== "observed") continue;
        const binding = bindings.get(gap.signal);
        const path =
          live && binding
            ? binding.scope +
              "." +
              WaveSignal.label({ ...binding, displayName: undefined })
            : observation.waveformSignal;
        const at = {
          tick: historyCutoff ?? gap.tick,
          ...(historyCutoff === undefined
            ? {}
            : { historyStart: "auto" as const }),
          ...(live
            ? { liveSessionId: live.id }
            : gap.orderAtTick === undefined
              ? {}
              : { changeOrder: gap.orderAtTick }),
        };
        if (
          gap.bit === undefined ||
          observation.projected ||
          (observation.width === 1 && !observation.range)
        ) {
          gap.continuation = { signal: path, ...at };
        } else if (
          observation.range &&
          gap.bit >= Math.min(...observation.range) &&
          gap.bit <= Math.max(...observation.range)
        ) {
          gap.continuation = {
            signal: declaredSignalName(path) + "[" + gap.bit + "]",
            ...at,
          };
        }
      }
    }
    const upstreamExecution = comparisons?.upstream
      .filter(({ transitions }) => transitions.length)
      .map(
        ({
          id,
          instance,
          signal,
          bit,
          recording,
          assignments,
          transitions,
        }) => {
          const ordinals = new Set(
            transitions.flatMap(
              ({ callbackOrdinals }) => callbackOrdinals ?? [],
            ),
          );
          const statementEvents = recording.events.filter(
            ({ kind }) => kind === "assignment-entered",
          );
          const writeEvents = reachedWriteEvents(
            recording.events,
            transitions,
            bit,
          );
          return {
            id,
            instance,
            signal,
            bit,
            coverage: recording.coverage,
            ...(recording.observationCoverage
              ? { observationCoverage: recording.observationCoverage }
              : {}),
            assignments,
            transitions,
            ...(ordinals.size
              ? {
                  callbackEvents: recording.events.filter(({ ordinal }) =>
                    ordinals.has(ordinal),
                  ),
                }
              : {}),
            ...(statementEvents.length ? { statementEvents } : {}),
            ...(writeEvents.length ? { writeEvents } : {}),
          };
        },
      );
    const runtimeInputs =
      verification && !mismatched && result.buildManifest
        ? await traceRuntimeInputs(
            result.buildManifest,
            trace,
            live?.runtimeInputs(),
          )
        : [];
    operation?.throwIfAborted();
    if (live && live !== liveTrace)
      throw Error("The live simulation session changed.");
    if (viewer.disposed || viewer.kdb !== design)
      throw Error("The waveform design changed during trace sampling.");
    const changeOrder = limits?.changeOrder;
    const selectedNode =
      changeOrder === undefined ? undefined : temporalTrace?.nodes[0];
    if (changeOrder !== undefined && !selectedNode)
      throw Error(
        "The selected signal change is unavailable at tick " +
          evidence.tick +
          ".",
      );
    const selectedTransition = selectedNode && {
      signal: selectedNode.signal,
      tick: selectedNode.tick,
      value: selectedNode.value,
      orderAtTick: selectedNode.orderAtTick ?? 1,
    };
    const { wholeRoot: _wholeRoot, ...observations } = waveformEvidence;
    return {
      context: {
        ...observations,
        schemaVersion: 1 as const,
        provider: live
          ? { kind: "live" as const, sampling: "endOfSlot" as const }
          : {
              kind: "waveform" as const,
              sampling: viewer.meta.supportsOrderedHistory
                ? ("orderedChanges" as const)
                : ("waveformChanges" as const),
            },
        mode: "observations" as const,
        sourceMatch: verification?.status ?? ("unverified" as const),
        sourceVerification: verification,
        ...(selectedTransition ? { selectedTransition } : {}),
        ...(runtimeInputs.length
          ? {
              runtimeInputs,
              runtimeInputSource: live
                ? ("liveLaunch" as const)
                : ("runManifest" as const),
            }
          : {}),
        ...(runtimeMismatches ? { runtimeMismatches } : {}),
        assignmentCandidates: mismatched
          ? undefined
          : traceAssignmentCandidates(trace, evidence),
        cursorWriters: mismatched
          ? undefined
          : traceCursorWriters(trace, evidence),
        temporalTrace,
        unmapped: trace.signals
          .filter(({ id }) => !bindings.has(id))
          .map(({ id }) => id),
      },
      execution,
      replayMatch,
      executionAssignments,
      executionTransitions: comparisons?.root,
      cursorWrite,
      upstreamExecution,
    };
  }
  function verifyWaveTrace(
    viewer: Viewer,
    result: Awaited<ReturnType<typeof traceWaveSignal>>,
  ) {
    if (!result.buildManifest) return undefined;
    return verifyTraceBuild(
      result.buildManifest,
      viewer.uri.fsPath,
      result.trace.compilation,
      new Map(
        vscode.workspace.textDocuments
          .filter(
            (document) => document.uri.scheme === "file" && document.isDirty,
          )
          .map((document) => [document.uri.fsPath, document.getText()]),
      ),
      result.trace.simulationProject?.limitations,
      result.design.verilatorArtifacts,
    );
  }

  function traceExecutionComparisonReport(
    evidence:
      | Pick<
          Awaited<ReturnType<typeof traceObservedContext>>,
          "executionAssignments" | "executionTransitions" | "upstreamExecution"
        >
      | undefined,
    events: Awaited<ReturnType<typeof readExecutionEvidence>>["events"] = [],
  ) {
    const { executionAssignments, executionTransitions, upstreamExecution } =
      evidence ?? {};
    let report = "";
    if (executionAssignments?.length)
      report += executionAssignmentReport(executionAssignments);
    if (executionTransitions?.length)
      report += executionTransitionReport(executionTransitions);
    for (const { transitions, instance, signal, bit } of upstreamExecution ??
      [])
      report += executionTransitionReport(
        transitions,
        instance + "." + signal + selectionText(undefined, bit),
      );
    const upstreamWrites = mergeExecutionEvents(
      [],
      (upstreamExecution ?? []).map(({ writeEvents }) => writeEvents ?? []),
    );
    if (upstreamWrites.length)
      report +=
        "\n## Upstream write events\n\n" +
        executionEventLines(upstreamWrites).join("\n") +
        "\n";
    if (
      upstreamExecution?.some(
        ({ callbackEvents, statementEvents, writeEvents }) =>
          callbackEvents?.length ||
          statementEvents?.length ||
          writeEvents?.length,
      )
    )
      report +=
        "\n## Root and upstream execution order\n\n" +
        mermaidMarkdown(traceExecutionGraph(events, upstreamExecution)) +
        "\n";
    return report;
  }
  function mergeExecutionEvents(
    selected: Awaited<ReturnType<typeof readExecutionEvidence>>["events"],
    upstream: readonly (typeof selected)[],
  ) {
    const events = new Map(selected.map((event) => [event.ordinal, event]));
    for (const group of upstream)
      for (const event of group)
        if (!events.has(event.ordinal)) events.set(event.ordinal, event);
    return [...events.values()].sort(
      (left, right) => left.ordinal - right.ordinal,
    );
  }
  function traceExecutionGraph(
    selected: Awaited<ReturnType<typeof readExecutionEvidence>>["events"],
    upstream: Awaited<
      ReturnType<typeof traceObservedContext>
    >["upstreamExecution"],
  ) {
    const groups = (upstream ?? []).flatMap(
      ({ callbackEvents, statementEvents, writeEvents }) => [
        callbackEvents ?? [],
        statementEvents ?? [],
        writeEvents ?? [],
      ],
    );
    return executionMermaidPages({
      events: mergeExecutionEvents(selected, groups),
    });
  }
  async function traceLiveContext(
    viewer: Viewer,
    result: Awaited<ReturnType<typeof traceWaveSignal>>,
    live: LiveTraceSession,
    operation: AbortSignal,
    historyStart?: string,
    executionFile?: string,
    expandReachable?: boolean,
    limits?: TemporalLimits,
    tick?: string,
  ) {
    const bindings = await bindTraceObservations(viewer, result);
    const verification = await verifyWaveTrace(viewer, result);
    operation.throwIfAborted();
    if (live !== liveTrace) throw Error("The live simulation session changed.");
    if (viewer.disposed || viewer.kdb !== result.design)
      throw Error("The waveform design changed during live trace sampling.");
    const { trace, instance } = result;
    const paths = new Map(
      trace.signals.map((node) => [
        node.id,
        (node.instance ?? instance) + "." + node.name,
      ]),
    );
    const sampled = live.observations(
      paths,
      historyStart,
      traceSignedness(trace),
      bindings,
      tick,
      trace.root,
    );
    const buildVerification = verifyLiveTraceBuild(
      result.buildManifest,
      verification,
      live.status().harnessSha256,
      sampled.scale,
      viewer.meta.scale,
      result.design.verilatorArtifacts,
      trace.frontier.some(({ reason }) => reason === "mismatchedDesign"),
    );
    const runtimeMismatches = result.buildManifest?.runtime
      ? await live.runtimeDifferences(result.buildManifest.runtime)
      : undefined;
    operation.throwIfAborted();
    if (live !== liveTrace) throw Error("The live simulation session changed.");
    const { events, coverage: executionCoverage } = live.executionWindow(
      instance,
      declaredSignalName(result.signal.name),
      historyStart ?? sampled.historyStart,
      sampled.tick,
    );
    const evidence = await traceObservedContext(
      viewer,
      result,
      sampled,
      bindings,
      buildVerification,
      operation,
      executionFile,
      live,
      expandReachable,
      runtimeMismatches,
      limits,
    );
    return {
      ...evidence,
      context: { ...evidence.context, mode: "live" as const },
      execution: events,
      executionCoverage,
      buildVerification,
    };
  }

  function liveTraceReport(
    evidence: Awaited<ReturnType<typeof traceLiveContext>>,
    trace: VideTrace,
  ) {
    const { context, replayMatch, executionCoverage, execution } = evidence;
    const report = [
      observationReport(context, trace),
      ...(replayMatch
        ? [
            "## Live event replay verification",
            "",
            "- Selected signal · " + replayMatch.status,
            ...replayMatch.upstream.map(
              ({ instance, signal, status }) =>
                "- " + instance + "." + signal + " · " + status,
            ),
            "",
          ]
        : []),
      traceExecutionComparisonReport(evidence, execution),
      "## Live execution coverage",
      "",
      executionCoverage.available
        ? "Recorded events available."
        : "The harness did not declare execution events.",
      "- Missing sequence numbers in the session · " +
        executionCoverage.missingOrdinals,
      "- Events omitted from this response · " +
        executionCoverage.responseOmitted,
      ...(executionCoverage.olderEventsDiscarded
        ? ["- The retained event buffer omits part of the requested window."]
        : []),
      "",
    ];
    if (execution.length)
      report.push(
        "## Live execution events",
        "",
        ...executionEventLines(execution),
        "",
      );
    return "\n" + report.join("\n");
  }

  let traceViewer: Viewer | undefined;
  let liveTraceRecording: string | undefined;
  let traceSelection = 0;
  type TraceContinuationState = {
    root: TemporalContinuation;
    initial: ContinuationTrace;
    walk: ContinuationWalk;
    assertCurrent: () => Promise<void>;
    query: (
      point: TemporalContinuation,
      abort: AbortSignal,
    ) => Promise<ContinuationTrace>;
  };
  type StaticContinuationState = Awaited<
    ReturnType<typeof createStaticWalk>
  > & {
    kind: "static";
    root: string;
    initial: VideTrace;
    direction: TraceDirection;
    walk: StaticWalk;
  };
  type ExplorerContinuation = (
    | (TraceContinuationState & {
        kind: "temporal";
        combined: ReturnType<typeof mergeTemporalContinuationGraph>;
      })
    | (StaticContinuationState & {
        combined: ReturnType<typeof mergeStaticContinuationGraph>;
      })
  ) & {
    report: string;
    running?: AbortController;
  };
  let traceContinuation: ExplorerContinuation | undefined;
  let traceContext:
    | {
        viewer: Viewer;
        result: Awaited<ReturnType<typeof traceWaveSignal>>;
        bindings: Awaited<ReturnType<typeof bindTraceObservations>>;
        backend: Viewer["backend"];
        tick: string;
        executionFile?: string;
        refresh?: AbortController;
      }
    | undefined;
  type SchematicEvidence = Pick<
    Awaited<ReturnType<typeof traceWaveContext>>["context"],
    | "observations"
    | "temporalTrace"
    | "runtimeInputs"
    | "runtimeInputSource"
    | "tick"
    | "scale"
    | "provider"
  >;
  type StoredTrace = {
    trace: VideTrace;
    direction: TraceDirection;
    evidence?: SchematicEvidence;
    combined?: ReturnType<typeof mergeTemporalContinuationGraph>;
    combinedStatic?: ReturnType<typeof mergeStaticContinuationGraph>;
    waveform?: string;
    fullname?: string;
  };
  const traceStorageKey = "rtlTrace.lastResult.v1";
  let traceSnapshot:
    | (StoredTrace & {
        wave?: {
          viewer: Viewer;
          fullname: string;
          backend: Viewer["backend"];
          result: Awaited<ReturnType<typeof traceWaveSignal>>;
        };
      })
    | undefined;
  let traceCursorTimer: ReturnType<typeof setTimeout> | undefined;

  function clearTraceContinuation(provider?: "live") {
    if (
      !provider ||
      (traceContinuation?.kind === "temporal" &&
        traceContinuation.root.liveSessionId)
    ) {
      traceContinuation?.running?.abort();
      traceContinuation = undefined;
    }
    if (
      traceSnapshot &&
      (!provider || traceSnapshot.combined?.provider.kind === provider)
    )
      traceSnapshot = {
        ...traceSnapshot,
        combined: undefined,
        combinedStatic: undefined,
      };
    traceExplorer.clearCombined(provider);
  }

  function resetTraceContext() {
    clearTimeout(traceCursorTimer);
    traceContext?.refresh?.abort();
    traceContext = undefined;
    traceSnapshot = undefined;
    clearTraceContinuation();
    traceExplorer.clear();
    return ++traceSelection;
  }

  function traceSubject(trace: VideTrace) {
    const root = trace.signals.find(({ id }) => id === trace.root);
    return (
      root &&
      [
        traceSignalScope(root),
        root.name +
          selectionText(trace.bitSelection?.range, trace.bitSelection?.bit),
      ]
        .filter(Boolean)
        .join(".")
    );
  }

  function traceModeLabel(
    direction: TraceDirection,
    tick?: string,
    scale?: string,
    live = false,
  ) {
    if (tick === undefined)
      return direction === "drivers"
        ? "静态 · 驱动（上游）"
        : "静态 · 负载（下游）";
    const source = live ? "在线时间追踪" : "A 游标 · 时间追踪";
    return `${source} @ ${tick} tick${scale ? `（${scale}/tick）` : ""}`;
  }

  function showWaveEvidence(
    trace: VideTrace,
    direction: TraceDirection,
    evidence?: SchematicEvidence,
    combined?: ReturnType<typeof mergeTemporalContinuationGraph>,
    combinedStatic?: ReturnType<typeof mergeStaticContinuationGraph>,
    wave = traceSnapshot?.wave,
    restored?: StoredTrace,
  ) {
    traceSnapshot = {
      trace,
      direction,
      evidence,
      combined,
      combinedStatic,
      waveform: wave?.viewer.uri.fsPath ?? restored?.waveform,
      fullname: wave?.fullname ?? restored?.fullname,
      wave,
    };
    if (!restored) {
      const { wave: _viewer, ...saved } = traceSnapshot;
      void context.workspaceState
        .update(traceStorageKey, saved)
        .then(undefined, (error) =>
          output.appendLine("Cannot save RTL Trace: " + String(error)),
        );
    }
    traceExplorer.show(
      trace,
      direction,
      new Map(
        evidence?.observations.map(({ signal, value, status }) => [
          signal,
          value ?? status,
        ]),
      ),
      evidence?.temporalTrace,
      evidence?.runtimeInputs,
      combined,
      combinedStatic,
      traceContinuation &&
        (combined ?? combinedStatic) === traceContinuation.combined
        ? traceContinuation.walk.remaining.length
        : 0,
    );
    traceExplorer.setMessage(
      [
        traceModeLabel(
          direction,
          evidence?.tick,
          evidence?.scale,
          evidence?.provider.kind === "live",
        ),
        traceSnapshot.fullname ?? traceSubject(trace),
        traceSnapshot.waveform
          ? "波形 " + path.basename(traceSnapshot.waveform)
          : "RTL 源码",
        restored && "已恢复的追踪结果",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  async function resumeTraceBatch() {
    const state = traceContinuation;
    if (!state || state.running || !state.walk.remaining.length) return;
    const running = new AbortController();
    state.running = running;
    const rootSignal = state.kind === "static" ? state.root : state.root.signal;
    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Continuing trace of " + rootSignal,
          cancellable: true,
        },
        async (_progress, token) => {
          const cancel = token.onCancellationRequested(() => running.abort());
          try {
            if (token.isCancellationRequested) running.abort();
            running.signal.throwIfAborted();
            await state.assertCurrent();
            const deadline = AbortSignal.timeout(100_000);
            let next: ExplorerContinuation;
            let appendix: string;
            if (state.kind === "static") {
              const walk = await state.run(
                4,
                running.signal,
                deadline,
                state.walk.segments,
              );
              const combined = mergeStaticContinuationGraph(
                state.initial,
                walk,
              );
              next = { ...state, walk, combined };
              appendix = staticContinuationReport(
                state.direction,
                walk,
                staticContinuationMermaid(state.root, walk),
                mergedStaticMermaid(combined),
              );
            } else {
              const walk = await followTemporalFrontier(
                state.root,
                state.initial.context.temporalTrace,
                4,
                running.signal,
                deadline,
                state.query,
                state.assertCurrent,
                state.walk.segments,
              );
              const combined = mergeTemporalContinuationGraph(
                state.initial,
                walk,
              );
              next = { ...state, walk, combined };
              appendix = continuationReport(
                walk,
                continuationMermaidPages(state.root, walk),
                combined,
              );
            }
            await state.assertCurrent();
            running.signal.throwIfAborted();
            if (traceContinuation !== state) return;
            const document = await vscode.workspace.openTextDocument({
              language: "markdown",
              content: appendContinuationReport(state.report, appendix),
            });
            if (traceContinuation !== state || running.signal.aborted) return;
            await state.assertCurrent();
            if (traceContinuation !== state || running.signal.aborted) return;
            traceContinuation = next.walk.remaining.length ? next : undefined;
            if (next.kind === "static") {
              showWaveEvidence(
                next.initial,
                next.direction,
                undefined,
                undefined,
                next.combined,
              );
            } else {
              if (traceSnapshot)
                traceSnapshot = { ...traceSnapshot, combined: next.combined };
              traceExplorer.updateCombined(
                next.combined,
                next.walk.remaining.length,
              );
            }
            await vscode.window.showTextDocument(document);
          } finally {
            cancel.dispose();
          }
        },
      );
    } catch (error) {
      if (!running.signal.aborted && traceContinuation === state) {
        if (error instanceof TraceContextChanged) {
          traceContinuation = undefined;
          if (state.kind === "static")
            showWaveEvidence(
              state.initial,
              state.direction,
              undefined,
              undefined,
              state.combined,
            );
          else {
            if (traceSnapshot)
              traceSnapshot = { ...traceSnapshot, combined: state.combined };
            traceExplorer.updateCombined(state.combined);
          }
        }
        report(error);
      }
    } finally {
      if (traceContinuation?.running === running)
        traceContinuation.running = undefined;
    }
  }

  function refreshTraceCursor(viewer: Viewer, tick: number) {
    const session = traceContext;
    if (!session || session.viewer !== viewer || session.tick === String(tick))
      return;
    if (
      viewer.kdb !== session.result.design ||
      viewer.backend !== session.backend
    ) {
      resetTraceContext();
      return;
    }
    const requested = String(tick);
    clearTraceContinuation();
    session.tick = requested;
    session.refresh?.abort();
    clearTimeout(traceCursorTimer);
    traceCursorTimer = setTimeout(async () => {
      const current = () =>
        traceContext === session &&
        session.tick === requested &&
        !viewer.disposed &&
        viewer.kdb === session.result.design &&
        viewer.backend === session.backend;
      if (!current()) return;
      const refresh = new AbortController();
      session.refresh = refresh;
      try {
        const evidence = await traceWaveContext(
          viewer,
          session.result,
          requested,
          "auto",
          await verifyWaveTrace(viewer, session.result),
          session.bindings,
          refresh.signal,
          session.executionFile,
        );
        if (current())
          showWaveEvidence(session.result.trace, "drivers", evidence.context);
      } catch (error) {
        if (current() && !refresh.signal.aborted)
          output.appendLine(String(error));
      } finally {
        if (session.refresh === refresh) session.refresh = undefined;
      }
    }, 75);
  }
  const traceExplorer = createTraceExplorer(
    vscode,
    context,
    async (source) => {
      const document = await vscode.workspace.openTextDocument(
        vscode.Uri.parse(source.uri),
      );
      const editor = await vscode.window.showTextDocument(document);
      const position = new vscode.Position(
        source.range.start.line,
        source.range.start.character,
      );
      editor.selection = new vscode.Selection(position, position);
      editor.revealRange(new vscode.Range(position, position));
    },
    async (subject, bit) => {
      const selection = traceSelection;
      const viewer =
        traceViewer ?? (await schematicViewer(traceSnapshot?.waveform));
      const scope = traceSignalScope(subject);
      if (!viewer || viewer.disposed || !scope) return;
      try {
        const name =
          bit === undefined
            ? subject.name
            : declaredSignalName(subject.name) + selectionText(undefined, bit);
        const signal = await findSignal(
          viewer.backend,
          dumpScope(viewer, scope) + "." + name,
          ".",
        );
        const currentTrace = () =>
          selection === traceSelection &&
          (traceViewer === viewer ||
            traceSnapshot?.waveform === viewer.uri.fsPath) &&
          !viewer.disposed;
        if (!currentTrace()) return;
        if (!viewer.panel.visible)
          viewer.panel.reveal(viewer.panel.viewColumn, true);
        await viewer.ui("batchAdd", { signals: [signal] });
      } catch (error) {
        report(error);
      }
    },
    async ({ instance, name }) => {
      await vscode.env.clipboard.writeText(
        instance ? instance + "." + name : name,
      );
    },
    async (subject, direction, point, packedSelection, continuationSignal) => {
      try {
        const { instance, name, declaration } = subject;
        const viewer =
          traceViewer ?? (await schematicViewer(traceSnapshot?.waveform));
        if (continuationSignal && viewer && !viewer.disposed) {
          await showSignalTrace(viewer, continuationSignal, direction);
          return;
        }
        if (point) {
          if (!viewer || viewer.disposed || (!instance && !point.continuation))
            return;
          const selection = point.bit === undefined ? "" : `[${point.bit}]`;
          const fullname =
            point.continuation?.signal ??
            dumpScope(viewer, traceSignalScope(subject)) +
              "." +
              name +
              selection;
          const liveSessionId = point.continuation?.liveSessionId;
          if (liveSessionId && liveTrace?.id !== liveSessionId)
            throw Error("The live simulation session changed.");
          await showSignalTrace(
            viewer,
            fullname,
            liveSessionId ? "live" : "context",
            point.continuation?.tick ?? point.tick,
            liveSessionId ? liveTraceRecording : traceContext?.executionFile,
            point.continuation?.changeOrder,
          );
          return;
        }
        if (viewer && !viewer.disposed && instance) {
          const fullname =
            dumpScope(viewer, traceSignalScope(subject)) +
            "." +
            (packedSelection ? declaredSignalName(name) : name);
          const dumped = await findSignal(viewer.backend, fullname, ".").catch(
            () => undefined,
          );
          if (dumped) {
            await showSignalTrace(
              viewer,
              fullname + (packedSelection ?? ""),
              direction,
            );
            return;
          }
        }
        if (!declaration)
          throw Error("This signal has no RTL declaration location.");
        const request = resetTraceContext();
        const position = declaration.range.start;
        const uri = vscode.Uri.parse(declaration.uri);
        const selection =
          viewer && !viewer.disposed && traceProjectSelection(viewer);
        const project = selection
          ? await openSimulationTrace(selection, viewer)
          : undefined;
        let trace: VideTrace;
        try {
          const source = await vscode.workspace.openTextDocument(uri);
          if (project && source.isDirty)
            throw Error(
              "Save the RTL declaration before tracing it against a simulation filelist.",
            );
          trace = await traceRtlPosition(
            direction,
            uri,
            new vscode.Position(position.line, position.character),
            project && { includeCompilation: true },
            undefined,
            project?.session,
          );
          if (project) trace.simulationProject = project.projectInfo;
        } finally {
          project?.session.dispose();
        }
        if (request !== traceSelection) return;
        traceViewer = undefined;
        showWaveEvidence(trace, direction);
        const document = await vscode.workspace.openTextDocument({
          language: "markdown",
          content: traceReport(trace, direction, name),
        });
        await vscode.window.showTextDocument(document);
      } catch (error) {
        report(error);
      }
    },
    async (tick) => {
      try {
        const viewer =
          traceViewer ?? (await schematicViewer(traceSnapshot?.waveform));
        const time = Number(tick);
        if (!viewer || viewer.disposed) return;
        if (!Number.isSafeInteger(time))
          throw Error(
            "This tick exceeds the waveform viewer's time precision.",
          );
        viewer.panel.reveal(viewer.panel.viewColumn, true);
        await viewer.ui("cursor", { time, reveal: true });
      } catch (error) {
        report(error);
      }
    },
    resumeTraceBatch,
  );

  const restoredTrace =
    context.workspaceState.get<StoredTrace>(traceStorageKey);
  if (restoredTrace?.trace?.schemaVersion === 1) {
    const { trace, direction, evidence, combined, combinedStatic } =
      restoredTrace;
    try {
      showWaveEvidence(
        trace,
        direction,
        evidence,
        combined,
        combinedStatic,
        undefined,
        restoredTrace,
      );
    } catch (error) {
      output.appendLine("Cannot restore RTL Trace: " + String(error));
    }
  }

  async function schematicViewer(filename: string | undefined) {
    if (!filename || !isWaveform(filename) || !fs.existsSync(filename)) return;
    const existing = [...viewers].find(
      (viewer) => !viewer.disposed && viewer.uri.fsPath === filename,
    );
    if (existing) {
      await existing.ready;
      if (!existing.disposed && !existing.openError) return existing;
    }
    return openWaveform(filename);
  }

  async function showExecutionEvidence(
    evidence: Awaited<ReturnType<typeof readExecutionEvidence>>,
    viewer?: Viewer,
    fullname?: string,
  ) {
    resetTraceContext();
    traceViewer = viewer;
    traceExplorer.showReplay(evidence, !!viewer);
    traceExplorer.setMessage(
      [
        `执行记录回放 · ${evidence.start}–${evidence.end} tick（${evidence.scale}/tick）`,
        fullname,
        viewer ? "波形 " + path.basename(viewer.uri.fsPath) : undefined,
      ]
        .filter(Boolean)
        .join("\n"),
    );
    const content =
      executionReport(evidence) +
      "\n" +
      mermaidMarkdown(executionMermaidPages(evidence)) +
      "\n";
    await vscode.window.showTextDocument(
      await vscode.workspace.openTextDocument({
        language: "markdown",
        content,
      }),
    );
  }

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "waveWorkbench.openExecutionRecording",
      async (
        selected?: vscode.Uri,
        recordedSignal?: string,
        recordedTick?: string,
      ) => {
        try {
          const filename =
            selected ??
            (
              await vscode.window.showOpenDialog({
                title: "Open execution recording",
                filters: { "Execution recording": ["jsonl"] },
              })
            )?.[0];
          if (!filename) return;
          const signal =
            recordedSignal ??
            (await vscode.window.showInputBox({
              prompt: "Full recorded signal path",
              placeHolder: "TOP.testbench.dut.result",
              validateInput: (value) =>
                /^.+\.[^.]+$/.test(value.trim())
                  ? undefined
                  : "Enter the instance and signal.",
            }));
          if (!signal?.trim()) return;
          const tick =
            recordedTick ??
            (await vscode.window.showInputBox({
              prompt: "Replay through this tick",
              validateInput: (value) =>
                /^(?:0|[1-9]\d{0,19})$/.test(value.trim())
                  ? undefined
                  : "Enter an integer tick.",
            }));
          if (!tick?.trim()) return;
          const fullname = signal.trim();
          const separator = fullname.lastIndexOf(".");
          if (separator <= 0 || separator === fullname.length - 1)
            throw Error("Enter the recorded instance and signal.");
          await showExecutionEvidence(
            await readExecutionEvidence(
              filename.fsPath,
              undefined,
              undefined,
              fullname.slice(0, separator),
              fullname.slice(separator + 1),
              tick.trim(),
              tick.trim(),
            ),
            undefined,
            fullname,
          );
        } catch (error) {
          report(error);
        }
      },
    ),
  );

  async function queryWaveSchematic(
    viewer: Viewer,
    fullname: string,
    tick: string | undefined,
    direction: TraceDirection,
    token?: vscode.CancellationToken,
  ) {
    await viewer.ready;
    const backend = viewer.backend;
    const raw = await traceWaveSignal(
      viewer,
      direction,
      fullname,
      { maxSignals: 96, maxAssignments: 96 },
      token,
    );
    const result = await focusWaveTrace(viewer, raw, fullname, direction);
    if (
      token?.isCancellationRequested ||
      viewer.disposed ||
      viewer.backend !== backend
    )
      return;
    const model = traceSchematic(result.trace);
    const bindings = await bindTraceObservations(viewer, result);
    if (
      token?.isCancellationRequested ||
      viewer.disposed ||
      viewer.backend !== backend
    )
      return;
    const mapped = new Map(
      model.graph.nodes.flatMap((node) => {
        const signal = bindings.get(model.signalNodes.get(node.id)!);
        return signal?.supported ? [[node.id, signal] as const] : [];
      }),
    );
    for (const node of model.graph.nodes) node.wave = mapped.has(node.id);
    const targets = [...mapped];
    if (
      tick &&
      /^\d+$/.test(tick) &&
      Number.isSafeInteger(Number(tick)) &&
      BigInt(tick) >= BigInt(viewer.meta.start) &&
      BigInt(tick) <= BigInt(viewer.meta.end)
    ) {
      for (let index = 0; index < targets.length; index += 64) {
        const batch = targets.slice(index, index + 64);
        if (
          token?.isCancellationRequested ||
          viewer.disposed ||
          viewer.backend !== backend
        )
          return;
        const values = await readSignalsAt(
          backend,
          batch.map(([, signal]) => signal),
          Number(tick),
        ).catch(() => []);
        batch.forEach(([id], offset) => {
          const value = values[offset];
          const node = model.graph.nodes.find((node) => node.id === id)!;
          if (value !== undefined)
            node.detail = [node.detail, value].filter(Boolean).join(" · ");
        });
      }
    }
    return { ...model, mapped };
  }

  async function showCurrentTraceSchematic(viewer?: Viewer) {
    const snapshot = traceSnapshot;
    if (
      !snapshot ||
      (viewer && snapshot.wave?.viewer && snapshot.wave.viewer !== viewer)
    ) {
      void vscode.window.showInformationMessage(
        "请先在当前波形或 RTL 编辑器中发起追踪。",
      );
      return;
    }
    const { trace, direction, evidence, combinedStatic, wave } = snapshot;
    if (
      wave &&
      (wave.viewer.disposed ||
        wave.viewer.backend !== wave.backend ||
        wave.viewer.kdb !== wave.result.design)
    )
      throw Error("关联的波形或设计数据库已更换，请重新追踪。");
    const temporal =
      snapshot.combined ??
      (evidence?.temporalTrace &&
        mergeTemporalContinuationGraph(
          {
            ...temporalTraceReferences(trace, evidence.temporalTrace),
            context: evidence,
            waveformSignals: temporalWaveformSignals(evidence),
          },
          { segments: [], links: [], remaining: [], stopReasons: [] },
        ));
    const staticTrace = combinedStatic ?? trace;
    const model = temporal
      ? traceTimeSchematic(trace, temporal)
      : traceSchematic(staticTrace);
    const mapped = new Map<string, Signal>();
    if (wave) {
      const bindTrace = temporal ? trace : staticTrace;
      const bindings = await trackTask(
        "读取追踪原理图",
        wave.viewer.uri.fsPath,
        () =>
          bindTraceObservations(
            wave.viewer,
            { ...wave.result, trace: bindTrace },
            new Set(model.signalNodes.values()),
          ),
      );
      if (
        traceSnapshot !== snapshot ||
        wave.viewer.disposed ||
        wave.viewer.backend !== wave.backend ||
        wave.viewer.kdb !== wave.result.design
      )
        return;
      for (const node of model.graph.nodes) {
        const signal = bindings.get(model.signalNodes.get(node.id)!);
        if (signal?.supported) {
          mapped.set(node.id, signal);
          node.wave = true;
        }
      }
    } else if (snapshot.waveform) {
      for (const node of model.graph.nodes)
        node.wave = node.kind === "signal" && !!node.instance;
    }
    const fullname = snapshot.fullname ?? traceSubject(trace);
    const title = [
      evidence
        ? "时间追踪 @ " + evidence.tick
        : direction === "loads"
          ? "追踪下游"
          : "追踪上游",
      fullname,
    ]
      .filter(Boolean)
      .join(" · ");
    openSignalSchematic(
      wave?.viewer,
      title,
      undefined,
      direction,
      { ...model, mapped },
      true,
      undefined,
      snapshot.waveform,
    );
  }

  async function showWaveSchematic(
    viewer: Viewer,
    fullname: string,
    tick?: string,
    direction: TraceDirection = "drivers",
  ) {
    await viewer.ready;
    const backend = viewer.backend;
    const diagram = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "正在读取 RTL 连接",
        cancellable: true,
      },
      (_progress, token) =>
        trackTask("读取信号原理图", viewer.uri.fsPath, () =>
          queryWaveSchematic(viewer, fullname, tick, direction, token),
        ),
    );
    if (!diagram || viewer.disposed || viewer.backend !== backend) return;
    openSignalSchematic(viewer, fullname, tick, direction, diagram);
  }

  type SignalDiagram = NonNullable<
    Awaited<ReturnType<typeof queryWaveSchematic>>
  >;
  type SavedDiagram = {
    graph: SchematicGraph;
    locations: [string, VideTrace["signals"][number]["declaration"]][];
    mapped: [string, Signal][];
  };
  type SavedSignalSchematic = {
    version: 1;
    kind: "signal";
    fullname: string;
    waveform?: string;
    tick?: string;
    direction: TraceDirection;
    snapshot: boolean;
    diagram: SavedDiagram;
  };
  type SavedModuleSchematic = {
    version: 1;
    kind: "module";
    database: string;
    waveform?: string;
    instance: string;
    previous: string[];
    traceProject?: TraceProjectSelection | null;
  };

  function schematicPanelOptions() {
    return {
      enableScripts: true,
      localResourceRoots: ["media", "dist/webview"].map((dir) =>
        vscode.Uri.joinPath(context.extensionUri, dir),
      ),
    };
  }

  function schematicViewColumn(viewer?: Viewer): vscode.ViewColumn {
    const editorGroup = vscode.window.tabGroups.all.find(
      (group) =>
        !group.tabs.some(
          ({ input }) =>
            input instanceof vscode.TabInputCustom &&
            input.viewType === "waveWorkbench.viewer",
        ),
    );
    return (
      editorGroup?.viewColumn ??
      viewer?.panel.viewColumn ??
      vscode.ViewColumn.Active
    );
  }

  function openSignalSchematic(
    viewer: Viewer | undefined,
    fullname: string,
    tick: string | undefined,
    direction: TraceDirection,
    initial: SignalDiagram,
    snapshot = false,
    restoredPanel?: vscode.WebviewPanel,
    waveform = viewer?.uri.fsPath,
  ) {
    let backend = viewer?.backend;
    const reconnect = async () => {
      if (viewer && !viewer.disposed && viewer.backend === backend)
        return viewer;
      if (!restoredPanel && viewer) return;
      viewer = await schematicViewer(waveform);
      backend = viewer?.backend;
      return viewer;
    };
    let diagram = initial;
    const media = vscode.Uri.joinPath(context.extensionUri, "media");
    const built = vscode.Uri.joinPath(context.extensionUri, "dist", "webview");
    const panel =
      restoredPanel ??
      vscode.window.createWebviewPanel(
        "waveWorkbench.schematic",
        snapshot ? "RTL 追踪原理图" : "RTL 原理图",
        schematicViewColumn(viewer),
        { enableScripts: true, localResourceRoots: [media, built] },
      );
    panel.webview.options = schematicPanelOptions();
    let busy = false;
    let graphRevision = 0;
    let disposed = false;
    const previous: {
      fullname: string;
      direction: TraceDirection;
      diagram: typeof diagram;
    }[] = [];
    const nonce = randomUUID();
    const { webview } = panel;
    const sendDiagram = () =>
      webview.postMessage({
        type: "schematic",
        title: fullname,
        graph: diagram.graph,
        revision: ++graphRevision,
        canGoBack: previous.length > 0,
        traceSnapshot: snapshot,
        restore: {
          version: 1,
          kind: "signal",
          fullname,
          waveform,
          direction,
          tick,
          snapshot,
          diagram: {
            graph: diagram.graph,
            locations: [...diagram.locations],
            mapped: [...diagram.mapped],
          },
        } satisfies SavedSignalSchematic,
        canOpenModule:
          !snapshot &&
          ((!!restoredPanel && !!waveform) ||
            viewer?.kdb instanceof VerilatorDesign ||
            (viewer?.kdb instanceof KdbSession && !!viewer.kdb.portLinks)),
      });
    const subscription = webview.onDidReceiveMessage(
      async (message: {
        type: string;
        id?: string;
        direction?: string;
        revision?: number;
      }) => {
        try {
          if (message.type === "ready") {
            await sendDiagram();
            return;
          }
          if (message.revision !== graphRevision || busy) return;
          const needsViewer = [
            "moduleView",
            "follow",
            "refresh",
            "wave",
          ].includes(message.type);
          const connected = needsViewer ? await reconnect() : undefined;
          if (disposed || message.revision !== graphRevision || busy) return;
          if (needsViewer && !connected) {
            await webview.postMessage({
              type: "navigationError",
              message: "关联的波形已关闭或更换。",
            });
            return;
          }
          if (!snapshot && viewer && message.type === "moduleView") {
            await showWaveModuleSchematic(viewer, fullname);
            return;
          }
          if (message.type === "back") {
            const entry = previous.pop();
            if (entry) {
              ({ fullname, direction, diagram } = entry);
              await sendDiagram();
            }
            return;
          }
          if (
            !snapshot &&
            viewer &&
            (message.type === "follow" || message.type === "refresh")
          ) {
            const follow = message.type === "follow";
            const signal = message.id
              ? diagram.mapped.get(message.id)
              : undefined;
            if (follow && !signal) return;
            const nextSignal = signal
              ? [
                  signal.scope,
                  WaveSignal.label({ ...signal, displayName: undefined }),
                ]
                  .filter(Boolean)
                  .join(".")
              : fullname;
            const nextDirection = follow
              ? message.direction === "loads"
                ? "loads"
                : "drivers"
              : direction;
            busy = true;
            try {
              const cursor = viewer.rtlCursor?.tick;
              const view =
                cursor === undefined && viewer.panel.visible
                  ? await viewer.ui("snapshot")
                  : undefined;
              const nextTick = cursor ?? view?.cursorA;
              const next = await vscode.window.withProgress(
                {
                  location: vscode.ProgressLocation.Notification,
                  title: "正在读取 RTL 连接",
                  cancellable: true,
                },
                (_progress, token) =>
                  queryWaveSchematic(
                    viewer,
                    nextSignal,
                    nextTick === undefined ? tick : String(nextTick),
                    nextDirection,
                    token,
                  ),
              );
              if (
                !next ||
                disposed ||
                viewer.disposed ||
                viewer.backend !== backend
              ) {
                if (!disposed)
                  await webview.postMessage({
                    type: "navigationError",
                    message: "未更新原理图。",
                  });
                return;
              }
              if (follow) {
                previous.push({ fullname, direction, diagram });
                if (previous.length > 24) previous.shift();
              }
              fullname = nextSignal;
              direction = nextDirection;
              if (nextTick !== undefined) tick = String(nextTick);
              diagram = next;
              await sendDiagram();
            } finally {
              busy = false;
            }
          } else if (message.id && message.type === "source") {
            const location = diagram.locations.get(message.id);
            if (!location) return;
            const document = await vscode.workspace.openTextDocument(
              vscode.Uri.parse(location.uri),
            );
            const position = new vscode.Position(
              location.range.start.line,
              location.range.start.character,
            );
            await vscode.window.showTextDocument(document, {
              viewColumn: vscode.ViewColumn.Active,
              selection: new vscode.Range(position, position),
            });
          } else if (message.id && message.type === "wave" && connected) {
            const signal = diagram.mapped.get(message.id);
            const node = diagram.graph.nodes.find(
              ({ id }) => id === message.id,
            );
            const name = signal
              ? [
                  signal.scope,
                  WaveSignal.label({ ...signal, displayName: undefined }),
                ]
                  .filter(Boolean)
                  .join(".")
              : node?.instance && node.kind === "signal"
                ? dumpScope(connected, node.instance) +
                  (node.signal?.startsWith(node.instance + ".")
                    ? node.signal.slice(node.instance.length)
                    : "." + node.label)
                : undefined;
            if (!name) return;
            const currentSignal =
              signal && !restoredPanel
                ? signal
                : await findSignal(connected.backend, name, ".");
            if (
              disposed ||
              connected.disposed ||
              message.revision !== graphRevision
            )
              return;
            connected.panel.reveal(connected.panel.viewColumn);
            await connected.ui("batchAdd", { signals: [currentSignal] });
          }
        } catch (error) {
          report(error);
          if (!disposed)
            await webview.postMessage({
              type: "navigationError",
              message: error instanceof Error ? error.message : String(error),
            });
        }
      },
    );
    panel.onDidDispose(() => {
      disposed = true;
      subscription.dispose();
    });
    webview.html = schematicHtml(webview, media, built, nonce);
  }

  function schematicHtml(
    webview: vscode.Webview,
    media: vscode.Uri,
    built: vscode.Uri,
    nonce: string,
  ) {
    return fs
      .readFileSync(vscode.Uri.joinPath(media, "schematic.html").fsPath, "utf8")
      .replaceAll("{{nonce}}", nonce)
      .replaceAll("{{csp}}", webview.cspSource)
      .replace(
        "{{css}}",
        webview
          .asWebviewUri(vscode.Uri.joinPath(media, "schematic.css"))
          .toString(),
      )
      .replace(
        "{{script}}",
        webview
          .asWebviewUri(vscode.Uri.joinPath(built, "schematic.js"))
          .toString(),
      );
  }

  async function showWaveModuleSchematic(viewer: Viewer, fullname?: string) {
    await viewer.ready;
    if (viewer.disposed || (!viewer.kdb && !(await viewer.attachKdb()))) return;
    if (viewer.disposed) return;
    const design = viewer.kdb;
    if (!(design instanceof VerilatorDesign || design instanceof KdbSession))
      throw Error("请关联 Verilator JSON 或 VCS KDB。");
    if (!fullname) {
      await showModuleSchematic(design, viewer);
      return;
    }
    const settings = vscode.workspace.getConfiguration(
      "waveWorkbench",
      viewer.uri,
    );
    const record = await design.resolve(
      mapPrefix(fullname, settings.get("hierarchyMappings")),
    );
    if (!record?.instance) throw Error("找不到信号所属的展开实例。");
    if (viewer.kdb === design && !viewer.disposed)
      await showModuleSchematic(design, viewer, record.instance);
  }

  async function openSchematicDesign(file: vscode.Uri) {
    const tree = verilatorTreeFile(file.fsPath);
    let design: VerilatorDesign | KdbSession;
    if (tree) {
      const directory = path.dirname(tree);
      const folder = vscode.workspace.getWorkspaceFolder(file);
      design = await VerilatorDesign.open(
        tree,
        [],
        [
          directory,
          path.dirname(directory),
          ...(folder ? [folder.uri.fsPath] : []),
        ],
      );
    } else {
      const directory = fs.statSync(file.fsPath).isDirectory();
      const kdbNames = ["simv.kdb", "kdb.elab++"];
      if (!directory && !kdbNames.includes(path.basename(file.fsPath)))
        throw Error("请选择 Verilator 展开树、simv.kdb 或 VCS simv.daidir。");
      const folder = directory ? file.fsPath : path.dirname(file.fsPath);
      if (!kdbNames.some((name) => fs.existsSync(path.join(folder, name))))
        throw Error("目录中找不到 VCS KDB。");
      const config = vscode.workspace.getConfiguration("waveWorkbench", file);
      const log = (message: string) => output.append(message);
      const plan = backendPlan(context, config, "design.fsdb", log);
      const open = async (kind: KdbSession) => {
        try {
          await kind.open(file.fsPath);
          return kind;
        } catch (error) {
          kind.dispose();
          throw error;
        }
      };
      try {
        design = await open(plan.createKdb());
      } catch (error) {
        if (plan.kdbKind !== "verdi" || config.get("fsdbBackend") === "verdi")
          throw error;
        log(`Verdi KDB open failed; trying WaveBench Reader: ${error}\n`);
        design = await open(
          backendPlan(
            context,
            config,
            "design.fsdb",
            log,
            "independent",
          ).createKdb(),
        );
      }
    }
    return design;
  }

  async function showModuleSchematic(
    design: VerilatorDesign | KdbSession,
    viewer?: Viewer,
    initialInstance?: string,
    restored?: { panel: vscode.WebviewPanel; state: SavedModuleSchematic },
  ) {
    if (design instanceof KdbSession && !design.portLinks)
      throw Error("该 KDB 后端不支持端口连接查询。");
    if (!initialInstance && design instanceof KdbSession) {
      const roots = await kdbSchematicRoots(design);
      if (!roots.length) throw Error("该 KDB 没有展开的顶层模块。");
      initialInstance =
        roots.length === 1
          ? roots[0].fullname
          : (
              await vscode.window.showQuickPick(
                roots.map((root) => ({
                  label: root.fullname,
                  description: root.module,
                })),
                { placeHolder: "选择 KDB 顶层模块" },
              )
            )?.label;
      if (!initialInstance) return false;
    }
    const waveformPath = viewer?.uri.fsPath ?? restored?.state.waveform;
    let logicProject:
      | Promise<{ session?: VideTraceProject; directory: string }>
      | undefined;
    const openLogicProject = async (kdb: KdbSession) => {
      const selected = viewer
        ? traceProjectSelection(viewer)
        : restored?.state.traceProject;
      const directory = path.dirname(kdb.path);
      if (selected) {
        const project = await openSimulationTrace(selected, viewer, kdb);
        return {
          session: project.session,
          directory: project.projectInfo.workingDirectory,
        };
      }
      if (selected !== null) {
        const manifest =
          waveformPath && (await readAdjacentTraceBuildManifest(waveformPath));
        if (
          manifest &&
          (manifest.roots.length || manifest.library_files?.length)
        )
          return {
            session: await openTraceBuildProject(manifest),
            directory: path.dirname(manifest.filename),
          };
        const rebuild = await discoverVcsRebuild(kdb.path);
        if (rebuild) {
          const project = await openSimulationTrace(rebuild, viewer, kdb);
          return {
            session: project.session,
            directory: rebuild.workingDirectory,
          };
        }
      }
      return { directory };
    };
    const readModule = (instance?: string) =>
      design instanceof VerilatorDesign
        ? design.moduleSchematic(instance)
        : kdbModuleSchematic(design, instance!, async (scope) => {
            if (!scope.definitionFile) throw Error("KDB 缺少模块源码位置");
            if (!logicProject) {
              const pending = openLogicProject(design);
              logicProject = pending;
              void pending.catch(() => {
                if (logicProject === pending) logicProject = undefined;
              });
            }
            const { session, directory } = await logicProject;
            const mappings = vscode.workspace
              .getConfiguration("waveWorkbench", viewer?.uri)
              .get<Record<string, string>>("sourcePathMappings");
            const sourceUri = (file: string) =>
              vscode.Uri.file(
                path.resolve(directory, mapPrefix(file, mappings)),
              );
            const trace = await traceRtlPosition(
              "drivers",
              sourceUri(scope.definitionFile),
              new vscode.Position(0, 0),
              {
                module: scope.module,
                maxAssignments: 2048,
                maxSignals: 2048,
              },
              undefined,
              session,
            );
            if (trace.scope !== "module")
              throw Error("当前 VIDE 版本缺少模块逻辑查询");
            return bindModuleGenerateBranches(
              trace,
              scope.fullname,
              design,
              (file) => sourceUri(file).toString(),
            );
          });
    const closeLogicProject = () => {
      void logicProject?.then(
        ({ session }) => session?.dispose(),
        () => undefined,
      );
    };
    let graph;
    try {
      graph = await trackTask("读取模块原理图", design.path, async () =>
        readModule(initialInstance),
      );
    } catch (error) {
      closeLogicProject();
      throw error;
    }
    if (viewer && (viewer.disposed || viewer.kdb !== design)) {
      closeLogicProject();
      return false;
    }
    const media = vscode.Uri.joinPath(context.extensionUri, "media");
    const built = vscode.Uri.joinPath(context.extensionUri, "dist", "webview");
    const panel =
      restored?.panel ??
      vscode.window.createWebviewPanel(
        "waveWorkbench.moduleSchematic",
        "RTL 模块原理图",
        schematicViewColumn(viewer),
        { enableScripts: true, localResourceRoots: [media, built] },
      );
    panel.webview.options = schematicPanelOptions();
    const { webview } = panel;
    const backend = viewer?.backend;
    const previous = restored?.state.previous ?? [];
    let revision = 0;
    let disposed = false;
    let navigating = false;
    const liveViewer = () =>
      viewer &&
      !viewer.disposed &&
      viewer.kdb === design &&
      viewer.backend === backend
        ? viewer
        : undefined;
    const send = () => {
      for (const node of graph.nodes)
        node.wave =
          !!node.signal && (!!liveViewer() || !!restored?.state.waveform);
      return webview.postMessage({
        type: "schematic",
        title: graph.module!.instance + " · " + graph.module!.name,
        graph,
        revision: ++revision,
        canGoBack: previous.length > 0,
        restore: {
          version: 1,
          kind: "module",
          database: design.path,
          waveform: waveformPath,
          instance: graph.module!.instance,
          previous,
          traceProject: viewer
            ? traceProjectSelection(viewer)
            : restored?.state.traceProject,
        } satisfies SavedModuleSchematic,
      });
    };
    const subscription = webview.onDidReceiveMessage(
      async (message: { type: string; id?: string; revision?: number }) => {
        try {
          if (message.type === "ready") {
            await send();
            return;
          }
          if (message.revision !== revision || navigating) return;
          const node = graph.nodes.find(({ id }) => id === message.id);
          const target =
            message.type === "back"
              ? previous.at(-1)
              : message.type === "parent"
                ? graph.module!.parent
                : message.type === "enter" && node?.kind === "module"
                  ? node.instance
                  : undefined;
          if (target) {
            navigating = true;
            let next;
            try {
              if (viewer && !liveViewer())
                throw Error("关联的设计数据库已关闭或更换。");
              next = await trackTask("读取模块原理图", design.path, async () =>
                readModule(target),
              );
              if (disposed) return;
            } finally {
              navigating = false;
            }
            if (message.type === "back") previous.pop();
            else {
              previous.push(graph.module!.instance);
              if (previous.length > 24) previous.shift();
            }
            graph = next;
            await send();
          } else if (node?.instance && message.type === "source") {
            const fullname = [node.instance, node.signal]
              .filter(Boolean)
              .join(".");
            const location = node.location ?? (await design.resolve(fullname));
            if (!location?.file || location.line < 1)
              throw Error("No source location for " + fullname);
            const cfg = vscode.workspace.getConfiguration(
              "waveWorkbench",
              viewer?.uri,
            );
            const file = path.resolve(
              path.dirname(design.path),
              mapPrefix(location.file, cfg.get("sourcePathMappings")),
            );
            const doc = await vscode.workspace.openTextDocument(
              vscode.Uri.file(file),
            );
            if (location.line > doc.lineCount)
              throw Error(
                "The source line is outside the current document: " + file,
              );
            const position = new vscode.Position(location.line - 1, 0);
            await vscode.window.showTextDocument(doc, {
              viewColumn: vscode.ViewColumn.Active,
              selection: new vscode.Range(position, position),
            });
          } else if (node?.instance && node.signal && message.type === "wave") {
            const waveform =
              liveViewer() ??
              (restored && (await schematicViewer(waveformPath)));
            if (!waveform) throw Error("关联的波形已关闭或更换。");
            const signal = await findSignal(
              waveform.backend,
              dumpScope(waveform, node.instance) + "." + node.signal,
              ".",
            );
            if (waveform.disposed || (!restored && !liveViewer())) return;
            waveform.panel.reveal(waveform.panel.viewColumn);
            await waveform.ui("batchAdd", { signals: [signal] });
          }
        } catch (error) {
          if (!disposed)
            await webview.postMessage({
              type: "navigationError",
              message: error instanceof Error ? error.message : String(error),
            });
        }
      },
    );
    panel.onDidDispose(() => {
      disposed = true;
      subscription.dispose();
      closeLogicProject();
      if (!viewer) design.dispose();
    });
    webview.html = schematicHtml(webview, media, built, randomUUID());
    return true;
  }

  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer("waveWorkbench.schematic", {
      async deserializeWebviewPanel(panel, saved) {
        const state: SavedSignalSchematic | undefined = (
          saved as { panel?: SavedSignalSchematic } | undefined
        )?.panel;
        if (state?.version !== 1 || state.kind !== "signal") {
          panel.webview.html =
            "<p>此原理图没有可恢复的记录，请从波形重新打开。</p>";
          return;
        }
        const { diagram } = state;
        openSignalSchematic(
          undefined,
          state.fullname,
          state.tick,
          state.direction,
          {
            graph: diagram.graph,
            locations: new Map(diagram.locations),
            mapped: new Map(diagram.mapped),
            signalNodes: new Map(),
          },
          state.snapshot,
          panel,
          state.waveform,
        );
      },
    }),
    vscode.window.registerWebviewPanelSerializer(
      "waveWorkbench.moduleSchematic",
      {
        async deserializeWebviewPanel(panel, saved) {
          const state: SavedModuleSchematic | undefined = (
            saved as { panel?: SavedModuleSchematic } | undefined
          )?.panel;
          if (state?.version !== 1 || state.kind !== "module") {
            panel.webview.html =
              "<p>此模块原理图没有可恢复的记录，请从波形重新打开。</p>";
            return;
          }
          let design: VerilatorDesign | KdbSession | undefined;
          try {
            design = await openSchematicDesign(vscode.Uri.file(state.database));
            if (
              !(await showModuleSchematic(design, undefined, state.instance, {
                panel,
                state,
              }))
            )
              design.dispose();
          } catch (error) {
            design?.dispose();
            output.appendLine(
              "Cannot restore module schematic: " + String(error),
            );
            panel.webview.html =
              "<p>未能恢复模块原理图，请检查设计数据库是否仍可访问。</p>";
          }
        },
      },
    ),
  );

  async function showSignalTrace(
    viewer: Viewer,
    fullname: string,
    mode: TraceDirection | "context" | "recordedContext" | "execution" | "live",
    tick?: string,
    executionFile?: string,
    changeOrder?: number,
    followContinuations = false,
    openReport = true,
  ) {
    if (
      (mode === "execution" || mode === "recordedContext") &&
      !executionFile
    ) {
      if (tick === undefined)
        throw Error("Set cursor A before opening execution evidence.");
      const filename = (
        await vscode.window.showOpenDialog({
          title: "Choose the waveform execution recording",
          filters: { "Execution recording": ["jsonl"] },
          defaultUri: vscode.Uri.file(path.dirname(viewer.uri.fsPath)),
        })
      )?.[0];
      if (!filename || viewer.disposed) return;
      executionFile = filename.fsPath;
    }
    if (mode === "execution") {
      await viewer.ready;
      const signal = await findSignal(viewer.backend, fullname, ".");
      const settings = vscode.workspace.getConfiguration(
        "waveWorkbench",
        viewer.uri,
      );
      const instance = mapPrefix(
        signal.scope,
        settings.get("hierarchyMappings"),
      );
      const evidence = await readExecutionEvidence(
        executionFile!,
        viewer.uri.fsPath,
        viewer.meta.scale,
        instance,
        declaredSignalName(signal.name),
        tick,
        tick,
      );
      await showExecutionEvidence(evidence, viewer, fullname);
      return;
    }
    const direction = mode === "loads" ? "loads" : "drivers";
    const live = mode === "live" ? liveTrace : undefined;
    if (mode === "live" && !live)
      throw Error("Start a live simulation harness first.");
    const withContext = mode === "context" || mode === "recordedContext";
    const followStatic =
      followContinuations && (mode === "drivers" || mode === "loads");
    const traceOptions = followContinuations
      ? { maxSignals: 512, maxAssignments: 1024, includeCompilation: true }
      : {};
    const request = resetTraceContext();
    traceExplorer.setMessage(
      [
        "正在追踪 · " +
          traceModeLabel(direction, withContext ? tick : undefined),
        fullname,
        "波形 " + path.basename(viewer.uri.fsPath),
      ].join("\n"),
    );
    const startingCursor = viewer.rtlCursor;
    const content = await Promise.resolve(
      vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Tracing " + fullname,
          cancellable: true,
        },
        async (_progress, token) => {
          let result = await traceWaveSignal(
            viewer,
            direction,
            fullname,
            traceOptions,
            token,
          );
          if (
            !live &&
            !token.isCancellationRequested &&
            (!withContext ||
              followContinuations ||
              result.trace.signals.some((signal) => signal.modportAlias))
          )
            result = await focusWaveTrace(viewer, result, fullname, direction);
          if (
            request !== traceSelection ||
            token.isCancellationRequested ||
            viewer.disposed
          )
            return;
          const backend = viewer.backend;
          const bindings =
            withContext && tick !== undefined
              ? await bindTraceObservations(viewer, result)
              : undefined;
          result = {
            ...result,
            trace: await bindStaticFrontier(viewer, result, bindings),
          };
          const sampling = new AbortController();
          const cancelSampling = token.onCancellationRequested(() =>
            sampling.abort(),
          );
          let evidence:
            | Awaited<ReturnType<typeof traceWaveContext>>
            | undefined;
          let liveEvidence:
            | Awaited<ReturnType<typeof traceLiveContext>>
            | undefined;
          let appendix: string | undefined;
          let combinedTemporal:
            | ReturnType<typeof mergeTemporalContinuationGraph>
            | undefined;
          let combinedStatic:
            | ReturnType<typeof mergeStaticContinuationGraph>
            | undefined;
          let continuation: TraceContinuationState | undefined;
          let staticContinuation: StaticContinuationState | undefined;
          try {
            if (live)
              liveEvidence = await traceLiveContext(
                viewer,
                result,
                live,
                sampling.signal,
                undefined,
                executionFile,
                undefined,
                undefined,
                tick,
              );
            else if (bindings && tick !== undefined)
              evidence = await traceWaveContext(
                viewer,
                result,
                tick,
                "auto",
                await verifyWaveTrace(viewer, result),
                bindings,
                sampling.signal,
                executionFile,
                undefined,
                changeOrder === undefined ? undefined : { changeOrder },
              );
            const context = liveEvidence?.context ?? evidence?.context;
            if (followStatic) {
              const state = await createStaticWalk(
                viewer,
                fullname,
                result,
                direction,
                traceOptions,
                undefined,
                () => {
                  if (request !== traceSelection)
                    throw new TraceContextChanged(
                      "The selected trace changed during continuation.",
                    );
                },
              );
              const walk = await state.run(
                4,
                sampling.signal,
                AbortSignal.timeout(100_000),
              );
              combinedStatic = mergeStaticContinuationGraph(result.trace, walk);
              appendix = staticContinuationReport(
                direction,
                walk,
                staticContinuationMermaid(fullname, walk),
                mergedStaticMermaid(combinedStatic),
              );
              if (
                walk.remaining.length &&
                !walk.stopReasons.includes("contextChanged")
              )
                staticContinuation = {
                  ...state,
                  kind: "static",
                  root: fullname,
                  initial: result.trace,
                  direction,
                  walk,
                };
            }
            if (followContinuations && context && !sampling.signal.aborted) {
              const root = {
                signal: fullname,
                tick: context.tick,
                changeOrder,
                liveSessionId: live?.id,
              };
              const assertCurrent = await createContinuationGuard(
                viewer,
                result,
                live,
                executionFile,
              );
              const query: TraceContinuationState["query"] = async (
                point,
                abort,
              ) => {
                if (request !== traceSelection)
                  throw new TraceContextChanged(
                    "The selected trace changed during continuation.",
                  );
                const cancellation = new vscode.CancellationTokenSource();
                const cancel = () => cancellation.cancel();
                abort.addEventListener("abort", cancel, { once: true });
                try {
                  abort.throwIfAborted();
                  let next = await traceWaveSignal(
                    viewer,
                    "drivers",
                    point.signal,
                    traceOptions,
                    cancellation.token,
                  );
                  abort.throwIfAborted();
                  if (!live)
                    next = await focusWaveTrace(
                      viewer,
                      next,
                      point.signal,
                      "drivers",
                    );
                  const continued = live
                    ? await traceLiveContext(
                        viewer,
                        next,
                        live,
                        abort,
                        undefined,
                        executionFile,
                        undefined,
                        undefined,
                        point.tick,
                      )
                    : await traceWaveContext(
                        viewer,
                        next,
                        point.tick,
                        "auto",
                        await verifyWaveTrace(viewer, next),
                        undefined,
                        abort,
                        executionFile,
                        undefined,
                        { changeOrder: point.changeOrder },
                      );
                  abort.throwIfAborted();
                  return {
                    context: continued.context,
                    waveformSignals: temporalWaveformSignals(continued.context),
                    ...temporalTraceReferences(
                      next.trace,
                      continued.context.temporalTrace,
                    ),
                  };
                } finally {
                  abort.removeEventListener("abort", cancel);
                  cancellation.dispose();
                }
              };
              const walk = await followTemporalFrontier(
                root,
                context.temporalTrace,
                4,
                sampling.signal,
                AbortSignal.timeout(100_000),
                query,
                assertCurrent,
              );
              const initial = {
                context,
                waveformSignals: temporalWaveformSignals(context),
                ...temporalTraceReferences(result.trace, context.temporalTrace),
              };
              combinedTemporal = mergeTemporalContinuationGraph(initial, walk);
              appendix = continuationReport(
                walk,
                continuationMermaidPages(root, walk),
                combinedTemporal,
              );
              if (
                walk.remaining.length &&
                !walk.stopReasons.includes("contextChanged")
              )
                continuation = { root, initial, walk, query, assertCurrent };
            }
          } finally {
            cancelSampling.dispose();
          }
          if (
            request !== traceSelection ||
            (token.isCancellationRequested && (!followStatic || !appendix)) ||
            viewer.disposed ||
            backend !== viewer.backend ||
            (live && live !== liveTrace)
          )
            return;
          if (bindings && tick !== undefined)
            traceContext = {
              viewer,
              result,
              bindings,
              backend,
              tick,
              executionFile,
            };
          traceViewer = viewer;
          liveTraceRecording = live ? executionFile : undefined;
          const baseReport =
            traceReport(result.trace, direction, fullname) +
            (liveEvidence
              ? liveTraceReport(liveEvidence, result.trace)
              : (evidence
                  ? observationReport(evidence.context, result.trace)
                  : "") +
                (evidence?.execution
                  ? executionReport(evidence.execution)
                  : "") +
                traceExecutionComparisonReport(
                  evidence,
                  evidence?.execution?.events,
                ));
          if (continuation && combinedTemporal)
            traceContinuation = {
              ...continuation,
              kind: "temporal",
              combined: combinedTemporal,
              report: baseReport,
            };
          if (staticContinuation && combinedStatic)
            traceContinuation = {
              ...staticContinuation,
              combined: combinedStatic,
              report: baseReport,
            };
          showWaveEvidence(
            result.trace,
            direction,
            liveEvidence?.context ?? evidence?.context,
            combinedTemporal,
            combinedStatic,
            { viewer, backend, result, fullname },
          );
          if (viewer.rtlCursor && viewer.rtlCursor !== startingCursor)
            refreshTraceCursor(viewer, viewer.rtlCursor.tick);
          return appendContinuationReport(baseReport, appendix);
        },
      ),
    ).finally(() => {
      if (request === traceSelection && !traceSnapshot)
        traceExplorer.setMessage(undefined);
    });
    if (content === undefined || request !== traceSelection) return;
    if (!openReport) return;
    const document = await vscode.workspace.openTextDocument({
      language: "markdown",
      content,
    });
    await vscode.window.showTextDocument(document);
  }
  const refreshSidebar = () => sidebar.refresh();
  const provider: vscode.CustomEditorProvider<WaveDocument> = {
    ...createWaveDocuments(
      vscode,
      viewers,
      projectChanges,
      saveProject,
      refreshSidebar,
      dropTraceProject,
    ),
    resolveCustomEditor: createWaveEditor(vscode, context, {
      trackTask,
      viewers,
      projectChanges,
      output,
      refreshSidebar,
      setCurrent(viewer) {
        current = viewer;
      },
      removeCurrent(viewer) {
        if (traceViewer === viewer || traceContext?.viewer === viewer)
          resetTraceContext();
        dropTraceProject(viewer);
        if (current === viewer) current = [...viewers].at(-1);
      },
      scheduleEditorSync,
      refreshTraceCursor,
      rememberFile,
      applyDebugLayout,
      executeTcl,
      openWaveform,
      openRecent,
      selectDecoder,
      editDecoderConfig,
      decoderConfigPath,
      configureWaveDecoder,
      manageWaveDecoders,
      materializeDecoderSignal,
      decodeWindow,
      updateSidebarTags,
      saveActiveProject,
      openProject,
      chooseClipExport,
      runScript,
      openKdbSource,
      showSignalTrace,
      showWaveSchematic,
      showWaveModuleSchematic,
      showCurrentTraceSchematic,
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
  for (const direction of ["drivers", "loads"] as const) {
    const command = direction === "drivers" ? "traceDrivers" : "traceLoads";
    context.subscriptions.push(
      vscode.commands.registerCommand("waveWorkbench." + command, async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor)
          return report(Error("Select an RTL signal in the editor."));
        const request = resetTraceContext();
        try {
          const trace = await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: "Tracing RTL " + direction,
              cancellable: true,
            },
            (_progress, token) =>
              traceRtlPosition(
                direction,
                editor.document.uri,
                editor.selection.active,
                undefined,
                token,
              ),
          );
          const document = await vscode.workspace.openTextDocument({
            language: "markdown",
            content: traceReport(trace, direction),
          });
          if (request !== traceSelection) return;
          traceViewer = undefined;
          showWaveEvidence(trace, direction);
          await vscode.window.showTextDocument(document);
        } catch (error) {
          report(error);
        }
      }),
    );
  }
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "waveWorkbench.openTraceSchematic",
      async () => {
        try {
          await showCurrentTraceSchematic();
        } catch (error) {
          report(error);
        }
      },
    ),
  );
  for (const [command, mode] of [
    ["traceWaveDrivers", "drivers"],
    ["traceWaveLoads", "loads"],
    ["traceWaveAtCursor", "context"],
  ] as const) {
    context.subscriptions.push(
      vscode.commands.registerCommand("waveWorkbench." + command, async () => {
        try {
          const viewer = current;
          if (!viewer || viewer.disposed) {
            void vscode.window.showInformationMessage("请先打开一个波形。");
            return;
          }
          await viewer.ready;
          if (viewer.disposed) return;
          if (!viewer.meta) throw Error("当前波形未加载成功。");
          if (!viewer.panel.visible)
            viewer.panel.reveal(viewer.panel.viewColumn, true);
          const selected: Signal | null = await viewer.ui("activeSignal");
          if (viewer.disposed) return;
          if (!selected || !selected.supported || selected.definition) {
            void vscode.window.showInformationMessage(
              "请先在波形中选中一条 RTL 信号。",
            );
            return;
          }
          const name = WaveSignal.label({
            ...selected,
            displayName: undefined,
          });
          const fullname = [selected.scope, name].filter(Boolean).join(".");
          let tick = viewer.rtlCursor?.tick;
          if (mode === "context" && tick === undefined) {
            const view: WaveState = await viewer.ui("snapshot");
            if (viewer.disposed) return;
            tick = view.cursorA;
          }
          await showSignalTrace(
            viewer,
            fullname,
            mode,
            tick === undefined ? undefined : String(tick),
            undefined,
            undefined,
            false,
            false,
          );
        } catch (error) {
          report(error);
        }
      }),
    );
  }
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
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "waveWorkbench.openModuleSchematic",
      async (selected?: vscode.Uri) => {
        try {
          const viewer = current;
          if (!selected && viewer && !viewer.disposed) {
            await viewer.ready;
            if (!viewer.kdb && isFsdb(viewer.uri.fsPath)) {
              if (!(await viewer.attachKdb()) || viewer.disposed) return;
            }
            if (
              viewer.kdb instanceof VerilatorDesign ||
              viewer.kdb instanceof KdbSession
            ) {
              await showModuleSchematic(viewer.kdb, viewer);
              return;
            }
          }
          let file = selected;
          if (!file) {
            const kind = await vscode.window.showQuickPick(
              ["Verilator JSON", "VCS KDB"],
              { placeHolder: "选择模块原理图的数据来源" },
            );
            if (!kind) return;
            const kdb = kind === "VCS KDB";
            file = (
              await vscode.window.showOpenDialog(
                kdb
                  ? {
                      title: "选择 VCS simv.daidir",
                      canSelectFiles: false,
                      canSelectFolders: true,
                    }
                  : {
                      title: "选择 Verilator 展开树",
                      filters: { "Verilator JSON": ["json"] },
                    },
              )
            )?.[0];
          }
          if (!file) return;
          if (file.scheme !== "file") throw Error("请选择本地设计数据库。");
          const design = await openSchematicDesign(file);
          try {
            if (!(await showModuleSchematic(design))) design.dispose();
          } catch (error) {
            design.dispose();
            throw error;
          }
        } catch (error) {
          report(error);
        }
      },
    ),
  );
  const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  async function startLiveTrace(
    selected?: vscode.Uri,
    vcs?: {
      signals?: readonly string[];
      recording?: vscode.Uri;
      statementScopes?: readonly string[];
    },
    launch?: LiveLaunchOptions,
  ) {
    try {
      const executable =
        selected ??
        (
          await vscode.window.showOpenDialog({
            title: vcs
              ? "Select a VCS simv executable"
              : "Select a live simulation harness",
            canSelectMany: false,
          })
        )?.[0];
      if (!executable) return;
      if (
        executable.scheme !== "file" ||
        (vcs?.recording && vcs.recording.scheme !== "file")
      )
        throw Error("Select a local simulation executable and recording path.");
      let options: Parameters<typeof LiveTraceSession.start>[3];
      if (vcs) {
        const paths = (input: string) =>
          input
            .trim()
            .split(/[\s,]+/)
            .filter(Boolean);
        const signals =
          vcs.signals ??
          (await vscode.window.showInputBox({
            prompt:
              "Enter up to 64 fully qualified VCS signal paths, including the clock for clock stepping",
            placeHolder: "tb.clk, tb.dut.q",
            validateInput: (input) => {
              const signals = paths(input);
              if (
                !signals.length ||
                signals.length > 64 ||
                !signals.every(isVcsLiveSignal)
              )
                return "Enter 1–64 fully qualified signal paths.";
            },
          }));
        if (signals === undefined) return;
        let statementScopes = vcs.statementScopes;
        if (!vcs.signals && !statementScopes) {
          const input = await vscode.window.showInputBox({
            prompt:
              "Module instance paths for assignment entry events. Leave blank for value changes only.",
            placeHolder: "tb.dut",
            validateInput: (value) => {
              const scopes = paths(value);
              if (
                scopes.length > 16 ||
                scopes.some((scope) => !isVcsLiveSignal(scope + ".x"))
              )
                return "Enter up to 16 module instance paths.";
            },
          });
          if (input === undefined) return;
          statementScopes = paths(input);
        }
        options = {
          signals: typeof signals === "string" ? paths(signals) : signals,
          recording: vcs.recording?.fsPath,
          statementScopes,
        };
      }
      if (launch === undefined && selected === undefined) {
        const input = await vscode.window.showInputBox({
          prompt:
            "Simulation launch options in JSON. Leave blank for the default working directory and no arguments.",
          placeHolder:
            '{"workingDirectory":".","plusargs":["+ENABLE"],"stimulusFiles":["stimulus.hex"]}',
          validateInput: (value) => {
            if (!value.trim()) return;
            try {
              parseLiveLaunch(JSON.parse(value));
            } catch (error) {
              return error instanceof Error ? error.message : String(error);
            }
          },
        });
        if (input === undefined) return;
        if (input.trim()) launch = parseLiveLaunch(JSON.parse(input));
      }
      const session = await LiveTraceSession.start(
        executable.fsPath,
        path.dirname(executable.fsPath),
        (message) => output.appendLine(message),
        options,
        launch,
      );
      liveTrace?.dispose();
      liveTrace = session;
      clearTraceContinuation("live");
      const { state, snapshot } = session.status();
      vscode.window.showInformationMessage(
        "Live trace " + state + " at tick " + snapshot?.tick,
      );
    } catch (error) {
      report(error);
    }
  }
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "waveWorkbench.startLiveTrace",
      (selected?: vscode.Uri, launch?: LiveLaunchOptions) =>
        startLiveTrace(selected, undefined, launch),
    ),
    vscode.commands.registerCommand(
      "waveWorkbench.startVcsLiveTrace",
      (
        selected?: vscode.Uri,
        signals?: readonly string[],
        recording?: vscode.Uri,
        statementScopes?: readonly string[],
        launch?: LiveLaunchOptions,
      ) =>
        startLiveTrace(
          selected,
          { signals, recording, statementScopes },
          launch,
        ),
    ),
    vscode.commands.registerCommand(
      "waveWorkbench.traceLiveSignal",
      async (
        selected?: string,
        recording?: vscode.Uri,
        followContinuations = false,
      ) => {
        const session = liveTrace;
        const viewer = current;
        try {
          if (!session) throw Error("Start a live simulation harness first.");
          if (!viewer) throw Error("Open the reference waveform first.");
          const signal =
            selected ??
            (await vscode.window.showQuickPick(
              Object.keys(session.status().snapshot?.values ?? {}),
              { placeHolder: "Choose a sampled live signal" },
            ));
          if (!signal || liveTrace !== session || viewer.disposed) return;
          const { capabilities } = session.status();
          if (
            !selected &&
            (capabilities.statementBreakpoints ||
              capabilities.valueChangeEvents)
          ) {
            const choice = await vscode.window.showQuickPick([
              "Use live samples",
              "Use live samples and an execution recording",
            ]);
            if (!choice) return;
            if (choice === "Use live samples and an execution recording") {
              recording = (
                await vscode.window.showOpenDialog({
                  title: "Choose the corresponding execution recording",
                  filters: { "Execution recording": ["jsonl"] },
                  defaultUri: vscode.Uri.file(path.dirname(viewer.uri.fsPath)),
                })
              )?.[0];
              if (!recording) return;
            }
          }
          if (liveTrace === session && !viewer.disposed)
            await showSignalTrace(
              viewer,
              signal,
              "live",
              undefined,
              recording?.fsPath,
              undefined,
              followContinuations,
            );
        } catch (error) {
          report(error);
        }
      },
    ),
    vscode.commands.registerCommand(
      "waveWorkbench.traceLiveContinuations",
      (selected?: string, recording?: vscode.Uri) =>
        vscode.commands.executeCommand(
          "waveWorkbench.traceLiveSignal",
          selected,
          recording,
          true,
        ),
    ),
    vscode.commands.registerCommand(
      "waveWorkbench.controlLiveTrace",
      async () => {
        const session = liveTrace;
        if (!session)
          return report(Error("Start a live simulation harness first."));
        try {
          const choice = await vscode.window.showQuickPick([
            "Status",
            "Pause",
            "Resume",
            "Step Clock",
            "Set Breakpoint",
            ...(session.status().capabilities.statementBreakpoints
              ? ["Set Statement Breakpoint"]
              : []),
            "Stop",
          ]);
          if (!choice) return;
          if (choice === "Pause") await session.pause();
          if (choice === "Resume") session.resume();
          if (choice === "Step Clock") {
            const clock = await vscode.window.showQuickPick(
              Object.keys(session.status().snapshot?.values ?? {}),
            );
            if (clock) await session.stepClock(clock, 1);
          }
          if (choice === "Set Breakpoint") {
            const signal = await vscode.window.showQuickPick(
              Object.keys(session.status().snapshot?.values ?? {}),
            );
            const value =
              signal &&
              (await vscode.window.showInputBox({
                prompt: "Breakpoint value in binary",
              }));
            if (signal && value) session.setBreakpoint({ signal, value });
          }
          if (choice === "Set Statement Breakpoint") {
            const instance = await vscode.window.showInputBox({
              prompt: "Recorded RTL instance path",
            });
            const statementId =
              instance?.trim() &&
              (await vscode.window.showInputBox({
                prompt: "Recorded statement ID",
              }));
            if (instance?.trim() && statementId?.trim()) {
              const { statementEventKinds: supported, nbaCommitEvents } =
                session.status().capabilities;
              const selected = await vscode.window.showQuickPick(
                (
                  [
                    {
                      label: "Assignment entry",
                      eventKind: "assignment-entered",
                    },
                    {
                      label: "Assignment evaluation",
                      eventKind: "assignment-evaluated",
                    },
                    {
                      label: "Assignment commit",
                      eventKind: "assignment-committed",
                    },
                    {
                      label: "Simulator commit",
                      eventKind: "assignment-committed",
                      timing: "simulator-commit",
                    },
                    {
                      label: "NBA superseded",
                      eventKind: "assignment-superseded",
                    },
                    { label: "Branch taken", eventKind: "branch-taken" },
                  ] as const
                ).filter(
                  (option) =>
                    supported.includes(option.eventKind) &&
                    (!("timing" in option) || nbaCommitEvents),
                ),
              );
              if (!selected) return;
              session.setBreakpoint({
                instance: instance.trim(),
                statementId: statementId.trim(),
                eventKind: selected.eventKind,
                ...("timing" in selected ? { timing: selected.timing } : {}),
              });
            }
          }
          if (choice === "Stop") {
            session.dispose();
            if (liveTrace === session) {
              liveTrace = undefined;
              clearTraceContinuation("live");
            }
            return;
          }
          const document = await vscode.workspace.openTextDocument({
            language: "json",
            content: JSON.stringify(session.status(), null, 2),
          });
          await vscode.window.showTextDocument(document);
        } catch (error) {
          report(error);
        }
      },
    ),
    {
      dispose() {
        liveTrace?.dispose();
      },
    },
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "waveWorkbench.previewVideProject",
      async (selected?: vscode.Uri, directory?: string) => {
        try {
          const viewer = current;
          const filelist =
            selected ??
            (
              await vscode.window.showOpenDialog({
                title: "Select the simulation filelist",
                filters: { Filelists: ["f", "F", "flist"] },
              })
            )?.[0];
          if (!filelist) return;
          const root =
            vscode.workspace.getWorkspaceFolder?.(filelist)?.uri.fsPath ??
            workspace ??
            path.dirname(filelist.fsPath);
          const buildDirectory =
            directory ??
            (await vscode.window.showInputBox({
              prompt: "Simulator working directory for relative filelist paths",
              value: path.dirname(filelist.fsPath),
            }));
          if (!buildDirectory) return;
          if (viewer && !viewer.disposed) await viewer.ready;
          const manifest = await readSimulationTrace(
            {
              filelist: filelist.fsPath,
              workingDirectory: path.resolve(root, buildDirectory),
            },
            viewer?.disposed ? undefined : viewer,
          );
          const document = await vscode.workspace.openTextDocument({
            language: "toml",
            content: previewVideManifest(manifest),
          });
          await vscode.window.showTextDocument(document);
        } catch (error) {
          report(error);
        }
      },
    ),
    vscode.commands.registerCommand(
      "waveWorkbench.useVideProject",
      async (selected?: vscode.Uri, directory?: string) => {
        try {
          const viewer = current;
          if (!viewer || viewer.disposed) throw Error("Open a waveform first.");
          const key = traceProjectKey(viewer);
          async function setSelection(
            selection: TraceProjectSelection | null | undefined,
          ) {
            if (viewer.disposed) return;
            if (viewer.document.projectPath) {
              if (selection === undefined)
                await context.workspaceState.update(key, undefined);
              if (viewer.disposed) return;
              viewer.document.traceProject = selection;
              viewer.document.dirty = true;
              projectChanges.fire({ document: viewer.document });
            } else {
              await context.workspaceState.update(key, selection);
            }
            dropTraceProject(viewer);
            if (traceViewer === viewer || traceContext?.viewer === viewer)
              resetTraceContext();
          }
          if (!selected) {
            const action = await vscode.window.showQuickPick([
              "Choose simulation filelist",
              "Choose existing vide.toml",
              "Use automatic build manifest",
              "Use workspace VIDE project",
            ]);
            if (!action) return;
            if (action === "Use automatic build manifest") {
              await setSelection(undefined);
              return;
            }
            if (action === "Use workspace VIDE project") {
              await setSelection(null);
              return;
            }
            if (action === "Choose existing vide.toml") {
              selected = (
                await vscode.window.showOpenDialog({
                  title: "Select the existing vide.toml",
                  filters: { "VIDE project": ["toml"] },
                })
              )?.[0];
              if (!selected) return;
            }
          }
          if (selected && path.extname(selected.fsPath) === ".toml") {
            if (path.basename(selected.fsPath) !== "vide.toml")
              throw Error("Select a file named vide.toml.");
            await setSelection({ videManifest: selected.fsPath });
            return;
          }
          const filelist =
            selected ??
            (
              await vscode.window.showOpenDialog({
                title: "Select the simulation filelist",
                filters: { Filelists: ["f", "F", "flist"] },
              })
            )?.[0];
          if (!filelist) return;
          const workingDirectory =
            directory ??
            (await vscode.window.showInputBox({
              prompt: "Simulator working directory for relative filelist paths",
              value: path.dirname(filelist.fsPath),
            }));
          if (!workingDirectory || viewer.disposed) return;
          const selection = {
            filelist: filelist.fsPath,
            workingDirectory: path.resolve(
              path.dirname(filelist.fsPath),
              workingDirectory,
            ),
          };
          await setSelection(selection);
          void vscode.window.showInformationMessage(
            "Simulation filelist selected for " +
              path.basename(viewer.uri.fsPath),
          );
        } catch (error) {
          report(error);
        }
      },
    ),
  );
  if (
    workspace &&
    vscode.workspace
      .getConfiguration("waveWorkbench")
      .get<boolean>("mcpEnabled")
  ) {
    try {
      type RetainedContinuation = (
        | (TraceContinuationState & { kind: "temporal" })
        | (StaticContinuationState & { instance: string })
      ) & {
        waveform: string;
        busy?: boolean;
      };
      const retained = new Map<string, RetainedContinuation>();
      const graphs = new Map<string, Record<string, readonly unknown[]>>();
      function saveGraph(
        snapshot:
          | ReturnType<typeof staticGraphSnapshot>
          | ReturnType<typeof temporalGraphSnapshot>,
        mermaid?: string[],
        report?: string,
      ) {
        const sections = {
          ...snapshot.sections,
          ...(mermaid ? { mermaid } : {}),
          ...(report !== undefined
            ? { report: report.match(/[\s\S]{1,32768}/gu) ?? [] }
            : {}),
        };
        if (graphs.size >= 4) graphs.delete(graphs.keys().next().value!);
        const graphCursor = process.pid + "." + randomUUID();
        graphs.set(graphCursor, sections);
        return {
          graphCursor,
          kind: snapshot.kind,
          metadata: snapshot.metadata,
          sections: Object.fromEntries(
            Object.entries(sections).map(([name, items]) => [
              name,
              items.length,
            ]),
          ),
        };
      }
      function pagedStatic(
        graph: ReturnType<typeof mergeStaticContinuationGraph>,
        format: unknown,
        report?: string,
      ) {
        return saveGraph(
          staticGraphSnapshot(graph),
          format === "mermaid" ? mergedStaticMermaid(graph) : undefined,
          report,
        );
      }
      function pagedTemporal(
        graph: ReturnType<typeof mergeTemporalContinuationGraph>,
        format: unknown,
        report?: string,
      ) {
        return saveGraph(
          temporalGraphSnapshot(graph),
          format === "mermaid" ? combinedTemporalMermaid(graph) : undefined,
          report,
        );
      }
      const retain = (state: RetainedContinuation) => {
        if (
          !state.walk.remaining.length ||
          state.walk.stopReasons.includes("contextChanged")
        )
          return undefined;
        if (retained.size >= 4) {
          const replace = [...retained].find(([, entry]) => !entry.busy);
          if (!replace) return undefined;
          retained.delete(replace[0]);
        }
        const cursor = process.pid + "." + randomUUID();
        retained.set(cursor, state);
        return cursor;
      };
      const continuationOutput = (
        root: TemporalContinuation,
        initial: ContinuationTrace,
        walk: ContinuationWalk,
        mermaid: boolean,
        report: boolean,
        includeRoot = false,
      ) => {
        const diagrams =
          report || mermaid ? continuationMermaidPages(root, walk) : [];
        const combined = mergeTemporalContinuationGraph(initial, walk);
        return {
          continuationWalk: walk,
          temporalContinuationGraph: combined,
          ...(mermaid
            ? {
                ...mermaidOutput("continuationMermaid", diagrams),
                ...mermaidOutput(
                  "temporalContinuationMermaid",
                  combinedTemporalMermaid(combined),
                ),
              }
            : {}),
          walkReport: report
            ? continuationReport(
                walk,
                diagrams,
                combined,
                includeRoot ? initial : undefined,
              )
            : undefined,
        };
      };
      const withTask =
        (
          handler: (
            name: string,
            args: Record<string, unknown>,
            operation: AbortSignal,
          ) => Promise<unknown>,
        ) =>
        async (
          name: string,
          args: Record<string, unknown>,
          operation: AbortSignal,
        ) => {
          const labels = {
            wave_open: "打开波形",
            wave_clip: "截取波形",
            wave_export: "导出波形",
            wave_tcl: "执行波形 Tcl",
            wave_schematic: "读取原理图",
            wave_save_project: "保存波形工程",
          };
          if (name === "wave_list") return handler(name, args, operation);
          const filename =
            name === "wave_open"
              ? args.path
              : (args.waveform ?? current?.uri.fsPath);
          return trackTask(
            labels[name] ?? name,
            typeof filename === "string"
              ? path.resolve(workspace, filename)
              : undefined,
            () => handler(name, args, operation),
          );
        };
      context.subscriptions.push(
        serveWaveMcp(
          workspace,
          withTask(
            async function request(name, args, operation): Promise<unknown> {
              const pagedGraph = args.output === "paged";
              if (
                pagedGraph &&
                (args.pageSize !== undefined || args.pageCursor !== undefined)
              )
                throw Error(
                  "Paged graph output uses wave_trace_graph_page for page bounds.",
                );
              if (name === "wave_trace_graph_page") {
                operation.throwIfAborted();
                const graphCursor = String(args.graphCursor);
                const sections = graphs.get(graphCursor);
                if (!sections)
                  throw Error(
                    "This trace graph cursor is unavailable. Start a new trace.",
                  );
                const section = String(args.section);
                if (!Object.hasOwn(sections, section))
                  throw Error(
                    "This section is unavailable in the graph snapshot.",
                  );
                const page = traceGraphPage(
                  sections[section],
                  Number(args.offset ?? 0),
                  Number(args.limit ?? 64),
                );
                return { graphCursor, section, ...page };
              }
              if (name === "wave_trace_resume") {
                const cursor = String(args.continuationCursor);
                const state = retained.get(cursor);
                if (!state)
                  throw Error(
                    "This trace continuation cursor is unavailable. Start a new trace.",
                  );
                if (state.busy)
                  throw Error("This trace continuation is already running.");
                const limit = Number(args.followContinuations ?? 4);
                if (!Number.isInteger(limit) || limit < 1 || limit > 8)
                  throw Error(
                    "followContinuations must be an integer from 1 to 8.",
                  );
                if (
                  (state.kind === "static" && args.output === "temporal") ||
                  (state.kind === "temporal" && args.output === "graph")
                )
                  throw Error(
                    "Use the output mode matching the original trace or select report.",
                  );
                state.busy = true;
                try {
                  await state.assertCurrent();
                  operation.throwIfAborted();
                  const deadline = AbortSignal.timeout(100_000);
                  const reportOnly = args.output === "report";
                  if (state.kind === "static") {
                    const walk = await state.run(
                      limit,
                      operation,
                      deadline,
                      state.walk.segments,
                    );
                    await state.assertCurrent();
                    operation.throwIfAborted();
                    const graph = mergeStaticContinuationGraph(
                      state.initial,
                      walk,
                    );
                    const fullReport = reportOnly || args.detail === "full";
                    const graphMermaid =
                      fullReport || args.format === "mermaid"
                        ? mergedStaticMermaid(graph)
                        : [];
                    const report = fullReport
                      ? appendContinuationReport(
                          traceReport(
                            state.initial,
                            state.direction,
                            state.root,
                          ),
                          staticContinuationReport(
                            state.direction,
                            walk,
                            staticContinuationMermaid(state.root, walk),
                            graphMermaid,
                          ),
                        )
                      : undefined;
                    if (pagedGraph) {
                      const graphSnapshot = saveGraph(
                        staticGraphSnapshot(graph),
                        args.format === "mermaid" ? graphMermaid : undefined,
                        report,
                      );
                      retained.delete(cursor);
                      return {
                        output: "paged",
                        waveform: state.waveform,
                        signal: state.root,
                        instance: state.instance,
                        direction: state.direction,
                        graphSnapshot,
                        continuationCursor: retain({
                          ...state,
                          walk,
                          busy: false,
                        }),
                        continuation: {
                          queried: walk.segments.length,
                          remaining: walk.remaining.length,
                          stopReasons: walk.stopReasons,
                        },
                      };
                    }
                    const diagrams =
                      args.format === "mermaid"
                        ? mermaidOutput(
                            "staticContinuationGraphMermaid",
                            graphMermaid,
                          )
                        : undefined;
                    retained.delete(cursor);
                    return {
                      output: reportOnly ? "report" : "graph",
                      waveform: state.waveform,
                      signal: state.root,
                      instance: state.instance,
                      direction: state.direction,
                      continuationCursor: retain({
                        ...state,
                        walk,
                        busy: false,
                      }),
                      ...(reportOnly
                        ? {
                            staticContinuationCoverage: {
                              status: walk.status,
                              stopReasons: walk.stopReasons,
                              remaining: walk.remaining.length,
                            },
                          }
                        : {
                            staticContinuationGraph: graph,
                            staticContinuationWalk: summarizeStaticWalk(walk),
                          }),
                      ...diagrams,
                      report,
                    };
                  }
                  const walk = await followTemporalFrontier(
                    state.root,
                    state.initial.context.temporalTrace,
                    limit,
                    operation,
                    deadline,
                    state.query,
                    state.assertCurrent,
                    state.walk.segments,
                  );
                  await state.assertCurrent();
                  operation.throwIfAborted();
                  if (pagedGraph) {
                    const graph = mergeTemporalContinuationGraph(
                      state.initial,
                      walk,
                    );
                    const report =
                      args.detail === "full"
                        ? "# Time trace of `" +
                          state.root.signal.replace(/[`\r\n]/g, " ") +
                          "`\n" +
                          continuationReport(
                            walk,
                            continuationMermaidPages(state.root, walk),
                            graph,
                            state.initial,
                          )
                        : undefined;
                    const graphSnapshot = pagedTemporal(
                      graph,
                      args.format,
                      report,
                    );
                    retained.delete(cursor);
                    return {
                      output: "paged",
                      waveform: state.waveform,
                      signal: state.root.signal,
                      tick: state.root.tick,
                      graphSnapshot,
                      continuationCursor: retain({
                        ...state,
                        walk,
                        busy: false,
                      }),
                      continuation: {
                        queried: walk.segments.length,
                        remaining: walk.remaining.length,
                        stopReasons: walk.stopReasons,
                      },
                    };
                  }
                  const { walkReport, ...output } = continuationOutput(
                    state.root,
                    state.initial,
                    walk,
                    args.format === "mermaid",
                    reportOnly || args.detail === "full",
                    true,
                  );
                  retained.delete(cursor);
                  const continuationCursor = retain({
                    ...state,
                    walk,
                    busy: false,
                  });
                  return {
                    output: reportOnly ? "report" : "temporal",
                    waveform: state.waveform,
                    signal: state.root.signal,
                    tick: state.root.tick,
                    continuationCursor,
                    ...(reportOnly
                      ? {
                          temporalCoverage:
                            output.temporalContinuationGraph.coverage,
                          continuationStopReasons: walk.stopReasons,
                        }
                      : output),
                    ...(walkReport
                      ? {
                          report:
                            "# Time trace of `" +
                            state.root.signal.replace(/[`\r\n]/g, " ") +
                            "`\n" +
                            walkReport,
                        }
                      : {}),
                    ...(reportOnly && args.format === "mermaid"
                      ? {
                          continuationMermaid: output.continuationMermaid,
                          continuationMermaidPages:
                            output.continuationMermaidPages,
                          temporalContinuationMermaid:
                            output.temporalContinuationMermaid,
                          temporalContinuationMermaidPages:
                            output.temporalContinuationMermaidPages,
                        }
                      : {}),
                  };
                } catch (error) {
                  if (error instanceof TraceContextChanged)
                    retained.delete(cursor);
                  throw error;
                } finally {
                  state.busy = false;
                }
              }
              if (name === "wave_live_status" || name === "wave_live_control") {
                operation.throwIfAborted();
                const session = liveTrace;
                if (!session)
                  throw Error("Start a live simulation harness first.");
                if (name === "wave_live_status") return session.status();
                if (args.action === "pause") return session.pause();
                if (args.action === "resume") return session.resume();
                if (
                  args.action === "stepClock" &&
                  typeof args.signal === "string"
                )
                  return session.stepClock(
                    args.signal,
                    Number(args.cycles ?? 1),
                    operation,
                  );
                if (
                  args.action === "setBreakpoint" &&
                  typeof args.signal === "string" &&
                  typeof args.value === "string"
                )
                  return session.setBreakpoint({
                    signal: args.signal,
                    value: args.value,
                  });
                if (args.action === "clearBreakpoint")
                  return session.setBreakpoint();
                if (
                  args.action === "setStatementBreakpoint" &&
                  typeof args.instance === "string" &&
                  typeof args.statementId === "string"
                ) {
                  const { eventKind = "assignment-evaluated" } = args;
                  const timing =
                    args.timing === "simulator-commit" ||
                    args.timing === "end-of-slot"
                      ? args.timing
                      : undefined;
                  if (
                    isStatementEventKind(eventKind) &&
                    (args.timing === undefined || timing !== undefined)
                  )
                    return session.setBreakpoint({
                      instance: args.instance,
                      statementId: args.statementId,
                      eventKind,
                      ...(timing === undefined ? {} : { timing }),
                    });
                }
                throw Error("Live action arguments are incomplete.");
              }
              if (name === "wave_list")
                return {
                  selected: current?.uri.fsPath ?? null,
                  views: [...viewers].map((v) => v.uri.fsPath),
                };
              if (name === "wave_open") {
                const filename = path.resolve(workspace, String(args.path));
                if (
                  (!isWaveform(filename) && !/\.waveproj$/i.test(filename)) ||
                  !fs.existsSync(filename)
                )
                  throw Error("Waveform or project not found: " + filename);
                const viewer = /\.waveproj$/i.test(filename)
                  ? await openProject(filename)
                  : await openWaveform(filename);
                if (!viewer?.meta)
                  throw Error(viewer?.openError ?? "Unable to open waveform");
                return {
                  waveform: viewer.uri.fsPath,
                  scale: viewer.meta.scale,
                };
              }
              const viewer = args.waveform
                ? [...viewers].find((v) => v.uri.fsPath === args.waveform)
                : current;
              if (name === "wave_execution_trace") {
                if (args.recordingOnly === true && args.waveform)
                  throw Error(
                    "Recording-only playback cannot also select a waveform.",
                  );
                if (args.waveform && !viewer)
                  throw Error("Open the selected waveform first.");
                const selected =
                  args.recordingOnly === true ? undefined : viewer;
                await selected?.ready;
                const tick = String(args.tick);
                const execution = await readExecutionEvidence(
                  path.resolve(workspace, String(args.executionLog)),
                  selected?.uri.fsPath,
                  selected?.meta.scale,
                  String(args.instance),
                  String(args.signal),
                  String(args.historyStart ?? tick),
                  tick,
                  undefined,
                  operation,
                );
                return {
                  ...execution,
                  ...(args.format === "mermaid"
                    ? mermaidOutput("mermaid", executionMermaidPages(execution))
                    : {}),
                  ...(args.detail === "full"
                    ? { report: executionReport(execution) }
                    : {}),
                };
              }
              if (!viewer) throw Error("Open a waveform first");
              if (name === "wave_schematic") {
                const cancel = new vscode.CancellationTokenSource();
                const abort = () => cancel.cancel();
                operation.addEventListener("abort", abort, { once: true });
                if (operation.aborted) abort();
                try {
                  const model = await queryWaveSchematic(
                    viewer,
                    String(args.signal),
                    typeof args.tick === "string" ? args.tick : undefined,
                    args.direction === "loads" ? "loads" : "drivers",
                    cancel.token,
                  );
                  operation.throwIfAborted();
                  if (!model)
                    throw Error(
                      "The waveform changed during the schematic query.",
                    );
                  return {
                    ...model.graph,
                    nodes: model.graph.nodes.map((node) => ({
                      ...node,
                      location: model.locations.get(node.id),
                      signal: model.mapped.get(node.id),
                    })),
                  };
                } finally {
                  operation.removeEventListener("abort", abort);
                  cancel.dispose();
                }
              }
              if (name === "wave_decoder_list") {
                const { definitions, warnings } =
                  await listWaveDecoders(viewer);
                return {
                  decoders: [...definitions.values()].map(
                    ({ manifest }) => manifest,
                  ),
                  warnings,
                };
              }
              if (name === "wave_decoder_query") {
                return decodeWindow(
                  viewer,
                  {
                    decoderId: String(args.decoderId),
                    bindings: args.bindings as DecoderInstance["bindings"],
                    options: args.options as DecoderInstance["options"],
                  },
                  String(args.start),
                  String(args.end),
                  operation,
                );
              }
              if (name === "wave_decoder_attach") {
                const { definitions } = await listWaveDecoders(viewer);
                const definition = definitions.get(String(args.decoderId));
                if (!definition)
                  throw Error(
                    "Decoder not found or disabled: " + args.decoderId,
                  );
                const instance = {
                  instanceId: randomUUID(),
                  decoderId: definition.manifest.id,
                  engine: definition.manifest.engine,
                  bindings: args.bindings as DecoderInstance["bindings"],
                  options: args.options as DecoderInstance["options"],
                };
                await viewer.ui("decoderAttach", instance);
                return instance;
              }
              if (
                name === "wave_decoder_detach" ||
                name === "wave_decoder_reload" ||
                name === "wave_decoder_status"
              ) {
                await viewer.ready;
                return await viewer.ui(
                  name === "wave_decoder_detach"
                    ? "decoderDetach"
                    : name === "wave_decoder_reload"
                      ? "decoderReload"
                      : "decoderStatus",
                  { instanceId: args.instanceId },
                );
              }
              if (name === "wave_execution_map") {
                await viewer.ready;
                const design = viewer.kdb;
                const instance = String(args.instance);
                const signal = String(args.signal);
                const captureOperands = args.captureOperands === true;
                const captureGuards = args.captureGuards === true;
                const captureGuardEntry = args.captureGuardEntry === true;
                let statements;
                if (design instanceof VerilatorDesign) {
                  if (captureOperands || captureGuards || captureGuardEntry)
                    throw Error(
                      "Automatic operand and guard capture in execution maps requires a VCS KDB.",
                    );
                  statements = await design.executionStatements(
                    instance,
                    signal,
                  );
                } else if (design instanceof KdbSession) {
                  const cancellation = new vscode.CancellationTokenSource();
                  const cancel = () => cancellation.cancel();
                  operation.throwIfAborted();
                  operation.addEventListener("abort", cancel, { once: true });
                  try {
                    const result = await traceWaveSignal(
                      viewer,
                      "drivers",
                      instance + "." + signal,
                      { maxDepth: 1 },
                      cancellation.token,
                    );
                    statements = await vcsExecutionStatements(
                      result.trace,
                      instance,
                      signal,
                      new Set(
                        vscode.workspace.textDocuments
                          .filter(
                            (document) =>
                              document.uri.scheme === "file" &&
                              document.isDirty,
                          )
                          .map((document) => document.uri.fsPath),
                      ),
                      captureOperands,
                      captureGuards,
                      captureGuardEntry,
                    );
                  } finally {
                    operation.removeEventListener("abort", cancel);
                    cancellation.dispose();
                  }
                } else {
                  throw Error(
                    "Attach a Verilator elaboration tree or a VCS KDB first.",
                  );
                }
                operation.throwIfAborted();
                return {
                  schemaVersion: 1,
                  instance,
                  signal,
                  statements,
                };
              }
              if (
                name === "wave_trace_drivers" ||
                name === "wave_trace_loads" ||
                name === "wave_trace_context" ||
                name === "wave_live_trace"
              ) {
                const live = name === "wave_live_trace" ? liveTrace : undefined;
                if (name === "wave_live_trace" && !live)
                  throw Error("Start a live simulation harness first.");
                if (
                  live &&
                  args.liveSessionId !== undefined &&
                  args.liveSessionId !== live.id
                )
                  throw Error("The live simulation session changed.");
                const followLimit = args.followContinuations as
                  | number
                  | undefined;
                if (
                  followLimit !== undefined &&
                  (!Number.isInteger(followLimit) ||
                    followLimit < 1 ||
                    followLimit > 8)
                )
                  throw Error(
                    "followContinuations must be an integer from 1 to 8.",
                  );
                const continuationDeadline =
                  followLimit === undefined
                    ? undefined
                    : AbortSignal.timeout(100_000);
                const direction =
                  name === "wave_trace_loads" ? "loads" : "drivers";
                const signal = String(args.signal);
                const filelist =
                  typeof args.filelist === "string"
                    ? path.resolve(workspace, args.filelist)
                    : undefined;
                const videManifest =
                  typeof args.videManifest === "string"
                    ? path.resolve(workspace, args.videManifest)
                    : undefined;
                const buildManifest =
                  typeof args.buildManifest === "string"
                    ? await readTraceBuildManifest(
                        path.resolve(workspace, args.buildManifest),
                      )
                    : undefined;
                operation.throwIfAborted();
                const cancellation = new vscode.CancellationTokenSource();
                const cancel = () => cancellation.cancel();
                operation.addEventListener("abort", cancel, { once: true });
                const expand = args.expandReachable === true;
                const traceOptions: TraceOptions = {
                  maxDepth:
                    (args.maxDepth as number | undefined) ??
                    (expand ? 256 : undefined),
                  maxSignals:
                    (args.maxSignals as number | undefined) ??
                    (expand ? 4096 : undefined),
                  maxAssignments:
                    (args.maxAssignments as number | undefined) ??
                    (expand ? 4096 : undefined),
                  includeCompilation:
                    buildManifest || followLimit !== undefined
                      ? true
                      : undefined,
                };
                const override: TraceProjectSelection | undefined = filelist
                  ? {
                      filelist,
                      workingDirectory:
                        typeof args.simulationDirectory === "string"
                          ? path.resolve(workspace, args.simulationDirectory)
                          : path.dirname(filelist),
                    }
                  : videManifest
                    ? { videManifest }
                    : undefined;
                const limits = {
                  nodes: args.maxTemporalNodes as number | undefined,
                  edges: args.maxTemporalEdges as number | undefined,
                  changeOrder: args.changeOrder as number | undefined,
                };
                let result = await traceWaveSignal(
                  viewer,
                  direction,
                  signal,
                  traceOptions,
                  cancellation.token,
                  override,
                  buildManifest,
                ).finally(() => {
                  operation.removeEventListener("abort", cancel);
                  cancellation.dispose();
                });
                operation.throwIfAborted();
                if (!live)
                  result = await focusWaveTrace(
                    viewer,
                    result,
                    signal,
                    direction,
                  );
                operation.throwIfAborted();
                const trace = await bindStaticFrontier(viewer, result);
                operation.throwIfAborted();
                result = { ...result, trace };
                const { instance } = result;
                const feedbackEdges = traceFeedback(trace);
                const staticCoverage = staticTraceCoverage(trace);
                const verification = live
                  ? undefined
                  : await verifyWaveTrace(viewer, result);
                operation.throwIfAborted();
                let staticAppendix: string | undefined;
                const staticOutput: {
                  continuationCursor?: string;
                  staticContinuationWalk?: StaticWalk;
                  staticContinuationGraph?: ReturnType<
                    typeof mergeStaticContinuationGraph
                  >;
                  staticContinuationMermaid?: string;
                  staticContinuationMermaidPages?: string[];
                  staticContinuationGraphMermaid?: string;
                  staticContinuationGraphMermaidPages?: string[];
                } = {};
                const staticQuery =
                  name === "wave_trace_drivers" || name === "wave_trace_loads";
                const graphOnly = staticQuery && args.output === "graph";
                const paginating =
                  args.pageSize !== undefined || args.pageCursor !== undefined;
                let staticWalk: StaticWalk | undefined;
                if (
                  staticQuery &&
                  followLimit !== undefined &&
                  continuationDeadline
                ) {
                  const state = await createStaticWalk(
                    viewer,
                    signal,
                    result,
                    direction,
                    traceOptions,
                    override,
                  );
                  staticWalk = await state.run(
                    followLimit,
                    operation,
                    continuationDeadline,
                  );
                  operation.throwIfAborted();
                  if (args.pageCursor === undefined)
                    staticOutput.continuationCursor = retain({
                      ...state,
                      kind: "static",
                      root: signal,
                      initial: trace,
                      direction,
                      instance,
                      walk: staticWalk,
                      waveform: viewer.uri.fsPath,
                    });
                }
                if (staticQuery && pagedGraph) {
                  const graph = mergeStaticContinuationGraph(trace, staticWalk);
                  const report =
                    args.detail === "full"
                      ? appendContinuationReport(
                          traceReport(
                            trace,
                            direction,
                            signal,
                            feedbackEdges,
                            staticCoverage,
                          ),
                          staticWalk
                            ? staticContinuationReport(
                                direction,
                                staticWalk,
                                staticContinuationMermaid(signal, staticWalk),
                                mergedStaticMermaid(graph),
                              )
                            : undefined,
                        )
                      : undefined;
                  return {
                    output: "paged",
                    signal,
                    instance,
                    direction,
                    buildVerification: verification,
                    continuationCursor: staticOutput.continuationCursor,
                    graphSnapshot: pagedStatic(graph, args.format, report),
                    ...(staticWalk
                      ? {
                          continuation: {
                            queried: staticWalk.segments.length,
                            remaining: staticWalk.remaining.length,
                            stopReasons: staticWalk.stopReasons,
                          },
                        }
                      : {}),
                  };
                }
                if (graphOnly) {
                  operation.throwIfAborted();
                  const combined = mergeStaticContinuationGraph(
                    trace,
                    staticWalk,
                  );
                  const { graph, page } = paginating
                    ? pageStaticContinuationGraph(
                        combined,
                        direction,
                        signal,
                        args.pageSize as number | undefined,
                        args.pageCursor as string | undefined,
                      )
                    : { graph: combined, page: undefined };
                  const diagram =
                    args.format === "mermaid"
                      ? mergedStaticMermaid(graph)
                      : undefined;
                  return {
                    output: "graph",
                    signal,
                    instance,
                    direction,
                    staticCoverage,
                    continuationCursor: staticOutput.continuationCursor,
                    staticContinuationGraph: graph,
                    page,
                    ...(verification
                      ? { buildVerification: verification }
                      : {}),
                    ...(staticWalk
                      ? {
                          staticContinuationWalk:
                            summarizeStaticWalk(staticWalk),
                        }
                      : {}),
                    ...(diagram
                      ? mermaidOutput("staticContinuationGraphMermaid", diagram)
                      : {}),
                    ...(args.detail === "full"
                      ? {
                          report: appendContinuationReport(
                            traceReport(
                              trace,
                              direction,
                              signal,
                              feedbackEdges,
                              staticCoverage,
                            ),
                            staticWalk
                              ? staticContinuationReport(
                                  direction,
                                  staticWalk,
                                  staticContinuationMermaid(signal, staticWalk),
                                  mergedStaticMermaid(combined),
                                )
                              : undefined,
                          ),
                        }
                      : {}),
                  };
                }
                if (staticWalk) {
                  staticOutput.staticContinuationWalk = staticWalk;
                  const combined = mergeStaticContinuationGraph(
                    trace,
                    staticWalk,
                  );
                  staticOutput.staticContinuationGraph = combined;
                  if (args.format === "mermaid" || args.detail === "full") {
                    const diagrams = staticContinuationMermaid(
                      signal,
                      staticWalk,
                    );
                    const merged = mergedStaticMermaid(combined);
                    if (args.format === "mermaid")
                      Object.assign(
                        staticOutput,
                        mermaidOutput("staticContinuationMermaid", diagrams),
                        mermaidOutput("staticContinuationGraphMermaid", merged),
                      );
                    if (args.detail === "full")
                      staticAppendix = staticContinuationReport(
                        direction,
                        staticWalk,
                        diagrams,
                        merged,
                      );
                  }
                }
                if (paginating) {
                  const paged = staticTracePage(
                    trace,
                    direction,
                    signal,
                    args.pageSize as number | undefined,
                    args.pageCursor as string | undefined,
                  );
                  const { assignmentOffset, assignmentCount } = paged.page;
                  const feedback = feedbackEdges.flatMap((edge) =>
                    edge.assignment >= assignmentOffset &&
                    edge.assignment < assignmentOffset + assignmentCount
                      ? [
                          {
                            ...edge,
                            assignment: edge.assignment - assignmentOffset,
                          },
                        ]
                      : [],
                  );
                  return {
                    ...paged.trace,
                    signal,
                    instance,
                    direction,
                    staticCoverage,
                    ...staticOutput,
                    ...(verification
                      ? { buildVerification: verification }
                      : {}),
                    feedbackEdges: feedback,
                    page: paged.page,
                    ...(args.format === "mermaid"
                      ? mermaidOutput(
                          "mermaid",
                          traceMermaidPages(paged.trace, feedback),
                        )
                      : {}),
                    ...(args.detail === "full"
                      ? {
                          report: appendContinuationReport(
                            traceReport(
                              paged.trace,
                              direction,
                              signal,
                              feedback,
                              staticCoverage,
                            ),
                            staticAppendix,
                          ),
                        }
                      : {}),
                  };
                }
                const reportOnly = args.output === "report";
                const temporalOnly =
                  args.output === "temporal" ||
                  (args.output === undefined && followLimit !== undefined);
                const fullReport = reportOnly || args.detail === "full";
                const temporalOutput = (
                  context:
                    | Awaited<
                        ReturnType<typeof traceObservedContext>
                      >["context"]
                    | Awaited<ReturnType<typeof traceLiveContext>>["context"],
                ) => {
                  const {
                    schemaVersion,
                    tick,
                    historyStart,
                    historyEnd,
                    scale,
                    provider,
                    mode,
                    sourceMatch,
                    selectedTransition,
                    temporalTrace,
                    observations,
                    runtimeInputs,
                    runtimeInputSource,
                    runtimeMismatches,
                  } = context;
                  return {
                    output: "temporal",
                    ...temporalTraceReferences(trace, temporalTrace),
                    waveformSignals: temporalWaveformSignals(context),
                    context: {
                      schemaVersion,
                      tick,
                      historyStart,
                      historyEnd,
                      scale,
                      provider,
                      mode,
                      sourceMatch,
                      selectedTransition,
                      temporalTrace,
                      observations: observations.filter(
                        ({ signal }) => signal === trace.root,
                      ),
                      runtimeInputs,
                      runtimeInputSource,
                      runtimeMismatches,
                    },
                  };
                };
                const follow = async (
                  context: Parameters<typeof temporalOutput>[0],
                  report?: () => string,
                ) => {
                  if (followLimit === undefined || !continuationDeadline) {
                    if (pagedGraph) {
                      const graph = mergeTemporalContinuationGraph(
                        temporalOutput(context),
                        {
                          segments: [],
                          links: [],
                          remaining: [],
                          stopReasons: [],
                        },
                      );
                      return {
                        graphSnapshot: pagedTemporal(
                          graph,
                          args.format,
                          report?.(),
                        ),
                        walkReport: undefined,
                      };
                    }
                    return { walkReport: undefined };
                  }
                  const root = {
                    signal,
                    tick: context.tick,
                    changeOrder: limits.changeOrder,
                    liveSessionId: live?.id,
                  };
                  const recording =
                    typeof args.executionLog === "string"
                      ? path.resolve(workspace, args.executionLog)
                      : undefined;
                  const assertCurrent = await createContinuationGuard(
                    viewer,
                    result,
                    live,
                    recording,
                  );
                  const initial = temporalOutput(context);
                  const query = async (
                    continuation: TemporalContinuation,
                    abort: AbortSignal,
                  ) => {
                    const start = args.historyStart as string | undefined;
                    const historyStart =
                      continuation.historyStart ??
                      (!live &&
                      start &&
                      start !== "auto" &&
                      BigInt(start) > BigInt(continuation.tick)
                        ? "auto"
                        : start);
                    const reply = await request(
                      name,
                      {
                        ...args,
                        changeOrder: undefined,
                        ...continuation,
                        historyStart,
                        waveform: viewer.uri.fsPath,
                        output: "temporal",
                        followContinuations: undefined,
                      },
                      abort,
                    );
                    return reply as ReturnType<typeof temporalOutput>;
                  };
                  const walk = await followTemporalFrontier(
                    root,
                    context.temporalTrace,
                    followLimit,
                    operation,
                    continuationDeadline,
                    query,
                    assertCurrent,
                  );
                  operation.throwIfAborted();
                  if (pagedGraph) {
                    const graph = mergeTemporalContinuationGraph(initial, walk);
                    const markdown =
                      report &&
                      appendContinuationReport(
                        report(),
                        continuationReport(
                          walk,
                          continuationMermaidPages(root, walk),
                          graph,
                        ),
                      );
                    return {
                      graphSnapshot: pagedTemporal(
                        graph,
                        args.format,
                        markdown,
                      ),
                      continuationCursor: retain({
                        kind: "temporal",
                        root,
                        initial,
                        waveform: viewer.uri.fsPath,
                        walk,
                        assertCurrent,
                        query,
                      }),
                      continuation: {
                        queried: walk.segments.length,
                        remaining: walk.remaining.length,
                        stopReasons: walk.stopReasons,
                      },
                      walkReport: undefined,
                    };
                  }
                  return {
                    ...continuationOutput(
                      root,
                      initial,
                      walk,
                      args.format === "mermaid",
                      fullReport,
                    ),
                    continuationCursor: retain({
                      kind: "temporal",
                      root,
                      initial,
                      waveform: viewer.uri.fsPath,
                      walk,
                      assertCurrent,
                      query,
                    }),
                  };
                };
                if (live) {
                  const evidence = await traceLiveContext(
                    viewer,
                    result,
                    live,
                    operation,
                    args.historyStart as string | undefined,
                    typeof args.executionLog === "string"
                      ? path.resolve(workspace, args.executionLog)
                      : undefined,
                    expand,
                    limits,
                    args.tick as string | undefined,
                  );
                  const {
                    context,
                    buildVerification,
                    execution,
                    executionCoverage,
                    replayMatch: executionReplayMatch,
                    executionAssignments,
                    executionTransitions,
                    upstreamExecution,
                  } = evidence;
                  const report = () =>
                    traceReport(
                      trace,
                      "drivers",
                      signal,
                      feedbackEdges,
                      staticCoverage,
                    ) + liveTraceReport(evidence, trace);
                  const { walkReport, ...continuations } = await follow(
                    context,
                    fullReport ? report : undefined,
                  );
                  if (pagedGraph)
                    return {
                      output: "paged",
                      signal,
                      instance,
                      tick: context.tick,
                      buildVerification,
                      executionCoverage,
                      ...continuations,
                    };
                  return {
                    ...(temporalOnly
                      ? temporalOutput(context)
                      : reportOnly
                        ? {}
                        : {
                            ...trace,
                            feedbackEdges,
                            context,
                            execution,
                            executionAssignments,
                            executionTransitions,
                            upstreamExecution,
                          }),
                    signal,
                    instance,
                    staticCoverage,
                    buildVerification,
                    executionCoverage,
                    executionReplayMatch,
                    ...continuations,
                    ...(reportOnly
                      ? {
                          tick: context.tick,
                          temporalCoverage: context.temporalTrace?.coverage,
                        }
                      : {}),
                    ...(args.format === "mermaid"
                      ? {
                          ...(!temporalOnly
                            ? mermaidOutput(
                                "mermaid",
                                traceMermaidPages(trace, feedbackEdges),
                              )
                            : {}),
                          ...(execution.length || upstreamExecution?.length
                            ? mermaidOutput(
                                "executionMermaid",
                                traceExecutionGraph(
                                  execution,
                                  upstreamExecution,
                                ),
                              )
                            : {}),
                          ...(context.temporalTrace
                            ? temporalMermaidOutput(
                                context.temporalTrace,
                                context,
                                undefined,
                                trace.signals,
                              )
                            : {}),
                        }
                      : {}),
                    ...(fullReport
                      ? {
                          report: appendContinuationReport(
                            report(),
                            walkReport,
                          ),
                        }
                      : {}),
                  };
                }
                const evidence =
                  name === "wave_trace_context"
                    ? await traceWaveContext(
                        viewer,
                        result,
                        String(args.tick),
                        args.historyStart as string | undefined,
                        verification,
                        undefined,
                        operation,
                        typeof args.executionLog === "string"
                          ? path.resolve(workspace, args.executionLog)
                          : undefined,
                        expand,
                        limits,
                      )
                    : undefined;
                const {
                  context,
                  execution,
                  executionAssignments,
                  executionTransitions,
                  upstreamExecution,
                } = evidence ?? {};
                const report = () =>
                  traceReport(
                    trace,
                    direction,
                    signal,
                    feedbackEdges,
                    staticCoverage,
                  ) +
                  (context ? observationReport(context, trace) : "") +
                  (execution ? executionReport(execution) : "") +
                  traceExecutionComparisonReport(evidence, execution?.events);
                const { walkReport, ...continuations } = context
                  ? await follow(context, fullReport ? report : undefined)
                  : { walkReport: undefined };
                if (pagedGraph && context)
                  return {
                    output: "paged",
                    signal,
                    instance,
                    direction,
                    tick: context.tick,
                    buildVerification: verification,
                    ...continuations,
                  };
                return {
                  ...(temporalOnly && context
                    ? temporalOutput(context)
                    : reportOnly
                      ? {}
                      : {
                          ...trace,
                          feedbackEdges,
                          context,
                          execution,
                          ...(executionAssignments?.length
                            ? { executionAssignments }
                            : {}),
                          ...(executionTransitions?.length
                            ? { executionTransitions }
                            : {}),
                          ...(upstreamExecution?.length
                            ? { upstreamExecution }
                            : {}),
                        }),
                  direction,
                  signal,
                  instance,
                  staticCoverage,
                  ...staticOutput,
                  ...continuations,
                  ...(verification ? { buildVerification: verification } : {}),
                  ...(reportOnly
                    ? {
                        tick: context?.tick,
                        temporalCoverage: context?.temporalTrace?.coverage,
                        selectedTransition: context?.selectedTransition,
                      }
                    : {}),
                  ...(execution && args.format === "mermaid"
                    ? mermaidOutput(
                        "executionMermaid",
                        traceExecutionGraph(
                          execution.events,
                          upstreamExecution,
                        ),
                      )
                    : {}),
                  ...(context && args.format === "mermaid"
                    ? {
                        ...(!temporalOnly
                          ? mermaidOutput(
                              "observationMermaid",
                              observationMermaidPages(context),
                            )
                          : {}),
                        ...(context.temporalTrace
                          ? temporalMermaidOutput(
                              context.temporalTrace,
                              context,
                              new Map(
                                executionTransitions?.flatMap(
                                  ({ links }) =>
                                    links?.map(
                                      ({ node, ordinal }) =>
                                        [node, ordinal] as const,
                                    ) ?? [],
                                ),
                              ),
                              trace.signals,
                            )
                          : {}),
                      }
                    : {}),
                  ...(args.format === "mermaid" && !temporalOnly
                    ? mermaidOutput(
                        "mermaid",
                        traceMermaidPages(trace, feedbackEdges),
                      )
                    : {}),
                  ...(fullReport
                    ? {
                        report: appendContinuationReport(
                          report(),
                          walkReport ?? staticAppendix,
                        ),
                      }
                    : {}),
                };
              }
              if (name === "wave_clip" || name === "wave_export") {
                await viewer.ready;
                if (!viewer.meta) throw Error("Waveform did not load");
                if (!viewer.panel.visible) viewer.panel.reveal(undefined, true);
                const clip = await collectClip(
                  viewer,
                  args as ClipOptions,
                  name === "wave_clip",
                );
                if (name === "wave_clip") {
                  await includeClipDecoder(viewer, clip, "json", operation);
                  return clip;
                }
                const format = args.format as ClipFormat;
                if (!clipFormats.includes(format))
                  throw Error("Unsupported clip format");
                await includeClipDecoder(viewer, clip, format, operation);
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
                const destination =
                  typeof args.path === "string"
                    ? path.resolve(workspace, args.path)
                    : viewer.document.projectPath ||
                      viewer.uri.fsPath.replace(/\.[^.]+$/, "") + ".waveproj";
                const filename = await saveProject(viewer, destination);
                if (viewer.panel.active && viewer.document.dirty)
                  await vscode.commands.executeCommand(
                    "workbench.action.files.save",
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
          ),
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
