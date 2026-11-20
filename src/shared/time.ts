// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

const UNITS = { s: 1, ms: 1e-3, us: 1e-6, ns: 1e-9, ps: 1e-12, fs: 1e-15 };

export function scaleSeconds(scale: string) {
  const match = /^([\d.e+-]+)\s*(s|ms|us|ns|ps|fs)$/i.exec(scale);
  if (!match || !(Number(match[1]) > 0))
    throw new Error(`Unsupported time scale ${scale}`);
  return Number(match[1]) * UNITS[match[2].toLowerCase() as keyof typeof UNITS];
}

export function scaleHertz(scale: string) {
  const match = /^([\d.e+-]+)\s*(mHz|Hz)$/.exec(scale);
  if (!match) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return match[2] === "mHz" ? value / 1000 : value;
}

export function frequencyLabel(hertz: number) {
  const magnitude = Math.abs(hertz);
  const [factor, unit] =
    magnitude >= 1e12
      ? [1e12, "THz"]
      : magnitude >= 1e9
        ? [1e9, "GHz"]
        : magnitude >= 1e6
          ? [1e6, "MHz"]
          : magnitude >= 1e3
            ? [1e3, "kHz"]
            : magnitude > 0 && magnitude < 1
              ? [1e-3, "mHz"]
              : [1, "Hz"];
  return Number((hertz / Number(factor)).toPrecision(6)) + " " + unit;
}
