// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { ChildProcessWithoutNullStreams } from "node:child_process";
export interface TclNode {
  value: string;
  items?: TclNode[];
}
import { spawn } from "node:child_process";
import * as readline from "node:readline";
import * as path from "node:path";
import { existsSync } from "node:fs";
const encode = (s: unknown) =>
  Buffer.from(String(s), "utf8").toString("base64");
const decode = (s: string) => Buffer.from(s || "", "base64").toString("utf8");
class TclRunner {
  dispatch: (
    name: string,
    args: TclNode[],
    directory: string,
  ) => Promise<unknown>;
  log: (text: string) => void;
  child: ChildProcessWithoutNullStreams;
  closed = false;
  pending: {
    resolve: (value: string) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  constructor(
    dispatch: TclRunner["dispatch"],
    {
      executable,
      log = (_text: string) => {},
    }: {
      executable?: string;
      log?: (text: string) => void;
    } = {},
  ) {
    this.dispatch = dispatch;
    this.log = log;
    const env = { ...process.env };
    const runtime = path.resolve(__dirname, "../bin/tcl");
    const bundledShell = path.join(
      runtime,
      "bin",
      process.platform === "win32" ? "tclsh.exe" : "tclsh",
    );
    const bundled = !executable && existsSync(bundledShell);
    executable ||= bundled ? bundledShell : "tclsh";
    if (bundled || executable === "tclsh" || executable === "/usr/bin/tclsh") {
      for (const key of Object.keys(env)) {
        if (
          [
            "LD_LIBRARY_PATH",
            "TCL_LIBRARY",
            "TCLLIBPATH",
            "TK_LIBRARY",
          ].includes(key.toUpperCase())
        )
          delete env[key];
      }
    }
    if (bundled) env.TCL_LIBRARY = path.join(runtime, "lib", "tcl8.6");
    this.child = spawn(executable, [path.join(__dirname, "tcl/bridge.tcl")], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env,
    });
    this.child.on("error", (e) => this.fail(e));
    this.child.on("exit", () => this.fail(new Error("Tcl interpreter exited")));
    this.child.stdin.on("error", (e) => this.fail(e));
    this.child.stderr.on("data", (d) => log(d.toString()));
    readline
      .createInterface({ input: this.child.stdout })
      .on("line", async (line) => {
        const [type, a, b, directory] = line.split("\t");
        if (type === "LOG") {
          log(decode(a));
          return;
        }
        if (type === "CALL") {
          try {
            const result = await this.dispatch(
              decode(a),
              JSON.parse(decode(b)),
              decode(directory),
            );
            this.child.stdin.write("OK\t" + encode(result ?? "") + "\n");
          } catch (e) {
            this.child.stdin.write(
              "ERROR\t" +
                encode(e instanceof Error ? e.message : String(e)) +
                "\n",
            );
          }
        } else if (type === "DONE" && this.pending) {
          const p = this.pending;
          this.pending = null;
          clearTimeout(p.timer);
          if (a === "ERROR") p.reject(new Error(decode(b)));
          else p.resolve(decode(b));
        }
      });
  }
  run(script: string, directory = process.cwd()): Promise<string> {
    if (this.closed)
      return Promise.reject(new Error("Tcl interpreter is closed"));
    if (this.pending)
      return Promise.reject(
        new Error("A Tcl script is already running in this window"),
      );
    if (Buffer.byteLength(script) > 1024 * 1024)
      return Promise.reject(new Error("Script size exceeds 1 MiB"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(new Error("Tcl script exceeded 120 seconds"));
        this.child.kill();
      }, 120000);
      this.pending = { resolve, reject, timer };
      this.child.stdin.write(encode(script) + "\t" + encode(directory) + "\n");
    });
  }
  fail(error: Error) {
    this.closed = true;
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(error);
      this.pending = null;
    }
  }
  dispose() {
    this.fail(new Error("Tcl interpreter closed"));
    this.child.kill();
    this.child.stdin.destroy();
    this.child.stdout.destroy();
    this.child.stderr.destroy();
  }
}
export { TclRunner };
