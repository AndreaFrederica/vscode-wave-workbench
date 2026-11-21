// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type * as vscode from "vscode";
import type { Backend } from "./backend";
import { thresholdSamples } from "./shared/analog";
import type { Viewer } from "./viewer";
import type { TrackTask } from "./wave-extension-types";
import { mathActions, showWaveMath } from "./wave-math-editor";
import { measureWave, measurements } from "./wave-measurements";

type WaveOperationMessage =
  | {
      type: "waveMath";
      operation: Parameters<typeof showWaveMath>[2];
      signals: Parameters<typeof showWaveMath>[3];
      range?: Parameters<typeof showWaveMath>[4];
    }
  | {
      type: "measureWave";
      operation: Parameters<typeof measureWave>[2];
      signals: Parameters<typeof measureWave>[3];
      start: string;
      end: string;
      reverse?: boolean;
      request: number;
    }
  | {
      type: "analogOperation";
      operation: "unit" | "threshold";
      id: string;
      scope?: string;
      name?: string;
      unit?: string;
    };

export async function handleWaveOperation(
  vscode: typeof import("vscode"),
  viewer: Viewer,
  backend: Backend,
  surface: vscode.Webview,
  msg: WaveOperationMessage,
  trackTask: TrackTask,
  openWaveform: (uri: vscode.Uri) => Promise<Viewer | undefined>,
) {
  if (msg.type === "waveMath" && mathActions.includes(msg.operation)) {
    await showWaveMath(
      vscode,
      viewer,
      msg.operation,
      msg.signals,
      msg.range,
      (work) =>
        trackTask(
          msg.operation === "fft" ? "计算 FFT" : "计算派生波形",
          viewer.uri.fsPath,
          work,
        ),
      openWaveform,
    );
  } else if (
    msg.type === "measureWave" &&
    measurements.includes(msg.operation)
  ) {
    try {
      const rows = await measureWave(
        backend,
        viewer.meta,
        msg.operation,
        msg.signals,
        msg.start,
        msg.end,
        msg.reverse === true,
      );
      if (viewer.backend === backend)
        await surface.postMessage({
          type: "waveMeasurement",
          request: msg.request,
          rows,
        });
    } catch (error) {
      if (viewer.backend === backend)
        await surface.postMessage({
          type: "waveMeasurement",
          request: msg.request,
          error: error instanceof Error ? error.message : String(error),
        });
    }
  } else if (msg.type === "analogOperation") {
    const id = msg.id;
    if (typeof id !== "string") return;
    const [signal] = await backend.request("describe", {
      descriptors: [{ id, scope: msg.scope, name: msg.name }],
    });
    if (!signal?.real || !signal.supported) throw Error("请选择一条实数信号。");
    if (msg.operation === "unit") {
      const unit = await vscode.window.showInputBox({
        title: "设置实数单位",
        prompt: "输入显示单位，留空可清除",
        value: typeof msg.unit === "string" ? msg.unit.slice(0, 24) : "",
        validateInput: (unit) =>
          unit.trim().length > 24 ? "单位最多 24 字符。" : undefined,
      });
      if (unit !== undefined && viewer.backend === backend)
        await surface.postMessage({
          type: "analogUnit",
          signal,
          unit: unit.trim(),
        });
    } else if (msg.operation === "threshold") {
      const value = await vscode.window.showInputBox({
        title: "生成带滞回的数字波形",
        prompt: "输入低阈值和高阈值，用逗号分隔",
        value: "0.3, 0.7",
      });
      if (value === undefined || viewer.backend !== backend) return;
      const thresholds = value.split(",").map((s) => s.trim());
      if (thresholds.length !== 2 || thresholds.some((s) => !s))
        throw Error("请输入两个阈值。");
      const [low, high] = thresholds.map(Number);
      const { start, end } = viewer.meta;
      const block = (
        await backend.request("query", {
          signals: [id],
          start,
          end,
          limit: 100000,
        })
      )[id];
      if (block.truncated) throw Error("实数波形超过全波形处理上限。");
      const samples = thresholdSamples(block.events, low, high);
      if (!samples.length || samples.length > 4096)
        throw Error("派生信号的采样数超出范围。");
      if (BigInt(samples[0][0]) > BigInt(start)) samples.unshift([start, "x"]);
      const result = await backend.request("defineVirtual", {
        name: signal.name + " 滞回",
        definition: {
          op: "samples",
          inputs: [],
          width: 1,
          source: ("threshold:" + id + ":" + signal.name).slice(0, 120),
          samples,
        },
      });
      await surface.postMessage({
        type: "virtualCreated",
        ...result,
      });
    }
  }
}
