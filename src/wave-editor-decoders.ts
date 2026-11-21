// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type * as vscode from "vscode";
import { loadDecoderCatalog, saveDecoderProfile } from "./decoder-config";
import type { DecoderInstance } from "./decoder-runtime/types";
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
    try {
      const decoded = await actions.decodeWindow(
        viewer,
        msg.instance,
        msg.start,
        msg.end,
        controller.signal,
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
