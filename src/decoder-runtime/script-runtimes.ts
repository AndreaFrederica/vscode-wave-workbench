// SPDX-License-Identifier: MPL-2.0

import { Worker } from "node:worker_threads";
import * as path from "node:path";
import { Backend } from "../backend";
import type { DecoderDefinition } from "./registry";
import {
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
): DecoderRuntime {
  const worker = new Worker(path.join(__dirname, "worker.js"), {
    workerData: {
      source: definition.source,
      filename: definition.filename,
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
  worker.on("message", ({ result, error }) =>
    error ? fail(Error(error)) : pending?.resolve(result),
  );
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
          ? [batch.inputs.buffer, batch.offsets.buffer, batch.values.buffer]
          : [];
        if (batch && !Array.isArray(batch.times))
          transfers.push(batch.times.buffer);
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
): Promise<DecoderRuntime> {
  signal.throwIfAborted();
  const backend = new Backend(binary, {
    args: ["--decoder-lua"],
    useVerdiLibraries: false,
  });
  const close = () => backend.dispose();
  signal.addEventListener("abort", close, { once: true });
  try {
    await backend.request("decoderInit", {
      source: definition.source!,
      context,
    });
  } catch (error) {
    signal.removeEventListener("abort", close);
    close();
    throw error;
  }
  return {
    async decode(batch) {
      return validateResult(
        await backend.request("decoderBatch", {
          start: batch.start,
          end: batch.end,
          initial: batch.initial,
          times: Array.from(batch.times as Iterable<string | bigint>, String),
          inputs: Array.from(batch.inputs),
          offsets: Array.from(batch.offsets),
          values: Buffer.from(batch.values).toString("ascii"),
        }),
      );
    },
    async flush() {
      return validateResult(await backend.request("decoderFlush"));
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
