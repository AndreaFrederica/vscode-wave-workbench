// SPDX-License-Identifier: MPL-2.0

import { clipProperties, tool, validateCall } from "./mcp-stdio";
import { mathActions } from "./wave-math-runtime";
import type { TclNode } from "./tcl";

const followAllContinuations = {
  type: "boolean",
  description:
    "Follow the reachable frontier automatically until it is exhausted or a continuation budget is reached. Defaults to paged graph output.",
};
const traceProperties = {
  followAllContinuations,
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
    minimum: 0,
    maximum: 8,
    description:
      "Automatically query up to this many distinct signals from the static frontier. Use zero to inspect the frontier before querying it.",
  },
  pageCursor: {
    type: "string",
    description: "Continue a previous static trace using its next page cursor.",
  },
};
const temporalLimits = {
  changeOrder: {
    type: "integer",
    minimum: 1,
    description:
      "One-based order of the selected signal change at the requested tick.",
  },
  maxTemporalNodes: { type: "integer", minimum: 1, maximum: 4096 },
  maxTemporalEdges: { type: "integer", minimum: 1, maximum: 16384 },
  maxTemporalGaps: {
    type: "integer",
    minimum: 1,
    maximum: 16384,
    description:
      "Maximum gap records per time graph segment. Defaults to the edge budget and prioritizes distinct continuation requests.",
  },
  followContinuations: {
    type: "integer",
    minimum: 0,
    maximum: 8,
    description:
      "Automatically query up to this many upstream transitions. Use zero to inspect the temporal frontier before querying it.",
  },
  output: {
    type: "string",
    enum: ["trace", "report", "temporal", "paged"],
    description:
      "Return the full trace, its report, the time graph with source references, or a cursor for paged graph output.",
  },
} as const;
export const toolDefinitions = [
  tool(
    "wave_math",
    "Calculate and attach a derived waveform, or analyze its FFT. ADC and DAC accept an optional trigger as the second signal.",
    {
      waveform: { type: "string" },
      operation: { type: "string", enum: mathActions },
      signals: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        maxItems: 4,
        description:
          "Full signal paths or derived signal IDs returned by wave_math.",
      },
      start: { type: "string" },
      end: { type: "string" },
      options: { type: "object" },
      open: {
        type: "boolean",
        description: "Open the exported FFT file in the current session.",
      },
    },
    ["operation", "signals"],
  ),
  tool(
    "wave_live_start",
    "Launch a local simulation harness or VCS with the Wave Workbench live shim.",
    {
      program: { type: "string" },
      cwd: { type: "string" },
      backend: { type: "string", enum: ["harness", "vcs"] },
      signals: { type: "array", items: { type: "string" }, maxItems: 64 },
      statementScopes: {
        type: "array",
        items: { type: "string" },
        maxItems: 16,
      },
      plusargs: { type: "array", items: { type: "string" } },
      stimulusFiles: { type: "array", items: { type: "string" } },
      recording: { type: "string" },
    },
    ["program"],
  ),
  tool("wave_live_stop", "Stop the simulation and retain its history.", {}, []),
  tool(
    "wave_live_history",
    "Read retained live samples and an exact cursor sample.",
    {
      start: { type: "string" },
      end: { type: "string" },
      cursor: { type: "string" },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 4096,
        description:
          "Page exact samples and return nextStart when more data is available.",
      },
    },
    [],
  ),
  tool(
    "wave_live_debug",
    "Attach or detach the live RTL debugger.",
    {
      action: { type: "string", enum: ["attach", "detach"] },
      configuration: { type: "object" },
      show: {
        type: "boolean",
        description: "Attach the VS Code debugger UI in the foreground.",
      },
    },
    ["action"],
  ),
  tool(
    "wave_debug_request",
    "Send a Debug Adapter Protocol request to the RTL debugger. Use events to read queued debug events.",
    {
      command: {
        type: "string",
        enum: [
          "initialize",
          "launch",
          "attach",
          "configurationDone",
          "setBreakpoints",
          "setFunctionBreakpoints",
          "setExceptionBreakpoints",
          "threads",
          "stackTrace",
          "scopes",
          "variables",
          "evaluate",
          "continue",
          "next",
          "stepIn",
          "pause",
          "disconnect",
          "terminate",
          "events",
        ],
      },
      arguments: { type: "object" },
    },
    ["command"],
  ),
  tool(
    "wave_view",
    "Read the view or edit its rows, selection, time window, cursor, or marker.",
    {
      waveform: { type: "string" },
      action: {
        type: "string",
        enum: [
          "snapshot",
          "add",
          "remove",
          "select",
          "window",
          "cursor",
          "marker",
          "fit",
        ],
      },
      signals: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        maxItems: 256,
      },
      tick: { type: "string" },
      start: { type: "string" },
      end: { type: "string" },
      name: { type: "string" },
      reveal: { type: "boolean" },
    },
    ["action"],
  ),
  tool(
    "wave_design_attach",
    "Attach an elaborated Verilator tree, VCS KDB or vendor HDL index.",
    {
      waveform: { type: "string" },
      path: { type: "string" },
    },
    ["path"],
  ),
  tool(
    "wave_source",
    "Resolve the RTL declaration, module definition, or instantiation of a signal.",
    {
      waveform: { type: "string" },
      signal: { type: "string" },
      target: {
        type: "string",
        enum: ["declaration", "definition", "instance"],
      },
      show: {
        type: "boolean",
        description: "Reveal the source in the foreground editor.",
      },
    },
    ["signal"],
  ),
  tool(
    "wave_module_schematic",
    "Read an elaborated module diagram, including its ports, child instances, and available internal logic.",
    {
      waveform: { type: "string" },
      instance: { type: "string" },
      signal: { type: "string" },
      show: {
        type: "boolean",
        description: "Open the schematic in the foreground editor.",
      },
    },
    [],
  ),
  tool(
    "wave_schematic",
    "Read a local RTL schematic with source locations and optional waveform values.",
    {
      waveform: { type: "string" },
      signal: { type: "string" },
      tick: { type: "string" },
      show: {
        type: "boolean",
        description: "Open the schematic in the foreground editor.",
      },
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
          "For VCS, capture operands at eligible fixed-target blocking and nonblocking assignments.",
      },
      captureGuards: {
        type: "boolean",
        description:
          "For VCS, sample eligible local guard operands at fixed-target or array-word NBA evaluations.",
      },
      captureGuardEntry: {
        type: "boolean",
        description:
          "For VCS, capture local operands at eligible if, else or case entries and wait resumptions for fixed-target or array-word NBAs.",
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
      followContinuations: {
        ...temporalLimits.followContinuations,
        minimum: 1,
        description:
          "Automatically query up to this many remaining dependencies.",
      },
      followAllContinuations,
      frontierIndices: {
        type: "array",
        minItems: 1,
        maxItems: 8,
        items: { type: "integer", minimum: 0 },
        description:
          "Run these zero-based entries of the current trace frontier in the specified order. Use instead of an automatic continuation budget.",
      },
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
    "Read a page of a dependency graph snapshot, including Mermaid or Markdown generated from the saved graph on request.",
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
          "bitEdges",
          "nodes",
          "edges",
          "gaps",
          "assignmentSources",
          "frontier",
          "queryFailures",
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
    "wave_trace_graph_path",
    "Extract dependency paths from selected signals or time nodes to traced roots, with optional Mermaid and Markdown.",
    {
      graphCursor: {
        type: "string",
        description:
          "Cursor of a paged RTL trace graph or a previously selected time path.",
      },
      nodeIds: {
        type: "array",
        items: { type: "integer", minimum: 0 },
        minItems: 1,
        maxItems: 16,
        description:
          "Signal IDs from the static signals section or zero-based indices from the temporal nodes section.",
      },
      nodeSelectors: {
        type: "array",
        items: { type: "object" },
        minItems: 1,
        maxItems: 16,
        description:
          "Match a static declaration by full signal path. Add an integer bit to each selector for recorded bit dependencies. For a time graph, supply a decimal tick and optionally changeOrder or callbackOrdinal.",
      },
      mode: {
        type: "string",
        enum: ["shortest", "all"],
        description:
          "Return one shortest path per selected node by default, or every existing branch to a traced root.",
      },
      format: traceProperties.format,
      detail: traceProperties.detail,
    },
    ["graphCursor"],
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
    "Run a Tcl script in the selected Wave Workbench session and return its result and puts output.",
    {
      script: { type: "string" },
      waveform: { type: "string" },
    },
    ["script"],
  ),
  tool(
    "wave_close",
    "Close an open waveform.",
    { waveform: { type: "string" } },
    [],
  ),
  tool(
    "wave_search",
    "Search the full waveform signal catalogue.",
    {
      waveform: { type: "string" },
      query: { type: "string" },
      offset: { type: "integer", minimum: 0 },
      limit: { type: "integer", minimum: 1, maximum: 1000 },
    },
    [],
  ),
  tool("wave_list", "List open waveform files and the selected view.", {}, []),
  tool(
    "wave_open",
    "Open an FSDB, FST or VCD file or restore a .waveproj project in Wave Workbench.",
    {
      path: { type: "string" },
      backend: { type: "string", enum: ["auto", "independent", "verdi"] },
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

export type WaveToolHandler = (
  name: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<unknown>;

export function tclWaveTool(
  handler: WaveToolHandler,
  nodes: TclNode[],
  names = toolDefinitions,
  waveform?: string,
  signal = AbortSignal.timeout(120_000),
): Promise<string> | string {
  const [name, input] = nodes.map(({ value }) => value);
  if (!name || nodes.length > 2)
    throw Error("Usage: waveTool toolName ?JSON arguments?");
  if (name === "list") return JSON.stringify(names);
  if (name === "wave_tcl")
    throw Error("A Tcl script cannot invoke wave_tcl recursively.");
  const args = JSON.parse(input ?? "{}");
  validateCall(names, name, args);
  const definition = names.find((entry) => entry.name === name);
  if (
    waveform &&
    definition &&
    Object.hasOwn(definition.inputSchema.properties, "waveform") &&
    !Object.hasOwn(args, "waveform")
  )
    args.waveform = waveform;
  return handler(name, args, signal).then((value) =>
    JSON.stringify(value ?? null),
  );
}
