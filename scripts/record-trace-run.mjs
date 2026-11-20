// SPDX-License-Identifier: MPL-2.0

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

async function sha256(filename) {
  if (!(await stat(filename)).isFile())
    throw Error("Expected a regular file: " + filename);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest("hex");
}

async function fingerprint(filename) {
  try {
    const info = await stat(filename, { bigint: true });
    return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(
      ":",
    );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  }
}

async function main() {
  const separator = process.argv.indexOf("--", 2);
  const command = separator === -1 ? [] : process.argv.slice(separator + 1);
  const { values } = parseArgs({
    args: process.argv.slice(2, separator === -1 ? undefined : separator),
    options: {
      manifest: { type: "string" },
      waveform: { type: "string" },
      input: { type: "string", multiple: true },
    },
  });
  if (!values.manifest || !values.waveform || !command.length)
    throw Error(
      "Usage: node scripts/record-trace-run.mjs --manifest BUILD.json --waveform OUTPUT [--input STIMULUS] -- SIMULATOR [ARG ...]",
    );

  const cwd = process.cwd();
  const filename = path.resolve(values.waveform) + ".wave-build.json";
  const base = path.dirname(path.resolve(values.manifest));
  const build = JSON.parse(await readFile(values.manifest, "utf8"));
  if (build.schemaVersion !== 1 || build.format !== "wave-workbench-build")
    throw Error("Expected a Wave Workbench build manifest.");

  const files = await Promise.all(
    [
      ...new Set((values.input ?? []).map((file) => path.resolve(cwd, file))),
    ].map(async (file) => ({ path: file, sha256: await sha256(file) })),
  );
  const previous = await fingerprint(values.waveform);
  const [executable, ...args] = command;
  await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(Error("Simulator exited with " + (signal ?? code)));
    });
  });
  const current = await fingerprint(values.waveform);
  if (!current || current === previous)
    throw Error("Simulator did not produce a fresh waveform.");
  for (const file of files)
    if ((await sha256(file.path)) !== file.sha256)
      throw Error("Stimulus changed during the simulation: " + file.path);
  const waveformSha256 = await sha256(values.waveform);
  if ((await fingerprint(values.waveform)) !== current)
    throw Error("Waveform changed during verification.");

  const absolute = (file) => path.resolve(base, file);
  const manifest = {
    ...build,
    waveformSha256,
    roots: build.roots.map(absolute),
    include_dirs: build.include_dirs.map(absolute),
    files: build.files.map((file) => ({ ...file, path: absolute(file.path) })),
    library_files: build.library_files?.map(absolute),
    library_maps: build.library_maps?.map(absolute),
    source_libraries: build.source_libraries?.map((entry) => ({
      ...entry,
      path: absolute(entry.path),
    })),
    compilation_units: build.compilation_units?.map((unit) =>
      unit.map(absolute),
    ),
    compilation_unit_options: build.compilation_unit_options?.map(
      (options) => ({
        ...options,
        include_dirs: options.include_dirs?.map(absolute),
      }),
    ),
    runtime: {
      workingDirectory: cwd,
      plusargs: args.filter((arg) => arg.startsWith("+")),
      files,
    },
  };
  const temporary = await mkdtemp(
    path.join(path.dirname(filename), ".wave-run-"),
  );
  try {
    const staged = path.join(temporary, "manifest.json");
    await writeFile(staged, JSON.stringify(manifest, null, 2) + "\n", {
      mode: 0o600,
    });
    await rename(staged, filename);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(error.message + "\n");
  process.exitCode = 1;
});
