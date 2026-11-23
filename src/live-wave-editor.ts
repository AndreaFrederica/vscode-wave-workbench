// SPDX-License-Identifier: MPL-2.0

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LiveTraceSession } from "./rtl-live-trace";
import type { Viewer } from "./viewer";

export function createLiveCapture(
  session: LiveTraceSession,
  dockOnOpen = false,
) {
  const snapshot = session.status().snapshot;
  if (!snapshot) throw Error("The simulation has no waveform samples.");
  const channels = Object.entries(snapshot.values).map(([path, bits]) => ({
    path,
    width: bits.length,
  }));
  const scale = snapshot.scale.replace(/\s+/g, "").toLowerCase();
  if (!channels.length || channels.length > 512)
    throw Error("The live editor requires 1–512 sampled signals.");
  if (
    !/^[1-9]\d*(s|ms|us|ns|ps|fs)$/.test(scale) ||
    channels.some(
      ({ path, width }) =>
        width > 65536 ||
        !path
          .split(".")
          .every((part) => part !== "$end" && /^[^\s\0]+$/.test(part)),
    )
  )
    throw Error(
      "The sampled signal names, widths or timescale cannot be written to VCD.",
    );
  const header = [`$timescale ${scale} $end`];
  for (const [index, { path, width }] of channels.entries()) {
    const parts = path.split(".");
    const name = parts.pop()!;
    for (const scope of parts) header.push(`$scope module ${scope} $end`);
    header.push(`$var wire ${width} ${index} ${name} $end`);
    for (const _ of parts) header.push("$upscope $end");
  }
  header.push("$enddefinitions $end", "#0", "");
  const filename = join(
    mkdtempSync(join(tmpdir(), "wave-live-editor-")),
    "Live Simulation.vcd",
  );
  writeFileSync(filename, header.join("\n"), { flag: "wx", mode: 0o600 });
  return { filename, channels, session, dockOnOpen };
}

export type LiveCapture = ReturnType<typeof createLiveCapture>;

export function bindLiveCapture(
  viewer: Viewer,
  capture: LiveCapture,
  log: (text: string) => void,
) {
  const { session, channels } = capture;
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reading = false;
  let pending = false;

  function schedule() {
    if (abort.signal.aborted) return;
    if (reading) pending = true;
    else
      timer ??= setTimeout(() => {
        timer = undefined;
        void update();
      }, 100);
  }

  async function update() {
    reading = true;
    try {
      const status = session.status();
      const tick = status.snapshot?.tick;
      if (!tick || viewer.disposed) return;
      let start = BigInt(viewer.meta.end);
      let changed = false;
      let next: string | undefined;
      do {
        const page = await session.readWavePage(
          start,
          BigInt(tick),
          128,
          abort.signal,
        );
        abort.signal.throwIfAborted();
        if (!page.samples.length) break;
        const result = await viewer.backend.request("appendLiveSamples", {
          samples: page.samples.map((sample) => ({
            tick: sample.tick,
            values: channels.map(({ path, width }) => {
              const bits = sample.values[path];
              return bits?.length === width
                ? bits.toLowerCase()
                : "x".repeat(width);
            }),
          })),
        });
        changed ||= result.changed;
        if (viewer.meta.end !== result.end)
          viewer.meta = { ...viewer.meta, end: result.end };
        next = page.nextStart;
        if (next !== undefined) start = BigInt(next);
      } while (next !== undefined);
      if (!viewer.disposed)
        await viewer.panel.webview.postMessage({
          type: "liveSamples",
          end: viewer.meta.end,
          state: status.state,
          changed,
        });
    } catch (error) {
      if (!abort.signal.aborted && !viewer.disposed) {
        log(String(error) + "\n");
        await viewer.panel.webview.postMessage({
          type: "liveSamples",
          end: viewer.meta.end,
          state: "error",
          changed: false,
        });
      }
    } finally {
      reading = false;
      if (pending) {
        pending = false;
        schedule();
      }
    }
  }
  const unsubscribe = session.onWaveUpdate(schedule);
  schedule();
  return () => {
    abort.abort();
    clearTimeout(timer);
    unsubscribe();
  };
}
