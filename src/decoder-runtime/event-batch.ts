// SPDX-License-Identifier: MPL-2.0

import type { Backend } from "../backend";
import type { Signal } from "../shared/protocol";
import { project } from "../shared/signals";
import { maxBatchEvents, type EventBatch } from "./types";

export interface DecoderEvent {
  tick: string;
  input: number;
  value: string;
}
const text = new TextDecoder();
const encode = new TextEncoder();

export function packEvents(
  start: bigint,
  end: bigint,
  initial: (string | null)[],
  events: readonly DecoderEvent[],
): EventBatch {
  const offsets = new Uint32Array(events.length + 1);
  const inputs = new Uint32Array(events.length);
  const values = new Uint8Array(
    events.reduce((count, event) => count + event.value.length, 0),
  );
  const times =
    end <= 1n << 64n
      ? new BigUint64Array(events.length)
      : new Array<string>(events.length);
  events.forEach((event, index) => {
    inputs[index] = event.input;
    if (Array.isArray(times)) times[index] = event.tick;
    else times[index] = BigInt(event.tick);
    offsets[index + 1] =
      offsets[index] +
      encode.encodeInto(event.value, values.subarray(offsets[index])).written;
  });
  return {
    start: String(start),
    end: String(end),
    initial,
    inputs,
    offsets,
    values,
    times,
  };
}

export function scriptEvents(batch: EventBatch) {
  return {
    start: batch.start,
    end: batch.end,
    initial: batch.initial,
    count: batch.inputs.length,
    *events() {
      for (let i = 0; i < batch.inputs.length; ++i) {
        yield {
          tick: String(batch.times[i]),
          input: batch.inputs[i],
          value: text.decode(
            batch.values.subarray(batch.offsets[i], batch.offsets[i + 1]),
          ),
        };
      }
    },
  };
}

export async function* readEventBatches(
  backend: Backend,
  bindings: (Signal | null)[],
  start: bigint,
  end: bigint,
  signal: AbortSignal,
): AsyncGenerator<EventBatch> {
  const ids = [
    ...new Set(bindings.flatMap((binding) => (binding ? [binding.id] : []))),
  ];
  const limit = Math.max(2, Math.floor(maxBatchEvents / bindings.length));
  async function* read(
    first: bigint,
    last: bigint,
  ): AsyncGenerator<EventBatch> {
    signal.throwIfAborted();
    const blocks = await backend.request("query", {
      signals: ids,
      start: String(first),
      end: String(last - 1n),
      limit,
      preserveSameTick: true,
    });
    signal.throwIfAborted();
    if (ids.some((id) => !blocks[id] || blocks[id].truncated)) {
      if (last - first <= 1n)
        throw Error(
          "The waveform limit truncates a decoder batch at tick " + first,
        );
      const middle = (first + last) / 2n;
      yield* read(first, middle);
      yield* read(middle, last);
      return;
    }
    const events: DecoderEvent[] = [];
    const initial = bindings.map((binding, input) => {
      let seed: string | null = null;
      if (!binding) return seed;
      for (const [tick, raw] of blocks[binding.id].events) {
        const value = project(raw, binding)?.toLowerCase();
        if (!value || !/^[01xz]+$/.test(value) || value.length > binding.width)
          throw Error("Invalid digital decoder sample for " + binding.name);
        const bits = value.padStart(
          binding.width,
          /^[xz]/.test(value) ? value[0] : "0",
        );
        if (BigInt(tick) < first) seed = bits;
        else if (BigInt(tick) < last) events.push({ tick, input, value: bits });
      }
      return seed;
    });
    events.sort((a, b) =>
      a.tick === b.tick
        ? a.input - b.input
        : BigInt(a.tick) < BigInt(b.tick)
          ? -1
          : 1,
    );
    yield packEvents(first, last, initial, events);
  }
  if (ids.length && start < end) yield* read(start, end);
}
