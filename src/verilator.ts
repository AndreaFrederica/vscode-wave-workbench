// SPDX-License-Identifier: MPL-2.0

import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
  ConstantPortDriver,
  DesignGenerateLabel,
  DesignGenerateScope,
  DesignHierarchicalAccess,
  DesignPortLink,
  DesignSession,
  VerilatorArtifacts,
} from "./kdb";
import { codeOnly, simpleAssignmentMacro } from "./rtl-selection";
import {
  portSources,
  type AssignmentValue,
  type DesignPortEndpoint,
  type Location,
  type Signal,
} from "./shared/protocol";

import type {
  SchematicGraph,
  SchematicNode,
  SchematicPortDirection,
} from "./shared/schematic";

const schematicOperators: Record<string, string> = {
  ADD: "+",
  SUB: "−",
  MUL: "×",
  DIV: "÷",
  AND: "AND",
  OR: "OR",
  XOR: "XOR",
  NOT: "NOT",
  EQ: "=",
  NEQ: "≠",
  LT: "<",
  GT: ">",
  LTE: "≤",
  GTE: "≥",
  SHIFTL: "<<",
  SHIFTR: ">>",
};

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
  unnamed?: boolean;
  isTemp?: boolean;
  modp?: string;
  modName?: string;
  varType?: string;
  isParam?: boolean;
  direction?: string;
  modVarp?: string;
  varp?: string;
  dtypep?: string;
  cellp?: string;
  ifacep?: string;
  modportp?: string;
  dotted?: string;
  access?: string;
  keyword?: string;
  edgeType?: string;
  rhsp?: AstNode[];
  pinsp?: AstNode[];
  exprp?: AstNode[];
  valuep?: AstNode[];
  fromp?: AstNode[];
  lsbp?: AstNode[];
  widthConst?: number;
  declRange?: string;
  range?: string;
  declElWidth?: number;
  stmtsp?: AstNode[];
  itemsp?: AstNode[];
  lhsp?: AstNode[];
  varsp?: AstNode[];
}

interface Contents {
  scopes: AstNode[];
  impliedBranches: AstNode[];
  variables: Map<string, AstNode>;
}

interface Scope {
  record: Location;
  parent: string;
  node: AstNode;
  definition: AstNode;
}

interface PortConnections {
  links: DesignPortLink[];
  constants: Map<string, ConstantPortDriver>;
  drivers: Set<string>;
  loads: Set<string>;
}

function packedPortConstant(expression: AstNode) {
  if (expression.type !== "CONST") return undefined;
  const parsed = /^(\d+)'(s?)([bh])([0-9a-fxz]+)$/i.exec(expression.name ?? "");
  if (!parsed) return undefined;
  const width = Number(parsed[1]);
  if (!Number.isInteger(width) || width < 1 || width > 4096) return undefined;
  const digits = parsed[4].toLowerCase();
  const hex = parsed[3].toLowerCase() === "h";
  if (
    digits.length > (hex ? Math.ceil(width / 4) : width) ||
    (!hex && !/^[01xz]+$/.test(digits))
  )
    return undefined;
  const bits = hex
    ? Array.from(digits, (digit) =>
        digit === "x" || digit === "z"
          ? digit.repeat(4)
          : Number.parseInt(digit, 16).toString(2).padStart(4, "0"),
      ).join("")
    : digits;
  const fill = /^[xz]/.test(bits) ? bits[0] : "0";
  return {
    bits: bits.slice(-width).padStart(width, fill),
    signed: !!parsed[2],
  };
}

function packedPortSelection(
  expression: AstNode,
): Pick<DesignPortEndpoint, "bit" | "range"> | undefined {
  if (expression.type === "VARREF") return {};
  if (expression.type !== "SEL" || (expression.declElWidth ?? 1) !== 1)
    return undefined;
  const index = /^\d+'h([\da-f]+)$/i.exec(expression.lsbp?.[0]?.name ?? "");
  const range = /^\[(-?\d+):(-?\d+)\]$/.exec(expression.declRange ?? "");
  const width = expression.widthConst;
  if (
    !index ||
    !range ||
    width === undefined ||
    !Number.isSafeInteger(width) ||
    width < 1
  )
    return undefined;
  const offset = Number.parseInt(index[1], 16);
  const [left, right] = range.slice(1).map(Number);
  if (
    !Number.isSafeInteger(left) ||
    !Number.isSafeInteger(right) ||
    !Number.isSafeInteger(offset) ||
    offset + width - 1 > Math.abs(left - right)
  )
    return undefined;
  const step = left < right ? -1 : 1;
  const end = right + step * offset;
  return width === 1
    ? { bit: end }
    : { range: [end + step * (width - 1), end] };
}

function portDirection(variable: AstNode): SchematicPortDirection | undefined {
  switch (variable.direction) {
    case "INPUT":
      return "input";
    case "OUTPUT":
      return "output";
    case "INOUT":
    case "REF":
      return "inout";
  }
}

const portKey = (instance: string, signal: string) => instance + "\0" + signal;

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
  const data = await fs.readFile(filename);
  return {
    document: JSON.parse(data.toString("utf8")),
    sha256: createHash("sha256").update(data).digest("hex"),
  };
}

export class VerilatorDesign implements DesignSession {
  readonly kind = "verilator";
  private definitions = new Map<string, AstNode>();
  private definitionsByName = new Map<string, AstNode | null>();
  private interfaceTypes = new Map<string, AstNode>();
  private packedRanges = new Map<string, [number, number]>();
  private scopes = new Map<string, Scope>();
  private roots: Scope[] = [];
  private contents = new WeakMap<AstNode, Contents>();
  private generateLabelsByDefinition = new WeakMap<
    AstNode,
    DesignGenerateLabel[]
  >();
  private portConnections = new WeakMap<Scope, PortConnections>();
  private hierarchicalAccessIndex?: {
    byTarget: Map<string, DesignHierarchicalAccess[]>;
    byName: Map<string, DesignHierarchicalAccess[]>;
  };
  private hierarchicalAccessCache = new WeakMap<
    Scope,
    DesignHierarchicalAccess[]
  >();
  private byModule?: Map<string, Location[]>;
  private sourceFiles = new Map<string, string>();
  readonly librarySourceFiles: readonly string[];
  private top: Scope;

  static async open(
    filename: string,
    signals: Signal[],
    sourceDirectories: string[],
  ) {
    filename = path.resolve(verilatorTreeFile(filename) || filename);
    const [treeFile, metadataFile] = await Promise.all([
      readJson(filename),
      readJson(filename.replace(/\.tree\.json$/i, ".tree.meta.json")),
    ]);
    const tree = treeFile.document;
    const meta = metadataFile.document;
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
      {
        treeSha256: treeFile.sha256,
        metadataSha256: metadataFile.sha256,
      },
      tree.miscsp?.find((node: AstNode) => node.type === "TYPETABLE")?.typesp ??
        [],
    );
  }

  private constructor(
    filename: string,
    definitions: AstNode[],
    files: Record<string, { filename?: string; realpath?: string }>,
    signals: Signal[],
    sourceDirectories: string[],
    readonly verilatorArtifacts: VerilatorArtifacts,
    types: AstNode[],
  ) {
    this.path = filename;
    for (const type of types) {
      if (type.type === "IFACEREFDTYPE" && type.addr)
        this.interfaceTypes.set(type.addr, type);
      if (
        type.type === "BASICDTYPE" &&
        type.addr &&
        typeof type.range === "string"
      ) {
        const match = /^(-?\d+):(-?\d+)$/.exec(type.range);
        if (!match) continue;
        const bounds: [number, number] = [Number(match[1]), Number(match[2])];
        if (bounds.every(Number.isSafeInteger))
          this.packedRanges.set(type.addr, bounds);
      }
    }
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
      this.definitionsByName.set(
        definition.name,
        this.definitionsByName.has(definition.name) ? null : definition,
      );
    }
    this.librarySourceFiles = [
      ...new Set(
        definitions
          .filter(
            (node) =>
              node.inLibrary &&
              definitionKinds[node.type] &&
              node.type !== "PACKAGE",
          )
          .map((node) => this.location(node.loc).file)
          .filter(Boolean),
      ),
    ];
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
    const { file, line } = this.sourcePosition(loc);
    return { file, line };
  }

  private sourcePosition(loc = "") {
    const match = /^([^,]+),(\d+)(?::(\d+))?(?:,|$)/.exec(loc);
    return {
      file: (match && this.sourceFiles.get(match[1])) || "",
      line: match ? Number(match[2]) : 0,
      column: Number(match?.[3] ?? 0),
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
    const result: Contents = {
      scopes: [],
      impliedBranches: [],
      variables: new Map(),
    };
    const pending = [...(node.stmtsp || []), ...(node.itemsp || [])];
    while (pending.length) {
      const member = pending.pop();
      if (member.type === "VAR" && rtlName(member) && !member.isTemp) {
        result.variables.set(rtlName(member), member);
      } else if (isHierarchyNode(member)) {
        result.scopes.push(member);
      } else if (
        member.type === "GENBLOCK" &&
        member.implied &&
        instanceName(member)
      ) {
        // Verilator also emits an implied block containing only the loop genvar.
        const items = [...(member.stmtsp ?? []), ...(member.itemsp ?? [])];
        if (
          items.some((item) => item.type !== "VAR" || item.varType !== "GENVAR")
        )
          result.impliedBranches.push(member);
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

  hierarchicalAccesses(instance: string): readonly DesignHierarchicalAccess[] {
    const scope = this.lookup(instance);
    if (!scope) return [];
    const cached = this.hierarchicalAccessCache.get(scope);
    if (cached) return cached;
    const reads: DesignHierarchicalAccess[] = [];
    const pending = [
      {
        node: scope.node.type === "CELL" ? scope.definition : scope.node,
        consumer: undefined as DesignHierarchicalAccess["consumer"],
      },
    ];
    while (pending.length) {
      const { node, consumer } = pending.pop()!;
      let output = consumer;
      if (node.type.startsWith("ASSIGN")) {
        const [lhs] = node.lhsp ?? [];
        const signal = lhs && rtlName(lhs);
        output =
          node.lhsp?.length === 1 &&
          lhs.type === "VARREF" &&
          signal &&
          this.scopeContents(scope).variables.get(signal)?.addr === lhs.varp
            ? { instance, signal }
            : undefined;
      }
      if (
        node.type === "VARXREF" &&
        (node.access === "RD" || node.access === "WR") &&
        node.dotted &&
        node.varp
      ) {
        const signal = rtlName(node);
        const position = this.sourcePosition(node.loc);
        const target =
          signal &&
          this.resolveDottedScope(scope, node.dotted, signal, node.varp);
        if (
          signal &&
          target &&
          position.file &&
          position.line &&
          position.column
        )
          reads.push({
            ...position,
            instance: target.scope.record.fullname,
            signal: target.signal,
            consumer,
            owner: instance,
            write: node.access === "WR",
          });
      }
      for (const child of Object.values(node)) {
        if (!Array.isArray(child)) continue;
        for (const entry of child) {
          if (entry?.type && !isHierarchyNode(entry))
            pending.push({ node: entry, consumer: output });
        }
      }
    }
    this.hierarchicalAccessCache.set(scope, reads);
    return reads;
  }

  private scopedAccessIndex() {
    if (!this.hierarchicalAccessIndex) {
      const byTarget = new Map<string, DesignHierarchicalAccess[]>();
      const byName = new Map<string, DesignHierarchicalAccess[]>();
      const pending = [...this.roots];
      const seen = new Set<Scope>();
      while (pending.length) {
        const scope = pending.pop()!;
        if (seen.has(scope)) continue;
        seen.add(scope);
        for (const read of this.hierarchicalAccesses(scope.record.fullname)) {
          for (const [index, identity] of [
            [byTarget, read.instance + "\0" + read.signal],
            [byName, read.signal],
          ] as const) {
            const accesses = index.get(identity);
            if (accesses) accesses.push(read);
            else index.set(identity, [read]);
          }
        }
        for (const child of this.childScopes(scope)) pending.push(child);
      }
      this.hierarchicalAccessIndex = { byTarget, byName };
    }
    return this.hierarchicalAccessIndex;
  }

  private hierarchicalUsages(instance: string, signal: string) {
    return (
      this.scopedAccessIndex().byTarget.get(instance + "\0" + signal) ?? []
    );
  }

  hierarchicalAccessSites(signal: string) {
    return this.scopedAccessIndex().byName.get(signal) ?? [];
  }

  hierarchicalConsumers(instance: string, signal: string) {
    return this.hierarchicalUsages(instance, signal).filter(
      ({ write }) => !write,
    );
  }

  hierarchicalWriters(instance: string, signal: string) {
    return this.hierarchicalUsages(instance, signal).filter(
      ({ write }) => write,
    );
  }

  private resolveDottedScope(
    scope: Scope,
    dotted: string,
    signal: string,
    variable: string,
  ) {
    const alias = this.scopeContents(scope).variables.get(dotted);
    if (alias?.varType === "IFACEREF") {
      const target = this.interfaceScope(scope, alias);
      if (!target) return undefined;
      const variables = this.scopeContents(target).variables;
      if (variables.get(signal)?.addr === variable)
        return { scope: target, signal };
      const modport = this.interfaceTypes.get(alias.dtypep)?.modportp;
      const member = target.definition.stmtsp
        ?.find((item) => item.type === "MODPORT" && item.addr === modport)
        ?.varsp?.find(
          (item) => rtlName(item) === signal && item.varp === variable,
        );
      const [reference] = member?.exprp ?? [];
      const underlying = reference && rtlName(reference);
      return member?.exprp?.length === 1 &&
        reference.type === "VARREF" &&
        reference.varp === variable &&
        underlying &&
        variables.get(underlying)?.addr === variable
        ? { scope: target, signal: underlying }
        : undefined;
    }
    const find = (candidate: string) => {
      const owner = this.lookup(candidate);
      return owner &&
        this.scopeContents(owner).variables.get(signal)?.addr === variable
        ? { scope: owner, signal }
        : undefined;
    };
    if (!dotted.startsWith("$root.")) {
      for (
        let owner: Scope | undefined = scope;
        owner;
        owner = this.lookup(owner.parent)
      ) {
        const target = find(owner.record.fullname + "." + dotted);
        if (target) return target;
      }
    }
    const absolute = dotted.replace(/^\$root\./, "");
    return find(absolute) ?? find("TOP." + absolute);
  }

  private interfaceScope(scope: Scope, variable: AstNode): Scope | undefined {
    const type = this.interfaceTypes.get(variable.dtypep);
    if (!type) return undefined;
    if (type.cellp)
      return this.childScopes(scope).find(
        (child) =>
          child.node.addr === type.cellp && child.definition.type === "IFACE",
      );
    const parent = this.lookup(scope.parent);
    if (!parent || !variable.addr) return undefined;
    const [pin, duplicate] = (scope.node.pinsp ?? []).filter(
      (pin) => pin.modVarp === variable.addr,
    );
    const [reference] = pin?.exprp ?? [];
    if (
      duplicate ||
      pin?.exprp?.length !== 1 ||
      reference?.type !== "VARREF" ||
      !reference.varp
    )
      return undefined;
    const actual = [...this.scopeContents(parent).variables.values()].find(
      (item) => item.addr === reference.varp && item.varType === "IFACEREF",
    );
    const target = actual && this.interfaceScope(parent, actual);
    return target && (!type.ifacep || type.ifacep === target.definition.addr)
      ? target
      : undefined;
  }

  generateLabels(instance: string): readonly DesignGenerateLabel[] {
    const definition = this.lookup(instance)?.definition;
    if (!definition) return [];
    const cached = this.generateLabelsByDefinition.get(definition);
    if (cached) return cached;
    const labels: DesignGenerateLabel[] = [];
    const pending = [definition];
    while (pending.length) {
      const node = pending.pop()!;
      if (node.type === "GENBLOCK" && (!node.implied || node.unnamed)) {
        const name = instanceName(node);
        const position = this.sourcePosition(node.loc);
        if (name && position.file && position.line && position.column)
          labels.push({
            ...position,
            name,
            unnamed: node.unnamed || undefined,
          });
      }
      for (const child of node.stmtsp ?? []) pending.push(child);
      for (const child of node.itemsp ?? []) pending.push(child);
    }
    this.generateLabelsByDefinition.set(definition, labels);
    return labels;
  }

  private generateScopeNodes(container: AstNode) {
    const { scopes, impliedBranches } = this.members(container);
    return [
      ...scopes.filter((node) => node.type === "GENBLOCK"),
      ...impliedBranches,
    ];
  }

  private generateContainer(instance: string): AstNode | undefined {
    const physical = this.lookup(instance);
    if (physical)
      return physical.node.type === "CELL"
        ? physical.definition
        : physical.node;
    const dot = instance.lastIndexOf(".");
    if (dot < 0) return;
    const parent = this.generateContainer(instance.slice(0, dot));
    if (!parent) return;
    const name = instance.slice(dot + 1);
    const matches = this.generateScopeNodes(parent).filter(
      (node) => instanceName(node) === name,
    );
    if (matches.length === 1) return matches[0];
  }

  generateScopes(instance: string): readonly DesignGenerateScope[] {
    const container = this.generateContainer(instance);
    if (!container) return [];
    return this.generateScopeNodes(container)
      .map((node) => ({
        fullname: instance + "." + instanceName(node),
        ...this.sourcePosition(node.loc),
      }))
      .sort((a, b) =>
        a.fullname.localeCompare(b.fullname, "en", { numeric: true }),
      );
  }

  private childScopes(scope: Scope) {
    return this.scopeContents(scope).scopes.flatMap((node) => {
      const definition =
        node.type === "CELL"
          ? this.definitions.get(node.modp) ||
            this.definitionsByName.get(node.modName)
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
    const parameter =
      node.isParam || node.varType === "GPARAM" || node.varType === "LPARAM";
    const value =
      parameter && node.valuep?.length === 1
        ? packedPortConstant(node.valuep[0])
        : undefined;
    return {
      ...parent.record,
      ...this.location(node.loc),
      fullname,
      kind: parameter
        ? "npiParameter"
        : node.varType === "WIRE"
          ? "npiNet"
          : "npiReg",
      module: rtlName(parent.definition),
      packedRange: node.dtypep && this.packedRanges.get(node.dtypep),
      ...(value && { parameterValue: value }),
    };
  }

  async executionStatements(instance: string, signal: string) {
    const scope =
      this.lookup(instance) ?? this.lookup(instance.replace(/^TOP\./, ""));
    const variable = scope && this.scopeContents(scope).variables.get(signal);
    if (!scope || !variable?.addr)
      throw Error(
        "Verilator source map has no signal " + instance + "." + signal,
      );

    const statements = [];
    const processKinds = new Set(["ALWAYS", "INITIAL", "FINAL"]);
    const beginSite = (body?: AstNode) => {
      const first = body?.stmtsp?.[0];
      if (body?.type !== "BEGIN" || !first) return undefined;
      return {
        begin: this.sourcePosition(body.loc),
        first: this.sourcePosition(first.lhsp?.[0]?.loc ?? first.loc),
      };
    };
    type BeginSite = NonNullable<ReturnType<typeof beginSite>>;
    const pending =
      (scope.node.type === "CELL" ? scope.definition : scope.node).stmtsp?.map(
        (node) => ({
          node,
          process: undefined as AstNode | undefined,
          statement: true,
          branches: [] as BeginSite[],
        }),
      ) ?? [];
    const visited = new Set<AstNode>();
    while (pending.length) {
      const { node, process, statement, branches } = pending.pop()!;
      if (visited.has(node) || isHierarchyNode(node)) continue;
      visited.add(node);
      const owner = processKinds.has(node.type) ? node : process;
      if (owner && node.type.startsWith("ASSIGN")) {
        const [target, ...others] = node.lhsp ?? [];
        if (
          target?.type === "VARREF" &&
          target.varp === variable.addr &&
          !others.length
        ) {
          const kind =
            node.type === "ASSIGNDLY"
              ? "nonblocking"
              : node.type === "ASSIGN"
                ? "blocking"
                : "unsupported";
          statements.push({
            kind,
            source: this.sourcePosition(target.loc),
            process: this.sourcePosition(owner.loc),
            operator: statement ? this.sourcePosition(node.loc) : undefined,
            processBody: beginSite(owner.stmtsp?.[0]),
            branches,
          });
        }
      }
      for (const [field, children] of Object.entries(node)) {
        if (field === "lhsp" || !Array.isArray(children)) continue;
        const statement = ["stmtsp", "thensp", "elsesp", "bodysp"].includes(
          field,
        );
        for (const child of children) {
          if (!child?.type) continue;
          const branch =
            node.type === "IF" &&
            (field === "thensp" || field === "elsesp") &&
            beginSite(child);
          pending.push({
            node: child,
            process: owner,
            statement,
            branches: branch ? [...branches, branch] : branches,
          });
        }
      }
    }
    const ordered = statements.sort(
      (a, b) =>
        a.source.file.localeCompare(b.source.file) ||
        a.source.line - b.source.line ||
        a.source.column - b.source.column,
    );
    const contents = new Map<string, { lines: string[]; sha256: string }>();
    for (const { source, process } of ordered) {
      for (const { file } of [source, process]) {
        if (!file || contents.has(file)) continue;
        const data = await fs.readFile(file).catch(() => undefined);
        if (data)
          contents.set(file, {
            lines: data.toString("utf8").split(/\r?\n/),
            sha256: createHash("sha256").update(data).digest("hex"),
          });
      }
    }
    const id = (identity: unknown[]) =>
      createHash("sha256").update(JSON.stringify(identity)).digest("hex");
    return ordered.map(
      ({ source, process, kind, operator, processBody, branches }) => {
        const sourceFile = contents.get(source.file);
        const processFile = contents.get(process.file);
        const lineText = sourceFile?.lines[source.line - 1];
        const reported = source;
        if (
          lineText &&
          operator?.line === source.line &&
          operator.file === source.file &&
          kind !== "unsupported"
        ) {
          const escaped = signal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const token = kind === "nonblocking" ? "<=" : "=(?!=)";
          const lexical = codeOnly(lineText);
          const pattern = new RegExp(
            "(?<![\\w$.])" + escaped + "(\\s*)(" + token + ")",
            "g",
          );
          const logicalColumn = (position: number) =>
            lineText
              .slice(0, position)
              .replace(/"(?:\\.|[^"\\])*"|\/\*.*?\*\//g, (token) =>
                token.startsWith("/") ? " " : token,
              ).length + 1;
          const matches = [...lexical.matchAll(pattern)].filter((match) => {
            const operatorOffset =
              match.index + signal.length + match[1].length;
            return (
              (match.index + 1 === source.column &&
                operatorOffset + 1 === operator!.column) ||
              (logicalColumn(match.index) === source.column &&
                logicalColumn(operatorOffset) === operator!.column)
            );
          });
          const physical = matches.length === 1 ? matches[0] : undefined;
          if (physical) {
            source = { ...source, column: physical.index + 1 };
            operator = {
              ...operator,
              column: physical.index + signal.length + physical[1].length + 1,
            };
          } else {
            operator = undefined;
          }
        }
        const text = lineText?.slice(source.column - 1);
        const expanded =
          sourceFile &&
          simpleAssignmentMacro(sourceFile.lines, source.line, source.column);
        const macro =
          expanded &&
          expanded.lhs === signal &&
          (kind === "nonblocking"
            ? expanded.operator === "<="
            : kind === "blocking" && expanded.operator === "=")
            ? {
                name: expanded.name,
                definition: {
                  file: source.file,
                  sha256: sourceFile.sha256,
                  ...expanded.definition,
                },
              }
            : undefined;
        if (
          !processFile ||
          !process.line ||
          !process.column ||
          !sourceFile ||
          !source.column ||
          (!macro &&
            (!text?.startsWith(signal) ||
              /[\w$]/.test(text[signal.length] ?? "")))
        )
          return {
            kind,
            source,
            process,
            diagnostic: /^`[a-zA-Z_][\w$]*/.test(text ?? "")
              ? ("unsupportedMacroExpansion" as const)
              : ("sourceUnmapped" as const),
          };
        const adjustEntry = (entry: BeginSite | undefined) =>
          entry?.first.file === reported.file &&
          entry.first.line === reported.line &&
          entry.first.column === reported.column
            ? { ...entry, first: source }
            : entry;
        return {
          kind,
          source: { ...source, sha256: sourceFile.sha256 },
          process: { ...process, sha256: processFile.sha256 },
          operator: macro ? source : operator,
          ...(macro ? { macro } : {}),
          processBody: adjustEntry(processBody),
          branches: branches.length ? branches.map(adjustEntry) : undefined,
          processId: id([
            instance,
            processFile.sha256,
            process.line,
            process.column,
          ]),
          statementId: id([
            instance,
            signal,
            kind,
            sourceFile.sha256,
            source.line,
            source.column,
          ]),
        };
      },
    );
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

  private portParent(child: Scope, ref: AstNode) {
    const name = rtlName(ref);
    if (!ref.varp || !name) return undefined;
    let parent = this.lookup(child.parent);
    while (parent) {
      const variable = this.scopeContents(parent).variables.get(name);
      if (variable?.addr === ref.varp)
        return { instance: parent.record.fullname, signal: name };
      if (parent.record.module) break;
      parent = this.lookup(parent.parent);
    }
    return undefined;
  }

  private outputSelectIndex(
    child: Scope,
    index: AstNode,
    range: [number, number],
    width: number,
  ): DesignPortLink["targetSelectIndex"] {
    const operands: DesignPortEndpoint[] = [];
    const lower = (node: AstNode, depth = 0): AssignmentValue | undefined => {
      if (depth >= 8) return undefined;
      const lowerChild = (nodes?: AstNode[]) =>
        nodes?.length === 1 ? lower(nodes[0], depth + 1) : undefined;
      if (node.type === "VARREF") {
        const endpoint = this.portParent(child, node);
        if (!endpoint) return undefined;
        const slot = operands.findIndex(
          ({ instance, signal }) =>
            instance === endpoint.instance && signal === endpoint.signal,
        );
        if (slot >= 0) return { op: "signal", args: slot };
        return { op: "signal", args: operands.push(endpoint) - 1 };
      }
      const constant = packedPortConstant(node);
      if (constant) return { op: "literal", args: [constant.bits, false] };
      if (node.type === "SEL") {
        const source = lowerChild(node.fromp);
        const first = node.lsbp?.[0] && packedPortConstant(node.lsbp[0]);
        const size = node.widthConst;
        if (!source || !first || !size || !/^[01]+$/.test(first.bits))
          return undefined;
        const right = Number.parseInt(first.bits, 2);
        if (right + size > 64) return undefined;
        return { op: "slice", args: [source, right + size - 1, right] };
      }
      if (node.type !== "ADD" && node.type !== "SUB") return undefined;
      const bounds = node.dtypep && this.packedRanges.get(node.dtypep);
      const left = lowerChild(node.lhsp);
      const right = lowerChild(node.rhsp);
      if (!bounds || !left || !right) return undefined;
      const size = Math.abs(bounds[0] - bounds[1]) + 1;
      if (size > 64) return undefined;
      const leftValue: AssignmentValue = {
        op: "cast",
        args: [size, false, false, left],
      };
      const rightValue: AssignmentValue = {
        op: "cast",
        args: [size, false, false, right],
      };
      return {
        op: "binary",
        args: [node.type === "ADD" ? "add" : "subtract", leftValue, rightValue],
      };
    };
    let value = lower(index);
    if (!value || !operands.length) return undefined;
    const [left, right] = range;
    const descending = left >= right;
    if (right !== 0 || !descending) {
      // The tree's index starts at the physical least-significant end.
      const base: AssignmentValue = {
        op: "literal",
        args: [
          BigInt.asUintN(64, BigInt(right)).toString(2).padStart(64, "0"),
          true,
        ],
      };
      const offset: AssignmentValue = {
        op: "cast",
        args: [
          64,
          true,
          false,
          { op: "cast", args: [null, false, false, value] },
        ],
      };
      value = {
        op: "binary",
        args: descending ? ["add", base, offset] : ["subtract", base, offset],
      };
    }
    return {
      operands,
      value,
      part: width === 1 ? undefined : { width, ascendingIndices: descending },
    };
  }

  private pinLinks(
    child: Scope,
    result: PortConnections,
    requireSource = true,
  ) {
    const childPorts = new Map(
      [...this.scopeContents(child).variables.values()]
        .filter((variable) => variable.addr)
        .map((variable) => [variable.addr, variable]),
    );
    for (const pin of child.node.pinsp ?? []) {
      const port = childPorts.get(pin.modVarp);
      const portName = port && rtlName(port);
      if (
        !portName ||
        !["INPUT", "OUTPUT", "INOUT", "REF"].includes(port.direction ?? "")
      )
        continue;
      const [expression] = pin.exprp ?? [];
      if (!expression) continue;
      const inside = { instance: child.record.fullname, signal: portName };
      const input = port.direction !== "OUTPUT";
      const output = port.direction !== "INPUT";
      const ref =
        expression.type === "SEL" ? expression.fromp?.[0] : expression;
      const selection = packedPortSelection(expression);
      const parent =
        ref?.type === "VARREF" ? this.portParent(child, ref) : undefined;
      const { file, line } = this.location(pin.loc);
      if (parent && selection && (!requireSource || (file && line >= 1))) {
        const outside = { ...parent, ...selection };
        if (input) result.links.push({ from: outside, to: inside, file, line });
        if (output)
          result.links.push({ from: inside, to: outside, file, line });
        continue;
      }
      const width = expression.widthConst;
      const index = expression.lsbp?.[0];
      const portRange = port.dtypep && this.packedRanges.get(port.dtypep);
      const range = /^\[(-?\d+):(-?\d+)\]$/.exec(expression.declRange ?? "");
      if (
        port.direction === "OUTPUT" &&
        expression.type === "SEL" &&
        parent &&
        range &&
        expression.declElWidth === 1 &&
        typeof width === "number" &&
        Number.isSafeInteger(width) &&
        width === (portRange ? Math.abs(portRange[0] - portRange[1]) + 1 : 1) &&
        index &&
        (!requireSource || (file && line >= 1))
      ) {
        const bounds: [number, number] = [Number(range[1]), Number(range[2])];
        const selector = bounds.every(Number.isSafeInteger)
          ? this.outputSelectIndex(child, index, bounds, width)
          : undefined;
        if (selector) {
          result.links.push({
            from: inside,
            to: parent,
            file,
            line,
            targetSelectIndex: selector,
          });
          continue;
        }
      }
      const insideKey = portKey(inside.instance, inside.signal);
      if (
        port.direction === "INPUT" &&
        (!requireSource || (file && line >= 1))
      ) {
        const constant = packedPortConstant(expression);
        if (constant) {
          result.constants.set(insideKey, { ...constant, file, line });
          continue;
        }
      }
      if (input) result.drivers.add(insideKey);
      if (output) result.loads.add(insideKey);
      const pending = [expression];
      while (pending.length) {
        const node = pending.pop();
        if (node.type === "VARREF") {
          const endpoint = this.portParent(child, node);
          if (!endpoint) continue;
          const key = portKey(endpoint.instance, endpoint.signal);
          if (input) result.loads.add(key);
          if (output) result.drivers.add(key);
        } else {
          for (const children of Object.values(node))
            if (Array.isArray(children))
              for (const value of children)
                if (value && typeof value.type === "string")
                  pending.push(value);
        }
      }
    }
  }

  private schematicLogic(
    owner: Scope,
    graph: SchematicGraph,
    addNet: (endpoint: DesignPortEndpoint) => string,
  ) {
    const instance = owner.record.fullname;
    const container =
      owner.node.type === "CELL" ? owner.definition : owner.node;
    for (const [index, statement] of [
      ...(container.stmtsp ?? []),
      ...(container.itemsp ?? []),
    ].entries()) {
      if (!["ALWAYS", "ASSIGNW"].includes(statement.type)) continue;
      const inputs = new Set<string>();
      const outputs = new Set<string>();
      const pending = [statement];
      const keyword = statement.keyword;
      const continuous =
        keyword === "cont_assign" || statement.type === "ASSIGNW";
      const assignment =
        continuous && statement.type === "ALWAYS"
          ? statement.stmtsp?.[0]
          : statement;
      const rhs = continuous ? assignment?.rhsp?.[0]?.type : undefined;
      let clocked = keyword === "always_ff";
      while (pending.length) {
        const expression = pending.pop()!;
        if (
          expression.type === "SENITEM" &&
          /^(ET_)?(POS|NEG|POSEDGE|NEGEDGE)$/i.test(expression.edgeType ?? "")
        )
          clocked = true;
        if (expression.type === "VARREF") {
          const signal = rtlName(expression);
          let scope = owner;
          while (
            scope &&
            this.scopeContents(scope).variables.get(signal)?.addr !==
              expression.varp
          ) {
            if (scope.record.module) break;
            scope = this.lookup(scope.parent);
          }
          if (
            !scope ||
            !signal ||
            !expression.varp ||
            this.scopeContents(scope).variables.get(signal)?.addr !==
              expression.varp
          ) {
            if (!expression.isTemp) graph.partial = true;
            continue;
          }
          const net = addNet({ instance: scope.record.fullname, signal });
          if (expression.access === "RD" || expression.access === "RW")
            inputs.add(net);
          if (expression.access === "WR" || expression.access === "RW")
            outputs.add(net);
        } else if (
          ["VARXREF", "TASKREF", "FUNCREF"].includes(expression.type)
        ) {
          graph.partial = true;
        }
        for (const children of Object.values(expression))
          if (Array.isArray(children))
            for (const child of children)
              if (
                child?.type &&
                !(child.type === "CELL" || child.type === "GENBLOCK")
              )
                pending.push(child);
      }
      if (!inputs.size && !outputs.size) continue;
      const id = "logic:" + instance + ":" + index;
      const location = this.location(statement.loc);
      const mux = rhs === "COND";
      const operator = rhs && schematicOperators[rhs];
      const label = mux
        ? "MUX"
        : operator || (continuous ? "assign" : keyword || "always");
      graph.nodes.push({
        id,
        instance,
        kind: clocked ? "register" : mux ? "mux" : "logic",
        label,
        detail: location.line ? "L" + location.line : "",
        location,
        source: !!location.file && location.line > 0,
      });
      for (const net of inputs) graph.edges.push({ from: net, to: id });
      for (const net of outputs) graph.edges.push({ from: id, to: net });
    }
  }

  moduleSchematic(fullname?: string): SchematicGraph {
    let scope = fullname ? this.lookup(fullname) : this.top;
    while (scope && !scope.record.module) scope = this.lookup(scope.parent);
    if (
      !scope ||
      !["npiModule", "npiInterface", "npiProgram"].includes(scope.record.kind)
    )
      throw Error("Unknown elaborated module: " + fullname);

    const { fullname: instance, module: name } = scope.record;
    let parent = this.lookup(scope.parent);
    while (parent && !parent.record.module) parent = this.lookup(parent.parent);
    const graph: SchematicGraph = {
      root: "",
      nodes: [],
      edges: [],
      partial: false,
      module: { instance, name, parent: parent?.record.fullname },
    };
    const netId = (endpoint: DesignPortEndpoint) =>
      "net:" + endpoint.instance + "." + endpoint.signal;
    const nets = new Map<string, SchematicNode>();
    const addNet = (endpoint: DesignPortEndpoint) => {
      const id = netId(endpoint);
      if (!nets.has(id)) {
        const node: SchematicNode = {
          id,
          kind: "net",
          label: endpoint.signal,
          detail: "",
          instance: endpoint.instance,
          signal: endpoint.signal,
          source: true,
        };
        nets.set(id, node);
        graph.nodes.push(node);
      }
      return id;
    };
    for (const [signal, variable] of this.scopeContents(scope).variables) {
      const direction = portDirection(variable);
      if (!direction) {
        if (this.interfaceTypes.has(variable.dtypep)) graph.partial = true;
        continue;
      }
      const endpoint = { instance, signal };
      const id = "port:" + signal;
      graph.nodes.push({
        id,
        instance,
        signal,
        kind: "port",
        direction,
        label: signal,
        detail: direction,
        source: true,
      });
      const net = addNet(endpoint);
      graph.edges.push(
        direction === "output"
          ? { from: net, to: id }
          : {
              from: id,
              to: net,
              bidirectional: direction === "inout",
            },
      );
    }

    const pending = [scope];
    while (pending.length) {
      const owner = pending.pop()!;
      this.schematicLogic(owner, graph, addNet);
      const children = this.childScopes(owner);
      if (children.length < this.scopeContents(owner).scopes.length)
        graph.partial = true;
      for (const child of children) {
        if (child.node.type !== "CELL") {
          pending.push(child);
          continue;
        }
        const childName = child.record.fullname;
        const id = "module:" + childName;
        const node: SchematicNode = {
          id,
          kind: "module",
          label: childName.slice(instance.length + 1),
          detail: child.record.module,
          instance: childName,
          source: !!child.record.file,
          ports: [],
        };
        graph.nodes.push(node);
        const connections: PortConnections = {
          links: [],
          constants: new Map(),
          drivers: new Set(),
          loads: new Set(),
        };
        this.pinLinks(child, connections, false);
        const connected = new Set<string>();
        for (const { from, to } of connections.links) {
          if (!from) continue;
          const output = from.instance === childName;
          const inside = output ? from : to;
          const outside = output ? to : from;
          const direction = portDirection(
            this.scopeContents(child).variables.get(inside.signal)!,
          );
          if (direction === "inout" && output) continue;
          connected.add(inside.signal);
          const net = addNet(outside);
          const pin = id + ":pin:" + inside.signal;
          const label = outside.range
            ? `[${outside.range.join(":")}]`
            : outside.bit === undefined
              ? undefined
              : `[${outside.bit}]`;
          graph.edges.push(
            output
              ? { from: id, fromPort: pin, to: net, label }
              : {
                  from: net,
                  to: id,
                  toPort: pin,
                  label,
                  bidirectional: direction === "inout",
                },
          );
        }
        const pinAddresses = new Set(
          (child.node.pinsp ?? [])
            .filter((pin) => pin.exprp?.length)
            .map((pin) => pin.modVarp),
        );
        for (const [signal, variable] of this.scopeContents(child).variables) {
          const direction = portDirection(variable);
          if (!direction) {
            if (this.interfaceTypes.has(variable.dtypep)) graph.partial = true;
            continue;
          }
          const pin = id + ":pin:" + signal;
          const constant = connections.constants.get(
            portKey(childName, signal),
          );
          if (constant) {
            const value = `${constant.bits.length}'${constant.signed ? "s" : ""}b${constant.bits}`;
            const constantId = pin + ":constant";
            graph.nodes.push({
              id: constantId,
              kind: "constant",
              label: value,
              detail: "",
            });
            graph.edges.push({ from: constantId, to: id, toPort: pin });
            connected.add(signal);
          }
          const status = connected.has(signal)
            ? undefined
            : pinAddresses.has(variable.addr)
              ? "unresolved"
              : "open";
          if (status === "unresolved") graph.partial = true;
          node.ports!.push({ id: pin, label: signal, direction, status });
        }
      }
    }
    // Keep visible instance and pin ordering stable across repeated layouts.
    graph.nodes.sort((a, b) =>
      a.label.localeCompare(b.label, "en", { numeric: true }),
    );
    const logicUnits = graph.nodes.filter(({ id }) =>
      id.startsWith("logic:"),
    ).length;
    if (logicUnits) graph.module!.logicStatus = `RTL 逻辑单元 ${logicUnits}`;
    return graph;
  }

  private resolvePortConnections(instance: string) {
    const scope = this.lookup(instance);
    if (!scope) return undefined;
    const cached = this.portConnections.get(scope);
    if (cached) return cached;
    const result: PortConnections = {
      links: [],
      constants: new Map(),
      drivers: new Set(),
      loads: new Set(),
    };
    this.pinLinks(scope, result);
    const children = this.childScopes(scope);
    while (children.length) {
      const child = children.pop();
      if (child.node.type === "CELL") this.pinLinks(child, result);
      else children.push(...this.childScopes(child));
    }
    this.portConnections.set(scope, result);
    return result;
  }

  unresolvedPortExpression(
    instance: string,
    signal: string,
    direction: "drivers" | "loads",
  ) {
    return (
      this.resolvePortConnections(instance)?.[direction].has(
        portKey(instance, signal),
      ) ?? false
    );
  }

  constantPortDriver(instance: string, signal: string) {
    return this.resolvePortConnections(instance)?.constants.get(
      portKey(instance, signal),
    );
  }

  async portLinks(instance: string, signal: string) {
    return (
      this.resolvePortConnections(instance)?.links.filter(
        (link) =>
          (link.to.instance === instance && link.to.signal === signal) ||
          portSources(link).some(
            (endpoint) =>
              endpoint.instance === instance && endpoint.signal === signal,
          ),
      ) ?? []
    );
  }

  dispose() {
    this.scopes.clear();
    this.roots = [];
    this.byModule = undefined;
  }
}
