// SPDX-License-Identifier: MPL-2.0

import { disassembleRv32 } from "./riscv";

export type BuiltinDecoder =
  | "rv32imfc"
  | "rv32-zfinx"
  | "tlul-a"
  | "tlul-d"
  | "axi-resp";
export interface Rule {
  mask: string;
  value: string;
  label: string;
}
export interface DecoderProfile {
  id: string;
  label: string;
  builtin?: BuiltinDecoder;
  width?: number;
  rules?: Rule[];
}
export interface Annotation {
  tags: string[];
  note: string;
}

export const builtinProfiles: DecoderProfile[] = [
  { id: "rv32imfc", label: "RISC-V RV32IMFC", builtin: "rv32imfc" },
  {
    id: "rv32-zfinx",
    label: "RISC-V RV32IMC + Zfinx · CV32",
    builtin: "rv32-zfinx",
  },
  { id: "tlul-a", label: "TL-UL A opcode", builtin: "tlul-a", width: 3 },
  { id: "tlul-d", label: "TL-UL D opcode", builtin: "tlul-d", width: 3 },
  { id: "axi-resp", label: "AXI BRESP / RRESP", builtin: "axi-resp", width: 2 },
];

const numeric = /^(0[xX][0-9a-fA-F]+|0[bB][01]+|[0-9]+)$/;
export function validateProfile(value: unknown): DecoderProfile {
  const p = value as DecoderProfile;
  if (
    !p ||
    !/^[a-zA-Z0-9][\w.-]{0,63}$/.test(p.id) ||
    typeof p.id !== "string" ||
    typeof p.label !== "string" ||
    !p.label.trim() ||
    p.label.length > 120
  )
    throw Error("解码配置需要有效的 id 和 label");
  if (p.builtin !== undefined) {
    const engine = builtinProfiles.find((entry) => entry.builtin === p.builtin);
    if (!engine || p.rules !== undefined)
      throw Error("无效的内置解码器配置 " + p.id);
    return { ...engine, id: p.id, label: p.label };
  }
  const width = p.width;
  if (
    width === undefined ||
    !Number.isInteger(width) ||
    width < 2 ||
    width > 256 ||
    !Array.isArray(p.rules) ||
    p.rules.length < 1 ||
    p.rules.length > 256
  )
    throw Error("自定义配置需要 2–256 位宽和 1–256 条规则 " + p.id);
  const max = (1n << BigInt(width)) - 1n;
  const rules = p.rules.map((rule) => {
    if (
      !rule ||
      typeof rule.mask !== "string" ||
      rule.mask.length > 258 ||
      !numeric.test(rule.mask) ||
      typeof rule.value !== "string" ||
      rule.value.length > 258 ||
      !numeric.test(rule.value) ||
      typeof rule.label !== "string" ||
      !rule.label.trim() ||
      rule.label.length > 160
    )
      throw Error("无效的解码规则 " + p.id);
    const mask = BigInt(rule.mask),
      expected = BigInt(rule.value);
    if (mask > max || (expected & mask) !== expected)
      throw Error("规则的掩码或匹配值超出位宽 " + p.id);
    for (const field of rule.label.matchAll(fieldPattern)) {
      if (Number(field[1]) >= width || Number(field[2]) > Number(field[1]))
        throw Error("规则的标签字段超出位宽 " + p.id);
    }
    return {
      mask: "0x" + mask.toString(16),
      value: "0x" + expected.toString(16),
      label: rule.label,
    };
  });
  return { id: p.id, label: p.label, width, rules };
}

export function supportsProfile(profile: DecoderProfile, width: number) {
  return profile.width !== undefined
    ? width === profile.width
    : width === 16 || width === 32;
}

const fieldPattern = /\{(\d{1,3}):(\d{1,3}):(hex|dec|signed|bin)\}/g;
const compiledRules = new WeakMap<
  DecoderProfile,
  { mask: bigint; value: bigint; label: string }[]
>();

export function decodeWord(
  profile: DecoderProfile,
  bits: string | undefined,
  width: number,
): string | undefined {
  if (!bits || bits.length > width || !supportsProfile(profile, width)) return;
  if (profile.builtin === "rv32imfc" || profile.builtin === "rv32-zfinx") {
    // An FSDB may leave the upper halfword unknown for a compressed instruction.
    const word = bits.endsWith("11") ? bits : bits.slice(-16);
    if (!/^[01]+$/.test(word) || (width === 16 && word.endsWith("11"))) return;
    return disassembleRv32(parseInt(word, 2), profile.builtin === "rv32-zfinx");
  }
  if (!/^[01]+$/.test(bits)) return;
  const word = BigInt("0b" + bits);
  if (profile.builtin === "tlul-a")
    return ["PutFullData", "PutPartialData", , , "Get"][Number(word)];
  if (profile.builtin === "tlul-d")
    return ["AccessAck", "AccessAckData"][Number(word)];
  if (profile.builtin === "axi-resp")
    return ["OKAY", "EXOKAY", "SLVERR", "DECERR"][Number(word)];
  let rules = compiledRules.get(profile);
  if (!rules) {
    rules = (profile.rules || []).map((rule) => ({
      ...rule,
      mask: BigInt(rule.mask),
      value: BigInt(rule.value),
    }));
    compiledRules.set(profile, rules);
  }
  const match = rules.find((rule) => (word & rule.mask) === rule.value);
  return match?.label.replace(fieldPattern, (_, msb, lsb, radix) => {
    const low = BigInt(lsb),
      count = BigInt(msb) - low + 1n;
    const value = (word >> low) & ((1n << count) - 1n);
    if (radix === "hex") return "0x" + value.toString(16);
    if (radix === "bin") return value.toString(2).padStart(Number(count), "0");
    if (radix === "signed")
      return BigInt.asIntN(Number(count), value).toString();
    return value.toString();
  });
}

export function normalizeAnnotation(
  tags: string[],
  note: string,
): Annotation | undefined {
  const clean = [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))];
  const text = note.trim();
  if (
    clean.length > 24 ||
    clean.some((tag) => tag.length > 48) ||
    text.length > 4000
  )
    throw Error("每条信号最多 24 个标签，每个 48 字符，注释最多 4000 字符");
  return clean.length || text ? { tags: clean, note: text } : undefined;
}
