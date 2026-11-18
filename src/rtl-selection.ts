// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { Backend } from "./backend";
import type { Signal } from "./shared/protocol";
import * as W from "./shared/signals";
const KEYWORDS = new Set(
  "accept_on alias always always_comb always_ff always_latch and assert assign assume automatic before begin bind bins binsof bit break buf byte case casex casez cell chandle checker class clocking const constraint context continue cover covergroup coverpoint cross deassign default defparam disable dist do edge else end endcase endchecker endclass endclocking endfunction endgenerate endgroup endinterface endmodule endpackage endprimitive endprogram endproperty endsequence endspecify endtable endtask enum event eventually expect export extends extern final first_match for force foreach forever fork forkjoin function generate genvar global highz0 highz1 if iff ifnone ignore_bins illegal_bins implements implies import incdir include initial inout input inside int integer interconnect interface intersect join join_any join_none large let liblist library local localparam logic longint macromodule matches medium modport module nand negedge nettype new nexttime nmos nor not notif0 notif1 null or output package packed parameter pmos posedge primitive priority program property protected pull0 pull1 pulldown pullup pure rand randc randcase randsequence rcmos real realtime ref reg reject_on release repeat restrict return rnmos rpmos rtran rtranif0 rtranif1 s_always s_eventually s_nexttime s_until s_until_with scalared sequence shortint shortreal showcancelled signed small solve specify specparam static string strong strong0 strong1 struct super supply0 supply1 sync_accept_on sync_reject_on table tagged task this throughout time timeprecision timeunit tran tranif0 tranif1 tri tri0 tri1 triand trior trireg type typedef union unique unique0 unsigned until until_with untyped use uwire var vectored virtual void wait wait_order wand weak weak0 weak1 while wildcard wire with within wor xnor xor".split(
    /\s+/,
  ),
);
function codeOnly(text: string) {
  return text.replace(
    /\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"|\b\d[\d_]*(?:\.[\d_]+(?:[eE][+-]?[\d_]+)?|[eE][+-]?[\d_]+)\b|(?:\d[\d_]*)?'[sS]?[bBoOdDhH][0-9a-fA-F_xXzZ?]+|'[01xXzZ]/g,
    (s) => " ".repeat(s.length),
  );
}
function identifiers(text: string) {
  if (text.length > 2 * 1024 * 1024) throw Error("选区超过 2 MiB，请分批添加");
  const clean = codeOnly(text);
  const id = "(?:\\\\[^\\s]+|[A-Za-z_$][\\w$]*)",
    index = "(?:\\s*\\[\\s*-?\\d+\\s*(?::\\s*-?\\d+\\s*)?\\])*";
  const pattern = new RegExp(
      id + index + "(?:\\s*\\.\\s*" + id + index + ")*",
      "g",
    ),
    out = [],
    seen = new Set();
  for (const m of clean.matchAll(pattern)) {
    let name = m[0].replace(/\s+/g, "").replace(/^\\/, "");
    const before = clean.slice(0, m.index).trimEnd().at(-1),
      after = clean.slice(m.index + m[0].length).trimStart();
    if (
      name.startsWith("$") ||
      KEYWORDS.has(name.replace(/\[.*$/, "")) ||
      before === "`" ||
      after.startsWith("(")
    )
      continue;
    // A packed part select currently adds the whole source Bus. Preserve unpacked indices.
    name = name.replace(/\[-?\d+:-?\d+\]$/, "");
    if (!seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
    if (out.length > 10000) throw Error("选区标识符超过 10000 个，请分批添加");
  }
  return out;
}

function portConnection(
  text: string,
  code: string,
  start: number,
  end: number,
) {
  const statementStart = code.lastIndexOf(";", start - 1) + 1;
  const prefix = code.slice(statementStart, start);
  const portAtCursor = /\.\s*$/.test(prefix) && /^\s*\(/.test(code.slice(end));
  const openings: number[] = [];
  for (const match of prefix.matchAll(/[()]/g)) {
    if (match[0] === "(") openings.push(statementStart + match.index);
    else openings.pop();
  }

  const argument = portAtCursor ? code.indexOf("(", end) : openings.pop();
  const list = openings.pop();
  if (argument === undefined || list === undefined) return;
  const instance = /([a-zA-Z_$][\w$]*)\s*$/.exec(
    code.slice(statementStart, list),
  );
  if (!instance) return;
  const port = /(?:^\s*|,\s*)\.\s*([a-zA-Z_$][\w$]*)\s*$/.exec(
    code.slice(list + 1, argument),
  );
  if (!port) return;

  // Only a complete direct signal connection can stand in for the other endpoint.
  const direct = /^\s*([a-zA-Z_$][\w$]*(?:\s*\[\s*-?\d+\s*\])*)\s*\)/.exec(
    text.slice(argument + 1),
  );
  if (!portAtCursor && (!direct || end > argument + direct[0].length)) return;
  return {
    instance: instance[1],
    instanceOffset: statementStart + instance.index,
    port: port[1],
    actual: direct?.[1].replace(/\s/g, ""),
    portAtCursor,
  };
}
async function resolveSelection(backend: Backend, names: string[], scope = "") {
  const lookups = new Set(names);
  for (const name of names) {
    const bit = /^(.*)\[-?\d+\]$/.exec(name);
    if (bit) lookups.add(bit[1]);
  }
  const result = await backend.request("matchNames", {
    names: [...lookups],
    query: scope,
  });
  const signals = [],
    missing = [],
    ambiguous = [],
    unsupported: string[] = [],
    seen = new Set<string>();
  for (const name of names) {
    let matches = result.matches[name] || [];
    if (!matches.length) {
      const bit = /^(.*)\[(-?\d+)\]$/.exec(name);
      if (bit) {
        matches = (result.matches[bit[1]] || []).flatMap((s) => {
          const range = /\[\s*(-?\d+)\s*:\s*(-?\d+)\s*\]$/.exec(s.name),
            right = range ? Number(range[2]) : 0;
          const offset =
            (Number(bit[2]) - right) *
            (range && Number(range[1]) < right ? -1 : 1);
          return offset >= 0 && offset < s.width
            ? [{ ...s, width: 1, sourceWidth: s.width, bitOffset: offset }]
            : [];
        });
      }
    }
    matches = [...new Map(matches.map((s) => [W.key(s), s])).values()];
    matches = matches.filter((s) => {
      if (!s.supported) {
        unsupported.push(name);
        return false;
      }
      return true;
    });
    if (!matches.length) {
      missing.push(name);
      continue;
    }
    if (matches.length > 1) {
      ambiguous.push({ name, matches });
      continue;
    }
    const s = matches[0];
    if (!seen.has(W.key(s))) {
      seen.add(W.key(s));
      signals.push(s);
    }
  }
  return {
    signals,
    missing,
    ambiguous,
    unsupported,
    truncated: result.truncated,
  };
}
export { identifiers, resolveSelection, codeOnly, portConnection };
