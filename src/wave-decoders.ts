// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { Viewer } from "./viewer";
import type { Signal } from "./shared/protocol";
import type * as vscode from "vscode";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

import { createDecoderGroup, loadDecoderProfiles } from "./decoder-config";
import {
  createScriptDecoder,
  decoderRegistry,
  type DecoderDefinition,
} from "./decoder-runtime/registry";
import { DecoderScheduler } from "./decoder-runtime/scheduler";
import { idPattern, type DecoderInstance } from "./decoder-runtime/types";
import { builtinProfiles, supportsProfile } from "./shared/decoders";
import { decodeWaveWindow } from "./wave-decoder-service";
import * as WaveSignal from "./shared/signals";

type VSCodeApi = typeof vscode;

export function createWaveDecoders(
  vscode: VSCodeApi,
  {
    context,
    output,
    viewers,
  }: {
    context: vscode.ExtensionContext;
    output: vscode.OutputChannel;
    viewers: Set<Viewer>;
  },
) {
  const decoderScheduler = new DecoderScheduler(
    context.asAbsolutePath(
      "bin/wave-backend-independent" +
        (process.platform === "win32" ? ".exe" : ""),
    ),
  );
  const decoderFileWatch = vscode.workspace.createFileSystemWatcher?.(
    "**/wave-decoders/{lua,javascript}/**/*",
  );
  if (decoderFileWatch) {
    let reloadTimer: ReturnType<typeof setTimeout> | undefined;
    const reload = (uri: vscode.Uri) => {
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => {
        const root = vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath;
        for (const viewer of viewers) {
          const config = decoderConfigPath(viewer);
          if (
            viewer.disposed ||
            !viewer.meta ||
            (root && config && path.dirname(path.dirname(config)) !== root)
          )
            continue;
          void viewer.ui("decoderRefresh").catch(() => {});
        }
      }, 150);
    };
    context.subscriptions.push(
      decoderFileWatch,
      decoderFileWatch.onDidCreate(reload),
      decoderFileWatch.onDidChange(reload),
      decoderFileWatch.onDidDelete(reload),
      { dispose: () => clearTimeout(reloadTimer) },
    );
  }
  function decoderConfigPath(viewer: Viewer) {
    const root = (
      vscode.workspace.getWorkspaceFolder?.(viewer.uri) ??
      vscode.workspace.workspaceFolders?.[0]
    )?.uri.fsPath;
    return root ? path.join(root, ".vscode", "wave-decoders.json") : undefined;
  }
  async function listWaveDecoders(viewer: Viewer) {
    const config = decoderConfigPath(viewer);
    const root = config && path.dirname(path.dirname(config));
    return decoderRegistry(
      await loadDecoderProfiles(config),
      vscode.workspace.isTrusted ? root : undefined,
    );
  }
  async function decodeWindow(
    viewer: Viewer,
    instance: DecoderInstance,
    start: string,
    end: string,
    signal?: AbortSignal,
  ) {
    await viewer.ready;
    const { backend, meta } = viewer;
    const decoded = await decodeWaveWindow(
      { backend, meta },
      decoderScheduler,
      await listWaveDecoders(viewer),
      instance,
      start,
      end,
      signal,
    );
    if (viewer.disposed || viewer.backend !== backend || viewer.meta !== meta)
      throw Error("The waveform changed during decoder replay.");
    return decoded;
  }
  async function configureWaveDecoder(viewer: Viewer) {
    const { definitions, warnings } = await listWaveDecoders(viewer);
    for (const warning of warnings) output.appendLine(warning);
    const choice = await vscode.window.showQuickPick(
      [...definitions.values()].map(({ manifest }) => ({
        label: manifest.name,
        description: manifest.engine + " · " + manifest.version,
        manifest,
      })),
      { placeHolder: "选择波形事务解码器" },
    );
    if (!choice) return;
    const selected: Signal | undefined = await viewer.ui("activeSignal");
    const bindings: Record<string, string> = {};
    for (const input of choice.manifest.inputs) {
      const name = await vscode.window.showInputBox({
        prompt: "绑定输入 " + input.id,
        value: selected ? selected.scope + "." + selected.name : "",
        validateInput: (value) =>
          !value.trim() && input.required !== false
            ? "输入波形信号路径"
            : undefined,
      });
      if (name === undefined) return;
      if (name.trim()) bindings[input.id] = name.trim();
    }
    const options = await vscode.window.showInputBox({
      prompt: "解码参数（JSON 对象）",
      value: JSON.stringify(choice.manifest.options ?? {}),
      validateInput(value) {
        try {
          const object = JSON.parse(value);
          return !object || typeof object !== "object" || Array.isArray(object)
            ? "请输入 JSON 对象"
            : undefined;
        } catch {
          return "无效的 JSON";
        }
      },
    });
    if (options === undefined) return;
    await viewer.ui("decoderAttach", {
      instanceId: randomUUID(),
      decoderId: choice.manifest.id,
      engine: choice.manifest.engine,
      bindings,
      options: JSON.parse(options),
    });
  }
  async function manageWaveDecoders(viewer: Viewer) {
    if (!vscode.workspace.isTrusted)
      throw Error("请在可信工作区管理脚本解码器。");
    const config = decoderConfigPath(viewer);
    if (!config) throw Error("请先打开工作区文件夹。");
    const root = path.dirname(path.dirname(config));
    const { definitions, warnings } = await listWaveDecoders(viewer);
    for (const warning of warnings) output.appendLine(warning);
    const action = await vscode.window.showQuickPick(
      [
        { label: "新建", id: "create" },
        { label: "复制", id: "copy" },
        { label: "编辑入口脚本", id: "script" },
        { label: "编辑清单", id: "manifest" },
        { label: "移到回收站", id: "trash" },
      ],
      { title: "管理脚本解码器" },
    );
    if (!action) return;
    let source: DecoderDefinition | undefined;
    if (action.id !== "create") {
      const choice = await vscode.window.showQuickPick(
        [...definitions.values()]
          .filter((definition) => definition.directory)
          .map((definition) => ({
            label: definition.manifest.name,
            description: definition.manifest.id,
            definition,
          })),
        { placeHolder: "选择工作区脚本解码器" },
      );
      if (!choice) return;
      source = choice.definition;
      if (action.id === "trash") {
        const confirmed = await vscode.window.showWarningMessage(
          "将 " + source.manifest.id + " 移到回收站？",
          { modal: true },
          "移到回收站",
        );
        if (confirmed)
          await vscode.workspace.fs.delete(vscode.Uri.file(source.directory!), {
            recursive: true,
            useTrash: true,
          });
        return;
      }
      if (action.id !== "copy") {
        const filename =
          action.id === "manifest"
            ? path.join(source.directory!, "decoder.json")
            : source.filename!;
        await vscode.window.showTextDocument(vscode.Uri.file(filename));
        return;
      }
    }
    const engine =
      source?.manifest.engine ??
      (await vscode.window.showQuickPick(["lua", "javascript"], {
        placeHolder: "选择脚本引擎",
      }));
    if (engine !== "lua" && engine !== "javascript") return;
    const id = await vscode.window.showInputBox({
      prompt: "解码器 ID",
      value: source ? source.manifest.id + ".copy" : "custom.",
      validateInput: (value) =>
        !idPattern.test(value)
          ? "请输入有效的解码器 ID"
          : definitions.has(value)
            ? "解码器 ID 已存在"
            : undefined,
    });
    if (!id) return;
    const filename = await createScriptDecoder(root, engine, id, source);
    await vscode.window.showTextDocument(vscode.Uri.file(filename));
  }
  async function materializeDecoderSignal(
    viewer: Viewer,
    instance: DecoderInstance,
  ) {
    await viewer.ready;
    const backend = viewer.backend;
    const { start, end } = viewer.meta;
    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "计算完整波形的虚拟信号",
        cancellable: true,
      },
      async (_progress, token) => {
        const controller = new AbortController();
        const cancel = token.onCancellationRequested(() => controller.abort());
        if (token.isCancellationRequested) controller.abort();
        try {
          return await decodeWindow(
            viewer,
            instance,
            start,
            String(BigInt(end) + 1n),
            controller.signal,
          );
        } catch (error) {
          if (!controller.signal.aborted) throw error;
        } finally {
          cancel.dispose();
        }
      },
    );
    if (!result) return;
    if (result.truncated) throw Error("解码结果达到容量上限。");
    const outputs = new Map<
      string,
      { width: number; samples: Map<string, string> }
    >();
    for (const { id, width, tick, value } of result.virtualSamples ?? []) {
      const output = outputs.get(id) ?? {
        width,
        samples: new Map<string, string>(),
      };
      if (output.width !== width)
        throw Error("虚拟信号 " + id + " 的位宽发生变化。");
      output.samples.set(tick, value);
      outputs.set(id, output);
    }
    if (!outputs.size) throw Error("此解码器没有输出虚拟信号采样。");
    const choice = await vscode.window.showQuickPick(
      [...outputs].map(([label, output]) => ({ label, output })),
      { placeHolder: "选择虚拟信号" },
    );
    if (!choice || viewer.disposed || viewer.backend !== backend) return;
    const { width, samples } = choice.output;
    if (!samples.has(start)) samples.set(start, "x".repeat(width));
    return backend.request("defineVirtual", {
      name: choice.label,
      definition: {
        op: "samples",
        inputs: [],
        width,
        source: instance.instanceId + "." + choice.label,
        samples: [...samples].sort(([left], [right]) =>
          BigInt(left) < BigInt(right) ? -1 : 1,
        ),
      },
    });
  }
  async function editDecoderConfig(viewer: Viewer) {
    const legacy = decoderConfigPath(viewer);
    if (!legacy) throw Error("请先打开工作区文件夹");
    const filename = await createDecoderGroup(legacy);
    await vscode.window.showTextDocument(
      await vscode.workspace.openTextDocument(filename),
    );
  }
  async function selectDecoder(viewer: Viewer) {
    const signal: Signal = await viewer.ui("activeSignal");
    if (!signal) throw Error("请先选中一个信号");
    const profiles = await loadDecoderProfiles(decoderConfigPath(viewer));
    const choices = [
      { label: "直接显示原始值", description: "", profile: undefined },
      ...profiles
        .filter((p) => supportsProfile(p, signal.width))
        .map((profile) => ({
          label: profile.label,
          description:
            (builtinProfiles.some((preset) => preset.id === profile.id)
              ? "内置预设"
              : "工作区规则") +
            " · " +
            profile.id,
          detail: signal.decoder?.id === profile.id ? "当前配置" : undefined,
          profile,
        })),
    ];
    const pick = await vscode.window.showQuickPick(choices, {
      title: "信号解码 · " + WaveSignal.label(signal),
      placeHolder: "选择与信号位宽匹配的解码规则",
    });
    if (pick) await viewer.ui("setDecoder", { signal, profile: pick.profile });
  }

  return {
    decoderConfigPath,
    listWaveDecoders,
    decodeWindow,
    configureWaveDecoder,
    manageWaveDecoders,
    materializeDecoderSignal,
    editDecoderConfig,
    selectDecoder,
  };
}
