import { build } from "esbuild";
import { readdir, rm, mkdir, copyFile } from "node:fs/promises";
await rm("dist", { recursive: true, force: true });
const host = (await readdir("src"))
  .filter((s) => s.endsWith(".ts"))
  .map((s) => "src/" + s);
await build({
  entryPoints: [...host, "src/shared/signals.ts"],
  outdir: "dist",
  outbase: "src",
  platform: "node",
  format: "cjs",
  target: "node18",
  sourcemap: true,
});
await build({
  entryPoints: ["src/webview/wave.ts", "src/webview/sidebar.ts"],
  outdir: "dist/webview",
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "chrome118",
  sourcemap: true,
});
await mkdir("dist/tcl", { recursive: true });
await copyFile("src/tcl/bridge.tcl", "dist/tcl/bridge.tcl");
