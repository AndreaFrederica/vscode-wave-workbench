// SPDX-License-Identifier: MPL-2.0

import { localize, localizeHtml } from "./shared/localization";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type * as vscode from "vscode";
import type { CacheStats, WaveCacheProjectUsage } from "./shared/protocol";
import type { GetViewer } from "./wave-extension-types";
import type { Viewer } from "./viewer";

const mib = 1024 * 1024;
const maxMiB = 1024 * 1024;
const limits = {
  cacheSizeMB: maxMiB,
  psfxlMemoryCacheSizeMB: maxMiB,
  psfxlCacheSizeMB: maxMiB,
};
type Setting = keyof typeof limits;

function settings(config: vscode.WorkspaceConfiguration) {
  return {
    cacheSizeMB: config.get<number>("cacheSizeMB", 128),
    psfxlMemoryCacheSizeMB: config.get<number>("psfxlMemoryCacheSizeMB", 64),
    psfxlCacheSizeMB: config.get<number>("psfxlCacheSizeMB", 768),
  };
}

export function cacheBudgets(config: vscode.WorkspaceConfiguration) {
  const size = settings(config);
  return {
    bytes: size.cacheSizeMB * mib,
    psfxl_memory_bytes: size.psfxlMemoryCacheSizeMB * mib,
    psfxl_bytes: size.psfxlCacheSizeMB * mib,
  };
}

export function createWaveCachePanel(
  code: typeof vscode,
  context: vscode.ExtensionContext,
  getCurrent: GetViewer,
  viewers: ReadonlySet<Viewer>,
) {
  let panel: vscode.WebviewPanel | undefined;
  return () => {
    if (panel) {
      panel.reveal();
      return;
    }
    const media = code.Uri.joinPath(context.extensionUri, "media");
    const built = code.Uri.joinPath(context.extensionUri, "dist", "webview");
    const view = code.window.createWebviewPanel(
      "waveWorkbench.cache",
      localize("波形缓存"),
      code.ViewColumn.Active,
      { enableScripts: true, localResourceRoots: [media, built] },
    );
    panel = view;
    const nonce = randomBytes(16).toString("hex");
    const uri = (root: vscode.Uri, file: string) =>
      view.webview.asWebviewUri(code.Uri.joinPath(root, file)).toString();
    view.webview.html = localizeHtml(
      readFileSync(context.asAbsolutePath("media/wave-cache.html"), "utf8"),
    )
      .replaceAll("{{csp}}", view.webview.cspSource)
      .replaceAll("{{nonce}}", nonce)
      .replace("{{css}}", uri(media, "wave-cache.css"))
      .replace("{{script}}", uri(built, "wave-cache.js"));

    let saving = false;
    let refreshing = false;
    let lastBackend: Viewer["backend"] | undefined;
    let lastSampleBackend: Viewer["backend"] | undefined;
    let session = 0;
    let sampleSession = 0;
    const samples = new WeakMap<
      Viewer["backend"],
      { stats?: CacheStats; reading?: boolean; failed?: boolean }
    >();
    const configuration = (viewer?: Viewer) =>
      code.workspace.getConfiguration("waveWorkbench", viewer?.uri);

    function sampleViewer(current?: Viewer) {
      const candidates = [...viewers].filter((open) => !open.disposed);
      const hasSamples = (open: Viewer) =>
        samples.get(open.backend)?.stats?.psfxl;
      const isLoadingShm = (open: Viewer) =>
        !samples.get(open.backend)?.stats &&
        !samples.get(open.backend)?.failed &&
        (open.meta?.backend === "rust-independent-shm" ||
          open.meta?.backend === "shm-lib");
      if (
        current &&
        !current.disposed &&
        (hasSamples(current) || isLoadingShm(current))
      )
        return current;
      return candidates.find(hasSamples) ?? candidates.find(isLoadingShm);
    }

    function poll(backend: Viewer["backend"]) {
      const sample = samples.get(backend) ?? {};
      samples.set(backend, sample);
      if (sample.reading) return;
      sample.reading = true;
      void backend.request("cacheStats").then(
        (stats) => {
          sample.stats = stats;
          sample.failed = false;
          sample.reading = false;
        },
        () => {
          sample.stats = undefined;
          sample.failed = true;
          sample.reading = false;
        },
      );
    }

    async function snapshot() {
      const viewer = getCurrent();
      const backend = viewer?.backend;
      if (backend !== lastBackend) {
        lastBackend = backend;
        session++;
      }
      const projects = new Map<string, WaveCacheProjectUsage>();
      const seen = new Set<Viewer["backend"]>();
      for (const open of viewers) {
        if (open.disposed || seen.has(open.backend)) continue;
        seen.add(open.backend);
        if (open.meta) poll(open.backend);
        const sample = samples.get(open.backend);
        const stats = sample?.stats;
        const filename = open.document.projectPath || open.uri.fsPath;
        const key = open.document.projectPath
          ? "project:" + open.document.projectPath
          : open.uri.toString();
        const project = projects.get(key) ?? {
          name: basename(filename),
          path: filename,
          active: false,
          sessions: 0,
          pending: 0,
          failed: 0,
          decoded: 0,
          samples: 0,
          disk: 0,
        };
        project.active ||= open === viewer;
        project.sessions++;
        if (stats) {
          project.decoded += stats.bytes;
          project.samples += stats.psfxl?.memory?.bytes ?? 0;
          project.disk += stats.psfxl?.bytes ?? 0;
        } else if (sample?.failed || open.openError) {
          project.failed++;
        } else {
          project.pending++;
        }
        projects.set(key, project);
      }
      const sample = sampleViewer(viewer);
      if (sample?.backend !== lastSampleBackend) {
        lastSampleBackend = sample?.backend;
        sampleSession++;
      }
      const cacheSettings = settings(configuration(viewer));
      const sampleSettings = settings(configuration(sample ?? viewer));
      await view.webview.postMessage({
        type: "snapshot",
        path: viewer?.uri.fsPath,
        backend: viewer?.meta?.backend,
        stats: backend && samples.get(backend)?.stats,
        psfxl: sample && samples.get(sample.backend)?.stats?.psfxl,
        psfxlPath: sample?.uri.fsPath,
        projects: [...projects.values()],
        settings: { ...sampleSettings, cacheSizeMB: cacheSettings.cacheSizeMB },
        session,
        sampleSession,
      });
    }

    async function save(key: Setting, size: number) {
      const current = getCurrent();
      const viewer =
        key === "cacheSizeMB" ? current : (sampleViewer(current) ?? current);
      const config = configuration(viewer);
      const target =
        config.inspect(key)?.workspaceFolderValue !== undefined
          ? code.ConfigurationTarget.WorkspaceFolder
          : code.workspace.workspaceFolders?.length
            ? code.ConfigurationTarget.Workspace
            : code.ConfigurationTarget.Global;
      await config.update(key, size, target);
      const results = await Promise.allSettled(
        [...viewers]
          .filter((open) => open.meta && !open.disposed)
          .map(async (open) => {
            const backend = open.backend;
            try {
              const stats = await backend.request(
                "cacheConfigure",
                cacheBudgets(configuration(open)),
              );
              const sample = samples.get(backend) ?? {};
              sample.stats = stats;
              sample.failed = false;
              samples.set(backend, sample);
            } catch (error) {
              if (!open.disposed && open.backend === backend) throw error;
            }
          }),
      );
      const failure = results.find((result) => result.status === "rejected");
      if (failure) throw failure.reason;
    }

    const subscription = view.webview.onDidReceiveMessage(async (message) => {
      const isSave = message?.type === "save";
      if (saving || (!isSave && (message?.type !== "refresh" || refreshing)))
        return;
      if (isSave) saving = true;
      else refreshing = true;
      try {
        if (isSave) {
          const { key, size } = message as { key: Setting; size: number };
          if (
            !Object.hasOwn(limits, key) ||
            !Number.isInteger(size) ||
            size < 0 ||
            size > limits[key]
          )
            throw Error(localize("请输入范围内的整数容量。"));
          await save(key, size);
          await view.webview.postMessage({
            type: "feedback",
            text: localize("容量设置已保存并应用。"),
            key,
          });
        }
        await snapshot();
      } catch (error) {
        await view.webview.postMessage({
          type: "feedback",
          error: true,
          text: error instanceof Error ? error.message : String(error),
        });
      } finally {
        if (isSave) saving = false;
        else refreshing = false;
      }
    });
    view.onDidDispose(() => {
      subscription.dispose();
      panel = undefined;
    });
  };
}
