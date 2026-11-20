// SPDX-License-Identifier: MPL-2.0

import { parentPort, workerData } from "node:worker_threads";
import { runInNewContext } from "node:vm";
import { scriptEvents } from "./event-batch";
import {
  maxTransactions,
  readCheckpoint,
  validateResult,
  type DecodeResult,
  type DecoderContext,
  type EventBatch,
  type Json,
} from "./types";

const { source, filename, context } = workerData as {
  source: string;
  filename: string;
  context: DecoderContext;
};
const channel = parentPort!;
let result: DecodeResult;
const ctx = Object.freeze({
  ...context,
  getOption: (name: string) => context.options[name],
  getInput: (name: string) =>
    context.inputs.find((input) => input?.id === name),
  emit(value: DecodeResult["transactions"][number]) {
    if (result.transactions.length >= maxTransactions)
      throw Error("Decoder transaction limit exceeded.");
    result.transactions.push(JSON.parse(JSON.stringify(value)));
  },
  reportDiagnostic(message: string) {
    if (result.warnings.length >= 64)
      throw Error("Decoder diagnostic limit exceeded.");
    result.warnings.push(String(message).slice(0, 1024));
  },
});
const exports = {};
const moduleValue = { exports };
runInNewContext(
  source,
  { module: moduleValue, exports },
  { filename, contextCodeGeneration: { strings: false, wasm: false } },
);
interface Script {
  init?(context: typeof ctx): unknown;
  decode(
    context: typeof ctx,
    state: unknown,
    batch: ReturnType<typeof scriptEvents>,
  ): unknown;
  flush?(context: typeof ctx, state: unknown): unknown;
  saveState?(state: unknown): unknown;
  restoreState?(value: Json): unknown;
}
const exported = moduleValue.exports as Script & { default?: Script };
const decoder = exported.default ?? exported;
if (typeof decoder.decode !== "function")
  throw Error("Decoder must export a decode function.");
result = { transactions: [], warnings: [], truncated: false };
let state = decoder.init?.(ctx);
if ((state as PromiseLike<unknown> | undefined)?.then)
  throw Error("Decoder functions must be synchronous.");
channel.on(
  "message",
  (command: { batch?: EventBatch; save?: boolean; restore?: Json }) => {
    try {
      if (command.save) {
        if (!decoder.saveState)
          throw Error("Decoder has no saveState function.");
        channel.postMessage({
          result: readCheckpoint(decoder.saveState(state)),
        });
        return;
      }
      if (command.restore !== undefined) {
        if (!decoder.restoreState)
          throw Error("Decoder has no restoreState function.");
        state = decoder.restoreState(command.restore);
        if ((state as PromiseLike<unknown> | undefined)?.then)
          throw Error("Decoder functions must be synchronous.");
        channel.postMessage({ result: null });
        return;
      }
      const { batch } = command;
      result = { transactions: [], warnings: [], truncated: false };
      const returned = batch
        ? decoder.decode(ctx, state, scriptEvents(batch))
        : decoder.flush?.(ctx, state);
      if ((returned as PromiseLike<unknown> | undefined)?.then)
        throw Error("Decoder functions must be synchronous.");
      channel.postMessage({ result: validateResult(result) });
    } catch (error) {
      channel.postMessage({ error: String(error).slice(0, 4096) });
    }
  },
);
