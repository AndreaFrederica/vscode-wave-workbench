// SPDX-License-Identifier: MPL-2.0

import type { Json, TransactionPoint } from "./types";

// The CoralNPU bridge's 128-bit Muntjac TL_A_STRUCT / TL_D_STRUCT.
// List fields MSB first, including fields between the ones shown in the UI.
const layout = {
  tla: [
    ["opcode", 3],
    ["param", 3],
    ["size", 4],
    ["source", 8],
    ["address", 32],
    ["mask", 16],
    ["corrupt", 1],
    ["data", 128],
  ],
  tld: [
    ["opcode", 3],
    ["param", 3],
    ["size", 4],
    ["source", 8],
    ["sink", 1],
    ["denied", 1],
    ["corrupt", 1],
    ["data", 128],
  ],
} as const;
const opcodes = {
  tla: [
    "PutFullData",
    "PutPartialData",
    "ArithmeticData",
    "LogicalData",
    "Get",
    "Hint",
    "AcquireBlock",
    "AcquirePerm",
  ],
  tld: [
    "AccessAck",
    "AccessAckData",
    "HintAck",
    "Reserved",
    "Grant",
    "GrantData",
    "ReleaseAck",
    "Reserved",
  ],
};

export function coralHandshake(
  channel: keyof typeof layout,
  tick: string,
  raw: string | null,
  dataWidth = 128,
): TransactionPoint {
  const fields: Record<string, Json> = {};
  const fieldsLayout: readonly (readonly [string, number])[] = layout[channel];
  const schema = fieldsLayout.map(
    ([name, size]) =>
      [
        name,
        name === "data" ? dataWidth : name === "mask" ? dataWidth / 8 : size,
      ] as const,
  );
  const width = schema.reduce((sum, field) => sum + field[1], 0);
  const bits = (raw ?? "x").padStart(
    width,
    /^[xz]/i.test(raw ?? "x") ? (raw ?? "x")[0] : "0",
  );
  let offset = 0;
  for (const [name, size] of schema) {
    const value = bits.slice(offset, offset + size);
    offset += size;
    if (!/^[01]+$/.test(value)) fields[name] = "0b" + value;
    else {
      const number = BigInt("0b" + value);
      fields[name] =
        number <= BigInt(Number.MAX_SAFE_INTEGER)
          ? Number(number)
          : "0x" + number.toString(16);
    }
  }
  const opcode =
    typeof fields.opcode === "number" ? opcodes[channel][fields.opcode] : "?";
  return {
    channel,
    tick,
    label: (channel === "tla" ? "UH A · " : "UH D · ") + opcode,
    fields,
  };
}
