// SPDX-License-Identifier: MPL-2.0
import { coralHandshake } from "./coral-uh";
import { scriptEvents } from "./event-batch";
import type {
  DecoderManifest,
  DecoderTransaction,
  ProtocolRuntime,
  TransactionPoint,
} from "./types";

export const uhManifest: DecoderManifest = {
  apiVersion: 1,
  version: "1",
  engine: "builtin",
  id: "opentitan.tluh",
  name: "OpenTitan TL-UH (A/D)",
  inputs: [
    { id: "clk", width: 1 },
    { id: "rst_n", width: 1 },
    { id: "tla" },
    { id: "tlavalid", width: 1 },
    { id: "tlaready", width: 1 },
    { id: "tld" },
    { id: "tldvalid", width: 1 },
    { id: "tldready", width: 1 },
  ],
};

export function uhRuntime(aWidth: number, dWidth: number): ProtocolRuntime {
  const width =
    aWidth === 87 && dWidth === 53
      ? 32
      : aWidth === 195 && dWidth === 149
        ? 128
        : 0;
  if (!width)
    throw Error(
      "TL-UH requires 32-bit or 128-bit Muntjac A/D bundles (32-bit address, 8-bit source, 1-bit sink).",
    );
  const pending = new Map<
    number,
    { item: DecoderTransaction; a: number; d: number }
  >();
  let values: (string | null)[] | undefined,
    end = "0";
  function interrupt(tick: string, status: string) {
    const result = [...pending.values()].map(({ item }) => {
      item.fields!.status = status;
      item.severity ??= "warning";
      item.end = tick;
      return item;
    });
    pending.clear();
    return result;
  }
  function sample(
    ch: "tla" | "tld",
    tick: string,
    items: DecoderTransaction[],
  ) {
    const point = coralHandshake(
      ch,
      tick,
      values![ch === "tla" ? 2 : 5],
      width,
    );
    const { opcode, size, source } = point.fields!;
    const finish = String(BigInt(tick) + 1n);
    const open = typeof source === "number" ? pending.get(source) : undefined;
    function orphan(label: string) {
      items.push({
        start: tick,
        end: finish,
        label,
        fields: point.fields,
        points: [point],
        severity: "warning",
      });
    }
    if (
      typeof source !== "number" ||
      typeof opcode !== "number" ||
      typeof size !== "number"
    )
      return orphan("Unknown UH handshake");
    const numBeats = Math.max(1, 2 ** size / (width / 8));
    function append(item: DecoderTransaction, p: TransactionPoint) {
      if (item.points!.length < 258) item.points!.push(p);
      else item.fields!.points_truncated = true;
      item.end = finish;
    }
    if (ch === "tla") {
      if (open && !open.a) return orphan("UH source already in use");
      const kind = point.label.replace("UH A · ", "");
      const entry = open ?? {
        item: {
          start: tick,
          end: finish,
          label: kind,
          kind,
          points: [],
          fields: { ...point.fields, a_beats: 0, d_beats: 0 },
        },
        a: opcode <= 3 ? numBeats : 1,
        d: 0,
      };
      append(entry.item, point);
      entry.item.fields!.a_beats = Number(entry.item.fields!.a_beats) + 1;
      entry.a--;
      pending.set(source, entry);
    } else {
      if (!open || open.a) return orphan("Unmatched UH D");
      append(open.item, point);
      open.d++;
      open.item.fields!.d_beats = open.d;
      if (point.fields!.denied === 1 || point.fields!.corrupt === 1)
        open.item.severity = "error";
      if (open.d >= (opcode === 1 || opcode === 5 ? numBeats : 1)) {
        items.push(open.item);
        pending.delete(source);
      }
    }
  }
  return {
    pendingBefore(limit) {
      return [...pending.values()].some((p) => BigInt(p.item.start) < limit);
    },
    async decode(batch, signal) {
      const transactions: DecoderTransaction[] = [];
      values ??= batch.initial.slice();
      for (const { input, tick, value } of scriptEvents(batch).events()) {
        signal.throwIfAborted();
        if (
          input === 0 &&
          value === "1" &&
          values[0] === "0" &&
          values[1] === "1"
        ) {
          const a = values[3] === "1" && values[4] === "1",
            d = values[6] === "1" && values[7] === "1";
          // Retire a previously issued request before permitting same-edge source reuse.
          const dSource = d
            ? coralHandshake("tld", tick, values[5], width).fields!.source
            : null;
          const prior =
            typeof dSource === "number" ? pending.get(dSource) : undefined;
          const retireFirst = !!prior && !prior.a;
          if (d && retireFirst) sample("tld", tick, transactions);
          if (a) sample("tla", tick, transactions);
          if (d && !retireFirst) sample("tld", tick, transactions);
        }
        if (input === 1 && value !== "1")
          transactions.push(...interrupt(tick, "reset"));
        values[input] = value;
      }
      end = batch.end;
      return { transactions, warnings: [], truncated: false };
    },
    async flush() {
      return {
        transactions: interrupt(end, "incomplete"),
        warnings: [],
        truncated: false,
      };
    },
    dispose() {
      pending.clear();
    },
  };
}
