// SPDX-License-Identifier: MPL-2.0

import { validateUart, type UartFrame, type UartOptions } from "./uart";
import { disassembleRv32 } from "./riscv";
import riscv from "../../decoders/riscv.json";
import tlul from "../../decoders/tlul.json";
import axi from "../../decoders/axi.json";
import uart from "../../decoders/uart.json";
import iic from "../../decoders/iic.json";

export type BuiltinDecoder =
  | "rv32imfc"
  | "rv32-zfinx"
  | "tlul-a"
  | "tlul-d"
  | "axi-resp";
export interface Match {
  mask: string;
  value: string;
}
export interface Rule extends Match {
  label: string;
  branches?: { when: Match[]; label: string }[];
}
export interface DecoderProfile {
  id: string;
  label: string;
  builtin?: BuiltinDecoder;
  width?: number;
  rules?: Rule[];
  uart?: UartOptions;
}
export interface Annotation {
  tags: string[];
  note: string;
}
export interface DecoderGroup {
  id: string;
  label: string;
  filename: string;
  builtin: boolean;
  profiles: DecoderProfile[];
}
export interface DecoderCatalog {
  groups: DecoderGroup[];
  warnings: string[];
}

const files = { riscv, tlul, axi, uart, iic };
export const builtinGroups: DecoderGroup[] = Object.entries(files).map(
  ([id, file]) => ({
    id: "builtin/" + id,
    label: file.label,
    filename: id + ".json",
    builtin: true,
    profiles: file.profiles as DecoderProfile[],
  }),
);
export const builtinProfiles = builtinGroups.flatMap((group) => group.profiles);

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
  const uart = p.uart === undefined ? undefined : validateUart(p.uart);
  if (uart && (p.builtin !== undefined || p.width !== 1))
    throw Error("UART 串行规则须绑定一位信号");
  if (
    uart &&
    (p.rules === undefined || (Array.isArray(p.rules) && !p.rules.length))
  )
    return { id: p.id, label: p.label, width: 1, uart };
  if (p.builtin !== undefined) {
    const engine = builtinProfiles.find((entry) => entry.id === p.builtin);
    if (!engine || (p.width !== undefined && !supportsProfile(engine, p.width)))
      throw Error("无效的内置解码器配置 " + p.id);
    if (engine.rules) {
      return validateProfile({
        ...engine,
        id: p.id,
        label: p.label,
        rules: p.rules ?? engine.rules,
      });
    }
    if (p.rules === undefined || (Array.isArray(p.rules) && !p.rules.length)) {
      return {
        ...engine,
        id: p.id,
        label: p.label,
        ...(p.width !== undefined ? { width: p.width } : {}),
      };
    }
  }
  const width = uart?.dataBits ?? p.width ?? (p.builtin ? 32 : undefined);
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
  function match(entry: Match) {
    if (
      !entry ||
      typeof entry.mask !== "string" ||
      typeof entry.value !== "string" ||
      entry.mask.length > 258 ||
      entry.value.length > 258 ||
      !numeric.test(entry.mask) ||
      !numeric.test(entry.value)
    )
      throw Error("掩码和匹配值须为非负整数");
    const mask = BigInt(entry.mask),
      value = BigInt(entry.value);
    if (mask > max || (value & mask) !== value)
      throw Error("规则的掩码或匹配值超出位宽 " + p.id);
    return { mask: "0x" + mask.toString(16), value: "0x" + value.toString(16) };
  }
  function label(text: string, wordWidth: number) {
    if (typeof text !== "string" || !text.trim() || text.length > 160)
      throw Error("无效的解码文本 " + p.id);
    for (const field of text.matchAll(fieldPattern)) {
      if (Number(field[1]) >= wordWidth || Number(field[2]) > Number(field[1]))
        throw Error("规则的标签字段超出位宽 " + p.id);
    }
    return text;
  }
  const rules = p.rules.map((rule) => {
    const decoded = { ...match(rule), label: label(rule.label, width) };
    if (rule.branches === undefined) return decoded;
    if (!Array.isArray(rule.branches) || rule.branches.length > 32)
      throw Error("每条规则最多 32 个分支");
    const branches = rule.branches.map((branch) => {
      if (
        !branch ||
        !Array.isArray(branch.when) ||
        !branch.when.length ||
        branch.when.length > 16
      )
        throw Error("每个分支须包含 1–16 个条件");
      return {
        when: branch.when.map(match),
        label: label(branch.label, width),
      };
    });
    return { ...decoded, branches };
  });
  return {
    id: p.id,
    label: p.label,
    ...(p.width !== undefined ? { width: p.width } : {}),
    rules,
    ...(p.builtin ? { builtin: p.builtin } : {}),
    ...(uart ? { uart } : {}),
  };
}

export function supportsProfile(profile: DecoderProfile, width: number) {
  return profile.width !== undefined
    ? width === profile.width
    : width === 16 || width === 32;
}

const fieldPattern = /\{(\d{1,3}):(\d{1,3}):(hex|dec|signed|bin)\}/g;
const compileMatch = ({ mask, value }: Match) => ({
  mask: BigInt(mask),
  value: BigInt(value),
});
function compileRule(rule: Rule) {
  return {
    ...compileMatch(rule),
    label: rule.label,
    branches: rule.branches?.map((branch) => ({
      label: branch.label,
      when: branch.when.map(compileMatch),
    })),
  };
}
const compiledRules = new WeakMap<
  DecoderProfile,
  ReturnType<typeof compileRule>[]
>();

export function decodeWord(
  profile: DecoderProfile,
  bits: string | undefined,
  width: number,
): string | undefined {
  if (
    !bits ||
    bits.length > width ||
    !supportsProfile(profile, width) ||
    profile.uart
  )
    return;
  if (
    profile.rules?.length ||
    (profile.builtin && !profile.builtin.startsWith("rv32"))
  ) {
    if (/^[01]+$/.test(bits)) {
      const label = decodeRuleValue(profile, BigInt("0b" + bits));
      if (label !== undefined) return label;
    }
  }
  if (profile.builtin === "rv32imfc" || profile.builtin === "rv32-zfinx") {
    // An FSDB may leave the upper halfword unknown for a compressed instruction.
    const word = bits.endsWith("11") ? bits : bits.slice(-16);
    if (!/^[01]+$/.test(word) || (width === 16 && word.endsWith("11"))) return;
    return disassembleRv32(parseInt(word, 2), profile.builtin === "rv32-zfinx");
  }
}

export function decodeRuleValue(profile: DecoderProfile, word: bigint) {
  let rules = compiledRules.get(profile);
  if (!rules) {
    const sourceRules =
      profile.rules ??
      builtinProfiles.find((entry) => entry.id === profile.builtin)?.rules ??
      [];
    rules = sourceRules.map(compileRule);
    compiledRules.set(profile, rules);
  }
  const matches = ({ mask, value }: ReturnType<typeof compileMatch>) =>
    (word & mask) === value;
  const rule = rules.find(matches);
  if (rule) {
    const branch = rule.branches?.find((entry) => entry.when.every(matches));
    return formatRule(branch?.label ?? rule.label, word);
  }
}

export function uartFrameLabel(profile: DecoderProfile, frame: UartFrame) {
  if (frame.errors.includes("unknown")) return "UART 数据未知";
  const custom = decodeRuleValue(profile, BigInt(frame.word));
  const hex =
    "0x" +
    frame.word
      .toString(16)
      .toUpperCase()
      .padStart(Math.ceil((profile.uart?.dataBits ?? 8) / 4), "0");
  const label = custom ?? hex;
  const errors = frame.errors.map((error) =>
    error === "parity" ? "校验错误" : "停止位错误",
  );
  return errors.length ? label + " · " + errors.join("、") : label;
}

function formatRule(label: string, word: bigint) {
  return label.replace(fieldPattern, (_, msb, lsb, radix) => {
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
