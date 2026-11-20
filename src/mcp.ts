// SPDX-License-Identifier: MPL-2.0

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import {
  clipProperties,
  serveMcpStdio,
  socketDirectory,
  tool,
  validateCall,
} from "./mcp-stdio";

type Arguments = Record<string, unknown>;
const maxMessage = 2 * 1024 * 1024;
const pipePrefix = "\\\\.\\pipe\\wave-workbench-";
const traceProperties = {
  waveform: {
    type: "string",
    description:
      "Absolute path of an open waveform. Defaults to the active view.",
  },
  signal: {
    type: "string",
    description: "Full dumped signal path with its instance.",
  },
  filelist: {
    type: "string",
    description:
      "Compile the trace against this simulator filelist in an isolated VIDE project.",
  },
  videManifest: {
    type: "string",
    description:
      "Analyze against an existing vide.toml and its project directory.",
  },
  buildManifest: {
    type: "string",
    description:
      "Build manifest with waveform and source hashes. Supplies the VIDE project when no filelist or vide.toml is selected.",
  },
  simulationDirectory: {
    type: "string",
    description:
      "Working directory for relative filelist paths. Defaults to the filelist directory.",
  },
  maxDepth: { type: "integer", minimum: 0, maximum: 256 },
  maxSignals: { type: "integer", minimum: 1, maximum: 4096 },
  maxAssignments: {
    type: "integer",
    minimum: 0,
    maximum: 8192,
    description: "Maximum static assignments in the connected trace.",
  },
  expandReachable: {
    type: "boolean",
    description:
      "Use expanded defaults for unspecified limits. The result reports any frontier that prevents complete coverage.",
  },
  format: {
    type: "string",
    enum: ["json", "mermaid"],
    description: "Include a Mermaid graph alongside the trace data.",
  },
  detail: {
    type: "string",
    enum: ["summary", "full"],
    description: "Include a detailed Markdown report with source locations.",
  },
};
const pagedTraceProperties = {
  ...traceProperties,
  signal: {
    type: "string",
    description:
      "Full dumped signal path. May end with a packed bit [index] or a constant slice [left:right].",
  },
  pageSize: { type: "integer", minimum: 1, maximum: 128 },
  output: {
    type: "string",
    enum: ["trace", "graph", "paged"],
    description:
      "Return the trace, the combined dependency graph, or a cursor for paged graph output. In graph mode, page bounds apply to the combined graph.",
  },
  followContinuations: {
    type: "integer",
    minimum: 1,
    maximum: 8,
    description:
      "Automatically query up to this many distinct signals from the static frontier.",
  },
  pageCursor: {
    type: "string",
    description: "Continue a previous static trace using its next page cursor.",
  },
};
const temporalLimits = {
  maxTemporalNodes: { type: "integer", minimum: 1, maximum: 4096 },
  maxTemporalEdges: { type: "integer", minimum: 1, maximum: 16384 },
  followContinuations: {
    type: "integer",
    minimum: 1,
    maximum: 8,
    description:
      "Automatically query up to this many distinct upstream transitions from the temporal frontier.",
  },
  output: {
    type: "string",
    enum: ["trace", "report", "temporal", "paged"],
    description:
      "Return the full trace, its report, the time graph with source references, or a cursor for paged graph output.",
  },
} as const;
const toolDefinitions = [
  tool(
    "wave_schematic",
    "Read a local RTL schematic with source locations and optional waveform values.",
    {
      waveform: { type: "string" },
      signal: { type: "string" },
      tick: { type: "string" },
      direction: { type: "string", enum: ["drivers", "loads"] },
    },
    ["signal"],
  ),

  tool(
    "wave_decoder_list",
    "List installed waveform decoders.",
    {
      waveform: {
        type: "string",
        description: "Optional path of an open waveform.",
      },
    },
    [],
  ),
  tool(
    "wave_decoder_query",
    "Decode waveform transactions over a half-open tick window.",
    {
      waveform: {
        type: "string",
        description: "Optional path of an open waveform.",
      },
      decoderId: { type: "string" },
      bindings: {
        type: "object",
        description: "Map input IDs to waveform signal paths.",
      },
      options: {
        type: "object",
        description: "Optional JSON decoder parameters.",
      },
      start: { type: "string", description: "First tick, inclusive." },
      end: { type: "string", description: "Last tick, exclusive." },
    },
    ["decoderId", "bindings", "start", "end"],
  ),
  tool(
    "wave_decoder_attach",
    "Bind a decoder to the waveform transaction row.",
    {
      waveform: { type: "string" },
      decoderId: { type: "string" },
      bindings: { type: "object" },
      options: { type: "object" },
    },
    ["decoderId", "bindings"],
  ),
  tool(
    "wave_decoder_detach",
    "Remove a waveform transaction row.",
    { waveform: { type: "string" }, instanceId: { type: "string" } },
    [],
  ),
  tool(
    "wave_decoder_reload",
    "Reload the script and decode the current viewport.",
    { waveform: { type: "string" }, instanceId: { type: "string" } },
    [],
  ),
  tool(
    "wave_decoder_status",
    "Read the waveform transaction row configuration.",
    { waveform: { type: "string" } },
    [],
  ),
  tool(
    "wave_live_status",
    "Read the live simulation state and recent execution events.",
    {},
    [],
  ),
  tool(
    "wave_live_control",
    "Control the running simulation using the provider's declared capabilities.",
    {
      action: {
        type: "string",
        enum: [
          "pause",
          "resume",
          "stepClock",
          "setBreakpoint",
          "setStatementBreakpoint",
          "clearBreakpoint",
        ],
      },
      signal: { type: "string" },
      cycles: { type: "integer", minimum: 1, maximum: 1000 },
      value: { type: "string" },
      instance: { type: "string" },
      statementId: { type: "string" },
      eventKind: {
        type: "string",
        enum: [
          "branch-taken",
          "assignment-entered",
          "assignment-evaluated",
          "assignment-committed",
          "assignment-superseded",
        ],
        description:
          "Statement event to match. Defaults to assignment evaluation.",
      },
      timing: {
        type: "string",
        enum: ["simulator-commit", "end-of-slot"],
        description:
          "Optional timing filter for an assignment-committed breakpoint.",
      },
    },
    ["action"],
  ),
  tool(
    "wave_live_trace",
    "Trace a selected RTL signal against retained live simulation samples. Attach the corresponding elaborated design to a reference waveform first.",
    {
      ...traceProperties,
      ...temporalLimits,
      tick: {
        type: "string",
        description:
          "Optional retained end-of-slot snapshot tick. Defaults to the latest snapshot.",
      },
      liveSessionId: {
        type: "string",
        description: "Require the live session that supplied the continuation.",
      },
      historyStart: {
        type: "string",
        description: "Optional first tick of retained live history.",
      },
      executionLog: {
        type: "string",
        description:
          "Execution JSONL for this build. With a matching build manifest and live event sequence, it provides source mappings for exact writer attribution.",
      },
    },
    ["signal"],
  ),
  tool(
    "wave_trace_drivers",
    "Trace upstream RTL assignments from a dumped signal using VIDE and supported elaborated port connections.",
    pagedTraceProperties,
    ["signal"],
  ),
  tool(
    "wave_trace_loads",
    "Trace downstream RTL assignments from a dumped signal using VIDE and supported elaborated port connections.",
    pagedTraceProperties,
    ["signal"],
  ),
  tool(
    "wave_execution_map",
    "Generate stable statement and process IDs for direct assignments to a signal in a Verilator or VCS design.",
    {
      waveform: traceProperties.waveform,
      instance: {
        type: "string",
        description: "Elaborated RTL instance path.",
      },
      signal: {
        type: "string",
        description:
          "Signal name within the instance. VCS also accepts a concrete array word such as mem[36].",
      },
      captureOperands: {
        type: "boolean",
        description:
          "For VCS, add operand capture to eligible fixed-target NBA statements.",
      },
      captureGuards: {
        type: "boolean",
        description:
          "For VCS, sample eligible local guard operands at fixed-target or array-word NBA evaluations.",
      },
      captureGuardEntry: {
        type: "boolean",
        description:
          "For VCS array-word maps, also capture eligible guard operands on entry to a taken if block.",
      },
    },
    ["instance", "signal"],
  ),
  tool(
    "wave_execution_trace",
    "Replay recorded execution for an instance signal, optionally verified against an open waveform.",
    {
      waveform: traceProperties.waveform,
      recordingOnly: {
        type: "boolean",
        description: "Read the recording independently of the active waveform.",
      },
      instance: {
        type: "string",
        description: "Exact recorded RTL instance path.",
      },
      signal: {
        type: "string",
        description: "Signal name within the recorded instance.",
      },
      executionLog: {
        type: "string",
        description: "Path to the execution JSONL recording.",
      },
      tick: {
        type: "string",
        description: "Final tick of the requested execution window.",
      },
      historyStart: {
        type: "string",
        description: "First tick of the requested window. Defaults to tick.",
      },
      detail: traceProperties.detail,
      format: traceProperties.format,
    },
    ["instance", "signal", "executionLog", "tick"],
  ),
  tool(
    "wave_trace_context",
    "Sample waveform values and bounded history for an upstream RTL trace.",
    {
      ...traceProperties,
      ...temporalLimits,
      tick: {
        type: "string",
        description: "Observation tick as a decimal string.",
      },
      changeOrder: {
        type: "integer",
        minimum: 1,
        description:
          "One-based order of the selected signal change at this tick.",
      },
      historyStart: {
        type: "string",
        description:
          "First tick for waveform history or 'auto' for history near the latest observed change.",
      },
      executionLog: {
        type: "string",
        description: "Optional execution recording matching the open waveform.",
      },
    },
    ["signal", "tick"],
  ),
  tool(
    "wave_trace_resume",
    "Follow another batch of dependencies and extend the combined graph from an earlier trace.",
    {
      continuationCursor: {
        type: "string",
        description:
          "Continuation cursor returned by a static, waveform, or live trace.",
      },
      followContinuations: temporalLimits.followContinuations,
      format: traceProperties.format,
      detail: traceProperties.detail,
      output: {
        type: "string",
        enum: ["graph", "temporal", "report", "paged"],
        description:
          "Return the matching dependency graph, its detailed Markdown report, or a cursor for paged graph output.",
      },
    },
    ["continuationCursor"],
  ),
  tool(
    "wave_trace_graph_page",
    "Read a page of an existing dependency graph snapshot.",
    {
      graphCursor: {
        type: "string",
        description: "Graph cursor returned by paged trace output.",
      },
      section: {
        type: "string",
        enum: [
          "signals",
          "assignments",
          "feedbackEdges",
          "nodes",
          "edges",
          "gaps",
          "assignmentSources",
          "mermaid",
          "report",
        ],
      },
      offset: { type: "integer", minimum: 0 },
      limit: { type: "integer", minimum: 1, maximum: 128 },
    },
    ["graphCursor", "section"],
  ),
  tool(
    "wave_clip",
    "Read a clipped segment from open waveform signals. Returns initial values, transitions, tick scale, markers and truncation flags.",
    clipProperties,
    [],
  ),
  tool(
    "wave_export",
    "Export a waveform segment as PNG, CSV, JSON or VCD. PNG may be returned directly as an image. Data formats require a destination path.",
    {
      ...clipProperties,
      format: { type: "string", enum: ["png", "csv", "json", "vcd"] },
      path: {
        type: "string",
        description:
          "A new destination file. Relative paths are resolved against the workspace.",
      },
    },
    ["format"],
  ),
  tool(
    "wave_tcl",
    "Run a Tcl script in the selected live Wave Workbench view and return its result and puts output.",
    {
      script: { type: "string" },
      waveform: { type: "string" },
    },
    ["script"],
  ),
  tool("wave_list", "List open waveform files and the selected view.", {}, []),
  tool(
    "wave_open",
    "Open an FSDB, FST or VCD file or restore a .waveproj project in Wave Workbench.",
    {
      path: { type: "string" },
    },
    ["path"],
  ),
  tool(
    "wave_save_project",
    "Save a waveform project without opening a dialog. With no path, use the current project or save beside the waveform.",
    {
      path: {
        type: "string",
        description:
          "Destination .waveproj path. Relative paths use the workspace root.",
      },
      waveform: {
        type: "string",
        description:
          "Absolute path of an open waveform. Defaults to the active view.",
      },
    },
    [],
  ),
];

export function serveWaveMcp(
  workspace: string,
  call: (
    name: string,
    args: Arguments,
    signal: AbortSignal,
  ) => Promise<unknown>,
  log: (message: string) => void,
) {
  const directory = socketDirectory(workspace);
  const pipeToken =
    process.platform === "win32" ? randomBytes(32).toString("hex") : undefined;
  const pipeId =
    pipeToken && process.pid + "-" + randomBytes(16).toString("hex");
  const registration = pipeId
    ? path.join(directory, pipeId + ".pipe")
    : undefined;
  const filename = pipeId
    ? pipePrefix + pipeId
    : path.join(directory, `${process.pid}.sock`);
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    socket.setTimeout(135000, () => socket.destroy());
    socket.on("error", () => socket.destroy());
    socket.once("close", () => sockets.delete(socket));
    let buffer = "";
    socket.on("data", async (content) => {
      buffer += content;
      if (Buffer.byteLength(buffer) > maxMessage) {
        socket.destroy();
        return;
      }
      const lineEnd = buffer.indexOf("\n");
      if (lineEnd === -1) return;
      socket.removeAllListeners("data");
      const operation = new AbortController();
      socket.once("close", () => operation.abort());
      try {
        const { name, args, token } = JSON.parse(buffer.slice(0, lineEnd));
        if (pipeToken && token !== pipeToken)
          throw Error("Invalid Wave Workbench pipe token.");
        validateCall(toolDefinitions, name, args);
        const result = await call(name, args, operation.signal);
        if (!operation.signal.aborted)
          socket.end(JSON.stringify({ result }) + "\n");
      } catch (error) {
        if (!operation.signal.aborted)
          socket.end(JSON.stringify({ error: String(error) }) + "\n");
      }
    });
  });
  let disposed = false;
  let published = false;
  server.on("error", (error) => log(String(error)));
  server.listen(filename, () => {
    if (disposed) {
      server.close();
      return;
    }
    try {
      if (registration) {
        const temporary = registration + ".tmp";
        fs.writeFileSync(
          temporary,
          JSON.stringify({ filename, token: pipeToken }),
          { flag: "wx", mode: 0o600 },
        );
        try {
          fs.renameSync(temporary, registration);
        } finally {
          fs.rmSync(temporary, { force: true });
        }
        published = true;
      } else fs.chmodSync(filename, 0o600);
    } catch (error) {
      server.close();
      log(String(error));
      return;
    }
    log("MCP socket " + filename);
  });
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      if (registration && published) {
        try {
          fs.rmSync(registration, { force: true });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT")
            log(String(error));
        }
      }
      for (const socket of sockets) socket.destroy();
      server.close();
    },
  };
}

function exchange(
  filename: string,
  request: Arguments,
  signal?: AbortSignal,
  timeout = 130000,
) {
  signal?.throwIfAborted();
  return new Promise<unknown>((resolve, reject) => {
    const socket = net.createConnection(filename);
    const cancel = () =>
      socket.destroy(Error("Wave Workbench request cancelled"));
    signal?.addEventListener("abort", cancel, { once: true });
    socket.setEncoding("utf8");
    socket.setTimeout(timeout, () =>
      socket.destroy(
        Object.assign(Error("Wave Workbench request timed out"), {
          code: "ETIMEDOUT",
        }),
      ),
    );
    socket.once("connect", () => socket.write(JSON.stringify(request) + "\n"));
    socket.on("error", reject);
    socket.once("close", () => {
      signal?.removeEventListener("abort", cancel);
      reject(Error("Wave Workbench closed the connection"));
    });
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 64 * 1024 * 1024) {
        socket.destroy(Error("Wave Workbench response is too large"));
        return;
      }
      const lineEnd = buffer.indexOf("\n");
      if (lineEnd === -1) return;
      try {
        const { result, error } = JSON.parse(buffer.slice(0, lineEnd));
        if (error) reject(Error(error));
        else resolve(result);
      } catch (error) {
        reject(error);
      } finally {
        socket.destroy();
      }
    });
  });
}

function readPipeRegistration(file: string, pid: number, nonce?: string) {
  try {
    const attributes = fs.lstatSync(file);
    if (!attributes.isFile() || attributes.size > 512) return;
    const registration = JSON.parse(fs.readFileSync(file, "utf8"));
    const prefix = pipePrefix + pid + "-";
    const filename = registration?.filename;
    const token = registration?.token;
    if (
      typeof filename === "string" &&
      filename.startsWith(prefix) &&
      /^[a-f0-9]{32}$/.test(filename.slice(prefix.length)) &&
      (!nonce || filename === prefix + nonce) &&
      typeof token === "string" &&
      /^[a-f0-9]{64}$/.test(token)
    )
      return { filename, token };
  } catch (error) {
    if (
      !(error instanceof SyntaxError) &&
      !["ENOENT", "EACCES", "EPERM"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
      )
    )
      throw error;
  }
}

async function connectToWorkbench(
  directory: string,
  name: string,
  args: Arguments,
  signal: AbortSignal,
) {
  const windows = process.platform === "win32";
  const pattern = windows
    ? /^([1-9]\d*)(?:-([a-f0-9]{32}))?\.pipe$/
    : /^([1-9]\d*)\.sock$/;
  const cursorField =
    name === "wave_trace_graph_page"
      ? "graphCursor"
      : name === "wave_trace_resume"
        ? "continuationCursor"
        : undefined;
  const cursorHost =
    cursorField &&
    /^([1-9]\d{0,9})\.[a-f0-9-]{36}$/.exec(String(args[cursorField]))?.[1];
  const cursorUnavailable =
    cursorField === "graphCursor"
      ? "This trace graph cursor is unavailable. Start a new trace."
      : "This trace continuation cursor is unavailable. Start a new trace.";
  if (cursorField && !cursorHost) throw Error(cursorUnavailable);
  async function probe(file: string) {
    signal.throwIfAborted();
    const candidate = pattern.exec(file);
    if (!candidate) return;
    const pid = Number(candidate[1]);
    if (pid > 0x7fffffff) return;
    const record = path.join(directory, file);
    try {
      process.kill(pid, 0);
      const endpoint = windows
        ? readPipeRegistration(record, pid, candidate[2])
        : { filename: record, token: undefined };
      if (!endpoint) return;
      const result = await exchange(
        endpoint.filename,
        {
          name: "wave_list",
          args: {},
          token: endpoint.token,
        },
        signal,
        3000,
      );
      if (
        result &&
        typeof result === "object" &&
        "views" in result &&
        Array.isArray(result.views)
      )
        return { ...endpoint, result };
    } catch (error) {
      if (
        !(error instanceof SyntaxError) &&
        ![
          "ESRCH",
          "ENOENT",
          "ECONNREFUSED",
          "ECONNRESET",
          "ECONNABORTED",
          "EPIPE",
          "ETIMEDOUT",
          "EACCES",
          "EPERM",
        ].includes((error as NodeJS.ErrnoException).code ?? "")
      )
        throw error;
    }
  }
  const entries = fs.readdirSync(directory).filter((file) => {
    const endpoint = pattern.exec(file);
    return endpoint && (!cursorHost || endpoint[1] === cursorHost);
  });
  const active = [];
  for (let offset = 0; offset < entries.length; offset += 8) {
    const batch = await Promise.all(
      entries.slice(offset, offset + 8).map(probe),
    );
    for (const endpoint of batch) if (endpoint) active.push(endpoint);
  }
  if (!active.length && cursorHost) throw Error(cursorUnavailable);
  if (!active.length)
    throw Error(
      "Open the workspace in Wave Workbench with waveWorkbench.mcpEnabled enabled",
    );
  const requestedWaveform =
    typeof args.waveform === "string" ? args.waveform : undefined;
  const matches = requestedWaveform
    ? active.filter(({ result }) =>
        (result as { views: string[] }).views.includes(requestedWaveform),
      )
    : active;
  if (matches.length !== 1)
    throw Error(
      "Select an open waveform by absolute path or use a single VS Code window for this workspace",
    );
  return name === "wave_list"
    ? matches[0].result
    : exchange(
        matches[0].filename,
        { name, args, token: matches[0].token },
        signal,
      );
}

if (require.main === module) {
  Promise.resolve()
    .then(() => {
      const directory = socketDirectory(process.argv[2] ?? process.cwd());
      return serveMcpStdio(
        "wave-workbench",
        toolDefinitions,
        (name, args, signal) =>
          connectToWorkbench(directory, name, args, signal),
      );
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
