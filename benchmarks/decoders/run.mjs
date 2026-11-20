// SPDX-License-Identifier: MPL-2.0

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

const require = createRequire(import.meta.url);
const { Backend } = require("../../dist/backend");
const { builtinRuntime } = require("../../dist/decoder-runtime/builtin");
const { packEvents } = require("../../dist/decoder-runtime/event-batch");
const { decoderRegistry } = require("../../dist/decoder-runtime/registry");
const { DecoderScheduler } = require("../../dist/decoder-runtime/scheduler");
const {
  javascriptRuntime,
  luaRuntime,
} = require("../../dist/decoder-runtime/script-runtimes");

const sizes = (process.env.WAVE_DECODER_BENCH_SIZES ?? "10000,100000,1000000")
  .split(",")
  .map(Number);
const seed = 0x3952e84b;
const maxReplayEvents = 1_000_000;
const repeats = Number(process.env.WAVE_DECODER_BENCH_REPEATS ?? 3);
assert(
  sizes.every(
    (size) => Number.isInteger(size) && size > 0 && size <= 10_000_000,
  ),
);
assert(Number.isInteger(repeats) && repeats >= 2 && repeats <= 20);
const binary =
  process.env.WAVE_TEST_DECODER_BINARY ??
  path.resolve(
    "bin/wave-backend-independent" +
      (process.platform === "win32" ? ".exe" : ""),
  );
const output = path.resolve(
  process.env.WAVE_DECODER_BENCH_OUTPUT ?? "benchmarks/decoders/results",
);
const profile = {
  id: "word",
  label: "Word",
  width: 8,
  rules: [{ mask: "255", value: "170", label: "word 0xaa" }],
};
const { definitions, warnings } = await decoderRegistry(
  [profile],
  path.resolve("examples"),
);
assert.deepEqual(warnings, []);
const context = {
  scale: "1ns",
  options: {},
  inputs: [{ id: "data", width: 8 }],
};
const scratch = await mkdtemp(path.join(os.tmpdir(), "wave-decoder-bench-"));

function value(index) {
  if (index % 257 === 0) return "10101010";
  const word = Math.imul(index ^ seed, 0x9e3779b1) >>> 0;
  return (word >>> 24) & 1 ? "00000001" : "00000000";
}

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const quantile = (fraction) =>
    +sorted[Math.ceil(sorted.length * fraction) - 1].toFixed(3);
  return { p50: quantile(0.5), p95: quantile(0.95), p99: quantile(0.99) };
}

try {
  const results = [];
  for (const events of sizes) {
    const filename = path.join(scratch, events + ".vcd");
    const stream =
      events <= maxReplayEvents ? createWriteStream(filename) : undefined;
    const sha = createHash("sha256");
    const append = async (text) => {
      sha.update(text);
      if (stream && !stream.write(text)) await once(stream, "drain");
    };
    await append(
      "$timescale 1ns $end\n$scope module tb $end\n$var wire 8 ! data [7:0] $end\n$upscope $end\n$enddefinitions $end\n",
    );
    for (let start = 0; start < events; start += 4096) {
      const entries = Math.min(4096, events - start);
      await append(
        Array.from(
          { length: entries },
          (_, i) => "#" + (start + i) + "\nb" + value(start + i) + " !\n",
        ).join(""),
      );
    }
    if (stream) {
      stream.end();
      await once(stream, "finish");
    }
    const datasetSha256 = sha.digest("hex");
    const backend = stream && new Backend(binary, { useVerdiLibraries: false });
    try {
      const meta = await backend?.request("open", { path: filename });
      let reference;
      for (const id of ["word", "example.lua.word", "example.js.word"]) {
        const definition = definitions.get(id);
        let scriptMs = 0;
        let preparationMs = 0;
        const onExecution = (ms, prepare = 0) => {
          scriptMs += ms;
          preparationMs += prepare;
        };
        const instantiate = async (signal) =>
          definition.profile
            ? builtinRuntime(profile, context)
            : definition.manifest.engine === "lua"
              ? luaRuntime(binary, definition, context, signal, onExecution)
              : javascriptRuntime(definition, context, onExecution);
        const setup = [],
          engine = [],
          inEngine = [],
          nativePreparation = [],
          boundary = [],
          endToEnd = [],
          cached = [];
        for (let attempt = 0; attempt <= repeats; ++attempt) {
          const operation = AbortSignal.timeout(90_000);
          let started = performance.now();
          const decoder = await instantiate(operation);
          try {
            // An empty batch waits for Worker module initialization and the first engine response.
            await decoder.decode(packEvents(0n, 0n, [null], []), operation);
            if (attempt) setup.push(performance.now() - started);
            let elapsed = 0;
            scriptMs = 0;
            preparationMs = 0;
            const all = [];
            for (let first = 0; first < events; first += 4096) {
              const last = Math.min(first + 4096, events);
              const batch = packEvents(
                BigInt(first),
                BigInt(last),
                [null],
                Array.from({ length: last - first }, (_, n) => ({
                  input: 0,
                  tick: String(first + n),
                  value: value(first + n),
                })),
              );
              started = performance.now();
              all.push(
                ...(await decoder.decode(batch, operation)).transactions,
              );
              elapsed += performance.now() - started;
            }
            started = performance.now();
            all.push(...(await decoder.flush(operation)).transactions);
            elapsed += performance.now() - started;
            if (attempt) {
              engine.push(elapsed);
              const execution = definition.profile ? elapsed : scriptMs;
              inEngine.push(execution);
              if (definition.manifest.engine === "lua")
                nativePreparation.push(preparationMs);
              boundary.push(Math.max(0, elapsed - execution));
            }
            if (reference) assert.deepEqual(all, reference);
            else reference = all;
          } finally {
            decoder.dispose();
          }
          if (!meta) continue;
          const scheduler = new DecoderScheduler(binary);
          const request = {
            provider: { backend, meta },
            definition,
            bindings: [meta.signals[0]],
            start: "0",
            end: String(events),
          };
          started = performance.now();
          const result = await scheduler.decode(request);
          if (attempt) endToEnd.push(performance.now() - started);
          assert.equal(result.truncated, false);
          assert.deepEqual(result.transactions, reference);
          started = performance.now();
          await scheduler.decode(request);
          if (attempt) cached.push(performance.now() - started);
        }
        results.push({
          engine: definition.manifest.engine,
          events,
          transactions: reference.length,
          datasetSha256,
          setupMs: stats(setup),
          batchExecutionAndTransportMs: stats(engine),
          engineExecutionMs: stats(inEngine),
          luaPreparationMs: nativePreparation.length
            ? stats(nativePreparation)
            : null,
          boundaryAndPreparationMs: stats(boundary),
          transactionsPerSecond: Math.round(
            (reference.length / stats(engine).p50) * 1000,
          ),
          endToEndMs: endToEnd.length ? stats(endToEnd) : null,
          cachedResultMs: cached.length ? stats(cached) : null,
          hostPeakRssKiB: process.resourceUsage().maxRSS,
          eventsPerSecond: Math.round((events / stats(engine).p50) * 1000),
        });
      }
    } finally {
      backend?.dispose();
    }
  }
  const report = {
    revision: execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
    dirty: Boolean(
      execFileSync("git", ["status", "--porcelain"], {
        encoding: "utf8",
      }).trim(),
    ),
    os: os.type() + " " + os.release(),
    arch: os.arch(),
    cpu: os.cpus()[0].model,
    seed,
    rust:
      spawnSync(process.env.RUSTC || "rustc", ["--version"], {
        encoding: "utf8",
      }).stdout?.trim() || "unavailable",
    node: process.version,
    v8: process.versions.v8,
    lua: "LuaJIT 2.1 via mlua 0.12.2 built with Cargo --release",
    eventBatchVersion: 1,
    repeats,
    warmup: 1,
    scenario: "equivalent eight-bit rule with stateful interval accumulation",
    results,
  };
  const table = [
    "| Events | Engine | Startup p50 ms | Engine p50 ms | Boundary p50 ms | E2E p50 ms | Cache p50 ms | Events/s |",
    "|---:|---|---:|---:|---:|---:|---:|---:|",
    ...results.map(
      (row) =>
        "| " +
        [
          row.events,
          row.engine,
          row.setupMs.p50,
          row.engineExecutionMs.p50,
          row.boundaryAndPreparationMs.p50,
          row.endToEndMs?.p50 ?? "N/A",
          row.cachedResultMs?.p50 ?? "N/A",
          row.eventsPerSecond,
        ].join(" | ") +
        " |",
    ),
  ];
  await mkdir(output, { recursive: true });
  await writeFile(
    path.join(output, "results.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  await writeFile(
    path.join(output, "results.md"),
    [
      "# Decoder benchmark",
      "",
      report.os + " · " + report.arch + " · " + report.cpu,
      "",
      report.node + " · V8 " + report.v8 + " · " + report.lua,
      "",
      "All three engines produced the same transaction list before timing was reported.",
      "The engine metric measures the script call and its event API. Boundary is the remaining measured batch time, including preparation, validation and Worker messages or Lua IPC. E2E includes reading the VCD through the Rust backend.",
      "The Builtin engine runs in the measuring process and reports its batch time as engine time.",
      "The JSON report also records time spent materializing the Lua event table and reading the binary columns inside the decoder.",
      "Each row has " +
        report.repeats +
        " measured runs after " +
        report.warmup +
        " warm-up. E2E opens a fresh scheduler while native waveform caching is shared within each dataset.",
      "E2E and cache are N/A above the one-million-event production replay budget.",
      "UI rendering, child-process RSS, and protocol-specific workloads are outside this benchmark.",
      "",
      ...table,
      "",
    ].join("\n"),
  );
  process.stdout.write(table.join("\n") + "\n");
} finally {
  await rm(scratch, { recursive: true, force: true });
}
