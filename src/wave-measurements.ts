// SPDX-License-Identifier: MPL-2.0

import type { Backend } from "./backend";
import type { Metadata, Operand, Signal } from "./shared/protocol";
import { interpolateReal, measureAnalog, realValue } from "./shared/analog";
import { label } from "./shared/signals";
import { frequencyLabel, scaleHertz, scaleSeconds } from "./shared/time";
import { mathBounds, readMathInputs } from "./wave-math-runtime";

export const measurements = [
  "cursors",
  "analog",
  "pulse",
  "delay",
  "edges",
  "peaks",
] as const;
export type Measurement = (typeof measurements)[number];
type Samples = [string, string][];
type Row = [string, string];

const number = (value: number | null) =>
  value === null || !Number.isFinite(value)
    ? "—"
    : String(Number(value.toPrecision(8)));

function duration(ticks: number, scale: number) {
  const seconds = ticks * scale;
  const magnitude = Math.abs(seconds);
  const [factor, unit] =
    magnitude >= 1 || magnitude === 0
      ? [1, "s"]
      : magnitude >= 1e-3
        ? [1e-3, "ms"]
        : magnitude >= 1e-6
          ? [1e-6, "µs"]
          : magnitude >= 1e-9
            ? [1e-9, "ns"]
            : magnitude >= 1e-12
              ? [1e-12, "ps"]
              : [1e-15, "fs"];
  return number(seconds / Number(factor)) + " " + unit;
}

function digitalPulses(events: Samples, start: bigint, end: bigint) {
  let previous: string | undefined;
  let rise: bigint | undefined;
  let fall: bigint | undefined;
  let highInCycle: bigint | undefined;
  let high = 0n,
    low = 0n,
    period = 0n,
    dutyHigh = 0n;
  let highs = 0,
    lows = 0,
    cycles = 0,
    rising = 0,
    falling = 0;
  let firstRise: bigint | undefined;
  for (const [time, value] of events) {
    const tick = BigInt(time);
    if (tick > end) break;
    if (value !== "0" && value !== "1") {
      rise = fall = highInCycle = undefined;
    } else if (tick >= start && previous === "0" && value === "1") {
      firstRise ??= tick;
      rising++;
      if (fall !== undefined && tick > fall) {
        low += tick - fall;
        lows++;
      }
      if (rise !== undefined && highInCycle !== undefined && tick > rise) {
        period += tick - rise;
        dutyHigh += highInCycle;
        cycles++;
      }
      rise = tick;
      highInCycle = undefined;
    } else if (tick >= start && previous === "1" && value === "0") {
      falling++;
      if (rise !== undefined && tick > rise) {
        highInCycle = tick - rise;
        high += highInCycle;
        highs++;
      }
      fall = tick;
    }
    previous = value;
  }
  return {
    firstRise,
    rising,
    falling,
    high,
    low,
    period,
    dutyHigh,
    highs,
    lows,
    cycles,
  };
}

function analogEdges(
  events: Samples,
  start: bigint,
  end: bigint,
  low: number,
  high: number,
) {
  const rises: number[] = [],
    falls: number[] = [];
  let rise: number | undefined, fall: number | undefined;
  for (let index = 1; index < events.length; index++) {
    const [leftTick, leftRaw] = events[index - 1];
    const [rightTick, rightRaw] = events[index];
    const left = realValue(leftRaw),
      right = realValue(rightRaw);
    if (left === undefined || right === undefined) {
      rise = fall = undefined;
      continue;
    }
    const offset = Number(BigInt(leftTick) - start);
    const width = Number(BigInt(rightTick) - BigInt(leftTick));
    const at = (threshold: number) =>
      offset + width * ((threshold - left) / (right - left));
    const within = (tick: number) => tick >= 0 && tick <= Number(end - start);
    if (left < low && right >= low) {
      fall = undefined;
      const tick = at(low);
      rise = within(tick) ? tick : undefined;
    }
    if (left < high && right >= high && rise !== undefined) {
      const tick = at(high);
      if (within(tick)) rises.push(tick - rise);
      rise = undefined;
    }
    if (left > high && right <= high) {
      rise = undefined;
      const tick = at(high);
      fall = within(tick) ? tick : undefined;
    }
    if (left > low && right <= low && fall !== undefined) {
      const tick = at(low);
      if (within(tick)) falls.push(tick - fall);
      fall = undefined;
    }
  }
  return { rises, falls };
}

export async function measureWave(
  backend: Backend,
  meta: Metadata,
  operation: Measurement,
  operands: (Operand & { unit?: string })[],
  first: string,
  last: string,
  reverse = false,
): Promise<Row[]> {
  const multiple = operation === "cursors" || operation === "analog";
  if (
    !Array.isArray(operands) ||
    operands.length < 1 ||
    (operation === "delay"
      ? operands.length !== 2
      : operands.length > (multiple ? 8 : 1))
  )
    throw Error("请选择此测量所需的信号。");
  const signals = await Promise.all(
    operands.map(async (operand) => {
      const [signal] = await backend.request("describe", {
        descriptors: [
          { id: operand.id, scope: operand.scope, name: operand.name },
        ],
      });
      if (!signal?.supported) throw Error("无法读取所选信号。");
      const unit =
        typeof operand.unit === "string" && operand.unit.length <= 24
          ? operand.unit
          : signal.unit;
      if (operand.bitOffset === undefined) return { ...signal, unit };
      const bitOffset = operand.bitOffset;
      if (
        signal.real ||
        bitOffset === null ||
        !Number.isInteger(bitOffset) ||
        bitOffset < 0 ||
        bitOffset >= signal.width
      )
        throw Error("无效的总线位。");
      return {
        ...signal,
        unit,
        width: 1,
        sourceWidth: signal.width,
        bitOffset,
      };
    }),
  );
  const [start, end] = mathBounds(meta, first, last);
  const [signal] = signals;
  const freq = meta.axis === "frequency" ? scaleHertz(meta.scale) : undefined;
  if (freq) {
    if (operation !== "peaks" && operation !== "cursors")
      throw Error("频谱支持 A/B 游标读数和频谱峰值测量。");
  } else if (operation === "peaks")
    throw Error("请先打开 FFT 频谱并选择幅值行。");
  if (
    ["pulse", "delay"].includes(operation) &&
    signals.some((s) => s.real || s.width !== 1)
  )
    throw Error("请选择单比特数字信号或总线位。");
  if (
    ["analog", "edges", "peaks"].includes(operation) &&
    signals.some((s) => !s.real)
  )
    throw Error("请选择实数信号。");
  const scale = freq ?? scaleSeconds(meta.scale);
  const position = (tick: bigint) =>
    freq ? frequencyLabel(Number(tick) * freq) : duration(Number(tick), scale);
  const withUnit = (value: string, unit?: string) =>
    unit && value !== "—" ? value + " " + unit : value;
  // Frequency files use Hz ticks. The input reader only needs the numeric period for time-domain math.
  const { inputs } = await readMathInputs(
    backend,
    freq ? { ...meta, scale: "1s" } : meta,
    signals,
    start,
    end,
  );
  const [channel] = inputs;
  const isLinear = (row: Signal) =>
    row.definition?.op === "samples" && row.definition.linear === true;
  const rows: Row[] = [["测量区间", position(start) + " → " + position(end)]];

  switch (operation) {
    case "cursors": {
      const [a, b] = reverse ? [end, start] : [start, end];
      const difference = Number(b - a);
      rows.push([
        "B − A",
        freq ? frequencyLabel(difference * freq) : duration(difference, scale),
      ]);
      for (const [index, row] of signals.entries()) {
        const events = inputs[index].events;
        const at = (tick: bigint) => {
          const index = events.findLastIndex(([time]) => BigInt(time) <= tick);
          const left = events[index],
            right = events[index + 1];
          if (left && right && isLinear(row) && BigInt(left[0]) < tick) {
            const value = interpolateReal(
              left[1],
              right[1],
              Number(tick - BigInt(left[0])) /
                Number(BigInt(right[0]) - BigInt(left[0])),
            );
            if (value !== undefined) return String(value);
          }
          return left?.[1];
        };
        const aa = at(a),
          bb = at(b);
        const format = (value?: string) =>
          row.real
            ? withUnit(number(realValue(value) ?? null), row.unit)
            : (value ?? "—");
        rows.push([label(row), "A " + format(aa) + " · B " + format(bb)]);
        if (
          row.real &&
          realValue(aa) !== undefined &&
          realValue(bb) !== undefined
        )
          rows.push([
            "B − A · " + label(row),
            withUnit(number(realValue(bb)! - realValue(aa)!), row.unit),
          ]);
      }
      break;
    }
    case "analog":
      for (const [index, row] of signals.entries()) {
        try {
          const m = measureAnalog(
            inputs[index].events,
            start,
            end,
            isLinear(row),
          );
          for (const [metric, value] of [
            ["最小值", m.min],
            ["最大值", m.max],
            ["峰峰值", m.peakToPeak],
            ["均值", m.mean],
            ["RMS", m.rms],
          ] as const)
            rows.push([
              label(row) + " · " + metric,
              withUnit(number(value), row.unit),
            ]);
          rows.push([
            label(row) + " · 有效覆盖",
            m.coveredTicks + " / " + m.durationTicks + " tick",
          ]);
        } catch (error) {
          rows.push([
            label(row),
            error instanceof Error ? error.message : String(error),
          ]);
        }
      }
      break;
    case "pulse": {
      const p = digitalPulses(channel.events, start, end);
      rows.push([
        label(signal),
        p.rising + " 个上升沿 · " + p.falling + " 个下降沿",
      ]);
      rows.push([
        "平均高脉宽",
        p.highs ? duration(Number(p.high) / p.highs, scale) : "—",
      ]);
      rows.push([
        "平均低脉宽",
        p.lows ? duration(Number(p.low) / p.lows, scale) : "—",
      ]);
      rows.push([
        "平均周期",
        p.cycles ? duration(Number(p.period) / p.cycles, scale) : "—",
      ]);
      rows.push([
        "频率",
        p.cycles ? frequencyLabel(p.cycles / (Number(p.period) * scale)) : "—",
      ]);
      rows.push([
        "高电平占空比",
        p.cycles
          ? number((100 * Number(p.dutyHigh)) / Number(p.period)) + " %"
          : "—",
      ]);
      rows.push(["完整周期", String(p.cycles)]);
      break;
    }
    case "delay": {
      const times = inputs.map(
        (input) => digitalPulses(input.events, start, end).firstRise,
      );
      times.forEach((tick, index) =>
        rows.push([
          label(signals[index]),
          tick === undefined ? "—" : position(tick),
        ]),
      );
      rows.push([
        "首个上升沿延时（下方 − 上方）",
        times[0] !== undefined && times[1] !== undefined
          ? duration(Number(times[1] - times[0]), scale)
          : "—",
      ]);
      break;
    }
    case "edges": {
      let min = Infinity,
        max = -Infinity;
      for (const [index, [time, raw]] of channel.events.entries()) {
        const tick = BigInt(time);
        const next = channel.events[index + 1];
        if (next && BigInt(next[0]) < start) continue;
        const value =
          tick < start && next && BigInt(next[0]) > start
            ? interpolateReal(
                raw,
                next[1],
                Number(start - tick) / Number(BigInt(next[0]) - tick),
              )
            : tick >= start
              ? realValue(raw)
              : undefined;
        if (value === undefined) continue;
        min = Math.min(min, value);
        max = Math.max(max, value);
      }
      if (max <= min) throw Error("区间内电平恒定，无法测量上升或下降时间。");
      const low = 0.9 * min + 0.1 * max,
        high = 0.1 * min + 0.9 * max;
      const { rises, falls } = analogEdges(
        channel.events,
        start,
        end,
        low,
        high,
      );
      rows.push([
        label(signal) + " · 10% / 90% 电平",
        [low, high].map((v) => withUnit(number(v), signal.unit)).join(" / "),
      ]);
      for (const [metric, widths] of [
        ["上升时间", rises],
        ["下降时间", falls],
      ] as const)
        rows.push([
          metric,
          widths.length
            ? duration(
                widths.reduce((a, b) => a + b, 0) / widths.length,
                scale,
              ) +
              " · " +
              widths.length +
              " 次"
            : "—",
        ]);
      break;
    }
    case "peaks": {
      const peaks = [];
      for (let index = 1; index + 1 < channel.events.length; index++) {
        const [time, raw] = channel.events[index],
          tick = BigInt(time);
        const value = realValue(raw),
          left = realValue(channel.events[index - 1][1]),
          right = realValue(channel.events[index + 1][1]);
        if (
          tick > 0n &&
          tick >= start &&
          tick < end &&
          value !== undefined &&
          left !== undefined &&
          right !== undefined &&
          value > left &&
          value >= right
        )
          peaks.push({ tick, value });
      }
      peaks.sort((a, b) => b.value - a.value);
      for (const peak of peaks.slice(0, 5))
        rows.push([
          position(peak.tick),
          withUnit(number(peak.value), signal.unit),
        ]);
      if (!peaks.length) rows.push([label(signal), "区间内没有局部峰值"]);
      break;
    }
  }
  return rows;
}
