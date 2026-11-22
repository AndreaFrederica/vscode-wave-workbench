// SPDX-License-Identifier: MPL-2.0

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { test } = require("node:test");
const { readAdjacentTraceBuildManifest, readTraceBuildManifest, verifyLiveTraceBuild, verifyTraceBuild } = require("../dist/rtl-build-verification");
const { traceRuntimeInputs } = require("../dist/rtl-runtime-inputs");

test("trace provenance compares waveform hashes, effective compilation and dirty files", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "trace-provenance-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const waveform = path.join(directory, "trace.fst");
  const source = path.join(directory, "tb.sv");
  const prelude = path.join(directory, "prelude.sv");
  const library = path.join(directory, "cell.v");
  const manifest = path.join(directory, "build.json");
  const sourceText = "module tb; endmodule\n";
  const preludeText = "typedef logic word_t;\n";
  const libraryText = "module cell; endmodule\n";
  const digest = (contents) => createHash("sha256").update(contents).digest("hex");
  await fs.writeFile(waveform, "fixture");
  await fs.writeFile(source, sourceText);
  await fs.writeFile(prelude, preludeText);
  await fs.writeFile(library, libraryText);
  const configuration = {
    schemaVersion: 1, format: "wave-workbench-build", waveformSha256: digest("fixture"),
    roots: ["prelude.sv", "tb.sv"], compilation_units: [["prelude.sv", "tb.sv"]],
    compilation_unit_options: [{ defines: ["UNIT=1"], include_dirs: ["unit-include"] }],
    library_files: ["cell.v"],
    source_libraries: [{ path: "cell.v", name: "cells" }],
    files: [{ path: "prelude.sv", sha256: digest(preludeText) }, { path: "tb.sv", sha256: digest(sourceText) }, { path: "cell.v", sha256: digest(libraryText) }],
    include_dirs: ["."], top_modules: ["tb"], defines: ["SIM=1"], parameter_overrides: ["Mode=1"],
  };
  await fs.writeFile(manifest, JSON.stringify(configuration));
  assert.equal(await readAdjacentTraceBuildManifest(waveform), undefined);
  await fs.copyFile(manifest, waveform + ".wave-build.json");
  assert.equal((await readAdjacentTraceBuildManifest(waveform)).filename, waveform + ".wave-build.json");
  const sourceUri = pathToFileURL(source).href;
  const preludeUri = pathToFileURL(prelude).href;
  const libraryUri = pathToFileURL(library).href;
  const effective = {
    roots: [preludeUri, sourceUri], compilationUnits: [[preludeUri, sourceUri]],
    compilationUnitOptions: [{ defines: ["UNIT=1"], includeDirs: [path.join(directory, "unit-include")] }],
    libraryFiles: [libraryUri], files: [preludeUri, sourceUri, libraryUri], includeDirs: [directory],
    sourceLibraries: [{ path: libraryUri, name: "cells" }],
    topModules: ["tb"], defines: ["SIM=1"], parameterOverrides: ["Mode=1"], complete: true,
  };
  const loaded = await readTraceBuildManifest(manifest);
  assert.deepEqual(loaded.roots, [prelude, source]);
  assert.deepEqual(loaded.compilation_units, [[prelude, source]]);
  assert.deepEqual(loaded.library_files, [library]);
  assert.deepEqual(loaded.include_dirs, [directory]);
  assert.equal(loaded.files[0].path, prelude);
  const verify = (profile, open = new Map()) => verifyTraceBuild(loaded, waveform, profile, open);
  const verified = await verify(effective);
  assert.equal(verified.status, "matched");
  const pli = [
    { table: { path: "tasks.tab", sha256: digest("original") },
      library: { path: "task.o", sha256: digest("original library") },
      calls: ["$drive"] },
    { table: { path: "missing.tab" } },
  ];
  await fs.writeFile(path.join(directory, "tasks.tab"), "original");
  await fs.writeFile(path.join(directory, "task.o"), "changed library");
  await fs.writeFile(manifest, JSON.stringify({ ...configuration, vcs_pli: pli }));
  const loadedPli = await readTraceBuildManifest(manifest);
  const checkedPli = await verifyTraceBuild(loadedPli, waveform, effective, new Map());
  assert.equal(checkedPli.status, "unverified");
  assert.deepEqual(checkedPli.mismatches, []);
  assert.deepEqual(checkedPli.vcsPli.map(({ table, library }) => [table.identity, library?.identity]),
    [["matched", "mismatched"], ["missing", undefined]]);
  assert.deepEqual(checkedPli.vcsPli[0].calls, ["$drive"]);
  const harnessSha256 = digest("harness");
  const traceLibrary = path.join(directory, "wave_vpi.so");
  await fs.writeFile(path.join(directory, "task.o"), "original library");
  await fs.writeFile(traceLibrary, "trace library");
  await fs.writeFile(manifest, JSON.stringify({
    ...configuration, harnessSha256, vcs_pli: [pli[0]],
    vcs_trace_library: { path: "wave_vpi.so", sha256: digest("trace library") },
    runtime: { workingDirectory: ".", plusargs: [], files: [] },
  }));
  const scopedManifest = await readTraceBuildManifest(manifest);
  const verifyScopedBuild = (limitations = []) =>
    verifyTraceBuild(scopedManifest, waveform, effective, new Map(), limitations);
  const verifyScopedLive = (build, harness = harnessSha256, recorded = scopedManifest) =>
    verifyLiveTraceBuild(recorded, build, harness, "1ps", "1ps", undefined, false);
  const scoped = await verifyScopedBuild();
  assert.equal(scoped.vcsTraceLibrary.path, traceLibrary);
  assert.equal(verifyScopedLive(scoped).status, "unverified");
  assert.equal(verifyScopedLive(scoped).executionReplayEligible, true);
  assert.equal(verifyScopedLive(scoped, digest("other")).executionReplayEligible, false);
  assert.equal(verifyScopedLive(scoped, harnessSha256, { ...scopedManifest, runtime: undefined }).executionReplayEligible, false);
  assert.equal(verifyScopedLive(await verifyScopedBuild(["Unmapped VCS option"])).executionReplayEligible, false);
  await fs.writeFile(path.join(directory, "task.o"), "changed library");
  assert.equal(verifyScopedLive(await verifyScopedBuild()).executionReplayEligible, false);
  await fs.writeFile(path.join(directory, "task.o"), "original library");
  await fs.writeFile(traceLibrary, "changed recorder");
  const changedRecorder = await verifyScopedBuild();
  assert.equal(changedRecorder.vcsTraceLibrary.identity, "mismatched");
  assert.equal(verifyScopedLive(changedRecorder).executionReplayEligible, false);
  await fs.writeFile(manifest, JSON.stringify({ ...configuration, harnessSha256 }));
  const liveBuild = await readTraceBuildManifest(manifest);
  assert.equal(liveBuild.harnessSha256, harnessSha256);
  assert.equal(verifyLiveTraceBuild(liveBuild, verified, harnessSha256, "1000fs", "1ps", undefined, false).status, "matched");
  assert.deepEqual(verifyLiveTraceBuild(liveBuild, verified, digest("other"), "1ns", "1ps", undefined, false).mismatches,
    ["Live harness SHA-256", "Live harness and waveform tick units"]);
  assert.equal(verifyLiveTraceBuild(loaded, verified, harnessSha256, "1ps", "1ps", undefined, false).status, "unverified");
  assert.deepEqual((await verify({
    ...effective, sourceLibraries: [{path: libraryUri, name: "other"}],
  })).mismatches, ["Named source libraries"]);
  assert.deepEqual((await verify({ ...effective, compilationUnits: undefined })).mismatches, ["Compilation unit grouping"]);
  assert.deepEqual((await verify({
    ...effective, compilationUnitOptions: [{ ...effective.compilationUnitOptions[0], defines: ["UNIT=0"] }],
  })).mismatches, ["Compilation unit preprocessing options"]);
  assert.deepEqual((await verify({ ...effective, libraryFiles: [] })).mismatches, ["Ordered library files"]);
  assert.equal((await verify(undefined)).status, "unverified");
  assert.deepEqual((await verify({ ...effective, parameterOverrides: ["Mode=0"] })).mismatches, ["Parameter overrides"]);
  const legacyTimescale = await verify({ ...effective, defaultTimescale: "1ns/1ps" });
  assert.equal(legacyTimescale.status, "unverified");
  assert.deepEqual(legacyTimescale.limitations, ["Build manifest omits the default RTL timescale."]);
  await fs.writeFile(manifest, JSON.stringify({ ...configuration, default_timescale: "1 ns / 1 ps" }));
  const withTimescale = await readTraceBuildManifest(manifest);
  assert.equal(withTimescale.default_timescale, "1ns/1ps");
  const verifyScale = (defaultTimescale) =>
    verifyTraceBuild(withTimescale, waveform, { ...effective, defaultTimescale }, new Map());
  assert.equal((await verifyScale("1ns/1ps")).status, "matched");
  assert.deepEqual((await verifyScale("1ns/10ps")).mismatches, ["Default RTL timescale"]);
  await fs.writeFile(manifest, JSON.stringify({ ...configuration, default_timescale: "1ps/1ns" }));
  await assert.rejects(readTraceBuildManifest(manifest), /Unsupported trace build manifest/);
  for (const schemaVersion of [undefined, 0, 2, "1"]) {
    await fs.writeFile(manifest, JSON.stringify({ ...configuration, schemaVersion }));
    await assert.rejects(readTraceBuildManifest(manifest), /Unsupported trace build manifest/);
  }
  const changed = await verify({ ...effective, defines: ["SIM=2"] }, new Map([[source, "module edited; endmodule\n"]]));
  assert.equal(changed.status, "mismatched");
  assert.ok(changed.mismatches.includes("Predefined macros"));
  assert.ok(changed.mismatches.some((item) => item.startsWith("Changed source ")));
  const artifacts = { treeSha256: digest("tree"), metadataSha256: digest("metadata") };
  await fs.writeFile(manifest, JSON.stringify({ ...configuration, verilatorArtifacts: artifacts }));
  const withArtifacts = await readTraceBuildManifest(manifest);
  const verifyArtifacts = (design) => verifyTraceBuild(withArtifacts, waveform, effective, new Map(), [], design);
  assert.equal((await verifyArtifacts(artifacts)).status, "matched");
  assert.deepEqual((await verifyArtifacts(undefined)).mismatches, ["Missing Verilator elaboration tree"]);
  assert.deepEqual((await verifyArtifacts({ ...artifacts, treeSha256: digest("other") })).mismatches, ["Verilator elaboration tree SHA-256"]);
  assert.deepEqual((await verifyArtifacts({ ...artifacts, metadataSha256: digest("other") })).mismatches, ["Verilator elaboration metadata SHA-256"]);
  const include = path.join(directory, "defs.svh");
  await fs.writeFile(include, "`define IDENT 1\n");
  const withInclude = { ...effective, files: [...effective.files, pathToFileURL(include).href] };
  assert.deepEqual((await verify(withInclude)).mismatches, ["Compilation and include file set"]);
  for (const coverage of [
    { files_complete: false },
    { unsupported: ["Header hashes unavailable from VCS rebuild metadata"] },
  ]) {
    await fs.writeFile(manifest, JSON.stringify({ ...configuration, ...coverage }));
    const partial = await readTraceBuildManifest(manifest);
    const check = (actual, open = new Map()) => verifyTraceBuild(partial, waveform, actual, open);
    const incomplete = await check(withInclude);
    assert.equal(incomplete.status, "unverified");
    assert.deepEqual(incomplete.mismatches, []);
    assert(incomplete.limitations.includes("No build hash for compilation file " + include));
    assert.equal((await check(effective)).status, "unverified");
    assert.deepEqual((await check({ ...withInclude, files: withInclude.files.filter(uri => uri !== sourceUri) })).mismatches, ["Compilation and include file set"]);
    assert.deepEqual((await check({ ...withInclude, defines: ["SIM=0"] })).mismatches, ["Predefined macros"]);
    assert.deepEqual((await check(withInclude, new Map([[source, "module edited; endmodule"]]))).mismatches,
      ["Changed source " + source]);
  }
  await fs.writeFile(manifest, JSON.stringify({ ...configuration, files_complete: "false" }));
  await assert.rejects(readTraceBuildManifest(manifest), /Unsupported trace build manifest/);
  await fs.writeFile(waveform, "changed");
  assert.deepEqual((await verify(effective)).mismatches, ["Waveform SHA-256"]);
  await assert.rejects(readAdjacentTraceBuildManifest(waveform), /belongs to a different waveform/);
});

test("runtime evidence binds the first matching argument and verifies the referenced file", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "trace-run-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const digest = (contents) => createHash("sha256").update(contents).digest("hex");
  const source = path.join(directory, "tb.sv");
  const run = path.join(directory, "run");
  const stimulus = path.join(run, "firmware with spaces.bin");
  const call = '$value$plusargs("firmware=%s", filename)';
  const dynamic = '$readmemh(filename, memory)';
  await fs.mkdir(run);
  await fs.writeFile(stimulus, "firmware");
  await fs.writeFile(source, call + "\n" + dynamic + "\n");
  const filename = path.join(directory, "manifest.json");
  await fs.writeFile(filename, JSON.stringify({
    schemaVersion: 1, format: "wave-workbench-build", waveformSha256: digest("wave"),
    roots: ["tb.sv"], files: [{path: "tb.sv", sha256: digest(call + "\n" + dynamic + "\n")}],
    include_dirs: [], top_modules: ["tb"], defines: [],
    runtime: {
      workingDirectory: "run",
      plusargs: ["+firmware=firmware with spaces.bin", "+firmware=later.bin"],
      files: [{path: "firmware with spaces.bin", sha256: digest("firmware")}],
    },
  }));
  const site = (line, character) => ({
    signal: line, reason: "unresolvedRuntimeInput",
    location: {uri: pathToFileURL(source).href, range: {
      start: {line, character: 0}, end: {line, character},
    }},
  });
  const trace = {frontier: [site(0, call.length), site(0, call.length), site(1, dynamic.length)]};
  const manifest = await readTraceBuildManifest(filename);
  const [input] = await traceRuntimeInputs(manifest, trace);
  assert.deepEqual(input.argument, {present: true, value: "firmware with spaces.bin"});
  assert.deepEqual(input.file, {path: stimulus, sha256: digest("firmware"), identity: "matched"});
  assert.equal((await traceRuntimeInputs(manifest, trace)).length, 1);
  await fs.writeFile(stimulus, "changed!");
  assert.equal((await traceRuntimeInputs(manifest, trace))[0].file.identity, "mismatched");
  await fs.appendFile(source, "// changed\n");
  assert.deepEqual(await traceRuntimeInputs(manifest, trace), []);
});
