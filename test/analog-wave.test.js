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
const { readTraceObservations } = require("../dist/rtl-trace-observations");
const { traceAssignmentCandidates } = require("../dist/rtl-trace-candidates");

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

async function openAnalog(t, filename, env) {
  const backend = new Backend(binary, { args: ["--independent"], useVerdiLibraries: false, env });
  t.after(() => backend.dispose());
  const meta = await backend.request("open", { path: filename });
  return {
    backend,
    meta,
    async window(signal, start = meta.start, end = meta.end, limit = 5000) {
      return (await backend.request("query", {
        signals: [signal.id], start, end, limit,
      }))[signal.id];
    },
  };
}

test("Trace preserves integer real samples without evaluating them as bits", {
  skip: !existsSync(binary),
}, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wave-real-trace-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, "integer-real.vcd");
  await fs.writeFile(filename, fixture.replace("r0.9 !", "r10 !"));
  const { backend, meta } = await openAnalog(t, filename);
  const voltage = meta.signals.find(({ name }) => name === "voltage");
  const ready = meta.signals.find(({ name }) => name === "ready");
  const evidence = await readTraceObservations(
    backend, meta, new Map([[0, voltage], [1, ready]]), "9", "0", 0,
  );
  const [real, digital] = evidence.observations;
  assert.equal(real.real, true);
  assert.equal(real.value, "10");
  assert.deepEqual(real.history.at(-1), { tick: "9", value: "10" });
  assert.equal(digital.value, "1");
  const trace = {
    root: 0,
    assignments: [{
      kind: "continuous",
      targets: [0],
      inputs: [],
      value: { op: "literal", args: ["10", false] },
    }],
  };
  const result = traceAssignmentCandidates(trace, evidence);
  assert.deepEqual(result.change, { tick: "9", value: "10" });
  assert.equal(result.candidates[0].status, "possible");
  assert.equal(result.candidates[0].value, undefined);
});

for (const [variable, reader] of [["WAVE_TEST_ANALOG_SHM", "shm-lib"], ["WAVE_TEST_ANALOG_WDB", "wdb-lib"]]) {
  test(`${reader} reads real and digital samples with the same clock`, {
    skip: !process.env[variable] || !existsSync(binary),
  }, async (t) => {
    const wave = await openAnalog(t, process.env[variable]);
    const { backend, meta } = wave;
    assert.equal(meta.backend, reader);
    assert.equal(meta.scale, "1ns");
    const voltage = meta.signals.find(({ name }) => name === "voltage");
    const ready = meta.signals.find(({ name }) => name === "ready");
    assert.equal(voltage.real, true);
    assert.equal(ready.real, undefined);
    assert.deepEqual((await wave.window(voltage)).events, [
      ["0", "-0.125"], ["4", "0.125"], ["9", "0.9"], ["16", "0.75"],
    ]);
    assert.deepEqual((await wave.window(ready)).events, [["0", "0"], ["9", "1"]]);
    assert.deepEqual(await wave.window(voltage, "5", "16", 2), {
      events: [["4", "0.125"], ["9", "0.9"]], truncated: true,
    });
    const evidence = await readTraceObservations(
      backend, meta, new Map([[0, voltage], [1, ready]]), "9", "0", 0,
    );
    assert.deepEqual(
      evidence.observations.map(({ real, value, history }) => [real, value, history.at(-1)]),
      [
        [true, "0.9", { tick: "9", value: "0.9" }],
        [undefined, "1", { tick: "9", value: "1" }],
      ],
    );
  });
}

test("Spectre transient PSF ASCII preserves voltage values and units", {
  skip: !process.env.WAVE_TEST_ANALOG_PSF || !existsSync(binary),
}, async (t) => {
  const wave = await openAnalog(t, process.env.WAVE_TEST_ANALOG_PSF);
  const out = wave.meta.signals.find(({ name }) => name === "out");
  assert.equal(wave.meta.backend, "rust-psfascii");
  assert.equal(wave.meta.scale, "1fs");
  assert.equal(out.unit, "V");
  const history = await wave.window(out);
  assert.equal(history.truncated, false);
  assert.equal(history.events[0][1], "0");
  assert.equal(history.events.at(-1)[0], "20000000");
  const result = measureAnalog(history.events, 0n, 20000000n);
  assert(result.max > .9 && result.max < 1.01);
  const { serializeClip } = require("../dist/wave-clip");
  const csv = serializeClip({
    waveform: process.env.WAVE_TEST_ANALOG_PSF,
    timescale: wave.meta.scale, start: "0", end: "20000000",
    traces: [{ ...out, label: out.name, path: "tran.out", ...history }],
  }, "csv");
  assert.match(csv, /20000000,"1fs","[^"]+",false,real,"V"/);
});

test("ngspice ASCII and binary agree for transient and complex AC", {
  skip: !process.env.WAVE_TEST_NGSPICE_DIR || !existsSync(binary),
}, async (t) => {
  for (const [kind, scale] of [["tran", "1fs"], ["ac", "1mHz"]]) {
    const [ascii, binary] = await Promise.all(
      ["ascii", "binary"].map(format => openAnalog(t, path.join(
        process.env.WAVE_TEST_NGSPICE_DIR, `${kind}-${format}.raw`,
      ))),
    );
    assert.equal(ascii.meta.scale, scale);
    assert.deepEqual(ascii.meta.signals, binary.meta.signals);
    for (const signal of ascii.meta.signals) {
      const [left, right] = await Promise.all([
        ascii.window(signal), binary.window(signal),
      ]);
      assert.deepEqual(left.events.map(([tick]) => tick), right.events.map(([tick]) => tick));
      left.events.forEach(([, value], index) => {
        assert(Math.abs(Number(value) - Number(right.events[index][1])) <= 1e-13);
      });
    }
    if (kind === "ac") {
      const omegaRC = 2 * Math.PI * 1e9 * 1e-9;
      for (const [name, expected] of [
        ["v(out).re", 1 / (1 + omegaRC ** 2)],
        ["v(out).im", -omegaRC / (1 + omegaRC ** 2)],
      ]) {
        const signal = ascii.meta.signals.find(s => s.name === name);
        const sample = (await ascii.window(signal, ascii.meta.end)).events.at(-1);
        assert(Math.abs(Number(sample[1]) - expected) <= 1e-12);
      }
    }
  }
});
