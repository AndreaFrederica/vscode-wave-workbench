// SPDX-License-Identifier: MPL-2.0

export type DecoderEngine = "builtin" | "lua" | "javascript";
export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [name: string]: Json };
export interface DecoderInput {
  id: string;
  width?: number;
  required?: boolean;
}
export interface DecoderManifest {
  apiVersion: 1;
  id: string;
  name: string;
  version: string;
  engine: DecoderEngine;
  entry?: string;
  inputs: DecoderInput[];
  options?: Record<string, Json>;
  capabilities?: { checkpoints?: boolean; virtualSignals?: boolean };
}
export interface DecoderInstance {
  instanceId?: string;
  decoderId: string;
  engine?: DecoderEngine;
  bindings: Record<string, string>;
  options?: Record<string, Json>;
}
export interface DecoderContext {
  scale: string;
  inputs: ({ id: string; width: number } | null)[];
  options: Record<string, Json>;
}
export interface DecoderTransaction {
  start: string;
  end: string;
  label: string;
  kind?: string;
  fields?: Record<string, Json>;
  severity?: "info" | "warning" | "error";
}
export interface DecodeVirtualSample {
  id: string;
  width: number;
  tick: string;
  value: string;
}
export interface DecodeResult {
  virtualSamples?: DecodeVirtualSample[];
  transactions: DecoderTransaction[];
  warnings: string[];
  truncated: boolean;
}
export const eventBatchVersion = 1;

export interface EventBatchHeader {
  version: typeof eventBatchVersion;
  start: string;
  end: string;
  initial: (string | null)[];
  count: number;
  timeEncoding: "u64" | "decimal";
  timeBytes: number;
  valueBytes: number;
}

export interface EventBatch {
  version: typeof eventBatchVersion;
  start: string;
  end: string;
  initial: (string | null)[];
  times: BigUint64Array | Uint8Array;
  inputs: Uint32Array;
  offsets: Uint32Array;
  values: Uint8Array;
}
export interface DecoderRuntime {
  decode(batch: EventBatch, signal: AbortSignal): Promise<DecodeResult>;
  flush(signal: AbortSignal): Promise<DecodeResult>;
  saveState?(signal: AbortSignal): Promise<Json>;
  restoreState?(state: Json, signal: AbortSignal): Promise<void>;
  dispose(): void;
}
export const maxTransactions = 4096;
export const maxBatchEvents = 4096;
export const tickPattern = /^(0|[1-9][0-9]{0,79})$/;
export const idPattern = /^[a-zA-Z0-9][\w.-]{0,63}$/;

export function validateResult(result: unknown): DecodeResult {
  const entry = result as DecodeResult;
  if (
    !entry ||
    !Array.isArray(entry.transactions) ||
    entry.transactions.length > maxTransactions ||
    !Array.isArray(entry.warnings) ||
    entry.warnings.length > 64 ||
    entry.warnings.some((w) => typeof w !== "string" || w.length > 1024) ||
    typeof entry.truncated !== "boolean"
  )
    throw Error("Invalid decoder result.");
  for (const transaction of entry.transactions) {
    if (
      !transaction ||
      typeof transaction.start !== "string" ||
      !tickPattern.test(transaction.start) ||
      typeof transaction.end !== "string" ||
      !tickPattern.test(transaction.end) ||
      BigInt(transaction.start) >= BigInt(transaction.end) ||
      typeof transaction.label !== "string" ||
      transaction.label.length > 1024 ||
      (transaction.kind !== undefined &&
        (typeof transaction.kind !== "string" ||
          transaction.kind.length > 64)) ||
      (transaction.severity !== undefined &&
        !["info", "warning", "error"].includes(transaction.severity)) ||
      (transaction.fields !== undefined &&
        (!transaction.fields ||
          typeof transaction.fields !== "object" ||
          Array.isArray(transaction.fields) ||
          JSON.stringify(transaction.fields).length > 8192))
    )
      throw Error("Invalid decoder transaction.");
  }
  if (entry.virtualSamples !== undefined) {
    if (
      !Array.isArray(entry.virtualSamples) ||
      entry.virtualSamples.length > maxBatchEvents
    )
      throw Error("Too many virtual samples.");
    for (const sample of entry.virtualSamples) {
      if (
        !sample ||
        typeof sample.id !== "string" ||
        !idPattern.test(sample.id) ||
        typeof sample.tick !== "string" ||
        !tickPattern.test(sample.tick) ||
        !Number.isInteger(sample.width) ||
        sample.width < 1 ||
        sample.width > 256 ||
        typeof sample.value !== "string" ||
        sample.value.length !== sample.width ||
        !/^[01xz]+$/.test(sample.value)
      )
        throw Error("Invalid virtual sample.");
    }
  }
  return entry;
}

export function readOptions(options: unknown): Record<string, Json> {
  if (options === undefined) return {};
  if (!options || typeof options !== "object" || Array.isArray(options))
    throw Error("Decoder options must be a JSON object.");
  const encoded = JSON.stringify(options);
  if (encoded.length > 16_384) throw Error("Decoder options exceed 16 KiB.");
  return JSON.parse(encoded);
}

export function readCheckpoint(state: unknown): Json {
  const encoded = JSON.stringify(state);
  if (!encoded || encoded.length > 64 * 1024)
    throw Error("Invalid decoder checkpoint size.");
  return JSON.parse(encoded);
}

export function validDecoderInstances(
  items: unknown,
): items is DecoderInstance[] {
  if (!Array.isArray(items) || items.length > 4) return false;
  const ids = new Set<string>();
  for (const item of items) {
    if (
      !item ||
      typeof item.instanceId !== "string" ||
      !idPattern.test(item.instanceId) ||
      ids.has(item.instanceId) ||
      typeof item.decoderId !== "string" ||
      !idPattern.test(item.decoderId) ||
      !["builtin", "lua", "javascript"].includes(item.engine) ||
      !item.bindings ||
      typeof item.bindings !== "object" ||
      Array.isArray(item.bindings) ||
      Object.entries(item.bindings).length > 64 ||
      Object.entries(item.bindings).some(
        ([name, value]) =>
          !idPattern.test(name) ||
          typeof value !== "string" ||
          !value ||
          value.length > 1024,
      )
    )
      return false;
    try {
      readOptions(item.options);
    } catch {
      return false;
    }
    ids.add(item.instanceId);
  }
  return true;
}
