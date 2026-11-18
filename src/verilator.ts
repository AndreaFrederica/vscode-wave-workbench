// SPDX-License-Identifier: MPL-2.0

import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { DesignSession } from "./kdb";
import type { Location, Signal } from "./shared/protocol";

interface AstNode {
  type: string;
  name?: string;
  addr?: string;
  loc?: string;
  origName?: string;
  verilogName?: string;
  level?: number;
  inLibrary?: boolean;
  implied?: boolean;
  isTemp?: boolean;
  modp?: string;
  modName?: string;
  varType?: string;
  stmtsp?: AstNode[];
  itemsp?: AstNode[];
}

interface Contents {
  scopes: AstNode[];
  variables: Map<string, AstNode>;
}

interface Scope {
  record: Location;
  parent: string;
  node: AstNode;
  definition: AstNode;
}

const definitionKinds: Record<string, string> = {
  MODULE: "npiModule",
  IFACE: "npiInterface",
  INTERFACE: "npiInterface",
  PACKAGE: "npiPackage",
  PROGRAM: "npiProgram",
};
const rtlName = (node: AstNode) =>
  (node.verilogName || node.origName || node.name)?.trim().replace(/^\\/, "");
const instanceName = (node: AstNode) =>
  (node.verilogName || node.name || node.origName)?.trim().replace(/^\\/, "");
const isHierarchyNode = (node: AstNode) =>
  (node.type === "CELL" || node.type === "GENBLOCK" || node.type === "BEGIN") &&
  !!instanceName(node) &&
  !node.implied;

export function verilatorTreeFile(filename: string) {
  return /\.tree(?:\.meta)?\.json$/i.test(filename)
    ? filename.replace(/\.tree\.meta\.json$/i, ".tree.json")
    : undefined;
}

export async function findVerilatorTree(waveform: string) {
  const dir = path.dirname(waveform);
  const stem = path.basename(waveform, path.extname(waveform));
  const candidates = [
    path.join(dir, stem + ".tree.json"),
    path.join(dir, "V" + stem + ".tree.json"),
    path.join(dir, "obj_dir", "V" + stem + ".tree.json"),
  ];
  return candidates.find((filename) => existsSync(filename));
}

async function readJson(filename: string) {
  const stat = await fs.stat(filename);
  if (!stat.isFile() || stat.size > 256 * 1024 * 1024)
    throw Error("Invalid or oversized Verilator JSON: " + filename);
  return JSON.parse(await fs.readFile(filename, "utf8"));
}

export class VerilatorDesign implements DesignSession {
  readonly kind = "verilator";
  private definitions = new Map<string, AstNode>();
  private scopes = new Map<string, Scope>();
  private roots: Scope[] = [];
  private contents = new WeakMap<AstNode, Contents>();
  private byModule?: Map<string, Location[]>;
  private sourceFiles = new Map<string, string>();
  private top: Scope;

  static async open(
    filename: string,
    signals: Signal[],
    sourceDirectories: string[],
  ) {
    filename = path.resolve(verilatorTreeFile(filename) || filename);
    const [tree, meta] = await Promise.all([
      readJson(filename),
      readJson(filename.replace(/\.tree\.json$/i, ".tree.meta.json")),
    ]);
    if (
      tree?.type !== "NETLIST" ||
      !Array.isArray(tree.modulesp) ||
      !meta?.files
    )
      throw Error(
        "Expected a Verilator --json-only tree and its companion metadata",
      );
    return new VerilatorDesign(
      filename,
      tree.modulesp,
      meta.files,
      signals,
      sourceDirectories,
    );
  }

  private constructor(
    filename: string,
    definitions: AstNode[],
    files: Record<string, { filename?: string; realpath?: string }>,
    signals: Signal[],
    sourceDirectories: string[],
  ) {
    this.path = filename;
    for (const [id, file] of Object.entries(files)) {
      const original = file.realpath || file.filename;
      if (!original || original.startsWith("<")) continue;
      const source = [original, file.filename]
        .filter((name) => name && !name.startsWith("<"))
        .flatMap((name) =>
          path.isAbsolute(name)
            ? [name]
            : sourceDirectories.map((dir) => path.resolve(dir, name)),
        )
        .find((candidate) => existsSync(candidate));
      this.sourceFiles.set(id, source || original);
    }
    for (const definition of definitions) {
      if (!definitionKinds[definition.type] || !definition.name) continue;
      if (definition.addr) this.definitions.set(definition.addr, definition);
      this.definitions.set(definition.name, definition);
    }
    const top =
      definitions.find(
        (node) => node.type === "MODULE" && node.level === 1 && !node.inLibrary,
      ) ||
      definitions.find((node) => node.type === "MODULE" && !node.inLibrary);
    if (!top) throw Error("Verilator JSON contains no elaborated top module");
    const name = rtlName(top);
    const dumpedScopes = new Set(signals.map((signal) => signal.scope));
    const candidates = ["TOP." + name, name];
    const topPath =
      candidates.find((scope) =>
        [...dumpedScopes].some(
          (dumped) => dumped === scope || dumped.startsWith(scope + "."),
        ),
      ) || (dumpedScopes.has("TOP") ? "TOP" : name);
    this.top = this.makeScope(topPath, "", top, top);
    this.roots.push(this.top);
    for (const node of definitions) {
      if (
        node.type !== "PACKAGE" ||
        !this.location(node.loc).file ||
        !rtlName(node)
      )
        continue;
      const name = rtlName(node);
      const fullname = dumpedScopes.has("TOP." + name) ? "TOP." + name : name;
      if (!this.scopes.has(fullname))
        this.roots.push(this.makeScope(fullname, "", node, node));
    }
  }

  readonly path: string;

  private location(loc = "") {
    const match = /^([^,]+),(\d+)(?::\d+)?(?:,|$)/.exec(loc);
    return {
      file: (match && this.sourceFiles.get(match[1])) || "",
      line: match ? Number(match[2]) : 0,
    };
  }

  private makeScope(
    fullname: string,
    parent: string,
    node: AstNode,
    definition: AstNode,
  ) {
    const target = this.location(definition.loc);
    const scope = {
      parent,
      node,
      definition,
      record: {
        fullname,
        instance: fullname,
        kind:
          node.type === "CELL"
            ? definitionKinds[definition.type]
            : definitionKinds[node.type] ||
              (node.type === "GENBLOCK" ? "npiGenScope" : "npiNamedBegin"),
        module:
          node === definition || node.type === "CELL"
            ? rtlName(definition)
            : "",
        ...this.location(node.loc),
        definitionFile: target.file,
        definitionLine: target.line,
      },
    };
    this.scopes.set(fullname, scope);
    return scope;
  }

  private members(node: AstNode): Contents {
    const cached = this.contents.get(node);
    if (cached) return cached;
    const result: Contents = { scopes: [], variables: new Map() };
    const pending = [...(node.stmtsp || []), ...(node.itemsp || [])];
    while (pending.length) {
      const member = pending.pop();
      if (member.type === "VAR" && rtlName(member) && !member.isTemp) {
        result.variables.set(rtlName(member), member);
      } else if (isHierarchyNode(member)) {
        result.scopes.push(member);
      } else if (!member.implied) {
        for (const child of member.stmtsp || []) pending.push(child);
        for (const child of member.itemsp || []) pending.push(child);
      }
    }
    this.contents.set(node, result);
    return result;
  }

  private scopeContents(scope: Scope) {
    return this.members(
      scope.node.type === "CELL" ? scope.definition : scope.node,
    );
  }

  private childScopes(scope: Scope) {
    return this.scopeContents(scope).scopes.flatMap((node) => {
      const definition =
        node.type === "CELL"
          ? this.definitions.get(node.modp) ||
            this.definitions.get(node.modName)
          : scope.definition;
      if (!definition) return [];
      const fullname = scope.record.fullname + "." + instanceName(node);
      return [
        this.scopes.get(fullname) ||
          this.makeScope(fullname, scope.record.fullname, node, definition),
      ];
    });
  }

  private lookup(fullname: string): Scope | undefined {
    const found = this.scopes.get(fullname);
    if (found) return found;
    const dot = fullname.lastIndexOf(".");
    if (dot < 0) return undefined;
    const parent = this.lookup(fullname.slice(0, dot));
    return (
      parent &&
      this.childScopes(parent).find(
        (scope) => scope.record.fullname === fullname,
      )
    );
  }

  async resolve(fullname: string) {
    const scope = this.lookup(fullname);
    if (scope) return scope.record;
    let dot = fullname.lastIndexOf(".");
    if (dot < 0) return undefined;
    let parent: Scope | undefined;
    while (dot >= 0) {
      const prefix = fullname.slice(0, dot);
      parent = this.lookup(prefix) || (prefix === "TOP" ? this.top : undefined);
      if (parent) break;
      dot = fullname.lastIndexOf(".", dot - 1);
    }
    if (!parent) return undefined;
    // --trace-structs puts aggregate members under a scope named for the variable.
    const name = fullname
      .slice(dot + 1)
      .split(".", 1)[0]
      .trim();
    const { variables } = this.scopeContents(parent);
    const node =
      variables.get(name) ||
      variables.get(name.replace(/(?:\s*\[-?\d+(?::-?\d+)?\])+$/, ""));
    if (!node) return undefined;
    return {
      ...parent.record,
      ...this.location(node.loc),
      fullname,
      kind: node.varType === "WIRE" ? "npiNet" : "npiReg",
      module: rtlName(parent.definition),
    };
  }

  async children(fullname = "", all = false) {
    const scope = fullname ? this.lookup(fullname) : undefined;
    const objects = fullname
      ? scope
        ? this.childScopes(scope)
        : []
      : this.roots;
    return objects
      .map(({ record }) => record)
      .filter(
        ({ kind }) => all || kind === "npiModule" || kind === "npiGenScope",
      )
      .sort((a, b) =>
        a.fullname.localeCompare(b.fullname, "en", { numeric: true }),
      );
  }

  async instances(module: string) {
    if (!this.byModule) {
      const index = new Map<string, Location[]>();
      const pending = [...this.roots];
      while (pending.length) {
        const scope = pending.pop();
        const { record } = scope;
        if (record.module) {
          const entries = index.get(record.module) || [];
          entries.push(record);
          index.set(record.module, entries);
        }
        for (const child of this.childScopes(scope)) pending.push(child);
      }
      this.byModule = index;
    }
    return this.byModule.get(module) || [];
  }

  async parent(fullname: string) {
    const scope = this.lookup(fullname);
    return scope
      ? scope.parent
      : (await this.resolve(fullname))?.instance || "";
  }

  dispose() {
    this.scopes.clear();
    this.roots = [];
    this.byModule = undefined;
  }
}
