// SPDX-License-Identifier: MPL-2.0
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs/promises");
const { existsSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Backend } = require("../dist/backend");
const { decoderRegistry } = require("../dist/decoder-runtime/registry");
const { DecoderScheduler } = require("../dist/decoder-runtime/scheduler");
const { packEvents, scriptEvents } = require("../dist/decoder-runtime/event-batch");
const { javascriptRuntime, luaRuntime } = require("../dist/decoder-runtime/script-runtimes");

const binary = process.env.WAVE_TEST_DECODER_BINARY ||
  path.resolve(__dirname, "../bin/wave-backend-independent" + (process.platform === "win32" ? ".exe" : ""));
const profile = { id: "word", label: "Word", width: 8, rules: [{ mask: "255", value: "170", label: "word 0xaa" }] };

test("decoder batch preserves wide four-state samples and timestamps beyond u64", () => {
  const time = 2n ** 79n;
  const bits = "01xz".repeat(128);
  const events = [...scriptEvents(packEvents(time, time + 1n, [null, null], [
    { tick: String(time), input: 0, value: bits },
    { tick: String(time), input: 1, value: "z" },
  ])).events()];
  assert.equal(events[0].value, bits);
  assert.equal(events[0].tick, String(time));
  assert.deepEqual(events.map(event => event.input), [0, 1]);
});

test("three engines agree on a real VCD across windows and checkpoints", { skip: !existsSync(binary) }, async t => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "wave-decoder-test-"));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const filename = path.join(tmp, "data.vcd");
  await fs.writeFile(filename, '$timescale 1ns $end\n$scope module tb $end\n$var wire 8 ! data [7:0] $end\n$upscope $end\n$enddefinitions $end\n#0\nb00000000 !\n#2\nb10101010 !\n#8\nbxxxxzzzz !\n#9\nb10101010 !\n#10\nb00000000 !\n');
  const backend = new Backend(binary, { useVerdiLibraries: false });
  t.after(() => backend.dispose());
  const meta = await backend.request("open", { path: filename });
  const { definitions, warnings } = await decoderRegistry([profile], path.resolve(__dirname, "../examples"));
  assert.deepEqual(warnings, []);
  const scheduler = new DecoderScheduler(binary);
  const base = { provider: { backend, meta }, bindings: [meta.signals[0]] };
  for (const id of ["word", "example.js.word", "example.lua.word"]) {
    const definition = definitions.get(id);
    assert(definition);
    const decode = (start, end) => scheduler.decode({ ...base, definition, start, end });
    const expected = { start: "2", end: "8", label: "word 0xaa" };
    assert.deepEqual((await decode("3", "5")).transactions, [expected]);
    assert.deepEqual((await decode("4", "7")).transactions, [expected]);
    assert.deepEqual((await decode("7", "10")).transactions,
      [expected, { start: "9", end: "10", label: "word 0xaa" }]);
    assert.deepEqual((await decode("8", "9")).transactions, []);
  }
});

test("endless decoder worker can be cancelled and a healthy worker can start", async () => {
  const make = source => javascriptRuntime({ source }, { inputs: [], scale: "1ns", options: {} });
  const runaway = make("module.exports = { decode() { for (;;) {} } }");
  try {
    const signal = AbortSignal.timeout(100);
    await assert.rejects(runaway.decode(packEvents(0n, 1n, [], []), signal), /cancelled/);
  } finally { runaway.dispose(); }
  const healthy = make("module.exports = { decode() {} }");
  try {
    assert.deepEqual(await healthy.decode(packEvents(0n, 1n, [], []), AbortSignal.timeout(2000)),
      { transactions: [], warnings: [], truncated: false });
  } finally { healthy.dispose(); }
});

test("Lua and JavaScript SPI decoders preserve same-tick inputs and checkpointed bytes", { skip: !existsSync(binary) }, async () => {
  const { definitions, warnings } = await decoderRegistry([], path.resolve(__dirname, "../examples"));
  assert.deepEqual(warnings, []);
  const signal = AbortSignal.timeout(3000);
  for (const [cpol, cpha] of [[0, 0], [0, 1], [1, 0], [1, 1]]) {
    const ctx = { scale: "1ns", inputs: ["clock", "mosi", "cs"].map(id => ({ id, width: 1 })), options: { cpol, cpha } };
    const active = String(1 - cpol), idle = String(cpol);
    const events = [{ input: 0, tick: "0", value: idle },
      { input: 2, tick: "0", value: "0" }];
    for (const [index, bit] of Array.from("10100101").entries()) {
      const at = 2 + index * 4;
      events.push({ input: 0, tick: String(at), value: active },
        { input: 1, tick: String(at), value: bit },
        { input: 0, tick: String(at + 1), value: idle });
    }
    for (const language of ["js", "lua"]) {
      const definition = definitions.get("example." + language + ".spi");
      const create = () => language === "lua" ? luaRuntime(binary, definition, ctx, signal) : javascriptRuntime(definition, ctx);
      let runtime = await create();
      try {
        const first = await runtime.decode(packEvents(0n, 18n, [null, null, null], events.filter(e => Number(e.tick) < 18)), signal);
        assert.deepEqual(first.transactions, []);
        const checkpoint = await runtime.saveState(signal);
        runtime.dispose();
        runtime = await create();
        await runtime.restoreState(checkpoint, signal);
        const last = await runtime.decode(packEvents(18n, 35n, [idle, "0", "0"], events.filter(e => Number(e.tick) >= 18)), signal);
        assert.deepEqual(last.transactions, [{ start: String(2 + cpha), end: String(30 + cpha), label: "0xa5" }]);
      } finally {
        runtime.dispose();
      }
    }
  }
});


test("an endless Lua decoder can be stopped without affecting a new decoder", { skip: !existsSync(binary) }, async () => {
  const context = { inputs: [], scale: "1ns", options: {} };
  const controller = new AbortController();
  const runaway = await luaRuntime(binary, { source: "return {decode = function() while true do end end}" }, context, controller.signal);
  const cancel = setTimeout(() => controller.abort(), 100);
  try {
    await assert.rejects(runaway.decode(packEvents(0n, 1n, [], []), controller.signal));
  } finally {
    clearTimeout(cancel);
    runaway.dispose();
  }
  const signal = AbortSignal.timeout(2000);
  const healthy = await luaRuntime(binary, { source: "return {decode = function() end}" }, context, signal);
  try {
    assert.deepEqual(await healthy.decode(packEvents(0n, 1n, [], []), signal),
      { transactions: [], warnings: [], truncated: false });
  } finally { healthy.dispose(); }
});
