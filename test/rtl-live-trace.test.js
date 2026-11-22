// SPDX-License-Identifier: MPL-2.0
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { setTimeout: delay } = require("node:timers/promises");
const { LiveTraceSession, matchLiveExecution } = require("../dist/rtl-live-trace");
const { LiveWaveHistory } = require("../dist/live-wave-history");
const { readExecutionEvidence, readExecutionEvidenceBatch } = require("../dist/rtl-execution");

test("live waves grow from the first tick and can seek into spilled history", async (t) => {
  const history = new LiveWaveHistory(8, 640, 12);
  t.after(() => history.dispose());
  const start = 18_446_744_073_709_540_000n;
  function tick(i) { return start + BigInt(i); }
  for (let i = 0; i < 5000; i++) {
    history.push({ tick: String(tick(i)), values: { clk: String(i % 2) } });
  }
  const updated = { tick: String(tick(4999)), values: { clk: "x" } };
  history.push(updated);
  const frame = history.overviewFrame();
  assert.equal(frame.firstTick, String(start));
  assert.equal(frame.lastTick, updated.tick);
  assert.equal(frame.approximate, true);
  assert.deepEqual(frame.samples.at(-1), updated);
  assert.equal(frame.samples[0].tick, String(start));
  const early = await history.read(tick(10), tick(13), tick(11));
  assert.equal(early.approximate, false);
  assert(early.samples.some((entry) => entry.tick === String(tick(10))));
  assert.deepEqual(early.cursor.values, { clk: "1" });
  const wide = await history.read(start, tick(4999), tick(101));
  assert.equal(wide.approximate, true);
  assert.deepEqual(wide.cursor.values, { clk: "1" });
  assert.equal(wide.samples[0].tick, String(start));
  assert.deepEqual(wide.samples.at(-1), updated);
  const tail = await history.read(tick(4996), tick(4999), tick(4999));
  assert.deepEqual(tail.cursor, updated);
  assert.equal(tail.approximate, false);
});

test("the active launch preserves argument order and checks stimulus identity", {
  skip: process.platform === "win32",
}, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wave-live-launch-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const work = path.join(directory, "test case");
  const executable = path.join(directory, "harness");
  const stimulus = path.join(work, "data hex");
  await fs.mkdir(work);
  await fs.writeFile(stimulus, "1");
  await fs.writeFile(executable, "#!/usr/bin/env node\n" + `
const fs = require("node:fs");
const args = process.argv.slice(2);
const ready = args.length === 2 && args[0] === "+file=data hex" &&
  args[1] === "+mode=7" && fs.readFileSync("data hex", "utf8") === "1";
const input = require("node:readline").createInterface({ input: process.stdin });
input.on("line", () => {
  console.log(JSON.stringify({ snapshot: { tick: "0", scale: "1ps", values: { ready: ready ? "1" : "0" }, done: false } }));
});
`, { mode: 0o755 });
  const session = await LiveTraceSession.start(executable, directory, () => {}, undefined, {
    workingDirectory: "test case",
    plusargs: ["+file=data hex", "+mode=7"],
    stimulusFiles: ["data hex"],
  });
  t.after(() => session.dispose());
  assert.equal(session.status().snapshot.values.ready, "1");
  const observed = session.runtimeInputs();
  assert.equal(observed.workingDirectory, await fs.realpath(work));
  assert.equal(observed.files[0].path, path.join(await fs.realpath(work), "data hex"));
  assert.match(observed.files[0].sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(await session.runtimeDifferences(observed), []);
  assert.deepEqual(await session.runtimeDifferences({ ...observed, plusargs: [] }), ["Simulation plusargs"]);
  await fs.writeFile(stimulus, "0");
  assert.deepEqual(await session.runtimeDifferences(observed), ["Simulation stimulus " + observed.files[0].path]);
});

test("live execution reports sequence gaps and bounded history for the requested signal", {
  skip: process.platform === "win32",
}, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wave-live-history-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const executable = path.join(directory, "harness");
  await fs.writeFile(executable, "#!/usr/bin/env node\n" + `
const input = require("node:readline").createInterface({ input: process.stdin });
input.on("line", (request) => {
  if (request === "current") {
    console.log(JSON.stringify({ snapshot: { tick: "0", scale: "1ps", values: { clk: "0" }, done: false, executionEvents: true } }));
    return;
  }
  for (let ordinal = 0; ordinal < 2100; ordinal++) {
    if (ordinal === 100) continue;
    const instance = ordinal < 350 ? "first" : "second";
    const event = { tick: String(ordinal + 1), ordinal, instance, processId: "p", kind: "process-trigger" };
    console.log(JSON.stringify({ execution: event }));
  }
  console.log(JSON.stringify({ snapshot: { tick: "2100", scale: "1ps", values: { clk: "1" }, done: true, executionEvents: true } }));
  input.close();
  process.stdin.pause();
});
`, { mode: 0o755 });
  const session = await LiveTraceSession.start(executable, directory, () => {});
  t.after(() => session.dispose());
  const stopped = await session.stepClock("clk", 1);
  assert.equal(stopped.state, "exited");
  assert.equal(stopped.missingOrdinals, 1);
  assert.equal(stopped.discardedEvents, 51);
  const first = session.executionWindow("first", "q", "1", "2100");
  assert.equal(first.events.length, 256);
  assert.equal(first.events.at(-1).ordinal, 349);
  assert.deepEqual(first.coverage, {
    available: true, missingOrdinals: 1, olderEventsDiscarded: true, responseOmitted: 42,
  });
  const latest = session.executionWindow("second", "q", "2000", "2100");
  assert.equal(latest.events.length, 101);
  assert.equal(latest.coverage.olderEventsDiscarded, false);
});

test("live stepping and a concurrent pause report a disconnected harness", {
  skip: process.platform === "win32",
}, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wave-live-disconnect-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const executable = path.join(directory, "harness");
  await fs.writeFile(executable, "#!/usr/bin/env node\n" + `
const input = require("node:readline").createInterface({ input: process.stdin });
input.on("line", (request) => {
  if (request === "advance") process.exit(1);
  console.log(JSON.stringify({ snapshot: { tick: "0", scale: "1ps", values: { clk: "0" }, done: false } }));
});


`, { mode: 0o755 });
  const session = await LiveTraceSession.start(executable, directory, () => {});
  t.after(() => session.dispose());
  assert.throws(() => session.setBreakpoint({
    instance: "dut", statementId: "write", eventKind: "assignment-evaluated",
  }), /does not provide statement events/);
  const step = session.stepClock("clk", 1);
  const pause = session.pause();
  const [stepped, paused] = await Promise.all([step, pause]);
  assert.equal(stepped.state, "error");
  assert.equal(paused.state, "error");
  assert.equal(stepped.elapsedCycles, 0);
  assert.match(paused.failure, /closed before its reply/);
});

test("live Trace rejects an invalid provider time unit before publishing a sample", {
  skip: process.platform === "win32",
}, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wave-live-scale-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const executable = path.join(directory, "harness");
  await fs.writeFile(executable, "#!/usr/bin/env node\n" + `
const input = require("node:readline").createInterface({ input: process.stdin });
input.once("line", () => {
  const { argv } = process;
  console.log(JSON.stringify({ snapshot: {
    tick: "0", scale: argv[2].slice(1), values: { q: "0" }, done: false,
  } }));
  input.close();
  process.stdin.pause();
});
`, { mode: 0o755 });
  for (const scale of ["ticks", "0ps", "1e999ns", "1e-320fs"]) {
    await assert.rejects(
      async () => {
        const session = await LiveTraceSession.start(executable, directory, () => {}, undefined, {
          plusargs: ["+" + scale],
        });
        await session.dispose();
      },
      /Unsupported time scale/,
    );
  }
});

test("live Trace accepts stable legacy and version 1 snapshots", {
  skip: process.platform === "win32",
}, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wave-live-schema-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const executable = path.join(directory, "harness");
  await fs.writeFile(executable, "#!/usr/bin/env node\n" + `
const input = require("node:readline").createInterface({ input: process.stdin });
const versions = JSON.parse(process.argv[2].slice(1));
let tick = 0;
input.on("line", () => {
  const schemaVersion = versions[tick];
  console.log(JSON.stringify({ snapshot: {
    ...(schemaVersion === null ? {} : { schemaVersion }),
    tick: String(tick), scale: "1ps", values: { clk: String(tick++ % 2) }, done: false,
  } }));
});
`, { mode: 0o755 });
  const start = (versions) => LiveTraceSession.start(executable, directory, () => {}, undefined, {
    plusargs: ["+" + JSON.stringify(versions)],
  });
  for (const version of [0, 2, "1"])
    await assert.rejects(start([version]), /Unsupported live simulation snapshot schema/);
  for (const [versions, expected] of [[[null, null], undefined], [[1, 1], 1]]) {
    const session = await start(versions);
    t.after(() => session.dispose());
    assert.equal(session.status().snapshot.schemaVersion, expected);
    const result = await session.stepClock("clk", 1);
    assert.equal(result.snapshot.schemaVersion, expected);
  }
  const changed = await start([1, null]);
  t.after(() => changed.dispose());
  const result = await changed.stepClock("clk", 1);
  assert.equal(result.state, "error");
  assert.match(result.failure, /snapshot schema changed/);
  assert.equal(result.snapshot.tick, "0");
});

test("a simulator-commit breakpoint skips end-of-slot observations", {
  skip: process.platform === "win32",
}, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wave-live-commit-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const executable = path.join(directory, "harness");
  await fs.writeFile(executable, "#!/usr/bin/env node\n" + `
const input = require("node:readline").createInterface({ input: process.stdin });
let tick = 0;
input.on("line", (request) => {
  if (request === "advance") {
    tick++;
    console.log(JSON.stringify({ execution: {
      tick: String(tick), ordinal: tick * 2 - 1, instance: "dut", processId: "p",
      statementId: "write", kind: "assignment-committed", signal: "q", value: "1",
      writeKind: "nonblocking", evaluationOrdinal: tick * 2 - 2,
      timing: tick === 1 ? "end-of-slot" : "simulator-commit",
    } }));
  }
  console.log(JSON.stringify({ snapshot: { tick: String(tick), scale: "1ps", values: { clk: String(tick % 2) }, done: false, executionEvents: true } }));
});
`, { mode: 0o755 });
  const session = await LiveTraceSession.start(executable, directory, () => {});
  t.after(() => session.dispose());
  const breakpoint = { instance: "dut", statementId: "write", eventKind: "assignment-committed", timing: "simulator-commit" };
  assert.throws(() => session.setBreakpoint({ ...breakpoint, eventKind: "assignment-evaluated" }), /Commit timing requires/);
  session.setBreakpoint(breakpoint);
  const stopped = await session.stepClock("clk", 5);
  assert.equal(stopped.state, "paused", stopped.failure);
  assert.equal(stopped.snapshot.tick, "2");
  assert.equal(stopped.breakEvent.ordinal, 3);
  assert.equal(stopped.breakEvent.timing, "simulator-commit");
  assert.deepEqual(stopped.events.map(({ timing }) => timing), ["end-of-slot", "simulator-commit"]);
});

test("cancelling a live step drains the current slot and allows another step", {
  skip: process.platform === "win32", timeout: 5000,
}, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wave-live-cancel-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const executable = path.join(directory, "harness");
  const release = path.join(directory, "released");
  await fs.writeFile(executable, "#!/usr/bin/env node\n" + `
const fs = require("node:fs");
const input = require("node:readline").createInterface({ input: process.stdin });
let tick = 0;
function snapshot() {
  console.log(JSON.stringify({ snapshot: { tick: String(tick), scale: "1ps", values: { clk: String(tick % 2) }, done: false } }));
}
input.on("line", (request) => {
  if (request === "advance" && ++tick === 1) {
    console.error("first advance");
    const gate = setInterval(() => {
      if (!fs.existsSync("released")) return;
      clearInterval(gate);
      snapshot();
    }, 5);
  } else {
    snapshot();
  }
});
`, { mode: 0o755 });
  let started;
  const advancing = new Promise((resolve) => { started = resolve; });
  const session = await LiveTraceSession.start(executable, directory, () => started());
  t.after(() => session.dispose());
  const operation = new AbortController();
  await assert.rejects(session.stepClock("clk", 5, AbortSignal.abort()), { name: "AbortError" });
  assert.equal(session.status().snapshot.tick, "0");
  const stepped = session.stepClock("clk", 5, operation.signal);
  const cancelled = assert.rejects(stepped, { name: "AbortError" });
  await advancing;
  operation.abort();
  assert.equal(session.status().state, "stepping");
  await fs.writeFile(release, "1");
  await cancelled;
  assert.equal(session.status().state, "paused");
  assert.equal(session.status().snapshot.tick, "1");
  const next = await session.stepClock("clk", 1);
  assert.equal(next.snapshot.tick, "3");
  assert.equal(next.elapsedCycles, 1);
});

const directory = process.env.WAVE_TEST_EXECUTION_TRACE;
const vcsDirectory = process.env.WAVE_TEST_VCS_LIVE;
const vcsStatementDirectory = process.env.WAVE_TEST_VCS_STATEMENTS;
test("VCS records assignment entry when an NBA holds its previous value", {
  skip: !vcsStatementDirectory,
  timeout: 10000,
}, async (t) => {
  const runDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "wave-vcs-statement-"));
  t.after(() => fs.rm(runDirectory, { recursive: true, force: true }));
  const instance = "clock_tb";
  const target = { instance, signal: "q" };
  const clock = instance + ".clk";
  const q = instance + ".q";
  const recording = path.join(runDirectory, "live.jsonl");
  const session = await LiveTraceSession.start(
    path.join(vcsStatementDirectory, "simv"), runDirectory, () => {}, {
      signals: [clock, instance + ".d", q],
      statementScopes: [instance],
      recording,
    },
  );
  t.after(() => session.dispose());

  const reference = path.join(vcsStatementDirectory, "reference.vcd");
  const log = path.join(vcsStatementDirectory, "sealed.jsonl");
  const replay = await readExecutionEvidence(log, reference, "1ns", instance, "q", "0", "5");
  const [held, changed, callback] = replay.events;
  assert.deepEqual(replay.events.slice(0, 3).map(({ kind }) => kind), [
    "assignment-entered", "assignment-entered", "signal-value-changed",
  ]);
  assert.deepEqual([held.tick, changed.tick, callback.tick], ["1", "3", "3"]);
  assert.match(held.statementSite.file, /vpi_live_tb\.sv$/);
  assert.equal(held.statementSite.line, 8);
  assert.equal(held.writeKind, "nonblocking");
  assert.equal(replay.coverage.status, "partial");
  assert.deepEqual(session.status().capabilities.statementEventKinds, ["assignment-entered"]);

  const breakpoint = { instance, statementId: held.statementId, eventKind: "assignment-entered" };
  assert.throws(() => session.setBreakpoint({ ...breakpoint, eventKind: "assignment-committed" }),
    /does not provide assignment-committed/);
  session.setBreakpoint(breakpoint);
  const hit = await session.stepClock(clock, 5);
  assert.equal(hit.state, "paused", hit.failure);
  assert.equal(hit.snapshot.tick, "1");
  assert.equal(hit.snapshot.values[q], "0000");
  assert.equal(hit.breakEvent.ordinal, held.ordinal);
  assert.equal(hit.breakEvent.statementId, held.statementId);
  assert.equal(hit.breakEvent.kind, "assignment-entered");
  assert.equal(session.executionWindow(instance, "q", "0", "1").events.length, 1);

  session.setBreakpoint();
  const stepped = await session.stepClock(clock, 2);
  assert.equal(stepped.snapshot.tick, "5");
  assert.equal(stepped.snapshot.values[q], "1010");
  const batch = await readExecutionEvidenceBatch(log, reference, "1ns",
    [target, { instance, signal: "d" }], "0", "5");
  for (const [index, signal] of ["q", "d"].entries())
    assert.equal(matchLiveExecution(batch[index], session.executionWindow(instance, signal, "0", "5"),
      index === 0), "matched");
  const finished = await session.stepClock(clock, 3);
  assert.equal(finished.state, "exited");
  assert.equal(finished.snapshot.tick, "8");
  assert.equal(await fs.readFile(recording, "utf8"),
    await fs.readFile(path.join(vcsStatementDirectory, "raw.jsonl"), "utf8"));
});

test("VCS pauses between slots and matches watched callbacks against offline replay", {
  skip: !vcsDirectory,
  timeout: 10000,
}, async (t) => {
  const runDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "wave-vcs-live-"));
  t.after(() => fs.rm(runDirectory, { recursive: true, force: true }));
  const executable = path.join(vcsDirectory, "simv");
  const instance = "clock_tb";
  const clock = instance + ".clk";
  const data = instance + ".d";
  const output = instance + ".q";
  const recording = path.join(runDirectory, "live.jsonl");
  const session = await LiveTraceSession.start(executable, runDirectory, () => {}, {
    signals: [clock, data, output],
    recording,
  });
  t.after(() => session.dispose());

  const start = session.status();
  assert.equal(start.state, "paused");
  assert.equal(start.snapshot.tick, "0");
  assert.equal(start.snapshot.scale, "1ns");
  assert.equal(start.capabilities.valueChangeEvents, true);
  assert.equal(start.capabilities.statementBreakpoints, false);
  assert.throws(() => session.setBreakpoint({
    instance, statementId: "write", eventKind: "assignment-evaluated",
  }), /does not provide statement events/);

  session.resume();
  assert.equal((await session.pause()).snapshot.tick, "1");
  assert.equal((await session.pause()).snapshot.tick, "1");
  const stepped = await session.stepClock(clock, 1);
  assert.equal(stepped.elapsedCycles, 1);
  assert.equal(stepped.snapshot.tick, "3");
  assert.equal(stepped.snapshot.values[output], "0101");
  session.setBreakpoint({ signal: output, value: "1010" });
  session.resume();
  while (session.status().state === "running") await delay(5);
  const hit = session.status();
  assert.equal(hit.state, "paused", hit.failure);
  assert.deepEqual(hit.breakHit, { signal: output, value: "1010" });
  assert.equal(hit.snapshot.tick, "5");
  assert.equal(hit.snapshot.values[output], "1010");

  const replay = await readExecutionEvidenceBatch(
    path.join(vcsDirectory, "sealed.jsonl"), path.join(vcsDirectory, "reference.vcd"),
    "1ns", [{ instance, signal: "q" }, { instance, signal: "d" }],
    "0", "5",
  );
  for (const [index, signal] of ["q", "d"].entries()) {
    const window = session.executionWindow(instance, signal, "0", "5");
    assert.equal(matchLiveExecution(replay[index], window, index === 0), "matched");
    assert.equal(window.events.length, 2);
    assert(window.events.every(({ kind }) => kind === "signal-value-changed"));
  }
  assert.equal(session.executionWindow(instance, "unwatched", "0", "5").coverage.available, false);
  session.setBreakpoint();
  const finished = await session.stepClock(clock, 3);
  assert.equal(finished.state, "exited");
  assert.equal(finished.snapshot.tick, "8");
  assert.equal(finished.snapshot.values[output], "1010");
  const liveRaw = (await fs.readFile(recording, "utf8")).trim().split("\n").map(JSON.parse);
  const offlineRaw = (await fs.readFile(path.join(vcsDirectory, "offline.jsonl"), "utf8"))
    .trim().split("\n").map(JSON.parse);
  assert.deepEqual(liveRaw, offlineRaw);
});

test("real Verilator harness supports stepping, breakpoints and matching execution replay", {
  skip: !directory,
}, async (t) => {
  const instance = "TOP.trace_tb.dut";
  const executable = path.join(directory, "obj_dir", process.platform === "win32" ? "Vtrace_tb.exe" : "Vtrace_tb");
  const session = await LiveTraceSession.start(executable, directory, () => {});
  t.after(() => session.dispose());
  assert.equal(session.status().snapshot.tick, "0");
  assert.equal(session.status().state, "paused");

  const stepped = await session.stepClock(instance + ".clk", 1);
  assert.equal(stepped.elapsedCycles, 1);
  assert.equal(stepped.snapshot.tick, "1");
  session.resume();
  const paused = await session.pause();
  assert.equal(paused.state, "paused");
  assert(BigInt(paused.snapshot.tick) <= 2n);
  const stepping = session.stepClock(instance + ".clk", 100);
  const interrupted = await session.pause();
  assert.equal(interrupted.state, "paused");
  assert((await stepping).elapsedCycles <= 1);
  assert(BigInt(interrupted.snapshot.tick) < 7n);

  const breakpoint = { signal: instance + ".owner_q", value: "1" };
  session.setBreakpoint(breakpoint);
  session.resume();
  for (let attempt = 0; attempt < 100 && session.status().state === "running"; attempt++) {
    await delay(5);
  }
  const stopped = session.status();
  assert.equal(stopped.state, "paused");
  assert.equal(stopped.snapshot.tick, "7");
  assert.deepEqual(stopped.breakHit, breakpoint);
  const sampled = session.observations(new Map([[0, instance + ".owner_q"], [1, instance + ".unrecorded"]]), "1");
  assert.equal(sampled.tick, "7");
  assert.equal(sampled.observations[0].initial.value, "0");
  assert.deepEqual(sampled.observations[0].history, [{ tick: "7", value: "1" }]);
  assert.equal(sampled.observations[1].status, "unavailable");
  const earlier = session.observations(
    new Map([[0, instance + ".owner_q"]]), "0", undefined, undefined, "1",
  );
  assert.equal(earlier.historyEnd, "1");
  assert.equal(earlier.observations[0].value, "0");
  assert(earlier.observations[0].history.every(({ tick }) => BigInt(tick) <= 1n));
  assert.equal(session.status().snapshot.tick, "7");
  assert.throws(() => session.observations(new Map(), "0", undefined, undefined, "99"),
    /no retained live snapshot/);
  const offline = await readExecutionEvidence(path.join(directory, "execution.jsonl"), path.join(directory, "trace.fst"),
    "1ps", instance, "owner_q", "1", "7");
  assert.deepEqual(
    stopped.events.filter(({ tick }) => tick !== "0").map(({ tick, kind, statementId, value }) => [tick, kind, statementId, value]),
    offline.events.map(({ tick, kind, statementId, value }) => [tick, kind, statementId, value]),
  );
  session.setBreakpoint();
  session.resume();
  for (let attempt = 0; attempt < 100 && session.status().state === "running"; attempt++) {
    await delay(5);
  }
  assert.equal(session.status().state, "exited");
  assert.equal(session.status().snapshot.tick, "8");
});

const livePipeline = process.env.WAVE_TEST_LIVE_RECORDED_UPSTREAM;
test("online and offline Verilator replay agree for both pipeline stages", {
  skip: !livePipeline,
}, async (t) => {
  const instance = "TOP.sampled_pipe_tb";
  const binary = process.platform === "win32" ? "Vsampled_pipe_tb.exe" : "Vsampled_pipe_tb";
  const session = await LiveTraceSession.start(path.join(livePipeline, "obj_verified", binary), livePipeline, () => {});
  t.after(() => session.dispose());
  assert.equal((await session.stepClock(instance + ".clk", 2)).snapshot.tick, "3");
  const recordings = await readExecutionEvidenceBatch(
    path.join(livePipeline, "execution.jsonl"), path.join(livePipeline, "trace.fst"), "1ps",
    ["second_q", "first_q"].map((signal) => ({ instance, signal })), "0", "3",
  );
  const [downstream, upstream] = recordings;
  const live = session.executionWindow(instance, "second_q", "0", "3");
  assert.equal(matchLiveExecution(downstream, live, true), "matched");
  assert.equal(matchLiveExecution(upstream, session.executionWindow(instance, "first_q", "0", "3"), false), "matched");
  const altered = downstream.events.map((event) =>
    event.ordinal === 8 ? { ...event, value: "0" } : event,
  );
  assert.equal(matchLiveExecution({ ...downstream, events: altered }, live, true), "eventSequenceDiffers");
  assert.equal(matchLiveExecution({ ...downstream, truncated: true }, live, true), "recordingCoverageIncomplete");
  assert.equal(matchLiveExecution(downstream, {
    ...live, coverage: { ...live.coverage, olderEventsDiscarded: true },
  }, true), "liveCoverageIncomplete");
});

const statementDirectory = process.env.WAVE_TEST_LIVE_STATEMENTS;
test("statement breakpoint pauses at the matching Verilator time slot and replays the hit", {
  skip: !statementDirectory,
}, async (t) => {
  const instance = "TOP.trace_tb.dut";
  const binary = process.platform === "win32" ? "Vtrace_tb.exe" : "Vtrace_tb";
  const session = await LiveTraceSession.start(path.join(statementDirectory, "obj_dir", binary), statementDirectory, () => {});
  t.after(() => session.dispose());
  assert.equal(session.status().capabilities.statementBreakpoints, true);
  const breakpoint = { instance, statementId: "owner.accept", eventKind: "assignment-evaluated" };
  session.setBreakpoint({ ...breakpoint, instance: instance + "_other" });
  assert.equal((await session.stepClock(instance + ".clk", 1)).breakHit, undefined);
  session.setBreakpoint(breakpoint);
  const stopped = await session.stepClock(instance + ".clk", 5);
  assert.equal(stopped.state, "paused");
  assert.equal(stopped.snapshot.tick, "3");
  assert.equal(stopped.snapshot.values[instance + ".owner_q"], "0");
  assert.deepEqual(stopped.breakHit, breakpoint);
  assert.equal(stopped.breakEvent.kind, "assignment-evaluated");
  const replay = await readExecutionEvidence(
    path.join(statementDirectory, "execution.jsonl"), path.join(statementDirectory, "trace.fst"),
    "1ps", instance, "owner_q", "3", "3",
  );
  const recorded = replay.events.find(({ ordinal }) => ordinal === stopped.breakEvent.ordinal);
  assert.deepEqual(stopped.breakEvent, {
    tick: recorded.tick, ordinal: recorded.ordinal, instance: recorded.instance,
    processId: recorded.processId, statementId: recorded.statementId,
    kind: recorded.kind, signal: recorded.signal, value: recorded.value,
  });
  session.setBreakpoint({ ...breakpoint, eventKind: "assignment-committed" });
  session.resume();
  for (let attempt = 0; attempt < 100 && session.status().state === "running"; attempt++) await delay(5);
  assert.equal(session.status().snapshot.tick, "7");
  assert.equal(session.status().breakEvent.kind, "assignment-committed");
});
