// SPDX-License-Identifier: MPL-2.0

import { interpolateReal, realValue } from "../shared/analog";

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
) {
  let min = Infinity,
    max = -Infinity;
  const steps: {
    first: number;
    last: number;
    value: number | undefined;
    endValue?: number;
  }[] = [];
  for (let index = 0; index < events.length; index++) {
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
  const scale = Math.max(Math.abs(min), Math.abs(max)) || 1;
  const span = max / scale - min / scale;
  const y = (value: number) =>
    span
      ? bottom - ((bottom - top) * (value / scale - min / scale)) / span
      : (top + bottom) / 2;
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
  return { min, max };
}
