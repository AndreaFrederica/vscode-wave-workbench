// SPDX-License-Identifier: MPL-2.0

import { interpolateReal, realValue } from "./shared/analog";

export type Samples = [string, string][];
type Direction = "rise" | "fall";
interface Edge {
  offset: number;
  direction: Direction;
  span: number;
}

export function analogExtrema(events: Samples, start: bigint, end: bigint) {
  let min = Infinity,
    max = -Infinity;
  for (const [index, [time, raw]] of events.entries()) {
    const tick = BigInt(time);
    if (tick > end) break;
    const next = events[index + 1];
    if (tick < start && next && BigInt(next[0]) <= start) continue;
    const value =
      tick < start && next
        ? interpolateReal(
            raw,
            next[1],
            Number(start - tick) / Number(BigInt(next[0]) - tick),
          )
        : realValue(raw);
    if (value === undefined) continue;
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  return { min, max };
}

export function crossingFraction(
  threshold: number,
  left: number,
  right: number,
) {
  const difference = right - left;
  return Number.isFinite(difference)
    ? (threshold - left) / difference
    : (threshold / 2 - left / 2) / (right / 2 - left / 2);
}

export function thresholdEdges(
  events: Samples,
  start: bigint,
  end: bigint,
  threshold?: number,
) {
  const edges: Edge[] = [];
  const spans: { first: number; last: number; endOpen?: boolean }[] = [];
  let previous: number | undefined;
  let previousTick = 0;
  let span: (typeof spans)[number] | undefined;
  const limit = Number(end - start);
  for (const [time, raw] of events) {
    const offset = Number(BigInt(time) - start);
    if (offset > limit) break;
    const value =
      threshold === undefined
        ? raw === "0" || raw === "1"
          ? Number(raw)
          : undefined
        : realValue(raw);
    if (value === undefined) {
      if (span) {
        span.last = threshold === undefined ? offset : previousTick;
        span.endOpen = threshold === undefined;
      }
      span = undefined;
    } else {
      if (!span) {
        span = { first: offset, last: limit };
        spans.push(span);
      }
      const middle = threshold ?? 0.5;
      if (
        Number.isFinite(middle) &&
        previous !== undefined &&
        previous >= middle !== value >= middle
      ) {
        const crossing =
          threshold === undefined
            ? offset
            : previousTick +
              (offset - previousTick) *
                crossingFraction(middle, previous, value);
        if (crossing >= 0 && crossing <= limit)
          edges.push({
            offset: crossing,
            direction: value >= middle ? "rise" : "fall",
            span: spans.length - 1,
          });
      }
    }
    previous = value;
    previousTick = offset;
  }
  return { edges, spans };
}

export const mean = (values: number[]) =>
  values.length
    ? values.reduce((sum, value) => sum + value / values.length, 0)
    : undefined;

export function pulseTiming(edges: Edge[]) {
  const rise: number[] = [],
    fall: number[] = [];
  const high: number[] = [],
    low: number[] = [];
  const periods: number[] = [],
    jitter: number[] = [];
  let totalHigh = 0,
    totalPeriod = 0;
  let previous: Edge | undefined;
  let previousRise: Edge | undefined;
  let previousPeriod: number | undefined;
  let firstCycle: [number, number] | undefined;
  for (const edge of edges) {
    const rising = edge.direction === "rise";
    (rising ? rise : fall).push(edge.offset);
    if (previous?.span === edge.span && previous.direction !== edge.direction) {
      const width = edge.offset - previous.offset;
      if (width > 0) (rising ? low : high).push(width);
      if (rising && previousRise?.span === edge.span) {
        const period = edge.offset - previousRise.offset;
        if (period > 0) {
          periods.push(period);
          totalHigh += previous.offset - previousRise.offset;
          totalPeriod += period;
          firstCycle ??= [previousRise.offset, edge.offset];
          if (previousPeriod !== undefined)
            jitter.push(Math.abs(period - previousPeriod));
          previousPeriod = period;
        }
      }
    } else {
      previousPeriod = undefined;
    }
    if (rising) previousRise = edge;
    previous = edge;
  }
  return {
    rise,
    fall,
    high,
    low,
    periods,
    jitter,
    totalHigh,
    totalPeriod,
    firstCycle,
  };
}

export function dataMargins(
  data: ReturnType<typeof thresholdEdges>,
  clock: Edge[],
  direction: Direction,
) {
  let setup: number | undefined;
  let hold: number | undefined;
  let index = 0;
  for (const edge of clock) {
    if (edge.direction !== direction) continue;
    while (index < data.edges.length && data.edges[index].offset < edge.offset)
      index++;
    const before = data.edges[index - 1];
    const after = data.edges[index];
    if (after?.offset === edge.offset) {
      setup = hold = 0;
      continue;
    }
    if (before) {
      const span = data.spans[before.span];
      if (
        edge.offset < span.last ||
        (!span.endOpen && edge.offset === span.last)
      )
        setup = Math.min(setup ?? Infinity, edge.offset - before.offset);
    }
    if (after && edge.offset >= data.spans[after.span].first)
      hold = Math.min(hold ?? Infinity, after.offset - edge.offset);
  }
  return { setup, hold };
}
