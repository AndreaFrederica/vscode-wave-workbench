// SPDX-License-Identifier: MPL-2.0

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
if (args.length !== 4)
  throw Error(
    "Usage: node scripts/smoke-rtl-trace.mjs CODE_EXECUTABLE WAVE_VSIX VIDE_VSIX HART1_FIXTURE_DIR",
  );
const [code, wavePackage, videPackage, fixture] = args.map((arg) =>
  resolve(arg),
);
const cli = resolve(
  dirname(code),
  process.platform === "darwin"
    ? "../Resources/app/out/cli.js"
    : "resources/app/out/cli.js",
);
const output = mkdtempSync(join(tmpdir(), "wave rtl trace-"));
process.stdout.write("Trace smoke artifacts: " + output + "\n");
const workspace = join(output, "workspace");
const treeDirectory = join(workspace, "obj_dir");
const extensions = join(output, "extensions");
mkdirSync(join(workspace, ".vscode"), { recursive: true });
mkdirSync(treeDirectory);
copyFileSync(
  fileURLToPath(new URL("../test/fixtures/trace/trace_tb.sv", import.meta.url)),
  join(workspace, "trace_tb.sv"),
);
for (const waveform of ["trace.vcd", "trace.fst"])
  copyFileSync(join(fixture, waveform), join(workspace, waveform));
const fixtureTree = existsSync(join(fixture, "Vtrace_tb.tree.json"))
  ? fixture
  : join(fixture, "obj_dir");
copyFileSync(
  join(fixtureTree, "Vtrace_tb.tree.json"),
  join(treeDirectory, "Vtrace_tb.tree.json"),
);
const metadataName = "Vtrace_tb.tree.meta.json";
const metadata = JSON.parse(
  readFileSync(join(fixtureTree, metadataName), "utf8"),
);
const source = Object.values(metadata.files).find(({ filename, realpath }) =>
  /(?:^|[\\/])trace_tb\.sv$/.test(realpath ?? filename),
);
if (!source)
  throw Error("The elaboration metadata does not include trace_tb.sv.");
const sourcePath = join(workspace, "trace_tb.sv");
writeFileSync(
  join(workspace, ".vscode", "settings.json"),
  JSON.stringify({
    "waveWorkbench.mcpEnabled": true,
    "waveWorkbench.verilatorTreePath": "obj_dir/Vtrace_tb.tree.json",
    "waveWorkbench.sourcePathMappings": {
      [source.realpath ?? source.filename]: sourcePath,
    },
    "extensions.autoCheckUpdates": false,
    "extensions.autoUpdate": false,
  }),
);
writeFileSync(join(treeDirectory, metadataName), JSON.stringify(metadata));
writeFileSync(
  join(workspace, "sources.f"),
  "+define+TRACE_PREFER_HART_1\ntrace_tb.sv\n",
);

const env = { ...process.env, WAVE_SMOKE_NODE: process.execPath };
delete env.VSCODE_IPC_HOOK_CLI;
delete env.ELECTRON_RUN_AS_NODE;
const profile = [
  "--user-data-dir=" + join(output, "user-data"),
  "--extensions-dir=" + extensions,
];
function run(logName, args, commandEnv) {
  const child = spawnSync(code, args, {
    env: commandEnv,
    encoding: "utf8",
    timeout: 120_000,
  });
  const log = join(output, logName);
  writeFileSync(log, (child.stdout ?? "") + (child.stderr ?? ""));
  if (child.error) throw Error(log, { cause: child.error });
  if (child.status !== 0) throw Error("VS Code failed. See " + log);
}
for (const [name, file] of [
  ["wave", wavePackage],
  ["vide", videPackage],
]) {
  run(
    "install-" + name + ".log",
    [cli, ...profile, "--install-extension", file],
    { ...env, ELECTRON_RUN_AS_NODE: "1" },
  );
}
const installedWave = readdirSync(extensions).find((name) =>
  name.startsWith("andreafrederica.wave-workbench-"),
);
if (!installedWave) throw Error("Wave Workbench VSIX installation is missing.");
run(
  "extension-host.log",
  [
    ...profile,
    "--skip-welcome",
    "--skip-release-notes",
    "--disable-workspace-trust",
    ...(process.platform === "linux" && process.getuid() === 0
      ? ["--no-sandbox"]
      : []),
    "--extensionDevelopmentPath=" + join(extensions, installedWave),
    "--extensionTestsPath=" +
      fileURLToPath(
        new URL("../test/fixtures/trace/smoke-ide.cjs", import.meta.url),
      ),
    workspace,
  ],
  env,
);
const evidence = join(workspace, "verified.json");
if (!existsSync(evidence))
  throw Error("No trace smoke result. See the logs in " + output);
process.stdout.write(readFileSync(evidence, "utf8"));
