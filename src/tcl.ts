import type { ChildProcessWithoutNullStreams } from "node:child_process";
export interface TclNode {
  value: string;
  items?: TclNode[];
}
import { spawn } from "node:child_process";
import * as readline from "node:readline";
import * as path from "node:path";
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
    { executable = "/usr/bin/tclsh", log = (_text: string) => {} } = {},
  ) {
    this.dispatch = dispatch;
    this.log = log;
    const env = { ...process.env };
    if (executable === "/usr/bin/tclsh") {
      delete env.LD_LIBRARY_PATH;
      delete env.TCL_LIBRARY;
      delete env.TCLLIBPATH;
      delete env.TK_LIBRARY;
    }
    this.child = spawn(executable, [path.join(__dirname, "tcl/bridge.tcl")], {
      stdio: ["pipe", "pipe", "pipe"],
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
  }
}
export { TclRunner };
