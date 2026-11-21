// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type * as vscode from "vscode";
import type { Backend } from "./backend";
import * as WaveSignal from "./shared/signals";
import { registerVirtuals } from "./view-state";
import type { Viewer } from "./viewer";

export function createWaveEditorQueries(
  viewer: Viewer,
  cfg: vscode.WorkspaceConfiguration,
  refreshSidebar: () => void,
) {
  async function scopeSignals(backend: Backend, surface: vscode.Webview, msg) {
    if (viewer.selectedScope !== msg.scope) {
      viewer.selectedScope = msg.scope;
      refreshSidebar();
    }
    const result = await backend.request("scopeSignals", {
      query: msg.scope,
      offset: Math.max(0, msg.offset || 0),
      limit: 512,
    });
    await surface.postMessage({
      type: "scopeSignals",
      request: msg.request,
      ...result,
    });
  }

  async function search(backend: Backend, surface: vscode.Webview, msg) {
    const result = await backend.request("search", {
      query: msg.query,
      offset: Number.isSafeInteger(msg.offset) ? msg.offset : 0,
      limit: msg.limit || 512,
    });
    await surface.postMessage({
      type: "searchResult",
      request: msg.request,
      ...result,
    });
  }

  async function defineVirtual(backend: Backend, surface: vscode.Webview, msg) {
    const result = await backend.request("defineVirtual", {
      definition: msg.definition,
      name: typeof msg.name === "string" ? msg.name.slice(0, 120) : "",
    });
    await surface.postMessage({
      type: "virtualCreated",
      ...result,
    });
  }

  async function restore(backend: Backend, surface: vscode.Webview, msg) {
    await registerVirtuals(backend, msg.virtualDefinitions || []);
    const style = new Map();
    for (const s of msg.signals) {
      if (typeof s === "string") continue;
      const key = WaveSignal.baseKey(s);
      if (!style.has(key)) style.set(key, []);
      style.get(key).push(s);
    }
    const signals = [];
    for (let i = 0; i < msg.signals.length; i += 1000) {
      const chunk = msg.signals
        .slice(i, i + 1000)
        .map((s) =>
          typeof s === "string"
            ? { id: s }
            : { id: s.id, scope: s.scope, name: s.name },
        );
      const described = await backend.request("describe", {
        descriptors: chunk,
      });
      for (const signal of described) {
        const s = style.get(WaveSignal.baseKey(signal))?.shift() || {};
        signals.push(WaveSignal.restore(s, signal));
      }
    }
    await surface.postMessage({ type: "restore", signals });
  }

  async function overview(backend: Backend, surface: vscode.Webview, msg) {
    if (
      typeof msg.signal !== "string" ||
      !Number.isSafeInteger(msg.start) ||
      !Number.isSafeInteger(msg.end) ||
      msg.start < 0 ||
      msg.end < msg.start ||
      !Number.isSafeInteger(msg.bins) ||
      msg.bins < 1 ||
      msg.bins > 4096
    )
      return;
    try {
      const result = await backend.request("overview", {
        name: msg.signal,
        start: String(msg.start),
        end: String(msg.end),
        bins: msg.bins,
      });
      await surface.postMessage({
        type: "overview",
        request: msg.request,
        result,
      });
    } catch (error) {
      await surface.postMessage({
        type: "overview",
        request: msg.request,
        error: String(error),
      });
    }
  }

  async function query(backend: Backend, surface: vscode.Webview, msg) {
    if (
      !viewer.meta ||
      !Array.isArray(msg.signals) ||
      msg.signals.length > 64 ||
      !Number.isSafeInteger(msg.start) ||
      !Number.isSafeInteger(msg.end) ||
      msg.start < 0 ||
      msg.end < msg.start
    )
      return;
    const result = await backend.request("query", {
      signals: msg.signals,
      start: String(msg.start),
      end: String(msg.end),
      limit:
        typeof msg.request === "string" &&
        msg.request.startsWith("uart:") &&
        msg.signals.length === 1
          ? 100000
          : msg.report && Number.isSafeInteger(msg.limit)
            ? Math.min(
                cfg.get<number>("eventsPerSignal") || 20000,
                Math.max(2, Math.min(5000, msg.limit)),
              )
            : cfg.get<number>("eventsPerSignal"),
    });
    await surface.postMessage({
      type: "data",
      request: msg.request,
      result,
    });
  }

  return function receive(
    backend: Backend,
    surface: vscode.Webview,
    msg,
  ): Promise<void> | undefined {
    switch (msg.type) {
      case "scopeSignals":
        if (typeof msg.scope === "string")
          return scopeSignals(backend, surface, msg);
        break;
      case "search":
        if (typeof msg.query === "string" && msg.query.length < 1024)
          return search(backend, surface, msg);
        break;
      case "defineVirtual":
        return defineVirtual(backend, surface, msg);
      case "restore":
        if (Array.isArray(msg.signals) && msg.signals.length <= 100000)
          return restore(backend, surface, msg);
        break;
      case "overview":
        return overview(backend, surface, msg);
      case "query":
        return query(backend, surface, msg);
    }
  };
}
