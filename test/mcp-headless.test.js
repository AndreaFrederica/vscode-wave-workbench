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

test("both MCP hosts publish the same schema and Tcl can run math and live debug", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wave-tools-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "mixed.vcd"), [
    "$timescale 1 ns $end", "$scope module tb $end", "$var real 64 r voltage $end",
    "$upscope $end", "$enddefinitions $end", "#0", "r0.125 r", "#5", "r0.75 r", "#12", "",
  ].join("\n"));
  const harness = path.join(dir, "harness");
  fs.writeFileSync(harness, [
    "#!/usr/bin/env node",
    "let tick = 0;",
    "require('node:readline').createInterface({input: process.stdin}).on('line', (command) => {",
    "  if (command === 'advance') tick++;",
    "  console.log(JSON.stringify({snapshot: {tick: String(tick), scale: '1ns', done: false, values: {'tb.clk': String(tick % 2)}}}));",
    "});",
  ].join("\n"), { mode: 0o700 });

  const run = (entry, calls) => {
    const result = spawnSync(process.execPath, [path.resolve(__dirname, "../dist", entry), dir], {
      input: calls.map(({ method, params }, id) => JSON.stringify({ jsonrpc: "2.0", id, method, params })).join("\n") + "\n",
      encoding: "utf8",
      env: { ...process.env, TMPDIR: dir, DISPLAY: "" },
      timeout: 15000,
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim().split("\n").map((line) => JSON.parse(line).result);
  };
  const list = { method: "tools/list" };
  const call = (name, args = {}) => ({ method: "tools/call", params: { name, arguments: args } });
  const launch = process.platform === "win32" ? [] : [
    call("wave_live_start", { program: harness }),
    call("wave_live_debug", { action: "attach" }),
    call("wave_debug_request", { command: "evaluate", arguments: { expression: "$tick" } }),
    call("wave_live_debug", { action: "detach" }),
    call("wave_live_control", { action: "stepClock", signal: "tb.clk", cycles: 3 }),
    call("wave_live_stop"),
    call("wave_live_history", { start: "0", end: "6", limit: 3 }),
    call("wave_live_history", { start: "3", end: "6", limit: 4 }),
  ];
  const [catalog, ...responses] = run("mcp-headless.js", [
    list,
    call("wave_tcl", { script: 'waveTool wave_open {{"path":"mixed.vcd"}}' }),
    call("wave_tcl", { script: 'set conversion adc; waveTool wave_math {{"operation":"adc","signals":["tb.voltage"],"options":{"bits":4,"name":"adc"}}}' }),
    call("wave_tcl", { script: "if {$conversion ne {adc}} {error {Tcl variables were lost}}; waveView" }),
    call("wave_save_project", { path: "mixed.waveproj" }),
    call("wave_close"),
    call("wave_open", { path: "mixed.waveproj" }),
    call("wave_clip", { start: "0", end: "12" }),
    ...launch,
  ]);
  assert.deepEqual(catalog, run("mcp.js", [list])[0]);
  const data = responses.map((response) => {
    assert.equal(response.isError, undefined, response.content[0].text);
    return JSON.parse(response.content[0].text);
  });
  const converted = JSON.parse(data[1].result).signal;
  assert.equal(converted.width, 4);
  assert.equal(JSON.parse(data[2].result).chosen[0].name, "adc");
  assert.deepEqual(data[6].traces[0].events.slice(0, 2), [["0", "0010"], ["5", "1011"]]);
  if (launch.length) {
    assert.equal(data[9].body.result, "0");
    assert.equal(data[12].state, "exited");
    assert.deepEqual(data[13].samples.map(({ tick }) => tick), ["0", "1", "2"]);
    assert.equal(data[13].nextStart, "3");
    assert.deepEqual(data[14].samples.map(({ tick }) => tick), ["3", "4", "5"]);
  }
});
