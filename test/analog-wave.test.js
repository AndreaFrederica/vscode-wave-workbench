// SPDX-License-Identifier: MPL-2.0

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { Backend } = require("../dist/backend");
const { DecoderScheduler } = require("../dist/decoder-runtime/scheduler");
const { measureAnalog, thresholdSamples } = require("../dist/shared/analog");
const { traceSchematic } = require("../dist/rtl-schematic");

const binary = path.resolve(
  "bin/wave-backend-independent" + (process.platform === "win32" ? ".exe" : ""),
);
const fixture =
  [
    "$timescale 1ns $end",
    "$scope module tb $end",
    "$var real 64 ! voltage $end",
    '$var wire 1 " ready $end',
    "$upscope $end",
    "$enddefinitions $end",
    "#0",
    "r-0.125 !",
    '0"',
    "#4",
    "r1.25e-1 !",
    "#9",
    "r0.9 !",
    '1"',
    "#16",
    "r0.75 !",
    "#17",
  ].join("\n") + "\n";

test("real measurements weight irregular samples and expose missing coverage", () => {
  const events = [
    ["0", "2"],
    ["3", "NaN"],
    ["9", "6"],
  ];
  assert.deepEqual(measureAnalog(events, 0n, 10n), {
    min: 2,
    max: 6,
    peakToPeak: 4,
    mean: 3,
    rms: Math.sqrt(12),
    coveredTicks: "4",
    durationTicks: "10",
  });
  assert.deepEqual(
    thresholdSamples(
      [
        ["0", "-0.1"],
        ["1", "0.5"],
        ["2", "0.8"],
        ["2", "0.6"],
        ["3", "NaN"],
        ["4", "0.5"],
        ["5", "0.2"],
      ],
      0.3,
      0.7,
    ),
    [
      ["0", "0"],
      ["2", "1"],
      ["3", "x"],
      ["5", "0"],
    ],
  );
});

test(
  "VCD and FST keep real values and digital values on one time axis",
  { skip: !existsSync(binary) },
  async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wave-real-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const file = path.join(directory, "mixed.vcd");
    const fst = path.join(directory, "mixed.fst");
    await fs.writeFile(file, fixture);
    const conversion = spawnSync("vcd2fst", [file, fst]);
    for (const input of conversion.status === 0 ? [file, fst] : [file]) {
      const backend = new Backend(binary, { useVerdiLibraries: false });
      t.after(() => backend.dispose());
      const meta = await backend.request("open", { path: input });
      const [real, digital] = meta.signals;
      assert.equal(real.real, true);
      assert.equal(digital.real, undefined);
      const result = await backend.request("query", {
        signals: [real.id, digital.id],
        start: "5",
        end: "16",
        limit: 20,
      });
      assert.deepEqual(
        result[real.id].events.map(([time, value]) => [time, Number(value)]),
        [
          ["4", 0.125],
          ["9", 0.9],
          ["16", 0.75],
        ],
      );
      assert.deepEqual(result[digital.id].events, [
        ["0", "0"],
        ["9", "1"],
      ]);
      for (const engine of ["javascript", "lua"]) {
        const source =
          engine === "lua"
            ? `return {decode = function(ctx, state, batch)
        local value
        for _, sample in ipairs(batch.events) do
          if sample.input == 0 then value = sample.real end
          if sample.input == 1 and sample.value == "1" and value == 0.9 then
            ctx.emit({start = sample.tick, ["end"] = "10", label = "sampled"})
          end
        end
      end}`
            : `module.exports = {decode(ctx, state, batch) {
        let value; for (const sample of batch.events()) {
          if (sample.input === 0) value = sample.real;
          if (sample.input === 1 && sample.value === "1" && value === 0.9)
            ctx.emit({start: sample.tick, end: "10", label: "sampled"});
        }
      }};`;
        const decoded = await new DecoderScheduler(binary).decode({
          provider: { backend, meta },
          definition: {
            hash: engine,
            manifest: {
              apiVersion: 1,
              id: "mixed",
              name: "Mixed",
              version: "1",
              engine,
              inputs: [
                { id: "voltage", real: true },
                { id: "ready", width: 1 },
              ],
            },
            source,
          },
          bindings: [real, digital],
          start: "0",
          end: "17",
        });
        assert.deepEqual(decoded.transactions, [
          { start: "9", end: "10", label: "sampled" },
        ]);
      }
    }
  },
);

test("schematic preserves signal direction and distinguishes control connections", () => {
  const location = {
    uri: "file:///fixture.sv",
    range: { start: { line: 4, character: 0 } },
  };
  const { graph } = traceSchematic({
    root: 3,
    diagnostics: [],
    frontier: [],
    signals: [
      { id: 1, name: "clk", declaration: location },
      { id: 2, name: "data", declaration: location },
      { id: 3, name: "q", declaration: location },
    ],
    assignments: [
      {
        location,
        kind: "nonblocking",
        targets: [3],
        inputs: [
          { signal: 1, kind: "trigger", edge: "rising" },
          { signal: 2, kind: "data" },
        ],
      },
    ],
  });
  assert.equal(
    graph.nodes.find((node) => node.kind === "register")?.label,
    "DFF",
  );
  assert.deepEqual(graph.edges, [
    { from: "signal-1", to: "assignment-0", control: true },
    { from: "signal-2", to: "assignment-0", control: false },
    { from: "assignment-0", to: "signal-3" },
  ]);
});

test(
  "independent FSDB real windows agree with VCD from the same simulation",
  {
    skip:
      !existsSync(binary) ||
      !process.env.WAVE_TEST_ANALOG_FSDB ||
      !process.env.WAVE_TEST_ANALOG_VCD,
  },
  async (t) => {
    const readers = [
      new Backend(binary, {
        args: ["--independent"],
        useVerdiLibraries: false,
      }),
      new Backend(binary, { useVerdiLibraries: false }),
    ];
    for (const reader of readers) t.after(() => reader.dispose());
    const [fsdb, vcd] = await Promise.all([
      readers[0].request("open", { path: process.env.WAVE_TEST_ANALOG_FSDB }),
      readers[1].request("open", { path: process.env.WAVE_TEST_ANALOG_VCD }),
    ]);
    assert.equal(fsdb.backend, "rust-independent-fsdb");
    const maxTime = BigInt(fsdb.end);
    const windows = [
      [0n, maxTime, 5000],
      [maxTime / 3n, maxTime, 5000],
      [1n, maxTime, 3],
    ];
    const expected = new Map(
      vcd.signals.map((signal) => [signal.name, signal]),
    );
    async function query(reader, signal, from, to, limit) {
      const block = (
        await reader.request("query", {
          signals: [signal.id],
          start: String(from),
          end: String(to),
          limit,
        })
      )[signal.id];
      return {
        ...block,
        events: signal.real
          ? block.events.map(([tick, value]) => [tick, Number(value)])
          : block.events,
      };
    }
    assert(fsdb.signals.some((signal) => signal.real && signal.supported));
    for (const signal of fsdb.signals) {
      if (!signal.supported) continue;
      const peer = expected.get(signal.name);
      assert(peer, signal.name);
      assert.equal(signal.real, peer.real);
      for (const [from, to, limit] of windows) {
        const a = await query(readers[0], signal, from, to, limit);
        const b = await query(readers[1], peer, from, to, limit);
        if (signal.scope === "many_real" && signal.name === "c") {
          // VCS writes the shortreal field in its VCD dump as bits interpreted
          // as a real number. The testbench and the SDK agree on these samples.
          const samples = [[0n, 1.25]];
          for (let j = 4; j <= 400; j += 4)
            samples.push([1n + BigInt((j * (j + 1)) / 2), j / 2]);
          const first = Math.max(
            0,
            samples.filter(([tick]) => tick <= from).length - 1,
          );
          const events = samples.slice(first).filter(([tick]) => tick <= to);
          assert.deepEqual(a, {
            events: events
              .slice(0, limit)
              .map(([tick, value]) => [String(tick), value]),
            truncated: events.length > limit,
          });
        } else {
          assert.deepEqual(a, b, [signal.name, from, to, limit].join(" "));
        }
      }
    }
  },
);
