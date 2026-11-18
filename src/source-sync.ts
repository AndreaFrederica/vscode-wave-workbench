// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
function moduleAt(text: string, line = 0) {
  // Preserve offsets/newlines while excluding strings and comments. The design remains
  // authoritative for elaboration; this only identifies the editor's declaration.
  const clean = text.replace(
    /\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"/g,
    (s) => s.replace(/[^\n]/g, " "),
  );
  const matches = [
    ...clean.matchAll(
      /\b(module|interface|program|package)\s+(?:(?:automatic|static)\s+)?(\\\S+|[a-zA-Z_$][\w$]*)/g,
    ),
  ];
  const offset = text
    .split("\n")
    .slice(0, line)
    .reduce((n, s) => n + s.length + 1, 0);
  return (matches.findLast((m) => m.index <= offset) ||
    matches[0])?.[2]?.replace(/^\\/, "");
}
function commonScope(a: string, b: string) {
  const x = a.split("."),
    y = b.split(".");
  let i = 0;
  while (i < x.length && x[i] === y[i]) i++;
  return i;
}
class SourceFiles {
  cache: Map<string, { stamp: string; hash: string }>;
  constructor() {
    this.cache = new Map();
  }
  same(a: string, b: string) {
    try {
      if (fs.realpathSync(a) === fs.realpathSync(b)) return true;
      return this.hash(a) === this.hash(b);
    } catch {
      return false;
    }
  }
  hash(file: string) {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 16 * 1024 * 1024)
      throw Error("RTL file too large");
    const key = path.resolve(file),
      stamp = stat.mtimeMs + ":" + stat.ctimeMs + ":" + stat.size;
    let value = this.cache.get(key);
    if (value?.stamp !== stamp) {
      value = {
        stamp,
        hash: crypto
          .createHash("sha256")
          .update(fs.readFileSync(file))
          .digest("hex"),
      };
      this.cache.set(key, value);
      while (this.cache.size > 512) {
        const oldest = this.cache.keys().next();
        if (!oldest.done) this.cache.delete(oldest.value);
      }
    }
    return value.hash;
  }
}
export { moduleAt, commonScope, SourceFiles };
