// SPDX-License-Identifier: MPL-2.0

import type { ElkNode } from "elkjs/lib/elk-api";
import type { SchematicGraph, SchematicNode } from "../shared/schematic";
import { expandedTraceGroups } from "./trace-module-view";

export type TraceFrame = {
  id: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

const innerX = 110;
const innerY = 38;

export async function layoutTraceFrames(
  graph: SchematicGraph,
  layoutGraph: (
    graph: SchematicGraph,
    boxes?: Map<string, ElkNode>,
  ) => Promise<ElkNode>,
) {
  const { groups, links } = expandedTraceGroups(graph);
  const packed = [];
  const sizes = new Map<string, ElkNode>();
  for (const part of groups) {
    const ids = new Set(part.nodes.map(({ id }) => id));
    const localRoots = (graph.roots ?? [graph.root]).filter((id) =>
      ids.has(id),
    );
    const local = await layoutGraph({
      ...graph,
      nodes: part.nodes,
      edges: part.edges,
      root: localRoots[0] ?? "",
      roots: localRoots,
      module: { instance: part.instance, name: part.frame.label },
    });
    const localNodes = new Map(local.children?.map((box) => [box.id, box]));
    const width = Math.max(270, (local.width ?? 1) + innerX * 2);
    let inputY = innerY;
    let outputY = innerY;
    const ports = [...part.ports.values()].map(({ pin, edges }) => {
      const output = pin.direction === "output";
      const anchor = localNodes.get(output ? edges[0].from : edges[0].to);
      const y = Math.max(output ? outputY : inputY, innerY + (anchor?.y ?? 0));
      if (output) outputY = y + 20;
      else inputY = y + 20;
      return {
        id: pin.id,
        x: (output ? width : 0) - 3,
        y,
        width: 6,
        height: 6,
        layoutOptions: { "elk.port.side": output ? "EAST" : "WEST" },
      };
    });
    const height = Math.max(
      innerY + (local.height ?? 1) + 22,
      inputY + 12,
      outputY + 12,
    );
    sizes.set(part.frame.id, {
      id: part.frame.id,
      width,
      height,
      ports,
      layoutOptions: ports.length
        ? { "elk.portConstraints": "FIXED_POS" }
        : undefined,
    });
    packed.push({ part, local, localNodes });
  }

  const root =
    groups.find(({ nodes }) => nodes.some(({ id }) => id === graph.root))?.frame
      .id ?? "";
  const outer = await layoutGraph(
    {
      ...graph,
      nodes: groups.map(({ frame }) => frame),
      edges: links,
      root,
      roots: root ? [root] : [],
    },
    sizes,
  );
  const frameBoxes = new Map(outer.children?.map((box) => [box.id, box]));
  const frames: TraceFrame[] = [];
  const children: ElkNode[] = [];
  const nodes: SchematicNode[] = [...graph.nodes];
  const edges: SchematicGraph["edges"] = [];
  const routed: NonNullable<ElkNode["edges"]> = [];
  const boundary = new Map<string, { x: number; y: number }>();
  type RoutedEdge = (typeof routed)[number];
  function addEdge(
    edge: SchematicGraph["edges"][number],
    route: Pick<RoutedEdge, "sections" | "labels">,
  ) {
    const id = String(edges.length);
    edges.push(edge);
    routed.push({ id, sources: [edge.from], targets: [edge.to], ...route });
  }
  function translate(route: RoutedEdge, offsetX: number, offsetY: number) {
    const point = ({ x, y }: { x: number; y: number }) => ({
      x: x + offsetX,
      y: y + offsetY,
    });
    return {
      sections: route.sections?.map((section) => ({
        ...section,
        startPoint: point(section.startPoint),
        endPoint: point(section.endPoint),
        bendPoints: section.bendPoints?.map(point),
      })),
      labels: route.labels?.map((label) => ({
        ...label,
        ...point({ x: label.x ?? 0, y: label.y ?? 0 }),
      })),
    };
  }
  for (const { part, local, localNodes } of packed) {
    const frame = frameBoxes.get(part.frame.id)!;
    const x = frame.x!;
    const y = frame.y!;
    const offsetX = x + innerX;
    const offsetY = y + innerY;
    frames.push({
      id: frame.id,
      label: part.frame.label,
      x,
      y,
      width: frame.width!,
      height: frame.height!,
    });
    for (const box of local.children ?? [])
      children.push({ ...box, x: box.x! + offsetX, y: box.y! + offsetY });
    for (const route of local.edges ?? [])
      addEdge(part.edges[Number(route.id)], translate(route, offsetX, offsetY));
    for (const port of frame.ports ?? []) {
      const { pin, edges: internal } = part.ports.get(port.id)!;
      const output = pin.direction === "output";
      const point = {
        x: x + (output ? frame.width! : 0),
        y: y + (port.y ?? 0) + 3,
      };
      boundary.set(pin.id, point);
      children.push({ id: pin.id, ...point, width: 0, height: 0 });
      nodes.push({
        id: pin.id,
        label: pin.label,
        detail: part.frame.label,
        kind: "port",
        direction: pin.direction,
        instance: part.instance,
      });
      const written = new Set<string>();
      for (const edge of internal) {
        const key = JSON.stringify([
          edge.from,
          edge.fromPort,
          edge.to,
          edge.toPort,
          !!edge.control,
        ]);
        if (written.has(key)) continue;
        written.add(key);
        const box = localNodes.get(output ? edge.from : edge.to)!;
        const pinId = output ? edge.fromPort : edge.toPort;
        const terminal = pinId && box.ports?.find(({ id }) => id === pinId);
        const endpoint = terminal
          ? {
              x:
                offsetX +
                box.x! +
                (terminal.x ?? 0) +
                (terminal.width ?? 0) / 2,
              y:
                offsetY +
                box.y! +
                (terminal.y ?? 0) +
                (terminal.height ?? 0) / 2,
            }
          : {
              x: offsetX + box.x! + (output ? box.width! : 0),
              y: offsetY + box.y! + box.height! / 2,
            };
        const lane =
          point.x + (output ? -1 : 1) * (70 + (written.size % 5) * 5);
        const bendPoints = [
          { x: lane, y: point.y },
          { x: lane, y: endpoint.y },
        ];
        addEdge(edge, {
          sections: [
            {
              id: "boundary",
              startPoint: output ? endpoint : point,
              endPoint: output ? point : endpoint,
              bendPoints: output ? bendPoints.reverse() : bendPoints,
            },
          ],
        });
      }
    }
  }
  for (const route of outer.edges ?? []) {
    const link = links[Number(route.id)];
    const from = link.fromPort!;
    const to = link.toPort!;
    const source = boundary.get(from);
    const target = boundary.get(to);
    if (!source || !target) continue;
    const sections = route.sections?.map((section) => ({
      ...section,
      startPoint: source,
      endPoint: target,
      bendPoints: section.bendPoints,
    }));
    addEdge({ ...link, from, to }, { sections, labels: route.labels });
  }
  return {
    frames,
    graph: { ...graph, nodes, edges },
    layout: { ...outer, children, edges: routed },
  };
}
