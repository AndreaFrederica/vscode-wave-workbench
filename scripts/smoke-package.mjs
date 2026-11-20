// SPDX-License-Identifier: MPL-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { delimiter, resolve } from "node:path";
import { TclRunner } from "../dist/tcl.js";

const platform = process.argv[2];
// Verify the packaged Tcl bridge with no external shell on PATH.
const savedPath = process.env.PATH;
process.env.PATH = delimiter;
const tcl = new TclRunner(async (name, args) => {
  assert.equal(name, "wvSetCursor");
  assert.equal(args[0].value, "20");
  return "cursor-set";
});
try {
  assert.match(await tcl.run("info patchlevel"), /^8\.6\./);
  assert.equal(
    await tcl.run("set tick [expr {2 * 10}]; wvSetCursor $tick"),
    "cursor-set",
  );
} finally {
  tcl.dispose();
  process.env.PATH = savedPath;
}

for (const independent of [false, true]) {
  const binary = "wave-backend" + (independent ? "-independent" : "");
  const suffix = platform.startsWith("win32-") ? ".exe" : "";
  const child = spawnSync(
    resolve("bin", binary + suffix),
    independent ? ["--independent"] : [],
    {
      encoding: "utf8",
      input: [
        { id: 1, method: "open", path: resolve("examples/demo.vcd") },
        {
          id: 2,
          method: "query",
          signals: ["!"],
          start: "12",
          end: "31",
          limit: 100,
        },
      ]
        .map((request) => JSON.stringify(request) + "\n")
        .join(""),
    },
  );
  if (child.error) throw child.error;
  assert.equal(child.status, 0, child.stderr);
  const [open, query] = child.stdout.trim().split("\n").map(JSON.parse);
  assert.equal(open.result.backend, "rust-vcd", open.error);
  assert.deepEqual(query.result["!"].events[0], ["10", "0"]);
}

const calls = [
  ["wave_open", { path: "demo.vcd" }],
  ["wave_clip", { signals: ["tb.dut.clk"], start: "12", end: "31" }],
  ["wave_tcl", { script: 'waveTool wave_search {{"query":"tb.dut.valid"}}' }],
];
const headless = spawnSync(
  process.execPath,
  [resolve("dist", "mcp-headless.js"), resolve("examples")],
  {
    encoding: "utf8",
    timeout: 30_000,
    input:
      calls
        .map(([name, args], id) =>
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            method: "tools/call",
            params: { name, arguments: args },
          }),
        )
        .join("\n") + "\n",
  },
);
if (headless.error) throw headless.error;
assert.equal(headless.status, 0, headless.stderr);
const responses = headless.stdout.trim().split("\n").map(JSON.parse);
assert.deepEqual(
  responses.map(({ id }) => id),
  [0, 1, 2],
);
const [opened, clip, tclSearch] = responses.map(({ result }) => {
  assert(!result.isError, result.content[0].text);
  return JSON.parse(result.content[0].text);
});
assert.equal(opened.backend, "rust-vcd");
assert.deepEqual(clip.traces[0].events, [
  ["12", "0"],
  ["15", "1"],
  ["20", "0"],
  ["25", "1"],
  ["30", "0"],
]);
const { signals } = JSON.parse(tclSearch.result);
assert(
  signals.some(({ scope, name }) => scope === "tb.dut" && name === "valid"),
);

await import("./smoke-mcp.mjs");
