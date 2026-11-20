// SPDX-License-Identifier: MPL-2.0

export function realValue(value?: string): number | undefined {
  if (!value || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value))
    return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

export function realLabel(value?: string) {
  return realValue(value) === undefined ? "—" : value!;
}

export function interpolateReal(left: string, right: string, fraction: number) {
  const a = realValue(left),
    b = realValue(right);
  return a === undefined || b === undefined
    ? undefined
    : (1 - fraction) * a + fraction * b;
}

export function measureAnalog(
  events: readonly [string, string][],
  start: bigint,
  end: bigint,
  linear = false,
) {
  if (end <= start) throw Error("Choose a non-empty measurement interval.");
  let min = Infinity,
    max = -Infinity,
    sum = 0,
    squares = 0,
    span = 0;
  let covered = 0n;
  const duration = Number(end - start);
  const samples = events.map(([, value]) => realValue(value));
  const amplitude =
    samples.reduce<number>(
      (largest, value) =>
        value === undefined ? largest : Math.max(largest, Math.abs(value)),
      0,
    ) || 1;
  for (let index = 0; index < events.length; index++) {
    const tick = BigInt(events[index][0]);
    const next = index + 1 < events.length ? BigInt(events[index + 1][0]) : end;
    const first = tick > start ? tick : start;
    const last = next < end ? next : end;
    const value = samples[index];
    if (value === undefined || last <= first) continue;
    const weight = Number(last - first) / duration;
    const a = value / amplitude;
    const nextValue = linear ? samples[index + 1] : undefined;
    const b = nextValue === undefined ? a : nextValue / amplitude;
    const at = (time: bigint) => {
      const fraction = Number(time - tick) / Number(next - tick);
      return (1 - fraction) * a + fraction * b;
    };
    const left = a === b ? a : at(first);
    const right = a === b ? a : at(last);
    min = Math.min(
      min,
      a === b ? value : left * amplitude,
      a === b ? value : right * amplitude,
    );
    max = Math.max(
      max,
      a === b ? value : left * amplitude,
      a === b ? value : right * amplitude,
    );
    sum += (a === b ? a : (left + right) / 2) * weight;
    squares +=
      (a === b ? a * a : (left * left + left * right + right * right) / 3) *
      weight;
    span += weight;
    covered += last - first;
  }
  if (!covered) throw Error("No finite real samples in the selected interval.");
  const peakToPeak = max - min;
  return {
    min,
    max,
    peakToPeak: Number.isFinite(peakToPeak) ? peakToPeak : null,
    mean: (sum / span) * amplitude,
    rms: Math.sqrt(squares / span) * amplitude,
    coveredTicks: String(covered),
    durationTicks: String(end - start),
  };
}

export function thresholdSamples(
  events: readonly [string, string][],
  lower: number,
  upper: number,
): [string, string][] {
  if (!Number.isFinite(lower) || !Number.isFinite(upper) || lower >= upper)
    throw Error("Specify finite thresholds with lower < upper.");
  const result: [string, string][] = [];
  for (const [tick, raw] of events) {
    const value = realValue(raw);
    const last = result.at(-1);
    const state =
      value === undefined
        ? "x"
        : value >= upper
          ? "1"
          : value <= lower
            ? "0"
            : (last?.[1] ?? "x");
    if (last?.[0] === tick) last[1] = state;
    else if (last?.[1] !== state) result.push([tick, state]);
  }
  return result;
}
