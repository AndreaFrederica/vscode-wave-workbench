// SPDX-License-Identifier: MPL-2.0

import type * as vscode from "vscode";
import { Backend } from "./backend";
import { KdbSession } from "./kdb";

export type FsdbBackend = "auto" | "independent" | "verdi";

export const backendChoices = [
  {
    value: "auto",
    label: "自动",
    description: "按已配置的独立后端路径选择，否则使用 Verdi",
  },
  {
    value: "independent",
    label: "独立后端",
    description: "直接读取 FSDB 和 KDB",
  },
  {
    value: "verdi",
    label: "Verdi 后端",
    description: "使用本机 Verdi Reader 和 NPI",
  },
] as const;

export const isFsdb = (filename: string) => /\.fsdb$/i.test(filename);

export function backendPlan(
  context: Pick<vscode.ExtensionContext, "asAbsolutePath">,
  cfg: Pick<vscode.WorkspaceConfiguration, "get">,
  filename: string,
  log: (text: string) => void,
  choice = cfg.get<FsdbBackend>("fsdbBackend") ?? "auto",
) {
  const defaultBinary = context.asAbsolutePath(
    `bin/wave-backend${process.platform === "win32" ? ".exe" : ""}`,
  );
  const independent = cfg.get<string>("independentBackendPath");
  if (
    isFsdb(filename) &&
    (choice === "independent" || (choice === "auto" && independent))
  ) {
    const binary =
      independent || (process.platform === "win32" ? "python" : "python3");
    const args = independent
      ? []
      : [context.asAbsolutePath("independent_backend/backend.py")];
    const options = { args, useVerdiLibraries: false, onLog: log };
    return {
      kind: "independent" as const,
      label: "独立后端",
      createWave: () => new Backend(binary, options),
      createKdb: () => new KdbSession(binary, undefined, log, options),
    };
  }
  const binary = cfg.get<string>("backendPath");
  const home =
    cfg.get<string>("verdiHome") ||
    process.env.VERDI_HOME ||
    process.env.NOVAS_HOME;
  const env = { ...process.env };
  if (home) env.VERDI_HOME = home;
  return {
    kind: isFsdb(filename) ? ("verdi" as const) : ("vcd" as const),
    label: isFsdb(filename) ? "Verdi 后端" : "VCD",
    createWave: () => new Backend(binary || defaultBinary, { env, onLog: log }),
    createKdb: () => {
      if (!home && !binary)
        throw Error("请设置 waveWorkbench.verdiHome 或 VERDI_HOME 后接入 KDB");
      return new KdbSession(binary || defaultBinary, home, log);
    },
  };
}
