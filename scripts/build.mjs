// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { build } from "esbuild";
import { readdir, rm, mkdir, copyFile } from "node:fs/promises";
await rm("dist", { recursive: true, force: true });
const host = (await readdir("src"))
  .filter(
    (s) =>
      s.endsWith(".ts") &&
      !["mcp-headless.ts", "headless-clip-image.ts"].includes(s),
  )
  .map((s) => "src/" + s);
const shared = (await readdir("src/shared"))
  .filter((s) => s.endsWith(".ts"))
  .map((s) => "src/shared/" + s);
const decoders = (await readdir("src/decoder-runtime"))
  .filter((s) => s.endsWith(".ts"))
  .map((s) => "src/decoder-runtime/" + s);
await build({
  entryPoints: [...host, ...shared, ...decoders],
  outdir: "dist",
  outbase: "src",
  platform: "node",
  format: "cjs",
  target: "node18",
  sourcemap: true,
});
await build({
  entryPoints: [
    "src/webview/wave.ts",
    "src/webview/sidebar.ts",
    "src/webview/schematic.ts",
  ],
  outdir: "dist/webview",
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "chrome118",
  sourcemap: true,
});
await mkdir("dist/tcl", { recursive: true });
await copyFile("src/tcl/bridge.tcl", "dist/tcl/bridge.tcl");
await build({
  entryPoints: ["src/mcp-headless.ts"],
  outfile: "dist/mcp-headless.js",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  legalComments: "linked",
});
await copyFile("node_modules/pureimage/LICENSE", "dist/pureimage-license.txt");
