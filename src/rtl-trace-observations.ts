// SPDX-License-Identifier: MPL-2.0

import type { Backend } from "./backend";
import type { Metadata, QueryResult, Signal } from "./shared/protocol";
import { label, project } from "./shared/signals";
import { normalizeBits } from "./rtl-trace-values";

interface CursorSamples {
  initial?: { tick: string; value: string | undefined };
  events: { tick: string; value: string | undefined }[];
  truncated: boolean;
}

function traceSample(raw: string | undefined, signal: Signal) {
  if (signal.real) return raw;
  const value = project(raw, signal);
  return normalizeBits(value, signal.width) ?? value;
}

export function tracePackedSelection(binding?: Signal) {
  const declared = /\[\s*(-?\d+)\s*:\s*(-?\d+)\s*\]$/.exec(binding?.name ?? "");
  const parsedRange = declared
    ? ([Number(declared[1]), Number(declared[2])] as const)
    : undefined;
  const range =
    binding?.packedRange ??
    (parsedRange?.every(Number.isSafeInteger) ? parsedRange : undefined);
  const offset = binding?.bitOffset;
  const bit =
    range &&
    offset !== undefined &&
    Math.abs(range[0] - range[1]) + 1 === binding.sourceWidth
      ? range[1] + (range[0] < range[1] ? -1 : 1) * offset
      : undefined;
  return { range, bit, projected: Number.isInteger(offset) };
}

async function findProjectedTransition(
  backend: Backend,
  signal: Signal,
  fileStart: bigint,
  anchor: bigint,
  span: bigint,
  operation?: AbortSignal,
) {
  let end = anchor;
  let window = span;
  let dense = false;
  for (let attempt = 0; attempt < 8; attempt++) {
    operation?.throwIfAborted();
    const start = end - fileStart > window ? end - window : fileStart;
    const seed = start > fileStart ? start - 1n : start;
    const result = await backend.request("query", {
      signals: [signal.id],
      start: seed.toString(),
      end: end.toString(),
      limit: 128,
      preserveSameTick: true,
    });
    const block = result[signal.id];
    if (!block) return { limited: true };
    if (block.truncated) {
      if (end - start <= 1n) return { limited: true };
      window = (end - start) / 2n;
      dense = true;
      continue;
    }
    let previous: string | undefined;
    let transition: bigint | undefined;
    for (const [tick, raw] of block.events) {
      const value = traceSample(raw, signal);
      if (previous !== undefined && value !== undefined && value !== previous)
        transition = BigInt(tick);
      previous = value;
    }
    if (transition !== undefined) return { transition, limited: false };
    if (start === fileStart) return { limited: false };
    end = start;
    if (!dense) window *= 4n;
  }
  return { limited: true };
}

export async function readTraceObservations(
  backend: Backend,
  metadata: Pick<Metadata, "start" | "end" | "scale"> &
    Pick<Metadata, "supportsOrderedHistory">,
  signals: ReadonlyMap<number, Signal>,
  tick: string,
  historyStart = tick,
  root?: number,
  signedness?: ReadonlyMap<number, boolean>,
  operation?: AbortSignal,
  historyAnchor?: string,
) {
  operation?.throwIfAborted();
  const isTick = (value: string) => /^\d{1,20}$/.test(value);
  if (!isTick(tick) || (historyStart !== "auto" && !isTick(historyStart))) {
    throw Error("Trace time must be a decimal waveform tick.");
  }
  const position = BigInt(tick);
  const fileStart = BigInt(metadata.start);
  let lower = historyStart === "auto" ? position : BigInt(historyStart);
  if (
    lower < fileStart ||
    lower > position ||
    position > BigInt(metadata.end)
  ) {
    throw Error("Trace observation window is outside the waveform.");
  }

  // A point query can supply the last event's original timestamp. Center the
  // history on that timestamp when a signal has held since its last write.
  let historyEnd = position;
  let automaticSearchLimited = false;
  let projectedTransition: bigint | undefined;
  const rootBinding = root === undefined ? undefined : signals.get(root);
  if (historyStart === "auto" && rootBinding && position > fileStart) {
    const timestamp =
      historyAnchor ??
      (
        await backend.request("query", {
          signals: [rootBinding.id],
          start: tick,
          end: tick,
          limit: 2,
        })
      )[rootBinding.id]?.events.at(-1)?.[0];
    if (
      timestamp &&
      isTick(timestamp) &&
      BigInt(timestamp) >= fileStart &&
      BigInt(timestamp) <= position
    )
      historyEnd = BigInt(timestamp);
    const units = {
      fs: 1n,
      ps: 1000n,
      ns: 1_000_000n,
      us: 1_000_000_000n,
      ms: 1_000_000_000_000n,
      s: 1_000_000_000_000_000n,
    };
    const scale = /^(\d+)\s*(fs|ps|ns|us|ms|s)$/i.exec(metadata.scale);
    const tickFs =
      scale &&
      BigInt(scale[1]) * units[scale[2].toLowerCase() as keyof typeof units];
    const span = tickFs ? 64_000_000n / tickFs + 2n : 256n;
    if (historyAnchor === undefined && rootBinding.bitOffset !== undefined) {
      const fallback = await findProjectedTransition(
        backend,
        rootBinding,
        fileStart,
        historyEnd,
        span,
        operation,
      );
      automaticSearchLimited = fallback.limited;
      projectedTransition = fallback.transition;
      historyEnd = projectedTransition ?? historyEnd;
    }
    lower = historyEnd - fileStart > span ? historyEnd - span : fileStart;
  }

  const ids = [...new Set(Array.from(signals.values(), ({ id }) => id))];
  const blocks = Object.create(null) as QueryResult;
  const cursorBlocks =
    historyEnd === position ? blocks : (Object.create(null) as QueryResult);
  // Readers with ordered history include the value strictly before the start.
  // Earlier readers need a one-tick lookback to seed a boundary transition.
  const orderedStart = metadata.supportsOrderedHistory;
  const queryStart = !orderedStart && lower > fileStart ? lower - 1n : lower;
  const cursorStart =
    !orderedStart && position > fileStart ? position - 1n : position;
  for (let offset = 0; offset < ids.length; offset += 64) {
    operation?.throwIfAborted();
    Object.assign(
      blocks,
      await backend.request("query", {
        signals: ids.slice(offset, offset + 64),
        start: queryStart.toString(),
        end: historyEnd.toString(),
        limit: 128,
        preserveSameTick: true,
      }),
    );
    if (cursorBlocks !== blocks)
      Object.assign(
        cursorBlocks,
        await backend.request("query", {
          signals: ids.slice(offset, offset + 64),
          start: cursorStart.toString(),
          end: tick,
          limit: 128,
          preserveSameTick: true,
        }),
      );
  }
  let focusedRoot: QueryResult[string] | undefined;
  if (
    rootBinding &&
    projectedTransition !== undefined &&
    blocks[rootBinding.id]?.truncated
  ) {
    operation?.throwIfAborted();
    const result = await backend.request("query", {
      signals: [rootBinding.id],
      start: (orderedStart
        ? projectedTransition
        : projectedTransition - 1n
      ).toString(),
      end: projectedTransition.toString(),
      limit: 128,
      preserveSameTick: true,
    });
    focusedRoot = result[rootBinding.id];
  }
  operation?.throwIfAborted();
  function observe(signal: number, binding: Signal, narrowed = false) {
    const block = narrowed && focusedRoot ? focusedRoot : blocks[binding.id];
    const observationStart =
      narrowed && focusedRoot && projectedTransition !== undefined
        ? projectedTransition
        : lower;
    const samples =
      block?.events.map(([tick, value]) => ({
        tick,
        value: traceSample(value, binding),
      })) ?? [];
    const initial = samples.findLast(
      ({ tick }) => BigInt(tick) < observationStart,
    );
    const cursor = cursorBlocks === blocks ? block : cursorBlocks[binding.id];
    const cursorSamples =
      cursor === block
        ? samples
        : (cursor?.events.map(([tick, value]) => ({
            tick,
            value: traceSample(value, binding),
          })) ?? []);
    const value = cursor?.truncated
      ? undefined
      : traceSample(cursor?.events.at(-1)?.[1], binding);
    return {
      signal,
      width: binding.width,
      real: binding.real || undefined,
      signed: signedness?.get(signal),
      ...tracePackedSelection(binding),
      waveformSignal:
        binding.scope + "." + label({ ...binding, displayName: undefined }),
      value,
      status: cursor?.truncated
        ? "truncated"
        : value === undefined
          ? "unavailable"
          : "observed",
      initial,
      history: samples.filter(({ tick }) => BigInt(tick) >= observationStart),
      historyLimitedToTransition: narrowed && focusedRoot ? true : undefined,
      historyTruncated: block?.truncated ?? false,
      cursorSamples: {
        initial: cursorSamples.findLast(({ tick }) => BigInt(tick) < position),
        events: cursorSamples.filter(({ tick }) => BigInt(tick) === position),
        truncated: cursor?.truncated ?? true,
      } as CursorSamples | undefined,
    };
  }
  const observations = Array.from(signals, ([signal, binding]) =>
    observe(signal, binding, signal === root),
  );
  const wholeRoot =
    root !== undefined &&
    rootBinding?.bitOffset !== undefined &&
    rootBinding.sourceWidth
      ? observe(root, {
          ...rootBinding,
          width: rootBinding.sourceWidth,
          bitOffset: undefined,
          sourceWidth: undefined,
        })
      : undefined;
  return {
    tick: position.toString(),
    historyStart: lower.toString(),
    historyEnd: historyEnd.toString(),
    scale: metadata.scale,
    automaticSearchLimited: automaticSearchLimited || undefined,
    observations,
    ...(wholeRoot ? { wholeRoot } : {}),
  };
}
