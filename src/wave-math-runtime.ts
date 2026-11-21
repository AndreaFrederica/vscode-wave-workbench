// SPDX-License-Identifier: MPL-2.0

import * as path from "node:path";
import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import type { Backend } from "./backend";
import type { Block, Metadata, Signal } from "./shared/protocol";
import { project } from "./shared/signals";
import { measureAnalog, thresholdSamples } from "./shared/analog";
import { scaleSeconds } from "./shared/time";
import { findSignal } from "./signal-lookup";
import {
  calculateWave,
  compileWaveExpression,
  fftWindows,
  filterWave,
  numericSamples,
  spectrumRaw,
  waveSpectrum,
  type FftWindow,
} from "./wave-math";
import {
  convertWave,
  runWaveOperator,
  validateOperatorOutput,
  type ConverterSampling,
  type WaveOperatorChannel,
  type WaveOperatorRequest,
} from "./wave-operator";

export const mathActions = [
  "measure",
  "hysteresis",
  "expression",
  "derivative",
  "integral",
  "filter",
  "adc",
  "dac",
  "fft",
  "external",
] as const;
export type Operation = (typeof mathActions)[number];

export interface WaveMathSource {
  backend: Backend;
  meta: Metadata;
  filename: string;
}

export function checkMathInputs(
  operation: Operation,
  meta: Metadata,
  count: number,
) {
  if (meta.axis === "frequency")
    throw Error("Wave math requires a time-domain waveform.");
  const maximum = ["fft", "filter", "measure", "hysteresis"].includes(operation)
    ? 1
    : operation === "adc" || operation === "dac"
      ? 2
      : 4;
  if (count < 1 || count > maximum)
    throw Error(`Choose 1–${maximum} input signals.`);
}

export function mathBounds(meta: Metadata, first: string, last: string) {
  if (![first, last].every((tick) => /^\d{1,20}$/.test(tick)))
    throw Error("Specify the math range as integer ticks.");
  const start = BigInt(first);
  const end = BigInt(last);
  if (start < BigInt(meta.start) || end > BigInt(meta.end) || start >= end)
    throw Error("Choose a non-empty range within the waveform.");
  return [start, end] as const;
}

export async function readMathInputs(
  backend: Backend,
  meta: Metadata,
  signals: Signal[],
  start: bigint,
  end: bigint,
  { complete = false } = {},
): Promise<WaveOperatorRequest> {
  const seed = start > BigInt(meta.start) ? start - 1n : start;
  const limit = Math.min(
    100_000,
    Math.max(
      8,
      Math.floor(
        (8 * 1024 * 1024) /
          signals.reduce(
            (sum, signal) => sum + (signal.sourceWidth ?? signal.width) + 40,
            0,
          ),
      ),
    ),
  );
  const blocks = await backend.request("query", {
    signals: [...new Set(signals.map(({ id }) => id))],
    start: String(seed),
    end: String(end),
    limit,
  });

  if (complete) {
    for (const id of Object.keys(blocks)) {
      const events = blocks[id].events;
      let block: Block = blocks[id];
      while (block.truncated) {
        const anchor = events.at(-1)?.[0];
        if (anchor === undefined || BigInt(anchor) >= end)
          throw Error("无法继续读取测量区间内的采样。");
        // Reopen at the last actual sample to avoid a synthesized seed at a page seam.
        const next = (
          await backend.request("query", {
            signals: [id],
            start: anchor,
            end: String(end),
            limit,
          })
        )[id];
        const after = BigInt(anchor);
        const first = next?.events.findIndex(([tick]) => BigInt(tick) > after);
        if (!next || (next.truncated && first === -1))
          throw Error("无法继续读取测量区间内的采样。");
        if (first !== undefined && first !== -1) {
          for (let index = first; index < next.events.length; index++)
            events.push(next.events[index]);
        }
        block = next;
      }
      blocks[id].truncated = false;
    }
  }

  return {
    apiVersion: 1,
    start: String(start),
    end: String(end),
    secondsPerTick: scaleSeconds(meta.scale),
    options: {},
    inputs: signals.map((signal) => {
      const block = blocks[signal.id];
      if (!block) throw Error("无法读取所选信号。");
      if (block.truncated) throw Error("输入事件过多，请缩小 A/B 区间。");
      if (signal.real)
        return { kind: "real", unit: signal.unit, events: block.events };
      const events: [string, string][] = block.events.map(([tick, raw]) => {
        const value = project(raw.toLowerCase(), signal)!;
        return [
          tick,
          /^[01xz]+$/.test(value) && value.length <= signal.width
            ? value.padStart(signal.width, /^[xz]/.test(value) ? value[0] : "0")
            : "x".repeat(signal.width),
        ];
      });
      return { kind: "digital", width: signal.width, events };
    }),
  };
}

export async function publishMath(
  backend: Backend,
  meta: Metadata,
  signals: Signal[],
  request: WaveOperatorRequest,
  output: WaveOperatorChannel,
  name: string,
  source: string,
  linear = false,
) {
  const events = output.events.slice();
  const end = BigInt(request.end);
  const real = output.kind === "real";
  const width = real ? 64 : output.width;
  const unknown = real ? "NaN" : "x".repeat(width);
  if (end < BigInt(meta.end) && events.at(-1)?.[1] !== unknown)
    events.push([String(end + 1n), unknown]);
  const result = await backend.request("defineVirtual", {
    name,
    definition: {
      op: "samples",
      inputs: [],
      width,
      real: real ? true : undefined,
      linear: real && linear ? true : undefined,
      source:
        "math:" +
        createHash("sha256")
          .update(
            JSON.stringify({
              source,
              start: request.start,
              end: request.end,
              name,
              inputs: signals.map(({ id, bitOffset }) => [id, bitOffset]),
            }),
          )
          .digest("hex"),
      samples: events,
    },
  });
  return {
    ...result,
    signal: real ? { ...result.signal, unit: output.unit } : result.signal,
  };
}

export interface MathOptions {
  expression?: string;
  signed?: boolean;
  name?: string;
  unit?: string;
  cutoff?: number;
  period?: string;
  low?: number;
  high?: number;
  bits?: number;
  sampling?: {
    mode?: string;
    period?: string;
    offset?: string;
    delay?: string;
    edge?: string;
    threshold?: number;
  };
  points?: number;
  window?: FftWindow;
  interpolation?: "hold" | "linear";
  removeMean?: boolean;
  path?: string;
  engine?: "native" | "javascript";
  entry?: string;
  parameters?: Record<string, unknown>;
}

function mathTick(value: string | undefined, fallback: string) {
  const tick = value ?? fallback;
  if (typeof tick !== "string" || !/^\d{1,20}$/.test(tick))
    throw Error(
      "Sampling period, offset, and delay must be decimal tick strings.",
    );
  return BigInt(tick);
}

function sampleConfiguration(
  options: MathOptions["sampling"],
): ConverterSampling {
  const mode = options?.mode ?? "changes";
  const delay = mathTick(options?.delay, "0");
  switch (mode) {
    case "changes":
      return { mode, delay };
    case "periodic":
      return {
        mode,
        delay,
        period: mathTick(options?.period, "1"),
        offset: mathTick(options?.offset, "0"),
      };
    case "external": {
      const edge = options?.edge ?? "rising";
      const threshold = options?.threshold ?? 0.5;
      if (
        !(edge === "rising" || edge === "falling" || edge === "either") ||
        !Number.isFinite(threshold)
      )
        throw Error(
          "External sampling requires a valid trigger edge and threshold.",
        );
      return { mode, delay, edge, threshold };
    }
    default:
      throw Error("Sampling mode must be changes, periodic, or external.");
  }
}

export async function runWaveMath(
  source: WaveMathSource,
  operation: Operation,
  selectors: string[],
  startText: string,
  endText: string,
  options: MathOptions,
  workspace: string,
  trusted: boolean,
  signal: AbortSignal,
) {
  const { backend, meta } = source;
  checkMathInputs(operation, meta, selectors.length);
  const [start, end] = mathBounds(meta, startText, endText);
  const inputs = await Promise.all(
    selectors.map((entry) => findSignal(backend, entry)),
  );
  if (inputs.some((entry) => !entry.supported))
    throw Error("A math input is unavailable.");
  signal.throwIfAborted();
  const request = await readMathInputs(backend, meta, inputs, start, end);
  signal.throwIfAborted();
  const first = inputs[0];
  if ((operation === "measure" || operation === "hysteresis") && !first.real)
    throw Error("Choose a real waveform.");
  if (operation === "measure")
    return {
      measurement: measureAnalog(
        request.inputs[0].events,
        start,
        end,
        first.definition?.op === "samples" && first.definition.linear,
      ),
      unit: first.unit,
    };
  const samples = () =>
    inputs.map((input, index) =>
      numericSamples(
        request.inputs[index].events,
        input,
        options.signed === true,
      ),
    );
  if (operation === "fft") {
    const points =
      options.points ??
      2 ** Math.floor(Math.log2(Math.min(4096, Number(end - start))));
    const window = options.window ?? "hann";
    const interpolation =
      options.interpolation ?? (first.real ? "linear" : "hold");
    if (
      !fftWindows.includes(window) ||
      !["linear", "hold"].includes(interpolation)
    )
      throw Error("Invalid FFT window or interpolation.");
    const spectrum = waveSpectrum(
      samples()[0],
      start,
      end,
      request.secondsPerTick,
      points,
      window,
      interpolation,
      options.removeMean === true,
    );
    signal.throwIfAborted();
    if (!options.path) return { spectrum };
    const filename = path.resolve(workspace, options.path);
    if (!/\.raw$/i.test(filename)) throw Error("Choose a .raw destination.");
    await fs.writeFile(
      filename,
      spectrumRaw(spectrum, selectors[0], first.unit),
      { flag: "wx" },
    );
    return { path: filename, spectrum };
  }

  const name = options.name ?? `${operation}(${first.name})`;
  if (
    typeof name !== "string" ||
    !name.trim() ||
    name.length > 256 ||
    (options.unit !== undefined &&
      (typeof options.unit !== "string" || options.unit.length > 24))
  )
    throw Error(
      "Choose a valid output name and a unit of up to 24 characters.",
    );
  let output: WaveOperatorChannel;
  const expression = options.expression ?? (inputs.length > 1 ? "A + B" : "A");
  if (operation === "hysteresis") {
    const events = thresholdSamples(
      request.inputs[0].events,
      options.low ?? 0.3,
      options.high ?? 0.7,
    );
    if (events.length > 4096)
      throw Error(
        "Too many hysteresis transitions. Choose a shorter interval.",
      );
    const before =
      events.filter(([tick]) => BigInt(tick) <= start).at(-1)?.[1] ?? "x";
    output = {
      kind: "digital",
      width: 1,
      events: [
        [String(start), before],
        ...events.filter(([tick]) => BigInt(tick) > start),
      ],
    };
  } else if (operation === "external") {
    if (!trusted)
      throw Error("External math operators require a trusted workspace.");
    const { engine, entry, parameters } = options;
    if (
      (engine !== "native" && engine !== "javascript") ||
      typeof entry !== "string" ||
      !entry
    )
      throw Error("Specify the engine and entry of a local operator.");
    if (
      parameters !== undefined &&
      (!parameters ||
        typeof parameters !== "object" ||
        Array.isArray(parameters) ||
        Buffer.byteLength(JSON.stringify(parameters)) > 65_536)
    )
      throw Error("Operator parameters must be a JSON object within 64 KiB.");
    request.options = parameters ?? {};
    output = validateOperatorOutput(
      await runWaveOperator(
        engine,
        path.resolve(workspace, entry),
        request,
        signal,
      ),
      request,
    );
  } else if (operation === "adc" || operation === "dac") {
    const bits = options.bits ?? (operation === "adc" ? 8 : first.width);
    output = validateOperatorOutput(
      convertWave(
        operation,
        request,
        bits,
        options.low ?? 0,
        options.high ?? 1,
        sampleConfiguration(options.sampling),
      ),
      request,
    );
  } else {
    const numeric = samples();
    const fileEnd = BigInt(meta.end);
    const events =
      operation === "filter"
        ? filterWave(
            numeric[0],
            start,
            end,
            request.secondsPerTick,
            options.cutoff ?? 1e6,
            mathTick(options.period, String((end - start + 1023n) / 1024n)),
            fileEnd,
          )
        : calculateWave(
            compileWaveExpression(expression, inputs.length),
            numeric,
            start,
            end,
            request.secondsPerTick,
            operation === "expression" ? "pointwise" : operation,
            fileEnd,
          );
    output = { kind: "real", events };
  }
  if (output.kind === "real")
    output.unit =
      options.unit ??
      output.unit ??
      (operation === "filter" ? first.unit : undefined);
  signal.throwIfAborted();
  return publishMath(
    backend,
    meta,
    inputs,
    request,
    output,
    name.trim(),
    JSON.stringify({ operation, options }),
    operation === "integral",
  );
}
