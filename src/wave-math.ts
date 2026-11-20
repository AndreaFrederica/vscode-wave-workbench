// SPDX-License-Identifier: MPL-2.0

import { realValue } from "./shared/analog";
import type { Signal } from "./shared/protocol";

type Samples = [string, string][];
type Sample = { tick: bigint; value: number };
type Expression = (values: readonly number[]) => number;

const binaries = {
  "+": { priority: 1, apply: (a: number, b: number) => a + b },
  "-": { priority: 1, apply: (a: number, b: number) => a - b },
  "*": { priority: 2, apply: (a: number, b: number) => a * b },
  "/": { priority: 2, apply: (a: number, b: number) => a / b },
  "%": { priority: 2, apply: (a: number, b: number) => a % b },
  "^": { priority: 4, apply: Math.pow },
} as const;

const functions: Record<string, [number, (...args: number[]) => number]> = {
  abs: [1, Math.abs],
  sqrt: [1, Math.sqrt],
  exp: [1, Math.exp],
  ln: [1, Math.log],
  log10: [1, Math.log10],
  sin: [1, Math.sin],
  cos: [1, Math.cos],
  tan: [1, Math.tan],
  asin: [1, Math.asin],
  acos: [1, Math.acos],
  atan: [1, Math.atan],
  atan2: [2, Math.atan2],
  floor: [1, Math.floor],
  ceil: [1, Math.ceil],
  round: [1, Math.round],
  sign: [1, Math.sign],
  min: [2, Math.min],
  max: [2, Math.max],
  hypot: [2, Math.hypot],
  pow: [2, Math.pow],
  clamp: [3, (value, low, high) => Math.min(Math.max(value, low), high)],
};

export function compileWaveExpression(source: string, inputCount: number) {
  if (source.length > 256) throw Error("表达式最多支持 256 字符。");
  const tokens =
    source.match(
      /(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?|[a-z][a-z0-9]*|[^\s]/gi,
    ) ?? [];
  let index = 0;
  function take(token: string) {
    if (tokens[index++] !== token) throw Error("表达式缺少 " + token);
  }
  function operand(): Expression {
    const token = tokens[index++];
    if (token === "+" || token === "-") {
      const expression = parse(3);
      return token === "+" ? expression : (values) => -expression(values);
    }
    if (token === "(") {
      const expression = parse(1);
      take(")");
      return expression;
    }
    if (/^[A-D]$/.test(token ?? "")) {
      const input = token.charCodeAt(0) - 65;
      if (input >= inputCount) throw Error("未选中输入 " + token);
      return (values) => values[input];
    }
    if (token === "pi" || token === "e")
      return () => (token === "pi" ? Math.PI : Math.E);
    if (token && Object.hasOwn(functions, token)) {
      const [arity, apply] = functions[token];
      take("(");
      const args = Array.from({ length: arity }, (_, i) => {
        if (i) take(",");
        return parse(1);
      });
      take(")");
      return (values) => apply(...args.map((expression) => expression(values)));
    }
    const literal = realValue(token);
    if (literal !== undefined) return () => literal;
    throw Error("未知操作数 " + (token ?? "（表达式结束）"));
  }
  function parse(minPriority: number): Expression {
    let left = operand();
    for (;;) {
      const token = tokens[index] as keyof typeof binaries;
      const binary = binaries[token];
      if (!binary || binary.priority < minPriority) return left;
      index++;
      const right = parse(binary.priority + (token === "^" ? 0 : 1));
      const previous = left;
      left = (values) => binary.apply(previous(values), right(values));
    }
  }
  const expression = parse(1);
  if (index < tokens.length) throw Error("表达式包含多余的 " + tokens[index]);
  return expression;
}

export function numericSamples(
  events: Samples,
  signal: Signal,
  signed: boolean,
): Sample[] {
  return events.map(([tick, raw]) => {
    let value = NaN;
    if (signal.real) {
      value = realValue(raw) ?? NaN;
    } else if (/^[01]+$/.test(raw) && raw.length <= signal.width) {
      const word = BigInt("0b" + raw);
      const integer =
        signed && signal.width > 1 ? BigInt.asIntN(signal.width, word) : word;
      if (integer >= -9007199254740991n && integer <= 9007199254740991n)
        value = Number(integer);
    }
    return { tick: BigInt(tick), value };
  });
}

export const maxMathSamples = 16_384;
export type MathTransform = "pointwise" | "derivative" | "integral";

export function calculateWave(
  expression: Expression,
  inputs: readonly Sample[][],
  start: bigint,
  end: bigint,
  secondsPerTick: number,
  transform: MathTransform,
  fileEnd: bigint,
): Samples {
  const cursors = inputs.map(() => 0);
  const values = inputs.map(() => NaN);
  const result: Samples = [];
  let total = 0;
  let previous = NaN;
  let previousTime = start;
  let tick = start;
  for (;;) {
    let next: bigint | undefined;
    for (const [i, samples] of inputs.entries()) {
      let cursor = cursors[i];
      while (cursor < samples.length && samples[cursor].tick <= tick)
        values[i] = samples[cursor++].value;
      cursors[i] = cursor;
      const candidate = samples[cursor]?.tick;
      if (candidate !== undefined && (next === undefined || candidate < next))
        next = candidate;
    }
    const current = expression(values);
    const elapsed = Number(tick - previousTime) * secondsPerTick;
    let value = current;
    if (transform === "derivative")
      value = elapsed > 0 ? (current - previous) / elapsed : NaN;
    if (transform === "integral") {
      if (elapsed > 0) total += previous * elapsed;
      value = total;
    }
    const encoded = Number.isFinite(value) ? String(value) : "NaN";
    if (result.at(-1)?.[1] !== encoded) result.push([String(tick), encoded]);
    if (result.length > maxMathSamples)
      throw Error("计算结果超过 16384 个采样，请缩小 A/B 区间。");
    if (tick >= end) break;
    previous = Number.isFinite(current) ? current : NaN;
    previousTime = tick;
    tick = next !== undefined && next < end ? next : end;
  }
  if (!result.some(([, value]) => value !== "NaN"))
    throw Error("计算区间内没有可用结果。请检查输入值和算式。");
  if (end < fileEnd && result.at(-1)?.[1] !== "NaN")
    result.push([String(end + 1n), "NaN"]);
  if (result.length > maxMathSamples)
    throw Error("计算结果超过 16384 个采样，请缩小 A/B 区间。");
  return result;
}

export const fftWindows = [
  "hann",
  "hamming",
  "blackman",
  "rectangular",
] as const;
export type FftWindow = (typeof fftWindows)[number];

export function waveSpectrum(
  samples: readonly Sample[],
  start: bigint,
  end: bigint,
  secondsPerTick: number,
  count: number,
  window: FftWindow,
  interpolation: "hold" | "linear",
  removeMean: boolean,
) {
  const span = end - start;
  if (
    !Number.isInteger(count) ||
    count < 8 ||
    count > 32768 ||
    count & (count - 1) ||
    span < BigInt(count)
  )
    throw Error("FFT 点数必须是 8–32768 的 2 次幂，且不能大于区间 tick 数。");
  const duration = Number(span) * secondsPerTick;
  const sampleRate = count / duration;
  const binWidth = sampleRate / count;
  if (
    !Number.isFinite(sampleRate) ||
    !Number.isFinite(binWidth) ||
    binWidth <= 0
  )
    throw Error("FFT 区间的时间刻度超出范围。");

  const re = new Float64Array(count);
  const im = new Float64Array(count);
  let cursor = 0;
  let peak = 0;
  const denominator = BigInt(count);
  for (let i = 0; i < count; i++) {
    const position = span * BigInt(i);
    const tick = start + position / denominator;
    const fraction = Number(position % denominator) / count;
    while (cursor < samples.length && samples[cursor].tick <= tick) cursor++;
    const previous = samples[cursor - 1];
    const next = samples[cursor];
    let value = previous?.value;
    if (
      interpolation === "linear" &&
      previous &&
      next &&
      (tick > previous.tick || fraction > 0)
    ) {
      const weight =
        (Number(tick - previous.tick) + fraction) /
        Number(next.tick - previous.tick);
      value = previous.value * (1 - weight) + next.value * weight;
    }
    if (value === undefined || !Number.isFinite(value))
      throw Error("FFT 区间存在缺失、X/Z 或不可表示的数值。");
    re[i] = value;
    peak = Math.max(peak, Math.abs(value));
  }

  const scale = peak || 1;
  let mean = 0;
  if (removeMean) for (const value of re) mean += value / scale / count;
  let sum = 0;
  let squares = 0;
  for (let i = 0; i < count; i++) {
    const angle = (2 * Math.PI * i) / count;
    const weights = {
      hann: 0.5 - 0.5 * Math.cos(angle),
      hamming: 0.54 - 0.46 * Math.cos(angle),
      blackman: 0.42 - 0.5 * Math.cos(angle) + 0.08 * Math.cos(2 * angle),
      rectangular: 1,
    };
    const weight = weights[window];
    sum += weight;
    squares += weight * weight;
    re[i] = (re[i] / scale - mean) * weight;
  }

  for (let i = 1, reversed = 0; i < count; i++) {
    let bit = count >> 1;
    for (; reversed & bit; bit >>= 1) reversed ^= bit;
    reversed ^= bit;
    if (i < reversed) [re[i], re[reversed]] = [re[reversed], re[i]];
  }
  for (let size = 2; size <= count; size *= 2) {
    const half = size / 2;
    for (let j = 0; j < half; j++) {
      const angle = (-2 * Math.PI * j) / size;
      const cosine = Math.cos(angle);
      const sine = Math.sin(angle);
      for (let left = j; left < count; left += size) {
        const right = left + half;
        const real = re[right] * cosine - im[right] * sine;
        const imaginary = re[right] * sine + im[right] * cosine;
        re[right] = re[left] - real;
        im[right] = im[left] - imaginary;
        re[left] += real;
        im[left] += imaginary;
      }
    }
  }

  const bins = Array.from({ length: count / 2 + 1 }, (_, bin) => {
    const factor = bin === 0 || bin === count / 2 ? 1 : 2;
    const magnitude = Math.hypot(re[bin], im[bin]);
    const amplitude = (magnitude / sum) * factor * scale;
    const rootDensity =
      (magnitude / Math.sqrt(sampleRate) / Math.sqrt(squares)) *
      Math.sqrt(factor) *
      scale;
    const density = rootDensity * rootDensity;
    const phase =
      magnitude > sum * Number.EPSILON * 8
        ? (Math.atan2(im[bin], re[bin]) * 180) / Math.PI
        : NaN;
    return {
      frequency: bin * binWidth,
      amplitude: Number.isFinite(amplitude) ? amplitude : NaN,
      decibels:
        amplitude > 0 && Number.isFinite(amplitude)
          ? 20 * Math.log10(amplitude)
          : NaN,
      density: Number.isFinite(density) ? density : NaN,
      phase,
    };
  });
  return { bins, sampleRate, binWidth };
}

export function spectrumRaw(
  result: ReturnType<typeof waveSpectrum>,
  title: string,
  unit: string | undefined,
) {
  const columns = [
    ["amplitude", unit ?? ""],
    ["level", "dB"],
    ["power_density", unit ? unit + "²/Hz" : "1/Hz"],
    ["phase", "deg"],
  ];
  return [
    "Title: " + title.replace(/[\r\n]/g, " "),
    "Plotname: FFT",
    "Flags: real",
    "WaveWorkbench Frequency Tick: " + result.binWidth,
    "No. Variables: 5",
    "No. Points: " + result.bins.length,
    "Variables:",
    "\t0\tfrequency\tfrequency",
    ...columns.map(([name, label], i) =>
      [i + 1, name, "notype", label.replace(/[\r\n\t]/g, " ")].join("\t"),
    ),
    "Values:",
    ...result.bins.flatMap(
      ({ frequency, amplitude, decibels, density, phase }, i) => [
        i + "\t" + frequency,
        ...[amplitude, decibels, density, phase].map((value) => "\t" + value),
      ],
    ),
    "",
  ].join("\n");
}

export function filterWave(
  samples: readonly Sample[],
  start: bigint,
  end: bigint,
  secondsPerTick: number,
  cutoff: number,
  period: bigint,
  fileEnd: bigint,
): Samples {
  const pole = 2 * Math.PI * cutoff;
  if (!Number.isFinite(pole) || pole <= 0)
    throw Error("低通截止频率必须是有限的正数。");
  const events: Samples = [];
  if (period <= 0n || (end - start) / period >= BigInt(maxMathSamples - 2))
    throw Error("低通输出周期过小，请增大周期或缩小 A/B 区间。");
  let held = NaN;
  let filtered = NaN;
  let lastTick = start;
  let cursor = 0;
  while (cursor < samples.length && samples[cursor].tick <= start)
    held = samples[cursor++].value;
  filtered = held;
  const emit = (tick: bigint, value: number) => {
    const encoded = Number.isFinite(value) ? String(value) : "NaN";
    if (events.at(-1)?.[1] !== encoded) events.push([String(tick), encoded]);
  };
  function advance(tick: bigint) {
    if (!Number.isFinite(held)) filtered = NaN;
    else if (!Number.isFinite(filtered)) filtered = held;
    else {
      const fraction = -Math.expm1(
        -Number(tick - lastTick) * secondsPerTick * pole,
      );
      filtered = filtered * (1 - fraction) + held * fraction;
    }
    lastTick = tick;
  }
  for (let tick = start; ; tick = tick + period < end ? tick + period : end) {
    while (cursor < samples.length && samples[cursor].tick <= tick) {
      const { tick: transition, value } = samples[cursor++];
      advance(transition);
      held = value;
      if (!Number.isFinite(held)) filtered = NaN;
      else if (!Number.isFinite(filtered)) filtered = held;
    }
    advance(tick);
    emit(tick, filtered);
    if (tick === end) break;
  }
  if (!events.some(([, value]) => value !== "NaN"))
    throw Error("滤波区间没有可用的数值。");
  if (end < fileEnd) emit(end + 1n, NaN);
  return events;
}
