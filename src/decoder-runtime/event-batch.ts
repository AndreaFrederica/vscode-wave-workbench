// SPDX-License-Identifier: MPL-2.0

import type { Backend } from "../backend";
import type { Signal } from "../shared/protocol";
import { project } from "../shared/signals";
import {
  eventBatchVersion,
  maxBatchEvents,
  type EventBatch,
  type EventBatchHeader,
} from "./types";

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
      : new Uint8Array(
          events.reduce((size, event) => size + 1 + event.tick.length, 0),
        );
  let tickOffset = 0;
  events.forEach((event, index) => {
    inputs[index] = event.input;
    if (times instanceof BigUint64Array) {
      times[index] = BigInt(event.tick);
    } else {
      times[tickOffset++] = event.tick.length;
      tickOffset += encode.encodeInto(
        event.tick,
        times.subarray(tickOffset),
      ).written;
    }
    offsets[index + 1] =
      offsets[index] +
      encode.encodeInto(event.value, values.subarray(offsets[index])).written;
  });
  return {
    version: eventBatchVersion,
    start: String(start),
    end: String(end),
    initial,
    inputs,
    offsets,
    values,
    times,
  };
}

const littleEndian = new Uint8Array(Uint32Array.of(1).buffer)[0] === 1;

function columnBytes(column: BigUint64Array | Uint32Array | Uint8Array) {
  const bytes = new Uint8Array(
    column.buffer,
    column.byteOffset,
    column.byteLength,
  );
  if (littleEndian || column instanceof Uint8Array) return bytes;
  const data = new DataView(new ArrayBuffer(bytes.byteLength));
  if (column instanceof BigUint64Array) {
    column.forEach((value, index) => data.setBigUint64(index * 8, value, true));
  } else {
    column.forEach((value, index) => data.setUint32(index * 4, value, true));
  }
  return new Uint8Array(data.buffer);
}

export function binaryBatch(batch: EventBatch) {
  const header: EventBatchHeader = {
    version: batch.version,
    start: batch.start,
    end: batch.end,
    initial: batch.initial,
    count: batch.inputs.length,
    timeEncoding: batch.times instanceof BigUint64Array ? "u64" : "decimal",
    timeBytes: batch.times.byteLength,
    valueBytes: batch.values.byteLength,
  };
  const columns = [batch.times, batch.inputs, batch.offsets, batch.values];
  return { header, chunks: columns.map(columnBytes) };
}

export function scriptEvents(batch: EventBatch) {
  if (batch.version !== eventBatchVersion)
    throw Error("Unsupported decoder event batch version.");
  return {
    start: batch.start,
    end: batch.end,
    initial: batch.initial,
    count: batch.inputs.length,
    *events() {
      const times = batch.times;
      let tickOffset = 0;
      for (let i = 0; i < batch.inputs.length; ++i) {
        let tick: string;
        if (times instanceof BigUint64Array) {
          tick = String(times[i]);
        } else {
          const length = times[tickOffset++];
          tick = text.decode(times.subarray(tickOffset, tickOffset + length));
          tickOffset += length;
        }
        yield {
          tick,
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
