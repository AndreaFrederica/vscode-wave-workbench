// SPDX-License-Identifier: MPL-2.0

import { realValue } from "../shared/analog";

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
) {
  let min = Infinity,
    max = -Infinity;
  const steps: { first: number; last: number; value: number | undefined }[] =
    [];
  for (let index = 0; index < events.length; index++) {
    const [tick, raw] = events[index];
    const first = Math.max(Number(tick), start);
    const last = Math.min(Number(events[index + 1]?.[0] ?? end), end);
    if (first > end) break;
    if (last < first) continue;
    const value = realValue(raw);
    steps.push({ first, last, value });
    if (value !== undefined) {
      min = Math.min(min, value);
      max = Math.max(max, value);
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
  for (const { first, last, value } of steps) {
    if (value === undefined) {
      previousEnd = undefined;
      continue;
    }
    const ordinate = y(value);
    if (previousEnd === first) ctx.lineTo(x(first), ordinate);
    else ctx.moveTo(x(first), ordinate);
    ctx.lineTo(x(last), ordinate);
    previousEnd = last;
  }
  ctx.stroke();
  return { min, max };
}
