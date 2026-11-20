// SPDX-License-Identifier: MPL-2.0

import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  CancellationTokenSource,
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/node";
import type { Uri } from "vscode";
import type { VideAnalysisApi, VideTrace, VideTraceProject } from "./rtl-trace";
import type { TraceHost } from "./wave-analysis";

export function fileUri(filename: string): Uri {
  const fsPath = path.resolve(filename);
  return {
    fsPath,
    scheme: "file",
    toString: () => pathToFileURL(fsPath).href,
  } as Uri;
}

function videExecutable(configured?: string) {
  if (configured) return configured;
  const filename = process.platform === "win32" ? "vide.exe" : "vide";
  for (const extensionDirectory of [
    process.env.VSCODE_AGENT_FOLDER &&
      path.join(process.env.VSCODE_AGENT_FOLDER, "extensions"),
    path.join(homedir(), ".vscode-server", "extensions"),
    path.join(homedir(), ".vscode", "extensions"),
    path.join(homedir(), ".vscode-insiders", "extensions"),
  ]) {
    if (!extensionDirectory || !existsSync(extensionDirectory)) continue;
    const candidates = readdirSync(extensionDirectory)
      .filter((entry) => entry.startsWith("pascal-lab.vide-code-extension-"))
      .sort((a, b) => b.localeCompare(a, "en", { numeric: true }));
    for (const candidate of candidates) {
      const executable = path.join(
        extensionDirectory,
        candidate,
        "server",
        filename,
      );
      if (existsSync(executable)) return executable;
    }
  }
  return filename;
}

export function headlessTraceHost(
  workspace: string,
  settings: Record<string, unknown>,
  log: (text: string) => void,
): TraceHost & { dispose(): void } {
  const children = new Set<() => void>();
  let defaultProject: Promise<VideTraceProject> | undefined;

  async function start(
    root: string,
    temporary = false,
    requireManifest = true,
  ): Promise<VideTraceProject> {
    const configured =
      process.env.WAVE_WORKBENCH_VIDE_PATH ?? settings["vide.server.command"];
    const executable = videExecutable(
      typeof configured === "string" && configured.includes(path.sep)
        ? path.resolve(workspace, configured)
        : typeof configured === "string"
          ? configured
          : undefined,
    );
    const args = ["vide.server.args", "vide.server.additionalArgs"].flatMap(
      (key) => {
        const configured = settings[key];
        return Array.isArray(configured)
          ? configured.filter((arg): arg is string => typeof arg === "string")
          : [];
      },
    );
    const cwd = settings["vide.server.cwd"];
    const child = spawn(executable, args, {
      cwd: typeof cwd === "string" ? path.resolve(workspace, cwd) : root,
      windowsHide: true,
    });
    const connection = createMessageConnection(
      new StreamMessageReader(child.stdout),
      new StreamMessageWriter(child.stdin),
    );
    let closed = false;
    const dispose = () => {
      if (closed) return;
      closed = true;
      children.delete(dispose);
      connection.dispose();
      child.kill();
      if (temporary)
        void rm(root, { recursive: true, force: true }).catch((error) =>
          log(String(error)),
        );
    };
    children.add(dispose);
    child.stderr.on("data", (data) => log(String(data)));
    let resolveReady: () => void;
    let rejectReady: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    void ready.catch(() => undefined);
    const fail = (error: Error) => {
      rejectReady(error);
      dispose();
    };
    child.once("error", (error) =>
      fail(
        Error(
          `Could not start modified VIDE (${executable}): ${error.message}`,
        ),
      ),
    );
    child.once("exit", (code) => fail(Error(`VIDE exited (${code}).`)));
    connection.onClose(() =>
      fail(Error("VIDE closed its analysis connection.")),
    );
    connection.onNotification(
      "vide/projectStatus",
      (status: { state: string; errors?: string[] }) => {
        if (
          status.state === "loaded" ||
          (!requireManifest && status.state === "none")
        )
          resolveReady();
        else if (status.state === "error" || status.state === "none")
          rejectReady(
            Error(
              status.errors?.join("\n") ||
                "VIDE could not load the analysis project.",
            ),
          );
      },
    );
    connection.onRequest(
      "workspace/configuration",
      ({ items }: { items: { section: string }[] }) =>
        items.map(({ section }) => settings[section] ?? null),
    );
    connection.listen();
    const startup = new CancellationTokenSource();
    const timer = setTimeout(
      () => fail(Error("VIDE project loading timed out.")),
      120_000,
    );
    try {
      const uri = pathToFileURL(root).href;
      const initial = await connection.sendRequest<{
        capabilities?: {
          experimental?: { videTrace?: { orderedProjectSources?: boolean } };
        };
      }>(
        "initialize",
        {
          processId: process.pid,
          rootUri: uri,
          workspaceFolders: [{ name: path.basename(root), uri }],
          capabilities: { general: { positionEncodings: ["utf-16"] } },
        },
        startup.token,
      );
      if (!initial.capabilities?.experimental?.videTrace?.orderedProjectSources)
        throw Error(
          "Install the modified VIDE with ordered RTL trace project support.",
        );
      await connection.sendNotification("initialized", {});
      if (requireManifest) await ready;
    } catch (error) {
      dispose();
      throw error;
    } finally {
      clearTimeout(timer);
      startup.dispose();
    }
    const openDocuments = new Map<string, { version: number; text: string }>();
    async function trace(
      method: string,
      args: Parameters<NonNullable<VideAnalysisApi["traceDrivers"]>>[0],
      token?: Parameters<NonNullable<VideAnalysisApi["traceDrivers"]>>[1],
    ) {
      if (!temporary && root === workspace) {
        const uri = args.textDocument.uri;
        const text = await readFile(fileURLToPath(uri), "utf8");
        const previous = openDocuments.get(uri);
        if (!previous) {
          await connection.sendNotification("textDocument/didOpen", {
            textDocument: {
              uri,
              text,
              version: 1,
              languageId: "systemverilog",
            },
          });
          openDocuments.set(uri, { version: 1, text });
        } else if (previous.text !== text) {
          const version = previous.version + 1;
          await connection.sendNotification("textDocument/didChange", {
            textDocument: { uri, version },
            contentChanges: [{ text }],
          });
          openDocuments.set(uri, { version, text });
        }
      }
      return connection.sendRequest<VideTrace | null>(method, args, token);
    }
    return {
      get closed() {
        return closed;
      },
      dispose,
      traceDrivers: (args, token) => trace("vide/traceDrivers", args, token),
      traceLoads: (args, token) => trace("vide/traceLoads", args, token),
    };
  }

  const api: VideAnalysisApi = {
    version: 1,
    capabilities: { staticTraceVersion: 1 },
    async openTraceProject(manifest) {
      const root = await mkdtemp(path.join(tmpdir(), "wave-vide-"));
      try {
        await writeFile(path.join(root, "vide.toml"), manifest, { flag: "wx" });
        return await start(root, true);
      } catch (error) {
        await rm(root, { recursive: true, force: true });
        throw error;
      }
    },
    async openTraceProjectFile(filename) {
      if (
        path.basename(filename) !== "vide.toml" ||
        !statSync(filename).isFile()
      )
        throw Error("Choose an existing vide.toml analysis manifest.");
      return start(path.dirname(filename));
    },
  };
  const project = async () => {
    if (defaultProject && !(await defaultProject).closed) return defaultProject;
    defaultProject = start(
      workspace,
      false,
      existsSync(path.join(workspace, "vide.toml")),
    ).catch((error) => {
      defaultProject = undefined;
      throw error;
    });
    return defaultProject;
  };
  api.traceDrivers = async (params, token) =>
    (await project()).traceDrivers(params, token);
  api.traceLoads = async (params, token) =>
    (await project()).traceLoads(params, token);

  return {
    getVide: async () => api,
    file: fileUri,
    position: (line, character) => ({ line, character }) as never,
    cancellation: () => new CancellationTokenSource(),
    workspace: {
      getConfiguration: () => ({
        get: <T>(name: string) => settings["waveWorkbench." + name] as T,
      }),
      textDocuments: [],
      async openTextDocument(uri) {
        const lines = (await readFile(uri.fsPath, "utf8")).split(/\r?\n/);
        const info = statSync(uri.fsPath);
        return {
          uri,
          isDirty: false,
          lineCount: lines.length,
          version: info.mtimeMs,
          lineAt: (line: number | { line: number }) =>
            ({
              text: lines[typeof line === "number" ? line : line.line],
            }) as never,
        };
      },
    },
    dispose: () => children.forEach((dispose) => dispose()),
  };
}
