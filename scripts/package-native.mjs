// SPDX-License-Identifier: MPL-2.0

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: { target: { type: "string" }, verdi: { type: "boolean" } },
});
const targets = {
  "linux-x64": "x86_64-unknown-linux-gnu",
  "linux-arm64": "aarch64-unknown-linux-gnu",
  "darwin-x64": "x86_64-apple-darwin",
  "darwin-arm64": "aarch64-apple-darwin",
  "win32-x64": "x86_64-pc-windows-msvc",
  "win32-arm64": "aarch64-pc-windows-msvc",
};
const host = process.platform + "-" + process.arch;
const platform = values.target ?? host;
if (!Object.hasOwn(targets, platform)) {
  throw Error("Supported targets are " + Object.keys(targets).join(", "));
}
if (
  values.verdi &&
  (platform !== "linux-x64" || host !== "linux-x64" || !process.env.VERDI_HOME)
) {
  throw Error(
    "Verdi packaging requires a native Linux x64 host and VERDI_HOME",
  );
}
const target = targets[platform];
const sdkFreeEnv = { ...process.env };
delete sdkFreeEnv.VERDI_HOME;
const cargo = process.env.CARGO || "cargo";
const cargoArgs = [
  "build",
  "--locked",
  "--release",
  "--manifest-path",
  "native/Cargo.toml",
  "--bin",
  "wave-backend",
  "--target",
  target,
];
const suffix = platform.startsWith("win32-") ? ".exe" : "";
const targetDirectory = process.env.CARGO_TARGET_DIR || "native/target";
const binary = resolve(
  targetDirectory,
  target,
  "release",
  "wave-backend" + suffix,
);
const verdiDirectory = resolve(targetDirectory, "verdi");

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw Error(command + " exited with " + result.status);
}

run(cargo, cargoArgs, sdkFreeEnv);
if (values.verdi) {
  run(cargo, [
    ...cargoArgs,
    "--features",
    "verdi-sdk",
    "--target-dir",
    verdiDirectory,
  ]);
}
mkdirSync("bin", { recursive: true });
for (const name of [
  "wave-backend",
  "wave-backend.exe",
  "wave-backend-independent",
  "wave-backend-independent.exe",
  "verdi-sdk",
]) {
  rmSync(resolve("bin", name), { force: true });
}
copyFileSync(binary, "bin/wave-backend-independent" + suffix);
if (values.verdi) {
  copyFileSync(
    resolve(verdiDirectory, target, "release", "wave-backend"),
    "bin/wave-backend",
  );
  writeFileSync("bin/verdi-sdk", "");
} else {
  copyFileSync(binary, "bin/wave-backend" + suffix);
}
run(process.execPath, [
  process.env.npm_execpath,
  "run",
  "package",
  "--",
  "--target",
  platform,
]);
