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

await import("./smoke-mcp.mjs");
