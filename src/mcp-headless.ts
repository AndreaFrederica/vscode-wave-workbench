// SPDX-License-Identifier: MPL-2.0

import * as path from "node:path";
import * as fs from "node:fs/promises";
import {
  backendFallback,
  backendPlan,
  backendSetting,
  isFsdb,
  isShm,
  isWaveform,
  type WaveBackend,
} from "./backend-selection";
import { Backend } from "./backend";
import { renderHeadlessClip } from "./headless-clip-image";
import { serveMcpStdio, socketDirectory } from "./mcp-stdio";
import { tclWaveTool, toolDefinitions } from "./wave-tools";
import { TclRunner } from "./tcl";
import { WaveCommands } from "./commands";
import { parse } from "jsonc-parser";
import { createWaveAnalysis, isAnalysisTool } from "./wave-analysis";
import { headlessTraceHost } from "./headless-vide";

import {
  findVerilatorTree,
  VerilatorDesign,
  verilatorTreeFile,
} from "./verilator";
import { readHdlIndex, shmSourceIndex, VendorHdlDesign } from "./vendor-hdl";
import { editWaveView } from "./wave-view-tools";
import {
  runWaveMath,
  type MathOptions,
  type Operation,
} from "./wave-math-runtime";
import {
  controlSimulation,
  launchSimulation,
  simulationHistory,
  simulationIsActive,
} from "./wave-live-tools";
import { LiveTraceSession } from "./rtl-live-trace";
import { AutomationDebugger } from "./wave-debug-tools";
import { DecoderScheduler } from "./decoder-runtime/scheduler";
import { decoderRegistry } from "./decoder-runtime/registry";
import { loadDecoderProfiles } from "./decoder-config";
import { decodeWaveWindow } from "./wave-decoder-service";
import type { DecoderInstance } from "./decoder-runtime/types";
import { findSignal } from "./signal-lookup";
import { randomUUID } from "node:crypto";
import { HeadlessWaveView } from "./headless-wave-view";
import { readWaveProject, saveWaveProject } from "./project";
import type { ClipContext, Metadata, WaveState } from "./shared/protocol";
import { restoreView } from "./view-state";
import {
  readClip,
  serializeClip,
  type ClipFormat,
  type ClipOptions,
} from "./wave-clip";
import { startBackgroundTask } from "./wave-tasks";

interface OpenWaveform {
  filename: string;
  backend: Backend;
  meta: Metadata;
  view: ClipContext;
  projectView: WaveState;
  state: HeadlessWaveView;
  project?: Awaited<ReturnType<typeof readWaveProject>>;
  projectPath?: string;
  requestedBackend?: WaveBackend;
}

async function main(workspace: string) {
  const directory = socketDirectory(workspace);
  const sessions = new Map<string, OpenWaveform>();
  let selected: string | undefined;
  let simulation: LiveTraceSession | undefined;
  let activeTcl: TclRunner | undefined;
  const interpreters = new Map<
    OpenWaveform,
    {
      runner: TclRunner;
      run(
        script: string,
        signal: AbortSignal,
      ): Promise<{ result: string; logs: string[] }>;
    }
  >();
  const debug = new AutomationDebugger({
    root: workspace,
    active: () => simulation,
    start: async (...args) => {
      if (simulationIsActive(simulation))
        throw Error("Stop the active simulation before starting another.");
      const next = await LiveTraceSession.start(...args);
      simulation?.disposeWaveHistory();
      simulation = next;
      return next;
    },
    stop: (session) => session.dispose(),
  });
  const decoderConfig = path.join(workspace, ".vscode", "wave-decoders.json");
  const trusted = process.env.WAVE_WORKBENCH_TRUSTED === "1";
  const profiles = () => loadDecoderProfiles(decoderConfig);
  const registry = async () =>
    decoderRegistry(await profiles(), trusted ? workspace : undefined);
  const scheduler = new DecoderScheduler(
    path.resolve(
      __dirname,
      "../bin/wave-backend-independent" +
        (process.platform === "win32" ? ".exe" : ""),
    ),
  );
  const decode = async (
    source: Pick<OpenWaveform, "backend" | "meta">,
    instance: DecoderInstance,
    start: string,
    end: string,
    signal?: AbortSignal,
  ) =>
    decodeWaveWindow(
      source,
      scheduler,
      await registry(),
      instance,
      start,
      end,
      signal,
    );
  const choose = (value: unknown) => {
    const filename =
      typeof value === "string" ? path.resolve(workspace, value) : selected;
    const session = filename && sessions.get(filename);
    if (!session)
      throw Error("Open a waveform in the background with wave_open first.");
    return session;
  };
  const settings: Record<string, string | undefined> = {
    independentBackendPath: process.env.WAVE_WORKBENCH_INDEPENDENT_BACKEND,
    backendPath: process.env.WAVE_WORKBENCH_VERDI_BACKEND,
    verdiHome: process.env.VERDI_HOME,
    wlf2vcdPath: process.env.WAVE_WORKBENCH_WLF2VCD,
  };
  const log = (message: string) => process.stderr.write(message + "\n");
  const workspaceSettingsFilename = path.join(
    workspace,
    ".vscode",
    "settings.json",
  );
  const workspaceSettings =
    (await fs.readFile(workspaceSettingsFilename, "utf8").then(
      (text) => parse(text) as Record<string, unknown>,
      (error) => {
        if (error.code === "ENOENT") return {};
        throw error;
      },
    )) ?? {};
  const traceHost = headlessTraceHost(workspace, workspaceSettings, log);
  const analyses = createWaveAnalysis<HeadlessWaveView>(
    traceHost,
    (viewer) => sessions.get(viewer.uri.fsPath)?.project?.traceProject,
    () => simulation,
    (_label, _filename, run) => run(),
  );
  const analysisTools = analyses.tools(
    workspace,
    (waveform) => {
      const filename =
        typeof waveform === "string"
          ? path.resolve(workspace, waveform)
          : selected;
      return filename ? sessions.get(filename)?.state : undefined;
    },
    async (viewer) => {
      if (!viewer.kdb) await viewer.attachKdb();
    },
  );
  const extension = {
    asAbsolutePath: (relative: string) =>
      path.resolve(__dirname, "..", relative),
  };
  const config = {
    get: <T>(key: string) =>
      (settings[key] ?? workspaceSettings["waveWorkbench." + key]) as T,
  };
  const exists = async (filename: string) =>
    fs.stat(filename).then(
      () => true,
      () => false,
    );
  function closeSession(session: OpenWaveform) {
    const running = interpreters.get(session)?.runner;
    interpreters.delete(session);
    if (running !== activeTcl) running?.dispose();
    session.state.disposed = true;
    analyses.dropTraceProject(session.state);
    session.state.kdb?.dispose();
    session.backend.dispose();
  }

  async function attachDesign(session: OpenWaveform, specified?: string) {
    const { filename, meta, backend, project, state } = session;
    const folder = path.dirname(filename);
    const index = shmSourceIndex(filename);
    const explicit = specified ?? project?.verilator ?? project?.kdb;
    const configuredTree = config.get<string>("verilatorTreePath");
    const sibling = path.join(folder, "simv.daidir");
    const database =
      explicit ??
      (/\.wdb$/i.test(filename) ? filename : undefined) ??
      (index && (await exists(index)) ? index : undefined) ??
      (configuredTree
        ? path.resolve(workspace, configuredTree)
        : await findVerilatorTree(filename)) ??
      ((await exists(sibling)) ? sibling : undefined) ??
      config.get<string>("kdbPath");
    if (!database) return false;
    const source = path.resolve(workspace, database);
    const mappings = config.get<Record<string, string>>("sourcePathMappings");
    let design;
    if (source === filename && /\.wdb$/i.test(source)) {
      design = await VendorHdlDesign.open(
        source,
        await backend.request("hdlLocations", {}),
        mappings,
      );
    } else if (/\.hdl\.json$/i.test(source)) {
      design = await VendorHdlDesign.open(
        source,
        await readHdlIndex(source),
        mappings,
      );
    } else if (verilatorTreeFile(source)) {
      design = await VerilatorDesign.open(source, meta.signals, [
        workspace,
        folder,
        path.dirname(source),
        path.dirname(path.dirname(source)),
      ]);
    } else {
      const preference = isFsdb(filename)
        ? (session.requestedBackend ?? "auto")
        : "independent";
      const plan = backendPlan(
        extension,
        config,
        "design.fsdb",
        log,
        preference,
      );
      const openKdb = async (kind: ReturnType<typeof plan.createKdb>) => {
        try {
          await kind.open(source);
          return kind;
        } catch (error) {
          kind.dispose();
          throw error;
        }
      };
      try {
        design = await openKdb(plan.createKdb());
      } catch (error) {
        if (preference !== "auto" || plan.kdbKind !== "verdi") throw error;
        design = await openKdb(
          backendPlan(
            extension,
            config,
            "design.fsdb",
            log,
            "independent",
          ).createKdb(),
        );
      }
    }
    if (state.disposed) {
      design.dispose();
      throw Error("The waveform was closed during design attachment.");
    }
    analyses.dropTraceProject(state);
    state.kdb?.dispose();
    state.kdb = design;
    return true;
  }

  async function open(
    filename: string,
    signal: AbortSignal,
    preference?: WaveBackend,
  ) {
    const projectPath = /\.waveproj$/i.test(filename) ? filename : undefined;
    const project = /\.waveproj$/i.test(filename)
      ? await readWaveProject(filename)
      : undefined;
    filename = project?.waveform ?? filename;
    preference ??= config.get<WaveBackend>(backendSetting(filename)) ?? "auto";
    if (
      !isWaveform(filename) ||
      !(/\.shm$/i.test(filename)
        ? (await fs.stat(filename)).isDirectory()
        : (await fs.stat(filename)).isFile())
    )
      throw Error(
        "Expected an accessible waveform file or SHM database directory.",
      );
    const previous = sessions.get(filename);
    if (
      previous &&
      !previous.backend.closed &&
      !project &&
      preference === previous.requestedBackend
    )
      return previous;

    const plan = backendPlan(extension, config, filename, log, preference);
    let backend: Backend;
    async function load(launch: typeof plan) {
      backend = launch.createWave();
      const abort = () => backend.dispose();
      signal.addEventListener("abort", abort, { once: true });
      try {
        signal.throwIfAborted();
        const meta = await backend.request("open", {
          path: filename,
          cadenceShm: launch.cadenceShm || undefined,
        });
        if (
          !Number.isSafeInteger(Number(meta.start)) ||
          !Number.isSafeInteger(Number(meta.end))
        )
          throw Error(
            "Waveform ticks exceed the range supported by the clip renderer.",
          );
        return meta;
      } catch (error) {
        backend.dispose();
        throw error;
      } finally {
        signal.removeEventListener("abort", abort);
      }
    }
    let meta: Metadata;
    try {
      meta = await load(plan);
    } catch (error) {
      signal.throwIfAborted();
      const fallback = backendFallback(filename, plan.kind, preference);
      if (!fallback) throw error;
      try {
        meta = await load(
          backendPlan(extension, config, filename, log, fallback),
        );
      } catch (fallbackError) {
        throw Error(`${error}\n${fallbackError}`);
      }
    }
    const dispose = () => backend.dispose();
    signal.addEventListener("abort", dispose, { once: true });
    try {
      signal.throwIfAborted();
      const projectView = project
        ? await restoreView(backend, project.view, meta, isShm(filename))
        : (previous &&
            isShm(filename) &&
            (await restoreView(backend, previous.projectView, meta, true))) ||
          undefined;
      signal.throwIfAborted();
      const state = new HeadlessWaveView(
        backend,
        meta,
        filename,
        projectView,
        (database) => attachDesign(session, database),
      );
      const session: OpenWaveform = {
        filename,
        meta,
        backend,
        state,
        project,
        projectPath,
        get view() {
          return state.clipContext();
        },
        get projectView() {
          return state.snapshot;
        },
        requestedBackend: preference,
      };
      if (project?.kdb || project?.verilator) {
        await state.attachKdb();
        if (signal.aborted) {
          closeSession(session);
          signal.throwIfAborted();
        }
      }
      if (previous) closeSession(previous);
      sessions.delete(filename);
      sessions.set(filename, session);
      return session;
    } catch (error) {
      backend.dispose();
      throw error;
    } finally {
      signal.removeEventListener("abort", dispose);
    }
  }

  function createInterpreter(owner?: OpenWaveform) {
    let target = owner;
    let signal: AbortSignal;
    let logs: string[];
    let scriptDirectory = workspace;
    const engine = new WaveCommands({
      getViewer: () => target?.state,
      decoderProfiles: profiles,
      decodeTransactions: (viewer, instance, start, end) =>
        decode(viewer, instance, start, end, signal),
      open: async (filename) => {
        target = await open(path.resolve(scriptDirectory, filename), signal);
        selected = target.filename;
      },
      scope: async (scope) => {
        if (!target) throw Error("Open a waveform first.");
        target.state.snapshot.scope = scope;
      },
    });
    const tcl = new TclRunner(
      (command, nodes, currentDirectory) => {
        scriptDirectory = currentDirectory;
        if (target) target.state.scriptDirectory = currentDirectory;
        if (command === "waveTool")
          return Promise.resolve(
            tclWaveTool(callTool, nodes, undefined, target?.filename, signal),
          ).then((value) => {
            if (
              nodes[0]?.value === "wave_open" ||
              nodes[0]?.value === "wave_close"
            )
              target = (selected && sessions.get(selected)) || undefined;
            return value;
          });
        return engine.execute(command, nodes);
      },
      {
        executable:
          process.env.WAVE_WORKBENCH_TCLSH ?? config.get<string>("tclshPath"),
        log: (line) => {
          if (logs.length < 500) logs.push(line.slice(0, 4096));
        },
      },
    );
    return {
      runner: tcl,
      async run(script: string, operation: AbortSignal) {
        signal = operation;
        logs = [];
        activeTcl = tcl;
        const abort = () => tcl.dispose();
        signal.addEventListener("abort", abort, { once: true });
        try {
          signal.throwIfAborted();
          return {
            result: await tcl.run(
              script,
              owner ? path.dirname(owner.filename) : workspace,
            ),
            logs,
          };
        } finally {
          signal.removeEventListener("abort", abort);
          activeTcl = undefined;
          if (!owner || owner.state.disposed || tcl.closed) {
            if (owner) interpreters.delete(owner);
            tcl.dispose();
          }
        }
      },
    };
  }

  async function invoke(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    if (name === "wave_list")
      return { selected: selected ?? null, views: [...sessions.keys()] };
    if (name === "wave_debug_request") return debug.request(args, signal);
    if (name === "wave_live_debug") return debug.attachOrDetach(args, signal);
    if (name === "wave_live_start") {
      if (simulationIsActive(simulation))
        throw Error("Stop the active simulation before starting another.");
      const next = await launchSimulation(workspace, args, log, signal);
      simulation?.disposeWaveHistory();
      simulation = next;
      return simulation.status();
    }
    if (
      [
        "wave_live_control",
        "wave_live_status",
        "wave_live_history",
        "wave_live_stop",
      ].includes(name)
    ) {
      if (!simulation) throw Error("Start a live simulation harness first.");
      if (name === "wave_live_status") return simulation.status();
      if (name === "wave_live_history")
        return simulationHistory(simulation, args, signal);
      if (name === "wave_live_stop") {
        simulation.dispose();
        return simulation.status();
      }
      return controlSimulation(simulation, args, signal);
    }
    if (name === "wave_tcl") {
      const owner = args.waveform
        ? choose(args.waveform)
        : (selected && sessions.get(selected)) || undefined;
      const interpreter =
        (owner && interpreters.get(owner)) || createInterpreter(owner);
      if (owner) interpreters.set(owner, interpreter);
      return interpreter.run(String(args.script), signal);
    }
    if (name === "wave_open") {
      const session = await open(
        path.resolve(workspace, String(args.path)),
        signal,
        args.backend as WaveBackend | undefined,
      );
      selected = session.filename;
      const { start, end, scale, total, backend } = session.meta;
      return { waveform: selected, start, end, scale, total, backend };
    }
    if (isAnalysisTool(name)) return await analysisTools(name, args, signal);
    const session = choose(args.waveform);
    if (name === "wave_view") return editWaveView(session.state, args, signal);
    if (name === "wave_design_attach") {
      if (!(await session.state.attachKdb(String(args.path))))
        throw Error("Could not attach design.");
      const design = session.state.kdb!;
      return { path: design.path, kind: design.kind };
    }
    if (name === "wave_close") {
      closeSession(session);
      sessions.delete(session.filename);
      if (selected === session.filename) selected = [...sessions.keys()].at(-1);
      return { waveform: session.filename, closed: true };
    }
    if (name === "wave_search")
      return await session.backend.request("search", {
        query: (args.query ?? "") as string,
        offset: (args.offset ?? 0) as number,
        limit: (args.limit ?? 100) as number,
      });
    if (name === "wave_save_project") {
      let destination =
        typeof args.path === "string"
          ? path.resolve(workspace, args.path)
          : (session.projectPath ??
            session.filename.replace(/\.[^.]+$/, "") + ".waveproj");
      if (!/\.waveproj$/i.test(destination)) destination += ".waveproj";
      const project = session.project;
      const design = session.state.kdb;
      await saveWaveProject(
        destination,
        session.filename,
        session.projectView,
        design?.kind === "verilator"
          ? undefined
          : (design?.path ?? project?.kdb),
        design?.kind === "verilator"
          ? design.path
          : design
            ? undefined
            : project?.verilator,
        project?.designView,
        project?.traceProject,
      );
      session.projectPath = destination;
      return { path: destination };
    }
    if (name === "wave_math") {
      const result = await runWaveMath(
        session,
        args.operation as Operation,
        args.signals as string[],
        String(args.start ?? session.meta.start),
        String(args.end ?? session.meta.end),
        (args.options ?? {}) as MathOptions,
        workspace,
        trusted,
        signal,
      );
      if ("signal" in result && result.signal)
        session.state.addVirtual(result.signal);
      if ("path" in result && result.path && args.open === true)
        selected = (await open(result.path, signal)).filename;
      return result;
    }
    if (name === "wave_decoder_list") {
      const { definitions, warnings } = await registry();
      return {
        decoders: [...definitions.values()].map(({ manifest }) => manifest),
        warnings,
      };
    }
    if (name === "wave_decoder_query")
      return decode(
        session,
        {
          decoderId: String(args.decoderId),
          bindings: args.bindings as DecoderInstance["bindings"],
          options: args.options as DecoderInstance["options"],
        },
        String(args.start),
        String(args.end),
        signal,
      );
    if (name === "wave_decoder_attach") {
      const { definitions } = await registry();
      const definition = definitions.get(String(args.decoderId));
      if (!definition)
        throw Error("Decoder not found or disabled: " + args.decoderId);
      const instance = {
        instanceId: randomUUID(),
        decoderId: definition.manifest.id,
        engine: definition.manifest.engine,
        bindings: args.bindings as DecoderInstance["bindings"],
        options: args.options as DecoderInstance["options"],
      };
      await Promise.all(
        Object.values(instance.bindings).map((input) =>
          findSignal(session.backend, input),
        ),
      );
      (session.projectView.decoderInstances ??= []).push(instance);
      return instance;
    }
    if (name === "wave_decoder_status")
      return {
        instances: (session.projectView.decoderInstances ?? []).map(
          (instance) => ({ instance, status: "" }),
        ),
      };
    if (name === "wave_decoder_detach" || name === "wave_decoder_reload") {
      const instances = session.projectView.decoderInstances ?? [];
      const id = args.instanceId ?? instances.at(-1)?.instanceId;
      if (name === "wave_decoder_detach") {
        if (id)
          session.projectView.decoderInstances = instances.filter(
            ({ instanceId }) => instanceId !== id,
          );
        return { detached: !!id };
      }
      const instance = instances.find(({ instanceId }) => instanceId === id);
      if (instance) {
        const { start, end } = session.view;
        await decode(
          session,
          instance,
          String(start),
          String(BigInt(end) + 1n),
          signal,
        );
      }
      return { reloaded: !!id };
    }
    if (name !== "wave_clip" && name !== "wave_export")
      throw Error("Unsupported background operation: " + name);
    const format = args.format as ClipFormat | undefined;
    const destination =
      format && typeof args.path === "string"
        ? path.resolve(workspace, args.path)
        : undefined;
    if (format && format !== "png" && !destination)
      throw Error("A path is required for this format.");
    if (destination && path.extname(destination).toLowerCase() !== "." + format)
      throw Error("The file extension must match the export format.");
    if (!args.signals && !session.view.selected.length)
      throw Error(
        "Specify signal paths or open a .waveproj with saved signal rows.",
      );
    const clip = await readClip(
      session,
      session.view,
      args as ClipOptions,
      !format,
    );
    signal.throwIfAborted();
    if (!format || format === "png" || format === "json") {
      for (const instance of session.projectView.decoderInstances ?? []) {
        const result = await decode(
          session,
          instance,
          clip.start,
          String(BigInt(clip.end) + 1n),
          signal,
        ).catch((error) => {
          signal.throwIfAborted();
          return {
            transactions: [],
            warnings: [String(error)],
            truncated: true,
          };
        });
        (clip.decoders ??= []).push({ id: instance.decoderId, result });
      }
    }
    if (!format) return clip;
    if (format === "vcd" && clip.truncated)
      throw Error(
        "The waveform segment exceeds the event limit. Choose a shorter interval to export VCD.",
      );
    const summary = {
      format,
      waveform: clip.waveform,
      timescale: clip.timescale,
      start: clip.start,
      end: clip.end,
      signalCount: clip.traces.length,
      truncated: clip.truncated,
    };
    const data =
      format === "png"
        ? await renderHeadlessClip(
            clip,
            session.projectView?.busLabelMode ?? "auto",
            session.projectView?.showDecodedValues !== false,
          )
        : serializeClip(clip, format);
    signal.throwIfAborted();
    if (!destination)
      return {
        ...summary,
        imagePng: Buffer.from(data).toString("base64"),
      };
    await fs.writeFile(destination, data, { flag: "wx" });
    return { ...summary, path: destination };
  }

  async function callTool(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ) {
    if (name === "wave_list") return invoke(name, args, signal);
    const filename =
      args.waveform ??
      args.program ??
      (name === "wave_open" ? args.path : selected);
    const finish = startBackgroundTask(directory, {
      label:
        {
          wave_open: "打开波形",
          wave_close: "关闭波形",
          wave_search: "查找信号",
          wave_clip: "截取波形",
          wave_export: "导出波形 " + String(args.format ?? "").toUpperCase(),
          wave_live_start: "启动在线仿真",
          wave_live_control: "控制在线仿真",
          wave_debug_request: "RTL 调试",
          wave_math: "波形数学",
          wave_tcl: "执行波形 Tcl",
        }[name] ?? name,
      filename:
        typeof filename === "string"
          ? path.resolve(workspace, filename)
          : undefined,
      started: Date.now(),
    });
    try {
      return await invoke(name, args, signal);
    } finally {
      finish();
    }
  }

  try {
    await serveMcpStdio("wave-workbench-headless", toolDefinitions, callTool);
  } finally {
    activeTcl?.dispose();
    debug.dispose();
    simulation?.dispose();
    simulation?.disposeWaveHistory();
    for (const session of sessions.values()) closeSession(session);
    analyses.dispose();
    traceHost.dispose();
  }
}

if (require.main === module) {
  main(path.resolve(process.argv[2] ?? process.cwd())).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
