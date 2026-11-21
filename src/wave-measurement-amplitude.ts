// SPDX-License-Identifier: MPL-2.0

import { realValue } from "./shared/analog";
import type { Samples } from "./wave-measurement-timing";

function above(low: number, high: number, level: number) {
  if (high <= level) return 0;
  if (low >= level) return (low + high) / 2 - level;
  return ((high - level) / (high - low)) * ((high - level) / 2);
}

export function amplitudeStats(
  events: Samples,
  start: bigint,
  end: bigint,
  linear: boolean,
  secondsPerTick: number,
  gate: readonly [number, number] = [0, Number(end - start)],
) {
  const [first, last] = gate;
  const tickAt = (index: number) => Number(BigInt(events[index][0]) - start);
  const after = (offset: number) => {
    let left = 0,
      right = events.length;
    while (left < right) {
      const middle = Math.floor((left + right) / 2);
      if (tickAt(middle) <= offset) left = middle + 1;
      else right = middle;
    }
    return left;
  };
  const firstIndex = Math.max(0, after(first) - 1);
  const lastIndex = Math.min(events.length, after(last) + 1);
  const size = lastIndex - firstIndex;
  const offsets = new Float64Array(size);
  const values = new Float64Array(size);
  let scale = 0;
  for (let index = 0; index < size; index++) {
    offsets[index] = tickAt(firstIndex + index);
    const value = realValue(events[firstIndex + index][1]);
    values[index] = value ?? NaN;
    if (value !== undefined) scale = Math.max(scale, Math.abs(value));
  }
  scale ||= 1;

  const lows = new Float64Array(size);
  const highs = new Float64Array(size);
  const weights = new Float64Array(size);
  let count = 0,
    hasSlope = false;
  let weight = 0,
    mean = 0,
    sum = 0,
    variance = 0,
    coveredTicks = 0;
  let min = Infinity,
    max = -Infinity,
    minAt = first,
    maxAt = first;
  for (let index = 0; index < size; index++) {
    const offset = offsets[index];
    const next = offsets[index + 1];
    const left = Math.max(first, offset);
    const right = Math.min(last, next ?? last);
    const value = values[index];
    if (!Number.isFinite(value) || right <= left) continue;
    const a = value / scale;
    const b =
      linear && Number.isFinite(values[index + 1])
        ? values[index + 1] / scale
        : a;
    const at = (tick: number) => {
      if (a === b) return a;
      const fraction = (tick - offset) / (next - offset);
      return (1 - fraction) * a + fraction * b;
    };
    const leftLevel = at(left),
      rightLevel = at(right);
    const low = Math.min(leftLevel, rightLevel),
      high = Math.max(leftLevel, rightLevel);
    if (low < min) {
      min = low;
      minAt = leftLevel === low ? left : right;
    }
    if (high > max) {
      max = high;
      maxAt = leftLevel === high ? left : right;
    }
    coveredTicks += right - left;
    const span = (right - left) / (last - first);
    const center = (low + high) / 2;
    const change = center - mean;
    const fraction = span / (weight + span);
    variance += span * ((high - low) ** 2 / 12 + (1 - fraction) * change ** 2);
    mean += fraction * change;
    sum += span * center;
    weight += span;
    lows[count] = low;
    highs[count] = high;
    weights[count] = span;
    count++;
    hasSlope ||= low !== high;
  }
  if (!weight) return;
  let median = min;
  if (!hasSlope) {
    const order = Uint32Array.from({ length: count }, (_, index) => index);
    order.sort((a, b) => lows[a] - lows[b]);
    let cumulative = 0;
    for (const index of order) {
      cumulative += weights[index];
      median = lows[index];
      if (cumulative >= weight / 2) break;
    }
  } else {
    let low = min,
      high = max;
    for (let pass = 0; pass < 48; pass++) {
      const mid = (low + high) / 2;
      let below = 0;
      for (let index = 0; index < count; index++) {
        const a = lows[index],
          b = highs[index];
        if (mid >= b) below += weights[index];
        else if (mid > a) below += weights[index] * ((mid - a) / (b - a));
      }
      if (below >= weight / 2) high = mid;
      else low = mid;
    }
    median = high;
  }
  mean = sum / weight;
  const std = Math.sqrt(variance / weight);
  const area = (level: number) => {
    let positive = 0,
      negative = 0;
    for (let index = 0; index < count; index++) {
      positive += above(lows[index], highs[index], level) * weights[index];
      negative += above(-highs[index], -lows[index], -level) * weights[index];
    }
    const areaScale = (last - first) * secondsPerTick;
    const convert = (value: number) => value * areaScale * scale;
    return [
      convert(positive),
      convert(-negative),
      convert(positive - negative),
      convert(positive + negative),
    ] as const;
  };
  return {
    min: min * scale,
    max: max * scale,
    peakToPeak: (max - min) * scale,
    coveredTicks,
    mean: mean * scale,
    rms: Math.hypot(mean, std) * scale,
    std: std * scale,
    median: median * scale,
    minAt,
    maxAt,
    dc: area(0),
    ac: area(mean),
  };
}
