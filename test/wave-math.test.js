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
  const { measureWave } = require("../dist/wave-measurements");
  const peaks = await measureWave(backend, meta, "peaks", [meta.signals[0]], "0", meta.end);
  assert.deepEqual(peaks[1], ["62.5 kHz", "3 V"]);
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

test("integral retains slope changes and native reads interpolate between stored knots", { skip: !existsSync(binary) }, async (t) => {
  const dir = await workdir(t);
  const file = path.join(dir, "integral.vcd");
  await writeFile(file, [
    "$timescale 1ns $end", "$scope module tb $end", "$var real 64 ! voltage $end",
    "$upscope $end", "$enddefinitions $end", "#0", "r0 !", "#5", "r2 !", "#20",
  ].join("\n") + "\n");
  const backend = new Backend(binary, { args: ["--independent"], useVerdiLibraries: false });
  t.after(() => backend.dispose());
  const meta = await backend.request("open", { path: file });
  const { runWaveMath } = require("../dist/wave-math-runtime");
  const result = await runWaveMath({ backend, meta }, "integral", ["/tb/voltage"],
    "0", "20", { name: "area" }, dir, true, new AbortController().signal);
  const definition = result.signal.definition;
  assert.equal(definition.linear, true);
  assert.deepEqual(definition.samples.map(([tick]) => tick), ["0", "5", "20"]);
  await backend.request("open", { path: file });
  const { signal } = await backend.request("defineVirtual", { name: "area", definition });
  assert.equal(signal.id, result.signal.id);
  const query = (start, end) => backend.request("query", { signals: [signal.id], start, end, limit: 20 }).then(block => block[signal.id].events);
  const events = await query("2", "11");
  assert.deepEqual(events.map(([tick]) => tick), ["2", "5", "11"]);
  assert.equal(Number(events[0][1]), 0);
  assert.ok(Math.abs(Number(events[2][1]) - 12e-9) < 1e-18);
  assert.ok(Math.abs(Number((await query("8", "8"))[0][1]) - 6e-9) < 1e-18);
  const { measureWave } = require("../dist/wave-measurements");
  const edge = await measureWave(backend, meta, "edges", [meta.signals[0]], "0", "5");
  assert.equal(edge.find(([name]) => name === "上升时间")[1], "4 ns · 1 次");
  const measured = await measureWave(backend, meta, "analog", [signal], "5", "20");
  assert.equal(measured.find(([name]) => name.endsWith("均值"))[1], "1.5e-8");
  assert.equal(measured.find(([name]) => name.endsWith("RMS"))[1], "1.7320508e-8");
});

test("scope measurements use duration weights and interpolate real threshold crossings", { skip: !existsSync(binary) }, async (t) => {
  const dir = await workdir(t);
  const file = path.join(dir, "measure.vcd");
  await writeFile(file, [
    "$timescale 1ns $end", "$scope module tb $end",
    "$var real 64 ! signal $end", '$var wire 1 " clock $end',
    "$upscope $end", "$enddefinitions $end",
    "#0", "r-2 !", '0"', "#3", '1"', "#4", "r2 !", "#7", '0"',
    "#8", "r-2 !", "#11", '1"', "#12", "r2 !", "#15", '0"', "#16", "r-2 !",
  ].join("\n") + "\n");
  const backend = new Backend(binary, { args: ["--independent"], useVerdiLibraries: false });
  t.after(() => backend.dispose());
  const meta = await backend.request("open", { path: file });
  const { measureWave } = require("../dist/wave-measurements");
  const measure = async (operation, operands) =>
    new Map(await measureWave(backend, meta, operation, operands, "0", "16"));
  const signal = meta.signals.find(({ name }) => name === "signal");
  const clock = meta.signals.find(({ name }) => name === "clock");
  const analog = await measure("analog", [signal]);
  assert.equal(analog.get("signal · 标准差"), "2");
  assert.equal(analog.get("signal · 中位数"), "-2");
  assert.equal(analog.get("signal · DC 正面积"), "1.6e-8 单位·s");
  assert.equal(analog.get("signal · AC 绝对面积"), "3.2e-8 单位·s");
  assert.equal(analog.get("signal · 首周期均值"), "0");
  const timing = await measure("pulse", [signal]);
  assert.deepEqual(await measure("timing", [signal]), timing);
  assert.equal(timing.get("平均周期"), "8 ns");
  assert.equal(timing.get("平均高脉宽"), "4 ns");
  assert.equal(timing.get("高电平占空比"), "50 %");
  assert.equal(timing.get("上升沿"), "2");
  const edges = await measure("edges", [signal]);
  assert.equal(edges.get("上升时间"), "3.2 ns · 2 次");
  const delay = await measure("delay", [signal, clock]);
  assert.equal(delay.get("相位（目标滞后为正）"), "45 °");
  assert.equal(delay.get("最小建立时间 · 上升沿"), "1 ns");
  assert.equal(delay.get("最小保持时间 · 上升沿"), "3 ns");
});

test("dense real measurements read past the backend event limit", { skip: !existsSync(binary) }, async (t) => {
  const dir = await workdir(t);
  const file = path.join(dir, "dense-real.vcd");
  const end = 100_104;
  const events = [];
  for (let tick = 0; tick <= end; tick++)
    events.push("#" + tick, "r" + (tick % 2 ? -2 : 2) + " !");
  await writeFile(file, [
    "$timescale 1ns $end", "$scope module tb $end", "$var real 64 ! v $end",
    "$upscope $end", "$enddefinitions $end", ...events,
  ].join("\n") + "\n");
  const backend = new Backend(binary, { args: ["--independent"], useVerdiLibraries: false });
  t.after(() => backend.dispose());
  const meta = await backend.request("open", { path: file });
  const [signal] = meta.signals;
  const { measureWave } = require("../dist/wave-measurements");
  const run = async (operation) =>
    new Map(await measureWave(backend, meta, operation, [signal], "0", String(end)));
  assert.equal((await run("cursors")).get("v"), "A 2 · B 2");
  const timing = await run("pulse");
  assert.equal(timing.get("上升沿"), String(end / 2));
  assert.equal(timing.get("下降沿"), String(end / 2));
  assert.equal(timing.get("平均周期"), "2 ns");
  assert.equal(timing.get("高电平占空比"), "50 %");
  const amplitude = await run("analog");
  assert.equal(amplitude.get("v · 有效覆盖"), end + " / " + end + " tick");
  assert.equal(amplitude.get("v · DC 绝对面积"), "0.000200208 单位·s");
});
