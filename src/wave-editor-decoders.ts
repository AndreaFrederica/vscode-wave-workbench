// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type * as vscode from "vscode";
import { loadDecoderCatalog, saveDecoderProfile } from "./decoder-config";
import type { DecoderInstance } from "./decoder-runtime/types";
import { findSignal } from "./signal-lookup";
import type { Viewer } from "./viewer";
import type { createWaveDecoders } from "./wave-decoders";

export type WaveEditorDecoderActions = Pick<
  ReturnType<typeof createWaveDecoders>,
  | "selectDecoder"
  | "editDecoderConfig"
  | "configureWaveDecoder"
  | "manageWaveDecoders"
  | "materializeDecoderSignal"
  | "decodeWindow"
  | "decoderConfigPath"
>;

export function createWaveEditorDecoders(
  vscode: typeof import("vscode"),
  viewer: Viewer,
  actions: WaveEditorDecoderActions,
) {
  const queries = new Map<string, AbortController>();

  let active = 0;
  const waiting: Array<() => void> = [];
  async function materialize(
    surface: vscode.Webview,
    instance: DecoderInstance,
  ) {
    const result = await actions.materializeDecoderSignal(viewer, instance);
    if (result)
      await surface.postMessage({ type: "virtualCreated", ...result });
  }

  async function query(surface: vscode.Webview, msg) {
    const id = msg.instance?.instanceId;
    if (typeof id !== "string" || id.length > 64)
      throw Error("Invalid decoder instance.");
    queries.get(id)?.abort();
    const controller = new AbortController();
    queries.set(id, controller);
    if (active >= 4)
      await new Promise<void>((resolve) => waiting.push(resolve));
    else active++;
    try {
      if (controller.signal.aborted) return;
      const decoded = await actions.decodeWindow(
        viewer,
        msg.instance,
        msg.start,
        msg.end,
        controller.signal,
        typeof msg.filter === "string" ? msg.filter.slice(0, 1024) : undefined,
      );
      if (!controller.signal.aborted)
        await surface.postMessage({
          type: "waveDecoderResult",
          instanceId: id,
          request: msg.request,
          decoded,
        });
    } catch (error) {
      if (!controller.signal.aborted)
        await surface.postMessage({
          type: "waveDecoderResult",
          instanceId: id,
          request: msg.request,
          error: error.message,
        });
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
      if (queries.get(id) === controller) queries.delete(id);
    }
  }

  async function catalog(surface: vscode.Webview) {
    const legacy = actions.decoderConfigPath(viewer);
    await surface.postMessage({
      type: "decoderCatalog",
      ...(await loadDecoderCatalog(legacy)),
      workspaceAvailable: !!legacy,
    });
  }

  async function saveProfile(surface: vscode.Webview, msg) {
    try {
      const legacy = actions.decoderConfigPath(viewer);
      if (!legacy) throw Error("请先打开工作区文件夹");
      const profile = await saveDecoderProfile(
        legacy,
        msg.group,
        msg.original,
        msg.edited,
        (filename) => {
          if (
            vscode.workspace.textDocuments.some(
              (document) =>
                document.isDirty && document.uri.fsPath === filename,
            )
          )
            throw Error("规则文件在编辑器中有未保存的修改，请先保存该文件");
        },
      );
      await surface.postMessage({
        type: "decoderProfileSaved",
        request: msg.request,
        profile,
      });
    } catch (error) {
      await surface.postMessage({
        type: "decoderProfileSaved",
        request: msg.request,
        error: error.message,
      });
    }
  }

  function receive(surface: vscode.Webview, msg): Promise<void> | undefined {
    switch (msg.type) {
      case "revealDecoderInputs":
        return (async () => {
          const bindings: Record<string, string> = msg.instance.bindings;
          const paths =
            typeof msg.channel === "string" &&
            Object.hasOwn(bindings, msg.channel)
              ? [bindings[msg.channel]]
              : Object.values(bindings);
          const signals = await Promise.all(
            [...new Set(paths)].map((path) => findSignal(viewer.backend, path)),
          );
          await surface.postMessage({
            type: "sidebarAdd",
            signals,
            focusSignals: signals,
            reveal: msg.reveal,
          });
        })();
      case "revealAxiHandshake":
        return (async () => {
          const channels =
            msg.channel === "read"
              ? ["ar", "r"]
              : msg.channel === "write"
                ? ["aw", "w", "b"]
                : [msg.channel];
          if (
            !channels.every((ch) =>
              ["aw", "w", "b", "ar", "r", "tla", "tld"].includes(ch),
            )
          )
            return;
          const bindings: Record<string, string> = msg.instance.bindings;
          const paths = Object.entries(bindings)
            .filter(
              ([id]) =>
                id === "aclk" || channels.some((ch) => id.startsWith(ch)),
            )
            .map(([, path]) => path);
          const signals = await Promise.all(
            paths.map((path) => findSignal(viewer.backend, path)),
          );
          await surface.postMessage({
            type: "sidebarAdd",
            signals,
            focusSignals: signals.filter((_, i) => paths[i] !== bindings.aclk),
            reveal: msg.reveal,
          });
        })();
      case "revealTlulHandshake":
        return (async () => {
          const { clk, h2d, d2h } = msg.instance.bindings;
          const [clock, host, device] = await Promise.all(
            [clk, h2d, d2h].map((path) => findSignal(viewer.backend, path)),
          );
          const bit = (bus: typeof host, offset: number, name: string) => ({
            ...bus,
            width: 1,
            sourceWidth: bus.width,
            bitOffset: offset,
            displayName: name,
          });
          await surface.postMessage({
            type: "sidebarAdd",
            reveal: msg.reveal,
            focusSignals: [msg.channel === "D" ? device : host],
            signals: [
              clock,
              bit(host, host.width - 1, "a_valid"),
              bit(device, 0, "a_ready"),
              bit(device, device.width - 1, "d_valid"),
              bit(host, 0, "d_ready"),
              host,
              device,
            ],
          });
        })();
      case "selectDecoder":
        return actions.selectDecoder(viewer);
      case "editDecoderConfig":
        return actions.editDecoderConfig(viewer);
      case "configureWaveDecoder":
        return actions.configureWaveDecoder(viewer);
      case "manageWaveDecoders":
        return actions.manageWaveDecoders(viewer);
      case "materializeDecoderSignal":
        return materialize(surface, msg.instance);
      case "cancelWaveDecoder":
        queries.get(msg.instanceId)?.abort();
        return Promise.resolve();
      case "queryWaveDecoder":
        return query(surface, msg);
      case "decoderCatalog":
        return catalog(surface);
      case "saveDecoderProfile":
        return saveProfile(surface, msg);
    }
  }

  return {
    receive,
    dispose() {
      for (const query of queries.values()) query.abort();
      queries.clear();
    },
  };
}
