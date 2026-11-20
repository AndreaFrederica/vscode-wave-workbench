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
  const harnessSha256 = digest("harness");
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
