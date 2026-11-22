// SPDX-License-Identifier: MPL-2.0
import type { DecoderTransaction, Json } from "../decoder-runtime/types";

export function transactionFilter(query: string) {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matchValue = (value: Json | undefined, expected: string) => {
    if (value === undefined) return false;
    if (String(value).toLowerCase() === expected) return true;
    if (
      ((typeof value === "number" && Number.isSafeInteger(value)) ||
        (typeof value === "string" && /^0x[0-9a-f]+$/i.test(value))) &&
      /^(0x[0-9a-f]+|\d+)$/i.test(expected)
    )
      return BigInt(value) === BigInt(expected);
    return false;
  };
  return (item: DecoderTransaction) =>
    terms.every((term) => {
      const equals = term.indexOf("=");
      if (equals < 0) return item.label.toLowerCase().includes(term);
      const field = term.slice(0, equals),
        expected = term.slice(equals + 1);
      if (field === "severity")
        return matchValue(item.severity ?? "info", expected);
      if (field === "kind")
        return matchValue(item.kind ?? item.label, expected);
      const dot = field.indexOf(".");
      if (dot < 0)
        return Object.entries(item.fields ?? {}).some(
          ([k, v]) => k.toLowerCase() === field && matchValue(v, expected),
        );
      return item.points?.some(
        (p) =>
          (p.channel ?? p.label).toLowerCase() === field.slice(0, dot) &&
          Object.entries(p.fields ?? {}).some(
            ([k, v]) =>
              k.toLowerCase() === field.slice(dot + 1) &&
              matchValue(v, expected),
          ),
      );
    });
}
