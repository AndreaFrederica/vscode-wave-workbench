// SPDX-License-Identifier: MPL-2.0
import { transactionFilter } from "../shared/transaction-filter";
import type { Backend } from "../backend";
import type { Metadata, Signal } from "../shared/protocol";
import { readEventBatches } from "./event-batch";
import {
  maxTransactions,
  validateResult,
  type DecodeResult,
  type DecoderTransaction,
  type ProtocolRuntime,
} from "./types";

type Page = {
  first: bigint;
  last: bigint;
  bytes: number;
  transactions: DecoderTransaction[];
};
type Entry = {
  cursor: bigint;
  floor: bigint;
  bytes: number;
  pages: Page[];
  runtime: ProtocolRuntime;
  busy: boolean;
  done: boolean;
};
const indexBytes = 16 * 1024 * 1024;
const replyBytes = 4 * 1024 * 1024;

export class ProtocolIndex {
  private sessions = new WeakMap<Metadata, Map<string, Entry>>();
  async query(
    backend: Backend,
    meta: Metadata,
    bindings: (Signal | null)[],
    key: string,
    start: bigint,
    end: bigint,
    open: () => ProtocolRuntime,
    signal: AbortSignal,
    filter = "",
  ): Promise<DecodeResult> {
    let entries = this.sessions.get(meta);
    if (!entries) this.sessions.set(meta, (entries = new Map()));
    let entry = entries.get(key);
    if (!entry || entry.busy || start < entry.floor) {
      const origin = BigInt(meta.start);
      if (entry && !entry.busy) entry.runtime.dispose();
      entry = {
        cursor: origin,
        floor: origin,
        bytes: 0,
        pages: [],
        runtime: open(),
        busy: false,
        done: false,
      };
      entries.set(key, entry);
      if (entries.size > 4)
        for (const [oldKey, old] of entries)
          if (oldKey !== key && !old.busy) {
            old.runtime.dispose();
            entries.delete(oldKey);
            break;
          }
    }
    entry.busy = true;
    const eof = BigInt(meta.end) + 1n;
    const result: DecodeResult = {
      transactions: [],
      warnings: [],
      truncated: false,
    };
    const span = end - start,
      bins = span < 128n ? Number(span) : 128;
    const overview = Array.from({ length: bins }, (_, i) => ({
      start: String(
        start + (BigInt(i) * span + BigInt(bins) - 1n) / BigInt(bins),
      ),
      end: String(
        start + (BigInt(i + 1) * span + BigInt(bins) - 1n) / BigInt(bins),
      ),
      count: 0,
      errors: 0,
      warnings: 0,
    }));
    let used = 0;
    const matches = transactionFilter(filter);
    function collect(page: Page) {
      if (page.last <= start || page.first >= end) return;
      for (const tx of page.transactions) {
        const a = BigInt(tx.start);
        if (a >= end || BigInt(tx.end) <= start || !matches(tx)) continue;
        const bin =
          overview[
            Number((((a < start ? start : a) - start) * BigInt(bins)) / span)
          ];
        bin.count++;
        if (tx.severity === "error") bin.errors++;
        if (tx.severity === "warning") bin.warnings++;
        if (
          result.transactions.length === maxTransactions ||
          used >= replyBytes
        )
          result.truncated = true;
        else {
          used += JSON.stringify(tx).length;
          result.transactions.push(tx);
        }
      }
    }
    function append(batch: DecodeResult) {
      if (!batch.transactions.length) return;
      let first = eof,
        last = 0n;
      for (const tx of batch.transactions) {
        const a = BigInt(tx.start),
          b = BigInt(tx.end);
        if (a < first) first = a;
        if (b > last) last = b;
      }
      const page = {
        first,
        last,
        bytes: JSON.stringify(batch.transactions).length,
        transactions: batch.transactions,
      };
      collect(page);
      entry!.pages.push(page);
      entry!.bytes += page.bytes;
      while (entry!.bytes > indexBytes && entry!.pages.length) {
        const old = entry!.pages.shift()!;
        entry!.bytes -= old.bytes;
        if (old.last > entry!.floor) entry!.floor = old.last;
      }
    }
    try {
      for (const page of entry.pages) collect(page);
      // Read to the window edge, then continue only until all earlier
      // requests have closed. Cache completed pages and the live bus state.
      let step = end - start;
      while (
        !entry.done &&
        (entry.cursor < end || entry.runtime.pendingBefore(end))
      ) {
        signal.throwIfAborted();
        const limit =
          entry.cursor < end
            ? end
            : entry.cursor + step < eof
              ? entry.cursor + step
              : eof;
        for await (const batch of readEventBatches(
          backend,
          bindings,
          entry.cursor,
          limit,
          signal,
        )) {
          append(validateResult(await entry.runtime.decode(batch, signal)));
          entry.cursor = BigInt(batch.end);
          if (entry.cursor >= end && !entry.runtime.pendingBefore(end)) break;
        }
        if (entry.cursor === eof) {
          append(validateResult(await entry.runtime.flush(signal)));
          entry.done = true;
        }
        step *= 2n;
      }
      signal.throwIfAborted();
      result.transactions.sort((a, b) =>
        BigInt(a.start) < BigInt(b.start)
          ? -1
          : BigInt(a.start) > BigInt(b.start)
            ? 1
            : 0,
      );
      if (result.truncated) result.overview = overview;
      return structuredClone(result);
    } catch (error) {
      if (entries.get(key) === entry) entries.delete(key);
      entry.runtime.dispose();
      throw error;
    } finally {
      entry.busy = false;
      if (entries.get(key) !== entry) entry.runtime.dispose();
    }
  }
}
