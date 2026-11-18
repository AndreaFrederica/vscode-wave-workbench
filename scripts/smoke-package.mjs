// SPDX-License-Identifier: MPL-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const platform = process.argv[2];
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
