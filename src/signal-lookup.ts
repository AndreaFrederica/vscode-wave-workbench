// SPDX-License-Identifier: MPL-2.0

import type { Backend } from "./backend";
import type { Signal } from "./shared/protocol";
import { project } from "./shared/signals";

function normalName(name: string, delimiter = "/") {
  return name
    .replace(
      new RegExp(
        "^" +
          (delimiter === "/"
            ? "/"
            : delimiter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) +
          "+",
      ),
      "",
    )
    .split(delimiter)
    .join(".")
    .replace(/\s*\[\s*-?\d+\s*:\s*-?\d+\s*\]$/, "");
}
async function lookupSignal(backend: Backend, normalized: string) {
  let result = await backend.request("search", {
    query: normalized,
  });
  const exact = result.signals.find(
    (s) => normalName(`${s.scope}.${s.name}`, ".") === normalized,
  );
  if (exact) return exact;
  const bit = /^(.*)\[(-?\d+)\]$/.exec(normalized);
  if (bit) {
    result = await backend.request("search", { query: bit[1] });
    for (const s of result.signals) {
      if (normalName(`${s.scope}.${s.name}`, ".") !== bit[1]) continue;
      const range = /\[\s*(-?\d+)\s*:\s*(-?\d+)\s*\]$/.exec(s.name),
        right = range ? Number(range[2]) : 0,
        direction = range && Number(range[1]) < right ? -1 : 1,
        offset = (Number(bit[2]) - right) * direction;
      if (Number.isSafeInteger(offset) && offset >= 0 && offset < s.width)
        return { ...s, width: 1, sourceWidth: s.width, bitOffset: offset };
    }
  }
}

async function findSignal(backend: Backend, name: string, delimiter = "/") {
  const signal = await lookupSignal(backend, normalName(name, delimiter));
  if (!signal) throw new Error(`Dumped signal not found: ${name}`);
  return signal;
}

async function findRtlSignals(backend: Backend, scope: string, name: string) {
  const signal = await lookupSignal(backend, `${scope}.${name}`);
  if (signal)
    return { signals: signal.supported ? [signal] : [], partial: false };

  // FSDB can record the elements of a packed array as separate signals.
  const limit = 16;
  const result = await backend.request("search", {
    query: `${scope}.${name}[`,
  });
  const members = result.signals
    .filter(
      (entry) =>
        entry.supported &&
        entry.scope === scope &&
        entry.name.startsWith(name + "[") &&
        /^(?:\[\s*-?\d+\s*\])+$/.test(
          normalName(entry.name, ".").slice(name.length),
        ),
    )
    .sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }));
  return {
    signals: members.slice(0, limit),
    partial: members.length > limit || result.total > result.signals.length,
  };
}

async function readSignalsAt(
  backend: Backend,
  signals: Signal[],
  time: number,
) {
  const tick = String(time);
  const result = await backend.request("query", {
    signals: [...new Set(signals.map((signal) => signal.id))],
    start: tick,
    end: tick,
    limit: 100000,
  });
  return signals.map((signal) => {
    const block = result[signal.id];
    if (block?.truncated)
      throw Error("Value query has too many same-tick events");
    return project(block?.events.at(-1)?.[1], signal);
  });
}

async function readSignalAt(backend: Backend, signal: Signal, time: number) {
  const [value] = await readSignalsAt(backend, [signal], time);
  return value;
}

export { findRtlSignals, findSignal, normalName, readSignalAt, readSignalsAt };
