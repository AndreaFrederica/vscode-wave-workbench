// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type {
  ChildProcessWithoutNullStreams,
  SpawnOptionsWithoutStdio,
} from "node:child_process";
import type { BackendProtocol } from "./shared/protocol";
import { spawn } from "node:child_process";
import * as readline from "node:readline";
import * as path from "node:path";
interface BackendOptions extends SpawnOptionsWithoutStdio {
  onLog?: (text: string) => void;
  args?: string[];
  useVerdiLibraries?: boolean;
}
class Backend {
  pending: Map<
    number,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >;
  sequence: number;
  closed: boolean;
  child: ChildProcessWithoutNullStreams;
  constructor(
    binary: string,
    {
      args = [],
      useVerdiLibraries = true,
      onLog,
      ...options
    }: BackendOptions = {},
  ) {
    this.pending = new Map();
    this.sequence = 0;
    this.closed = false;
    const env = { ...(options.env || process.env) };
    const home = env.VERDI_HOME || env.NOVAS_HOME;
    const readerLib =
      env.FSDB_LIB_DIR || (home && path.join(home, "share/FsdbReader/linux64"));
    if (!useVerdiLibraries) {
      delete env.VERDI_HOME;
      delete env.NOVAS_HOME;
      delete env.FSDB_LIB_DIR;
    } else if (readerLib)
      env.LD_LIBRARY_PATH = [readerLib, env.LD_LIBRARY_PATH]
        .filter(Boolean)
        .join(path.delimiter);
    this.child = spawn(binary, args, {
      stdio: ["pipe", "pipe", "pipe"],
      ...options,
      env,
    });
    const fail = (error: Error) => {
      this.closed = true;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(error);
      }
      this.pending.clear();
    };
    this.child.on("error", fail);
    this.child.on("exit", (code, signal) =>
      fail(
        new Error(
          `Wave backend exited (${signal || code}). See Output > Wave Workbench.`,
        ),
      ),
    );
    this.child.stdin.on("error", fail);
    this.child.stderr.on("data", (d) => onLog?.(d.toString()));
    readline
      .createInterface({ input: this.child.stdout })
      .on("line", (line) => {
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          onLog?.(line);
          return;
        }
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(msg.error));
        else p.resolve(msg.result);
      });
  }
  request<M extends Exclude<keyof BackendProtocol, "decoderBatch">>(
    method: M,
    ...[args]: {} extends BackendProtocol[M]["args"]
      ? [args?: BackendProtocol[M]["args"]]
      : [args: BackendProtocol[M]["args"]]
  ): Promise<BackendProtocol[M]["result"]> {
    return this.send(method, args);
  }

  requestDecoderBatch(
    header: BackendProtocol["decoderBatch"]["args"],
    chunks: readonly Uint8Array[],
  ): Promise<BackendProtocol["decoderBatch"]["result"]> {
    return this.send("decoderBatch", header, chunks);
  }

  private send<M extends keyof BackendProtocol>(
    method: M,
    args: BackendProtocol[M]["args"] | undefined,
    chunks: readonly Uint8Array[] = [],
  ): Promise<BackendProtocol[M]["result"]> {
    if (this.closed) return Promise.reject(new Error("Wave backend is closed"));
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const line = JSON.stringify({ id, method, ...args }) + "\n";
      const timer = setTimeout(() => {
        if (method === "cacheStats") this.pending.delete(id);
        else this.dispose();
        reject(
          new Error(
            "Wave read exceeded 120 seconds; reduce the selected window/signals.",
          ),
        );
      }, 120000);
      this.pending.set(id, { resolve, reject, timer });
      const stream = this.child.stdin;
      if (chunks.length) stream.cork();
      try {
        stream.write(line);
        for (const chunk of chunks) stream.write(chunk);
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
        if (chunks.length) this.dispose();
      } finally {
        if (chunks.length) stream.uncork();
      }
    });
  }
  dispose() {
    this.closed = true;
    this.child.kill();
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("Wave backend closed"));
    }
    this.pending.clear();
  }
}
export { Backend };
