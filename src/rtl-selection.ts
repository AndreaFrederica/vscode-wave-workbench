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

export function simpleAssignmentMacro(
  lines: readonly string[],
  line: number,
  column: number,
) {
  const identifier = "[A-Za-z_$][\\w$]*";
  const code = lines
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (comment) =>
      comment.replace(/[^\r\n]/g, " "),
    )
    .split("\n");
  const start = (code[line - 1] ?? "").slice(column - 1);
  const invocation = new RegExp(
    "^`(" +
      identifier +
      ")\\([ \\t]*(" +
      identifier +
      "(?:[ \\t]*,[ \\t]*" +
      identifier +
      ")*)[ \\t]*\\)",
  ).exec(start);
  if (!invocation) return;
  const [, name, argumentsText] = invocation;
  const candidates = code.slice(0, line - 1);
  if (
    candidates.some((text) =>
      /^\s*`(?:ifn?def|elsif|include|undef|undefineall)\b/.test(text),
    )
  )
    return;
  const escapedName = name.replace(/[$]/g, "\\$");
  const definition = new RegExp(
    "^([ \\t]*)`define[ \\t]+" +
      escapedName +
      "\\((" +
      identifier +
      "(?:[ \\t]*,[ \\t]*" +
      identifier +
      ")*)\\)[ \\t]+(" +
      identifier +
      ")[ \\t]*(<=|=)[ \\t]*(" +
      identifier +
      ")[ \\t]*;[ \\t]*(?://.*)?$",
  );
  const matches = candidates.flatMap((text, index) => {
    const match = definition.exec(text);
    return match ? [{ line: index + 1, match }] : [];
  });
  const defineName = new RegExp(
    "^[ \\t]*`define[ \\t]+" + escapedName + "(?=[ \\t(]|$)",
  );
  const definitions = candidates.filter((text) => defineName.test(text));
  if (matches.length !== 1 || definitions.length !== 1) return;
  const [{ line: definitionLine, match }] = matches;
  const [, indent, formals, lhs, operator, rhs] = match;
  const parameters = formals.split(",").map((value) => value.trim());
  const arguments_ = argumentsText.split(",").map((value) => value.trim());
  if (
    parameters.length !== arguments_.length ||
    new Set(parameters).size !== parameters.length
  )
    return;
  const values = new Map(
    parameters.map((name, index) => [name, arguments_[index]]),
  );
  return {
    name,
    lhs: values.get(lhs) ?? lhs,
    operator,
    rhs: values.get(rhs) ?? rhs,
    length: invocation[0].length,
    definition: { line: definitionLine, column: indent.length + 1 },
  };
}

export function vscOperandExpression(text: string) {
  const code = text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (comment) =>
    comment.replace(/[^\r\n]/g, " "),
  );
  const fixedSelection =
    /^\s*([A-Za-z_][\w$]{0,63})\s*\[\s*-?\d+\s*(?::\s*-?\d+\s*)?\]\s*$/.exec(
      code,
    );
  if (fixedSelection && !KEYWORDS.has(fixedSelection[1]))
    return { code, names: [fixedSelection[1]] };
  const tokens = code.match(
    /<<<|>>>|<<|>>|&&|\|\||~[&|^]|\^~|[A-Za-z_][\w$]*|[^\s]/g,
  );
  if (!tokens) return;
  const names = new Set<string>();
  const conditionalDepths: number[] = [];
  let expectOperand = true;
  let depth = 0;
  for (const token of tokens) {
    if (expectOperand) {
      if (token === "(") {
        depth++;
      } else if (!/^(?:~[&|^]?|\^~|[&|^])$/.test(token)) {
        if (
          !/^[A-Za-z_][\w$]{0,63}$/.test(token) ||
          KEYWORDS.has(token) ||
          names.has(token) ||
          names.size === 8
        )
          return;
        names.add(token);
        expectOperand = false;
      }
    } else if (token === ")" && depth && conditionalDepths.at(-1) !== depth) {
      depth--;
    } else if (token === "?") {
      conditionalDepths.push(depth);
      expectOperand = true;
    } else if (token === ":" && conditionalDepths.at(-1) === depth) {
      conditionalDepths.pop();
      expectOperand = true;
    } else if (/^(?:[&|^]|~\^|\^~|<<<|>>>|<<|>>)$/.test(token)) {
      expectOperand = true;
    } else {
      return;
    }
  }
  if (!depth && !conditionalDepths.length && !expectOperand)
    return { code, names: [...names] };
}

export function vcsGuardEntry(
  code: string,
  first: number,
  last: number,
  assignment: number,
  takenWhenTrue = true,
) {
  // The probe runs inside the chosen branch, after the original condition evaluates.
  if (
    first < 0 ||
    last <= first ||
    assignment <= last ||
    !/\bif\s*\(\s*$/.test(code.slice(Math.max(0, first - 256), first)) ||
    /[\x60#]/.test(code.slice(first, last))
  )
    return;
  const close = /^\s*\)\s*/.exec(code.slice(last, assignment));
  if (!close) return;
  let branch = last + close[0].length;
  const beginPattern = /^begin\b(?:\s*:\s*[A-Za-z_][\w$]*)?/;
  if (!takenWhenTrue) {
    const beforeElse = code.slice(branch, assignment);
    const block = beginPattern.exec(beforeElse);
    let ending: number | undefined;
    if (block) {
      let depth = 1;
      for (const token of beforeElse
        .slice(block[0].length)
        .matchAll(/\b(begin|end)\b/g)) {
        depth += token[1] === "begin" ? 1 : -1;
        if (depth === 0) {
          ending = block[0].length + token.index + token[0].length;
          break;
        }
      }
    } else {
      // A bare true assignment has no nested conditional that can own the else.
      const simple =
        /^[A-Za-z_][\w$]*(?:\s*\[[^;\]]+\])*\s*(?:<=|=(?!=))[^;]*;/.exec(
          beforeElse,
        );
      ending = simple?.[0].length;
    }
    if (ending === undefined) return;
    const next = /^(?:\s*:\s*[A-Za-z_][\w$]*)?\s*else\b\s*/.exec(
      beforeElse.slice(ending),
    );
    if (!next) return;
    branch += ending + next[0].length;
  }
  if (branch === assignment) return { at: assignment, bare: true };
  const begin = beginPattern.exec(code.slice(branch, assignment));
  if (!begin) return;
  const entry = branch + begin[0].length;
  let depth = 1;
  for (const token of code
    .slice(entry, assignment)
    .matchAll(/\b(begin|end)\b/g)) {
    depth += token[1] === "begin" ? 1 : -1;
    if (!depth) return;
  }
  return { at: entry, bare: false };
}

export function vcsCaseEntry(
  code: string,
  first: number,
  last: number,
  body: number,
  end: number,
  assignment: number,
  source = code,
) {
  if (
    first < 0 ||
    last <= first ||
    body <= last ||
    assignment < body ||
    assignment >= end ||
    !/\bcase[xz]?\s*\(\s*$/.test(code.slice(Math.max(0, first - 256), first)) ||
    !/^\s*\)/.test(code.slice(last, body))
  )
    return;
  if (assignment === body) return { at: assignment, bare: true };

  const begin = /^begin\b(?:\s*:\s*[A-Za-z_][\w$]*)?/.exec(
    code.slice(body, assignment),
  );
  if (!begin) return;
  const at = body + begin[0].length;
  // Use the simulator timestamp saved at entry for standalone decimal
  // delays. codeOnly can mask numeric literals in the examined source.
  const prior = code.slice(at, assignment);
  const writes =
    /\s*(?:#\s*(?:\d[\d_]*(?:\.[\d_]+)?)?\s*|[A-Za-z_][\w$]*\s*(?:<=|=(?!=))[^;#@()`]*);/gy;
  let consumed = 0;
  while (writes.exec(prior)) consumed = writes.lastIndex;
  const remaining = prior.slice(consumed);
  const wait = /^\s*wait\s*\(([\s\S]*)\)\s*$/.exec(remaining);
  if (
    !remaining.trim() ||
    (wait &&
      vcsWaitOperands(
        source.slice(
          at + consumed + remaining.indexOf("(") + 1,
          at + consumed + remaining.lastIndexOf(")"),
        ),
      ))
  )
    return { at, bare: false };
}

const waitInteger =
  /(?:[0-9][\d_]*)?'(?:s?[bBoOdDhH]\s*[0-9a-fA-F_xXzZ?]+)|'[01xXzZ]|[0-9][\d_]*/i;
const waitToken = new RegExp(
  waitInteger.source +
    String.raw`|===|!==|==|!=|<=|>=|&&|\|\||[A-Za-z_][\w$]*|\S`,
  "gi",
);

export function vcsWaitOperands(source: string) {
  if (source.length > 4096) return;
  const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, " ");
  const tokens = code.match(waitToken);
  if (!tokens) return;
  const names = new Set<string>();
  let depth = 0;
  let expectOperand = true;
  for (const token of tokens) {
    if (expectOperand) {
      if (token === "(") depth++;
      else if (token !== "!" && token !== "~") {
        if (/^[\d']/.test(token) && token.match(waitInteger)?.[0] === token) {
          expectOperand = false;
          continue;
        }
        if (!/^[A-Za-z_][\w$]{0,63}$/.test(token) || KEYWORDS.has(token))
          return;
        names.add(token);
        if (names.size > 8) return;
        expectOperand = false;
      }
    } else if (token === ")" && depth) depth--;
    else if (/^(?:&&|\|\||[&|^]|===?|!==?|[<>]=?)$/.test(token))
      expectOperand = true;
    else return;
  }
  if (names.size && !depth && !expectOperand)
    return { names: [...names], compound: tokens.length > 1 };
}

export function vcsWaitEntry(
  code: string,
  first: number,
  last: number,
  assignment: number,
) {
  if (
    first >= 0 &&
    last > first &&
    assignment > last &&
    /\bwait\s*\(\s*$/.test(code.slice(Math.max(0, first - 256), first)) &&
    /^\s*\)\s*$/.test(code.slice(last, assignment))
  )
    return { at: assignment, bare: true };
}

export function vcsStandaloneWait(
  code: string,
  first: number,
  last: number,
  assignment: number,
) {
  if (first < 0 || last <= first || assignment <= last) return;
  const prefixStart = Math.max(0, first - 256);
  const header = /\bwait\s*\(\s*$/.exec(code.slice(prefixStart, first));
  const tail = code.slice(last, assignment);
  const end = /^\s*\)\s*;/.exec(tail);
  if (
    header &&
    end &&
    /^(?:\s*#\s*(?:\d[\d_]*(?:\.[\d_]+)?)?\s*;)*\s*$/.test(
      tail.slice(end[0].length),
    )
  )
    return {
      start: prefixStart + header.index,
      semicolon: last + end[0].length - 1,
    };
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
