// SPDX-License-Identifier: MPL-2.0

import { coralBridgeId } from "../shared/axi-decoder";
import { coralHandshake } from "./coral-uh";
import { scriptEvents } from "./event-batch";
import type {
  DecoderContext,
  DecoderManifest,
  DecoderTransaction,
  Json,
  ProtocolRuntime,
  TransactionPoint,
} from "./types";

const channels = ["aw", "w", "b", "ar", "r"] as const;
type Channel = (typeof channels)[number];
const addressPins = [
  "id",
  "addr",
  "len",
  "size",
  "burst",
  "prot",
  "cache",
  "qos",
  "lock",
  "region",
  "user",
];
const pins: Record<Channel, string[]> = {
  aw: addressPins,
  w: ["data", "strb", "last", "user"],
  b: ["id", "resp", "user"],
  ar: addressPins,
  r: ["id", "data", "resp", "last", "user"],
};
const widths: Record<string, number> = {
  valid: 1,
  ready: 1,
  last: 1,
  len: 8,
  size: 3,
  burst: 2,
  resp: 2,
  prot: 3,
  cache: 4,
  qos: 4,
  lock: 1,
  region: 4,
};
export const axiManifest: DecoderManifest = {
  apiVersion: 1,
  id: "amba.axi4",
  name: "AXI4 memory-mapped",
  version: "1",
  engine: "builtin",
  inputs: [
    { id: "aclk", width: 1 },
    { id: "aresetn", width: 1 },
    ...channels.flatMap((ch) =>
      ["valid", "ready", ...pins[ch]].map((pin) => ({
        id: ch + pin,
        width: widths[pin],
        required: ![
          "data",
          "strb",
          "size",
          "burst",
          "prot",
          "cache",
          "qos",
          "lock",
          "region",
          "user",
        ].includes(pin),
      })),
    ),
  ],
};

export const coralBridgeManifest: DecoderManifest = {
  ...axiManifest,
  id: coralBridgeId,
  name: "CoralNPU AXI4 ↔ TL-UH (128-bit)",
  inputs: [
    ...axiManifest.inputs.map((pin) =>
      ["awaddr", "araddr"].includes(pin.id)
        ? { ...pin, required: true, width: 32 }
        : pin,
    ),
    ...["tla", "tld"].flatMap((id) => [
      { id, width: id === "tla" ? 195 : 149 },
      { id: id + "valid", width: 1 },
      { id: id + "ready", width: 1 },
    ]),
  ],
};
type Fields = Record<string, Json>;
type Burst = {
  item: DecoderTransaction;
  fields: Fields;
  points: TransactionPoint[];
  firstCycle: number;
  beats: number;
};
type Address = { key: string; burst: Burst };
const responses = ["OKAY", "EXOKAY", "SLVERR", "DECERR"];
function beatAddresses(b: Burst) {
  const { address, size, burst, expected_beats: count } = b.fields;
  if (
    typeof size !== "number" ||
    typeof burst !== "number" ||
    burst > 2 ||
    (typeof address !== "number" &&
      !(typeof address === "string" && /^0x[0-9a-f]+$/i.test(address)))
  )
    return;
  if (
    burst === 2 &&
    (typeof count !== "number" || ![2, 4, 8, 16].includes(count))
  )
    return;
  const base = BigInt(address),
    bytes = 1n << BigInt(size),
    aligned = base - (base % bytes);
  const span = bytes * BigInt(typeof count === "number" ? count : 1);
  let i = 0n;
  for (const point of b.points) {
    if (point.channel !== "w" && point.channel !== "r") continue;
    let addr = base;
    if (i && burst === 1) addr = aligned + i * bytes;
    if (i && burst === 2)
      addr = base - (base % span) + (((base % span) + i * bytes) % span);
    point.fields!.address =
      addr <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(addr)
        : "0x" + addr.toString(16);
    i++;
  }
}
export function axiRuntime(
  context: DecoderContext,
  manifest = axiManifest,
): ProtocolRuntime {
  const widthsByPin = new Map(
    context.inputs.flatMap((pin) =>
      pin ? [[pin.id, pin.width] as const] : [],
    ),
  );
  for (const [request, response] of [
    ["arid", "rid"],
    ["awid", "bid"],
  ]) {
    if (widthsByPin.get(request) !== widthsByPin.get(response))
      throw Error("AXI4 ID width mismatch: " + request + " / " + response);
  }
  const bridge = manifest.id === coralBridgeId;
  let uhOwner: Burst | undefined;
  const names = manifest.inputs.map((pin) => pin.id);
  const values: Record<string, string | null> = Object.create(null);
  const reads = new Map<string, Burst[]>(),
    responsesDue = new Map<string, Burst[]>();
  const addresses: Address[] = [],
    dataBursts: Burst[] = [];
  let dataInProgress: Burst | undefined,
    cycle = 0,
    end = "0",
    initialized = false;
  const live = new Set<Burst>();
  const stalls = new Map<Channel, number>();
  function make(label: string, tick: string): Burst {
    if (live.size >= 4096) throw Error("AXI4 has over 4096 outstanding bursts");
    const points: TransactionPoint[] = [],
      fields: Fields = {};
    const burst: Burst = {
      item: {
        start: tick,
        end: String(BigInt(tick) + 1n),
        kind: label,
        label,
        fields,
        points,
      },
      points,
      fields,
      firstCycle: cycle,
      beats: 0,
    };
    live.add(burst);
    return burst;
  }
  function value(name: string): Json {
    const bits = values[name];
    if (!bits) return null;
    if (!/^[01]+$/.test(bits)) return "0b" + bits;
    const n = BigInt("0b" + bits);
    return n <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(n)
      : "0x" + n.toString(16);
  }
  function record(ch: Channel, tick: string, label: string): TransactionPoint {
    const fields: Fields = {};
    for (const pin of pins[ch]) {
      const v = value(ch + pin);
      if (v !== null) fields[pin] = v;
    }
    if (typeof fields.resp === "number") fields.resp = responses[fields.resp];
    fields.wait_cycles = stalls.get(ch) ?? 0;
    return { channel: ch, label, tick, fields };
  }
  function flag(b: Burst, message: string) {
    b.fields.status = message;
    b.item.severity = "error";
  }
  function close(b: Burst, tick: string, out: DecoderTransaction[]) {
    live.delete(b);
    if (uhOwner === b) uhOwner = undefined;
    if (
      bridge &&
      (b.item.kind === "Read" || b.item.kind === "Write") &&
      !b.points.some((p) => p.channel === "tld")
    ) {
      b.fields.uh_status = "Incomplete bridge handshakes";
      b.item.severity ??= "warning";
    }
    beatAddresses(b);
    b.item.end = String(BigInt(tick) + 1n);
    b.fields.beats = b.beats;
    b.fields.latency_cycles = cycle - b.firstCycle;
    out.push(b.item);
  }
  function enqueue(queue: Map<string, Burst[]>, key: string, b: Burst) {
    const q = queue.get(key);
    if (q) q.push(b);
    else queue.set(key, [b]);
  }
  function pop(queue: Map<string, Burst[]>, key: string) {
    const q = queue.get(key),
      b = q?.shift();
    if (!q?.length) queue.delete(key);
    return b;
  }
  function key(ch: Channel, tick: string) {
    const id = values[ch + "id"];
    // An unknown ID cannot be correlated to any other handshake.
    return id && /^[01]+$/.test(id)
      ? BigInt("0b" + id).toString()
      : ch + "?" + tick;
  }
  function address(ch: "ar" | "aw", tick: string) {
    const b = make(ch === "ar" ? "Read" : "Write", tick);
    const p = record(ch, tick, ch.toUpperCase());
    b.points.push(p);
    Object.assign(b.fields, p.fields);
    b.fields.address = b.fields.addr;
    delete b.fields.addr;
    b.fields.expected_beats =
      typeof b.fields.len === "number" ? b.fields.len + 1 : null;
    const id = key(ch, tick);
    if (ch === "ar") enqueue(reads, id, b);
    else addresses.push({ key: id, burst: b });
  }
  function checkLength(b: Burst) {
    if (
      typeof b.fields.expected_beats === "number" &&
      b.beats !== b.fields.expected_beats
    )
      flag(b, "LAST / LEN mismatch");
  }
  function beat(b: Burst, ch: "r" | "w", tick: string) {
    b.beats++;
    const point = record(
      ch,
      tick,
      ch.toUpperCase() + "[" + String(b.beats - 1) + "]",
    );
    if (b.beats <= 256) b.points.push(point);
    else flag(b, "Burst exceeds 256 beats");
    if (point.fields?.resp === "SLVERR" || point.fields?.resp === "DECERR") {
      b.item.severity = "error";
      b.fields.response = point.fields.resp;
    }
  }
  function joinWrites() {
    while (addresses.length && dataBursts.length) {
      const { key, burst } = addresses.shift()!,
        data = dataBursts.shift()!;
      live.delete(data);
      if (BigInt(data.item.start) < BigInt(burst.item.start))
        burst.item.start = data.item.start;
      burst.firstCycle = Math.min(burst.firstCycle, data.firstCycle);
      burst.points.push(...data.points);
      burst.points.sort((a, b) =>
        BigInt(a.tick) < BigInt(b.tick)
          ? -1
          : BigInt(a.tick) > BigInt(b.tick)
            ? 1
            : 0,
      );
      burst.beats = data.beats;
      if (data.item.severity) flag(burst, String(data.fields.status));
      checkLength(burst);
      enqueue(responsesDue, key, burst);
    }
  }
  function orphan(ch: Channel, tick: string, out: DecoderTransaction[]) {
    const b = make("Unmatched " + ch.toUpperCase(), tick);
    const p = record(ch, tick, ch.toUpperCase());
    b.points.push(p);
    Object.assign(b.fields, p.fields);
    flag(b, "No matching request");
    close(b, tick, out);
  }
  function sampleBridge(tick: string, out: DecoderTransaction[]) {
    for (const channel of ["tla", "tld"] as const) {
      if (
        values[channel + "valid"] !== "1" ||
        values[channel + "ready"] !== "1"
      )
        continue;
      const point = coralHandshake(channel, tick, values[channel]);
      const fields = point.fields!;
      let owner: Burst | undefined;
      if (channel === "tla") {
        const kind =
          fields.opcode === 4
            ? "Read"
            : [0, 1].includes(Number(fields.opcode))
              ? "Write"
              : undefined;
        // This bridge serializes requests, and translates all AXI IDs to source zero.
        const candidates = [...live].filter(
          (b) =>
            b.item.kind === kind &&
            b.fields.address === fields.address &&
            typeof fields.address === "number" &&
            !b.points.some((p) => p.channel === "tla") &&
            (kind === "Read" || b.beats === 1),
        );
        if (!uhOwner && fields.source === 0 && candidates.length === 1)
          owner = candidates[0];
        uhOwner = owner;
      } else {
        if (
          uhOwner &&
          fields.source === 0 &&
          fields.opcode === (uhOwner.item.kind === "Read" ? 1 : 0)
        )
          owner = uhOwner;
        uhOwner = undefined;
      }
      if (owner) {
        owner.points.push(point);
        if (fields.denied === 1 || fields.corrupt === 1)
          owner.item.severity = "error";
      } else {
        out.push({
          start: tick,
          end: String(BigInt(tick) + 1n),
          kind: "Unmatched UH",
          label: point.label,
          fields,
          points: [point],
          severity: "warning",
        });
      }
    }
  }
  function sample(tick: string, out: DecoderTransaction[]) {
    cycle++;
    const accepted = (ch: Channel) =>
      values[ch + "valid"] === "1" && values[ch + "ready"] === "1";
    if (bridge) sampleBridge(tick, out);
    // Responses refer to requests accepted on earlier edges.
    if (accepted("b")) {
      const b = pop(responsesDue, key("b", tick));
      if (!b) orphan("b", tick, out);
      else {
        const p = record("b", tick, "B");
        b.points.push(p);
        b.fields.response = p.fields!.resp;
        if (["SLVERR", "DECERR"].includes(String(b.fields.response)))
          b.item.severity = "error";
        close(b, tick, out);
      }
    }
    if (accepted("r")) {
      const id = key("r", tick),
        b = reads.get(id)?.[0];
      if (!b) orphan("r", tick, out);
      else {
        beat(b, "r", tick);
        if (values.rlast === "1") {
          pop(reads, id);
          checkLength(b);
          b.fields.response ??= b.points.at(-1)!.fields!.resp;
          close(b, tick, out);
        }
      }
    }
    if (accepted("ar")) address("ar", tick);
    if (accepted("aw")) address("aw", tick);
    if (accepted("w")) {
      dataInProgress ??= make("Write data", tick);
      beat(dataInProgress, "w", tick);
      if (values.wlast === "1") {
        dataBursts.push(dataInProgress);
        dataInProgress = undefined;
      }
    }
    joinWrites();
    for (const ch of channels)
      stalls.set(
        ch,
        values[ch + "valid"] === "1" && values[ch + "ready"] === "0"
          ? (stalls.get(ch) ?? 0) + 1
          : 0,
      );
  }
  function drain(tick: string, reason: string, out: DecoderTransaction[]) {
    // Pair the currently open W burst with its AW for an interrupted write.
    if (dataInProgress) {
      dataBursts.push(dataInProgress);
      dataInProgress = undefined;
      joinWrites();
    }
    for (const b of live) {
      b.fields.status = reason;
      b.item.severity ??= "warning";
      close(b, tick, out);
    }
    addresses.length = dataBursts.length = 0;
    reads.clear();
    responsesDue.clear();
    stalls.clear();
  }
  return {
    pendingBefore(limit) {
      for (const b of live) if (BigInt(b.item.start) < limit) return true;
      return false;
    },
    async decode(batch, signal) {
      const out: DecoderTransaction[] = [];
      if (!initialized) {
        names.forEach((name, i) => (values[name] = batch.initial[i]));
        initialized = true;
      }
      for (const { input, value: bits, tick } of scriptEvents(batch).events()) {
        signal.throwIfAborted();
        if (
          input === 0 &&
          values.aclk === "0" &&
          bits === "1" &&
          values.aresetn === "1"
        )
          sample(tick, out);
        if (input === 1 && bits !== "1") drain(tick, "reset", out);
        values[names[input]] = bits;
      }
      end = batch.end;
      return { transactions: out, warnings: [], truncated: false };
    },
    async flush() {
      const out: DecoderTransaction[] = [];
      drain(String(BigInt(end) - 1n), "incomplete", out);
      return { transactions: out, warnings: [], truncated: false };
    },
    dispose() {
      live.clear();
      reads.clear();
      responsesDue.clear();
      addresses.length = dataBursts.length = 0;
      dataInProgress = undefined;
    },
  };
}
