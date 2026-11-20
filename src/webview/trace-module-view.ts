// SPDX-License-Identifier: MPL-2.0

import type {
  SchematicGraph,
  SchematicNode,
  SchematicPort,
} from "../shared/schematic";

const groupOf = (node: SchematicNode) => node.instance ?? "";
const moduleId = (instance: string) => "trace-module:" + instance;

function traceTerminal(
  local: SchematicNode,
  remote: SchematicNode,
  direction: "input" | "output",
) {
  const signal = local.kind === "signal" ? local : remote;
  return {
    id: JSON.stringify(["trace-port", groupOf(local), signal.id, direction]),
    label: signal.label,
    direction,
  };
}

export function expandedTraceGroups(graph: SchematicGraph) {
  type Part = {
    instance: string;
    nodes: SchematicNode[];
    edges: SchematicGraph["edges"];
    ports: Map<string, { pin: SchematicPort; edges: SchematicGraph["edges"] }>;
  };
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const groups = new Map<string, Part>();
  const links: SchematicGraph["edges"] = [];
  for (const node of graph.nodes) {
    const instance = groupOf(node);
    let part = groups.get(instance);
    if (!part) {
      part = { instance, nodes: [], edges: [], ports: new Map() };
      groups.set(instance, part);
    }
    part.nodes.push(node);
  }
  function connect(
    part: Part,
    local: SchematicNode,
    remote: SchematicNode,
    direction: "input" | "output",
    edge: SchematicGraph["edges"][number],
  ) {
    const pin = traceTerminal(local, remote, direction);
    let terminal = part.ports.get(pin.id);
    if (!terminal) {
      terminal = { pin, edges: [] };
      part.ports.set(pin.id, terminal);
    }
    terminal.edges.push(
      direction === "input"
        ? {
            from: pin.id,
            to: local.id,
            toPort: edge.toPort,
            control: edge.control,
          }
        : {
            from: local.id,
            fromPort: edge.fromPort,
            to: pin.id,
            control: edge.control,
          },
    );
    return pin.id;
  }
  const seen = new Set<string>();
  for (const edge of graph.edges) {
    const source = nodes.get(edge.from);
    const target = nodes.get(edge.to);
    if (!source || !target) continue;
    const from = groups.get(groupOf(source))!;
    const to = groups.get(groupOf(target))!;
    if (from === to) {
      from.edges.push(edge);
      continue;
    }
    const fromPort = connect(from, source, target, "output", edge);
    const toPort = connect(to, target, source, "input", edge);
    const key = JSON.stringify([
      edge.from,
      edge.to,
      fromPort,
      toPort,
      edge.label,
      !!edge.control,
    ]);
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({
      ...edge,
      from: moduleId(from.instance),
      to: moduleId(to.instance),
      fromPort,
      toPort,
    });
  }
  return {
    groups: [...groups.values()].map((part) => ({
      ...part,
      frame: {
        id: moduleId(part.instance),
        instance: part.instance,
        label: part.instance || "未定位实例",
        detail: "",
        kind: "module",
        ports: [...part.ports.values()].map(({ pin }) => pin),
      } satisfies SchematicNode,
    })),
    links,
  };
}

export function moduleTraceView(
  graph: SchematicGraph,
  inside?: string,
): SchematicGraph {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const groups = new Map<string, SchematicNode & { ports: SchematicPort[] }>();
  const result: SchematicGraph = {
    ...graph,
    root: "",
    roots: [],
    nodes: [],
    edges: [],
  };
  if (inside !== undefined) {
    result.nodes = graph.nodes.filter((node) => groupOf(node) === inside);
    result.root = result.nodes.some(({ id }) => id === graph.root)
      ? graph.root
      : "";
    result.roots = (graph.roots ?? [graph.root]).filter((id) => {
      const node = nodes.get(id);
      return node && groupOf(node) === inside;
    });
    result.module = {
      instance: inside,
      name: inside.split(".").at(-1) || "未定位实例",
    };
  } else {
    for (const node of graph.nodes) {
      const instance = groupOf(node);
      let group = groups.get(instance);
      if (!group) {
        group = {
          id: moduleId(instance),
          instance,
          label: instance.split(".").at(-1) || "未定位实例",
          detail: instance,
          kind: "module",
          ports: [],
        };
        groups.set(instance, group);
      }
    }
    result.nodes = [...groups.values()];
    result.root = nodes.has(graph.root)
      ? moduleId(groupOf(nodes.get(graph.root)!))
      : "";
    result.roots = [
      ...new Set(
        (graph.roots ?? [graph.root]).flatMap((id) => {
          const node = nodes.get(id);
          return node ? [moduleId(groupOf(node))] : [];
        }),
      ),
    ];
  }

  const interfaces = new Set<string>();
  const connections = new Set<string>();
  function terminal(
    local: SchematicNode,
    remote: SchematicNode,
    direction: "input" | "output",
  ) {
    const owner = groupOf(local);
    const pin = traceTerminal(local, remote, direction);
    const { id, label } = pin;
    if (!interfaces.has(id)) {
      interfaces.add(id);
      if (inside !== undefined) {
        result.nodes.push({
          id,
          kind: "port",
          direction,
          label,
          detail: groupOf(remote) || "未定位实例",
        });
      } else {
        groups.get(owner)!.ports.push(pin);
      }
    }
    return id;
  }

  for (const edge of graph.edges) {
    const source = nodes.get(edge.from);
    const target = nodes.get(edge.to);
    if (!source || !target) continue;
    const from = groupOf(source);
    const to = groupOf(target);
    if (from === to) {
      if (inside === from) result.edges.push(edge);
    } else if (inside === undefined) {
      const fromPort = terminal(source, target, "output");
      const toPort = terminal(target, source, "input");
      const key = JSON.stringify([
        fromPort,
        toPort,
        edge.control ?? false,
        edge.label,
      ]);
      if (connections.has(key)) continue;
      connections.add(key);
      result.edges.push({
        ...edge,
        from: moduleId(from),
        to: moduleId(to),
        fromPort,
        toPort,
      });
    } else if (inside === from) {
      result.edges.push({
        ...edge,
        to: terminal(source, target, "output"),
        toPort: undefined,
      });
    } else if (inside === to) {
      result.edges.push({
        ...edge,
        from: terminal(target, source, "input"),
        fromPort: undefined,
      });
    }
  }
  return result;
}
