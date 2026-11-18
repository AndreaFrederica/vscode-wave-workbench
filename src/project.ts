// SPDX-License-Identifier: MPL-2.0

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { WaveState } from "./shared/protocol";
import type { Viewer } from "./viewer";

interface WaveProject {
  format: "wave-workbench-project";
  version: 1;
  waveform: string;
  kdb?: string;
  verilator?: string;
  designView?: DesignView;
  view: WaveState;
}

export interface DesignView {
  selected: string;
  expanded: string[];
  includeOther: boolean;
}

export function designSnapshot(viewer: Viewer): DesignView | undefined {
  if (!viewer.kdb) return undefined;
  return {
    selected: viewer.selectedScope || "",
    expanded: [...viewer.treeExpanded].sort(),
    includeOther: !!viewer.includeOther,
  };
}

export async function saveWaveProject(
  filename: string,
  waveform: string,
  view: WaveState,
  kdb?: string,
  verilator?: string,
  designView?: DesignView,
) {
  const directory = path.dirname(filename);
  const document: WaveProject = {
    format: "wave-workbench-project",
    version: 1,
    waveform: path.relative(directory, waveform),
    kdb: kdb ? path.relative(directory, kdb) : undefined,
    verilator: verilator ? path.relative(directory, verilator) : undefined,
    designView,
    view,
  };
  const temporary = path.join(directory, ".wave-project-" + randomUUID());
  try {
    await fs.writeFile(temporary, JSON.stringify(document, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    await fs.rename(temporary, filename);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

export async function readWaveProject(filename: string) {
  const info = await fs.stat(filename);
  if (!info.isFile() || info.size > 64 * 1024 * 1024)
    throw Error("Invalid waveform project file");
  const document = JSON.parse(
    await fs.readFile(filename, "utf8"),
  ) as WaveProject;
  if (
    document?.format !== "wave-workbench-project" ||
    document.version !== 1 ||
    typeof document.waveform !== "string" ||
    !document.waveform ||
    (document.kdb !== undefined && typeof document.kdb !== "string") ||
    (document.verilator !== undefined &&
      (typeof document.verilator !== "string" ||
        !/\.tree\.json$/i.test(document.verilator))) ||
    Boolean(document.kdb && document.verilator) ||
    (document.designView !== undefined &&
      (typeof document.designView?.selected !== "string" ||
        !Array.isArray(document.designView.expanded) ||
        document.designView.expanded.some(
          (scope) => typeof scope !== "string",
        ) ||
        typeof document.designView.includeOther !== "boolean")) ||
    !document.view ||
    !Array.isArray(document.view.chosen)
  )
    throw Error("Unsupported waveform project format");
  const directory = path.dirname(filename);
  return {
    ...document,
    waveform: path.resolve(directory, document.waveform),
    kdb: document.kdb ? path.resolve(directory, document.kdb) : undefined,
    verilator: document.verilator
      ? path.resolve(directory, document.verilator)
      : undefined,
  };
}
