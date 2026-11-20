// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { Signal } from "./protocol";
import {
  normalizeAnnotation,
  supportsProfile,
  validateProfile,
} from "./decoders";
const baseKey = (s: Pick<Signal, "id" | "scope" | "name">) =>
  `${s.scope}\u0000${s.name}\u0000${s.id}`;
const key = (s: Pick<Signal, "id" | "scope" | "name" | "bitOffset">) =>
  baseKey(s) +
  (Number.isInteger(s.bitOffset) ? "\u0000bit:" + s.bitOffset : "");
function label(s: Pick<Signal, "name" | "displayName" | "bitOffset">) {
  if (s.displayName) return s.displayName;
  if (typeof s.bitOffset !== "number" || !Number.isInteger(s.bitOffset))
    return s.name;
  const range = /\[\s*(-?\d+)\s*:\s*(-?\d+)\s*\]$/.exec(s.name);
  let index = s.bitOffset;
  if (range)
    index =
      Number(range[2]) +
      (Number(range[1]) >= Number(range[2]) ? 1 : -1) * s.bitOffset;
  return s.name.replace(/\[\s*-?\d+\s*:\s*-?\d+\s*\]$/, "") + "[" + index + "]";
}
function project(raw: string | undefined, s: Signal) {
  if (
    raw == null ||
    typeof s.bitOffset !== "number" ||
    !Number.isInteger(s.bitOffset)
  )
    return raw;
  if (!/^[01xz]+$/i.test(raw)) return "x";
  const bits = raw
    .toLowerCase()
    .padStart(
      s.sourceWidth ?? s.width,
      /^[xz]/i.test(raw) ? raw[0].toLowerCase() : "0",
    );
  return bits[bits.length - 1 - s.bitOffset] || "x";
}
function bits(s: Signal): Signal[] {
  if (s.real || s.width <= 1 || Number.isInteger(s.bitOffset)) return [];
  return Array.from({ length: s.width }, (_, i) => ({
    ...s,
    width: 1,
    sourceWidth: s.width,
    bitOffset: s.width - 1 - i,
    displayRadix: "bin",
    displayName: undefined,
    parentBus: key(s),
    decoder: undefined,
    annotation: undefined,
  }));
}
function restore(s: Partial<Signal>, canonical: Signal): Signal {
  const bit =
    typeof s.bitOffset === "number" &&
    Number.isSafeInteger(s.bitOffset) &&
    s.bitOffset >= 0 &&
    s.bitOffset < canonical.width;
  if (s.bitOffset !== undefined && (!bit || canonical.real))
    throw Error("Saved bit selection is outside the source Bus");
  const decoder =
    !canonical.real && s.decoder ? validateProfile(s.decoder) : undefined;
  if (decoder && !supportsProfile(decoder, bit ? 1 : canonical.width))
    throw Error("解码配置与信号位宽不符");
  return {
    ...canonical,
    unit:
      canonical.real && typeof s.unit === "string"
        ? s.unit.slice(0, 24)
        : canonical.unit,
    group: typeof s.group === "string" ? s.group : undefined,
    displayName: typeof s.displayName === "string" ? s.displayName : undefined,
    highlight: /^#[0-9a-f]{6}$/i.test(s.highlight || "")
      ? s.highlight
      : undefined,
    notation: s.notation === "verilog" ? "verilog" : undefined,
    decoder,
    annotation:
      s.annotation && normalizeAnnotation(s.annotation.tags, s.annotation.note),
    displayRadix: ["hex", "bin", "oct", "unsigned", "signed"].includes(
      s.displayRadix || "",
    )
      ? s.displayRadix
      : undefined,
    ...(bit
      ? {
          width: 1,
          sourceWidth: canonical.width,
          bitOffset: s.bitOffset,
          parentBus: typeof s.parentBus === "string" ? s.parentBus : undefined,
        }
      : {}),
  };
}

export { baseKey, key, label, project, bits, restore };
