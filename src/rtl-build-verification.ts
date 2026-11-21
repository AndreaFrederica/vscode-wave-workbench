// SPDX-License-Identifier: MPL-2.0

import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { VerilatorArtifacts } from "./kdb";
import { waveformHash } from "./rtl-execution";
import { normalizeRtlTimescale, scaleSeconds } from "./shared/time";
import type { VideTrace } from "./rtl-trace";

export interface TraceRuntimeInputs {
  workingDirectory: string;
  plusargs?: readonly string[];
  files?: readonly { path: string; sha256?: string }[];
}

type PliFile = { path: string; sha256?: string };
type VcsPli = { table: PliFile; library?: PliFile; calls?: string[] };
export const vcsPliExecutionGap =
  "External VCS PLI callback execution was not verified.";
export type VcsPliVerification = {
  table: PliFile & {
    identity: "matched" | "mismatched" | "missing" | "unverified";
  };
  library?: VcsPliVerification["table"];
  calls?: string[];
};

interface BuildManifestData {
  schemaVersion: 1;
  format: "wave-workbench-build";
  waveformSha256: string;
  harnessSha256?: string;
  verilatorArtifacts?: VerilatorArtifacts;
  roots: string[];
  compilation_units?: string[][];
  compilation_unit_options?: { defines?: string[]; include_dirs?: string[] }[];
  library_files?: string[];
  library_maps?: string[];
  source_libraries?: { path: string; name: string }[];
  files: { path: string; sha256: string }[];
  files_complete?: boolean;
  vcs_pli?: VcsPli[];
  vcs_trace_library?: PliFile;
  include_dirs: string[];
  top_modules: string[];
  parameter_overrides?: string[];
  default_timescale?: string;
  defines: string[];
  unsupported?: string[];
  runtime?: {
    workingDirectory: string;
    plusargs?: string[];
    files?: { path: string; sha256: string }[];
  };
}

export type TraceBuildManifest = BuildManifestData & { filename: string };

const hash = /^[a-f0-9]{64}$/;
const validStrings = (values: unknown): values is string[] =>
  Array.isArray(values) &&
  values.length <= 16384 &&
  values.every((value) => typeof value === "string");

const validFiles = (files: unknown): files is BuildManifestData["files"] =>
  Array.isArray(files) &&
  files.length <= 16384 &&
  files.every(
    (file) =>
      file &&
      typeof file.path === "string" &&
      typeof file.sha256 === "string" &&
      hash.test(file.sha256),
  );

function isManifest(value: unknown): value is BuildManifestData {
  const manifest = value as BuildManifestData;
  const validPliFile = (file: PliFile | undefined) =>
    !!file &&
    typeof file.path === "string" &&
    file.path.length > 0 &&
    (file.sha256 === undefined ||
      (typeof file.sha256 === "string" && hash.test(file.sha256)));
  return (
    !!manifest &&
    manifest.schemaVersion === 1 &&
    manifest.format === "wave-workbench-build" &&
    typeof manifest.waveformSha256 === "string" &&
    hash.test(manifest.waveformSha256) &&
    (manifest.harnessSha256 === undefined ||
      (typeof manifest.harnessSha256 === "string" &&
        hash.test(manifest.harnessSha256))) &&
    (manifest.verilatorArtifacts === undefined ||
      (!!manifest.verilatorArtifacts &&
        typeof manifest.verilatorArtifacts.treeSha256 === "string" &&
        hash.test(manifest.verilatorArtifacts.treeSha256) &&
        typeof manifest.verilatorArtifacts.metadataSha256 === "string" &&
        hash.test(manifest.verilatorArtifacts.metadataSha256))) &&
    validStrings(manifest.roots) &&
    (manifest.compilation_units === undefined ||
      (Array.isArray(manifest.compilation_units) &&
        manifest.compilation_units.length <= manifest.roots.length &&
        manifest.compilation_units.every(
          (unit) => validStrings(unit) && unit.length > 0,
        ) &&
        JSON.stringify(manifest.compilation_units.flat()) ===
          JSON.stringify(manifest.roots))) &&
    (manifest.compilation_unit_options === undefined ||
      (Array.isArray(manifest.compilation_unit_options) &&
        manifest.compilation_unit_options.length ===
          manifest.compilation_units?.length &&
        manifest.compilation_unit_options.every(
          (unit) =>
            unit &&
            typeof unit === "object" &&
            !Array.isArray(unit) &&
            (unit.defines === undefined || validStrings(unit.defines)) &&
            (unit.include_dirs === undefined ||
              validStrings(unit.include_dirs)),
        ))) &&
    (manifest.library_files === undefined ||
      validStrings(manifest.library_files)) &&
    (manifest.library_maps === undefined ||
      validStrings(manifest.library_maps)) &&
    (manifest.source_libraries === undefined ||
      (Array.isArray(manifest.source_libraries) &&
        manifest.source_libraries.length <= 16384 &&
        manifest.source_libraries.every(
          (source) =>
            source &&
            typeof source.path === "string" &&
            typeof source.name === "string" &&
            source.name.trim().length > 0,
        ))) &&
    validStrings(manifest.include_dirs) &&
    validStrings(manifest.top_modules) &&
    (manifest.parameter_overrides === undefined ||
      validStrings(manifest.parameter_overrides)) &&
    (manifest.default_timescale === undefined ||
      (typeof manifest.default_timescale === "string" &&
        normalizeRtlTimescale(manifest.default_timescale) !== undefined)) &&
    validStrings(manifest.defines) &&
    (manifest.unsupported === undefined ||
      validStrings(manifest.unsupported)) &&
    (manifest.files_complete === undefined ||
      typeof manifest.files_complete === "boolean") &&
    validFiles(manifest.files) &&
    (manifest.vcs_trace_library === undefined ||
      validPliFile(manifest.vcs_trace_library)) &&
    (manifest.vcs_pli === undefined ||
      (Array.isArray(manifest.vcs_pli) &&
        manifest.vcs_pli.length <= 128 &&
        manifest.vcs_pli.every(
          (entry) =>
            entry &&
            validPliFile(entry.table) &&
            (entry.library === undefined || validPliFile(entry.library)) &&
            (entry.calls === undefined ||
              (Array.isArray(entry.calls) &&
                entry.calls.length <= 512 &&
                entry.calls.every(
                  (name) =>
                    typeof name === "string" &&
                    /^\$[A-Za-z_][\w$]*$/.test(name),
                ))),
        ))) &&
    (manifest.runtime === undefined ||
      (!!manifest.runtime &&
        typeof manifest.runtime.workingDirectory === "string" &&
        manifest.runtime.workingDirectory.length > 0 &&
        (manifest.runtime.plusargs === undefined ||
          (validStrings(manifest.runtime.plusargs) &&
            manifest.runtime.plusargs.every((arg) => arg.startsWith("+")))) &&
        (manifest.runtime.files === undefined ||
          validFiles(manifest.runtime.files))))
  );
}

export async function readTraceBuildManifest(
  filename: string,
): Promise<TraceBuildManifest> {
  const attributes = await stat(filename);
  if (!attributes.isFile() || attributes.size > 8 * 1024 * 1024)
    throw Error("Invalid trace build manifest.");
  const input: unknown = JSON.parse(await readFile(filename, "utf8"));
  if (!isManifest(input)) throw Error("Unsupported trace build manifest.");
  const base = path.dirname(filename);
  const expectedPath = (name: string) => path.resolve(base, name);
  const workingDirectory =
    input.runtime && expectedPath(input.runtime.workingDirectory);
  return {
    ...input,
    filename,
    default_timescale: input.default_timescale
      ? normalizeRtlTimescale(input.default_timescale)
      : undefined,
    roots: input.roots.map(expectedPath),
    compilation_units: input.compilation_units?.map((unit) =>
      unit.map(expectedPath),
    ),
    compilation_unit_options: input.compilation_unit_options?.map((unit) => ({
      ...unit,
      include_dirs: unit.include_dirs?.map(expectedPath),
    })),
    library_files: input.library_files?.map(expectedPath),
    library_maps: input.library_maps?.map(expectedPath),
    source_libraries: input.source_libraries?.map((source) => ({
      ...source,
      path: expectedPath(source.path),
    })),
    include_dirs: input.include_dirs.map(expectedPath),
    files: input.files.map((file) => ({
      ...file,
      path: expectedPath(file.path),
    })),
    vcs_trace_library: input.vcs_trace_library && {
      ...input.vcs_trace_library,
      path: expectedPath(input.vcs_trace_library.path),
    },
    vcs_pli: input.vcs_pli?.map(({ table, library, calls }) => ({
      table: { ...table, path: expectedPath(table.path) },
      library: library && { ...library, path: expectedPath(library.path) },
      calls,
    })),
    runtime:
      input.runtime && workingDirectory
        ? {
            ...input.runtime,
            workingDirectory,
            files: input.runtime.files?.map((file) => ({
              ...file,
              path: path.resolve(workingDirectory, file.path),
            })),
          }
        : undefined,
  };
}

export async function readAdjacentTraceBuildManifest(waveform: string) {
  const filename = waveform + ".wave-build.json";
  let manifest: TraceBuildManifest;
  try {
    manifest = await readTraceBuildManifest(filename);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if ((await waveformHash(waveform)) !== manifest.waveformSha256)
    throw Error(
      "The adjacent trace build manifest belongs to a different waveform. Choose a simulation filelist or update " +
        filename,
    );
  return manifest;
}

export function verilatorArtifactMismatches(
  expected: VerilatorArtifacts | undefined,
  actual: VerilatorArtifacts | undefined,
) {
  if (!expected) return [];
  if (!actual) return ["Missing Verilator elaboration tree"];
  const differences: string[] = [];
  if (expected.treeSha256 !== actual.treeSha256)
    differences.push("Verilator elaboration tree SHA-256");
  if (expected.metadataSha256 !== actual.metadataSha256)
    differences.push("Verilator elaboration metadata SHA-256");
  return differences;
}

async function verifyVcsLibraryFile(
  file: PliFile,
): Promise<VcsPliVerification["table"]> {
  let identity: VcsPliVerification["table"]["identity"] = "unverified";
  try {
    const attributes = await stat(file.path);
    if (
      file.sha256 &&
      attributes.isFile() &&
      attributes.size <= 128 * 1024 * 1024
    )
      identity =
        (await waveformHash(file.path)) === file.sha256
          ? "matched"
          : "mismatched";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      identity = "missing";
  }
  return { ...file, identity };
}

async function verifyVcsPli(
  configured: readonly VcsPli[],
): Promise<VcsPliVerification[]> {
  return Promise.all(
    configured.map(async ({ table, library, calls }) => ({
      table: await verifyVcsLibraryFile(table),
      ...(library ? { library: await verifyVcsLibraryFile(library) } : {}),
      ...(calls?.length ? { calls } : {}),
    })),
  );
}

export async function verifyTraceBuild(
  manifest: TraceBuildManifest,
  waveform: string,
  actual: VideTrace["compilation"],
  openDocuments: ReadonlyMap<string, string>,
  compilationLimitations: readonly string[] = [],
  verilatorArtifacts?: VerilatorArtifacts,
) {
  const limitations = [...compilationLimitations];
  const filesComplete =
    manifest.files_complete ??
    !manifest.unsupported?.includes(
      "Header hashes unavailable from VCS rebuild metadata",
    );
  if (!filesComplete) limitations.push("Incomplete build file hash inventory");
  const mismatches = verilatorArtifactMismatches(
    manifest.verilatorArtifacts,
    verilatorArtifacts,
  );
  const same = (left: string[], right: string[]) =>
    left.length === right.length &&
    left.every((entry, index) => entry === right[index]);
  const canonical = (name: string) =>
    realpath(name).catch(() => path.resolve(name));

  if ((await waveformHash(waveform)) !== manifest.waveformSha256)
    mismatches.push("Waveform SHA-256");
  if (manifest.unsupported?.length) limitations.push(...manifest.unsupported);
  if (!actual) limitations.push("VIDE did not return its compilation profile.");
  else {
    if (!actual.complete)
      limitations.push(
        "VIDE reported missing sources or incomplete include resolution.",
      );
    if (!same(actual.defines, manifest.defines))
      mismatches.push("Predefined macros");
    if (!same(actual.topModules, manifest.top_modules))
      mismatches.push("Top modules");
    if (
      !same(actual.parameterOverrides ?? [], manifest.parameter_overrides ?? [])
    )
      mismatches.push("Parameter overrides");
    if (manifest.default_timescale !== undefined) {
      if (actual.defaultTimescale !== manifest.default_timescale)
        mismatches.push("Default RTL timescale");
    } else if (actual.defaultTimescale !== undefined) {
      limitations.push("Build manifest omits the default RTL timescale.");
    }
    const rootPaths = await Promise.all(
      actual.roots.map((uri) => canonical(fileURLToPath(uri))),
    );
    const expectedRoots = await Promise.all(manifest.roots.map(canonical));
    if (!same(rootPaths, expectedRoots))
      mismatches.push("Ordered compilation roots");
    const actualUnits = actual.compilationUnits
      ? await Promise.all(
          actual.compilationUnits.map((unit) =>
            Promise.all(unit.map((uri) => canonical(fileURLToPath(uri)))),
          ),
        )
      : rootPaths.map((file) => [file]);
    const expectedUnits = manifest.compilation_units
      ? await Promise.all(
          manifest.compilation_units.map((unit) =>
            Promise.all(unit.map(canonical)),
          ),
        )
      : expectedRoots.map((file) => [file]);
    const sameUnits =
      JSON.stringify(actualUnits) === JSON.stringify(expectedUnits);
    if (!sameUnits) mismatches.push("Compilation unit grouping");
    const expectedOptions = await Promise.all(
      expectedUnits.map(async (_, index) => {
        const unit = manifest.compilation_unit_options?.[index];
        return [
          unit?.defines ?? [],
          await Promise.all((unit?.include_dirs ?? []).map(canonical)),
        ];
      }),
    );
    const actualOptions = await Promise.all(
      actualUnits.map(async (_, index) => {
        const unit = actual.compilationUnitOptions?.[index];
        return [
          unit?.defines ?? [],
          await Promise.all((unit?.includeDirs ?? []).map(canonical)),
        ];
      }),
    );
    if (
      sameUnits &&
      JSON.stringify(actualOptions) !== JSON.stringify(expectedOptions)
    )
      mismatches.push("Compilation unit preprocessing options");
    const actualLibraries = await Promise.all(
      (actual.libraryFiles ?? []).map((uri) => canonical(fileURLToPath(uri))),
    );
    const expectedLibraries = await Promise.all(
      (manifest.library_files ?? []).map(canonical),
    );
    if (!same(actualLibraries, expectedLibraries))
      mismatches.push("Ordered library files");
    const actualMaps = await Promise.all(
      (actual.libraryMaps ?? []).map((uri) => canonical(fileURLToPath(uri))),
    );
    const expectedMaps = await Promise.all(
      (manifest.library_maps ?? []).map(canonical),
    );
    if (!same(actualMaps, expectedMaps)) mismatches.push("Library maps");
    const expectedNamed = new Map(
      await Promise.all(
        (manifest.source_libraries ?? []).map(
          async (source) =>
            [await canonical(source.path), source.name] as const,
        ),
      ),
    );
    const actualNamed = new Map(
      await Promise.all(
        (actual.sourceLibraries ?? []).map(
          async (source) =>
            [await canonical(fileURLToPath(source.path)), source.name] as const,
        ),
      ),
    );
    if (
      [...new Set([...expectedNamed.keys(), ...actualNamed.keys()])].some(
        (file) =>
          (expectedNamed.get(file) ?? "work") !==
          (actualNamed.get(file) ?? "work"),
      )
    )
      mismatches.push("Named source libraries");
    const includePaths = await Promise.all(actual.includeDirs.map(canonical));
    const expectedIncludes = await Promise.all(
      manifest.include_dirs.map(canonical),
    );
    if (!same(includePaths, expectedIncludes)) mismatches.push("Include paths");
    const actualFiles = new Set(
      await Promise.all(
        actual.files.map((uri) => canonical(fileURLToPath(uri))),
      ),
    );
    const expectedFiles = new Set(
      await Promise.all(manifest.files.map(({ path }) => canonical(path))),
    );
    if (
      [...expectedFiles].some((file) => !actualFiles.has(file)) ||
      (filesComplete && actualFiles.size !== expectedFiles.size)
    )
      mismatches.push("Compilation and include file set");
    if (!filesComplete) {
      for (const file of [...actualFiles].sort()) {
        if (!expectedFiles.has(file))
          limitations.push("No build hash for compilation file " + file);
      }
    }
  }

  for (const file of manifest.files) {
    const filename = file.path;
    const current =
      openDocuments.get(filename) ??
      openDocuments.get(await canonical(filename));
    try {
      const attributes = await stat(filename);
      if (!attributes.isFile() || attributes.size > 16 * 1024 * 1024) {
        limitations.push("Source exceeds verification limit " + filename);
        continue;
      }
      const contents = current ?? (await readFile(filename));
      const currentHash = createHash("sha256").update(contents).digest("hex");
      if (currentHash !== file.sha256)
        mismatches.push("Changed source " + filename);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      mismatches.push("Missing source " + filename);
    }
  }
  const vcsPli = await verifyVcsPli(manifest.vcs_pli ?? []);
  if (vcsPli.length) limitations.push(vcsPliExecutionGap);
  const vcsTraceLibrary =
    manifest.vcs_trace_library &&
    (await verifyVcsLibraryFile(manifest.vcs_trace_library));
  if (vcsTraceLibrary && vcsTraceLibrary.identity !== "matched")
    limitations.push(
      `VCS trace library identity ${vcsTraceLibrary.identity}: ${vcsTraceLibrary.path}`,
    );
  const status: "matched" | "mismatched" | "unverified" = mismatches.length
    ? "mismatched"
    : limitations.length
      ? "unverified"
      : "matched";
  return {
    status,
    mismatches,
    limitations: [...new Set(limitations)],
    ...(vcsPli.length ? { vcsPli } : {}),
    ...(vcsTraceLibrary ? { vcsTraceLibrary } : {}),
  };
}

export function verifyLiveTraceBuild(
  manifest: TraceBuildManifest | undefined,
  build: Awaited<ReturnType<typeof verifyTraceBuild>> | undefined,
  harnessSha256: string | undefined,
  liveScale: string,
  waveformScale: string,
  elaboration: VerilatorArtifacts | undefined,
  mismatchedDesign: boolean,
) {
  const mismatches = [...(build?.mismatches ?? [])];
  const limitations = [...(build?.limitations ?? [])];
  if (mismatchedDesign && !mismatches.length)
    mismatches.push("Selected design differs from the build manifest");
  if (!manifest || !build)
    limitations.push("No reference simulation build manifest.");
  else if (!manifest.harnessSha256)
    limitations.push("Build manifest omits the live harness SHA-256.");
  else if (!harnessSha256)
    limitations.push("Live harness identity was unavailable at launch.");
  else if (manifest.harnessSha256 !== harnessSha256)
    mismatches.push("Live harness SHA-256");
  if (manifest && elaboration && !manifest.verilatorArtifacts)
    limitations.push(
      "Build manifest omits the Verilator elaboration artifact hashes.",
    );
  try {
    const live = scaleSeconds(liveScale);
    const waveform = scaleSeconds(waveformScale);
    if (!Number.isFinite(live) || !Number.isFinite(waveform))
      throw Error("Unsupported scale");
    if (
      Math.abs(live - waveform) >
      Math.max(live, waveform) * Number.EPSILON * 4
    )
      mismatches.push("Live harness and waveform tick units");
  } catch {
    limitations.push(
      "Cannot compare the live harness and waveform tick units.",
    );
  }
  // An instrumented subset can be compared event by event even when other
  // PLI callbacks remain outside the capture scope.
  const scopedPliReplay =
    !!manifest?.runtime?.plusargs &&
    !!manifest.runtime.files &&
    build?.vcsTraceLibrary?.identity === "matched" &&
    !!build.vcsPli?.length &&
    build.vcsPli.every(
      ({ table, library }) =>
        table.identity === "matched" && library?.identity === "matched",
    ) &&
    limitations.length === 1 &&
    limitations[0] === vcsPliExecutionGap;
  return {
    status: mismatches.length
      ? ("mismatched" as const)
      : limitations.length
        ? ("unverified" as const)
        : ("matched" as const),
    mismatches,
    limitations,
    executionReplayEligible:
      !mismatches.length && (!limitations.length || scopedPliReplay),
    ...(build?.vcsPli ? { vcsPli: build.vcsPli } : {}),
    ...(build?.vcsTraceLibrary
      ? { vcsTraceLibrary: build.vcsTraceLibrary }
      : {}),
  };
}
