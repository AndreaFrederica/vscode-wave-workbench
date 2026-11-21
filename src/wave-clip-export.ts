// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { Viewer } from "./viewer";
import type { ClipContext, WaveClip, WaveState } from "./shared/protocol";
import type * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs";

import { collectClip, serializeClip, type ClipFormat } from "./wave-clip";

import type { TrackTask } from "./wave-extension-types";
import type { createWaveDecoders } from "./wave-decoders";

type VSCodeApi = typeof vscode;

export function createWaveClipExport(
  vscode: VSCodeApi,
  {
    trackTask,
    decodeWindow,
  }: {
    trackTask: TrackTask;
    decodeWindow: ReturnType<typeof createWaveDecoders>["decodeWindow"];
  },
) {
  async function exportClipArtifact(
    viewer: Viewer,
    clip: WaveClip,
    format: ClipFormat,
    filename?: string,
    exclusive = true,
  ) {
    const summary = {
      format,
      waveform: clip.waveform,
      timescale: clip.timescale,
      start: clip.start,
      end: clip.end,
      signalCount: clip.traces.length,
      truncated: clip.truncated,
    };
    if (!filename && format !== "png")
      throw Error("A path is required for this format");
    if (filename && path.extname(filename).toLowerCase() !== "." + format)
      throw Error("The file extension must match the export format");
    if (filename && path.resolve(filename) === path.resolve(viewer.uri.fsPath))
      throw Error("Choose a destination different from the source waveform");
    if (format === "vcd" && clip.truncated)
      throw Error(
        "The waveform segment exceeds the event limit. Choose a shorter interval to export VCD.",
      );

    const png: string | undefined =
      format === "png" ? await viewer.ui("renderClipImage", clip) : undefined;
    if (!filename) return { ...summary, imagePng: png };
    const data =
      format === "png"
        ? Buffer.from(png, "base64")
        : serializeClip(clip, format);
    await fs.promises.writeFile(filename, data, {
      flag: exclusive ? "wx" : "w",
    });
    return { ...summary, path: filename };
  }

  async function chooseClipExport(viewer: Viewer) {
    if (!viewer) throw Error("先打开波形");
    await viewer.ready;
    if (!viewer.meta) throw Error("波形未加载成功");
    const view: ClipContext = await viewer.ui("clipContext");
    const options = [
      { label: "当前可见时间窗口", range: "view" as const },
      ...(view.cursorB !== null && view.cursorA !== view.cursorB
        ? [{ label: "游标 A 到 B", range: "cursors" as const }]
        : []),
    ];
    const scope = await vscode.window.showQuickPick(
      [
        {
          label: "已选信号",
          description: `${view.selected.length} 个`,
          signals: view.selected,
        },
        {
          label: "当前显示的信号",
          description: `${view.displayed.length} 个`,
          signals: view.displayed,
        },
      ],
      { placeHolder: "选择要截取的信号" },
    );
    if (!scope) return;
    const interval = await vscode.window.showQuickPick(options, {
      placeHolder: "选择截取的时间范围",
    });
    if (!interval) return;
    const kind = await vscode.window.showQuickPick(
      [
        { label: "PNG 图片", format: "png" as const },
        { label: "CSV 事件表", format: "csv" as const },
        { label: "JSON 波形数据", format: "json" as const },
        { label: "VCD 波形片段", format: "vcd" as const },
      ],
      { placeHolder: "选择导出格式" },
    );
    if (!kind) return;

    const clip = await trackTask("截取波形", viewer.uri.fsPath, async () => {
      const result = await collectClip(
        viewer,
        { range: interval.range },
        false,
        {
          ...view,
          selected: scope.signals,
        },
      );
      await includeClipDecoder(viewer, result, kind.format);
      return result;
    });
    const destination = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(
        path.join(
          path.dirname(viewer.uri.fsPath),
          `wave-${clip.start}-${clip.end}.${kind.format}`,
        ),
      ),
      filters: { [kind.label]: [kind.format] },
    });
    if (!destination) return;
    await trackTask(
      `导出波形 ${kind.format.toUpperCase()}`,
      viewer.uri.fsPath,
      () =>
        exportClipArtifact(
          viewer,
          clip,
          kind.format,
          destination.fsPath,
          false,
        ),
    );
    vscode.window.showInformationMessage(
      clip.truncated
        ? "波形已导出。部分信号达到事件上限，文件中已标记。"
        : "波形片段已导出。",
    );
  }

  async function includeClipDecoder(
    viewer: Viewer,
    clip: WaveClip,
    format: ClipFormat,
    signal?: AbortSignal,
  ) {
    if (format !== "png" && format !== "json") return;
    const view: WaveState = await viewer.ui("snapshot");
    for (const instance of view?.decoderInstances ?? []) {
      let result;
      try {
        result = await decodeWindow(
          viewer,
          instance,
          clip.start,
          String(BigInt(clip.end) + 1n),
          signal,
        );
      } catch (error) {
        signal?.throwIfAborted();
        result = {
          transactions: [],
          warnings: [String(error)],
          truncated: true,
        };
      }
      (clip.decoders ??= []).push({ id: instance.decoderId, result });
    }
  }

  return { exportClipArtifact, chooseClipExport, includeClipDecoder };
}
