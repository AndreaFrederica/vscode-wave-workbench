// SPDX-License-Identifier: MPL-2.0
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs/promises");
const { existsSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { eventBatchVersion } = require("../dist/decoder-runtime/types");
const { Backend } = require("../dist/backend");
const {
  decoderRegistry,
  createScriptDecoder,
} = require("../dist/decoder-runtime/registry");
const { DecoderScheduler } = require("../dist/decoder-runtime/scheduler");
const {
  binaryBatch,
  packEvents,
  scriptEvents,
} = require("../dist/decoder-runtime/event-batch");
const {
  javascriptRuntime,
  luaRuntime,
} = require("../dist/decoder-runtime/script-runtimes");

const binary =
  process.env.WAVE_TEST_DECODER_BINARY ||
  path.resolve(
    __dirname,
    "../bin/wave-backend-independent" +
      (process.platform === "win32" ? ".exe" : ""),
  );
const profile = {
  id: "word",
  label: "Word",
  width: 8,
  rules: [{ mask: "255", value: "170", label: "word 0xaa" }],
};

test("decoder batch preserves wide four-state samples and timestamps beyond u64", () => {
  const time = 2n ** 79n;
  const bits = "01xz".repeat(128);
  const events = [
    ...scriptEvents(
      packEvents(
        time,
        time + 1n,
        [null, null],
        [
          { tick: String(time), input: 0, value: bits },
          { tick: String(time), input: 1, value: "z" },
        ],
      ),
    ).events(),
  ];
  assert.equal(events[0].value, bits);
  assert.equal(events[0].tick, String(time));
  assert.deepEqual(
    events.map((event) => event.input),
    [0, 1],
  );
});

test(
  "three engines agree on a real VCD across windows and checkpoints",
  { skip: !existsSync(binary) },
  async (t) => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "wave-decoder-test-"));
    t.after(() => fs.rm(tmp, { recursive: true, force: true }));
    const filename = path.join(tmp, "data.vcd");
    await fs.writeFile(
      filename,
      "$timescale 1ns $end\n$scope module tb $end\n$var wire 8 ! data [7:0] $end\n$upscope $end\n$enddefinitions $end\n#0\nb00000000 !\n#2\nb10101010 !\n#8\nbxxxxzzzz !\n#9\nb10101010 !\n#10\nb00000000 !\n",
    );
    const backend = new Backend(binary, { useVerdiLibraries: false });
    t.after(() => backend.dispose());
    const meta = await backend.request("open", { path: filename });
    const { definitions, warnings } = await decoderRegistry(
      [profile],
      path.resolve(__dirname, "../examples"),
    );
    assert.deepEqual(warnings, []);
    const scheduler = new DecoderScheduler(binary);
    const base = { provider: { backend, meta }, bindings: [meta.signals[0]] };
    for (const id of ["word", "example.js.word", "example.lua.word"]) {
      const definition = definitions.get(id);
      assert(definition);
      const decode = (start, end) =>
        scheduler.decode({ ...base, definition, start, end });
      const expected = { start: "2", end: "8", label: "word 0xaa" };
      assert.deepEqual((await decode("3", "5")).transactions, [expected]);
      assert.deepEqual((await decode("4", "7")).transactions, [expected]);
      assert.deepEqual((await decode("7", "10")).transactions, [
        expected,
        { start: "9", end: "10", label: "word 0xaa" },
      ]);
      assert.deepEqual((await decode("8", "9")).transactions, []);
    }
  },
);

test("endless decoder worker can be cancelled and a healthy worker can start", async () => {
  const make = (source) =>
    javascriptRuntime({ source }, { inputs: [], scale: "1ns", options: {} });
  const runaway = make("module.exports = { decode() { for (;;) {} } }");
  try {
    const signal = AbortSignal.timeout(100);
    await assert.rejects(
      runaway.decode(packEvents(0n, 1n, [], []), signal),
      /cancelled/,
    );
  } finally {
    runaway.dispose();
  }
  const healthy = make("module.exports = { decode() {} }");
  try {
    assert.deepEqual(
      await healthy.decode(
        packEvents(0n, 1n, [], []),
        AbortSignal.timeout(2000),
      ),
      { transactions: [], warnings: [], truncated: false },
    );
  } finally {
    healthy.dispose();
  }
});

test(
  "Lua and JavaScript SPI decoders preserve same-tick inputs and checkpointed bytes",
  { skip: !existsSync(binary) },
  async () => {
    const { definitions, warnings } = await decoderRegistry(
      [],
      path.resolve(__dirname, "../examples"),
    );
    assert.deepEqual(warnings, []);
    const signal = AbortSignal.timeout(3000);
    for (const [cpol, cpha] of [
      [0, 0],
      [0, 1],
      [1, 0],
      [1, 1],
    ]) {
      const ctx = {
        scale: "1ns",
        inputs: ["clock", "mosi", "cs"].map((id) => ({ id, width: 1 })),
        options: { cpol, cpha },
      };
      const active = String(1 - cpol),
        idle = String(cpol);
      const events = [
        { input: 0, tick: "0", value: idle },
        { input: 2, tick: "0", value: "0" },
      ];
      for (const [index, bit] of Array.from("10100101").entries()) {
        const at = 2 + index * 4;
        events.push(
          { input: 0, tick: String(at), value: active },
          { input: 1, tick: String(at), value: bit },
          { input: 0, tick: String(at + 1), value: idle },
        );
      }
      for (const language of ["js", "lua"]) {
        const definition = definitions.get("example." + language + ".spi");
        const create = () =>
          language === "lua"
            ? luaRuntime(binary, definition, ctx, signal)
            : javascriptRuntime(definition, ctx);
        let runtime = await create();
        try {
          const first = await runtime.decode(
            packEvents(
              0n,
              18n,
              [null, null, null],
              events.filter((e) => Number(e.tick) < 18),
            ),
            signal,
          );
          assert.deepEqual(first.transactions, []);
          const checkpoint = await runtime.saveState(signal);
          runtime.dispose();
          runtime = await create();
          await runtime.restoreState(checkpoint, signal);
          const last = await runtime.decode(
            packEvents(
              18n,
              35n,
              [idle, "0", "0"],
              events.filter((e) => Number(e.tick) >= 18),
            ),
            signal,
          );
          assert.deepEqual(last.transactions, [
            { start: String(2 + cpha), end: String(30 + cpha), label: "0xa5" },
          ]);
        } finally {
          runtime.dispose();
        }
      }
    }
  },
);

test(
  "an endless Lua decoder can be stopped without affecting a new decoder",
  { skip: !existsSync(binary) },
  async () => {
    const context = { inputs: [], scale: "1ns", options: {} };
    const controller = new AbortController();
    const runaway = await luaRuntime(
      binary,
      { source: "return {decode = function() while true do end end}" },
      context,
      controller.signal,
    );
    const cancel = setTimeout(() => controller.abort(), 100);
    try {
      await assert.rejects(
        runaway.decode(packEvents(0n, 1n, [], []), controller.signal),
      );
    } finally {
      clearTimeout(cancel);
      runaway.dispose();
    }
    const signal = AbortSignal.timeout(2000);
    const healthy = await luaRuntime(
      binary,
      { source: "return {decode = function() end}" },
      context,
      signal,
    );
    try {
      assert.deepEqual(
        await healthy.decode(packEvents(0n, 1n, [], []), signal),
        { transactions: [], warnings: [], truncated: false },
      );
    } finally {
      healthy.dispose();
    }
  },
);

test("script management creates a runnable decoder and preserves an existing package", async (t) => {
  const workspace = await fs.mkdtemp(
    path.join(os.tmpdir(), "wave-decoder-workspace-"),
  );
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const filename = await createScriptDecoder(
    workspace,
    "javascript",
    "custom.test",
  );
  await assert.rejects(
    createScriptDecoder(workspace, "javascript", "custom.test"),
    /EEXIST/,
  );
  await assert.rejects(
    createScriptDecoder(workspace, "lua", "../outside"),
    /Invalid decoder ID/,
  );
  const registry = await decoderRegistry([], workspace);
  assert.deepEqual(registry.warnings, []);
  assert.equal(registry.definitions.get("custom.test").filename, filename);
  await createScriptDecoder(
    workspace,
    "javascript",
    "custom.copy",
    registry.definitions.get("custom.test"),
  );
  const updated = await decoderRegistry([], workspace);
  assert.equal(
    updated.definitions.get("custom.copy").source,
    await fs.readFile(filename, "utf8"),
  );
});

test(
  "Lua and JavaScript publish equivalent samples that restore as a virtual waveform",
  { skip: !existsSync(binary) },
  async (t) => {
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "wave-decoder-virtual-"),
    );
    t.after(() => fs.rm(workspace, { recursive: true, force: true }));
    const filename = path.join(workspace, "data.vcd");
    await fs.writeFile(
      filename,
      "$timescale 1ns $end\n$scope module tb $end\n$var wire 1 ! data $end\n$upscope $end\n$enddefinitions $end\n#0\n0!\n#2\nx!\n#8\nz!\n",
    );
    const backend = new Backend(binary, { useVerdiLibraries: false });
    t.after(() => backend.dispose());
    const meta = await backend.request("open", { path: filename });
    const scheduler = new DecoderScheduler(binary);
    const expected = [
      ["0", "0"],
      ["2", "x"],
      ["8", "z"],
    ];
    const programs = {
      javascript:
        'module.exports = { decode(ctx, _, batch) { for (const e of batch.events()) ctx.emitVirtualSample("out", 1, e.tick, e.value); } }',
      lua: 'return {decode = function(ctx, _, batch) for _, e in ipairs(batch.events) do ctx.emitVirtualSample("out", 1, e.tick, e.value) end end}',
    };
    for (const engine of Object.keys(programs)) {
      const source = programs[engine];
      const result = await scheduler.decode({
        provider: { backend, meta },
        bindings: [meta.signals[0]],
        start: "0",
        end: "9",
        definition: {
          source,
          hash: engine,
          manifest: {
            inputs: [{ id: "data" }],
            engine,
            capabilities: { virtualSignals: true },
          },
        },
      });
      assert.deepEqual(
        result.virtualSamples.map(({ tick, value }) => [tick, value]),
        expected,
      );
    }
    const definition = {
      op: "samples",
      inputs: [],
      width: 1,
      source: "test.out",
      samples: expected,
    };
    const virtual = await backend.request("defineVirtual", {
      name: "out",
      definition,
    });
    const { id } = virtual.signal;
    const state = {
      chosen: [virtual.signal],
      virtualDefinitions: virtual.definitions,
      start: 1,
      end: 7,
      cursorA: 2,
    };
    const reopened = new Backend(binary, { useVerdiLibraries: false });
    t.after(() => reopened.dispose());
    const reopenedMeta = await reopened.request("open", { path: filename });
    const { restoreView } = require("../dist/view-state");
    const restored = await restoreView(
      reopened,
      JSON.parse(JSON.stringify(state)),
      reopenedMeta,
    );
    assert.equal(restored.chosen[0].id, id);
    const trace = await reopened.request("query", {
      signals: [id],
      start: "3",
      end: "8",
      limit: 10,
    });
    assert.deepEqual(trace[id].events, [
      ["2", "x"],
      ["8", "z"],
    ]);
  },
);

test(
  "Lua and V8 read u64 and extended clocks from the same binary batch format",
  { skip: !existsSync(binary) },
  async () => {
    const ctx = {
      inputs: [
        { id: "wide", width: 512 },
        { id: "flag", width: 1 },
      ],
      options: {},
      scale: "1ns",
    };
    const scripts = {
      lua: 'return {decode = function(ctx, _, batch) for _, event in ipairs(batch.events) do ctx.emit({start = event.tick, ["end"] = batch["end"], label = event.value, fields = { input = event.input, initial = batch.initial[2] }}) end end}',
      javascript:
        "module.exports = {decode(ctx, _, batch) { for (const event of batch.events()) ctx.emit({start: event.tick, end: batch.end, label: event.value, fields: {input: event.input, initial: batch.initial[1]}}); }};",
    };
    const signal = AbortSignal.timeout(5000);
    const lua = await luaRuntime(binary, { source: scripts.lua }, ctx, signal);
    const js = javascriptRuntime({ source: scripts.javascript }, ctx);
    try {
      for (const tick of [(1n << 64n) - 1n, 1n << 79n]) {
        const initial = [null, "z"];
        const events = [
          { tick: String(tick), input: 0, value: "01xz".repeat(128) },
          { tick: String(tick), input: 1, value: "x" },
        ];
        const end = tick + 1n;
        const l = await lua.decode(
          packEvents(tick, end, initial, events),
          signal,
        );
        const v = await js.decode(
          packEvents(tick, end, initial, events),
          signal,
        );
        assert.deepEqual(l, v);
        assert.deepEqual(
          l.transactions,
          events.map((event) => ({
            start: event.tick,
            end: String(end),
            label: event.value,
            fields: { input: event.input, initial: "z" },
          })),
        );
      }
    } finally {
      lua.dispose();
      js.dispose();
    }
  },
);

test(
  "an invalid binary sample leaves the next Lua frame readable",
  { skip: !existsSync(binary) },
  async (t) => {
    const backend = new Backend(binary, {
      args: ["--decoder-lua"],
      useVerdiLibraries: false,
    });
    t.after(() => backend.dispose());
    assert.equal(
      await backend.request("decoderInit", {
        source: "return {decode = function() end}",
        context: {
          inputs: [{ id: "data", width: 1 }],
          options: {},
          scale: "1ns",
        },
      }),
      eventBatchVersion,
    );
    const batch = packEvents(
      0n,
      2n,
      [null],
      [
        { tick: "0", input: 0, value: "1" },
        { tick: "1", input: 0, value: "0" },
      ],
    );
    const damaged = binaryBatch({ ...batch, offsets: Uint32Array.of(0, 3, 2) });
    const valid = binaryBatch(batch);
    await Promise.all([
      assert.rejects(
        backend.requestDecoderBatch(damaged.header, damaged.chunks),
        /Invalid decoder sample offsets/,
      ),
      backend.requestDecoderBatch(valid.header, valid.chunks).then((result) =>
        assert.deepEqual(result, {
          transactions: [],
          warnings: [],
          truncated: false,
        }),
      ),
    ]);
  },
);

test("packed TL-UL matches interleaved sources, reuse, reset and partial windows", async () => {
  const { tlulRuntime } = require("../dist/decoder-runtime/tlul");
  const { validateResult } = require("../dist/decoder-runtime/types");
  const bits = (n, width) => n.toString(2).padStart(width, "0");
  for (const width of [109, 114]) {
    const runtime = tlulRuntime(width);
    const transactions = [];
    // Drive each request before its sampling edge. Split the stream into
    // batches while both IDs are outstanding.
    const cycles = [
      { a: 7, ready: 0 },
      { a: 7 },
      { a: 8 },
      { d: 8 },
      { a: 7, d: 7 },
      { d: 7 },
      { a: 8 },
      { reset: 0 },
      { d: 8 },
      { a: 1 },
    ];
    for (const [i, c] of cycles.entries()) {
      const now = i * 10;
      const event = (input, at, value) => ({
        input,
        tick: String(now + at),
        value,
      });
      const h = [
        Number(c.a !== undefined),
        "10000010",
        bits(c.a ?? 0, 8),
        bits(now, 32),
        "1111",
        "0".repeat(32),
        "0".repeat(width - 86),
        "1",
      ].join("");
      const d = [
        Number(c.d !== undefined),
        "00100010",
        bits(c.d ?? 0, 8),
        "0",
        "0".repeat(32 + 14),
        "0",
        c.ready ?? 1,
      ].join("");
      const batch = packEvents(
        BigInt(now),
        BigInt(now + 10),
        [null, null, null, null],
        [
          event(0, 0, "0"),
          event(1, 0, String(c.reset ?? 1)),
          event(2, 0, h),
          event(3, 0, d),
          event(0, 5, "1"),
        ],
      );
      transactions.push(
        ...validateResult(
          await runtime.decode(batch, new AbortController().signal),
        ).transactions,
      );
    }
    transactions.push(...validateResult(await runtime.flush()).transactions);
    assert.deepEqual(
      transactions.map((t) => t.points.map((p) => p.channel)),
      [["A", "D"], ["A", "A", "D"], ["A", "D"], ["A"], ["D"], ["A"]],
    );
    assert.deepEqual(
      transactions.map((t) => [
        t.fields.source,
        t.fields.address,
        t.fields.status,
        t.points.map((p) => p.tick),
      ]),
      [
        [8, 20, undefined, ["25", "35"]],
        [7, 10, undefined, ["5", "15", "45"]],
        [7, 40, undefined, ["45", "55"]],
        [8, 60, "reset", ["65"]],
        [8, undefined, "unmatched", ["85"]],
        [1, 90, "incomplete", ["95"]],
      ],
    );
  }
});

test("CoralNPU correlates translated IDs and reports a mismatched UH address", async () => {
  const {
    coralBridgeManifest,
    axiRuntime,
  } = require("../dist/decoder-runtime/axi4");
  const pins = coralBridgeManifest.inputs;
  const inputs = pins.map(({ id, width }) => ({ id, width: width ?? 8 }));
  const bus = Array(pins.length).fill("0");
  const set = (pin, value) => {
    bus[pins.findIndex((p) => p.id === pin)] = BigInt(value).toString(2);
  };
  for (const pin of [
    "aresetn",
    "arvalid",
    "arready",
    "rlast",
    "tlaready",
    "tldready",
  ])
    set(pin, 1);
  set("araddr", 0x1234);
  set("arid", 42);
  set("rid", 42);
  const signal = new AbortController().signal;
  for (const address of [0x1234, 0x5678]) {
    const runtime = axiRuntime(
      { inputs, scale: "1ns", options: {} },
      coralBridgeManifest,
    );
    const initial = bus.slice();
    const events = [];
    const change = (tick, pin, value) =>
      events.push({
        tick: String(tick),
        input: pins.findIndex((p) => p.id === pin),
        value: BigInt(value).toString(2),
      });
    const clock = (tick) => {
      change(tick, "aclk", 1);
      change(tick + 1, "aclk", 0);
    };
    clock(2);
    change(4, "arvalid", 0);
    change(4, "tlavalid", 1);
    change(4, "tla", (4n << 192n) | (BigInt(address) << 145n));
    clock(5);
    change(7, "tlavalid", 0);
    change(7, "tldvalid", 1);
    change(7, "tld", (1n << 146n) | 0xabcdefn);
    clock(8);
    change(10, "tldvalid", 0);
    change(10, "rready", 1);
    change(10, "rvalid", 1);
    clock(11);
    const { transactions } = await runtime.decode(
      packEvents(0n, 15n, initial, events),
      signal,
    );
    const read = transactions.find((t) => t.kind === "Read");
    assert.equal(read.fields.id, 42);
    if (address === 0x1234) {
      assert.deepEqual(
        read.points.map((p) => p.channel),
        ["ar", "tla", "tld", "r"],
      );
      assert.equal(read.points[1].fields.source, 0);
      assert.equal(read.points[2].fields.data, 0xabcdef);
    } else {
      assert.deepEqual(
        read.points.map((p) => p.channel),
        ["ar", "r"],
      );
      assert.equal(
        transactions.filter((t) => t.kind === "Unmatched UH").length,
        2,
      );
      assert.equal(read.severity, "warning");
    }
    runtime.dispose();
  }
});
