// SPDX-License-Identifier: MPL-2.0

import type * as vscode from "vscode";
import { existsSync } from "node:fs";
import { Backend } from "./backend";
import { KdbSession } from "./kdb";

export type FsdbBackend = "auto" | "independent" | "verdi";

export const backendChoices = [
  {
    value: "auto",
    label: "自动",
    description: "优先使用 Verdi，启动或读盘失败时尝试 WaveBench Reader",
  },
  {
    value: "independent",
    label: "独立后端",
    description: "使用 Rust 直接读取 FSDB 和 KDB",
  },
  {
    value: "verdi",
    label: "Verdi 后端",
    description: "使用本机 Verdi Reader 和 NPI",
  },
] as const;

export const isFsdb = (filename: string) => /\.fsdb$/i.test(filename);
export const isWaveform = (filename: string) =>
  /\.(?:fsdb|fst|vcd)$/i.test(filename);

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
  const binary = cfg.get<string>("backendPath");
  const home =
    cfg.get<string>("verdiHome") ||
    process.env.VERDI_HOME ||
    process.env.NOVAS_HOME;
  const useBundledVerdi =
    process.platform === "linux" &&
    process.arch === "x64" &&
    existsSync(context.asAbsolutePath("bin/verdi-sdk"));
  const verdiConfigured = Boolean(binary || (home && useBundledVerdi));
  if (
    isFsdb(filename) &&
    (choice === "independent" || (choice === "auto" && !verdiConfigured))
  ) {
    const binary =
      independent ||
      context.asAbsolutePath(
        `bin/wave-backend-independent${process.platform === "win32" ? ".exe" : ""}`,
      );
    const args = independent ? [] : ["--independent"];
    const env = { ...process.env };
    const lzo = cfg.get<string>("lzoLibraryPath");
    if (lzo) env.WAVE_WORKBENCH_LZO_LIBRARY = lzo;
    const options = { args, env, useVerdiLibraries: false, onLog: log };
    return {
      kind: "independent" as const,
      label: "独立后端",
      createWave: () => new Backend(binary, options),
      createKdb: () => new KdbSession(binary, undefined, log, options),
    };
  }
  const env = { ...process.env };
  if (home) env.VERDI_HOME = home;
  const fst = /\.fst$/i.test(filename);
  const fsdb = isFsdb(filename);
  const standalone = context.asAbsolutePath(
    `bin/wave-backend-independent${process.platform === "win32" ? ".exe" : ""}`,
  );
  const waveBinary =
    !fsdb && existsSync(standalone) ? standalone : defaultBinary;
  return {
    kind: fsdb ? ("verdi" as const) : fst ? ("fst" as const) : ("vcd" as const),
    label: fsdb ? "Verdi 后端" : fst ? "FST" : "VCD",
    createWave: () =>
      new Backend(binary || waveBinary, {
        env,
        onLog: log,
        useVerdiLibraries: fsdb || Boolean(binary),
      }),
    createKdb: () => {
      if (!home && !binary)
        throw Error("请设置 waveWorkbench.verdiHome 或 VERDI_HOME 后接入 KDB");
      return new KdbSession(binary || defaultBinary, home, log);
    },
  };
}
