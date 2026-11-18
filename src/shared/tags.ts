// SPDX-License-Identifier: MPL-2.0

export type TagStyle = "pill" | "dot" | "text";
export type TagColors = Record<string, string>;

export function tagStyle(value: unknown): TagStyle {
  return value === "dot" || value === "text" ? value : "pill";
}

export function isTagColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
}

export function normalizeTagColors(value: unknown): TagColors {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      ([name, color]) =>
        name.length > 0 && name.length <= 48 && isTagColor(color),
    ),
  );
}
