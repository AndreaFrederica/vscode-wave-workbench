// SPDX-License-Identifier: MPL-2.0

import { interpolateReal, realValue } from "../shared/analog";
import type { OverviewBin } from "../shared/protocol";

export interface AnalogRange {
  min: number;
  max: number;
}

export function overviewRange(
  bins: readonly OverviewBin[],
): AnalogRange | undefined {
  if (!bins.length) return;
  let min = Infinity,
    max = -Infinity;
  for (const [, , low, high] of bins) {
    min = Math.min(min, Number(low));
    max = Math.max(max, Number(high));
  }
  return { min, max };
}

export function analogOrdinate(
  range: AnalogRange,
  top: number,
  bottom: number,
) {
  const { min, max } = range;
  const scale = Math.max(Math.abs(min), Math.abs(max)) || 1;
  const span = max / scale - min / scale;
  return (value: number) => {
    const ratio = span ? (value / scale - min / scale) / span : 0.5;
    return bottom - (bottom - top) * Math.max(0, Math.min(1, ratio));
  };
}

export function drawAnalogOverview(
  ctx: CanvasRenderingContext2D,
  bins: readonly OverviewBin[],
  x: (tick: number) => number,
  top: number,
  bottom: number,
  limits?: AnalogRange,
) {
  const range = limits ?? overviewRange(bins);
  if (!range) return;
  const y = analogOrdinate(range, top, bottom);
  ctx.beginPath();
  for (const [start, end, min, max] of bins) {
    const left = x(Number(start)),
      right = x(Number(end));
    const low = y(Number(min)),
      high = y(Number(max));
    ctx.moveTo(left, low);
    ctx.lineTo(right, low);
    if (high !== low) {
      ctx.lineTo(right, high);
      ctx.lineTo(left, high);
      ctx.lineTo(left, low);
    }
  }
  ctx.stroke();
  return range;
}

export function drawAnalogOverviewSamples(
  ctx: CanvasRenderingContext2D,
  bins: readonly OverviewBin[],
  start: number,
  end: number,
  x: (tick: number) => number,
  top: number,
  bottom: number,
  limits?: AnalogRange,
) {
  const range =
    limits ??
    overviewRange(
      bins.filter(
        ([first, last]) => Number(first) <= end && Number(last) >= start,
      ),
    );
  if (!range) return;
  const y = analogOrdinate(range, top, bottom);
  ctx.beginPath();
  let previousSegment: number | undefined;
  for (const [, , , , samples] of bins) {
    for (const [tick, value, segment] of samples ?? []) {
      const px = x(Number(tick));
      const py = y(value);
      if (segment === previousSegment) {
        ctx.lineTo(px, py);
      } else {
        ctx.moveTo(px, py);
        ctx.lineTo(px + 0.5, py);
        ctx.moveTo(px, py);
      }
      previousSegment = segment;
    }
  }
  ctx.stroke();
  return range;
}

export function drawAnalog(
  ctx: Pick<
    CanvasRenderingContext2D,
    "beginPath" | "moveTo" | "lineTo" | "stroke"
  >,
  events: readonly [string, string][],
  start: number,
  end: number,
  x: (tick: number) => number,
  top: number,
  bottom: number,
  linear = false,
  limits?: AnalogRange,
) {
  let min = Infinity,
    max = -Infinity;
  const steps: {
    first: number;
    last: number;
    value: number | undefined;
    endValue?: number;
  }[] = [];
  let firstSample = 0;
  let after = events.length;
  while (firstSample < after) {
    const mid = Math.floor((firstSample + after) / 2);
    if (Number(events[mid][0]) < start) firstSample = mid + 1;
    else after = mid;
  }
  for (
    let index = Math.max(0, firstSample - 1);
    index < events.length;
    index++
  ) {
    const [tick, raw] = events[index];
    const first = Math.max(Number(tick), start);
    const last = Math.min(Number(events[index + 1]?.[0] ?? end), end);
    if (first > end) break;
    if (last < first) continue;
    const next = events[index + 1];
    const at = (time: number) =>
      linear && next && Number(next[0]) > Number(tick)
        ? interpolateReal(
            raw,
            next[1],
            (time - Number(tick)) / (Number(next[0]) - Number(tick)),
          )
        : undefined;
    const value = at(first) ?? realValue(raw);
    const endValue = at(last) ?? value;
    steps.push({ first, last, value, endValue });
    if (value !== undefined && endValue !== undefined) {
      min = Math.min(min, value, endValue);
      max = Math.max(max, value, endValue);
    }
  }
  if (min > max) return undefined;
  const range = limits ?? { min, max };
  const y = analogOrdinate(range, top, bottom);
  ctx.beginPath();
  let previousEnd: number | undefined;
  for (const { first, last, value, endValue } of steps) {
    if (value === undefined) {
      previousEnd = undefined;
      continue;
    }
    const ordinate = y(value);
    if (previousEnd === first) ctx.lineTo(x(first), ordinate);
    else ctx.moveTo(x(first), ordinate);
    ctx.lineTo(x(last), y(endValue ?? value));
    previousEnd = last;
  }
  ctx.stroke();
  return range;
}
