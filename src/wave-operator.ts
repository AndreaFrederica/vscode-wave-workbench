// SPDX-License-Identifier: MPL-2.0

import * as path from "node:path";
import { spawn } from "node:child_process";
import { Worker } from "node:worker_threads";
import { realValue } from "./shared/analog";

export type WaveOperatorChannel =
  | { kind: "real"; unit?: string; events: [string, string][] }
  | { kind: "digital"; width: number; events: [string, string][] };

export interface WaveOperatorRequest {
  apiVersion: 1;
  start: string;
  end: string;
  secondsPerTick: number;
  inputs: WaveOperatorChannel[];
  options: Record<string, unknown>;
}

export type WaveOperator = (
  request: WaveOperatorRequest,
) => WaveOperatorChannel | Promise<WaveOperatorChannel>;

export type ConverterSampling =
  | { mode: "changes"; delay: bigint }
  | { mode: "periodic"; period: bigint; offset: bigint; delay: bigint }
  | {
      mode: "external";
      edge: "rising" | "falling" | "either";
      threshold: number;
      delay: bigint;
    };

export function convertWave(
  direction: "adc" | "dac",
  request: WaveOperatorRequest,
  bits: number,
  low: number,
  high: number,
  sampling: ConverterSampling,
): WaveOperatorChannel {
  const [input, clock] = request.inputs;
  const span = high - low;
  if (
    !Number.isInteger(bits) ||
    bits < 1 ||
    bits > 32 ||
    !Number.isFinite(span) ||
    span <= 0
  )
    throw Error("转换范围需要有限的低值和高值，分辨率为 1–32 bit。");
  const start = BigInt(request.start);
  const end = BigInt(request.end);
  const top = 2 ** bits - 1;
  const adc = direction === "adc";
  if (
    adc
      ? input?.kind !== "real"
      : input?.kind !== "digital" || input.width !== bits
  )
    throw Error(
      adc ? "ADC 需要实数输入。" : "DAC 需要与分辨率相同的数字输入。",
    );
  if (
    sampling.mode === "external"
      ? !clock || (clock.kind === "digital" && clock.width !== 1)
      : !!clock
  )
    throw Error("外部触发需要第二条 1 bit 或实数输入。");
  if (
    sampling.delay < 0n ||
    (sampling.mode === "periodic" &&
      (sampling.period <= 0n || sampling.offset < 0n)) ||
    (sampling.mode === "external" && !Number.isFinite(sampling.threshold))
  )
    throw Error("采样周期、相位偏移、延迟或触发阈值无效。");

  const unknown = adc ? "x".repeat(bits) : "NaN";
  const events: [string, string][] = [[request.start, unknown]];
  function convert(raw: string | undefined) {
    if (!adc)
      return raw && /^[01]+$/.test(raw)
        ? String(low + (Number.parseInt(raw, 2) / top) * span)
        : unknown;
    const value = realValue(raw);
    if (value === undefined) return unknown;
    const code = Math.round(
      Math.min(1, Math.max(0, (value - low) / span)) * top,
    );
    return code.toString(2).padStart(bits, "0");
  }

  let cursor = 0;
  function sample(tick: bigint) {
    const outputTick = tick + sampling.delay;
    if (outputTick > end) return;
    while (
      cursor < input.events.length &&
      BigInt(input.events[cursor][0]) <= tick
    )
      cursor++;
    const value = convert(input.events[cursor - 1]?.[1]);
    const last = events.at(-1)!;
    if (last[0] === String(outputTick)) last[1] = value;
    else if (last[1] !== value) events.push([String(outputTick), value]);
    if (events.length > (adc ? 4096 : 16383))
      throw Error("转换结果过多，请缩小 A/B 区间。");
  }

  if (sampling.mode === "periodic") {
    const first = start + sampling.offset;
    const last = end - sampling.delay;
    if (last >= first && (last - first) / sampling.period >= 100_000n)
      throw Error("采样次数超过 100000 次。请增大周期或缩小 A/B 区间。");
    for (let tick = first; tick <= last; tick += sampling.period) sample(tick);
  } else if (sampling.mode === "external") {
    let previous: boolean | undefined;
    for (const [tick, raw] of clock!.events) {
      const value =
        clock!.kind === "real"
          ? realValue(raw)
          : /^[01]$/.test(raw)
            ? Number(raw)
            : undefined;
      const level =
        value === undefined
          ? undefined
          : value >= (clock!.kind === "real" ? sampling.threshold : 1);
      const coordinate = BigInt(tick);
      if (
        coordinate >= start &&
        previous !== undefined &&
        level !== undefined &&
        previous !== level &&
        (sampling.edge === "either" ||
          (level ? "rising" : "falling") === sampling.edge)
      )
        sample(coordinate);
      previous = level;
    }
  } else {
    sample(start);
    for (const [tick] of input.events) {
      const coordinate = BigInt(tick);
      if (coordinate > start && coordinate <= end) sample(coordinate);
    }
  }

  return adc
    ? { kind: "digital", width: bits, events }
    : { kind: "real", events };
}

export function validateOperatorOutput(
  output: unknown,
  request: WaveOperatorRequest,
): WaveOperatorChannel {
  const channel = output as WaveOperatorChannel;
  if (
    !channel ||
    (channel.kind !== "real" && channel.kind !== "digital") ||
    (channel.kind === "digital" &&
      (!Number.isInteger(channel.width) ||
        channel.width < 1 ||
        channel.width > 256)) ||
    (channel.kind === "real" &&
      channel.unit !== undefined &&
      (typeof channel.unit !== "string" || channel.unit.length > 24)) ||
    !Array.isArray(channel.events) ||
    channel.events.length === 0 ||
    channel.events.length > (channel.kind === "real" ? 16383 : 4096)
  )
    throw Error("无效的算子输出类型、位宽、单位或采样数。");
  const start = BigInt(request.start);
  const end = BigInt(request.end);
  let previous = start - 1n;
  for (const sample of channel.events) {
    if (!Array.isArray(sample) || sample.length !== 2)
      throw Error("无效的算子采样。");
    const [tick, value] = sample;
    if (
      typeof tick !== "string" ||
      !/^(?:0|[1-9]\d{0,19})$/.test(tick) ||
      typeof value !== "string" ||
      (channel.kind === "real"
        ? value !== "NaN" && realValue(value) === undefined
        : value.length !== channel.width || !/^[01xz]+$/.test(value))
    )
      throw Error("无效的算子采样。");
    const coordinate = BigInt(tick);
    if (coordinate <= previous || coordinate > end)
      throw Error("算子采样必须位于区间内且严格递增。");
    previous = coordinate;
    if (channel.kind === "real" && value !== "NaN")
      sample[1] = String(realValue(value));
  }
  return channel;
}

export function runWaveOperator(
  engine: "javascript" | "native",
  entry: string,
  request: WaveOperatorRequest,
  signal?: AbortSignal,
): Promise<unknown> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(Error("外部算子运行超时。")), 15_000);
    let dispose = () => {};
    let settled = false;
    const abort = () => finish(Error("Wave operator was cancelled."));
    signal?.addEventListener("abort", abort, { once: true });
    function finish(error?: Error, result?: unknown) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      dispose();
      if (error) reject(error);
      else resolve(result);
    }
    if (engine === "javascript") {
      const worker = new Worker(path.join(__dirname, "wave-operator-worker.js"), {
        workerData: { entry, request },
        resourceLimits: { maxOldGenerationSizeMb: 128 },
      });
      dispose = () => {
        void worker.terminate();
      };
      worker.once("message", (reply) =>
        reply.error
          ? finish(Error(reply.error))
          : finish(undefined, reply.result),
      );
      worker.once("error", finish);
      worker.once("exit", () =>
        finish(Error("JavaScript 算子退出且没有返回结果。")),
      );
      return;
    }

    const body = JSON.stringify(request);
    if (Buffer.byteLength(body) > 16 * 1024 * 1024) {
      finish(Error("外部算子输入超过 16 MiB。"));
      return;
    }
    const child = spawn(entry, [], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    dispose = () => {
      child.kill("SIGKILL");
    };
    const chunks: Buffer[] = [];
    let size = 0;
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 4 * 1024 * 1024) finish(Error("外部算子输出超过 4 MiB。"));
      else chunks.push(chunk);
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(0, 4096);
    });
    child.once("error", finish);
    child.stdin.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") finish(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      if (code !== 0)
        return finish(Error(stderr.trim() || "Native 算子退出码 " + code));
      try {
        finish(undefined, JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        finish(Error("Native 算子必须在 stdout 返回一个 JSON 结果。"));
      }
    });
    child.stdin.end(body);
  });
}
