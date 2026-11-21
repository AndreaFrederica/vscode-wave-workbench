// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { localizeHtml } from "./shared/localization";
import type { SchematicGraph } from "./shared/schematic";
import type { Viewer } from "./viewer";
import type { Signal } from "./shared/protocol";
import type * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import { traceSchematic, traceTimeSchematic } from "./rtl-schematic";
import { kdbSchematicRoots } from "./kdb-schematic";

import { backendPlan, isFsdb } from "./backend-selection";
import { type TraceProjectSelection } from "./project";
import { findSignal } from "./signal-lookup";
import { VerilatorDesign, verilatorTreeFile } from "./verilator";
import * as WaveSignal from "./shared/signals";
import { KdbSession, mapPrefix } from "./kdb";
import {
  mergeTemporalContinuationGraph,
  temporalTraceReferences,
  temporalWaveformSignals,
  type TraceDirection,
  type VideTrace,
} from "./rtl-trace";

import type {
  WaveAnalysis,
  GetViewer,
  ReportError,
  TrackTask,
} from "./wave-extension-types";
import type { createWaveFiles } from "./wave-files";
import type { createWaveTraceView } from "./wave-trace-view";

type VSCodeApi = typeof vscode;

export function createWaveSchematics(
  vscode: VSCodeApi,
  {
    context,
    getCurrent,
    output,
    report,
    trackTask,
    restoreWaveformViewer,
    traceProjectSelection,
    getTraceSnapshot,
    traceSubject,
    bindTraceObservations,
    queryWaveSchematic,
    moduleSchematicReader,
    dumpScope,
  }: {
    context: vscode.ExtensionContext;
    getCurrent: GetViewer;
    output: vscode.OutputChannel;
    report: ReportError;
    trackTask: TrackTask;
    restoreWaveformViewer: ReturnType<
      typeof createWaveFiles
    >["restoreWaveformViewer"];
    traceProjectSelection: (
      viewer: Viewer,
    ) => TraceProjectSelection | null | undefined;
    getTraceSnapshot: ReturnType<
      typeof createWaveTraceView
    >["getTraceSnapshot"];
    traceSubject: ReturnType<typeof createWaveTraceView>["traceSubject"];
    bindTraceObservations: WaveAnalysis["bindTraceObservations"];
    queryWaveSchematic: WaveAnalysis["queryWaveSchematic"];
    moduleSchematicReader: WaveAnalysis["moduleSchematicReader"];
    dumpScope: WaveAnalysis["dumpScope"];
  },
) {
  async function showCurrentTraceSchematic(viewer?: Viewer) {
    const snapshot = getTraceSnapshot();
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
    if (wave && model.signalNodes.size) {
      const bindTrace = temporal ? trace : staticTrace;
      const { bindings } = await trackTask(
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
        getTraceSnapshot() !== snapshot ||
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
    } else if (!wave && snapshot.waveform) {
      for (const node of model.graph.nodes)
        if (node.wave === undefined)
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
    {
      tick,
      direction = "drivers",
    }: { tick?: string; direction?: TraceDirection } = {},
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
      viewer = await restoreWaveformViewer(waveform);
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
              : (node?.waveformSignal ??
                (node?.wave && node.instance && node.kind === "signal"
                  ? dumpScope(connected, node.instance) +
                    (node.signal?.startsWith(node.instance + ".")
                      ? node.signal.slice(node.instance.length)
                      : "." + node.label)
                  : undefined));
            if (!name) return;
            const currentSignal =
              signal && !restoredPanel
                ? signal
                : await findSignal(connected.backend, name, ".");
            if (
              disposed ||
              connected.disposed ||
              !currentSignal.supported ||
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
    return localizeHtml(
      fs.readFileSync(
        vscode.Uri.joinPath(media, "schematic.html").fsPath,
        "utf8",
      ),
    )
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
    const { readModule, closeLogicProject } = moduleSchematicReader(
      design,
      viewer,
      waveformPath,
      restored?.state.traceProject,
    );
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
              (restored && (await restoreWaveformViewer(waveformPath)));
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
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "waveWorkbench.openModuleSchematic",
      async (selected?: vscode.Uri) => {
        try {
          const viewer = getCurrent();
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

  return {
    showCurrentTraceSchematic,
    showWaveSchematic,
    showModuleSchematic,
    showWaveModuleSchematic,
  };
}
