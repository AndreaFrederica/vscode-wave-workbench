// SPDX-License-Identifier: MPL-2.0

import { scriptEvents } from "./event-batch";
import type {
  DecoderManifest,
  ProtocolRuntime,
  DecoderTransaction,
} from "./types";

// OpenTitan's RV32 packed tl_h2d_t and tl_d2h_t, in declaration order.
// Earlgrey and Darjeeling differ in a_user width, below a_data.
export const tlulManifest: DecoderManifest = {
  apiVersion: 1,
  id: "opentitan.tlul",
  version: "2",
  engine: "builtin",
  name: "OpenTitan TL-UL (packed RV32)",
  inputs: [
    { id: "clk", width: 1 },
    { id: "rst_n", width: 1 },
    { id: "h2d" },
    { id: "d2h", width: 66 },
  ],
};

function numberField(bits: string) {
  return /^[01]+$/.test(bits) ? parseInt(bits, 2) : "0b" + bits;
}

export function tlulRuntime(h2dWidth: number): ProtocolRuntime {
  if (![109, 114].includes(h2dWidth))
    throw Error("OpenTitan TL-UL requires a 109- or 114-bit h2d signal.");
  const pending = new Map<
    number,
    { item: DecoderTransaction; cycle: number }
  >();
  let cycle = 0,
    waitCycles = 0,
    waitStart = "",
    end = "0";
  let values: (string | null)[] | undefined;

  function interrupt(tick: string, reason: string) {
    const items: DecoderTransaction[] = [];
    for (const { item } of pending.values()) {
      item.end = BigInt(tick) >= BigInt(item.end) ? tick : item.end;
      item.fields!.status = reason;
      item.severity = "warning";
      items.push(item);
    }
    pending.clear();
    waitCycles = 0;
    return items;
  }

  function sample(
    tick: string,
    h: string,
    d: string,
    items: DecoderTransaction[],
  ) {
    cycle++;
    const accept = h[0] === "1" && d.at(-1) === "1";
    const respond = d[0] === "1" && h.at(-1) === "1";
    const aSource = numberField(h.slice(9, 17)),
      dSource = numberField(d.slice(9, 17));
    const finish = String(BigInt(tick) + 1n);
    const close = () => {
      const open =
        typeof dSource === "number" ? pending.get(dSource) : undefined;
      const item: DecoderTransaction = open?.item ?? {
        start: tick,
        end: finish,
        label: "Unmatched D",
        severity: "warning",
        fields: { source: dSource, status: "unmatched" },
        points: [],
      };
      item.end = finish;
      const opcode = numberField(d.slice(1, 4));
      const response =
        opcode === 0
          ? "AccessAck"
          : opcode === 1
            ? "AccessAckData"
            : "opcode " + opcode;
      item.points!.push({ channel: "D", label: "UL D · " + response, tick });
      const error = numberField(d.slice(-2, -1));
      Object.assign(item.fields!, {
        d_opcode: opcode,
        d_data: numberField(d.slice(18, 50)),
        d_error: error,
      });
      if (open) {
        item.fields!.latency_cycles = cycle - open.cycle;
        pending.delete(dSource as number);
      }
      if (error === 1) item.severity = "error";
      items.push(item);
    };
    // A simultaneous response retires the previous request before source reuse.
    const retireFirst =
      respond && typeof dSource === "number" && pending.has(dSource);
    if (retireFirst) close();
    if (accept) {
      const op = numberField(h.slice(1, 4));
      const label =
        (
          { 0: "PutFullData", 1: "PutPartialData", 4: "Get" } as Record<
            string,
            string
          >
        )[op] ?? "A opcode " + op;
      const item: DecoderTransaction = {
        start: waitCycles ? waitStart : tick,
        end: finish,
        label,
        fields: {
          source: aSource,
          address: numberField(h.slice(17, 49)),
          mask: numberField(h.slice(49, 53)),
          a_data: numberField(h.slice(53, 85)),
          wait_cycles: waitCycles,
        },
        points: [
          ...(waitCycles
            ? [{ channel: "A", label: "Wait", tick: waitStart }]
            : []),
          { channel: "A", label: "UL A · " + label, tick },
        ],
      };
      if (typeof aSource === "number" && !pending.has(aSource))
        pending.set(aSource, { item, cycle });
      else {
        item.severity = "warning";
        item.fields!.status = "unknown or busy source";
        items.push(item);
      }
    }
    if (respond && !retireFirst) close();
    if (h[0] === "1" && d.at(-1) === "0") {
      if (!waitCycles) waitStart = tick;
      waitCycles++;
    } else waitCycles = 0;
  }

  return {
    pendingBefore(limit) {
      if (waitCycles && BigInt(waitStart) < limit) return true;
      for (const { item } of pending.values())
        if (BigInt(item.start) < limit) return true;
      return false;
    },
    async decode(batch, signal) {
      values ??= batch.initial.slice();
      const items: DecoderTransaction[] = [];
      // Event batches sort equal ticks by input. Clock is input zero, so
      // sampling sees bus values before any same-tick sequential updates.
      for (const { input, tick, value } of scriptEvents(batch).events()) {
        signal.throwIfAborted();
        if (
          input === 0 &&
          values[0] === "0" &&
          value === "1" &&
          values[1] === "1" &&
          values[2] &&
          values[3]
        )
          sample(tick, values[2], values[3], items);
        if (input === 1 && value !== "1")
          items.push(...interrupt(tick, "reset"));
        values[input] = value;
      }
      end = batch.end;
      return { transactions: items, warnings: [], truncated: false };
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
