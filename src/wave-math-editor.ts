// SPDX-License-Identifier: MPL-2.0

import * as path from "node:path";
import type * as vscode from "vscode";
import type { Viewer } from "./viewer";
import type { Signal } from "./shared/protocol";
import { label } from "./shared/signals";
import { scaleSeconds } from "./shared/time";
import {
  calculateWave,
  compileWaveExpression,
  fftWindows,
  numericSamples,
  spectrumRaw,
  waveSpectrum,
  filterWave,
} from "./wave-math";
import {
  convertWave,
  runWaveOperator,
  validateOperatorOutput,
  type ConverterSampling,
  type WaveOperatorChannel,
  type WaveOperatorRequest,
} from "./wave-operator";

import {
  checkMathInputs,
  mathBounds,
  publishMath,
  readMathInputs,
} from "./wave-math-runtime";
export const mathActions = [
  "expression",
  "derivative",
  "integral",
  "filter",
  "adc",
  "dac",
  "fft",
  "external",
] as const;
type MathEditorOperation = (typeof mathActions)[number];

export async function showWaveMath(
  code: typeof vscode,
  viewer: Viewer,
  operation: MathEditorOperation,
  rows: Signal[],
  range: readonly [string, string] | undefined,
  track: <T>(work: () => Promise<T>) => Promise<T>,
  open: (uri: vscode.Uri) => Promise<Viewer | undefined>,
) {
  const { backend, meta } = viewer;
  const current = () => !viewer.disposed && viewer.backend === backend;
  if (!Array.isArray(rows)) throw Error("无效的数学输入。");
  checkMathInputs(operation, meta, rows.length);
  if (
    rows.some(
      (row) =>
        !row ||
        typeof row.id !== "string" ||
        typeof row.scope !== "string" ||
        typeof row.name !== "string",
    )
  )
    throw Error("无效的数学输入。");
  const signals = await Promise.all(
    rows.map(async (row) => {
      const [signal] = await backend.request("describe", {
        descriptors: [{ id: row.id, scope: row.scope, name: row.name }],
      });
      if (!signal?.supported) throw Error("算子输入不可用。");
      if (row.bitOffset !== undefined) {
        if (
          signal.real ||
          !Number.isInteger(row.bitOffset) ||
          row.bitOffset < 0 ||
          row.bitOffset >= signal.width
        )
          throw Error("无效的输入位选。");
        return {
          ...signal,
          sourceWidth: signal.width,
          width: 1,
          bitOffset: row.bitOffset,
        };
      }
      return {
        ...signal,
        unit:
          typeof row.unit === "string" ? row.unit.slice(0, 24) : signal.unit,
      };
    }),
  );
  const [first, second] = signals;
  const inputs = signals
    .map(
      (signal, i) =>
        String.fromCharCode(65 + i) +
        " = " +
        signal.scope +
        "." +
        label(signal),
    )
    .join(" · ");
  const read = (title: string, prompt: string, value = "") =>
    code.window.showInputBox({ title, prompt, value, ignoreFocusOut: true });
  const pick = async <T>(
    title: string,
    values: { label: string; value: T }[],
  ) =>
    (
      await code.window.showQuickPick(values, {
        title,
        placeHolder: inputs,
        ignoreFocusOut: true,
      })
    )?.value;
  const title = {
    expression: "数学算式",
    derivative: "差分微分",
    integral: "积分",
    filter: "一阶低通",
    adc: "ADC",
    dac: "DAC",
    fft: "FFT 频谱",
    external: "外部算子",
  }[operation];
  const bounds = range
    ? await pick("选择计算区间", [
        { label: "A/B 游标", value: range },
        { label: "全波形", value: [meta.start, meta.end] as const },
      ])
    : ([meta.start, meta.end] as const);
  if (!bounds || !current()) return;
  const [start, end] = mathBounds(meta, ...bounds);
  const secondsPerTick = scaleSeconds(meta.scale);
  const fileEnd = BigInt(meta.end);

  async function readInputs() {
    if (!current()) throw Error("波形已切换。");
    const request = await readMathInputs(backend, meta, signals, start, end);
    if (!current()) throw Error("波形已切换。");
    return request;
  }

  const numberMode = async () =>
    signals.every((signal) => signal.real || signal.width === 1)
      ? false
      : pick("数字总线数值解释", [
          { label: "无符号", value: false },
          { label: "二补码有符号", value: true },
        ]);

  async function publish(
    request: WaveOperatorRequest,
    output: WaveOperatorChannel,
    name: string,
    source: string,
  ) {
    if (!current()) return;
    const result = await publishMath(
      backend,
      meta,
      signals,
      request,
      output,
      name,
      source,
      operation === "integral",
    );
    if (current())
      await viewer.panel.webview.postMessage({
        type: "virtualCreated",
        ...result,
      });
  }

  if (operation === "fft") {
    const suggested =
      2 ** Math.floor(Math.log2(Math.min(4096, Number(end - start))));
    const points = await read(
      title,
      "点数为 8–32768 的 2 次幂。建议按信号带宽和求解步长选择。",
      String(suggested),
    );
    if (points === undefined) return;
    if (!/^\d+$/.test(points)) throw Error("请输入 FFT 点数。");
    const window = await pick(
      "FFT 窗函数",
      fftWindows.map((value) => ({ label: value, value })),
    );
    if (!window) return;
    const interpolation = first.real
      ? await pick("FFT 均匀重采样", [
          { label: "线性插值", value: "linear" as const },
          { label: "零阶保持", value: "hold" as const },
        ])
      : "hold";
    if (!interpolation) return;
    const removeMean = await pick("FFT 直流分量", [
      { label: "保留 DC", value: false },
      { label: "去均值", value: true },
    ]);
    if (removeMean === undefined) return;
    const signed = await numberMode();
    if (signed === undefined) return;
    const base = path.basename(viewer.uri.fsPath).replace(/\.[^.]+$/, "");
    const target = await code.window.showSaveDialog({
      title: "保存并打开 FFT 频谱",
      defaultUri: code.Uri.file(
        path.join(path.dirname(viewer.uri.fsPath), base + "-fft.raw"),
      ),
      filters: { "FFT / RAW": ["raw"] },
    });
    if (!target) return;
    if (!/\.raw$/i.test(target.fsPath))
      throw Error("频谱文件需要 .raw 扩展名。");
    if (target.fsPath === viewer.uri.fsPath)
      throw Error("请选择独立的频谱文件。");
    await track(async () => {
      const request = await readInputs();
      const samples = numericSamples(request.inputs[0].events, first, signed);
      const result = waveSpectrum(
        samples,
        start,
        end,
        secondsPerTick,
        Number(points),
        window,
        interpolation,
        removeMean,
      );
      if (!current()) return;
      const text = spectrumRaw(
        result,
        inputs + " · " + window + " · " + points + " points",
        first.unit,
      );
      await code.workspace.fs.writeFile(target, Buffer.from(text));
      const spectrum = await open(target);
      if (spectrum?.meta && !spectrum.disposed)
        await spectrum.ui("addSignals", { signals: spectrum.meta.signals });
    });
    return;
  }

  if (operation === "adc" || operation === "dac") {
    const adc = operation === "adc";
    if (adc ? !first.real : first.real || first.width > 32)
      throw Error(
        adc
          ? "请先选中实数输入，再选可选触发信号。"
          : "请先选中 1–32 bit 数字输入，再选可选触发信号。",
      );
    const limits = await read(
      title,
      "低值, 高值" +
        (adc ? ", 分辨率 bit。量化使用无符号码。" : "。输入使用无符号码。"),
      adc ? "0, 1, 8" : "0, 1",
    );
    if (limits === undefined) return;
    const fields = limits.split(",").map((field) => field.trim());
    if (fields.some((field) => !field) || fields.length !== (adc ? 3 : 2))
      throw Error("请输入完整的转换范围。");
    const [low, high, resolution] = fields.map(Number);
    const mode = await pick(
      title + " 采样方式",
      second
        ? [{ label: "外部触发 · " + label(second), value: "external" as const }]
        : [
            { label: "随输入变化", value: "changes" as const },
            { label: "固定周期", value: "periodic" as const },
          ],
    );
    if (!mode) return;
    const delayText = await read(
      title + " 输出延迟",
      "采样到输出更新之间的 tick 数。",
      "0",
    );
    if (delayText === undefined) return;
    if (!/^\d{1,20}$/.test(delayText)) throw Error("延迟必须是非负整数 tick。");
    const delay = BigInt(delayText);
    let sampling: ConverterSampling = { mode: "changes", delay };
    if (mode === "periodic") {
      const text = await read(
        title + " 固定周期",
        "周期, 起始相对 A/B 左端或波形起点的偏移（tick）。",
        "1, 0",
      );
      if (text === undefined) return;
      const match = /^(\d{1,20})\s*,\s*(\d{1,20})$/.exec(text.trim());
      if (!match) throw Error("请输入整数周期和偏移。");
      sampling = {
        mode,
        period: BigInt(match[1]),
        offset: BigInt(match[2]),
        delay,
      };
    } else if (mode === "external") {
      const edge = await pick(title + " 触发沿", [
        { label: "上升沿", value: "rising" as const },
        { label: "下降沿", value: "falling" as const },
        { label: "双沿", value: "either" as const },
      ]);
      if (!edge) return;
      const threshold = second!.real
        ? await read(title + " 实数触发阈值", "按采样点跨越阈值触发。", "0.5")
        : "0.5";
      if (threshold === undefined) return;
      if (!threshold.trim() || !Number.isFinite(Number(threshold)))
        throw Error("请输入有效阈值。");
      sampling = { mode, edge, threshold: Number(threshold), delay };
    }
    const name = await read(
      title + " 输出信号名",
      inputs,
      title + "(" + label(first) + ")",
    );
    if (!name?.trim()) return;
    const unit = adc
      ? ""
      : await read(title + " 输出单位", "可选单位，例如 V。", "");
    if (unit === undefined || unit.length > 24) return;
    await track(async () => {
      const request = await readInputs();
      const output = convertWave(
        operation,
        request,
        adc ? resolution : first.width,
        low,
        high,
        sampling,
      );
      if (output.kind === "real") output.unit = unit.trim() || undefined;
      await publish(
        request,
        validateOperatorOutput(output, request),
        name.trim(),
        title,
      );
    });
    return;
  }

  if (operation === "external") {
    if (!code.workspace.isTrusted) throw Error("外部数学算子需要可信工作区。");
    const engine = await pick("外部数学算子", [
      { label: "JavaScript 模块", value: "javascript" as const },
      { label: "Native 可执行文件", value: "native" as const },
    ]);
    if (!engine) return;
    const entry = (
      await code.window.showOpenDialog({
        title: "选择要执行的本地算子",
        canSelectMany: false,
        canSelectFiles: true,
        canSelectFolders: false,
        filters:
          engine === "javascript"
            ? { JavaScript: ["js", "mjs", "cjs"] }
            : undefined,
      })
    )?.[0];
    if (!entry) return;
    const settings = await read("算子参数", "输入传给算子的 JSON 对象。", "{}");
    if (settings === undefined) return;
    if (settings.length > 65536) throw Error("算子参数超过 64 KiB。");
    const options = JSON.parse(settings);
    if (!options || Array.isArray(options) || typeof options !== "object")
      throw Error("算子参数必须是 JSON 对象。");
    const name = await read(
      "外部算子输出信号名",
      inputs,
      path.basename(entry.fsPath),
    );
    if (!name?.trim()) return;
    await track(async () => {
      const request = await readInputs();
      request.options = options;
      const result = await runWaveOperator(engine, entry.fsPath, request);
      await publish(
        request,
        validateOperatorOutput(result, request),
        name.trim(),
        entry.fsPath,
      );
    });
    return;
  }

  const expression =
    operation === "filter"
      ? "A"
      : await read(title, inputs, signals.length > 1 ? "A + B" : "A");
  if (expression === undefined) return;
  const compiled = compileWaveExpression(expression, signals.length);
  const cutoff =
    operation === "filter"
      ? await read(title, "输入截止频率（Hz）。", "1000000")
      : "1";
  if (cutoff === undefined) return;
  const defaultPeriod = (end - start + 1023n) / 1024n;
  const period =
    operation === "filter"
      ? await read(title, "输出采样周期（tick）。", String(defaultPeriod))
      : "1";
  if (period === undefined) return;
  if (!/^\d{1,20}$/.test(period)) throw Error("输出周期必须是整数 tick。");
  const signed = await numberMode();
  if (signed === undefined) return;
  const name = await read(
    title + " 输出信号名",
    inputs,
    title + "(" + expression + ")",
  );
  if (!name?.trim()) return;
  const unit = await read(
    title + " 输出单位",
    "可选单位，例如 V、V/s 或 V·s。",
    operation === "filter" ? (first.unit ?? "") : "",
  );
  if (unit === undefined || unit.length > 24) return;
  await track(async () => {
    const request = await readInputs();
    const samples = signals.map((signal, i) =>
      numericSamples(request.inputs[i].events, signal, signed),
    );
    const events =
      operation === "filter"
        ? filterWave(
            samples[0],
            start,
            end,
            secondsPerTick,
            Number(cutoff),
            BigInt(period),
            fileEnd,
          )
        : calculateWave(
            compiled,
            samples,
            start,
            end,
            secondsPerTick,
            operation === "expression" ? "pointwise" : operation,
            fileEnd,
          );
    await publish(
      request,
      { kind: "real", unit: unit.trim() || undefined, events },
      name.trim(),
      expression,
    );
  });
}
