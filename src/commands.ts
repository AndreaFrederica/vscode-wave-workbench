// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { Viewer } from "./viewer";
import type { TclNode } from "./tcl";
import * as WaveSignal from "./shared/signals";
import { restoreView } from "./view-state";
import * as fs from "node:fs";
import * as path from "node:path";
const UNITS = { s: 1, ms: 1e-3, us: 1e-6, ns: 1e-9, ps: 1e-12, fs: 1e-15 };
const HELP = `Supported nWave Tcl commands (current window):
wvCreateWindow / wvGetCurrentWindow
wvOpenFile filename
wvAddSignal [-clear] signal... | -group {group {signal}...}
wvDeleteSignal signal...; wvSelectSignal signal
wvSetCursor -begin|-end|time; wvSetMarker [-name name] time
wvZoom start end; wvZoomAll; wvZoomIn; wvZoomOut; wvZoomCursorMarker
wvSetRadix [-Unsigned|-2Com] -format Bin|Oct|Hex|Dec [signal...]
wvGetSigValueByTime signal [-format Bin|Oct|Hex|UDec|2Com] [-time time] [-lz]
wvIsSignalExistInWaveform -signal signal
wvSetWindowTimeUnit number s|ms|us|ns|ps|fs; wvGetWindowTimeUnit
wvSearchNext / wvSearchPrev (current loaded window, transition search)
waveRestoreView json; waveView
waveFindSignals query ?offset? ?limit?
waveGetEvents signal start end ?limit?
waveGroup list | create name | target name | move name target before|after
waveGroup rename name newName | remove name | expand name | collapse name | assign name signal...
waveTooltip ?0|1?; waveLayout ?rowHeight signalColumnPercent?
wvSaveSignal file.tcl; wvRestoreSignal file.tcl; source file.tcl
srcGetFileName full.name; srcSetScope full.name
All wv commands except wvCreateWindow accept -win 1. Unsupported commands/options raise errors.
Saved signal files are replayable Tcl scripts, not native Verdi .sav files.`;
function parse(nodes: TclNode[], spec: Record<string, number> = {}) {
  const options: Record<string, TclNode> = {},
    position = [];
  for (let i = 0; i < nodes.length; i++) {
    const key = nodes[i].value;
    if (key.startsWith("-") && !/^-[\d.]/.test(key)) {
      if (!(key in spec)) throw new Error(`Unsupported option: ${key}`);
      if (spec[key]) {
        if (!nodes[i + 1]) throw new Error(`Missing argument for ${key}`);
        options[key] = nodes[++i];
      } else options[key] = { value: "1" };
    } else position.push(nodes[i]);
  }
  return { options, position };
}
const text = (n?: TclNode) => n?.value;
function names(nodes: TclNode[]) {
  return nodes.flatMap((n) => (n.items?.length > 1 ? n.items : [n])).map(text);
}
function normalName(name: string, delimiter = "/") {
  return name
    .replace(
      new RegExp(
        "^" +
          (delimiter === "/"
            ? "/"
            : delimiter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) +
          "+",
      ),
      "",
    )
    .split(delimiter)
    .join(".")
    .replace(/\s*\[\s*-?\d+\s*:\s*-?\d+\s*\]$/, "");
}
function scaleSeconds(scale: string) {
  const match = /^([\d.e+-]+)\s*(s|ms|us|ns|ps|fs)$/i.exec(scale);
  if (!match || !(Number(match[1]) > 0))
    throw new Error(`Unsupported time scale ${scale}`);
  return Number(match[1]) * UNITS[match[2].toLowerCase()];
}
function quote(value: unknown) {
  return (
    '"' +
    String(value).replace(
      /[\\"$\[\]\n\r]/g,
      (c) => ({ "\n": "\\n", "\r": "\\r" })[c] || "\\" + c,
    ) +
    '"'
  );
}
function formatValue(
  raw: string,
  width: number,
  format = "Hex",
  leading = false,
) {
  let bits = raw
    .padStart(width, /^[xz]/i.test(raw) ? raw[0] : "0")
    .toLowerCase();
  const f = format.toLowerCase();
  if (f === "bin") return leading ? bits : bits.replace(/^0+(?=.)/, "");
  if (f === "hex" || f === "oct") {
    const size = f === "hex" ? 4 : 3;
    bits = bits.padStart(
      Math.ceil(bits.length / size) * size,
      /^[xz]/.test(bits) ? bits[0] : "0",
    );
    let result = "";
    for (let i = 0; i < bits.length; i += size) {
      const part = bits.slice(i, i + size);
      result += part.includes("x")
        ? "x"
        : part.includes("z")
          ? "z"
          : parseInt(part, 2).toString(f === "hex" ? 16 : 8);
    }
    return leading ? result : result.replace(/^0+(?=.)/, "");
  }
  if (!["dec", "udec", "2com"].includes(f))
    throw new Error(`Unsupported value format: ${format}`);
  if (/[xz]/.test(bits)) return bits.includes("x") ? "x" : "z";
  let number = BigInt("0b" + bits);
  if (f === "2com" && bits[0] === "1") number -= 1n << BigInt(width);
  return String(number);
}
interface CommandHooks {
  getViewer: () => Viewer;
  open?: (file: string) => Promise<void>;
  source?: unknown;
  scope?: (scope: string) => Promise<void>;
}
class WaveCommands {
  getViewer: CommandHooks["getViewer"];
  open: CommandHooks["open"];
  source: unknown;
  scope: CommandHooks["scope"];
  windowScale: string;
  constructor({ getViewer, open, source, scope }: CommandHooks) {
    Object.assign(this, { getViewer, open, source, scope });
  }
  async execute(command: string, nodes: TclNode[]) {
    if (command === "waveHelp") return HELP;
    let viewer = this.getViewer();
    const p = parse(nodes, {
      "-win": 1,
      ...({
        wvAddSignal: { "-group": 1, "-clear": 0, "-delim": 1 },
        wvSetCursor: { "-begin": 0, "-end": 0 },
        wvSetMarker: { "-name": 1, "-keepViewRange": 0 },
        wvSetRadix: { "-format": 1, "-Unsigned": 0, "-2Com": 0, "-delim": 1 },
        wvSelectSignal: { "-delim": 1 },
        wvDeleteSignal: { "-delim": 1 },
        wvGetSigValueByTime: {
          "-format": 1,
          "-time": 1,
          "-lz": 0,
          "-delim": 1,
        },
        wvIsSignalExistInWaveform: { "-signal": 1, "-delim": 1 },
      }[command] || {}),
    });
    const { options: o, position: a } = p;
    const args = a.map(text);
    if (o["-win"] && !["1", "_nWave1"].includes(text(o["-win"])))
      throw new Error("Only the current wave window (-win 1) is supported");
    const count = (min, max = min) => {
      if (a.length < min || a.length > max)
        throw new Error(`Invalid arguments for ${command}; run waveHelp`);
    };
    if (command === "wvCreateWindow" || command === "wvGetCurrentWindow") {
      count(0);
      return "1";
    }
    if (command === "wvOpenFile") {
      count(1);
      await this.open(args[0]);
      this.windowScale =
        (await this.getViewer().ui("snapshot")).displayScale ||
        this.getViewer().meta.scale;
      return "1";
    }
    if (!viewer?.meta) throw new Error("Open a waveform first");
    if (
      !this.windowScale ||
      [
        "wvGetWindowTimeUnit",
        "waveGetEvents",
        "wvSetCursor",
        "wvSetMarker",
        "wvZoom",
        "wvGetSigValueByTime",
      ].includes(command)
    )
      this.windowScale =
        (await viewer.ui("snapshot")).displayScale || viewer.meta.scale;
    const scale = this.windowScale;
    const ticks = (value: string) => {
      const n =
          (Number(value) * scaleSeconds(scale)) /
          scaleSeconds(viewer.meta.scale),
        t = Math.round(n);
      if (
        !Number.isFinite(n) ||
        !Number.isSafeInteger(t) ||
        t < Number(viewer.meta.start) ||
        t > Number(viewer.meta.end) ||
        Math.abs(n - t) > 1e-5
      )
        throw new Error(
          `Time ${value} is outside the dump or not representable in dump ticks`,
        );
      return t;
    };
    const time = (t: number) =>
      String((t * scaleSeconds(viewer.meta.scale)) / scaleSeconds(scale));
    const find = async (name: string) => {
      const normalized = normalName(name, text(o["-delim"]) || "/");
      let result = await viewer.backend.request("search", {
        query: normalized,
      });
      const exact = result.signals.find(
        (s) => normalName(`${s.scope}.${s.name}`, ".") === normalized,
      );
      if (exact) return exact;
      const bit = /^(.*)\[(-?\d+)\]$/.exec(normalized);
      if (bit) {
        result = await viewer.backend.request("search", { query: bit[1] });
        for (const s of result.signals) {
          if (normalName(`${s.scope}.${s.name}`, ".") !== bit[1]) continue;
          const range = /\[\s*(-?\d+)\s*:\s*(-?\d+)\s*\]$/.exec(s.name),
            right = range ? Number(range[2]) : 0,
            direction = range && Number(range[1]) < right ? -1 : 1,
            offset = (Number(bit[2]) - right) * direction;
          if (Number.isSafeInteger(offset) && offset >= 0 && offset < s.width)
            return { ...s, width: 1, sourceWidth: s.width, bitOffset: offset };
        }
      }
      throw new Error(`Dumped signal not found: ${name}`);
    };
    const ui = (action: string, payload: unknown = {}) =>
      viewer.ui(action, payload);
    switch (command) {
      case "wvAddSignal": {
        const descriptors = [];
        const group = o["-group"];
        if (group) {
          if (!group.items?.length) throw new Error("Empty group");
          const groupName = group.items[0].value;
          for (const entry of group.items.slice(1)) {
            const parts = entry.items || [entry];
            if (parts.length !== 1)
              throw new Error("Per-signal add options are not supported");
            descriptors.push({
              ...(await find(parts[0].value)),
              group: groupName,
            });
          }
        }
        for (const name of names(a)) descriptors.push(await find(name));
        if (!descriptors.length && !o["-clear"])
          throw new Error("No signals supplied");
        if (descriptors.some((s) => !s.supported))
          throw new Error("Unsupported signal encoding");
        await ui("addSignals", { signals: descriptors, clear: !!o["-clear"] });
        return "1";
      }
      case "wvDeleteSignal":
      case "wvSelectSignal": {
        count(1, 100000);
        const signals = await Promise.all(names(a).map(find));
        return String(
          await ui(
            command === "wvDeleteSignal" ? "deleteSignals" : "selectSignals",
            { signals },
          ),
        );
      }
      case "wvSetCursor": {
        count(o["-begin"] || o["-end"] ? 0 : 1);
        await ui("cursor", {
          time: o["-begin"]
            ? Number(viewer.meta.start)
            : o["-end"]
              ? Number(viewer.meta.end)
              : ticks(args[0]),
        });
        return "1";
      }
      case "wvSetMarker": {
        count(1);
        await ui("marker", {
          time: ticks(args[0]),
          name: text(o["-name"]) || "B",
          keepView: !!o["-keepViewRange"],
        });
        return "1";
      }
      case "wvZoom": {
        count(2);
        const start = ticks(args[0]),
          end = ticks(args[1]);
        if (start >= end) throw new Error("Zoom start must be before end");
        await ui("window", { start, end });
        return "1";
      }
      case "wvZoomAll":
      case "wvZoomIn":
      case "wvZoomOut":
      case "wvZoomCursorMarker": {
        count(0);
        await ui(
          {
            wvZoomAll: "fit",
            wvZoomIn: "in",
            wvZoomOut: "out",
            wvZoomCursorMarker: "between",
          }[command],
        );
        return "1";
      }
      case "wvSearchNext":
      case "wvSearchPrev": {
        count(0);
        const result = await ui(command === "wvSearchNext" ? "next" : "prev");
        return result === null ? "0" : `1 ${time(result)}`;
      }
      case "wvSetRadix": {
        const fmt = (text(o["-format"]) || "Hex").toLowerCase();
        const radix = {
          bin: "bin",
          oct: "oct",
          hex: "hex",
          dec: o["-2Com"] ? "signed" : "unsigned",
        }[fmt];
        if (!radix) throw new Error(`Unsupported radix ${fmt}`);
        await ui("radix", {
          radix,
          signals: a.length ? await Promise.all(names(a).map(find)) : null,
        });
        return "1";
      }
      case "wvGetSigValueByTime": {
        count(1);
        const signal = await find(args[0]),
          snapshot = o["-time"] ? null : await ui("snapshot");
        const t = o["-time"] ? ticks(text(o["-time"])) : snapshot.cursorA;
        const result = (
          await viewer.backend.request("query", {
            signals: [signal.id],
            start: String(t),
            end: String(t),
            limit: 100000,
          })
        )[signal.id];
        if (result.truncated)
          throw new Error("Value query has too many same-tick events");
        const raw = result.events.at(-1)?.[1];
        return raw == null
          ? ""
          : formatValue(
              WaveSignal.project(raw, signal),
              signal.width,
              text(o["-format"]) || "Hex",
              !!o["-lz"],
            );
      }
      case "wvIsSignalExistInWaveform": {
        count(o["-signal"] ? 0 : 1);
        try {
          await find(text(o["-signal"]) || args[0]);
          return "1";
        } catch (e) {
          if (e.message.startsWith("Dumped signal not found:")) return "0";
          throw e;
        }
      }
      case "wvGetWindowTimeUnit": {
        count(0);
        return scale.replace(/([a-z]+)$/i, " $1");
      }
      case "wvSetWindowTimeUnit": {
        count(2);
        const next = args.join("");
        scaleSeconds(next);
        this.windowScale = next;
        await ui("timeUnit", {
          scale: next,
          factor: scaleSeconds(next) / scaleSeconds(viewer.meta.scale),
        });
        return "1";
      }
      case "waveView":
        count(0);
        return JSON.stringify(await ui("snapshot"));
      case "waveFindSignals": {
        count(1, 3);
        const offset = Number(args[1] ?? 0);
        const limit = Number(args[2] ?? 100);
        if (
          !Number.isSafeInteger(offset) ||
          offset < 0 ||
          !Number.isSafeInteger(limit) ||
          limit < 1 ||
          limit > 512
        )
          throw Error("Invalid signal search page");
        const result = await viewer.backend.request("search", {
          query: normalName(args[0]),
          offset,
          limit,
        });
        return JSON.stringify(result);
      }
      case "waveGetEvents": {
        count(3, 4);
        const signal = await find(args[0]);
        const start = ticks(args[1]),
          end = ticks(args[2]);
        const limit = Number(args[3] ?? 1000);
        if (
          end < start ||
          !Number.isSafeInteger(limit) ||
          limit < 1 ||
          limit > 10000
        )
          throw Error("Invalid event window or limit");
        const block = (
          await viewer.backend.request("query", {
            signals: [signal.id],
            start: String(start),
            end: String(end),
            limit,
          })
        )[signal.id];
        return JSON.stringify({
          signal: args[0],
          unit: scale,
          truncated: block.truncated,
          events: block.events.map(([tick, raw]) => [
            time(Number(tick)),
            WaveSignal.project(raw, signal),
          ]),
        });
      }
      case "waveLayout": {
        count(0, 2);
        if (args.length === 1)
          throw Error("Expected row height and signal column percentage");
        const rowHeight = args.length ? Number(args[0]) : undefined;
        const namesFraction = args.length ? Number(args[1]) / 100 : undefined;
        if (
          args.length &&
          (!Number.isInteger(rowHeight) ||
            rowHeight < 24 ||
            rowHeight > 80 ||
            !Number.isFinite(namesFraction) ||
            namesFraction < 0.1 ||
            namesFraction > 0.75)
        )
          throw Error("Layout values must be 24–80 px and 10–75 percent");
        return JSON.stringify(
          await ui("trackLayout", { rowHeight, namesFraction }),
        );
      }
      case "waveTooltip":
        count(0, 1);
        if (args.length && !["0", "1"].includes(args[0]))
          throw Error("waveTooltip expects 0 or 1");
        return String(
          await ui("tooltip", {
            enabled: args.length ? args[0] === "1" : undefined,
          }),
        );
      case "waveGroup": {
        count(1, 100000);
        const [operation, group, target, side] = args;
        switch (operation) {
          case "list":
            count(1);
            return JSON.stringify(await ui("groups", { operation }));
          case "target":
          case "create":
          case "remove":
          case "collapse":
          case "expand":
            count(2);
            break;
          case "rename":
            count(3);
            if (!target) throw Error("Group name is empty");
            break;
          case "move":
            count(4);
            if (!["before", "after"].includes(side))
              throw Error("Expected before or after");
            break;
          case "assign":
            count(3, 100000);
            return String(
              await ui("groups", {
                operation,
                group,
                signals: await Promise.all(names(a.slice(2)).map(find)),
              }),
            );
          default:
            throw Error("Unknown waveGroup operation");
        }
        return String(
          await ui("groups", {
            operation,
            group,
            target,
            after: side === "after",
          }),
        );
      }
      case "waveRestoreView": {
        count(1);
        const state = await restoreView(
          viewer.backend,
          JSON.parse(args[0]),
          viewer.meta,
        );
        await ui("restoreView", state);
        this.windowScale = state.displayScale || viewer.meta.scale;
        return "1";
      }
      case "wvSaveSignal": {
        count(1);
        if (/\.sav$/i.test(args[0]))
          throw new Error(
            "Native Verdi .sav format is not supported; save to .tcl instead",
          );
        const s = await ui("snapshot");
        const lines = [
          "# Wave Workbench signal configuration; replay with source / wvRestoreSignal",
          `wvSetWindowTimeUnit ${viewer.meta.scale.replace(/([a-z]+)$/i, " $1")}`,
        ];
        if (
          s.markers?.some((m) => m.color) ||
          s.markersVisible === false ||
          s.chosen.some(
            (signal) =>
              Number.isInteger(signal.bitOffset) ||
              signal.id.startsWith("@virtual:"),
          )
        ) {
          lines.push("waveRestoreView " + quote(JSON.stringify(s)));
          if (Buffer.byteLength(lines.join("\n") + "\n") > 1048576)
            throw Error(
              "View replay exceeds the 1 MiB Tcl script limit; reduce expanded signals",
            );
          fs.writeFileSync(
            path.resolve(
              viewer.scriptDirectory || path.dirname(viewer.uri.fsPath),
              args[0],
            ),
            lines.join("\n") + "\n",
          );
          return "1";
        }
        for (const signal of s.chosen) {
          const full =
            "/" + signal.scope.split(".").join("/") + "/" + signal.name;
          lines.push(
            signal.group
              ? `wvAddSignal -group [list ${quote(signal.group)} [list ${quote(full)}]]`
              : `wvAddSignal ${quote(full)}`,
          );
          if (signal.displayRadix || s.radix) {
            const mode = signal.displayRadix || s.radix;
            const fmt = {
              hex: "Hex",
              bin: "Bin",
              oct: "Oct",
              unsigned: "Dec",
              signed: "Dec",
            }[mode];
            lines.push(
              `wvSetRadix ${mode === "signed" ? "-2Com " : ""}-format ${fmt} ${quote(full)}`,
            );
          }
        }
        lines.push(`wvSetCursor ${s.cursorA}`);
        for (const m of s.markers || [])
          lines.push(`wvSetMarker -name ${quote(m.name)} ${m.time}`);
        if (s.cursorB != null && !s.markers?.some((m) => m.name === "B"))
          lines.push(`wvSetMarker ${s.cursorB}`);
        lines.push(`wvZoom ${s.start} ${s.end}`);
        if (s.displayScale)
          lines.push(
            "wvSetWindowTimeUnit " +
              s.displayScale.replace(/([a-z]+)$/i, " $1"),
          );
        fs.writeFileSync(
          path.resolve(
            viewer.scriptDirectory || path.dirname(viewer.uri.fsPath),
            args[0],
          ),
          lines.join("\n") + "\n",
          { flag: "w" },
        );
        return "1";
      }
      case "__restore": {
        count(1);
        const filename = path.resolve(
          viewer.scriptDirectory || path.dirname(viewer.uri.fsPath),
          args[0],
        );
        if (/\.sav$/i.test(filename))
          throw new Error(
            "Native Verdi .sav format is not supported; restore a Tcl script",
          );
        if (!fs.existsSync(filename))
          throw new Error("Signal script not found: " + filename);
        await ui("clear");
        return filename;
      }
      case "srcGetFileName": {
        count(1);
        if (!viewer.kdb) await viewer.attachKdb();
        if (!viewer.kdb) throw new Error("No KDB attached");
        return (await viewer.kdb.resolve(args[0])).file;
      }
      case "srcSetScope": {
        count(1);
        await this.scope(args[0]);
        return "1";
      }
      default:
        throw new Error(`Unsupported Verdi/nWave command: ${command}`);
    }
  }
}
export { WaveCommands, HELP, formatValue, quote };
