// SPDX-License-Identifier: MPL-2.0

import ELK from "elkjs/lib/elk.bundled.js";
import type { ElkNode, ElkPort } from "elkjs/lib/elk-api";
import type { SchematicGraph, SchematicNode } from "../shared/schematic";

declare function acquireVsCodeApi(): { postMessage(message: object): void };
const vscode = acquireVsCodeApi();
const canvas = document.querySelector<HTMLCanvasElement>("#trace-edges")!;
const diagram = document.querySelector<SVGSVGElement>("#diagram")!;
const scene = document.querySelector<HTMLDivElement>("#scene")!;
const title = document.querySelector<HTMLElement>("#title")!;
const status = document.querySelector<HTMLElement>("#status")!;
const selectedLabel = document.querySelector<HTMLOutputElement>("#selected")!;
const source = document.querySelector<HTMLButtonElement>("#source")!;
const wave = document.querySelector<HTMLButtonElement>("#wave")!;
const back = document.querySelector<HTMLButtonElement>("#back")!;
const refresh = document.querySelector<HTMLButtonElement>("#refresh")!;
const drivers = document.querySelector<HTMLButtonElement>("#drivers")!;
const loads = document.querySelector<HTMLButtonElement>("#loads")!;
const parent = document.querySelector<HTMLButtonElement>("#parent")!;
const enter = document.querySelector<HTMLButtonElement>("#enter")!;
const moduleView = document.querySelector<HTMLButtonElement>("#module-view")!;
let moduleMode = false;
let traceSnapshot = false;
let canGoUp = false;
let canOpenModule = false;
let selected: SchematicNode | undefined;
let revision = 0;
let navigation = false;
let canGoBack = false;
let loaded = false;
let layoutGeneration = 0;
let size = { width: 1, height: 1 };
let zoom = 1;
let redrawTrace: (() => void) | undefined;
let viewportFrame = 0;
let origin = { x: 0, y: 0 };
let drag:
  | {
      id: number;
      x: number;
      y: number;
      origin: typeof origin;
      moved: boolean;
    }
  | undefined;
let suppressClick = false;

function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  properties: Record<string, string | number>,
) {
  const element = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(properties))
    element.setAttribute(key, String(value));
  return element;
}

function updateViewport() {
  const width = Math.max(1, scene.clientWidth) / zoom;
  const height = Math.max(1, scene.clientHeight) / zoom;
  diagram.setAttribute("viewBox", `${origin.x} ${origin.y} ${width} ${height}`);
  if (redrawTrace && !viewportFrame)
    viewportFrame = requestAnimationFrame(() => {
      viewportFrame = 0;
      redrawTrace?.();
    });
}

function scale(
  value: number,
  x = scene.clientWidth / 2,
  y = scene.clientHeight / 2,
) {
  const next = Math.max(0.02, Math.min(8, value));
  origin = {
    x: origin.x + x / zoom - x / next,
    y: origin.y + y / zoom - y / next,
  };
  zoom = next;
  updateViewport();
}

function fit() {
  zoom = Math.max(
    0.02,
    Math.min(
      1,
      scene.clientWidth / size.width,
      scene.clientHeight / size.height,
    ),
  );
  origin = {
    x: (size.width - scene.clientWidth / zoom) / 2,
    y: (size.height - scene.clientHeight / zoom) / 2,
  };
  updateViewport();
}

new ResizeObserver(updateViewport).observe(scene);
scene.addEventListener(
  "wheel",
  (event) => {
    if (!loaded || !event.deltaY) return;
    event.preventDefault();
    const box = scene.getBoundingClientRect();
    const unit =
      event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? 16
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? scene.clientHeight
          : 1;
    const amount = Math.max(-240, Math.min(240, event.deltaY * unit));
    scale(
      zoom * Math.exp(-amount * 0.002),
      event.clientX - box.left,
      event.clientY - box.top,
    );
  },
  { passive: false },
);

scene.addEventListener("pointerdown", (event) => {
  if (!loaded || !event.isPrimary || event.button !== 0) return;
  suppressClick = false;
  drag = {
    id: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    origin,
    moved: false,
  };
});
scene.addEventListener("pointermove", (event) => {
  if (!drag || event.pointerId !== drag.id) return;
  if (!(event.buttons & 1)) {
    finishDrag(event);
    return;
  }
  const x = event.clientX - drag.x;
  const y = event.clientY - drag.y;
  if (!drag.moved) {
    if (Math.hypot(x, y) < 4) return;
    drag.moved = true;
    scene.setPointerCapture(event.pointerId);
    scene.classList.add("panning");
  }
  origin = { x: drag.origin.x - x / zoom, y: drag.origin.y - y / zoom };
  updateViewport();
});
function finishDrag(event: PointerEvent) {
  if (!drag || event.pointerId !== drag.id) return;
  suppressClick = drag.moved;
  drag = undefined;
  scene.classList.remove("panning");
}
scene.addEventListener("pointerup", finishDrag);
scene.addEventListener("pointercancel", finishDrag);
scene.addEventListener("lostpointercapture", finishDrag);
for (const eventType of ["click", "dblclick"]) {
  scene.addEventListener(
    eventType,
    (event) => {
      if (!suppressClick || !(event as MouseEvent).detail) return;
      event.stopImmediatePropagation();
      event.preventDefault();
    },
    true,
  );
}

function controls() {
  back.disabled = navigation || !canGoBack;
  refresh.hidden = drivers.hidden = loads.hidden = moduleMode || traceSnapshot;
  parent.hidden = enter.hidden = !moduleMode;
  moduleView.hidden = moduleMode || !canOpenModule;
  parent.disabled = navigation || !canGoUp;
  enter.disabled = navigation || selected?.kind !== "module";
  moduleView.disabled = navigation;
  refresh.disabled = navigation || !loaded;
  source.disabled = navigation || !selected?.source;
  wave.disabled =
    drivers.disabled =
    loads.disabled =
      navigation || !selected?.wave;
}

function navigate(type: string, direction?: "drivers" | "loads") {
  navigation = true;
  controls();
  status.textContent = "正在读取连接…";
  vscode.postMessage({
    type,
    id: type === "follow" || type === "enter" ? selected?.id : undefined,
    direction,
    revision,
  });
}

function select(node: SchematicNode, element: SVGGElement) {
  diagram.querySelector(".selected")?.classList.remove("selected");
  element.classList.add("selected");
  if (moduleMode || (traceSnapshot && !redrawTrace)) {
    for (const wire of diagram.querySelectorAll<SVGElement>(".edge"))
      wire.classList.toggle(
        "active",
        wire.dataset.from === node.id || wire.dataset.to === node.id,
      );
  }
  selected = node;
  if (redrawTrace) updateViewport();
  selectedLabel.textContent = [node.label, node.detail]
    .filter(Boolean)
    .join(" · ");
  controls();
}

function layoutNode(node: SchematicNode): ElkNode {
  const inputs =
    node.ports?.filter((port) => port.direction !== "output") ?? [];
  const outputs =
    node.ports?.filter((port) => port.direction === "output") ?? [];
  const pinWidth = (pins: typeof inputs) =>
    Math.max(0, ...pins.map((pin) => Math.min(29, pin.label.length) * 7 + 22));
  const width = Math.max(
    86,
    Math.min(340, Math.max(node.label.length, node.detail.length) * 8 + 22),
    pinWidth(inputs) + pinWidth(outputs) + 16,
  );
  const ports: ElkPort[] = [
    ...inputs.map((pin, index) => ({
      id: pin.id,
      x: -3,
      y: 48 + index * 18,
      width: 6,
      height: 6,
      layoutOptions: { "elk.port.side": "WEST" },
    })),
    ...outputs.map((pin, index) => ({
      id: pin.id,
      x: width - 3,
      y: 48 + index * 18,
      width: 6,
      height: 6,
      layoutOptions: { "elk.port.side": "EAST" },
    })),
  ];
  return {
    id: node.id,
    width,
    height: ports.length
      ? 53 + Math.max(inputs.length, outputs.length) * 18
      : 44,
    ports,
    layoutOptions: ports.length
      ? { "elk.portConstraints": "FIXED_POS" }
      : undefined,
  };
}

function layoutLargeGraph(graph: SchematicGraph): ElkNode {
  const layers = new Map<string, number>();
  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();
  for (const { from, to } of graph.edges) {
    if (!incoming.has(to)) incoming.set(to, []);
    if (!outgoing.has(from)) outgoing.set(from, []);
    incoming.get(to)!.push(from);
    outgoing.get(from)!.push(to);
  }
  const roots = graph.module
    ? graph.nodes
        .filter(
          ({ kind, direction }) => kind === "port" && direction !== "output",
        )
        .map(({ id }) => id)
    : (graph.roots ?? [graph.root]);
  for (const id of roots) if (id) layers.set(id, 0);
  for (const [neighbors, step] of [
    [incoming, -1],
    [outgoing, 1],
  ] as const) {
    const pending = [...roots];
    for (let index = 0; index < pending.length; index++) {
      const id = pending[index];
      for (const next of neighbors.get(id) ?? []) {
        if (layers.has(next)) continue;
        layers.set(next, layers.get(id)! + step);
        pending.push(next);
      }
    }
  }
  if (graph.module) {
    for (const node of graph.nodes)
      if (!layers.has(node.id))
        layers.set(
          node.id,
          node.kind === "port" ? 4 : node.kind === "net" ? 1 : 2,
        );
  }
  const first = Math.min(0, ...layers.values());
  const rows = new Map<number, number>();
  const boxes = graph.nodes.map((node) => {
    const layer = layers.get(node.id) ?? 0;
    const y = rows.get(layer) ?? 16;
    const box = layoutNode(node);
    rows.set(layer, y + box.height + 18);
    return {
      ...box,
      x: 16 + (layer - first) * 480,
      y,
    };
  });
  const byId = new Map(boxes.map((box) => [box.id, box]));
  const ports = new Map(
    boxes.flatMap(({ ports }) => (ports ?? []).map((port) => [port.id, port])),
  );
  return {
    id: "design",
    children: boxes,
    width: Math.max(...boxes.map((box) => box.x + box.width + 16)),
    height: Math.max(...boxes.map((box) => box.y + box.height + 16)),
    edges: graph.edges.flatMap(({ from, to, fromPort, toPort }, index) => {
      const a = byId.get(from);
      const b = byId.get(to);
      if (!a || !b) return [];
      const forward = b.x > a.x;
      const startPin = fromPort ? ports.get(fromPort) : undefined;
      const endPin = toPort ? ports.get(toPort) : undefined;
      const startPoint = {
        x: a.x + (startPin ? (startPin.x ?? 0) + 3 : a.width),
        y: a.y + (startPin ? (startPin.y ?? 0) + 3 : a.height / 2),
      };
      const endPoint = {
        x: b.x + (endPin ? (endPin.x ?? 0) + 3 : forward ? 0 : b.width),
        y: b.y + (endPin ? (endPin.y ?? 0) + 3 : b.height / 2),
      };
      const sameLayer = a.x === b.x;
      const column = sameLayer
        ? Math.max(startPoint.x, endPoint.x) + 12 + (index % 6) * 4
        : forward
          ? a.x + a.width + 14 + (index % 7) * 5
          : startPoint.x + 12;
      const bendPoints =
        sameLayer || forward
          ? [
              { x: column, y: startPoint.y },
              { x: column, y: endPoint.y },
            ]
          : [
              { x: column, y: startPoint.y },
              { x: column, y: endPoint.y + 17 },
              { x: endPoint.x + 8, y: endPoint.y + 17 },
            ];
      return [
        {
          id: String(index),
          sources: [from],
          targets: [to],
          sections: [{ id: String(index), startPoint, endPoint, bendPoints }],
        },
      ];
    }),
  };
}

function renderDenseGraph(
  layout: ElkNode,
  graph: SchematicGraph,
  createNode: (box: ElkNode) => SVGGElement,
) {
  const context = canvas.getContext("2d")!;
  const theme = getComputedStyle(document.body);
  const dataColor =
    theme.getPropertyValue("--vscode-charts-blue").trim() || "#6ca9e9";
  const controlColor =
    theme.getPropertyValue("--vscode-charts-orange").trim() || "#cf9e63";
  const activeColor =
    theme.getPropertyValue("--vscode-focusBorder").trim() || "#6cf";
  const boxes = layout.children ?? [];
  const mounted = new Map<string, SVGGElement>();
  const wires = (layout.edges ?? []).flatMap((edge) => {
    const connection = graph.edges[Number(edge.id)];
    return (edge.sections ?? []).map((section) => {
      const points = [
        section.startPoint,
        ...(section.bendPoints ?? []),
        section.endPoint,
      ];
      return {
        connection,
        segments: points
          .slice(1)
          .map((end, index) => ({ start: points[index], end })),
      };
    });
  });

  return () => {
    const width = scene.clientWidth;
    const height = scene.clientHeight;
    if (!width || !height) return;
    const dpr = window.devicePixelRatio || 1;
    const pixelWidth = Math.round(width * dpr);
    const pixelHeight = Math.round(height * dpr);
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
    context.resetTransform();
    context.clearRect(0, 0, pixelWidth, pixelHeight);
    context.setTransform(
      zoom * dpr,
      0,
      0,
      zoom * dpr,
      -origin.x * zoom * dpr,
      -origin.y * zoom * dpr,
    );
    const right = origin.x + width / zoom;
    const bottom = origin.y + height / zoom;
    const overview = zoom < 0.26;
    const margin = 24 / zoom;
    const visible = (x: number, y: number, w: number, h: number) =>
      x + w >= origin.x - margin &&
      x <= right + margin &&
      y + h >= origin.y - margin &&
      y <= bottom + margin;

    const data = new Path2D();
    const controls = new Path2D();
    const highlighted = new Path2D();
    for (const { connection, segments } of wires) {
      const active =
        selected &&
        (connection.from === selected.id || connection.to === selected.id);
      if (overview && !active) continue;
      const lines = active ? highlighted : connection.control ? controls : data;
      for (const { start, end } of segments) {
        if (
          Math.max(start.x, end.x) < origin.x ||
          Math.min(start.x, end.x) > right ||
          Math.max(start.y, end.y) < origin.y ||
          Math.min(start.y, end.y) > bottom
        )
          continue;
        lines.moveTo(start.x, start.y);
        lines.lineTo(end.x, end.y);
      }
    }
    context.lineWidth = 1.2 / zoom;
    context.strokeStyle = dataColor;
    context.setLineDash([]);
    context.stroke(data);
    context.strokeStyle = controlColor;
    context.setLineDash([4 / zoom, 4 / zoom]);
    context.stroke(controls);
    context.strokeStyle = activeColor;
    context.setLineDash([]);
    context.lineWidth = 2 / zoom;
    context.stroke(highlighted);

    const shown = new Set<string>();
    for (const box of boxes) {
      const x = box.x ?? 0;
      const y = box.y ?? 0;
      const w = box.width ?? 0;
      const h = box.height ?? 0;
      if (!visible(x, y, w, h)) continue;
      if (overview) {
        context.globalAlpha = box.id === graph.root ? 1 : 0.42;
        context.fillStyle = box.id === graph.root ? activeColor : dataColor;
        context.fillRect(x, y, w, h);
        continue;
      }
      shown.add(box.id);
      let item = mounted.get(box.id);
      if (!item) {
        item = createNode(box);
        mounted.set(box.id, item);
        diagram.append(item);
      }
      item.classList.toggle("selected", selected?.id === box.id);
    }
    context.globalAlpha = 1;
    for (const [id, item] of mounted) {
      if (!shown.has(id)) {
        item.remove();
        mounted.delete(id);
      }
    }
    const message = overview
      ? `${graph.nodes.length} 节点 · ${graph.edges.length} 连线 · 放大查看连线`
      : graph.partial
        ? "图中含未解析连接"
        : "";
    const summary = [graph.module?.logicStatus, message]
      .filter(Boolean)
      .join(" · ");
    if (status.textContent !== summary) status.textContent = summary;
  };
}

async function render(graph: SchematicGraph, generation: number) {
  const large =
    (traceSnapshot || moduleMode) &&
    (graph.nodes.length > 220 || graph.edges.length > 450);
  const layout = large
    ? layoutLargeGraph(graph)
    : await new ELK().layout<ElkNode>({
        id: "design",
        layoutOptions: {
          "elk.algorithm": "layered",
          "elk.direction": "RIGHT",
          "elk.edgeRouting": "ORTHOGONAL",
          "elk.layered.spacing.nodeNodeBetweenLayers": "54",
        },
        children: graph.nodes.map(layoutNode),
        edges: graph.edges.map(
          ({ from, to, fromPort, toPort, label }, index) => ({
            id: String(index),
            sources: [fromPort ?? from],
            targets: [toPort ?? to],
            labels: label
              ? [{ text: label, width: label.length * 7 + 4, height: 15 }]
              : undefined,
          }),
        ),
      } satisfies ElkNode);
  if (generation !== layoutGeneration) return;
  redrawTrace = undefined;
  canvas.hidden = !large;
  diagram.replaceChildren();
  selected = undefined;
  selectedLabel.textContent = "";
  size = { width: layout.width ?? 1, height: layout.height ?? 1 };

  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const roots = new Set(graph.roots ?? [graph.root]);
  for (const edge of large ? [] : (layout.edges ?? [])) {
    const connection = graph.edges[Number(edge.id)];
    for (const section of edge.sections ?? []) {
      const points = [
        section.startPoint,
        ...(section.bendPoints ?? []),
        section.endPoint,
      ];
      const wire = svg("polyline", {
        class:
          "edge" +
          (connection.control ? " control" : "") +
          (connection.bidirectional ? " bidirectional" : ""),
        points: points.map(({ x, y }) => `${x},${y}`).join(" "),
        "data-from": connection.from,
        "data-to": connection.to,
      });
      const tooltip = svg("title", {});
      tooltip.textContent = [
        nodes.get(connection.from)?.label,
        connection.label,
        connection.bidirectional ? "↔" : "→",
        nodes.get(connection.to)?.label,
      ]
        .filter(Boolean)
        .join(" ");
      wire.append(tooltip);
      diagram.append(wire);
    }
    for (const label of edge.labels ?? []) {
      const text = svg("text", {
        class: "wire-label",
        x: label.x ?? 0,
        y: (label.y ?? 0) + 11,
      });
      text.textContent = label.text ?? "";
      diagram.append(text);
    }
  }
  const createNode = (box: ElkNode) => {
    const node = nodes.get(box.id)!;
    const element = svg("g", {
      class: "node " + node.kind + (roots.has(node.id) ? " root" : ""),
      transform: `translate(${box.x},${box.y})`,
      tabindex: 0,
      role: "button",
      "aria-label": node.label,
    });
    const tooltip = svg("title", {});
    tooltip.textContent = [node.instance, node.label, node.detail]
      .filter(Boolean)
      .join(" · ");
    element.append(tooltip);
    element.append(
      svg("rect", { width: box.width!, height: box.height!, rx: 5 }),
    );
    for (const [index, label] of [node.label, node.detail].entries()) {
      const text = svg("text", {
        x: 9,
        y: 17 + index * 16,
        class: index ? "detail" : "label",
      });
      text.textContent = label.length > 28 ? label.slice(0, 26) + "…" : label;
      element.append(text);
    }
    const ports = new Map(node.ports?.map((port) => [port.id, port]));
    for (const pin of box.ports ?? []) {
      const port = ports.get(pin.id);
      if (!port) continue;
      const x = (pin.x ?? 0) + (pin.width ?? 0) / 2;
      const y = (pin.y ?? 0) + (pin.height ?? 0) / 2;
      const output = port.direction === "output";
      const pinElement = svg("g", {
        class: "pin" + (port.status ? " " + port.status : ""),
      });
      const tooltip = svg("title", {});
      tooltip.textContent = [port.label, port.direction, port.status]
        .filter(Boolean)
        .join(" · ");
      const label = svg("text", {
        x: x + (output ? -9 : 9),
        y: y + 4,
        "text-anchor": output ? "end" : "start",
      });
      const display =
        port.label.length > 29 ? port.label.slice(0, 27) + "…" : port.label;
      label.textContent =
        port.direction === "inout" ? "↔ " + display : display;
      pinElement.append(tooltip, svg("circle", { cx: x, cy: y, r: 3 }), label);
      element.append(pinElement);
    }
    element.onclick = () => select(node, element);
    if (node.kind === "module")
      element.ondblclick = () => {
        select(node, element);
        if (!enter.disabled) navigate("enter");
      };
    element.onkeydown = (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        select(node, element);
      }
    };
    return element;
  };
  if (large) {
    redrawTrace = renderDenseGraph(layout, graph, createNode);
    const rootNode = nodes.get(graph.root);
    if (rootNode) {
      selected = rootNode;
      selectedLabel.textContent = [rootNode.label, rootNode.detail]
        .filter(Boolean)
        .join(" · ");
    }
    zoom = 0.8;
    const root =
      layout.children?.find(({ id }) => id === graph.root) ??
      (moduleMode
        ? (layout.children?.find(
            ({ id }) => nodes.get(id)?.kind === "register",
          ) ?? layout.children?.find(({ id }) => id.startsWith("rtl:")))
        : undefined);
    origin = {
      x:
        (root?.x ?? 0) +
        (root?.width ?? 0) / 2 -
        scene.clientWidth / (2 * zoom),
      y: Math.max(0, (root?.y ?? 0) - scene.clientHeight / (3 * zoom)),
    };
    updateViewport();
  } else {
    for (const box of layout.children ?? []) {
      const element = createNode(box);
      diagram.append(element);
      if (box.id === graph.root) select(nodes.get(box.id)!, element);
    }
    fit();
  }
  const message = graph.partial
    ? "图中含未解析连接"
    : graph.nodes.length
      ? ""
      : moduleMode
        ? "该模块没有可显示的端口或实例"
        : "本次追踪没有可显示的关系";
  status.textContent = [graph.module?.logicStatus, message]
    .filter(Boolean)
    .join(" · ");
}

document.querySelector<HTMLButtonElement>("#in")!.onclick = () =>
  scale(zoom * 1.3);
document.querySelector<HTMLButtonElement>("#out")!.onclick = () =>
  scale(zoom / 1.3);
document.querySelector<HTMLButtonElement>("#fit")!.onclick = fit;
source.onclick = () =>
  vscode.postMessage({ type: "source", id: selected?.id, revision });
wave.onclick = () =>
  vscode.postMessage({ type: "wave", id: selected?.id, revision });
back.onclick = () => navigate("back");
parent.onclick = () => navigate("parent");
enter.onclick = () => navigate("enter");
moduleView.onclick = () => vscode.postMessage({ type: "moduleView", revision });
refresh.onclick = () => navigate("refresh");
drivers.onclick = () => navigate("follow", "drivers");
loads.onclick = () => navigate("follow", "loads");

window.addEventListener("message", (event) => {
  if (event.data.type === "navigationError") {
    navigation = false;
    controls();
    status.textContent = event.data.message;
    return;
  }
  if (event.data.type !== "schematic") return;
  const generation = ++layoutGeneration;
  navigation = true;
  controls();
  moduleMode = !!event.data.graph.module;
  traceSnapshot = !!event.data.traceSnapshot;
  canOpenModule = !!event.data.canOpenModule;
  canGoUp = !!event.data.graph.module?.parent;
  title.textContent = event.data.title;
  title.title = event.data.title;
  status.textContent = "正在布局…";
  void render(event.data.graph, generation)
    .then(() => {
      if (generation !== layoutGeneration) return;
      loaded = true;
      revision = event.data.revision ?? 0;
      canGoBack = !!event.data.canGoBack;
    })
    .catch((error) => {
      if (generation === layoutGeneration) status.textContent = String(error);
    })
    .finally(() => {
      if (generation !== layoutGeneration) return;
      navigation = false;
      controls();
    });
});
vscode.postMessage({ type: "ready" });
