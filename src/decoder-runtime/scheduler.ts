// SPDX-License-Identifier: MPL-2.0

import { createHash } from "node:crypto";
import type { Backend } from "../backend";
import type { Metadata, Signal } from "../shared/protocol";
import { builtinRuntime } from "./builtin";
import { readEventBatches } from "./event-batch";
import type { DecoderDefinition } from "./registry";
import { javascriptRuntime, luaRuntime } from "./script-runtimes";
import {
  maxTransactions,
  readOptions,
  tickPattern,
  validateResult,
  type DecoderContext,
  type DecodeResult,
  type Json,
} from "./types";

type Provider = { backend: Backend; meta: Metadata };
type Job = {
  provider: Provider;
  definition: DecoderDefinition;
  bindings: (Signal | null)[];
  options?: unknown;
  start: string;
  end: string;
  signal?: AbortSignal;
};

export class DecoderScheduler {
  #cache = new WeakMap<Backend, Map<string, DecodeResult>>();
  #checkpoints = new WeakMap<
    Backend,
    Map<string, { tick: bigint; state: Json }[]>
  >();
  #active = 0;

  constructor(private readonly binary: string) {}

  async decode(job: Job): Promise<DecodeResult> {
    const { provider, definition, bindings } = job;
    const { meta, backend } = provider;
    const context: DecoderContext = {
      scale: meta.scale,
      inputs: definition.manifest.inputs.map(({ id }, i) =>
        bindings[i] ? { id, width: bindings[i]!.width } : null,
      ),
      options: { ...definition.manifest.options, ...readOptions(job.options) },
    };
    if (!tickPattern.test(job.start) || !tickPattern.test(job.end))
      throw Error("Invalid decoder ticks.");
    const start = BigInt(job.start),
      end = BigInt(job.end);
    if (
      start >= end ||
      start < BigInt(meta.start) ||
      end > BigInt(meta.end) + 1n
    )
      throw Error("Decoder window is outside the waveform.");
    job.signal?.throwIfAborted();
    const stateKey = createHash("sha256")
      .update(
        JSON.stringify([
          definition.hash,
          bindings.map(
            (binding) =>
              binding && [binding.id, binding.bitOffset, binding.width],
          ),
          context,
          meta.start,
          meta.end,
        ]),
      )
      .digest("hex");
    const key = [stateKey, job.start, job.end].join(":");
    let cache = this.#cache.get(backend);
    if (!cache) this.#cache.set(backend, (cache = new Map()));
    const cached = cache.get(key);
    if (cached) {
      cache.delete(key);
      cache.set(key, cached);
      return structuredClone(cached);
    }
    if (this.#active >= 4) throw Error("Too many active decoder queries.");
    this.#active++;
    const timeout = AbortSignal.timeout(15_000);
    const signal = job.signal
      ? AbortSignal.any([job.signal, timeout])
      : timeout;
    try {
      const open = async () =>
        definition.profile
          ? builtinRuntime(definition.profile, context)
          : definition.manifest.engine === "javascript"
            ? javascriptRuntime(definition, context)
            : await luaRuntime(this.binary, definition, context, signal);
      let runtime = await open();
      try {
        let replayStart = BigInt(meta.start);
        const checkpointCache =
          this.#checkpoints.get(backend) ??
          new Map<string, { tick: bigint; state: Json }[]>();
        if (
          definition.manifest.capabilities?.checkpoints &&
          runtime.restoreState
        ) {
          this.#checkpoints.set(backend, checkpointCache);
          const checkpoint = checkpointCache
            .get(stateKey)
            ?.findLast((item) => item.tick <= start);
          if (checkpoint) {
            try {
              await runtime.restoreState(checkpoint.state, signal);
              replayStart = checkpoint.tick;
            } catch {
              runtime.dispose();
              signal.throwIfAborted();
              checkpointCache.delete(stateKey);
              runtime = await open();
            }
          }
        }
        const result: DecodeResult = {
          transactions: [],
          warnings: [],
          truncated: false,
        };
        function collect(batch: DecodeResult) {
          validateResult(batch);
          for (const item of batch.transactions) {
            if (BigInt(item.start) >= end || BigInt(item.end) <= start)
              continue;
            if (result.transactions.length === maxTransactions) {
              result.truncated = true;
              break;
            }
            result.transactions.push(item);
          }
          result.warnings = [
            ...new Set([...result.warnings, ...batch.warnings]),
          ].slice(0, 64);
          result.truncated ||= batch.truncated;
        }
        let total = 0;
        async function consume(first: bigint, last: bigint) {
          for await (const batch of readEventBatches(
            backend,
            bindings,
            first,
            last,
            signal,
          )) {
            total += batch.inputs.length;
            if (total > 1_000_000)
              throw Error("Decoder replay exceeds one million events.");
            const decoded = await runtime.decode(batch, signal);
            if (
              decoded.transactions.some(
                (item) => BigInt(item.end) > BigInt(batch.end),
              )
            )
              throw Error("Decoder emitted a transaction before its end tick.");
            collect(decoded);
          }
        }
        if (
          definition.manifest.capabilities?.checkpoints &&
          runtime.saveState &&
          replayStart < start
        ) {
          await consume(replayStart, start);
          const state = await runtime.saveState(signal);
          const list = checkpointCache.get(stateKey) ?? [];
          if (!checkpointCache.has(stateKey) && checkpointCache.size >= 8)
            checkpointCache.delete(checkpointCache.keys().next().value!);
          checkpointCache.set(
            stateKey,
            [
              ...list.filter((item) => item.tick !== start),
              { tick: start, state },
            ]
              .sort((a, b) => (a.tick < b.tick ? -1 : 1))
              .slice(-8),
          );
          replayStart = start;
        }
        // Replay through EOF to include transactions that close after the selected window.
        await consume(replayStart, BigInt(meta.end) + 1n);
        collect(await runtime.flush(signal));
        signal.throwIfAborted();
        result.transactions.sort((a, b) =>
          BigInt(a.start) < BigInt(b.start)
            ? -1
            : BigInt(a.start) > BigInt(b.start)
              ? 1
              : 0,
        );
        if (!result.truncated && JSON.stringify(result).length < 512 * 1024) {
          if (cache.size >= 8) cache.delete(cache.keys().next().value!);
          cache.set(key, structuredClone(result));
        }
        return result;
      } finally {
        runtime.dispose();
      }
    } finally {
      this.#active--;
    }
  }
}
