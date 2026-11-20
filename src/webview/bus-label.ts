// SPDX-License-Identifier: MPL-2.0

import type { BusLabelMode } from "../shared/protocol";

export function drawBusLabel(
  ctx: Pick<CanvasRenderingContext2D, "fillText"> & {
    measureText(text: string): { width: number };
  },
  value: string,
  left: number,
  right: number,
  baseline: number,
  mode: BusLabelMode,
  compact?: string,
  preservePrefix = false,
) {
  const span = right - left;
  const inset = Math.min(7, Math.max(2, Math.floor(span / 6)));
  const available = span - 2 * inset;
  const fits = (text: string) => ctx.measureText(text).width <= available;
  if (available <= 0) return;
  let label = value;
  if (!fits(label)) {
    if (mode === "full") return;
    label = compact || value;
    if (!fits(label)) {
      const digits = Array.from(label);
      let low = 1;
      let high = digits.length - 1;
      label = "";
      while (low <= high) {
        const length = Math.floor((low + high) / 2);
        const candidate = preservePrefix
          ? digits.slice(0, length).join("") + "…"
          : "…" + digits.slice(-length).join("");
        if (fits(candidate)) {
          label = candidate;
          low = length + 1;
        } else {
          high = length - 1;
        }
      }
      if (!label) return;
    }
  }
  ctx.fillText(label, left + inset, baseline);
}
