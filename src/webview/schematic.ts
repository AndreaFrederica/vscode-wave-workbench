// SPDX-License-Identifier: MPL-2.0

import ELK from "elkjs/lib/elk.bundled.js";
import type { ElkNode, ElkPort } from "elkjs/lib/elk-api";
import { spatialIndex, type Bounds } from "./schematic-spatial";
import { moduleTraceView } from "./trace-module-view";
import { layoutTraceFrames, type TraceFrame } from "./trace-frame-layout";
import type { SchematicGraph, SchematicNode } from "../shared/schematic";

type SchematicView = {
  zoom: number;
  origin: { x: number; y: number };
  mode: "signals" | "modules" | "expanded";
  inside?: string;
  selected?: string;
  overview: boolean;
};
declare function acquireVsCodeApi(): {
  postMessage(message: object): void;
  getState(): { panel?: unknown; view?: SchematicView } | undefined;
  setState(state: { panel: unknown; view: SchematicView }): void;
};
const vscode = acquireVsCodeApi();
const frameLayer = document.querySelector<SVGSVGElement>("#trace-frames")!;
const canvas = document.querySelector<HTMLCanvasElement>("#trace-edges")!;
const overview = document.querySelector<HTMLDivElement>("#overview")!;
const overviewMap = document.querySelector<HTMLCanvasElement>("#overview-map")!;
const overviewOverlay =
  document.querySelector<SVGSVGElement>("#overview-overlay")!;
const overviewWindow =
  document.querySelector<SVGRectElement>("#overview-window")!;
const overviewToggle =
  document.querySelector<HTMLButtonElement>("#overview-toggle")!;
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
const layoutMode = document.querySelector<HTMLSelectElement>("#trace-layout")!;
const moduleView = document.querySelector<HTMLButtonElement>("#module-view")!;
let previousView = vscode.getState?.()?.view;
let panelState: unknown;
let baseGraph: SchematicGraph;
let baseTitle: string;
let inside: string | undefined;
let canGroup = false;
let hostCanGoBack = false;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
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
let overviewBoxes: readonly ElkNode[] = [];
let overviewFrames: readonly TraceFrame[] = [];
let redrawFrames: (() => void) | undefined;
let overviewProjection: { scale: number; x: number; y: number } | undefined;
let overviewDrag: { id: number; x: number; y: number } | undefined;
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
  if (loaded && !navigation) scheduleViewSave();
  const viewBox = `${origin.x} ${origin.y} ${width} ${height}`;
  diagram.setAttribute("viewBox", viewBox);
  if (overviewFrames.length) frameLayer.setAttribute("viewBox", viewBox);
  if (viewportFrame) return;
  viewportFrame = requestAnimationFrame(() => {
    viewportFrame = 0;
    redrawFrames?.();
    redrawTrace?.();
    updateOverviewWindow();
  });
}

function saveView() {
  if (!loaded || panelState === undefined) return;
  vscode.setState?.({
    panel: panelState,
    view: {
      zoom,
      origin,
      mode:
        layoutMode.value === "expanded"
          ? "expanded"
          : layoutMode.value === "modules"
            ? "modules"
            : "signals",
      inside,
      selected: selected?.id,
      overview: overviewToggle.getAttribute("aria-pressed") === "true",
    },
  });
}

function scheduleViewSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveView, 250);
}

window.addEventListener("pagehide", saveView);

function scale(
  value: number,
  x = scene.clientWidth / 2,
  y = scene.clientHeight / 2,
) {
  const next = Math.max(Math.min(0.02, fitZoom()), Math.min(8, value));
  origin = {
    x: origin.x + x / zoom - x / next,
    y: origin.y + y / zoom - y / next,
  };
  zoom = next;
  updateViewport();
}

function fitZoom() {
  return Math.min(
    1,
    Math.max(1, scene.clientWidth) / size.width,
    Math.max(1, scene.clientHeight) / size.height,
  );
}

function fit() {
  zoom = fitZoom();
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

function drawOverview() {
  overviewProjection = undefined;
  if (overview.hidden) return;
  const { clientWidth: width, clientHeight: height } = overview;
  if (width <= 16 || height <= 16) return;
  const scale = Math.min(
    (width - 16) / size.width,
    (height - 16) / size.height,
  );
  const x = (width - size.width * scale) / 2;
  const y = (height - size.height * scale) / 2;
  overviewProjection = { scale, x, y };
  overviewOverlay.setAttribute("viewBox", `0 0 ${width} ${height}`);
  const dpr = window.devicePixelRatio || 1;
  overviewMap.width = Math.round(width * dpr);
  overviewMap.height = Math.round(height * dpr);
  const ctx = overviewMap.getContext("2d")!;
  ctx.scale(dpr, dpr);
  ctx.fillStyle =
    getComputedStyle(document.body)
      .getPropertyValue("--vscode-charts-blue")
      .trim() || "#6ca9e9";
  const outline = new Path2D();
  for (const box of overviewBoxes) {
    outline.rect(
      x + box.x! * scale,
      y + box.y! * scale,
      Math.max(1, box.width! * scale),
      Math.max(1, box.height! * scale),
    );
  }
  if (overviewFrames.length) {
    ctx.strokeStyle =
      getComputedStyle(document.body)
        .getPropertyValue("--vscode-charts-purple")
        .trim() || "#b99ae5";
    const frames = new Path2D();
    for (const frame of overviewFrames)
      frames.rect(
        x + frame.x * scale,
        y + frame.y * scale,
        Math.max(1, frame.width * scale),
        Math.max(1, frame.height * scale),
      );
    ctx.stroke(frames);
  }
  ctx.fill(outline);
  updateOverviewWindow();
}

function updateOverviewWindow() {
  if (!overviewProjection) return;
  const { x, y, scale } = overviewProjection;
  const width = scene.clientWidth / zoom;
  const height = scene.clientHeight / zoom;
  const left = Math.max(0, Math.min(size.width, origin.x));
  const top = Math.max(0, Math.min(size.height, origin.y));
  const right = Math.max(0, Math.min(size.width, origin.x + width));
  const bottom = Math.max(0, Math.min(size.height, origin.y + height));
  overviewWindow.setAttribute("x", String(x + left * scale));
  overviewWindow.setAttribute("y", String(y + top * scale));
  overviewWindow.setAttribute(
    "width",
    String(Math.max(2, (right - left) * scale)),
  );
  overviewWindow.setAttribute(
    "height",
    String(Math.max(2, (bottom - top) * scale)),
  );
}

function overviewPoint(event: PointerEvent) {
  const frame = overviewOverlay.getBoundingClientRect();
  const { x, y, scale } = overviewProjection!;
  return {
    x: Math.max(
      0,
      Math.min(size.width, (event.clientX - frame.left - x) / scale),
    ),
    y: Math.max(
      0,
      Math.min(size.height, (event.clientY - frame.top - y) / scale),
    ),
  };
}

overview.addEventListener("pointerdown", (event) => {
  event.stopPropagation();
  if (!overviewProjection || !event.isPrimary || event.button !== 0) return;
  const point = overviewPoint(event);
  const halfWidth = scene.clientWidth / zoom / 2;
  const halfHeight = scene.clientHeight / zoom / 2;
  const inside =
    point.x >= origin.x &&
    point.x <= origin.x + 2 * halfWidth &&
    point.y >= origin.y &&
    point.y <= origin.y + 2 * halfHeight;
  overviewDrag = {
    id: event.pointerId,
    x: inside ? point.x - origin.x : halfWidth,
    y: inside ? point.y - origin.y : halfHeight,
  };
  origin = { x: point.x - overviewDrag.x, y: point.y - overviewDrag.y };
  overview.setPointerCapture(event.pointerId);
  overview.classList.add("dragging");
  updateViewport();
});
overview.addEventListener("pointermove", (event) => {
  if (!overviewProjection || overviewDrag?.id !== event.pointerId) return;
  const point = overviewPoint(event);
  origin = { x: point.x - overviewDrag.x, y: point.y - overviewDrag.y };
  updateViewport();
});
for (const name of ["pointerup", "lostpointercapture", "pointercancel"]) {
  overview.addEventListener(name, (event) => {
    if (overviewDrag?.id !== (event as PointerEvent).pointerId) return;
    overviewDrag = undefined;
    overview.classList.remove("dragging");
  });
}
overview.addEventListener("keydown", (event) => {
  const directions: Record<string, readonly [number, number]> = {
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
    ArrowUp: [0, -1],
    ArrowDown: [0, 1],
  };
  const delta = directions[event.key];
  if (!delta) return;
  event.preventDefault();
  const [x, y] = delta;
  origin = {
    x: origin.x + (x * scene.clientWidth) / zoom / 4,
    y: origin.y + (y * scene.clientHeight) / zoom / 4,
  };
  updateViewport();
});
overview.addEventListener("wheel", (event) => event.stopPropagation());
new ResizeObserver(drawOverview).observe(overview);
overviewToggle.onclick = () => {
  const visible = overviewToggle.getAttribute("aria-pressed") !== "true";
  overviewToggle.setAttribute("aria-pressed", String(visible));
  overview.hidden = !visible;
  drawOverview();
  saveView();
};

function controls() {
  back.disabled = navigation || (!canGoBack && inside === undefined);
  layoutMode.hidden = !canGroup;
  layoutMode.disabled = navigation;

  refresh.hidden = drivers.hidden = loads.hidden = moduleMode || traceSnapshot;
  parent.hidden = !moduleMode || inside !== undefined;
  enter.hidden = !moduleMode && !(canGroup && layoutMode.value === "modules");
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
  if (canGroup && layoutMode.value === "modules") {
    if (type === "enter" && selected?.kind === "module") {
      inside = selected.instance ?? "";
      void drawGraph();
      return;
    }
    if (type === "back" && inside !== undefined) {
      inside = undefined;
      void drawGraph();
      return;
    }
  }
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
  if (!redrawTrace) {
    for (const wire of diagram.querySelectorAll<SVGElement>(".edge"))
      wire.classList.toggle(
        "active",
        wire.dataset.from === node.id || wire.dataset.to === node.id,
      );
  }
  selected = node;
  if (loaded && !navigation) saveView();
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

function layoutLargeGraph(
  graph: SchematicGraph,
  sizedBoxes?: Map<string, ElkNode>,
): ElkNode {
  const layers = new Map<string, number>();
  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();
  for (const { from, to } of graph.edges) {
    if (!incoming.has(to)) incoming.set(to, []);
    if (!outgoing.has(from)) outgoing.set(from, []);
    incoming.get(to)!.push(from);
    outgoing.get(from)!.push(to);
  }
  const roots =
    graph.module && !graph.roots?.length
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
  let first = 0;
  for (const layer of layers.values()) first = Math.min(first, layer);
  const rows = new Map<number, number>();
  const columnWidths = new Map<number, number>();
  const boxes = graph.nodes.map((node) => {
    const layer = layers.get(node.id) ?? 0;
    const y = rows.get(layer) ?? 16;
    const box = sizedBoxes?.get(node.id) ?? layoutNode(node);
    const width = box.width!;
    const height = box.height!;
    if (sizedBoxes)
      columnWidths.set(layer, Math.max(columnWidths.get(layer) ?? 0, width));
    rows.set(layer, y + height + (sizedBoxes ? 54 : 18));
    return { ...box, width, height, x: 16 + (layer - first) * 480, y };
  });
  const columns = new Map<number, number>();
  if (sizedBoxes) {
    let left = 32;
    for (const layer of [...columnWidths.keys()].sort((a, b) => a - b)) {
      columns.set(layer, left);
      left += columnWidths.get(layer)! + 96;
    }
    for (const box of boxes) box.x = columns.get(layers.get(box.id) ?? 0)!;
  }
  let width = 1;
  let height = 1;
  for (const box of boxes) {
    width = Math.max(width, box.x + box.width + 48);
    height = Math.max(height, box.y + box.height + 24);
  }
  const byId = new Map(boxes.map((box) => [box.id, box]));
  const ports = new Map(
    boxes.flatMap(({ ports }) => (ports ?? []).map((port) => [port.id, port])),
  );
  return {
    id: "design",
    children: boxes,
    width,
    height,
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
      let bendPoints =
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
      if (sizedBoxes) {
        const fromLane =
          columns.get(layers.get(from) ?? 0)! +
          columnWidths.get(layers.get(from) ?? 0)! +
          24 +
          (index % 6) * 4;
        const toLane = b.x - 24 - (index % 6) * 4;
        if (forward && (layers.get(to) ?? 0) - (layers.get(from) ?? 0) === 1) {
          bendPoints = [
            { x: fromLane, y: startPoint.y },
            { x: fromLane, y: endPoint.y },
          ];
        } else {
          const top = 2 + (index % 6) * 2;
          bendPoints = [
            { x: fromLane, y: startPoint.y },
            { x: fromLane, y: top },
            { x: toLane, y: top },
            { x: toLane, y: endPoint.y },
          ];
        }
      }
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
  const visibleBoxes = spatialIndex(
    boxes.map((box) => ({
      box,
      bounds: {
        minX: box.x!,
        minY: box.y!,
        maxX: box.x! + box.width!,
        maxY: box.y! + box.height!,
      },
    })),
  );
  const connections = new Map<string, number[]>();
  const wires = (layout.edges ?? []).flatMap((edge) => {
    const index = Number(edge.id);
    const connection = graph.edges[index];
    for (const id of new Set([connection.from, connection.to])) {
      const incident = connections.get(id);
      if (incident) incident.push(index);
      else connections.set(id, [index]);
    }
    return (edge.sections ?? []).flatMap(
      ({ startPoint, endPoint, bendPoints }) => {
        const points = [startPoint, ...(bendPoints ?? []), endPoint];
        return points.slice(1).map((end, i) => {
          const start = points[i];
          return {
            index,
            start,
            end,
            bounds: {
              minX: Math.min(start.x, end.x),
              minY: Math.min(start.y, end.y),
              maxX: Math.max(start.x, end.x),
              maxY: Math.max(start.y, end.y),
            },
          };
        });
      },
    );
  });
  const visibleWires = spatialIndex(wires);
  const edgesById = new Map(
    (layout.edges ?? []).map((edge) => [Number(edge.id), edge]),
  );
  let previousSelection: string | undefined;
  const hideSelection = () => {
    if (!previousSelection) return;
    mounted.get(previousSelection)?.classList.remove("selected");
  };

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
    const bounds: Bounds = {
      minX: origin.x,
      minY: origin.y,
      maxX: origin.x + width / zoom,
      maxY: origin.y + height / zoom,
    };
    const overview = zoom < 0.26;
    const margin = 32 / zoom;
    const data = new Path2D();
    const controls = new Path2D();
    const highlighted = new Path2D();
    if (!overview) {
      visibleWires(bounds, ({ index, start, end }) => {
        const lines = graph.edges[index].control ? controls : data;
        lines.moveTo(start.x, start.y);
        lines.lineTo(end.x, end.y);
      });
    }
    // Paint the selected node's edges from adjacency lists so zoomed-out
    // navigation never has to traverse every wire.
    if (selected) {
      for (const index of connections.get(selected.id) ?? []) {
        for (const section of edgesById.get(index)?.sections ?? []) {
          highlighted.moveTo(section.startPoint.x, section.startPoint.y);
          for (const point of section.bendPoints ?? [])
            highlighted.lineTo(point.x, point.y);
          highlighted.lineTo(section.endPoint.x, section.endPoint.y);
        }
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
    if (previousSelection !== selected?.id) hideSelection();
    visibleBoxes(
      {
        minX: bounds.minX - margin,
        minY: bounds.minY - margin,
        maxX: bounds.maxX + margin,
        maxY: bounds.maxY + margin,
      },
      ({ box }) => {
        if (overview) {
          context.globalAlpha = box.id === graph.root ? 1 : 0.42;
          context.fillStyle = box.id === graph.root ? activeColor : dataColor;
          context.fillRect(box.x!, box.y!, box.width!, box.height!);
          return;
        }
        shown.add(box.id);
        let item = mounted.get(box.id);
        if (!item) {
          item = createNode(box);
          mounted.set(box.id, item);
          diagram.append(item);
        }
        if (selected?.id === box.id) item.classList.add("selected");
      },
    );
    previousSelection = selected?.id;
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

function renderFrames(frames: readonly TraceFrame[]) {
  frameLayer.replaceChildren();
  frameLayer.toggleAttribute("hidden", !frames.length);
  if (!frames.length) return;
  const active = new Map<string, SVGGElement>();
  const visible = spatialIndex(
    frames.map((frame) => ({
      frame,
      bounds: {
        minX: frame.x,
        minY: frame.y,
        maxX: frame.x + frame.width,
        maxY: frame.y + frame.height,
      },
    })),
  );
  return () => {
    const shown = new Set<string>();
    visible(
      {
        minX: origin.x,
        minY: origin.y,
        maxX: origin.x + scene.clientWidth / zoom,
        maxY: origin.y + scene.clientHeight / zoom,
      },
      ({ frame }) => {
        shown.add(frame.id);
        if (active.has(frame.id)) return;
        const element = svg("g", {
          class: "trace-frame",
          "data-instance": frame.label,
          transform: `translate(${frame.x},${frame.y})`,
        });
        const label = svg("text", { x: 12, y: 20 });
        const characters = Math.max(12, Math.floor((frame.width - 24) / 8));
        label.textContent =
          frame.label.length <= characters
            ? frame.label
            : "…" + frame.label.slice(1 - characters);
        element.append(
          svg("rect", { width: frame.width, height: frame.height, rx: 6 }),
          svg("line", {
            class: "header",
            x1: 0,
            x2: frame.width,
            y1: 29,
            y2: 29,
          }),
          label,
        );
        active.set(frame.id, element);
        frameLayer.append(element);
      },
    );
    for (const [id, element] of active)
      if (!shown.has(id)) {
        element.remove();
        active.delete(id);
      }
  };
}

async function render(
  graph: SchematicGraph,
  generation: number,
  view?: SchematicView,
  expanded = false,
) {
  const portCount = graph.nodes.reduce(
    (total, node) => total + (node.ports?.length ?? 0),
    0,
  );
  const large =
    graph.nodes.length > 220 ||
    graph.edges.length > (expanded ? 250 : 450) ||
    portCount > 600;
  const elk = large ? undefined : new ELK();
  const layoutGraph = async (
    model: SchematicGraph,
    boxes?: Map<string, ElkNode>,
  ) =>
    elk
      ? elk.layout<ElkNode>({
          id: "design",
          layoutOptions: {
            "elk.algorithm": "layered",
            "elk.direction": "RIGHT",
            "elk.edgeRouting": "ORTHOGONAL",
            "elk.layered.spacing.nodeNodeBetweenLayers": expanded ? "84" : "54",
          },
          children: model.nodes.map(
            (node) => boxes?.get(node.id) ?? layoutNode(node),
          ),
          edges: model.edges.map(
            ({ from, to, fromPort, toPort, label }, index) => ({
              id: String(index),
              sources: [fromPort ?? from],
              targets: [toPort ?? to],
              labels: label
                ? [{ text: label, width: label.length * 7 + 4, height: 15 }]
                : undefined,
            }),
          ),
        } satisfies ElkNode)
      : layoutLargeGraph(model, boxes);
  const compound = expanded
    ? await layoutTraceFrames(graph, layoutGraph)
    : undefined;
  const layout = compound?.layout ?? (await layoutGraph(graph));
  graph = compound?.graph ?? graph;
  if (generation !== layoutGeneration) return;
  redrawTrace = undefined;
  canvas.hidden = !large;
  diagram.replaceChildren();
  selected = undefined;
  selectedLabel.textContent = "";
  size = {
    width: Math.max(1, layout.width ?? 1),
    height: Math.max(1, layout.height ?? 1),
  };
  overviewBoxes = layout.children ?? [];
  overviewFrames = compound?.frames ?? [];
  redrawFrames = renderFrames(overviewFrames);
  overviewToggle.disabled = !overviewBoxes.length;
  overview.hidden =
    overviewToggle.disabled ||
    overviewToggle.getAttribute("aria-pressed") !== "true";
  overviewDrag = undefined;
  overview.classList.remove("dragging");
  drawOverview();

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
          (expanded && connection.fromPort && connection.toPort
            ? " trace-interface"
            : "") +
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
    if (expanded && box.width === 0) {
      const output = node.direction === "output";
      const element = svg("g", {
        class: "trace-boundary-port",
        "data-direction": node.direction!,
        transform: `translate(${box.x},${box.y})`,
      });
      const label = svg("text", {
        x: output ? -8 : 8,
        y: -5,
        "text-anchor": output ? "end" : "start",
      });
      label.textContent =
        node.label.length > 18 ? node.label.slice(0, 17) + "…" : node.label;
      const tooltip = svg("title", {});
      tooltip.textContent = node.label;
      element.append(tooltip, svg("circle", { cx: 0, cy: 0, r: 4 }), label);
      return element;
    }
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
    const rootNode = nodes.get(view?.selected ?? graph.root);
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
      if (box.id === (view?.selected ?? graph.root))
        select(nodes.get(box.id)!, element);
    }
    fit();
  }
  if (
    view &&
    Number.isFinite(view.zoom) &&
    view.zoom > 0 &&
    view.zoom <= 8 &&
    Number.isFinite(view.origin?.x) &&
    Number.isFinite(view.origin?.y)
  ) {
    zoom = view.zoom;
    origin = view.origin;
    updateViewport();
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

async function drawGraph(view?: SchematicView) {
  const grouped = canGroup && layoutMode.value === "modules";
  const graph = grouped ? moduleTraceView(baseGraph, inside) : baseGraph;
  const generation = ++layoutGeneration;
  navigation = true;
  moduleMode = !!graph.module;
  canGoUp = !!graph.module?.parent;
  title.textContent =
    inside === undefined
      ? baseTitle
      : baseTitle + " · " + (inside || "未定位实例");
  title.title = title.textContent;
  status.textContent = "正在布局…";
  controls();
  try {
    await render(
      graph,
      generation,
      view,
      canGroup && layoutMode.value === "expanded",
    );
    if (generation !== layoutGeneration) return;
    loaded = true;
    canGoBack = hostCanGoBack;
    saveView();
  } catch (error) {
    if (generation === layoutGeneration) status.textContent = String(error);
  } finally {
    if (generation === layoutGeneration) {
      navigation = false;
      controls();
    }
  }
}
layoutMode.onchange = () => {
  inside = undefined;
  void drawGraph();
};
window.addEventListener("message", (event) => {
  if (event.data.type === "navigationError") {
    navigation = false;
    controls();
    status.textContent = event.data.message;
    return;
  }
  if (event.data.type !== "schematic") return;
  baseGraph = event.data.graph;
  baseTitle = event.data.title;
  panelState = event.data.restore;
  revision = event.data.revision ?? 0;
  hostCanGoBack = !!event.data.canGoBack;
  traceSnapshot = !!event.data.traceSnapshot;
  canOpenModule = !!event.data.canOpenModule;
  canGroup =
    !baseGraph.module && baseGraph.nodes.some(({ instance }) => !!instance);
  if (previousView) {
    layoutMode.value =
      canGroup && ["signals", "modules", "expanded"].includes(previousView.mode)
        ? previousView.mode
        : "signals";
    inside = layoutMode.value === "modules" ? previousView.inside : undefined;
    overviewToggle.setAttribute(
      "aria-pressed",
      String(previousView.overview !== false),
    );
  } else if (
    !canGroup ||
    !baseGraph.nodes.some(({ instance }) => (instance ?? "") === inside)
  ) {
    inside = undefined;
  }
  const view = previousView;
  previousView = undefined;
  void drawGraph(view);
});
vscode.postMessage({ type: "ready" });
