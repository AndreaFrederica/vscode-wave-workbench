// SPDX-License-Identifier: MPL-2.0

import {
  decodeWord,
  uartFrameLabel,
  type DecoderProfile,
} from "../shared/decoders";
import { decodeUart } from "../shared/uart";
import { scriptEvents } from "./event-batch";
import {
  maxTransactions,
  type DecoderContext,
  type DecoderRuntime,
  type DecoderTransaction,
} from "./types";

export function builtinRuntime(
  profile: DecoderProfile,
  context: DecoderContext,
): DecoderRuntime {
  const width = context.inputs[0]!.width;
  let tail: { tick: string; value: string } | undefined;
  let end = "0";
  const uartEvents: [string, string][] = [];
  function label(transactionEnd: string): DecoderTransaction[] {
    const decoded = tail && decodeWord(profile, tail.value, width);
    return tail && decoded !== undefined && tail.tick !== transactionEnd
      ? [{ start: tail.tick, end: transactionEnd, label: decoded }]
      : [];
  }
  return {
    async decode(batch, signal) {
      const transactions: DecoderTransaction[] = [];
      end = batch.end;
      if (!tail && batch.initial[0] !== null) {
        tail = { tick: batch.start, value: batch.initial[0] };
        if (profile.uart) uartEvents.push([tail.tick, tail.value]);
      }
      for (const event of scriptEvents(batch).events()) {
        signal.throwIfAborted();
        if (profile.uart) {
          if (uartEvents.length >= 250_000)
            throw Error("Builtin UART replay event budget exceeded.");
          uartEvents.push([event.tick, event.value]);
        } else transactions.push(...label(event.tick));
        tail = event;
      }
      return { transactions, warnings: [], truncated: false };
    },
    async flush() {
      if (!profile.uart)
        return { transactions: label(end), warnings: [], truncated: false };
      if (!Number.isSafeInteger(Number(end)))
        throw Error("Builtin UART requires a safe integer tick range.");
      const frames = decodeUart(
        profile.uart,
        context.scale,
        uartEvents,
        Number(end),
      );
      return {
        transactions: frames.slice(0, maxTransactions).map((frame) => ({
          start: String(Math.floor(frame.start)),
          end: String(Math.ceil(frame.end)),
          label: uartFrameLabel(profile, frame),
          fields: { value: frame.word, errors: frame.errors },
          ...(frame.errors.length ? { severity: "warning" as const } : {}),
        })),
        warnings: [],
        truncated: frames.length > maxTransactions,
      };
    },
    dispose() {},
  };
}
