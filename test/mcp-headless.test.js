// SPDX-License-Identifier: MPL-2.0

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

test("standalone MCP opens, clips and exports without a VS Code connection", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wave-headless-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "mixed.vcd"), [
    "$timescale 1 ns $end", "$scope module tb $end",
    "$var real 64 r voltage $end", "$var wire 1 w ready $end",
    "$upscope $end", "$enddefinitions $end",
    "#0", "r0.125 r", "0w", "#5", "r-2.5 r", "1w", "#12", "",
  ].join("\n"));
  const clip = { signals: ["tb.voltage", "tb.ready"], start: "2", end: "12" };
  const calls = [
    ["wave_open", { path: "mixed.vcd" }],
    ["wave_search", { query: "voltage" }],
    ["wave_clip", clip],
    ["wave_export", { ...clip, format: "png" }],
    ["wave_export", { ...clip, format: "vcd", path: "cut.vcd" }],
    ["wave_export", { ...clip, format: "vcd", path: "cut.vcd" }],
    ["wave_close", {}],
    ["wave_list", {}],
  ];
  const input = calls.map(([name, args], id) =>
    JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })
  ).join("\n") + "\n";
  const child = spawnSync(process.execPath, [path.resolve(__dirname, "../dist/mcp-headless.js"), dir], {
    input,
    encoding: "utf8",
    env: { ...process.env, TMPDIR: dir, DISPLAY: "", VSCODE_IPC_HOOK_CLI: "" },
    timeout: 15000,
  });
  assert.equal(child.status, 0, child.stderr);
  const responses = child.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(responses.map(({ id }) => id), calls.map((_, id) => id));
  for (const { result, id } of responses) assert.equal(Boolean(result.isError), id === 5, JSON.stringify(result.content[0]));
  const data = (index) => JSON.parse(responses[index].result.content[0].text);
  assert.equal(data(0).scale, "1ns");
  assert.ok(data(1).signals[0].real);
  assert.deepEqual(data(2).traces[0].events, [["2", "0.125"], ["5", "-2.5"]]);
  assert.equal(responses[3].result.content[1].mimeType, "image/png");
  assert.equal(Buffer.from(responses[3].result.content[1].data, "base64").readUInt32BE(16), 1440);
  assert.match(fs.readFileSync(path.join(dir, "cut.vcd"), "utf8"), /#3\nr-2\.5 s0/);
  assert.match(responses[5].result.content[0].text, /EEXIST/);
  assert.deepEqual(data(7), { selected: null, views: [] });
});
