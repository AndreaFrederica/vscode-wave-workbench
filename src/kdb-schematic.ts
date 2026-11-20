// SPDX-License-Identifier: MPL-2.0

import { fileURLToPath } from "node:url";
import type { KdbSession } from "./kdb";
import { traceSignalScope, type VideTrace } from "./rtl-trace";
import type { DesignPortEndpoint, Location } from "./shared/protocol";
import type {
  SchematicGraph,
  SchematicNode,
  SchematicPort,
} from "./shared/schematic";

const moduleKinds = new Set(["npiModule", "npiProgram"]);
const containerKinds = new Set([
  "npiGenScope",
  "npiModuleArray",
  "npiProgramArray",
]);

const portId = (node: SchematicNode, signal: string) =>
  node.id + ":pin:" + signal;

function selection(endpoint: DesignPortEndpoint) {
  const range =
    endpoint.range ?? (endpoint.bit === undefined ? undefined : [endpoint.bit]);
  if (!range) return undefined;
  const text = range[0] === range[1] ? String(range[0]) : range.join(":");
  return "[" + text + "]";
}

async function kdbModuleScope(design: KdbSession, name: string) {
  while (name) {
    const scope = await design.resolve(name);
    if (scope && moduleKinds.has(scope.kind)) return scope;
    name = await design.parent(name);
  }
}

async function childModules(design: KdbSession, instance: string) {
  const result: Location[] = [];
  const pending = [instance];
  while (pending.length) {
    for (const child of await design.children(pending.pop()!)) {
      if (moduleKinds.has(child.kind)) result.push(child);
      else if (containerKinds.has(child.kind)) pending.push(child.fullname);
    }
  }
  return result;
}

export function kdbSchematicRoots(design: KdbSession) {
  return childModules(design, "");
}

export async function kdbModuleSchematic(
  design: KdbSession,
  fullname: string,
  readLogic?: (scope: Location) => Promise<VideTrace>,
): Promise<SchematicGraph> {
  const scope = await kdbModuleScope(design, fullname);
  if (!scope) throw Error("Unknown elaborated KDB module: " + fullname);
  const instance = scope.fullname;
  const [parent, children, scan] = await Promise.all([
    design.parent(instance).then((name) => kdbModuleScope(design, name)),
    childModules(design, instance),
    design.scanPorts(instance),
  ]);
  const graph: SchematicGraph = {
    root: "",
    module: { instance, name: scope.module, parent: parent?.fullname },
    partial: scan.truncated || !scan.ports || !!scan.portsIncomplete,
    nodes: [],
    edges: [],
  };
  const nets = new Set<string>();
  const modules = new Map<string, SchematicNode & { ports: SchematicPort[] }>();
  const pins = new Map<string, SchematicPort>();
  const addNet = (endpoint: DesignPortEndpoint) => {
    const { instance: owner, signal, field } = endpoint;
    const name = field ? signal + "." + field : signal;
    const id = "net:" + owner + "." + name;
    if (nets.has(id)) return id;
    nets.add(id);
    graph.nodes.push({
      id,
      kind: "net",
      label: name,
      detail: owner === instance ? "" : owner.slice(instance.length + 1),
      source: true,
      instance: owner,
      signal: name,
    });
    return id;
  };
  for (const child of children) {
    const node = {
      id: "module:" + child.fullname,
      kind: "module" as const,
      instance: child.fullname,
      label: child.fullname.slice(instance.length + 1),
      detail: child.module,
      ports: [],
      source: true,
    };
    modules.set(child.fullname, node);
    graph.nodes.push(node);
  }
  for (const port of scan.ports ?? []) {
    const node = modules.get(port.instance);
    if (node) {
      const id = portId(node, port.signal);
      if (pins.has(id)) continue;
      const pin: SchematicPort = {
        id,
        label: port.signal,
        direction: port.direction,
        status: "open",
      };
      pins.set(id, pin);
      node.ports.push(pin);
    } else if (port.instance === instance) {
      const id = "port:" + port.signal;
      graph.nodes.push({
        id,
        instance,
        signal: port.signal,
        kind: "port",
        direction: port.direction,
        label: port.signal,
        detail: port.direction,
        source: true,
      });
      const net = addNet(port);
      graph.edges.push(
        port.direction === "output"
          ? { from: net, to: id }
          : {
              from: id,
              to: net,
              bidirectional: port.direction === "inout",
            },
      );
    }
  }

  function visible(owner: string) {
    if (owner === instance || modules.has(owner)) return true;
    if (!owner.startsWith(instance + ".")) return false;
    for (
      let end = owner.lastIndexOf(".");
      end > instance.length;
      end = owner.lastIndexOf(".", end - 1)
    )
      if (modules.has(owner.slice(0, end))) return false;
    return true;
  }
  const connected = new Set<string>();
  const endpoint = (
    terminal: DesignPortEndpoint,
    direction: "input" | "output",
  ) => {
    const node = modules.get(terminal.instance);
    if (!node) return { id: addNet(terminal) };
    const id = portId(node, terminal.signal);
    let pin = pins.get(id);
    if (!pin) {
      graph.partial = true;
      pin = { id, label: terminal.signal, direction };
      pins.set(id, pin);
      node.ports.push(pin);
    }
    pin.status = undefined;
    connected.add(id);
    return { id: node.id, pin };
  };
  const wires = new Set<string>();
  const wire = (from: DesignPortEndpoint, to: DesignPortEndpoint) => {
    if (!visible(from.instance) || !visible(to.instance)) return;
    if (!modules.has(from.instance) && !modules.has(to.instance)) return;
    const a = endpoint(from, "output");
    const b = endpoint(to, "input");
    const bidirectional =
      a.pin?.direction === "inout" || b.pin?.direction === "inout";
    const left = [a.pin?.id ?? a.id, selection(from)].join(" ");
    const right = [b.pin?.id ?? b.id, selection(to)].join(" ");
    const key = (bidirectional ? [left, right].sort() : [left, right]).join(
      "\0",
    );
    if (wires.has(key)) return;
    wires.add(key);
    const label = [selection(from), selection(to)].filter(Boolean).join(" → ");
    graph.edges.push({
      from: a.id,
      fromPort: a.pin?.id,
      to: b.id,
      toPort: b.pin?.id,
      label,
      bidirectional,
    });
  };
  for (const [index, link] of scan.links.entries()) {
    if (link.from && !link.selectIndex) {
      wire(link.from, link.to);
      continue;
    }
    if (!modules.has(link.to.instance)) continue;
    const inputs =
      link.expression?.operands ??
      (link.selectIndex ? [link.from, link.selectIndex] : []);
    const id = "expression:" + index;
    const to = endpoint(link.to, "input");
    graph.nodes.push({
      id,
      kind: "logic",
      label: "端口表达式",
      detail:
        link.expression?.value.op ??
        (link.selectIndex?.part ? "indexedPartSelect" : "bitSelect"),
      instance,
      location: { file: link.file, line: link.line },
      source: !!link.file && link.line > 0,
    });
    graph.edges.push({
      from: id,
      to: to.id,
      toPort: to.pin?.id,
      label: selection(link.to),
    });
    for (const input of inputs) {
      if (!input || !visible(input.instance)) {
        graph.partial = true;
        continue;
      }
      const from = endpoint(input, "output");
      graph.edges.push({
        from: from.id,
        fromPort: from.pin?.id,
        to: id,
        label: selection(input),
      });
    }
  }
  for (const [index, constant] of (scan.constants ?? []).entries()) {
    if (!modules.has(constant.instance)) continue;
    const target = endpoint(constant, "input");
    const id = "constant:" + index;
    const value = `${constant.bits.length}'${constant.signed ? "s" : ""}b${constant.bits}`;
    graph.nodes.push({ id, kind: "constant", label: value, detail: "" });
    graph.edges.push({ from: id, to: target.id, toPort: target.pin?.id });
  }
  for (const gap of scan.gaps ?? []) {
    if (!visible(gap.instance)) continue;
    graph.partial = true;
    const node = modules.get(gap.instance);
    if (!node) continue;
    for (const pin of node.ports)
      if (gap.signal ? pin.label === gap.signal : !connected.has(pin.id))
        pin.status = "unresolved";
  }
  if (graph.partial && (scan.truncated || scan.portsIncomplete))
    for (const pin of pins.values())
      if (pin.status === "open") pin.status = "unresolved";
  if (readLogic) {
    try {
      const trace = await readLogic(scope);
      addModuleLogic(graph, trace, instance, addNet);
      const count = graph.nodes.filter(({ id }) =>
        id.startsWith("rtl:"),
      ).length;
      const incomplete = trace.diagnostics?.some(
        (code) => code !== "localAssignmentCoverage",
      );
      graph.partial ||= !!incomplete;
      graph.module!.logicStatus = count
        ? `RTL 逻辑单元 ${count}`
        : "未找到可显示的 RTL 逻辑";
    } catch (error) {
      graph.module!.logicStatus =
        "RTL 逻辑不可用 · " +
        (error instanceof Error ? error.message : String(error));
    }
  }
  graph.nodes.sort((a, b) =>
    a.label.localeCompare(b.label, "en", { numeric: true }),
  );
  return graph;
}

function addModuleLogic(
  graph: SchematicGraph,
  trace: VideTrace,
  instance: string,
  addNet: (endpoint: DesignPortEndpoint) => string,
) {
  const signals = new Map(trace.signals.map((signal) => [signal.id, signal]));
  const net = (id: number) => {
    const signal = signals.get(id);
    if (!signal || signal.parameterValue) return;
    return addNet({
      instance: traceSignalScope(signal, instance),
      signal: signal.name,
    });
  };
  const groups = new Map<string, VideTrace["assignments"]>();
  for (const [index, assignment] of trace.assignments.entries()) {
    if (
      !["continuous", "blocking", "nonblocking", "initialization"].includes(
        assignment.kind,
      )
    )
      continue;
    const key = assignment.process
      ? JSON.stringify([
          assignment.instance,
          assignment.process,
          assignment.targets,
        ])
      : String(index);
    const group = groups.get(key);
    if (group) group.push(assignment);
    else groups.set(key, [assignment]);
  }
  for (const [index, assignments] of [...groups.values()].entries()) {
    const assignment = assignments[0];
    const output = new Set<string>();
    const input = new Map<string, boolean>();
    for (const relation of assignments) {
      const hierarchical = new Set(
        relation.hierarchicalTargets?.map(({ signal }) => signal),
      );
      for (const target of relation.targets) {
        if (hierarchical.has(target)) continue;
        const id = net(target);
        if (id) output.add(id);
      }
      for (const dependency of relation.inputs) {
        if (dependency.hierarchical) continue;
        const id = net(dependency.signal);
        if (id)
          input.set(id, (input.get(id) ?? true) && dependency.kind !== "data");
      }
      graph.partial ||=
        relation.hasUnresolvedOperands ||
        hierarchical.size > 0 ||
        relation.inputs.some(({ hierarchical }) => hierarchical);
    }
    if (!output.size) continue;
    const id = "rtl:" + index;
    const line = assignment.location.range.start.line + 1;
    const file = fileURLToPath(assignment.location.uri);
    const clocked = assignments.some(({ inputs }) =>
      inputs.some(
        ({ kind, edge }) =>
          kind === "trigger" && (edge === "rising" || edge === "falling"),
      ),
    );
    const value =
      assignment.value ?? assignment.fieldValue ?? assignment.elementValue;
    const mux =
      value?.op === "conditional" ||
      assignments.some((item) => item.guards?.length);
    const operator =
      value?.op === "binary" || value?.op === "unary"
        ? value.args[0]
        : undefined;
    const targets = assignment.targets
      .map((signal) => signals.get(signal)?.name)
      .filter(Boolean);
    graph.nodes.push({
      id,
      kind: clocked ? "register" : mux ? "mux" : "logic",
      label: clocked
        ? "DFF"
        : mux
          ? "MUX"
          : (operator ?? (assignment.process ? "always" : "assign")),
      detail: targets.join(", ") + " · L" + line,
      instance: assignment.instance ?? instance,
      location: { file, line },
      source: true,
    });
    for (const [from, control] of input)
      graph.edges.push({ from, to: id, control });
    for (const to of output) graph.edges.push({ from: id, to });
  }
}
