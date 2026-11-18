// SPDX-License-Identifier: MPL-2.0

export interface UartOptions {
  baud: number;
  dataBits: number;
  parity: "none" | "even" | "odd" | "mark" | "space";
  stopBits: 1 | 1.5 | 2;
  bitOrder: "lsb" | "msb";
  inverted: boolean;
}

export function validateUart(options: UartOptions): UartOptions {
  const { baud, dataBits, parity, stopBits, bitOrder, inverted } =
    options || {};
  if (
    !Number.isSafeInteger(baud) ||
    baud < 1 ||
    baud > 1e9 ||
    !Number.isInteger(dataBits) ||
    dataBits < 5 ||
    dataBits > 9 ||
    !["none", "even", "odd", "mark", "space"].includes(parity) ||
    ![1, 1.5, 2].includes(stopBits) ||
    !["lsb", "msb"].includes(bitOrder) ||
    typeof inverted !== "boolean"
  )
    throw Error("UART 参数无效，请检查波特率、数据位、校验位、停止位和位序");
  return { baud, dataBits, parity, stopBits, bitOrder, inverted };
}

const seconds = { s: 1, ms: 1e-3, us: 1e-6, ns: 1e-9, ps: 1e-12, fs: 1e-15 };
export function uartBitTicks(options: UartOptions, timescale: string) {
  const unit = /^\s*([\d.e+-]+)\s*(fs|ps|ns|us|ms|s)\s*$/i.exec(timescale);
  if (!unit) return NaN;
  return (
    1 /
    (options.baud *
      Number(unit[1]) *
      seconds[unit[2].toLowerCase() as keyof typeof seconds])
  );
}

export interface UartFrame {
  start: number;
  end: number;
  word: number;
  errors: ("unknown" | "parity" | "stop")[];
}

export function decodeUart(
  options: UartOptions,
  timescale: string,
  events: [string, string][],
  end: number,
  project: (value: string) => string = (value) => value,
): UartFrame[] {
  const bitTicks = uartBitTicks(options, timescale);
  if (!Number.isFinite(bitTicks) || bitTicks < 2 || events.length < 2)
    return [];
  const frames: UartFrame[] = [];
  const idle = options.inverted ? "0" : "1";
  const active = options.inverted ? "1" : "0";
  const parityBits = Number(options.parity !== "none");
  const stop = 1 + options.dataBits + parityBits;
  let previous = project(events[0][1]);
  let nextStart = -Infinity;
  let at = 0;
  const sample = (time: number) => {
    while (at + 1 < events.length && Number(events[at + 1][0]) <= time) at++;
    const raw = project(events[at][1]);
    return raw === idle ? 1 : raw === active ? 0 : -1;
  };
  for (let i = 1; i < events.length; i++) {
    const [tick, raw] = events[i];
    const level = project(raw);
    const start = Number(tick);
    const edge = previous === idle && level === active;
    previous = level;
    if (!edge || start + 1e-6 < nextStart) continue;
    const finish = start + bitTicks * (stop + options.stopBits);
    if (Math.ceil(finish - 1e-6) > end) break;
    if (sample(start + 0.5 * bitTicks) !== 0) continue;

    let word = 0,
      ones = 0;
    const errors: UartFrame["errors"] = [];
    for (let j = 0; j < options.dataBits; j++) {
      const bit = sample(start + (j + 1.5) * bitTicks);
      if (bit < 0 && !errors.includes("unknown")) errors.push("unknown");
      if (bit === 1) {
        ones++;
        word |=
          1 << (options.bitOrder === "lsb" ? j : options.dataBits - 1 - j);
      }
    }
    if (parityBits) {
      const parityBit = sample(start + (stop - 0.5) * bitTicks);
      const expected =
        options.parity === "mark"
          ? 1
          : options.parity === "space"
            ? 0
            : ones % 2 ^ Number(options.parity === "odd");
      if (parityBit < 0) {
        if (!errors.includes("unknown")) errors.push("unknown");
      } else if (parityBit !== expected) errors.push("parity");
    }
    if (
      sample(start + (stop + 0.5) * bitTicks) !== 1 ||
      (options.stopBits > 1 &&
        sample(start + (stop + (1 + options.stopBits) / 2) * bitTicks) !== 1)
    )
      errors.push("stop");
    frames.push({ start, end: finish, word, errors });
    nextStart = finish - bitTicks * 0.35;
  }
  return frames;
}
