// SPDX-License-Identifier: MPL-2.0

import * as path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import type * as VSCode from "vscode";
import { socketDirectory } from "./mcp-stdio";
import { readBackgroundTasks, type WaveTask } from "./wave-tasks";

export function createWaveTaskStatus(
  vscode: typeof VSCode,
  context: VSCode.ExtensionContext,
) {
  const foreground = new Set<WaveTask>();
  const local = new AsyncLocalStorage<WaveTask>();
  const status = vscode.window.createStatusBarItem?.(
    "waveWorkbench.tasks",
    vscode.StatusBarAlignment.Right,
    50,
  );
  let background: WaveTask[] = [];
  let disposed = false;
  let reading = false;
  const details = (task: WaveTask) =>
    [
      task.filename,
      `${Math.max(0, Math.floor((Date.now() - task.started) / 1000))} 秒`,
    ]
      .filter(Boolean)
      .join(" · ");
  const active = () =>
    [
      ...Array.from(foreground, (task) => ({ task, mode: "前台" })),
      ...background.map((task) => ({ task, mode: "后台" })),
    ].sort((a, b) => a.task.started - b.task.started);
  const label = (task: WaveTask, mode: string) => `${mode} · ${task.label}`;

  function update() {
    if (!status || disposed) return;
    const tasks = active();
    if (!tasks.length) {
      status.hide();
      return;
    }
    const { task, mode } = tasks[0];
    const name = task.label.replace(/\$\(/g, "（");
    status.text =
      tasks.length === 1
        ? `$(sync~spin) ${mode} · ${name}`
        : `$(sync~spin) 波形任务 (${tasks.length})`;
    status.tooltip = tasks
      .map(({ task, mode }) => `${label(task, mode)}\n${details(task)}`)
      .join("\n\n");
    status.show();
  }

  if (status) {
    status.name = "Wave Workbench Tasks";
    status.command = "waveWorkbench.showRunningTasks";
    const directories = () => [
      ...new Set(
        (vscode.workspace.workspaceFolders ?? []).flatMap(({ uri }) => {
          try {
            return uri.scheme === "file" ? [socketDirectory(uri.fsPath)] : [];
          } catch {
            return [];
          }
        }),
      ),
    ];
    let watched = directories();
    const folders = vscode.workspace.onDidChangeWorkspaceFolders(() => {
      watched = directories();
    });
    async function refresh() {
      if (reading) return;
      reading = true;
      try {
        const result = await Promise.all(
          watched.map((dir) => readBackgroundTasks(dir).catch(() => [])),
        );
        background = result.flat();
        update();
      } finally {
        reading = false;
      }
    }
    const timer = setInterval(() => void refresh(), 500);
    void refresh();
    context.subscriptions.push(
      folders,
      status,
      vscode.commands.registerCommand(
        "waveWorkbench.showRunningTasks",
        async () => {
          await refresh();
          const items = active().map(({ task, mode }) => ({
            label: label(task, mode),
            description: details(task),
          }));
          if (items.length)
            await vscode.window.showQuickPick(items, {
              placeHolder: "正在运行的波形任务",
            });
          else
            void vscode.window.showInformationMessage(
              "当前没有正在运行的波形任务。",
            );
        },
      ),
      {
        dispose() {
          disposed = true;
          clearInterval(timer);
        },
      },
    );
  }

  return async function track<T>(
    label: string,
    filename: string | undefined,
    work: () => Promise<T>,
  ): Promise<T> {
    if (!status || local.getStore()) return work();
    const task = {
      label,
      filename: filename ? path.normalize(filename) : undefined,
      started: Date.now(),
    };
    foreground.add(task);
    update();
    try {
      return await local.run(task, work);
    } finally {
      foreground.delete(task);
      update();
    }
  };
}
