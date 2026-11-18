// SPDX-License-Identifier: MPL-2.0

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";

type Arguments = Record<string, unknown>;
const maxMessage = 2 * 1024 * 1024;
const clipProperties = {
  waveform: {
    type: "string",
    description:
      "Absolute path of an open waveform. Defaults to the active view.",
  },
  signals: {
    type: "array",
    items: { type: "string" },
    minItems: 1,
    maxItems: 64,
    description:
      "Full signal paths. Defaults to selected signal rows, or displayed rows if none are selected.",
  },
  range: {
    type: "string",
    enum: ["view", "cursors", "explicit"],
    description:
      "Visible time window, A/B cursor interval, or explicit tick bounds.",
  },
  start: {
    type: "string",
    description:
      "Start tick, as an integer string. Together with end, defaults to explicit range.",
  },
  end: { type: "string", description: "End tick, as an integer string." },
  limit: {
    type: "integer",
    minimum: 1,
    maximum: 5000,
    description:
      "Maximum events per signal before the total clip budget is applied.",
  },
};
const toolDefinitions = [
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
    "Open an FSDB/VCD file or restore a .waveproj project in Wave Workbench.",
    {
      path: { type: "string" },
    },
    ["path"],
  ),
  tool(
    "wave_save_project",
    "Save the current waveform and view state to a .waveproj file.",
    {
      path: { type: "string" },
      waveform: { type: "string" },
    },
    ["path"],
  ),
];

type InputProperty = {
  type: string;
  enum?: readonly string[];
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  items?: { type: string };
  description?: string;
};

function validArgument(value: unknown, property: InputProperty) {
  if (property.type === "string")
    return (
      typeof value === "string" &&
      value.length > 0 &&
      (!property.enum || property.enum.includes(value))
    );
  if (property.type === "integer")
    return (
      typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= (property.minimum ?? -Infinity) &&
      value <= (property.maximum ?? Infinity)
    );
  return (
    property.type === "array" &&
    Array.isArray(value) &&
    value.length >= (property.minItems ?? 0) &&
    value.length <= (property.maxItems ?? Infinity) &&
    value.every(
      (item) => typeof item === property.items?.type && item.length > 0,
    )
  );
}

function tool(
  name: string,
  description: string,
  properties: Record<string, InputProperty>,
  required: string[],
) {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    },
  };
}

function socketDirectory(workspace: string) {
  const id = createHash("sha256")
    .update(fs.realpathSync(workspace))
    .digest("hex")
    .slice(0, 20);
  const directory = path.join(
    os.tmpdir(),
    `wave-workbench-${process.getuid()}-${id}`,
  );
  try {
    fs.mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const info = fs.lstatSync(directory);
  if (!info.isDirectory() || info.uid !== process.getuid() || info.mode & 0o077)
    throw Error(
      "Wave Workbench socket directory must be private and owned by the current user",
    );
  return directory;
}

export function serveWaveMcp(
  workspace: string,
  call: (name: string, args: Arguments) => Promise<unknown>,
  log: (message: string) => void,
) {
  const filename = path.join(socketDirectory(workspace), `${process.pid}.sock`);
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
      try {
        const { name, args } = JSON.parse(buffer.slice(0, lineEnd));
        const definition = toolDefinitions.find((entry) => entry.name === name);
        if (
          !definition ||
          !args ||
          typeof args !== "object" ||
          Array.isArray(args)
        )
          throw Error("Invalid Wave Workbench tool call");
        if (
          definition.inputSchema.required.some(
            (key) => !Object.hasOwn(args, key),
          ) ||
          Object.keys(args).some(
            (key) =>
              !Object.hasOwn(definition.inputSchema.properties, key) ||
              !validArgument(args[key], definition.inputSchema.properties[key]),
          )
        )
          throw Error("Invalid Wave Workbench tool arguments");
        const result = await call(name, args);
        socket.end(JSON.stringify({ result }) + "\n");
      } catch (error) {
        socket.end(JSON.stringify({ error: String(error) }) + "\n");
      }
    });
  });
  server.on("error", log);
  server.listen(filename, () => {
    fs.chmodSync(filename, 0o600);
    log("MCP socket " + filename);
  });
  return {
    dispose() {
      for (const socket of sockets) socket.destroy();
      server.close();
    },
  };
}

function exchange(filename: string, request: Arguments) {
  return new Promise<unknown>((resolve, reject) => {
    const socket = net.createConnection(filename);
    socket.setEncoding("utf8");
    socket.setTimeout(130000, () =>
      socket.destroy(Error("Wave Workbench request timed out")),
    );
    socket.once("connect", () => socket.write(JSON.stringify(request) + "\n"));
    socket.on("error", reject);
    socket.once("close", () =>
      reject(Error("Wave Workbench closed the connection")),
    );
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

async function connectToWorkbench(
  directory: string,
  name: string,
  args: Arguments,
) {
  const candidates = fs
    .readdirSync(directory)
    .filter((file) => /^\d+\.sock$/.test(file));
  const active = [];
  for (const file of candidates) {
    const filename = path.join(directory, file);
    try {
      process.kill(Number.parseInt(file, 10), 0);
      const result = await exchange(filename, { name: "wave_list", args: {} });
      active.push({ filename, result });
    } catch (error) {
      if (
        !["ESRCH", "ENOENT", "ECONNREFUSED"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      )
        throw error;
    }
  }
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
    : exchange(matches[0].filename, { name, args });
}

async function stdio(workspace: string) {
  const directory = socketDirectory(workspace);
  const supportedVersions = [
    "2025-11-25",
    "2025-06-18",
    "2025-03-26",
    "2024-11-05",
  ];
  for await (const line of readline.createInterface({ input: process.stdin })) {
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Invalid JSON" },
        }) + "\n",
      );
      continue;
    }
    if (!request || !Object.hasOwn(request, "id")) continue;
    const response: Arguments = { jsonrpc: "2.0", id: request.id };
    if (request.method === "initialize") {
      const version = request.params?.protocolVersion;
      response.result = {
        protocolVersion: supportedVersions.includes(version)
          ? version
          : supportedVersions[0],
        capabilities: { tools: {} },
        serverInfo: { name: "wave-workbench", version: "0.9.5" },
      };
    } else if (request.method === "ping") response.result = {};
    else if (request.method === "tools/list")
      response.result = { tools: toolDefinitions };
    else if (request.method === "tools/call") {
      try {
        const result = await connectToWorkbench(
          directory,
          request.params?.name,
          request.params?.arguments ?? {},
        );
        if (
          request.params?.name === "wave_export" &&
          result &&
          typeof result === "object" &&
          "imagePng" in result &&
          typeof result.imagePng === "string"
        ) {
          const { imagePng, ...metadata } = result;
          response.result = {
            content: [
              { type: "text", text: JSON.stringify(metadata) },
              { type: "image", mimeType: "image/png", data: imagePng },
            ],
          };
        } else {
          response.result = {
            content: [{ type: "text", text: JSON.stringify(result) }],
          };
        }
      } catch (error) {
        response.result = {
          isError: true,
          content: [{ type: "text", text: String(error) }],
        };
      }
    } else response.error = { code: -32601, message: "Method not found" };
    process.stdout.write(JSON.stringify(response) + "\n");
  }
}

if (require.main === module) {
  stdio(process.argv[2] ?? process.cwd()).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
