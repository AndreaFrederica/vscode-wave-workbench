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
async function findSignal(backend: Backend, name: string, delimiter = "/") {
  const normalized = normalName(name, delimiter);
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
  throw new Error(`Dumped signal not found: ${name}`);
}

async function readSignalAt(backend: Backend, signal: Signal, time: number) {
  const tick = String(time);
  const block = (
    await backend.request("query", {
      signals: [signal.id],
      start: tick,
      end: tick,
      limit: 100000,
    })
  )[signal.id];
  if (block?.truncated)
    throw Error("Value query has too many same-tick events");
  return project(block?.events.at(-1)?.[1], signal);
}

export { findSignal, normalName, readSignalAt };
