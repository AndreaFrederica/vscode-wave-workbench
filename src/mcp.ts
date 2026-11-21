// SPDX-License-Identifier: MPL-2.0

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { serveMcpStdio, socketDirectory, validateCall } from "./mcp-stdio";

import { toolDefinitions } from "./wave-tools";

type Arguments = Record<string, unknown>;
const maxMessage = 2 * 1024 * 1024;
const pipePrefix = "\\\\.\\pipe\\wave-workbench-";
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
    name === "wave_trace_graph_page" || name === "wave_trace_graph_path"
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
