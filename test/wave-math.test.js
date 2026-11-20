// SPDX-License-Identifier: MPL-2.0
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { chmod, mkdtemp, rm, writeFile } = require("node:fs/promises");
const { existsSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { Backend } = require("../dist/backend");
const { serializeClip } = require("../dist/wave-clip");
const { scaleHertz } = require("../dist/shared/time");
const {
  compileWaveExpression, numericSamples, calculateWave, filterWave,
  waveSpectrum, spectrumRaw,
} = require("../dist/wave-math");
const { convertWave, runWaveOperator, validateOperatorOutput } = require("../dist/wave-operator");
const binary = path.resolve("bin/wave-backend-independent" + (process.platform === "win32" ? ".exe" : ""));

function workdir(t) {
  return mkdtemp(path.join(tmpdir(), "wave-math-")).then((dir) => {
    t.after(() => rm(dir, { recursive: true, force: true }));
    return dir;
  });
}

test("arithmetic aligns asynchronous real and digital events and preserves unknowns", () => {
  const expression = compileWaveExpression("max(A, -2) + B * 2^2", 2);
  const real = numericSamples([["0", "0.5"], ["3", "-4"], ["8", "-0.5"]], { real: true }, false);
  const digital = numericSamples([["0", "00"], ["5", "11"], ["6", "xz"], ["9", "10"]], { width: 2 }, true);
  assert.deepEqual(calculateWave(expression, [real, digital], 1n, 10n, 1, "pointwise", 12n), [
    ["1", "0.5"], ["3", "-2"], ["5", "-6"], ["6", "NaN"], ["9", "-8.5"], ["11", "NaN"],
  ]);
  assert.throws(() => compileWaveExpression("process.exit()", 1), /未知操作数/);
  assert.throws(() => compileWaveExpression("sqrt(A, 2)", 1), /表达式/);
  assert.equal(compileWaveExpression("-2^2 + 2^-2", 1)([]), -3.75);
  assert.deepEqual(filterWave([{ tick: 0n, value: 0 }, { tick: 2n, value: 1 }], 0n, 4n, 1, Math.log(2) / (2 * Math.PI), 1n, 4n), [
    ["0", "0"], ["3", "0.5"], ["4", "0.75"],
  ]);
});

test("ADC and DAC use configured external edges, delay, or periodic sampling", () => {
  const request = {
    apiVersion: 1, start: "2", end: "20", secondsPerTick: 1, options: {},
    inputs: [
      { kind: "real", events: [["0", "0.1"], ["6", "0.8"], ["12", "2"], ["16", "NaN"]] },
      { kind: "digital", width: 1, events: [["1", "0"], ["2", "1"], ["7", "0"], ["9", "1"], ["12", "0"], ["17", "x"], ["18", "1"]] },
    ],
  };
  const adc = convertWave("adc", request, 3, 0, 1, { mode: "external", delay: 1n, threshold: 0.5, edge: "rising" });
  assert.deepEqual(adc.events, [["2", "xxx"], ["3", "001"], ["10", "110"]]);
  const trigger = { kind: "real", events: [["0", "0"], ["4", "3"], ["8", "1"], ["10", "3"], ["11", "1"], ["15", "3"], ["16", "1"]] };
  const dac = convertWave("dac", { ...request, inputs: [adc, trigger] }, 3, 0, 7,
    { mode: "external", delay: 2n, threshold: 2, edge: "falling" });
  assert.deepEqual(dac.events, [["2", "NaN"], ["10", "1"], ["13", "6"]]);
  const periodic = convertWave("adc", { ...request, inputs: [request.inputs[0]] }, 3, 0, 1,
    { mode: "periodic", period: 5n, offset: 1n, delay: 1n });
  assert.deepEqual(periodic.events, [["2", "xxx"], ["4", "001"], ["9", "110"], ["14", "111"], ["19", "xxx"]]);
});

test("known sine amplitude, phase and PSD reach the reopened frequency waveform", { skip: !existsSync(binary) }, async (t) => {
  const size = 128;
  const bin = 8;
  const samples = Array.from({ length: size }, (_, i) => ({
    tick: BigInt(i), value: 1.5 + 3 * Math.sin(2 * Math.PI * bin * i / size),
  }));
  for (const window of ["rectangular", "hann", "hamming", "blackman"]) {
    const spectrum = waveSpectrum(samples, 0n, 128n, 1e-6, size, window, "hold", true);
    assert(Math.abs(spectrum.bins[bin].amplitude - 3) < 1e-12, window);
    assert(Math.abs(spectrum.bins[bin].phase + 90) < 1e-12, window);
    assert(spectrum.bins[0].amplitude < 1e-12);
    const power = spectrum.bins.reduce((sum, entry) => sum + entry.density * spectrum.binWidth, 0);
    assert(Math.abs(power - 4.5) < 1e-10, window);
  }
  const spectrum = waveSpectrum(samples, 0n, 128n, 1e-6, size, "hann", "hold", false);
  const dir = await workdir(t);
  const file = path.join(dir, "tone.raw");
  await writeFile(file, spectrumRaw(spectrum, "tone", "V"));
  const backend = new Backend(binary, { args: ["--independent"], useVerdiLibraries: false });
  t.after(() => backend.dispose());
  const meta = await backend.request("open", { path: file });
  assert.equal(meta.axis, "frequency");
  assert.equal(meta.end, "64");
  assert.equal(meta.signals[2].unit, "V²/Hz");
  assert(Math.abs(scaleHertz(meta.scale) * bin - 62_500) < 1e-8);
  const block = (await backend.request("query", { signals: ["0"], start: "8", end: "8", limit: 10 }))["0"];
  assert(Math.abs(Number(block.events[0][1]) - 3) < 1e-12);
  const csv = serializeClip({ timescale: meta.scale, traces: [{ path: "ac.amplitude", real: true, unit: "V", ...block }] }, "csv");
  assert(csv.includes("frequency_hz"));
  assert(Math.abs(Number(csv.trim().split(",").at(-1)) - 62_500) < 1e-8);
});

test("sampled real virtuals restore and support random time queries", { skip: !existsSync(binary) }, async (t) => {
  const dir = await workdir(t);
  const file = path.join(dir, "source.vcd");
  await writeFile(file, "$timescale 1ns $end\n$scope module tb $end\n$var wire 1 ! q $end\n$upscope $end\n$enddefinitions $end\n#0\n0!\n#20\n1!\n");
  const backend = new Backend(binary, { args: ["--independent"], useVerdiLibraries: false });
  t.after(() => backend.dispose());
  await backend.request("open", { path: file });
  const definition = { op: "samples", inputs: [], width: 64, real: true, source: "math:test",
    samples: [["1", "10"], ["3", "-0.5"], ["9", "NaN"], ["14", "2.5"]] };
  const first = await backend.request("defineVirtual", { name: "calculated", definition });
  assert.equal(first.signal.real, true);
  await backend.request("open", { path: file });
  const { signal } = await backend.request("defineVirtual", { name: first.signal.name, definition: first.signal.definition });
  assert.equal(signal.id, first.signal.id);
  const block = (await backend.request("query", { signals: [signal.id], start: "8", end: "10", limit: 10 }))[signal.id];
  assert.deepEqual(block.events, [["3", "-0.5"], ["9", "NaN"]]);
});

test("JavaScript and native operator adapters exchange the same versioned payload", async (t) => {
  const dir = await workdir(t);
  const request = {
    apiVersion: 1, start: "0", end: "4", secondsPerTick: 1,
    options: { gain: 3 }, inputs: [{ kind: "real", events: [["0", "1.5"], ["4", "2"]] }],
  };
  const body = 'const apply = ({ inputs, options }) => ({ kind: "real", events: inputs[0].events.map(([t,v]) => [t, String(Number(v)*options.gain)]) });\n';
  const js = path.join(dir, "gain.mjs");
  await writeFile(js, body + "export default apply;\n");
  const expected = { kind: "real", events: [["0", "4.5"], ["4", "6"]] };
  assert.deepEqual(validateOperatorOutput(await runWaveOperator("javascript", js, request), request), expected);
  if (process.platform !== "win32") {
    const exe = path.join(dir, "gain");
    await writeFile(exe, "#!/usr/bin/env node\n" + body + 'process.stdout.write(JSON.stringify(apply(JSON.parse(require("node:fs").readFileSync(0,"utf8")))));\n');
    await chmod(exe, 0o700);
    assert.deepEqual(validateOperatorOutput(await runWaveOperator("native", exe, request), request), expected);
  }
  assert.throws(() => validateOperatorOutput({ kind: "digital", width: 2, events: [["1", "01"], ["1", "10"]] }, request), /严格递增/);
});
