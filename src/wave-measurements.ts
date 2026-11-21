// SPDX-License-Identifier: MPL-2.0

import type { Backend } from "./backend";
import type { Metadata, Operand, Signal } from "./shared/protocol";
import { realValue } from "./shared/analog";
import { label } from "./shared/signals";
import { frequencyLabel, scaleHertz, scaleSeconds } from "./shared/time";
import { mathBounds, readMathInputs } from "./wave-math-runtime";
import { amplitudeStats } from "./wave-measurement-amplitude";
import {
  analogExtrema,
  crossingFraction,
  dataMargins,
  mean,
  pulseTiming,
  thresholdEdges,
  type Samples,
} from "./wave-measurement-timing";

import {
  measurementAcceptsSignal,
  type Measurement,
} from "./shared/measurements";
export { measurements, type Measurement } from "./shared/measurements";
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
      offset + width * crossingFraction(threshold, left, right);
    const within = (tick: number) => tick >= 0 && tick <= Number(end - start);
    if (left >= low && right < low) rise = undefined;
    if (left <= high && right > high) fall = undefined;
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
  if (signals.some((signal) => !measurementAcceptsSignal(operation, signal)))
    throw Error(
      operation === "pulse" || operation === "timing" || operation === "delay"
        ? "请选择实数信号、单比特数字信号或总线位。"
        : "请选择实数信号。",
    );
  const scale = freq ?? scaleSeconds(meta.scale);
  const position = (tick: bigint) =>
    freq ? frequencyLabel(Number(tick) * freq) : duration(Number(tick), scale);
  const withUnit = (value: string, unit?: string) =>
    unit && value !== "—" ? value + " " + unit : value;
  // The input reader uses the scale for math requests. Frequency measurements
  // already have the real axis scale above.
  const inputMeta = freq ? { ...meta, scale: "1s" } : meta;
  const rows: Row[] = [["测量区间", position(start) + " → " + position(end)]];
  if (operation === "cursors") {
    const [a, b] = reverse ? [end, start] : [start, end];
    const readPoint = (tick: bigint) =>
      readMathInputs(backend, inputMeta, signals, tick, tick);
    const [first, second] = await Promise.all([readPoint(a), readPoint(b)]);
    const difference = Number(b - a);
    rows.push([
      "B − A",
      freq ? frequencyLabel(difference * freq) : duration(difference, scale),
    ]);
    for (const [index, row] of signals.entries()) {
      const aa = first.inputs[index].events.at(-1)?.[1];
      const bb = second.inputs[index].events.at(-1)?.[1];
      const format = (value?: string) =>
        row.real
          ? withUnit(number(realValue(value) ?? null), row.unit)
          : (value ?? "—");
      rows.push([label(row), "A " + format(aa) + " · B " + format(bb)]);
      if (!row.real) continue;
      const av = realValue(aa),
        bv = realValue(bb);
      if (av !== undefined && bv !== undefined)
        rows.push([
          "B − A · " + label(row),
          withUnit(number(bv - av), row.unit),
        ]);
    }
    return rows;
  }

  const { inputs } = await readMathInputs(
    backend,
    inputMeta,
    signals,
    start,
    end,
    { complete: true },
  );
  const [channel] = inputs;
  const isLinear = (row: Signal) =>
    row.id.startsWith("psfxl:") ||
    (row.definition?.op === "samples" && row.definition.linear === true);
  const time = (ticks?: number) =>
    ticks === undefined ? "—" : duration(ticks, scale);
  const timing = (index: number) => {
    const events = inputs[index].events;
    if (!signals[index].real) return thresholdEdges(events, start, end);
    const { min, max } = analogExtrema(events, start, end);
    return thresholdEdges(events, start, end, min / 2 + max / 2);
  };

  switch (operation) {
    case "analog":
      for (const [index, row] of signals.entries()) {
        try {
          const events = inputs[index].events;
          const linear = isLinear(row);
          const stats = amplitudeStats(events, start, end, linear, scale);
          if (!stats) {
            rows.push([label(row), "测量区间内没有有效实数采样。"]);
            continue;
          }
          for (const [metric, value] of [
            ["最小值", stats.min],
            ["最大值", stats.max],
            ["峰峰值", stats.peakToPeak],
            ["均值", stats.mean],
            ["RMS", stats.rms],
          ] as const)
            rows.push([
              label(row) + " · " + metric,
              withUnit(number(value), row.unit),
            ]);
          const add = (name: string, value: string) =>
            rows.push([label(row) + " · " + name, value]);
          add("标准差", withUnit(number(stats.std), row.unit));
          add("中位数", withUnit(number(stats.median), row.unit));
          add("最小值时刻", time(Number(start) + stats.minAt));
          add("最大值时刻", time(Number(start) + stats.maxAt));
          for (const [reference, values] of [
            ["DC", stats.dc],
            ["AC", stats.ac],
          ] as const) {
            for (const [index, metric] of [
              "正面积",
              "负面积",
              "净面积",
              "绝对面积",
            ].entries())
              add(
                reference + " " + metric,
                withUnit(
                  number(values[index]),
                  row.unit ? row.unit + "·s" : "单位·s",
                ),
              );
          }
          const cycle = pulseTiming(timing(index).edges).firstCycle;
          const cycleStats =
            cycle && amplitudeStats(events, start, end, linear, scale, cycle);
          if (cycleStats) {
            add("首周期均值", withUnit(number(cycleStats.mean), row.unit));
            add("首周期 RMS", withUnit(number(cycleStats.rms), row.unit));
            add("首周期标准差", withUnit(number(cycleStats.std), row.unit));
            add("首周期中位数", withUnit(number(cycleStats.median), row.unit));
          }
          rows.push([
            label(row) + " · 有效覆盖",
            stats.coveredTicks + " / " + String(end - start) + " tick",
          ]);
        } catch (error) {
          rows.push([
            label(row),
            error instanceof Error ? error.message : String(error),
          ]);
        }
      }
      break;
    case "pulse":
    case "timing": {
      const p = pulseTiming(timing(0).edges);
      if (signal.real && !p.rise.length && !p.fall.length)
        rows.push(["边沿状态", "区间内没有跨越中间电平的有效边沿。"]);
      const period = mean(p.periods);
      if (
        signal.real &&
        period === undefined &&
        (p.rise.length || p.fall.length)
      )
        rows.push(["周期状态", "区间内没有完整周期。"]);
      const highDuty = p.totalPeriod ? p.totalHigh / p.totalPeriod : undefined;
      const burst = (first: number[], last: number[]) =>
        first.length && last.length && last.at(-1)! > first[0]
          ? time(last.at(-1)! - first[0])
          : "—";
      rows.push(
        ["平均周期", time(period)],
        [
          "频率",
          period === undefined ? "—" : frequencyLabel(1 / (period * scale)),
        ],
        ["平均高脉宽", time(mean(p.high))],
        ["平均低脉宽", time(mean(p.low))],
        [
          "高电平占空比",
          highDuty === undefined ? "—" : number(100 * highDuty) + " %",
        ],
        [
          "低电平占空比",
          highDuty === undefined ? "—" : number(100 * (1 - highDuty)) + " %",
        ],
        ["正突发宽度", burst(p.rise, p.fall)],
        ["负突发宽度", burst(p.fall, p.rise)],
        ["相邻周期平均差（绝对值）", time(mean(p.jitter))],
        ["完整周期", String(p.periods.length)],
        ["上升沿", String(p.rise.length)],
        ["下降沿", String(p.fall.length)],
        ["边沿总数", String(p.rise.length + p.fall.length)],
        ["完整高脉冲", String(p.high.length)],
        ["完整低脉冲", String(p.low.length)],
      );
      break;
    }
    case "delay": {
      const source = timing(0),
        target = timing(1);
      const a = pulseTiming(source.edges),
        b = pulseTiming(target.edges);
      rows.push(["源 → 目标", label(signals[0]) + " → " + label(signals[1])]);
      const delta = (first?: number, second?: number) =>
        first === undefined || second === undefined
          ? undefined
          : second - first;
      for (const [from, first] of [
        ["上升", a.rise[0]],
        ["下降", a.fall[0]],
      ] as const) {
        for (const [to, edges] of [
          ["上升", b.rise],
          ["下降", b.fall],
        ] as const) {
          rows.push(
            [
              "首个" + from + "沿 → 后续首个" + to + "沿",
              time(
                delta(
                  first,
                  edges.find((edge) => first !== undefined && edge >= first),
                ),
              ),
            ],
            [
              "首个" + from + "沿 → 末个" + to + "沿",
              time(delta(first, edges.at(-1))),
            ],
          );
        }
      }
      const closest = b.rise.reduce<number | undefined>((best, tick) => {
        const difference = delta(a.rise[0], tick);
        if (difference === undefined) return best;
        return best === undefined || Math.abs(difference) < Math.abs(best)
          ? difference
          : best;
      }, undefined);
      const period = mean(a.periods);
      const phase =
        closest === undefined || period === undefined
          ? undefined
          : (((((360 * closest) / period) % 360) + 540) % 360) - 180;
      rows.push(
        ["最近上升沿偏斜（目标 − 源）", time(closest)],
        [
          "相位（目标滞后为正）",
          phase === undefined ? "—" : number(phase) + " °",
        ],
      );
      for (const [direction, name] of [
        ["rise", "上升沿"],
        ["fall", "下降沿"],
      ] as const) {
        const margins = dataMargins(source, target.edges, direction);
        rows.push(
          ["最小建立时间 · " + name, time(margins.setup)],
          ["最小保持时间 · " + name, time(margins.hold)],
        );
      }
      rows.push([
        "首个上升沿延时（目标 − 源）",
        time(delta(a.rise[0], b.rise[0])),
      ]);
      break;
    }
    case "edges": {
      const { min, max } = analogExtrema(channel.events, start, end);
      if (min > max) throw Error("测量区间内没有有效实数采样。");
      if (max === min) throw Error("区间内电平恒定，无法测量上升或下降时间。");
      for (const ratio of [0.1, 0.2]) {
        const low = (1 - ratio) * min + ratio * max;
        const high = ratio * min + (1 - ratio) * max;
        const { rises, falls } = analogEdges(
          channel.events,
          start,
          end,
          low,
          high,
        );
        const band = ratio === 0.1 ? "10–90%" : "20–80%";
        rows.push([
          label(signal) + " · " + band + " 电平",
          [low, high].map((v) => withUnit(number(v), signal.unit)).join(" / "),
        ]);
        for (const [metric, widths, polarity] of [
          ["上升时间", rises, 1],
          ["下降时间", falls, -1],
        ] as const) {
          const average = mean(widths);
          rows.push([
            ratio === 0.1 ? metric : metric + " · " + band,
            average === undefined
              ? "—"
              : time(average) + " · " + widths.length + " 次",
          ]);
          if (ratio === 0.1) {
            const slope = mean(
              widths
                .filter((width) => width > 0)
                .map((width) => (polarity * ((high - low) / scale)) / width),
            );
            rows.push([
              polarity > 0 ? "平均上升斜率" : "平均下降斜率",
              slope === undefined
                ? "—"
                : withUnit(number(slope), (signal.unit || "单位") + "/s"),
            ]);
          }
        }
      }
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
