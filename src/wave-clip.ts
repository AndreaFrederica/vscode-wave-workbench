import { realValue } from "./shared/analog";
// SPDX-License-Identifier: MPL-2.0

import type { Viewer } from "./viewer";
import type { ClipContext, WaveClip } from "./shared/protocol";
import { findSignal } from "./signal-lookup";
import * as WaveSignal from "./shared/signals";
import { scaleHertz } from "./shared/time";

export const clipFormats = ["png", "csv", "json", "vcd"] as const;
export type ClipFormat = (typeof clipFormats)[number];
export const ranges = ["view", "cursors", "explicit"] as const;
type ClipRange = (typeof ranges)[number];
export interface ClipOptions {
  range?: ClipRange;
  start?: string;
  end?: string;
  signals?: string[];
  limit?: number;
}

export function collectClip(
  viewer: Viewer,
  options: ClipOptions,
  inline: boolean,
  context?: ClipContext,
) {
  const source = {
    backend: viewer.backend,
    meta: viewer.meta,
    filename: viewer.uri.fsPath,
  };
  return (context ? Promise.resolve(context) : viewer.ui("clipContext")).then(
    (view: ClipContext) => readClip(source, view, options, inline),
  );
}

export async function readClip(
  source: {
    backend: Viewer["backend"];
    meta: Viewer["meta"];
    filename: string;
  },
  view: ClipContext,
  options: ClipOptions,
  inline: boolean,
): Promise<WaveClip> {
  const range =
    options.range ??
    (options.start !== undefined || options.end !== undefined
      ? "explicit"
      : "view");
  if (!ranges.includes(range)) throw Error("Invalid clip range");
  if (
    range !== "explicit" &&
    (options.start !== undefined || options.end !== undefined)
  )
    throw Error("start and end require an explicit range");

  let start = view.start;
  let end = view.end;
  if (range === "cursors") {
    if (view.cursorB === null) throw Error("Set both A and B cursors first");
    start = Math.min(view.cursorA, view.cursorB);
    end = Math.max(view.cursorA, view.cursorB);
  } else if (range === "explicit") {
    if (!/^\d+$/.test(options.start ?? "") || !/^\d+$/.test(options.end ?? ""))
      throw Error("Specify start and end as integer dump ticks");
    start = Number(options.start);
    end = Number(options.end);
  }
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start >= end ||
    start < Number(source.meta.start) ||
    end > Number(source.meta.end)
  )
    throw Error("Choose a non-empty range within the waveform time bounds");

  const count = options.signals?.length ?? view.selected.length;
  if (count < 1 || count > 64) throw Error("Choose 1–64 signals to clip");
  const signals = options.signals
    ? await Promise.all(
        options.signals.map((name) => findSignal(source.backend, name)),
      )
    : view.selected;
  const styled = new Map(
    view.displayed.map((signal) => [WaveSignal.key(signal), signal]),
  );
  const distinct = [
    ...new Map(
      signals.map((signal) => {
        const key = WaveSignal.key(signal);
        return [key, styled.get(key) ?? signal] as const;
      }),
    ).values(),
  ];
  if (distinct.some((signal) => !signal.supported))
    throw Error("The selected signals include an unsupported encoding");

  const budget = inline ? 2400 : 64000;
  const countLimit = Math.floor(budget / distinct.length);
  const limit = Math.min(options.limit ?? (inline ? 256 : 5000), countLimit);
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw Error("Invalid event limit");
  const blocks = await source.backend.request("query", {
    signals: [...new Set(distinct.map((signal) => signal.id))],
    start: String(start),
    end: String(end),
    limit,
  });
  const traces = distinct.map((signal) => {
    const block = blocks[signal.id];
    const events: [string, string][] = [];
    for (const [time, raw] of block.events) {
      const tick = String(Math.max(start, Number(time)));
      const value = WaveSignal.project(raw, signal);
      if (events.at(-1)?.[0] === tick) events[events.length - 1][1] = value;
      else if (events.at(-1)?.[1] !== value) events.push([tick, value]);
    }
    if (events[0]?.[0] !== String(start))
      events.unshift([
        String(start),
        signal.real ? "NaN" : "x".repeat(signal.width),
      ]);
    return {
      path: [
        signal.scope,
        WaveSignal.label({ ...signal, displayName: undefined }),
      ]
        .filter(Boolean)
        .join("."),
      label: WaveSignal.label(signal),
      group: signal.group,
      width: signal.width,
      ...(signal.real ? { real: true, unit: signal.unit } : {}),
      decoder: signal.decoder,
      annotation: signal.annotation,
      events,
      truncated: block.truncated,
    };
  });
  return {
    waveform: source.filename,
    timescale: source.meta.scale,
    start: String(start),
    end: String(end),
    traces,
    eventLimitPerSignal: limit,
    truncated: traces.some((trace) => trace.truncated),
    markers: view.markers.filter(
      (marker) => marker.time >= start && marker.time <= end,
    ),
  };
}

export function serializeClip(
  clip: WaveClip,
  format: Exclude<ClipFormat, "png">,
) {
  if (format === "json") return JSON.stringify(clip, null, 2) + "\n";
  if (format === "csv") {
    const hertz = scaleHertz(clip.timescale);
    const mixed =
      hertz !== undefined || clip.traces.some((trace) => trace.real);
    const rows = [
      mixed
        ? "signal,tick,timescale,value,truncated,value_type,unit" +
          (hertz === undefined ? "" : ",frequency_hz")
        : "signal,tick,timescale,value_binary,truncated",
    ];
    const csvField = (value: string) => '"' + value.replaceAll('"', '""') + '"';
    for (const trace of clip.traces) {
      for (const [time, value] of trace.events)
        rows.push(
          [
            csvField(trace.path),
            time,
            csvField(clip.timescale),
            csvField(value),
            String(trace.truncated),
            ...(mixed
              ? [trace.real ? "real" : "digital", csvField(trace.unit ?? "")]
              : []),
            ...(hertz === undefined ? [] : [String(Number(time) * hertz)]),
          ].join(","),
        );
    }
    return rows.join("\n") + "\n";
  }

  // VCD uses offset timestamps and stable ASCII references. Comments preserve original paths.
  const scale = /^(1|10|100)\s*(s|ms|us|ns|ps|fs)$/.exec(
    clip.timescale.toLowerCase(),
  );
  if (!scale) throw Error("The source timescale cannot be represented in VCD");
  const rows = [
    `$timescale ${scale[1]} ${scale[2]} $end`,
    `$comment First tick in source: ${clip.start} $end`,
    "$scope module clip $end",
  ];
  const transitions = new Map<number, string[]>();
  for (const [index, trace] of clip.traces.entries()) {
    const ref = "s" + index;
    const leaf = trace.label.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 80);
    const original = trace.path.replace(/[\r\n$]/g, "_");
    rows.push(
      `$comment ${ref} = ${original} $end`,
      `$var ${trace.real ? "real 64" : "wire " + trace.width} ${ref} ${ref}_${leaf} $end`,
    );
    for (const [time, value] of trace.events) {
      const offset = Number(time) - Number(clip.start);
      if (!trace.real && !/^[01xz]+$/i.test(value))
        throw Error("Invalid digital signal value in VCD export");
      if (!transitions.has(offset)) transitions.set(offset, []);
      transitions
        .get(offset)
        .push(
          trace.real
            ? `r${realValue(value) ?? "NaN"} ${ref}`
            : trace.width === 1
              ? value + ref
              : `b${value} ${ref}`,
        );
    }
  }
  rows.push("$upscope $end", "$enddefinitions $end");
  for (const [offset, values] of [...transitions].sort(
    ([left], [right]) => left - right,
  ))
    rows.push("#" + offset, ...values);
  const duration = Number(clip.end) - Number(clip.start);
  if (!transitions.has(duration)) rows.push("#" + duration);
  return rows.join("\n") + "\n";
}
