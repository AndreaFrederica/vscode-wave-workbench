// SPDX-License-Identifier: MPL-2.0

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  mkdir,
  mkdtemp,
  realpath,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { createConnection, createServer } from "node:net";

const workspace = await mkdtemp(join(tmpdir(), "wave-package-mcp-"));
const longTemp = join(workspace, "nested-".repeat(18));
const env =
  process.platform === "win32"
    ? process.env
    : { ...process.env, TMPDIR: longTemp };
if (process.platform !== "win32") await mkdir(longTemp);
const mcp = resolve("dist/mcp.js");
const hosts = [];
const windows = process.platform === "win32";
const windowsDirectory =
  windows &&
  join(
    tmpdir(),
    "wave-workbench-" +
      createHash("sha256")
        .update(await realpath(workspace))
        .digest("hex")
        .slice(0, 20),
  );
if (windowsDirectory) await mkdir(windowsDirectory);
const hostScript = `
const { serveWaveMcp } = require(process.argv[1]);
const waveform = process.argv[3];
if (process.argv[4]) {
  const fs = require("node:fs");
  const stale = require("node:path").join(process.argv[4], process.pid + ".pipe");
  fs.writeFileSync(stale, "{");
}
const server = serveWaveMcp(
  process.argv[2],
  async (name, args, signal) => {
    if (name === "wave_list") return { selected: waveform, views: [waveform] };
    if (args.signal === "cancel.me") {
      await new Promise((resolve) => {
        signal.addEventListener("abort", resolve, { once: true });
        process.send("started trace");
      });
      process.send("cancelled trace");
    }
    return { waveform, signal: args.signal, recordingOnly: args.recordingOnly };
  },
  (log) => process.send(log),
);
process.once("message", () => {
  server.dispose();
  process.disconnect();
});
`;

async function startHost(waveform) {
  const child = spawn(
    process.execPath,
    ["-e", hostScript, mcp, workspace, waveform, windowsDirectory || ""],
    {
      stdio: ["ignore", "inherit", "inherit", "ipc"],
      env,
    },
  );
  const exited = once(child, "exit");
  hosts.push({ child, exited });
  const [message] = await once(child, "message", {
    signal: AbortSignal.timeout(5000),
  });
  assert.match(message, /^MCP socket /);
  return { child, exited, socket: message.slice("MCP socket ".length) };
}

function call(name, args) {
  const child = spawnSync(process.execPath, [mcp, workspace], {
    encoding: "utf8",
    env,
    timeout: 10000,
    input:
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }) + "\n",
  });
  if (child.error) throw child.error;
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout).result;
}

try {
  const first = join(workspace, "first.fst");
  const second = join(workspace, "second.fst");
  const primary = await startHost(first);
  const other = await startHost(second);
  const socketDirectory = windowsDirectory || dirname(other.socket);
  const registrations = () => readdir(socketDirectory);
  const registration = (host) =>
    windows
      ? host.socket.slice(
          host.socket.lastIndexOf("wave-workbench-") + "wave-workbench-".length,
        ) + ".pipe"
      : host.child.pid + ".sock";
  assert((await registrations()).includes(registration(other)));
  if (windows) {
    assert.match(
      other.socket,
      /^\\\\\.\\pipe\\wave-workbench-\d+-[a-f0-9]{32}$/,
    );
    assert((await registrations()).includes(other.child.pid + ".pipe"));
    const unauthenticated = createConnection(other.socket);
    unauthenticated.setEncoding("utf8");
    unauthenticated.setTimeout(5000, () => unauthenticated.destroy());
    let response = "";
    unauthenticated.on("data", (chunk) => {
      response += chunk;
    });
    unauthenticated.once("connect", () =>
      unauthenticated.write('{"name":"wave_list","args":{}}\n'),
    );
    await once(unauthenticated, "close");
    assert.match(
      JSON.parse(response).error,
      /Invalid Wave Workbench pipe token/,
    );
  } else assert(Buffer.byteLength(other.socket) <= 100);
  assert.match(
    call("wave_list", {}).content[0].text,
    /Select an open waveform/,
  );
  const selected = call("wave_trace_drivers", {
    waveform: second,
    signal: "dut.q",
  });
  assert.deepEqual(JSON.parse(selected.content[0].text), {
    waveform: second,
    signal: "dut.q",
  });
  const resumed = call("wave_trace_resume", {
    continuationCursor:
      primary.child.pid + ".7b87c4bc-79fb-4bec-8ac3-ce5174fdc3ec",
  });
  assert.deepEqual(JSON.parse(resumed.content[0].text), { waveform: first });
  const page = call("wave_trace_graph_page", {
    graphCursor: other.child.pid + ".7b87c4bc-79fb-4bec-8ac3-ce5174fdc3ec",
    section: "nodes",
  });
  assert.deepEqual(JSON.parse(page.content[0].text), { waveform: second });
  assert.match(
    call("wave_trace_resume", { continuationCursor: "invalid" }).content[0]
      .text,
    /cursor is unavailable/,
  );
  const unresponsiveName = process.pid + "-" + "f".repeat(32);
  const unresponsiveAddress = windows
    ? "\\\\.\\pipe\\wave-workbench-" + unresponsiveName
    : join(socketDirectory, process.pid + ".sock");
  const connections = new Set();
  const unresponsive = createServer((socket) => {
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
  });
  unresponsive.listen(unresponsiveAddress);
  await once(unresponsive, "listening");
  const dummyRegistration =
    windows && join(socketDirectory, unresponsiveName + ".pipe");
  try {
    if (dummyRegistration)
      await writeFile(
        dummyRegistration,
        JSON.stringify({
          filename: unresponsiveAddress,
          token: "f".repeat(64),
        }),
      );
    const reply = call("wave_trace_drivers", {
      waveform: second,
      signal: "dut.q",
    });
    assert.deepEqual(JSON.parse(reply.content[0].text), {
      waveform: second,
      signal: "dut.q",
    });
  } finally {
    for (const socket of connections) socket.destroy();
    unresponsive.close();
    if (dummyRegistration) await rm(dummyRegistration, { force: true });
  }
  const client = spawn(process.execPath, [mcp, workspace], {
    stdio: ["pipe", "pipe", "inherit"],
    env,
  });
  const clientExited = once(client, "exit");
  const replies = [];
  createInterface({ input: client.stdout }).on("line", (line) =>
    replies.push(JSON.parse(line)),
  );
  const request = (payload) =>
    client.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...payload }) + "\n");
  try {
    const start = once(other.child, "message", {
      signal: AbortSignal.timeout(5000),
    });
    request({
      id: "trace",
      method: "tools/call",
      params: {
        name: "wave_trace_drivers",
        arguments: { waveform: second, signal: "cancel.me" },
      },
    });
    assert.equal((await start)[0], "started trace");
    const cancelled = once(other.child, "message", {
      signal: AbortSignal.timeout(5000),
    });
    request({
      method: "notifications/cancelled",
      params: { requestId: "trace" },
    });
    request({ id: "ping", method: "ping" });
    client.stdin.end();
    assert.equal((await cancelled)[0], "cancelled trace");
    assert.deepEqual(await clientExited, [0, null]);
    assert.deepEqual(replies, [{ jsonrpc: "2.0", id: "ping", result: {} }]);
  } finally {
    if (client.exitCode === null) client.kill();
    await clientExited;
  }
  other.child.send("stop");
  assert.deepEqual(await other.exited, [0, null]);
  assert(!(await registrations()).includes(registration(other)));
  const playback = call("wave_execution_trace", {
    instance: "dut",
    signal: "q",
    executionLog: "trace.jsonl",
    tick: "1",
    recordingOnly: true,
  });
  assert.deepEqual(JSON.parse(playback.content[0].text), {
    waveform: first,
    signal: "q",
    recordingOnly: true,
  });
  primary.child.send("stop");
  assert.deepEqual(await primary.exited, [0, null]);
  if (windows) {
    const stale = hosts.map(({ child }) => child.pid + ".pipe").sort();
    assert.deepEqual((await registrations()).sort(), stale);
    for (const file of stale) await rm(join(socketDirectory, file));
  }
  assert.deepEqual(await registrations(), []);
  await rm(socketDirectory, { recursive: true, force: true });
} finally {
  await Promise.all(
    hosts.map(async ({ child, exited }) => {
      if (child.connected) child.send("stop");
      try {
        await Promise.race([
          exited,
          once(child, "disconnect", { signal: AbortSignal.timeout(5000) }),
        ]);
      } catch {
        child.kill();
        await exited;
      }
    }),
  );
  await rm(workspace, { recursive: true, force: true });
}
console.log("MCP local IPC smoke passed on " + process.platform);
