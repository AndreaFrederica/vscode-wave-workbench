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
export function kdbGenerateScope(scope: string) {
  // VCS FSDB escapes negative generate indices that KDB spells directly.
  return scope.replace(
    /(^|\.)\\([a-zA-Z_][\w$]*) \[(-\d+)\](?=\.|$)/g,
    "$1$2[$3]",
  );
}

export function fsdbGenerateScope(scope: string) {
  return scope.replace(
    /(^|\.)([a-zA-Z_][\w$]*)\[(-\d+)\](?=\.|$)/g,
    "$1\\$2 [$3]",
  );
}

async function exactSignal(backend: Backend, fullname: string) {
  const boundary = fullname.lastIndexOf(".");
  const alias =
    boundary < 0
      ? fullname
      : fsdbGenerateScope(fullname.slice(0, boundary)) +
        fullname.slice(boundary);
  for (const query of new Set([fullname, alias])) {
    const { signals } = await backend.request("search", { query });
    const exact = signals.find(
      (signal) => normalName(signal.scope + "." + signal.name, ".") === query,
    );
    if (exact) return exact;
  }
}

async function lookupSignal(backend: Backend, normalized: string) {
  const exact = await exactSignal(backend, normalized);
  if (exact) return exact;
  const bit = /^(.*)\[(-?\d+)\]$/.exec(normalized);
  if (bit) {
    const s = await exactSignal(backend, bit[1]);
    if (s) {
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
  const [signal] = name.startsWith("@virtual:")
    ? await backend.request("describe", { descriptors: [{ id: name }] })
    : [await lookupSignal(backend, normalName(name, delimiter))];
  if (!signal) throw new Error(`Dumped signal not found: ${name}`);
  return signal;
}

async function findRtlSignals(backend: Backend, scope: string, name: string) {
  const aggregate = scope + "." + name.split("[", 1)[0];
  const signal =
    (await lookupSignal(backend, scope + "." + name)) ||
    (await lookupSignal(backend, aggregate + "." + name));
  if (signal)
    return { signals: signal.supported ? [signal] : [], partial: false };

  // Array elements can be recorded directly or under an aggregate trace scope.
  const limit = 16;
  const prefix = scope + "." + name + "[";
  const direct = await backend.request("search", { query: prefix });
  const result = direct.total
    ? direct
    : await backend.request("search", { query: aggregate + "." + name + "[" });
  const members = result.signals
    .filter(
      (entry) =>
        entry.supported &&
        (entry.scope === scope || entry.scope === aggregate) &&
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
