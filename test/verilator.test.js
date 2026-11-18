// SPDX-License-Identifier: MPL-2.0

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Backend } = require("../dist/backend");
const { VerilatorDesign } = require("../dist/verilator");
const { readWaveProject, saveWaveProject } = require("../dist/project");
const { restoreView } = require("../dist/view-state");

const fixture = process.env.WAVE_TEST_VERILATOR;
const stress = process.env.WAVE_TEST_VERILATOR_LARGE;
const startBackend = () =>
  new Backend(path.resolve(__dirname, "../bin/wave-backend-independent"), {
    useVerdiLibraries: false,
  });

test("Verilator VCD and FST agree on alias values and source locations", { skip: !fixture }, async (t) => {
  const expected = [["29", "1111"], ["31", "0000"], ["33", "0001"], ["35", "0010"], ["37", "0011"]];
  for (const format of ["vcd", "fst"]) {
    await t.test(format, async (t) => {
      const backend = startBackend();
      t.after(() => backend.dispose());
      const waveform = path.join(fixture, "top." + format);
      const meta = await backend.request("open", { path: waveform });
      assert.equal(meta.backend, "rust-" + format);
      assert.equal(meta.scale, "1ps");
      const pc = meta.signals.find((s) => s.scope === "TOP.top.u0" && s.name === "pc[3:0]");
      const port = meta.signals.find((s) => s.scope === "TOP" && s.name === "left[3:0]");
      assert.equal(pc.id, port.id);
      const result = await backend.request("query", { signals: [pc.id], start: "30", end: "38", limit: 9 });
      assert.deepEqual(result[pc.id].events.map(([tick, value]) => [tick, value.padStart(pc.width, "0")]), expected);
      const design = await VerilatorDesign.open(path.join(fixture, "obj_dir/Vtop.tree.json"), meta.signals, [fixture]);
      assert.deepEqual((await design.children()).map((s) => s.fullname), ["TOP.top"]);
      assert.deepEqual((await design.instances("leaf")).map((s) => s.fullname).sort(), ["TOP.top.u0", "TOP.top.u1"]);
      const declaration = await design.resolve("TOP.top.u0.pc[3:0]");
      assert.equal(declaration.file, path.join(fixture, "fixture.sv"));
      assert.equal(declaration.line, 4);
      assert.equal(declaration.instance, "TOP.top.u0");
      assert.equal((await design.resolve("TOP.left[3:0]")).line, 18);
      const instance = await design.resolve("TOP.top.u1");
      assert.equal(instance.line, 20);
      assert.equal(instance.definitionLine, 4);
      assert.equal(await design.parent("TOP.top.u1.stages[0].u1"), "TOP.top.u1.stages[0]");
      assert.ok((await design.children("TOP.top.u1")).some((entry) => entry.fullname.endsWith("stages[1]")));

      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wave-project-verilator-"));
      t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
      const projectFile = path.join(directory, "debug.waveproj");
      const designView = { selected: instance.fullname, expanded: ["TOP.top"], includeOther: true };
      const view = {
        chosen: [{ ...pc, group: "Core", annotation: { tags: ["verify"], note: "counter" } }],
        start: 28, end: 40, cursorA: 30, cursorB: 37,
        markers: [{ name: "overflow", time: 31 }], groupOrder: ["Core"],
        radix: "hex", collapsedGroups: [], expandedBuses: [], virtualDefinitions: [],
      };
      await saveWaveProject(projectFile, waveform, view, undefined, design.path, designView);
      const saved = JSON.parse(fs.readFileSync(projectFile, "utf8"));
      assert.ok(!path.isAbsolute(saved.verilator));
      const reopened = await readWaveProject(projectFile);
      const newBackend = startBackend();
      t.after(() => newBackend.dispose());
      const newMeta = await newBackend.request("open", { path: reopened.waveform });
      const newDesign = await VerilatorDesign.open(reopened.verilator, newMeta.signals, [fixture]);
      const restored = await restoreView(newBackend, reopened.view, newMeta);
      assert.equal(restored.chosen[0].group, "Core");
      assert.deepEqual(restored.chosen[0].annotation, view.chosen[0].annotation);
      assert.deepEqual(restored.markers, view.markers);
      assert.equal(restored.cursorB, 37);
      assert.deepEqual(reopened.designView, designView);
      assert.deepEqual(await newDesign.resolve(reopened.designView.selected), instance);
    });
  }
});

test("large Verilator FST pages past preview and seeds held signals at late seeks", { skip: !stress }, async (t) => {
  const backend = startBackend();
  t.after(() => backend.dispose());
  const waveform = path.join(stress, "top.fst");
  assert.ok(fs.statSync(waveform).size > 100 * 1024 * 1024);
  const meta = await backend.request("open", { path: waveform });
  assert.equal(meta.end, "99999");
  assert.ok(meta.total > meta.signals.length);
  const tail = await backend.request("search", { query: "", offset: meta.signals.length, limit: 512 });
  assert.equal(tail.signals.length, meta.total - meta.signals.length);
  const scope = "TOP.top.bank[255]";
  const page = await backend.request("scopeSignals", { query: scope, offset: 0, limit: 2 });
  assert.equal(page.signals.length, 2);
  assert.ok(page.total > page.signals.length);
  const constant = meta.signals.find((s) => s.name === "holding[63:0]");
  const ids = [...new Set(meta.signals.map((s) => s.id))].slice(0, 64);
  assert.equal(ids.length, 64);
  assert.ok(ids.includes(constant.id));
  const args = { signals: ids, start: "99000", end: "99031", limit: 100 };
  const data = await backend.request("query", args);
  assert.equal(Object.values(data).length, 64);
  for (const block of Object.values(data)) {
    assert.ok(Number(block.events[0][0]) <= Number(args.start));
    assert.ok(Number(block.events.at(-1)[0]) <= Number(args.end));
  }
  assert.equal(BigInt("0b" + data[constant.id].events[0][1]), 0x87654321f0e1d2c3n);
  const reduced = await backend.request("query", { ...args, signals: [ids[0], constant.id], limit: 3 });
  assert.equal(reduced[ids[0]].truncated, true);
  assert.equal(reduced[constant.id].truncated, false);
  const design = await VerilatorDesign.open(path.join(stress, "Vtop.tree.json"), meta.signals, [stress]);
  assert.equal((await design.children("TOP.top")).length, 256);
  assert.equal((await design.resolve(scope + ".flipped[63:0]")).instance, scope);
});
