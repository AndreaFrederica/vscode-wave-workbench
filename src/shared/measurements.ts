// SPDX-License-Identifier: MPL-2.0

import type { Signal } from "./protocol";

export const measurements = [
  "cursors",
  "analog",
  "pulse",
  "timing",
  "delay",
  "edges",
  "peaks",
] as const;

export type Measurement = (typeof measurements)[number];

export function measurementAcceptsSignal(
  operation: Measurement,
  signal: Pick<Signal, "real" | "width">,
) {
  if (operation === "cursors") return true;
  if (operation === "pulse" || operation === "timing" || operation === "delay")
    return !!signal.real || signal.width === 1;
  return !!signal.real;
}
