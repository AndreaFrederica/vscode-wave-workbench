// SPDX-License-Identifier: MPL-2.0

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { createRequire } from "node:module";
import {
  mkdtemp,
  readFile,
  realpath,
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

async function readBuildTemplate(filename) {
  const base = path.dirname(path.resolve(filename));
  const build = JSON.parse(await readFile(filename, "utf8"));
  if (build.schemaVersion !== 1 || build.format !== "wave-workbench-build")
    throw Error("Expected a Wave Workbench build manifest.");
  const absolute = (file) => path.resolve(base, file);
  return {
    ...build,
    roots: build.roots.map(absolute),
    include_dirs: build.include_dirs.map(absolute),
    files: build.files.map((file) => ({ ...file, path: absolute(file.path) })),
    vcs_pli: build.vcs_pli?.map(({ table, library, ...entry }) => ({
      ...entry,
      table: { ...table, path: absolute(table.path) },
      library: library && { ...library, path: absolute(library.path) },
    })),
    vcs_trace_library: build.vcs_trace_library && {
      ...build.vcs_trace_library,
      path: absolute(build.vcs_trace_library.path),
    },
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
  };
}

async function readVcsBuild(database, reference) {
  const require = createRequire(import.meta.url);
  const {
    discoverVcsRebuild,
    readSimulationFilelist,
    readVcsSourceInventory,
    simulationFilelistsCurrent,
    simulationInputFingerprint,
  } = require("../dist/vide-project-config.js");
  const rebuild = await discoverVcsRebuild(database);
  if (!rebuild) throw Error("No VCS rebuild metadata found in " + database);
  const profile = await readSimulationFilelist(
    rebuild.filelist,
    rebuild.workingDirectory,
    undefined,
    rebuild.rebuild,
  );
  const roots = profile.sources.map(({ path }) => path);
  const libraries = profile.libraryFiles.map(({ path }) => path);
  if (!roots.length && !libraries.length)
    throw Error("The VCS rebuild metadata contains no RTL sources.");
  const inventory = await readVcsSourceInventory(
    rebuild.filelist,
    rebuild.workingDirectory,
  );
  const canonical = (file) => realpath(file).catch(() => path.resolve(file));
  const compiled = new Set(await Promise.all(inventory.files.map(canonical)));
  const buildFiles = await Promise.all([...roots, ...libraries].map(canonical));
  const selected = new Set([
    ...buildFiles,
    ...compiled,
    ...(await Promise.all((profile.libraryMaps ?? []).map(canonical))),
  ]);
  const files = [];
  for (const file of reference?.files ?? []) {
    if (selected.has(await canonical(file.path))) files.push(file);
  }
  const hashed = new Set(
    await Promise.all(files.map(({ path }) => canonical(path))),
  );
  const filesComplete =
    !!reference &&
    reference.files_complete !== false &&
    !reference.unsupported?.includes(
      "Header hashes unavailable from VCS rebuild metadata",
    ) &&
    buildFiles.every((file) => compiled.has(file)) &&
    [...selected].every((file) => hashed.has(file));
  const inputs = [
    ...profile.filelists,
    ...profile.sourceFingerprints,
    ...(inventory.input ? [inventory.input] : []),
    ...(await Promise.all(
      [...new Set([...inventory.files, ...files.map(({ path }) => path)])].map(
        simulationInputFingerprint,
      ),
    )),
  ];
  async function recordPliFile(filename, limit) {
    inputs.push(await simulationInputFingerprint(filename));
    const attributes = await stat(filename).catch((error) => {
      if (error.code !== "ENOENT" && error.code !== "EACCES") throw error;
    });
    return {
      path: filename,
      ...(attributes?.isFile() && attributes.size <= limit
        ? { sha256: await sha256(filename) }
        : {}),
    };
  }
  const vcsPli = [];
  for (const entry of profile.vcsPli ?? []) {
    const table = await recordPliFile(entry.table, 1024 * 1024);
    const library =
      entry.library && (await recordPliFile(entry.library, 128 * 1024 * 1024));
    vcsPli.push({
      table,
      library,
      ...(table.sha256 && entry.calls ? { calls: entry.calls } : {}),
    });
  }
  const traceLibrary =
    profile.vcsTraceLibrary &&
    (await recordPliFile(profile.vcsTraceLibrary, 128 * 1024 * 1024));
  return {
    executable: path.dirname(rebuild.filelist).slice(0, -".daidir".length),
    build: {
      schemaVersion: 1,
      format: "wave-workbench-build",
      roots,
      include_dirs: profile.includeDirectories,
      defines: profile.defines,
      top_modules: profile.topModules,
      parameter_overrides: profile.parameterOverrides,
      default_timescale: profile.defaultTimescale,
      library_files: libraries,
      library_maps: profile.libraryMaps,
      source_libraries: profile.sourceLibraries,
      compilation_units: profile.compilationUnits,
      compilation_unit_options: profile.compilationUnitOptions,
      files,
      files_complete: filesComplete,
      vcs_pli: vcsPli.length ? vcsPli : undefined,
      vcs_trace_library: traceLibrary,
      unsupported: profile.unsupported,
    },
    assertCurrent: async () => {
      if (!(await simulationFilelistsCurrent(inputs)))
        throw Error("The VCS rebuild inputs changed during the simulation.");
    },
  };
}

async function main() {
  const separator = process.argv.indexOf("--", 2);
  const command = separator === -1 ? [] : process.argv.slice(separator + 1);
  const { values } = parseArgs({
    args: process.argv.slice(2, separator === -1 ? undefined : separator),
    options: {
      manifest: { type: "string" },
      "vcs-kdb": { type: "string" },
      waveform: { type: "string" },
      input: { type: "string", multiple: true },
    },
  });
  if (
    (!values.manifest && !values["vcs-kdb"]) ||
    !values.waveform ||
    !command.length
  )
    throw Error(
      "Usage: node scripts/record-trace-run.mjs [--manifest BUILD.json] [--vcs-kdb SIMV.daidir] --waveform OUTPUT [--input STIMULUS] -- SIMULATOR [ARG ...]",
    );

  const cwd = process.cwd();
  const filename = path.resolve(values.waveform) + ".wave-build.json";
  const reference =
    values.manifest && (await readBuildTemplate(values.manifest));
  const vcs =
    values["vcs-kdb"] && (await readVcsBuild(values["vcs-kdb"], reference));

  const files = await Promise.all(
    [
      ...new Set((values.input ?? []).map((file) => path.resolve(cwd, file))),
    ].map(async (file) => ({ path: file, sha256: await sha256(file) })),
  );
  const previous = await fingerprint(values.waveform);
  const [executable, ...args] = command;
  // A wrapper or a different binary can still record a waveform, but cannot
  // attest that this particular elaborated VCS executable produced it.
  const harnessPath = path.resolve(cwd, executable);
  const harness =
    vcs && (path.isAbsolute(executable) || executable.includes(path.sep))
      ? await realpath(harnessPath).catch(() => undefined)
      : undefined;
  const expectedHarness =
    vcs && (await realpath(vcs.executable).catch(() => undefined));
  const harnessSha256 =
    harness && harness === expectedHarness ? await sha256(harness) : undefined;
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

  await vcs?.assertCurrent();
  if (
    harnessSha256 &&
    ((await realpath(harnessPath)) !== harness ||
      (await sha256(harness)) !== harnessSha256)
  )
    throw Error("The VCS executable changed during the simulation.");
  const manifest = {
    ...(vcs?.build ?? reference),
    ...(vcs ? { harnessSha256 } : {}),
    waveformSha256,
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
