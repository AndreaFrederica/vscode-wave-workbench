// SPDX-License-Identifier: MPL-2.0

import type {
  LiveWaveSample,
  LiveWaveUpdate,
  LiveWaveWindow,
} from "../shared/live-wave";
import { drawBusLabel } from "./bus-label";

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };
const vscode = acquireVsCodeApi();
const byId = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const follow = byId<HTMLInputElement>("follow");
const wave = byId("wave");
const rows = byId("rows");
const canvas = byId<HTMLCanvasElement>("timeline");
const status = byId("status");
const time = byId("time");
const empty = byId("empty");
const picker = byId<HTMLDetailsElement>("channels");
const filter = byId<HTMLInputElement>("filter");
const options = byId("channel-options");
const fit = byId<HTMLButtonElement>("fit");
const zoomIn = byId<HTMLButtonElement>("zoom-in");
const zoomOut = byId<HTMLButtonElement>("zoom-out");

const rulerHeight = 24;
const rowHeight = 27;
const stateLabels = {
  paused: "已暂停",
  running: "运行中",
  stepping: "单步执行中",
  exited: "已结束",
  error: "仿真出错",
};
let sessionId: string | undefined;
let revision = -1;
let scale = "";
let firstTick: bigint | undefined;
let lastTick: bigint | undefined;
let latest: LiveWaveSample | undefined;
let summary = "";
let summaryTitle = "";
let overview: (LiveWaveSample & { coordinate: bigint })[] = [];
let overviewApproximate = false;
let approximate = false;
let exactCursor: LiveWaveSample | undefined;
let windowError: string | undefined;
let windowTimer: ReturnType<typeof setTimeout> | undefined;
let request = 0;
let samples: (LiveWaveSample & { coordinate: bigint })[] = [];
const channels = new Set<string>();
const enabled = new Set<string>();
let selected: string[] = [];
const rowValues = new Map<string, HTMLElement>();
let start = 0n;
let end = 1n;
let cursor = 0n;
let drawing = false;
let gesture:
  | { x: number; start: bigint; end: bigint; moved: boolean }
  | undefined;

function clamp(value: bigint, min: bigint, max: bigint) {
  return value < min ? min : value > max ? max : value;
}

function limits() {
  const first = firstTick!;
  const last = lastTick!;
  return { first, last, upper: last > first ? last : first + 1n };
}

function setRange(left: bigint, right: bigint) {
  const { first, upper } = limits();
  const length = clamp(right - left, 1n, upper - first);
  start = clamp(left, first, upper - length);
  end = start + length;
}

function alignWindow() {
  const { first, last, upper } = limits();
  if (follow.checked) {
    setRange(first, upper);
    cursor = last;
  } else {
    setRange(start, end);
    cursor = clamp(cursor, first, last);
  }
}

function firstAfter(tick: bigint) {
  let low = 0;
  let high = samples.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (samples[middle].coordinate <= tick) low = middle + 1;
    else high = middle;
  }
  return low;
}

function sampledValue(sample: LiveWaveSample | undefined, name: string) {
  return sample && Object.hasOwn(sample.values, name)
    ? sample.values[name]
    : undefined;
}

function displayValue(value?: string) {
  if (value === undefined) return "—";
  if (value.length <= 1 || !/^[01]+$/.test(value)) return value;
  return (
    "0x" +
    BigInt("0b" + value)
      .toString(16)
      .padStart(Math.ceil(value.length / 4), "0")
  );
}

function refreshRows() {
  selected = [...channels].filter((name) => enabled.has(name));
  rowValues.clear();
  rows.replaceChildren();
  for (const signal of selected) {
    const row = document.createElement("div");
    row.className = "row";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = signal;
    name.title = signal;
    const value = document.createElement("output");
    value.className = "value";
    rowValues.set(signal, value);
    row.append(name, value);
    rows.append(row);
  }
  const height = rulerHeight + selected.length * rowHeight;
  canvas.style.height = height + "px";
  requestDraw();
}

function refreshPicker() {
  if (!picker.open) return;
  const query = filter.value.trim().toLowerCase();
  options.replaceChildren();
  for (const name of channels) {
    if (!name.toLowerCase().includes(query)) continue;
    const label = document.createElement("label");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = enabled.has(name);
    checkbox.onchange = () => {
      if (checkbox.checked) enabled.add(name);
      else enabled.delete(name);
      display();
      refreshRows();
    };
    label.append(checkbox, name);
    options.append(label);
  }
}

function display() {
  const active = lastTick !== undefined;
  follow.disabled = !active;
  fit.disabled = zoomIn.disabled = zoomOut.disabled = !active;
  picker.setAttribute("aria-disabled", String(!active));
  const hasRows = active && enabled.size > 0;
  wave.hidden = !hasRows;
  empty.hidden = hasRows;
  empty.textContent = active
    ? "从「信号」菜单选择要显示的信号。"
    : "启动或附加在线仿真后，采样的信号会显示在这里。";
}

function receive(update: LiveWaveUpdate) {
  const newSession = update.sessionId !== sessionId;
  if (!newSession && update.revision < revision) return;
  if (newSession) {
    sessionId = update.sessionId;
    channels.clear();
    enabled.clear();
    follow.checked = true;
    gesture = undefined;
    windowError = undefined;
    clearTimeout(windowTimer);
    request++;
  }
  firstTick =
    update.firstTick === undefined ? undefined : BigInt(update.firstTick);
  lastTick =
    update.lastTick === undefined ? undefined : BigInt(update.lastTick);
  overview = coordinates(update.samples);
  latest = overview.at(-1);
  overviewApproximate = update.approximate;
  let changed = newSession;
  const fillDefault = channels.size === 0;
  for (const sample of update.samples) {
    for (const name of Object.keys(sample.values)) {
      if (channels.has(name)) continue;
      if (fillDefault && enabled.size < 8) enabled.add(name);
      channels.add(name);
      changed = true;
    }
  }
  revision = update.revision;
  scale = update.scale ?? "";
  summary =
    stateLabels[update.state] +
    (update.historyFailure ? " · 波形记录已停止" : "");
  summaryTitle = update.historyFailure ?? update.failure ?? "";
  if (lastTick !== undefined) alignWindow();
  if (follow.checked) {
    samples = overview;
    approximate = overviewApproximate;
    exactCursor = latest;
  }
  display();
  if (changed) {
    refreshRows();
    refreshPicker();
  }
  requestDraw();
}

function coordinates(samples: LiveWaveSample[]) {
  return samples.map((sample) => ({
    ...sample,
    coordinate: BigInt(sample.tick),
  }));
}

function inspectWindow() {
  exactCursor = undefined;
  windowError = undefined;
  samples = overview;
  approximate = overviewApproximate;
  clearTimeout(windowTimer);
  const requested = ++request;
  windowTimer = setTimeout(() => {
    vscode.postMessage({
      type: "readWindow",
      sessionId,
      request: requested,
      start: String(start),
      end: String(end),
      cursor: String(cursor),
    });
  }, 60);
  requestDraw();
}

function receiveWindow(
  reply: LiveWaveWindow & {
    sessionId: string;
    request: number;
    error?: string;
  },
) {
  if (
    reply.sessionId !== sessionId ||
    reply.request !== request ||
    follow.checked
  )
    return;
  windowError = reply.error;
  if (!reply.error) {
    samples = coordinates(reply.samples);
    approximate = reply.approximate;
    exactCursor = reply.cursor;
  }
  requestDraw();
}

function requestDraw() {
  if (drawing) return;
  drawing = true;
  requestAnimationFrame(() => {
    drawing = false;
    draw();
  });
}

function draw() {
  if (!latest) {
    time.textContent = "";
    return;
  }
  const rangeLabel =
    start + " → " + (end > lastTick! ? lastTick : end) + " × " + scale;
  time.textContent = follow.checked
    ? rangeLabel
    : "游标 " + cursor + " · 最新 " + latest.tick + " × " + scale;
  status.textContent =
    summary +
    (windowError ? " · 读取采样失败" : approximate ? " · 采样概览" : "");
  status.title = windowError ?? summaryTitle;
  for (const [signal, element] of rowValues) {
    const value = sampledValue(exactCursor, signal);
    element.textContent = displayValue(value);
    element.title = value ?? "缺少采样";
  }
  if (wave.hidden) return;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (!width || !height) return;
  const pixelRatio = window.devicePixelRatio || 1;
  const pixelWidth = Math.round(width * pixelRatio);
  const pixelHeight = Math.round(height * pixelRatio);
  if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
  if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const style = getComputedStyle(document.body);
  const color = (key: string, fallback: string) =>
    style.getPropertyValue(key).trim() || fallback;
  const font = "11px " + color("--vscode-editor-font-family", "monospace");
  const grid = color("--vscode-panel-border", "#666");
  const foreground = style.color;
  const palette = [
    color("--vscode-charts-blue", "#58a6ff"),
    color("--vscode-charts-green", "#66cf95"),
    color("--vscode-charts-purple", "#a58fe9"),
    color("--vscode-charts-yellow", "#daa54e"),
  ];
  const unknown = color("--vscode-errorForeground", "#ff7979");
  const highImpedance = color("--vscode-editorWarning-foreground", "#daa54e");
  const extent = end - start;
  const x = (tick: bigint) =>
    (Number(tick - start) / Number(extent)) * (width - 1);
  ctx.font = font;
  ctx.textBaseline = "middle";
  ctx.strokeStyle = grid;
  ctx.fillStyle = foreground;
  const divisions = Math.max(1, Math.floor(width / 115));
  const step = extent / BigInt(divisions) || 1n;
  const magnitude = 10n ** BigInt(step.toString().length - 1);
  const spacing = ((step + magnitude - 1n) / magnitude) * magnitude;
  for (
    let tick = ((start + spacing - 1n) / spacing) * spacing;
    tick <= end;
    tick += spacing
  ) {
    const position = x(tick);
    ctx.beginPath();
    ctx.moveTo(position, rulerHeight);
    ctx.lineTo(position, height);
    ctx.stroke();
    ctx.fillText(String(tick), position + 3, rulerHeight / 2);
  }

  const first = Math.max(0, firstAfter(start) - 1);
  const last = firstAfter(end);
  for (const [row, name] of selected.entries()) {
    const bottom = rulerHeight + (row + 1) * rowHeight;
    const middle = bottom - rowHeight / 2;
    ctx.strokeStyle = grid;
    ctx.beginPath();
    ctx.moveTo(0, bottom - 0.5);
    ctx.lineTo(width, bottom - 0.5);
    ctx.stroke();

    let previous: string | undefined;
    for (let index = first; index < last; ) {
      const sample = samples[index];
      const value = sampledValue(sample, name);
      let next = index + 1;
      while (next < last && sampledValue(samples[next], name) === value) next++;
      index = next;
      if (value === undefined) {
        previous = undefined;
        continue;
      }
      const left = x(clamp(sample.coordinate, start, end));
      const right = x(
        clamp(samples[next]?.coordinate ?? lastTick!, start, end),
      );
      if (right < left) continue;
      const top = middle - 7;
      const low = middle + 7;
      const invalid = /[xz]/i.test(value);
      ctx.fillStyle = ctx.strokeStyle = /x/i.test(value)
        ? unknown
        : invalid
          ? highImpedance
          : palette[row % palette.length];
      ctx.beginPath();
      if (value.length === 1 && !invalid) {
        const level = value === "1" ? top : low;
        if (previous === "0" || previous === "1") {
          ctx.moveTo(left, previous === "1" ? top : low);
          ctx.lineTo(left, level);
        } else ctx.moveTo(left, level);
        ctx.lineTo(Math.max(right, left + 1), level);
      } else {
        const bevel = Math.min(4, (right - left) / 2);
        ctx.moveTo(left, middle);
        ctx.lineTo(left + bevel, top);
        ctx.lineTo(right - bevel, top);
        ctx.lineTo(right, middle);
        ctx.lineTo(right - bevel, low);
        ctx.lineTo(left + bevel, low);
        ctx.closePath();
      }
      ctx.stroke();
      if ((value.length > 1 || invalid) && right - left >= 12)
        drawBusLabel(ctx, displayValue(value), left, right, middle, "auto");
      previous = value;
    }
  }

  if (cursor >= start && cursor <= end) {
    const position = x(cursor);
    ctx.strokeStyle = color("--vscode-focusBorder", "#888");
    ctx.beginPath();
    ctx.moveTo(position, 0);
    ctx.lineTo(position, height);
    ctx.stroke();
  }
}

function zoom(expand: boolean) {
  if (lastTick === undefined) return;
  const width = end - start;
  const next = expand ? width * 2n : width / 2n || 1n;
  follow.checked = false;
  const anchor = cursor >= start && cursor <= end ? cursor : start + width / 2n;
  const left = anchor - ((anchor - start) * next) / width;
  setRange(left, left + next);
  inspectWindow();
}

zoomIn.onclick = () => zoom(false);
zoomOut.onclick = () => zoom(true);
fit.onclick = () => {
  if (lastTick === undefined) return;
  follow.checked = true;
  followLatest();
};
follow.onchange = () => {
  if (lastTick === undefined) return;
  if (follow.checked) followLatest();
  else inspectWindow();
};

function followLatest() {
  clearTimeout(windowTimer);
  request++;
  alignWindow();
  samples = overview;
  approximate = overviewApproximate;
  exactCursor = latest;
  windowError = undefined;
  requestDraw();
}

filter.oninput = refreshPicker;
picker.ontoggle = refreshPicker;
canvas.addEventListener(
  "wheel",
  (event) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    zoom(event.deltaY > 0);
  },
  { passive: false },
);
canvas.onpointerdown = (event) => {
  if (lastTick === undefined || event.button !== 0) return;
  gesture = { x: event.clientX, start, end, moved: false };
  canvas.setPointerCapture(event.pointerId);
};
canvas.onpointermove = (event) => {
  if (!gesture) return;
  const delta = event.clientX - gesture.x;
  if (Math.abs(delta) < 3 && !gesture.moved) return;
  gesture.moved = true;
  follow.checked = false;
  const shift =
    (BigInt(Math.trunc(delta)) * (gesture.end - gesture.start)) /
    BigInt(Math.max(1, canvas.clientWidth));
  setRange(gesture.start - shift, gesture.end - shift);
  inspectWindow();
};
canvas.onlostpointercapture = () => {
  gesture = undefined;
};
canvas.onpointerup = (event) => {
  if (gesture && !gesture.moved) {
    const offset = clamp(
      BigInt(Math.round(event.clientX - canvas.getBoundingClientRect().left)),
      0n,
      BigInt(canvas.clientWidth),
    );
    const tick =
      start +
      (offset * (end - start)) / BigInt(Math.max(1, canvas.clientWidth - 1));
    const { first, last } = limits();
    follow.checked = false;
    cursor = clamp(tick, first, last);
    inspectWindow();
  }
  gesture = undefined;
};

new ResizeObserver(requestDraw).observe(wave);
new MutationObserver(requestDraw).observe(document.body, {
  attributes: true,
  attributeFilter: ["class"],
});
window.addEventListener("message", ({ data }: MessageEvent) => {
  if (data?.type === "liveWave") receive(data);
  if (data?.type === "liveWaveWindow") receiveWindow(data);
});
display();
vscode.postMessage({ type: "ready" });
