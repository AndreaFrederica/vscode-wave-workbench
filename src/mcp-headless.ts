// SPDX-License-Identifier: MPL-2.0

import * as path from "node:path";
import * as fs from "node:fs/promises";
import { backendPlan, isWaveform, type FsdbBackend } from "./backend-selection";
import { Backend } from "./backend";
import { renderHeadlessClip } from "./headless-clip-image";
import {
  clipProperties,
  serveMcpStdio,
  socketDirectory,
  tool,
} from "./mcp-stdio";
import { readWaveProject } from "./project";
import type { ClipContext, Metadata, WaveState } from "./shared/protocol";
import { restoreView } from "./view-state";
import {
  readClip,
  serializeClip,
  type ClipFormat,
  type ClipOptions,
} from "./wave-clip";
import { startBackgroundTask } from "./wave-tasks";

const waveform = {
  ...clipProperties.waveform,
  description: "Open waveform path. Defaults to the last selected waveform.",
};
const clipInputs = {
  ...clipProperties,
  waveform,
  range: {
    ...clipProperties.range,
    description:
      "Full waveform or saved project window, saved cursors, or explicit tick bounds.",
  },
  signals: {
    ...clipProperties.signals,
    description:
      "Full signal paths. Defaults to the saved rows when a waveform project is open.",
  },
};
const definitions = [
  tool(
    "wave_open",
    "Open a waveform or .waveproj in the background.",
    {
      path: { type: "string" },
      backend: { type: "string", enum: ["auto", "independent", "verdi"] },
    },
    ["path"],
  ),
  tool(
    "wave_list",
    "List the waveforms opened by this background session.",
    {},
    [],
  ),
  tool("wave_close", "Close a waveform in the background.", { waveform }, []),
  tool(
    "wave_search",
    "Search the full waveform signal catalogue.",
    {
      waveform,
      query: { type: "string" },
      offset: { type: "integer", minimum: 0 },
      limit: { type: "integer", minimum: 1, maximum: 1000 },
    },
    [],
  ),
  tool(
    "wave_clip",
    "Read a waveform segment with held start values, changes and truncation flags.",
    clipInputs,
    [],
  ),
  tool(
    "wave_export",
    "Export a waveform segment as PNG, CSV, JSON or VCD.",
    {
      ...clipInputs,
      format: { type: "string", enum: ["png", "csv", "json", "vcd"] },
      path: {
        type: "string",
        description: "New destination path. PNG can also be returned inline.",
      },
    },
    ["format"],
  ),
];

interface OpenWaveform {
  filename: string;
  backend: Backend;
  meta: Metadata;
  view: ClipContext;
  projectView?: WaveState;
  requestedBackend?: FsdbBackend;
}

async function main(workspace: string) {
  const directory = socketDirectory(workspace);
  const sessions = new Map<string, OpenWaveform>();
  let selected: string | undefined;
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
  const log = (message: string) => process.stderr.write(message);
  const extension = {
    asAbsolutePath: (relative: string) =>
      path.resolve(__dirname, "..", relative),
  };
  const config = { get: <T>(key: string) => settings[key] as T };

  async function open(
    filename: string,
    preference: FsdbBackend,
    signal: AbortSignal,
  ) {
    const project = /\.waveproj$/i.test(filename)
      ? await readWaveProject(filename)
      : undefined;
    filename = project?.waveform ?? filename;
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
        const meta = await backend.request("open", { path: filename });
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
      if (plan.kind !== "verdi" || preference !== "auto") throw error;
      meta = await load(
        backendPlan(extension, config, filename, log, "independent"),
      );
    }
    const dispose = () => backend.dispose();
    signal.addEventListener("abort", dispose, { once: true });
    try {
      signal.throwIfAborted();
      const projectView =
        project && (await restoreView(backend, project.view, meta));
      signal.throwIfAborted();
      const view: ClipContext = {
        start: projectView?.start ?? Number(meta.start),
        end: projectView?.end ?? Number(meta.end),
        cursorA: projectView?.cursorA ?? Number(meta.start),
        cursorB: projectView?.cursorB ?? null,
        selected: projectView?.chosen ?? [],
        displayed: projectView?.chosen ?? [],
        markers: projectView?.markers ?? [],
      };
      const session: OpenWaveform = {
        filename,
        meta,
        backend,
        view,
        projectView,
        requestedBackend: preference,
      };
      previous?.backend.dispose();
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

  try {
    await serveMcpStdio(
      "wave-workbench-headless",
      definitions,
      async (name, args, signal) => {
        if (name === "wave_list")
          return { selected: selected ?? null, views: [...sessions.keys()] };
        const filename = (
          name === "wave_open" ? args.path : (args.waveform ?? selected)
        ) as string | undefined;
        const finish = startBackgroundTask(directory, {
          label:
            name === "wave_export"
              ? `导出波形 ${String(args.format).toUpperCase()}`
              : {
                  wave_open: "打开波形",
                  wave_close: "关闭波形",
                  wave_search: "查找信号",
                  wave_clip: "截取波形",
                }[name],
          filename: filename && path.resolve(workspace, filename),
          started: Date.now(),
        });
        try {
          if (name === "wave_open") {
            const session = await open(
              path.resolve(workspace, filename!),
              (args.backend ?? "auto") as FsdbBackend,
              signal,
            );
            selected = session.filename;
            const { start, end, scale, total, backend } = session.meta;
            return { waveform: selected, start, end, scale, total, backend };
          }
          const session = choose(args.waveform);
          if (name === "wave_close") {
            session.backend.dispose();
            sessions.delete(session.filename);
            if (selected === session.filename)
              selected = [...sessions.keys()].at(-1);
            return { waveform: session.filename, closed: true };
          }
          if (name === "wave_search")
            return await session.backend.request("search", {
              query: (args.query ?? "") as string,
              offset: (args.offset ?? 0) as number,
              limit: (args.limit ?? 100) as number,
            });
          const format = args.format as ClipFormat | undefined;
          const destination =
            format && typeof args.path === "string"
              ? path.resolve(workspace, args.path)
              : undefined;
          if (format && format !== "png" && !destination)
            throw Error("A path is required for this format.");
          if (
            destination &&
            path.extname(destination).toLowerCase() !== "." + format
          )
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
        } finally {
          finish();
        }
      },
    );
  } finally {
    for (const session of sessions.values()) session.backend.dispose();
  }
}

if (require.main === module) {
  main(path.resolve(process.argv[2] ?? process.cwd())).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
