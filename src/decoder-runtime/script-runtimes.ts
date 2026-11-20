// SPDX-License-Identifier: MPL-2.0

import { Worker } from "node:worker_threads";
import * as path from "node:path";
import { Backend } from "../backend";
import { binaryBatch } from "./event-batch";
import type { DecoderDefinition } from "./registry";
import {
  eventBatchVersion,
  readCheckpoint,
  validateResult,
  type DecoderContext,
  type DecoderRuntime,
  type EventBatch,
  type Json,
} from "./types";

export function javascriptRuntime(
  definition: DecoderDefinition,
  context: DecoderContext,
  reportTime?: (engineMs: number) => void,
): DecoderRuntime {
  const worker = new Worker(path.join(__dirname, "worker.js"), {
    workerData: {
      source: definition.source,
      filename: definition.filename,
      measure: !!reportTime,
      context,
    },
    resourceLimits: { maxOldGenerationSizeMb: 64, stackSizeMb: 4 },
  });
  let failure: Error | undefined;
  let pending:
    | { resolve: (value: unknown) => void; reject: (error: Error) => void }
    | undefined;
  const fail = (error: Error) => {
    failure = error;
    pending?.reject(error);
  };
  worker.on("error", fail);
  worker.on("exit", (code) =>
    fail(Error("Decoder worker exited (" + code + ").")),
  );
  worker.on("message", ({ result, error, engineMs }) => {
    if (typeof engineMs === "number") reportTime?.(engineMs);
    if (error) pending?.reject(Error(error));
    else pending?.resolve(result);
  });
  async function request(
    command: { batch?: EventBatch; save?: boolean; restore?: Json },
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    if (failure) throw failure;
    if (pending) throw Error("Decoder worker is busy.");
    const abort = () => fail(Error("Decoder cancelled."));
    signal.addEventListener("abort", abort, { once: true });
    try {
      return await new Promise<unknown>((resolve, reject) => {
        pending = { resolve, reject };
        const { batch } = command;
        const transfers = batch
          ? [
              ...new Set([
                batch.times.buffer,
                batch.inputs.buffer,
                batch.offsets.buffer,
                batch.values.buffer,
              ]),
            ]
          : [];
        worker.postMessage(command, transfers as ArrayBuffer[]);
      });
    } finally {
      pending = undefined;
      signal.removeEventListener("abort", abort);
    }
  }
  return {
    decode: async (batch, signal) =>
      validateResult(await request({ batch }, signal)),
    flush: async (signal) => validateResult(await request({}, signal)),
    async saveState(signal) {
      return readCheckpoint(await request({ save: true }, signal));
    },
    async restoreState(restore, signal) {
      await request({ restore }, signal);
    },
    dispose: () => {
      void worker.terminate();
    },
  };
}

export async function luaRuntime(
  binary: string,
  definition: DecoderDefinition,
  context: DecoderContext,
  signal: AbortSignal,
  reportTime?: (engineMs: number, preparationMs?: number) => void,
): Promise<DecoderRuntime> {
  signal.throwIfAborted();
  const backend = new Backend(binary, {
    args: ["--decoder-lua"],
    useVerdiLibraries: false,
  });
  const close = () => backend.dispose();
  signal.addEventListener("abort", close, { once: true });
  try {
    const version = await backend.request("decoderInit", {
      source: definition.source!,
      context,
      measure: !!reportTime,
    });
    if (version !== eventBatchVersion)
      throw Error(
        "The native Lua decoder does not support binary event batches. Rebuild or reinstall the extension.",
      );
  } catch (error) {
    signal.removeEventListener("abort", close);
    close();
    throw error;
  }
  function measured(result: unknown) {
    const { engineMs, preparationMs, ...payload } = result as {
      engineMs?: number;
      preparationMs?: number;
    };
    if (typeof engineMs === "number") reportTime?.(engineMs, preparationMs);
    return validateResult(payload);
  }
  return {
    async decode(batch) {
      const { header, chunks } = binaryBatch(batch);
      return measured(await backend.requestDecoderBatch(header, chunks));
    },
    async flush() {
      return measured(await backend.request("decoderFlush"));
    },
    async saveState() {
      return readCheckpoint(await backend.request("decoderSaveState"));
    },
    async restoreState(state) {
      await backend.request("decoderRestoreState", { state });
    },
    dispose() {
      signal.removeEventListener("abort", close);
      close();
    },
  };
}
