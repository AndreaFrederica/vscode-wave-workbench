// SPDX-License-Identifier: MPL-2.0

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as files from "node:fs/promises";
import * as path from "node:path";

export interface WaveTask {
  label: string;
  filename?: string;
  started: number;
}

const filenamePattern = /^task-(\d+)-[a-f0-9-]{36}\.json$/;

export function startBackgroundTask(directory: string, task: WaveTask) {
  const filename = path.join(
    directory,
    `task-${process.pid}-${randomUUID()}.json`,
  );
  try {
    fs.writeFileSync(filename, JSON.stringify(task), {
      flag: "wx",
      mode: 0o600,
    });
  } catch {
    // Task reporting must not prevent a waveform operation from running.
  }
  return () => {
    try {
      fs.rmSync(filename, { force: true });
    } catch {}
  };
}

export async function readBackgroundTasks(
  directory: string,
): Promise<WaveTask[]> {
  const entries = await files.readdir(directory, { withFileTypes: true });
  const tasks = await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isFile()) return;
      const match = filenamePattern.exec(entry.name);
      if (!match) return;
      const pid = Number(match[1]);
      if (!Number.isInteger(pid) || pid < 1 || pid > 0x7fffffff) return;
      const file = path.join(directory, entry.name);
      try {
        process.kill(pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH")
          await files.rm(file, { force: true }).catch(() => {});
        return;
      }
      try {
        if ((await files.stat(file)).size > 32 * 1024) return;
        const task = JSON.parse(await files.readFile(file, "utf8"));
        if (
          typeof task?.label === "string" &&
          typeof task.started === "number" &&
          Number.isFinite(task.started) &&
          (task.filename === undefined || typeof task.filename === "string")
        )
          return task as WaveTask;
      } catch {}
    }),
  );
  return tasks.filter((task): task is WaveTask => !!task);
}
