// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { getElement as $ } from "./dom";
import { renderClipImage } from "./clip-image";
import { realLabel } from "../shared/analog";
import { drawAnalog } from "./analog-render";
import {
  validDecoderInstances,
  type DecoderInstance,
  type DecodeResult,
} from "../decoder-runtime/types";
import { drawBusLabel } from "./bus-label";
import { scaleSeconds } from "../shared/time";
import { renderTags } from "./tags";
import {
  isTagColor,
  normalizeTagColors,
  tagStyle,
  type TagColors,
} from "../shared/tags";
import {
  decodeUart,
  uartBitTicks,
  type UartFrame,
  type UartOptions,
} from "../shared/uart";
import * as WaveSignal from "../shared/signals";
import {
  decodeWord,
  normalizeAnnotation,
  supportsProfile,
  validateProfile,
  uartFrameLabel,
  type DecoderCatalog,
  type DecoderGroup,
  type DecoderProfile,
  type Rule,
} from "../shared/decoders";
import type {
  Signal,
  Metadata,
  WaveState,
  Block,
  BusLabelMode,
  Marker,
  QueryResult,
} from "../shared/protocol";
/* global acquireVsCodeApi */
const vscode = acquireVsCodeApi<Partial<WaveState>>();

const DEFAULT_ROW_HEIGHT = 32;
let colors: string[] = [],
  theme: Record<string, string> = {};
function readTheme() {
  const css = getComputedStyle(document.body),
    color = (name) => css.getPropertyValue(name).trim();
  colors = Array.from({ length: 5 }, (_, i) => color("--wave-" + i));
  theme = {
    background: color("--bg"),
    grid: color("--grid"),
    foreground: color("--muted"),
    error: color("--error"),
    warning: color("--warning"),
    cursorA: color("--cursor-a"),
    cursorB: color("--cursor-b"),
  };
}
readTheme();
interface WaveRead {
  start: number;
  end: number;
  block: Block;
}

let meta: Metadata,
  chosen: Signal[] = [],
  data: Record<string, WaveRead> = {},
  active = 0,
  start = 0,
  end = 1,
  cursorA = 0,
  cursorB = null,
  radix: import("../shared/protocol").Radix = "hex",
  markers: Marker[] = [],
  displayScale = null,
  displayFactor = 1;
let generation = 0,
  inflight: { request: number; start: number; end: number } | null = null,
  neededIds: string[] = [],
  prefetchIds: string[] = [],
  retainedIds = new Set<string>(),
  dragIndex = null,
  pan = null,
  searchRequest = 0,
  searchTimer;
const saved = vscode.getState() || {};
let decoderInstances = validDecoderInstances(saved.decoderInstances)
  ? saved.decoderInstances
  : [];
let decoderRequest = 0;
interface DecoderLane {
  lane: HTMLElement;
  items: HTMLElement;
  status: HTMLElement;
  key?: string;
  request?: number;
  timer?: ReturnType<typeof setTimeout>;
}
const decoderLanes = new Map<string, DecoderLane>();

function cancelDecoder(id: string) {
  const lane = decoderLanes.get(id);
  if (!lane) return;
  clearTimeout(lane.timer);
  lane.request = undefined;
  vscode.postMessage({ type: "cancelWaveDecoder", instanceId: id });
}

function detachDecoder(id: string) {
  cancelDecoder(id);
  decoderLanes.get(id)?.lane.remove();
  decoderLanes.delete(id);
  decoderInstances = decoderInstances.filter(
    (instance) => instance.instanceId !== id,
  );
  publishProjectState();
}

function mountDecoder(id: string, name: string): DecoderLane {
  const lane = document.createElement("div");
  lane.className = "decoderTrack";
  const controls = document.createElement("div");
  controls.className = "decoderTrackControls";
  const label = document.createElement("strong");
  label.className = "decoderTrackName";
  label.textContent = name;
  controls.append(label);
  for (const [title, action] of [
    ["重载", () => scheduleDecoder(id)],
    [
      "取消",
      () => {
        cancelDecoder(id);
        decoderLanes.get(id)!.status.textContent = "已取消";
      },
    ],
    [
      "生成虚拟信号",
      () => {
        const instance = decoderInstances.find(
          (item) => item.instanceId === id,
        );
        if (instance)
          vscode.postMessage({ type: "materializeDecoderSignal", instance });
      },
    ],
    ["移除", () => detachDecoder(id)],
  ] as const) {
    const button = document.createElement("button");
    button.textContent = title;
    button.onclick = action;
    controls.append(button);
  }
  const plot = document.createElement("div");
  plot.className = "decoderTrackPlot";
  const items = document.createElement("div");
  items.className = "decoderTrackItems";
  const status = document.createElement("span");
  status.className = "decoderTrackStatus";
  status.setAttribute("role", "status");
  plot.append(items, status);
  lane.append(controls, plot);
  $("decoderTracks").append(lane);
  const mounted = { lane, items, status };
  decoderLanes.set(id, mounted);
  return mounted;
}

function scheduleDecoder(refresh?: string) {
  if (!meta || !Number.isSafeInteger(start) || !Number.isSafeInteger(end))
    return;
  const last = end === Number(meta.end) ? BigInt(end) + 1n : BigInt(end);
  for (const instance of decoderInstances) {
    const id = instance.instanceId!;
    const lane = decoderLanes.get(id) ?? mountDecoder(id, instance.decoderId);
    const key = JSON.stringify([instance, start, String(last)]);
    if (lane.key === key && refresh !== id) continue;
    cancelDecoder(id);
    lane.key = key;
    const request = (lane.request = ++decoderRequest);
    lane.items.replaceChildren();
    lane.status.textContent = "解码中…";
    lane.timer = setTimeout(
      () =>
        vscode.postMessage({
          type: "queryWaveDecoder",
          instance,
          request,
          start: String(start),
          end: String(last),
        }),
      180,
    );
  }
}

function showDecoderResult(
  lane: { items: HTMLElement; status: HTMLElement },
  result: DecodeResult,
) {
  lane.items.replaceChildren();
  for (const item of result.transactions) {
    const first = Math.max(start, Number(item.start));
    const last = Math.min(end, Number(item.end));
    if (first >= last) continue;
    const button = document.createElement("button");
    button.className = "decoderTransaction " + (item.severity ?? "");
    button.textContent = item.label;
    button.title = [
      item.start + " → " + item.end,
      item.label,
      ...Object.entries(item.fields ?? {}).map(
        ([name, value]) => name + " = " + JSON.stringify(value),
      ),
    ].join("\n");
    button.style.left = ((first - start) / (end - start)) * 100 + "%";
    button.style.width = ((last - first) / (end - start)) * 100 + "%";
    button.onclick = () => {
      cursorA = first;
      request();
    };
    lane.items.append(button);
  }
  lane.status.textContent =
    result.warnings[0] ??
    (result.truncated
      ? "结果已截断"
      : result.transactions.length
        ? ""
        : "窗口内无事务");
}

$("configureWaveDecoder").onclick = () =>
  vscode.postMessage({ type: "configureWaveDecoder" });
$("manageWaveDecoders").onclick = () =>
  vscode.postMessage({ type: "manageWaveDecoders" });
const key = WaveSignal.key;
let selectedKeys = new Set<string>(),
  selectionAnchor = 0,
  displayRows: { index?: number; group?: string; count?: number }[] = [],
  collapsedGroups = new Set(saved.collapsedGroups || []);
let groupOrder = [...new Set(saved.groupOrder || [])],
  activeGroup = saved.activeGroup || "";
let signalFilter = saved.signalFilter || "";
let expandedBuses = new Set(saved.expandedBuses || []);
let virtualDefinitions = saved.virtualDefinitions || [];
let markersVisible = saved.markersVisible !== false;
let tooltipEnabled = saved.tooltipEnabled !== false;
let busLabelMode: BusLabelMode =
  saved.busLabelMode === "full" ? "full" : "auto";
const showInlineTags = $("showInlineTags");
const showDecodedValues = $("showDecodedValues");
const waveTagStyle = $("waveTagStyle");
let tagColors: TagColors = {};
function applyValueDisplay(state: Partial<WaveState>) {
  showInlineTags.checked = state.showInlineTags === true;
  showDecodedValues.checked = state.showDecodedValues !== false;
  waveTagStyle.value = tagStyle(state.tagStyle);
  tagColors = normalizeTagColors(state.tagColors);
}
applyValueDisplay(saved);
showInlineTags.onchange =
  showDecodedValues.onchange =
  waveTagStyle.onchange =
    () => {
      persist();
      if (meta) render();
    };
let clearWaveHover: () => void;
let rowHeight = normalizeRowHeight(saved.rowHeight);
let namesFraction = normalizeNamesFraction(saved.namesFraction);
let valueFraction = normalizeValueFraction(saved.valueFraction);
let timelineHeight = DEFAULT_ROW_HEIGHT;

function normalizeRowHeight(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.round(Math.min(80, Math.max(24, value)))
    : DEFAULT_ROW_HEIGHT;
}
function normalizeNamesFraction(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(0.75, Math.max(0.1, value))
    : undefined;
}
function normalizeValueFraction(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : undefined;
}
function applyTrackLayout() {
  const tracks = $("tracks");
  tracks.style.setProperty("--wave-row-height", rowHeight + "px");
  const namesWidth =
    namesFraction === undefined ? "280px" : namesFraction * 100 + "%";
  tracks.style.setProperty("--wave-names-width", namesWidth);
  $("decoderTracks").style.setProperty("--wave-names-width", namesWidth);
  ($("waveRowHeight") as HTMLInputElement).value = String(rowHeight);
  $("waveSplit").setAttribute(
    "aria-valuenow",
    String(Math.round(100 * (namesFraction ?? 0.3))),
  );
}
applyTrackLayout();
let persistTimer;
let sentRtlCursor: string;
function publishRtlCursor() {
  if (!meta) return;
  const stamp = JSON.stringify([cursorA, displayFactor, displayScale]);
  if (stamp === sentRtlCursor) return;
  sentRtlCursor = stamp;
  vscode.postMessage({
    type: "rtlCursor",
    tick: cursorA,
    displayFactor,
    displayScale,
  });
}
let projectSignature: string | undefined;
let projectDirty = false;
let projectTimer: number | undefined;
const signatureOf = (view: WaveState) =>
  JSON.stringify({ ...view, scrollTop: undefined });
function publishProjectState(baseline = false) {
  if (projectTimer !== undefined) clearTimeout(projectTimer);
  projectTimer = undefined;
  const view = snapshot();
  const signature = signatureOf(view);
  if (!baseline && signature === projectSignature) return;
  projectSignature = signature;
  projectDirty = !baseline;
  vscode.postMessage({ type: "projectState", view, baseline });
}
let cursorValues = {},
  cursorFlight = null,
  cursorSequence = 0;
function persist() {
  publishRtlCursor();
  if (projectSignature !== undefined) {
    if (!projectDirty) publishProjectState();
    else projectTimer ??= window.setTimeout(publishProjectState, 100);
  }
  clearTimeout(persistTimer);
  persistTimer = window.setTimeout(
    () =>
      vscode.setState({
        chosen: chosen.map((s) => ({
          id: s.id,
          scope: s.scope,
          name: s.name,
          group: s.group,
          displayRadix: s.displayRadix,
          displayName: s.displayName,
          highlight: s.highlight,
          notation: s.notation,
          bitOffset: s.bitOffset,
          sourceWidth: s.sourceWidth,
          parentBus: s.parentBus,
          decoder: s.decoder,
          annotation: s.annotation,
          unit: s.unit,
        })),
        start,
        end,
        cursorA,
        cursorB,
        radix,
        markers,
        markersVisible,
        tooltipEnabled,
        showInlineTags: showInlineTags.checked,
        tagStyle: tagStyle(waveTagStyle.value),
        tagColors,
        showDecodedValues: showDecodedValues.checked,
        busLabelMode,
        rowHeight,
        namesFraction,
        valueFraction,
        displayScale,
        displayFactor,
        collapsedGroups: [...collapsedGroups],
        groupOrder,
        activeGroup,
        signalFilter,
        virtualDefinitions,
        expandedBuses: [...expandedBuses],
        scrollTop: $("tracks").scrollTop,
        scope: window.waveWorkflow?.selectedScope() || "",
      }),
    100,
  );
}
function status(text, kind = "") {
  $("status").textContent = text;
  $("status").title = text;
  $("status").className = kind;
}
function valueAt(events, time) {
  let lo = 0,
    hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (Number(events[mid][0]) <= time) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}
function format(raw, width, mode = radix) {
  if (raw == null) return "—";
  if (!/^[01xz]+$/i.test(raw)) return raw;
  let bits = raw.toLowerCase();
  bits = bits.padStart(width, /^[xz]/.test(bits) ? bits[0] : "0");
  if (mode === "bin") return bits;
  if (/[xz]/.test(bits)) return bits.includes("x") ? "X" : "Z";
  try {
    let n = BigInt("0b" + bits);
    if (mode === "signed" && bits[0] === "1") n -= 1n << BigInt(width);
    return mode === "oct"
      ? n.toString(8)
      : mode === "hex"
        ? n
            .toString(16)
            .toUpperCase()
            .padStart(Math.ceil(width / 4), "0")
        : n.toString();
  } catch {
    return raw;
  }
}
function formatSignal(raw, s) {
  if (s.real) {
    const value = realLabel(raw);
    return s.unit && value !== "—" ? value + " " + s.unit : value;
  }
  const value = format(
    WaveSignal.project(raw, s),
    s.width,
    s.displayRadix || radix,
  );
  if (raw == null || s.notation !== "verilog") return value;
  const mode = s.displayRadix || radix;
  return (
    (value.startsWith("-") ? "-" : "") +
    s.width +
    "'" +
    ({ bin: "b", oct: "o", hex: "h", signed: "sd", unsigned: "d" }[mode] ||
      "h") +
    (value.startsWith("-") ? value.slice(1) : value)
  );
}
function timeLabel(t) {
  return `${String(t / displayFactor)} × ${displayScale || meta?.scale || "tick"}`;
}
const OVERSCAN = 4,
  MAX_SIGNALS = 100000;
let firstRow = 0,
  lastRow = 0,
  viewportHeight = 1,
  frame = 0;
function rebuildRows() {
  displayRows = [];
  const groups = new Map(groupOrder.map((name) => [name, []])),
    loose = [];
  chosen.forEach((s, index) => {
    if (s.group) {
      if (!groups.has(s.group)) {
        groups.set(s.group, []);
        groupOrder.push(s.group);
      }
      groups.get(s.group).push(index);
    } else loose.push(index);
  });
  function flatten(indices) {
    const set = new Set(indices.map((i) => key(chosen[i]))),
      children = new Map();
    for (const i of indices) {
      const s = chosen[i];
      if (s.parentBus && set.has(s.parentBus)) {
        if (!children.has(s.parentBus)) children.set(s.parentBus, []);
        children.get(s.parentBus).push(i);
      }
    }
    const filter = signalFilter.trim().toLowerCase();
    const matches = (i) => {
      const s = chosen[i];
      if (filter.startsWith("tag:"))
        return s.annotation?.tags.some((tag) =>
          tag.toLowerCase().includes(filter.slice(4).trim()),
        );
      return [
        WaveSignal.label(s),
        `${s.scope}.${s.name}`,
        ...(s.annotation?.tags || []),
      ].some((text) => text.toLowerCase().includes(filter));
    };
    const rows = [];
    for (const i of indices) {
      const s = chosen[i];
      if (s.parentBus && set.has(s.parentBus)) continue;
      const kids = children.get(key(s)) || [];
      if (!matches(i) && !kids.some(matches)) continue;
      rows.push({ index: i });
      if (expandedBuses.has(key(s)) || signalFilter)
        for (const child of kids)
          if (matches(child)) rows.push({ index: child });
    }
    return rows;
  }
  for (const [group, indices] of groups) {
    const rows = flatten(indices);
    if (signalFilter && !rows.length) continue;
    displayRows.push({ group, count: indices.length });
    if (!collapsedGroups.has(group)) displayRows.push(...rows);
  }
  displayRows.push(...flatten(loose));
  window.waveWorkflow?.groupsChanged();
}
function expandBus(signals = selectedSignals()) {
  let remaining = MAX_SIGNALS - chosen.length;
  const fresh = [];
  const existing = new Set(chosen.map(key));
  for (const s of signals) {
    if (s.width <= 1 || Number.isInteger(s.bitOffset) || s.supported === false)
      continue;
    const range = /\[\s*(-?\d+)\s*:\s*(-?\d+)\s*\]$/.exec(s.name);
    if (
      range &&
      Math.abs(Number(range[1]) - Number(range[2])) + 1 !== s.width
    ) {
      status("暂不支持多维 packed Bus 位展开", "warn");
      return;
    }
    if (s.width > MAX_SIGNALS) {
      status("Bus 位数超过会话上限", "warn");
      return;
    }
    const bits = WaveSignal.bits(s).filter((bit) => !existing.has(key(bit)));
    if (bits.length > remaining) {
      status("展开后超过会话信号上限，请减少所选 Bus", "warn");
      return;
    }
    remaining -= bits.length;
    fresh.push(...bits);
    expandedBuses.add(key(s));
  }
  chosen.push(...fresh);
  request();
}
function collapseBus(signals = selectedSignals()) {
  for (const s of signals) {
    expandedBuses.delete(s.parentBus || key(s));
    if (s.parentBus) {
      const parent = chosen.findIndex((v) => key(v) === s.parentBus);
      if (parent >= 0) {
        active = parent;
        selectedKeys = new Set([key(chosen[parent])]);
      }
    }
  }
  request();
}
function splitBus() {
  const parents = selectedSignals().filter((s) => s.width > 1);
  expandBus(parents);
  const keys = new Set(parents.map(key)),
    children = chosen.filter((s) => keys.has(s.parentBus));
  if (!children.length) return;
  for (const s of children) delete s.parentBus;
  chosen = chosen.filter((s) => !keys.has(key(s)));
  for (const k of keys) expandedBuses.delete(k);
  selectedKeys = new Set(children.map(key));
  active = Math.max(0, chosen.indexOf(children[0]));
  request();
}
function restoreSourceBus() {
  const selected = selectedSignals().filter((s) =>
      Number.isInteger(s.bitOffset),
    ),
    sources = new Map();
  for (const s of selected) sources.set(WaveSignal.baseKey(s), s);
  if (!sources.size) return;
  const parents = [];
  for (const [base, s] of sources) {
    parents.push(
      chosen.find((v) => key(v) === base) || {
        ...s,
        width: s.sourceWidth,
        sourceWidth: undefined,
        bitOffset: undefined,
        parentBus: undefined,
        displayName: undefined,
        displayRadix: undefined,
      },
    );
    expandedBuses.delete(base);
  }
  chosen = chosen.filter((s) => !sources.has(WaveSignal.baseKey(s)));
  chosen.push(...parents);
  active = chosen.length - parents.length;
  selectedKeys = new Set(parents.map(key));
  request();
}
function eventsForSignal(s) {
  const events = data[s.id]?.block.events || [];
  if (!Number.isInteger(s.bitOffset)) return events;
  let last;
  return events.filter((e) => {
    const value = WaveSignal.project(e[1], s);
    if (value === last) return false;
    last = value;
    return true;
  });
}
function assignGroup(name, signals = selectedSignals()) {
  if (name && !groupOrder.includes(name)) groupOrder.push(name);
  const keys = new Set(signals.map(key));
  for (const s of chosen)
    if (keys.has(key(s)) || keys.has(s.parentBus)) s.group = name || undefined;
  activeGroup = name;
  request();
}
function renameGroup(name, next) {
  if (!next || name === next) return;
  if (groupOrder.includes(next)) throw Error("此分组名称已存在");
  for (const s of chosen) if (s.group === name) s.group = next;
  groupOrder = groupOrder.map((g) => (g === name ? next : g));
  if (collapsedGroups.delete(name)) collapsedGroups.add(next);
  activeGroup = next;
  request();
}
function selectedSignals() {
  const items = chosen.filter((s) => selectedKeys.has(key(s)));
  return items.length ? items : chosen[active] ? [chosen[active]] : [];
}
function selectRow(index: number, event: Partial<MouseEvent> = {}) {
  if (event.shiftKey) {
    if (!event.ctrlKey && !event.metaKey) selectedKeys.clear();
    for (
      let i = Math.min(selectionAnchor, index);
      i <= Math.max(selectionAnchor, index);
      i++
    )
      selectedKeys.add(key(chosen[i]));
  } else if (event.ctrlKey || event.metaKey) {
    const k = key(chosen[index]);
    if (selectedKeys.has(k)) selectedKeys.delete(k);
    else selectedKeys.add(k);
    selectionAnchor = index;
  } else {
    selectedKeys = new Set([key(chosen[index])]);
    selectionAnchor = index;
  }
  active = index;
  activeGroup = chosen[index]?.group || "";
  persist();
  render();
}
function visibleRange() {
  const height = Math.max(1, $("tracks").clientHeight - timelineHeight),
    top = $("tracks").scrollTop;
  return [
    Math.max(0, Math.floor(top / rowHeight) - OVERSCAN),
    Math.min(
      displayRows.length,
      Math.ceil((top + height) / rowHeight) + OVERSCAN,
    ),
  ];
}
function refreshNeeded() {
  const [a, b] = visibleRange();
  firstRow = a;
  lastRow = b;
  const idsInRange = (first: number, last: number) =>
    displayRows
      .slice(first, last)
      .flatMap(({ index }) => (index === undefined ? [] : [chosen[index].id]));
  neededIds = [...new Set(idsInRange(a, b))];
  const margin = Math.min(16, Math.ceil(viewportHeight / rowHeight / 2));
  retainedIds = new Set(neededIds);
  prefetchIds = [];
  for (const id of [
    ...idsInRange(b, b + margin),
    ...idsInRange(Math.max(0, a - margin), a),
  ]) {
    if (retainedIds.has(id)) continue;
    retainedIds.add(id);
    prefetchIds.push(id);
  }
  for (const id of Object.keys(data)) if (!retainedIds.has(id)) delete data[id];
  for (const id of Object.keys(cursorValues))
    if (!retainedIds.has(id)) delete cursorValues[id];
  pump();
  pumpCursor();
  pumpUart();
}
const uartReads = new Map<
  string,
  {
    through: number;
    block: Block;
    decoded: WeakMap<DecoderProfile, UartFrame[]>;
  }
>();
let uartFlight: { request: string; id: string; through: number } | undefined;
let uartSequence = 0;
function pumpUart() {
  if (!meta || !showDecodedValues.checked || uartFlight) return;
  const wanted = new Map<string, number>();
  for (const row of displayRows.slice(firstRow, lastRow)) {
    const signal = chosen[row.index];
    if (!signal?.decoder?.uart) continue;
    const ticks = uartBitTicks(signal.decoder.uart, meta.scale);
    if (!Number.isFinite(ticks) || ticks < 2) continue;
    const through = Math.min(
      Number(meta.end),
      Math.ceil(Math.max(end, cursorA) + 13 * ticks),
    );
    wanted.set(signal.id, Math.max(through, wanted.get(signal.id) || 0));
  }
  for (const id of uartReads.keys()) if (!wanted.has(id)) uartReads.delete(id);
  for (const [id, through] of wanted) {
    const read = uartReads.get(id);
    if (read && (read.through >= through || read.block.truncated)) continue;
    uartFlight = { request: "uart:" + ++uartSequence, id, through };
    vscode.postMessage({
      type: "query",
      request: uartFlight.request,
      signals: [id],
      start: Number(meta.start),
      end: through,
      limit: 100000,
    });
    return;
  }
}
function uartFrames(signal: Signal) {
  const profile = signal.decoder;
  const read = uartReads.get(signal.id);
  if (!showDecodedValues.checked || !profile?.uart || !read) return [];
  let frames = read.decoded.get(profile);
  if (!frames) {
    const { block } = read;
    const through = block.truncated
      ? Number(block.events.at(-1)?.[0])
      : read.through;
    frames = decodeUart(
      profile.uart,
      meta.scale,
      block.events,
      through,
      (raw) => WaveSignal.project(raw, signal),
    );
    read.decoded.set(profile, frames);
  }
  return frames;
}
function firstUartFrameEndingAfter(frames: UartFrame[], tick: number) {
  let low = 0,
    high = frames.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (frames[mid].end <= tick) low = mid + 1;
    else high = mid;
  }
  return low;
}
function uartLabelAt(signal: Signal, tick: number) {
  const frames = uartFrames(signal);
  const frame = frames[firstUartFrameEndingAfter(frames, tick)];
  return frame && frame.start <= tick
    ? uartFrameLabel(signal.decoder, frame)
    : undefined;
}
function readEnd(read: WaveRead) {
  return read.block.truncated
    ? Number(read.block.events.at(-1)?.[0] ?? read.start)
    : read.end;
}

function coversTick(read: WaveRead | undefined, tick: number) {
  return read && tick >= read.start && tick <= readEnd(read);
}

function needsData(id: string) {
  const read = data[id];
  return (
    !read ||
    read.start > start ||
    read.end < end ||
    (read.start < start && readEnd(read) < end)
  );
}

// Values at A must remain correct when A lies outside the displayed time window.
function pumpCursor() {
  if (!meta || cursorFlight) return;
  const required = neededIds.filter((id) => {
    return (
      cursorValues[id]?.time !== cursorA &&
      !coversTick(data[id], cursorA) &&
      (cursorA < start || cursorA > end || !needsData(id))
    );
  });
  if (!required.length) return;
  const ids = required.slice(0, 64);
  cursorFlight = { request: "cursor:" + ++cursorSequence, time: cursorA, ids };
  vscode.postMessage({
    type: "query",
    signals: ids,
    start: cursorA,
    end: cursorA,
    request: cursorFlight.request,
  });
}
function cursorValue(id) {
  const read = data[id];
  if (coversTick(read, cursorA)) {
    const events = read.block.events;
    const value = events[valueAt(events, cursorA)]?.[1];
    cursorValues[id] = { time: cursorA, value };
    return value;
  }
  return cursorValues[id]?.time === cursorA ? cursorValues[id].value : null;
}
function activateSignalGroup(signal?: Signal) {
  if (!signal) return;
  activeGroup = signal.group || "";
  if (activeGroup) collapsedGroups.delete(activeGroup);
}
function moveGroup(name: string, target: string, after: boolean) {
  if (!groupOrder.includes(name) || !groupOrder.includes(target))
    throw Error("分组不存在");
  if (name === target) return;
  const order = groupOrder.filter((group) => group !== name);
  order.splice(order.indexOf(target) + Number(after), 0, name);
  groupOrder = order;
  activeGroup = name;
  request();
}
function removeGroup(name: string) {
  for (const signal of chosen)
    if (signal.group === name) signal.group = undefined;
  groupOrder = groupOrder.filter((group) => group !== name);
  collapsedGroups.delete(name);
  if (activeGroup === name) activeGroup = "";
  request();
}
function setTooltip(enabled: boolean) {
  tooltipEnabled = enabled;
  $("toggleTooltip").checked = enabled;
  if (!enabled) clearWaveHover?.();
  persist();
}
function add(signal) {
  if (chosen.some((s) => key(s) === key(signal))) return;
  if (chosen.length >= MAX_SIGNALS) {
    status("已达到 100000 个已添加信号的会话上限", "warn");
    return;
  }
  if (!signal.group && activeGroup) signal.group = activeGroup;
  chosen.push(signal);
  activateSignalGroup(signal);
  active = chosen.length - 1;
  selectedKeys = new Set([key(signal)]);
  request();
}
function request() {
  rebuildRows();
  persist();
  render();
}
function pump() {
  if (!meta) return;
  const missing = neededIds.filter(needsData);
  if (!missing.length) settled();
  if (inflight) return;
  const ids = missing.length
    ? missing.slice(0, 64)
    : prefetchIds.filter(needsData).slice(0, 16);
  if (!ids.length) return;
  // Preload neighboring ticks to cover small pans without a backend round trip.
  // Retry with the exact viewport when a dense signal exhausts the event limit.
  const padding = ids.some((id) => data[id]?.block.truncated)
    ? 0
    : Math.ceil((end - start) / 2);
  inflight = {
    request: ++generation,
    start: Math.max(Number(meta.start), start - padding),
    end: Math.min(
      Math.max(Number(meta.start) + 1, Number(meta.end)),
      end + padding,
    ),
  };
  if (missing.length)
    status(
      `正在读取可见信号… ${chosen.length} 个已添加 / ${neededIds.length} 个视口信号`,
    );
  vscode.postMessage({
    type: "query",
    signals: ids,
    start: inflight.start,
    end: inflight.end,
    request: inflight.request,
  });
}
function settled() {
  const clipped = neededIds.some((id) => data[id] && readEnd(data[id]) < end);
  status(
    clipped
      ? "可见信号事件超限，阴影区域尚未读取；请缩小时间窗口。"
      : `${chosen.length} 个信号 · 视口 ${firstRow + 1}–${lastRow} · ${meta?.scale || ""}/tick`,
    clipped ? "warn" : "",
  );
  for (const p of dataWaiters.splice(0)) p.resolve();
}
function scheduleViewport() {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    render();
  });
}
function ensureActive() {
  if (chosen[active]?.group) collapsedGroups.delete(chosen[active].group);
  if (chosen[active]?.parentBus) expandedBuses.add(chosen[active].parentBus);
  rebuildRows();
  const position = displayRows.findIndex((r) => r.index === active),
    tracks = $("tracks"),
    top = Math.max(0, position) * rowHeight,
    bottom = top + rowHeight;
  // Update the scroll range before jumping into a newly expanded group.
  if (bottom + timelineHeight > tracks.scrollHeight) render();
  if (top < tracks.scrollTop) tracks.scrollTop = top;
  else if (bottom > tracks.scrollTop + tracks.clientHeight - timelineHeight)
    tracks.scrollTop = bottom - (tracks.clientHeight - timelineHeight);
  render();
}
const CATALOG_ROW = 24,
  CATALOG_PAGE = 512,
  MAX_SCROLL_HEIGHT = 8000000;
let catalogFlat = false,
  catalogRows = [],
  catalogExpanded = new Set(),
  catalogInitialized = false;
let catalog = {
  query: "",
  total: 0,
  pages: new Map(),
  revision: 0,
  flight: null,
};
const treeSpace = document.createElement("div"),
  treeViewport = document.createElement("div");
treeSpace.id = "treeSpace";
treeViewport.id = "treeViewport";
$("tree").append(treeSpace, treeViewport);
function renderTree() {
  if (!meta) return;
  const root = { children: new Map(), signals: [], path: "" };
  for (const signal of meta.signals) {
    let node = root;
    for (const part of signal.scope.split(".").filter(Boolean)) {
      if (!node.children.has(part)) {
        const path = node.path ? node.path + "." + part : part;
        node.children.set(part, { children: new Map(), signals: [], path });
        if (!catalogInitialized && path.split(".").length <= 2)
          catalogExpanded.add(path);
      }
      node = node.children.get(part);
    }
    node.signals.push(signal);
  }
  catalogInitialized = true;
  catalogRows = [];
  function flatten(node, depth) {
    for (const [name, child] of node.children) {
      catalogRows.push({ kind: "scope", name, path: child.path, depth });
      if (catalogExpanded.has(child.path)) flatten(child, depth + 1);
    }
    for (const signal of node.signals)
      catalogRows.push({ kind: "signal", signal, depth });
  }
  flatten(root, 0);
  renderCatalog();
}
function catalogRequest(page) {
  if (catalog.flight) return;
  catalog.flight = { revision: catalog.revision, page };
  vscode.postMessage({
    type: "search",
    query: catalog.query,
    request: catalog.revision,
    offset: page * CATALOG_PAGE,
    limit: CATALOG_PAGE,
  });
}
function setCatalog(query, flat = true) {
  catalogFlat = flat;
  catalog.query = query;
  catalog.total = 0;
  catalog.pages.clear();
  catalog.revision = ++searchRequest;
  $("tree").scrollTop = 0;
  renderCatalog();
}
function renderCatalog() {
  if (!meta) return;
  const tree = $("tree"),
    height = Math.max(1, tree.clientHeight),
    total = catalogFlat ? catalog.total : catalogRows.length;
  const logicalHeight = Math.max(height, total * CATALOG_ROW),
    physicalHeight = Math.min(MAX_SCROLL_HEIGHT, logicalHeight);
  treeSpace.style.height = physicalHeight + "px";
  const ratio =
      logicalHeight > height
        ? (logicalHeight - height) / Math.max(1, physicalHeight - height)
        : 1,
    logicalTop = tree.scrollTop * ratio;
  const first = Math.max(0, Math.floor(logicalTop / CATALOG_ROW) - OVERSCAN),
    last = Math.min(
      total,
      Math.ceil((logicalTop + height) / CATALOG_ROW) + OVERSCAN,
    );
  treeViewport.style.top = tree.scrollTop + "px";
  treeViewport.style.height = height + "px";
  treeViewport.replaceChildren();
  let missing = null;
  for (let i = first; i < last; i++) {
    let entry = catalogRows[i];
    if (catalogFlat) {
      const page = Math.floor(i / CATALOG_PAGE),
        signals = catalog.pages.get(page);
      entry = signals?.[i % CATALOG_PAGE]
        ? { kind: "signal", signal: signals[i % CATALOG_PAGE], depth: 0 }
        : null;
      if (!entry && missing === null) missing = page;
    }
    const button = document.createElement("button");
    button.style.top = i * CATALOG_ROW - logicalTop + "px";
    button.style.paddingInlineStart = 8 + (entry?.depth || 0) * 16 + "px";
    if (entry) button.dataset.depth = String(entry.depth);
    if (!entry) {
      button.textContent = "读取信号目录…";
      button.disabled = true;
    } else if (entry.kind === "scope") {
      button.className = "scope";
      button.textContent =
        (catalogExpanded.has(entry.path) ? "▾ " : "▸ ") + entry.name;
      button.title = entry.path;
      button.setAttribute(
        "aria-expanded",
        String(catalogExpanded.has(entry.path)),
      );
      button.onclick = (e) => {
        if (e.offsetX < 8 + entry.depth * 16 + 18) {
          if (catalogExpanded.has(entry.path))
            catalogExpanded.delete(entry.path);
          else catalogExpanded.add(entry.path);
          renderTree();
        } else window.waveWorkflow?.scope(entry.path);
      };
      button.ondblclick = () =>
        vscode.postMessage({
          type: "kdbSource",
          scope: entry.path,
          target: "definition",
        });
    } else {
      const signal = entry.signal;
      button.className = "leaf";
      button.textContent = `+ ${catalogFlat ? signal.scope + "." + signal.name : signal.name}`;
      button.title = `${signal.scope}.${signal.name}`;
      button.disabled = !signal.supported;
      button.draggable = signal.supported;
      button.ondragstart = (e) =>
        e.dataTransfer.setData(
          "application/x-wave-signals",
          JSON.stringify([signal]),
        );
      button.ondblclick = () => add(signal);
      button.onkeydown = (e) => {
        if (e.key === "Enter") add(signal);
      };
    }
    treeViewport.append(button);
  }
  $("count").textContent = catalogFlat
    ? `${total} 个匹配信号 · 按需分页`
    : `层次预览 ${meta.signals.length} / ${meta.total ?? meta.signals.length} · 全部信号可滚动浏览`;
  if (
    catalogFlat &&
    (missing !== null || (total === 0 && catalog.pages.size === 0))
  )
    catalogRequest(missing ?? 0);
}
$("tree").addEventListener(
  "scroll",
  () => requestAnimationFrame(renderCatalog),
  { passive: true },
);
$("tree").addEventListener(
  "wheel",
  (e) => {
    const h = $("tree").clientHeight,
      total = (catalogFlat ? catalog.total : catalogRows.length) * CATALOG_ROW;
    if (total > MAX_SCROLL_HEIGHT) {
      e.preventDefault();
      $("tree").scrollTop += (e.deltaY * (MAX_SCROLL_HEIGHT - h)) / (total - h);
    }
  },
  { passive: false },
);
$("catalogAll").onclick = () => setCatalog($("search").value, true);
$("catalogPreview").onclick = () => {
  $("search").value = "";
  setCatalog("", false);
};
function setWindow(a: number, b: number, defer = false) {
  const low = Number(meta.start),
    high = Math.max(low + 1, Number(meta.end)),
    length = Math.min(high - low, Math.max(1, b - a)),
    nextStart = Math.round(Math.max(low, Math.min(a, high - length))),
    nextEnd = Math.min(high, nextStart + Math.round(length));
  if (nextStart === start && nextEnd === end) return;
  start = nextStart;
  end = nextEnd;
  persist();
  if (defer) scheduleViewport();
  else render();
}
function zoom(factor: number, anchor = 0.5, defer = false) {
  const length = (end - start) * factor,
    point = start + (end - start) * anchor;
  setWindow(point - length * anchor, point + length * (1 - anchor), defer);
}
const timeUnitSelect = $("timeUnitSelect");
const nativeTimeUnit = timeUnitSelect.options[0];
const customTimeUnit = new Option();
timeUnitSelect.onchange = () => {
  const unit = timeUnitSelect.value;
  uiAction("timeUnit", {
    scale: unit || null,
    factor: unit
      ? Number((scaleSeconds(unit) / scaleSeconds(meta.scale)).toPrecision(15))
      : 1,
  });
};
function updateTimeUnit() {
  if (!meta) return;
  timeUnitSelect.disabled = false;
  nativeTimeUnit.textContent = "原始 (" + meta.scale + ")";
  if (timeUnitSelect.value === (displayScale || "")) return;
  customTimeUnit.remove();
  if (
    displayScale &&
    ![...timeUnitSelect.options].some((option) => option.value === displayScale)
  ) {
    customTimeUnit.value = displayScale;
    customTimeUnit.textContent = displayScale;
    timeUnitSelect.append(customTimeUnit);
  }
  timeUnitSelect.value = displayScale || "";
}

const timeScroll = $("timeScroll");
const timeThumb = $("timeThumb");
function timeScrollGeometry() {
  const first = Number(meta.start);
  const total = Math.max(1, Number(meta.end) - first);
  const duration = end - start;
  const ratio = Math.min(1, duration / total);
  const width = timeScroll.clientWidth;
  const thumbWidth = Math.min(width, Math.max(14, width * ratio));
  const maxOffset = Math.max(0, total - duration);
  return {
    first,
    duration,
    ratio,
    thumbWidth,
    travel: width - thumbWidth,
    maxOffset,
  };
}

function updateTimeScroll() {
  const plot = $("plot");
  const bars = $("waveScrollbars");
  bars.style.setProperty("--wave-pan-offset", plot.offsetLeft + "px");
  bars.style.setProperty("--wave-pan-width", plot.clientWidth + "px");
  if (!meta) return;
  const { first, ratio, thumbWidth, travel, maxOffset } = timeScrollGeometry();
  const offset = Math.max(0, Math.min(start - first, maxOffset));
  timeThumb.style.width = thumbWidth + "px";
  timeThumb.style.left = (maxOffset ? (offset / maxOffset) * travel : 0) + "px";
  timeScroll.setAttribute("aria-valuemin", String(first));
  timeScroll.setAttribute("aria-valuemax", String(first + maxOffset));
  timeScroll.setAttribute("aria-valuenow", String(first + offset));
  timeScroll.setAttribute("aria-disabled", String(maxOffset === 0));
  const percentage = (ratio * 100).toLocaleString("zh-CN", {
    maximumSignificantDigits: 3,
  });
  const description = `${timeLabel(start)} → ${timeLabel(end)} · 全波形的 ${percentage}%`;
  timeScroll.setAttribute("aria-valuetext", description);
  timeScroll.title = description;
}

let thumbGrabOffset = 0;
function panByThumb(event: PointerEvent) {
  const { first, duration, travel, maxOffset } = timeScrollGeometry();
  if (travel <= 0 || maxOffset === 0) return;
  const x =
    event.clientX - timeScroll.getBoundingClientRect().left - thumbGrabOffset;
  const fraction = Math.min(1, Math.max(0, x / travel));
  const nextStart = first + Math.round(fraction * maxOffset);
  setWindow(nextStart, nextStart + duration, true);
}

timeScroll.onpointerdown = (event) => {
  if (event.button !== 0 || timeScroll.getAttribute("aria-disabled") === "true")
    return;
  timeScroll.focus({ preventScroll: true });
  const thumb = timeThumb.getBoundingClientRect();
  const grabbedThumb = event.target === timeThumb;
  thumbGrabOffset = grabbedThumb ? event.clientX - thumb.left : thumb.width / 2;
  timeScroll.setPointerCapture(event.pointerId);
  if (!grabbedThumb) panByThumb(event);
};
timeScroll.onpointermove = (event) => {
  if (timeScroll.hasPointerCapture(event.pointerId)) panByThumb(event);
};
timeScroll.onpointerup = timeScroll.onpointermove;
timeScroll.onkeydown = (event) => {
  if (!meta) return;
  const { first, duration, maxOffset } = timeScrollGeometry();
  const step = Math.max(1, Math.round(duration / 10));
  const destinations: Record<string, number> = {
    ArrowLeft: start - step,
    ArrowRight: start + step,
    PageUp: start - duration,
    PageDown: start + duration,
    Home: first,
    End: first + maxOffset,
  };
  if (!Object.hasOwn(destinations, event.key)) return;
  event.preventDefault();
  event.stopPropagation();
  const next = destinations[event.key];
  setWindow(next, next + duration);
};

const signalNames = $("names");
const valueSplit = $("valueSplit");
function updateValueSplit() {
  const width = signalNames.clientWidth;
  const minimum = 56;
  const maximum = Math.max(minimum, width - 76);
  const requested =
    valueFraction === undefined ? 90 : Math.round(width * valueFraction);
  const valueWidth = Math.min(maximum, Math.max(minimum, requested));
  signalNames.style.setProperty("--wave-value-width", valueWidth + "px");
  valueSplit.setAttribute("aria-valuemin", String(minimum));
  valueSplit.setAttribute("aria-valuemax", String(maximum));
  valueSplit.setAttribute("aria-valuenow", String(valueWidth));
  valueSplit.setAttribute("aria-valuetext", "数值列 " + valueWidth + " 像素");
}
function setValueFraction(fraction?: number) {
  valueFraction = normalizeValueFraction(fraction);
  scheduleViewport();
  persist();
}
let valueDragOffset = 0;
valueSplit.onpointerdown = (event) => {
  if (event.button !== 0) return;
  const bar = valueSplit.getBoundingClientRect();
  valueDragOffset = event.clientX - (bar.left + bar.width / 2);
  valueSplit.setPointerCapture(event.pointerId);
  valueSplit.focus({ preventScroll: true });
  event.preventDefault();
};
valueSplit.onpointermove = (event) => {
  if (!valueSplit.hasPointerCapture(event.pointerId)) return;
  const bounds = signalNames.getBoundingClientRect();
  setValueFraction(
    (bounds.left +
      signalNames.clientWidth -
      8 -
      event.clientX +
      valueDragOffset) /
      signalNames.clientWidth,
  );
};
valueSplit.ondblclick = () => setValueFraction();
valueSplit.onkeydown = (event) => {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  event.preventDefault();
  event.stopPropagation();
  const width = Number(valueSplit.getAttribute("aria-valuenow"));
  const step = event.key === "ArrowLeft" ? 12 : -12;
  setValueFraction((width + step) / signalNames.clientWidth);
};
const nameScroll = $("nameScroll");
function applyNameScroll() {
  signalNames.style.setProperty("--name-scroll", -nameScroll.scrollLeft + "px");
}
nameScroll.addEventListener("scroll", applyNameScroll, { passive: true });
nameScroll.addEventListener("keydown", (e) => {
  if (e.key === "ArrowLeft" || e.key === "ArrowRight") e.stopPropagation();
});
signalNames.addEventListener(
  "wheel",
  (e) => {
    if (nameScroll.hidden || e.ctrlKey || e.metaKey) return;
    if (!e.shiftKey && Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
    e.preventDefault();
    const delta = e.deltaX || e.deltaY;
    const unit =
      e.deltaMode === 1
        ? rowHeight
        : e.deltaMode === 2
          ? nameScroll.clientWidth
          : 1;
    nameScroll.scrollLeft += delta * unit;
  },
  { passive: false },
);
function updateNameScroll(rows: HTMLElement) {
  let overflow = 0;
  for (const content of rows.querySelectorAll<HTMLElement>(
    ".signalNameContent",
  )) {
    overflow = Math.max(
      overflow,
      content.scrollWidth - content.parentElement.clientWidth,
    );
  }
  nameScroll.style.width = signalNames.offsetWidth + "px";
  nameScroll.hidden = !overflow;
  (nameScroll.firstElementChild as HTMLElement).style.width =
    signalNames.offsetWidth + overflow + "px";
  applyNameScroll();
}
function render() {
  scheduleDecoder();
  timelineHeight =
    markersVisible && markers.some((m) => m.name !== "B")
      ? 56
      : DEFAULT_ROW_HEIGHT;
  $("names").querySelector<HTMLElement>(".ruler").style.height =
    timelineHeight + "px";
  $("zoomBox")?.style.setProperty("top", timelineHeight + "px");
  viewportHeight = Math.max(1, $("tracks").clientHeight);
  $("trackContent").style.height =
    Math.max(viewportHeight, rowHeight * displayRows.length + timelineHeight) +
    "px";
  $("plot").style.height = viewportHeight + "px";
  $("tracks").dataset.total = String(chosen.length);
  updateValueSplit();
  [firstRow, lastRow] = visibleRange();
  const rows = $("rows");
  rows.style.top = timelineHeight + firstRow * rowHeight + "px";
  rows.replaceChildren();
  for (let position = firstRow; position < lastRow; position++) {
    const item = displayRows[position];
    if (item.index === undefined) {
      const group = document.createElement("button");
      group.className =
        "groupRow" + (activeGroup === item.group ? " currentGroup" : "");
      group.textContent =
        (collapsedGroups.has(item.group) ? "▸ " : "▾ ") +
        item.group +
        " (" +
        item.count +
        ")";
      group.dataset.group = item.group;
      group.setAttribute(
        "aria-expanded",
        String(!collapsedGroups.has(item.group)),
      );
      group.title = "拖动排序 · 点击折叠/展开 · 双击重命名";
      group.draggable = true;
      const groupDragType = "application/x-wave-group";
      const dropAfter = (event: DragEvent) => {
        const bounds = group.getBoundingClientRect();
        return event.clientY >= bounds.top + bounds.height / 2;
      };
      const clearDropStyle = () =>
        group.classList.remove("dropTarget", "dropBefore", "dropAfter");
      group.ondragstart = (event) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData(groupDragType, item.group);
      };
      group.ondragend = () =>
        rows
          .querySelectorAll(".dropBefore,.dropAfter")
          .forEach((row) => row.classList.remove("dropBefore", "dropAfter"));
      group.onclick = () => {
        activeGroup = item.group;
        if (collapsedGroups.has(item.group)) collapsedGroups.delete(item.group);
        else collapsedGroups.add(item.group);
        request();
      };
      group.ondblclick = () => window.waveWorkflow?.editGroup(item.group);
      group.oncontextmenu = (e) => {
        e.preventDefault();
        activeGroup = item.group;
        window.waveWorkflow?.groupMenu(e.clientX, e.clientY, item.group);
      };
      group.ondragover = (e) => {
        const types = e.dataTransfer.types;
        if (
          !types.some((type) =>
            [
              groupDragType,
              "application/x-wave-reorder",
              "application/x-wave-signals",
            ].includes(type),
          )
        )
          return;
        e.preventDefault();
        clearDropStyle();
        if (types.includes(groupDragType)) {
          e.dataTransfer.dropEffect = "move";
          group.classList.add(dropAfter(e) ? "dropAfter" : "dropBefore");
        } else group.classList.add("dropTarget");
      };
      group.ondragleave = clearDropStyle;
      group.ondrop = async (e) => {
        e.preventDefault();
        e.stopPropagation();
        clearDropStyle();
        if (e.dataTransfer.types.includes(groupDragType)) {
          moveGroup(
            e.dataTransfer.getData(groupDragType),
            item.group,
            dropAfter(e),
          );
        } else if (
          e.dataTransfer.types.includes("application/x-wave-reorder")
        ) {
          assignGroup(item.group);
          dragIndex = null;
        } else {
          try {
            const signals = JSON.parse(
              e.dataTransfer.getData("application/x-wave-signals"),
            );
            if (!Array.isArray(signals)) return;
            const keys = new Set(signals.map(key));
            assignGroup(
              item.group,
              chosen.filter((s) => keys.has(key(s))),
            );
            collapsedGroups.delete(item.group);
            await uiAction("addSignals", {
              signals: signals.map((s) => ({ ...s, group: item.group })),
            });
          } catch (err) {
            status(err.message, "error");
          }
        }
      };
      rows.append(group);
      continue;
    }
    const i = item.index,
      s = chosen[i];
    const row = document.createElement("div");
    row.className =
      "row" +
      (selectedKeys.has(key(s)) || (!selectedKeys.size && active === i)
        ? " active"
        : "");
    row.draggable = true;
    row.dataset.index = String(i);
    row.title = `${s.scope}.${s.name}`;
    const grab = document.createElement("span");
    grab.className = "grab";
    grab.textContent = "⠿";
    const name = document.createElement("span");
    name.className = "name";
    const nameContent = document.createElement("span");
    nameContent.className = "signalNameContent";
    nameContent.textContent = WaveSignal.label(s);
    name.append(nameContent);
    if (s.annotation) {
      const tags = s.annotation.tags.map((tag) => "#" + tag).join(" ");
      const inline = showInlineTags.checked && tags;
      if (inline) {
        const label = document.createElement("span");
        label.className = "signalNameText";
        label.textContent = nameContent.textContent;
        const tagText = renderTags(
          s.annotation.tags,
          tagColors,
          tagStyle(waveTagStyle.value),
        );
        nameContent.classList.add("withInlineTags");
        nameContent.replaceChildren(label, tagText);
      }
      row.title += [tags, s.annotation.note]
        .filter(Boolean)
        .map((text) => "\n" + text)
        .join("");
    }
    row.classList.toggle("groupChild", !!s.group);
    row.classList.toggle("busBit", Number.isInteger(s.bitOffset));
    row.style.setProperty(
      "--signal-color",
      s.highlight || colors[i % colors.length],
    );
    const value = document.createElement("span");
    value.className = "value";
    const raw = cursorValue(s.id);
    const rawValue = formatSignal(raw, s);
    const decoded =
      uartLabelAt(s, cursorA) ||
      (showDecodedValues.checked &&
        s.decoder &&
        decodeWord(s.decoder, WaveSignal.project(raw, s), s.width));
    value.textContent = decoded || rawValue;
    if (decoded) value.title = decoded + " · " + rawValue;
    else if (s.decoder?.uart && showDecodedValues.checked) {
      if (uartBitTicks(s.decoder.uart, meta.scale) < 2)
        value.title = "波形时间精度不足以按此波特率解码";
      else if (uartReads.get(s.id)?.block.truncated)
        value.title = "UART 解码所需的历史事件被截断";
    }
    const toggle = document.createElement("button");
    toggle.className = "busToggle";
    toggle.textContent =
      !s.real && s.width > 1 ? (expandedBuses.has(key(s)) ? "▾" : "▸") : "";
    toggle.disabled = !!s.real || s.width <= 1;
    toggle.title = "展开/收回 Bus 位";
    toggle.onclick = (e) => {
      e.stopPropagation();
      if (expandedBuses.has(key(s))) collapseBus([s]);
      else expandBus([s]);
    };
    row.append(toggle);
    const group = document.createElement("span");
    group.className = "group";
    group.textContent = s.group || "";
    const annotation = document.createElement("button");
    annotation.type = "button";
    annotation.className = "signalAnnotation";
    annotation.classList.toggle("hasAnnotation", !!s.annotation);
    annotation.textContent = "✎";
    annotation.title = "编辑 " + WaveSignal.label(s) + " 的标签和注释";
    annotation.setAttribute("aria-label", annotation.title);
    annotation.onclick = (event) => {
      event.stopPropagation();
      window.waveWorkflow?.editAnnotation(s);
    };
    annotation.ondblclick = (event) => event.stopPropagation();
    row.append(grab, group, name, annotation, value);
    row.onclick = (e) => selectRow(i, e);
    row.oncontextmenu = (e) => {
      e.preventDefault();
      if (!selectedKeys.has(key(s))) selectRow(i);
      window.waveWorkflow?.menu(e.clientX, e.clientY);
    };
    row.ondblclick = () => source();
    row.ondragstart = (e) => {
      dragIndex = i;
      if (!selectedKeys.has(key(s))) selectedKeys = new Set([key(s)]);
      e.dataTransfer.setData("application/x-wave-reorder", "1");
    };
    row.ondragover = (e) => e.preventDefault();
    row.ondragend = () => {
      dragIndex = null;
    };
    row.ondrop = (e) => {
      if (!e.dataTransfer.types.includes("application/x-wave-reorder")) return;
      e.preventDefault();
      e.stopPropagation();
      if (dragIndex !== null && !selectedKeys.has(key(s))) {
        const selected = new Set(selectedSignals().map(key)),
          moving = chosen.filter(
            (v) => selected.has(key(v)) || selected.has(v.parentBus),
          ),
          keys = new Set(moving.map(key));
        chosen = chosen.filter((v) => !keys.has(key(v)));
        const target = chosen.indexOf(s);
        for (const v of moving) v.group = s.group;
        chosen.splice(target, 0, ...moving);
        active = target;
        activateSignalGroup(s);
        dragIndex = null;
        request();
      }
    };
    rows.append(row);
  }
  updateNameScroll(rows);
  updateTimeScroll();
  updateTimeUnit();
  const cursorDetails = `A: ${timeLabel(cursorA)}${cursorB == null ? " · Shift+单击设置 B" : `   B: ${timeLabel(cursorB)}   Δ: ${timeLabel(Math.abs(cursorA - cursorB))}`}`;
  $("cursors").textContent =
    (cursorB == null ? "" : `Δ: ${timeLabel(Math.abs(cursorA - cursorB))}`) +
    (cursorA < start || cursorA > end ? " · A 在视窗外" : "");
  $("cursors").classList.toggle("offscreen", cursorA < start || cursorA > end);
  $("cursors").title = cursorDetails;
  if (document.activeElement !== $("cursorAInput"))
    $("cursorAInput").value = String(cursorA / displayFactor);
  if (document.activeElement !== $("cursorBInput"))
    $("cursorBInput").value =
      cursorB == null ? "" : String(cursorB / displayFactor);
  $("range").textContent =
    `${start / displayFactor} → ${end / displayFactor} × ${displayScale || meta?.scale || "tick"}`;
  $("range").title = `${timeLabel(start)} → ${timeLabel(end)}`;
  draw();
  refreshNeeded();
  window.waveHover?.refresh();
}
function draw() {
  const canvas = $("canvas"),
    plot = $("plot"),
    width = Math.max(80, plot.clientWidth),
    height = Math.max(1, viewportHeight);
  const dpr = window.devicePixelRatio || 1;
  const pixelWidth = Math.round(width * dpr),
    pixelHeight = Math.round(height * dpr);
  if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
  if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
  canvas.style.width = width + "px";
  canvas.style.height = height + "px";
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = theme.background;
  ctx.fillRect(0, 0, width, height);
  ctx.font = "11px monospace";
  const x = (t) => ((Number(t) - start) / (end - start)) * width;
  const stepBase =
    10 **
    Math.floor(
      Math.log10(Math.max(1, (end - start) / Math.max(1, width / 110))),
    );
  const desired = (end - start) / Math.max(1, width / 110) / stepBase;
  const step =
    stepBase * (desired > 5 ? 10 : desired > 2 ? 5 : desired > 1 ? 2 : 1);
  ctx.strokeStyle = theme.grid;
  ctx.fillStyle = theme.foreground;
  for (let t = Math.ceil(start / step) * step; t <= end; t += step) {
    const px = x(t);
    ctx.beginPath();
    ctx.moveTo(px, DEFAULT_ROW_HEIGHT);
    ctx.lineTo(px, height);
    ctx.stroke();
    ctx.fillText(
      Number((t / displayFactor).toPrecision(6)).toString(),
      px + 4,
      20,
    );
  }
  ctx.save();
  const verticalScale = rowHeight / DEFAULT_ROW_HEIGHT;
  const waveHalfHeight = 9 * verticalScale;
  const valueFontSize = Math.round(
    Math.max(9, Math.min(18, 11 * verticalScale)),
  );
  ctx.font = valueFontSize + "px monospace";
  ctx.textBaseline = "middle";
  ctx.beginPath();
  ctx.rect(0, timelineHeight, width, Math.max(0, height - timelineHeight));
  ctx.clip();
  const top = $("tracks").scrollTop;
  for (let position = firstRow; position < lastRow; position++) {
    const item = displayRows[position];
    if (item.index === undefined) continue;
    const i = item.index,
      s = chosen[i];
    const y = timelineHeight + rowHeight * position - top,
      middle = y + rowHeight / 2,
      high = middle - waveHalfHeight,
      low = middle + waveHalfHeight,
      events = eventsForSignal(s);
    ctx.strokeStyle = theme.grid;
    ctx.beginPath();
    ctx.moveTo(0, y + rowHeight);
    ctx.lineTo(width, y + rowHeight);
    ctx.stroke();
    const read = data[s.id];
    const traceStart = Math.max(start, read?.start ?? start);
    const traceEnd = Math.min(end, read ? readEnd(read) : start);
    if (s.real && read) {
      ctx.strokeStyle = s.highlight || colors[i % colors.length];
      const range = drawAnalog(ctx, events, traceStart, traceEnd, x, high, low);
      if (range) {
        ctx.fillStyle = theme.foreground;
        ctx.fillText(Number(range.max.toPrecision(4)).toString(), 4, high);
        if (range.min !== range.max)
          ctx.fillText(Number(range.min.toPrecision(4)).toString(), 4, low);
      }
    }
    if (!s.real) {
      let index = Math.max(0, valueAt(events, traceStart)),
        lastPixel = -2;
      for (; index < events.length; index++) {
        const [t, raw] = events[index];
        const v = WaveSignal.project(raw, s);
        if (Number(t) > traceEnd) break;
        const left = x(Math.max(traceStart, Number(t)));
        const right = x(
          Math.min(traceEnd, Number(events[index + 1]?.[0] ?? traceEnd)),
        );
        if (right < left) continue;
        const invalid = /[xz]/i.test(v),
          color = /x/i.test(v)
            ? theme.error
            : /z/i.test(v)
              ? theme.warning
              : s.highlight || colors[i % colors.length];
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        if (right - left < 0.8 && Math.floor(left) === lastPixel) continue;
        lastPixel = Math.floor(left);
        ctx.beginPath();
        if (s.width === 1 && !invalid) {
          const level = v === "1" ? high : low;
          ctx.moveTo(left, high);
          ctx.lineTo(left, low);
          ctx.moveTo(left, level);
          ctx.lineTo(right, level);
        } else {
          const bevel = Math.min(4, (right - left) / 2);
          ctx.moveTo(left, middle);
          ctx.lineTo(left + bevel, high);
          ctx.lineTo(right - bevel, high);
          ctx.lineTo(right, middle);
          ctx.lineTo(right - bevel, low);
          ctx.lineTo(left + bevel, low);
          ctx.closePath();
        }
        ctx.stroke();
        if (s.width > 1 && right - left >= 10) {
          const decoded =
            showDecodedValues.checked &&
            s.decoder &&
            decodeWord(s.decoder, v, s.width);
          const value = decoded || formatSignal(raw, s),
            mode = s.displayRadix || radix;
          const compact = decoded
            ? decoded.split(" ", 1)[0]
            : (mode === "hex" || mode === "bin") &&
                s.notation !== "verilog" &&
                value.startsWith("0") &&
                /^[01]+$/.test(v)
              ? value.replace(/^0+(?=.)/, "")
              : undefined;
          drawBusLabel(
            ctx,
            value,
            left,
            right,
            middle,
            busLabelMode,
            compact,
            !!decoded,
          );
        }
      }
      if (s.decoder?.uart) {
        const frames = uartFrames(s);
        for (
          let index = firstUartFrameEndingAfter(frames, start);
          index < frames.length;
          index++
        ) {
          const frame = frames[index];
          if (frame.start >= end) break;
          const left = Math.max(0, x(frame.start)),
            right = Math.min(width, x(frame.end));
          ctx.fillStyle = frame.errors.length
            ? theme.error
            : s.highlight || colors[i % colors.length];
          drawBusLabel(
            ctx,
            uartFrameLabel(s.decoder, frame),
            left,
            right,
            middle,
            busLabelMode,
            undefined,
            true,
          );
        }
      }
    }
    if (read?.block.truncated && read.start <= start && readEnd(read) < end) {
      const last = readEnd(read);
      ctx.save();
      ctx.globalAlpha = 0.18;
      ctx.fillStyle = theme.warning;
      ctx.fillRect(
        Math.max(0, x(last)),
        y,
        width - Math.max(0, x(last)),
        rowHeight,
      );
      ctx.restore();
    }
  }
  ctx.restore();
  for (const [t, color, label] of [
    [cursorA, theme.cursorA, "A"],
    [cursorB, theme.cursorB, "B"],
  ]) {
    if (t == null || t < start || t > end) continue;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x(t), 0);
    ctx.lineTo(x(t), height);
    ctx.stroke();
    ctx.fillText(label, x(t) + 3, 30);
  }
  if (markersVisible) {
    for (const m of markers) {
      if (m.name === "B" || m.time < start || m.time > end) continue;
      ctx.save();
      ctx.strokeStyle = m.color || colors[0];
      ctx.fillStyle = m.color || colors[0];
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(x(m.time), 28);
      ctx.lineTo(x(m.time), height);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(x(m.time), 28, 2.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }
  window.waveMarkers?.render();
  if (!chosen.length) {
    ctx.fillStyle = theme.foreground;
    ctx.fillText(
      "双击左侧信号添加波形 · 在 RTL 中右键 Add Selected Signal to Wave",
      20,
      65,
    );
  }
}
function source(target = "declaration") {
  const s = chosen[active];
  if (s)
    vscode.postMessage({
      type: "source",
      id: s.id,
      scope: s.scope,
      name: s.name,
      target,
    });
}
function postRtlTrace(
  signal: Signal | undefined,
  mode: "drivers" | "loads" | "context" | "recordedContext" | "execution",
  followContinuations = false,
) {
  if (!signal || signal.definition)
    return status("请选择一条 RTL 波形信号。", "warn");
  vscode.postMessage({
    type: "rtlTrace",
    signal:
      signal.scope +
      "." +
      WaveSignal.label({ ...signal, displayName: undefined }),
    mode,
    tick: String(cursorA),
    ...(followContinuations ? { followContinuations } : {}),
  });
}

function action(name) {
  if (
    [
      "openWaveform",
      "openRecent",
      "selectDecoder",
      "editDecoderConfig",
      "runScript",
      "saveProject",
      "openProject",
      "exportClip",
    ].includes(name)
  ) {
    vscode.postMessage({ type: name });
    return;
  }
  if (name === "console") {
    $("console").open = true;
    $("commandInput").focus();
    return;
  }
  if (!meta) return;
  const len = end - start;
  if (name === "fit")
    setWindow(
      Number(meta.start),
      Math.max(Number(meta.start) + 1, Number(meta.end)),
    );
  else if (name === "in") zoom(0.5);
  else if (name === "out") zoom(2);
  else if (name === "left") setWindow(start - len * 0.3, end - len * 0.3);
  else if (name === "right") setWindow(start + len * 0.3, end + len * 0.3);
  else if (name === "remove") {
    const keys = new Set(selectedSignals().map(key));
    chosen = chosen.filter((s) => !keys.has(key(s)) && !keys.has(s.parentBus));
    selectedKeys.clear();
    active = Math.min(active, Math.max(0, chosen.length - 1));
    request();
  } else if (name === "between") {
    if (cursorB !== null && cursorA !== cursorB)
      setWindow(Math.min(cursorA, cursorB), Math.max(cursorA, cursorB));
  } else if (name === "source") source();
  else if (name === "rtlTraceSchematic")
    vscode.postMessage({ type: "rtlTraceSchematic" });
  else if (
    name === "rtlSchematic" ||
    name === "rtlSchematicLoads" ||
    name === "rtlSchematicModule" ||
    name === "rtlSchematicTop"
  ) {
    const signal = chosen[active];
    if (name === "rtlSchematicTop") {
      vscode.postMessage({ type: "rtlModuleSchematic" });
      return;
    }
    if (!signal || signal.definition)
      return status("请选择一条 RTL 波形信号。", "warn");
    const fullname = [
      signal.scope,
      WaveSignal.label({ ...signal, displayName: undefined }),
    ]
      .filter(Boolean)
      .join(".");
    if (name === "rtlSchematicModule")
      vscode.postMessage({ type: "rtlModuleSchematic", signal: fullname });
    else
      vscode.postMessage({
        type: "rtlSchematic",
        direction: name === "rtlSchematicLoads" ? "loads" : "drivers",
        signal: fullname,
        tick: String(cursorA),
      });
  } else if (
    name === "analogMeasure" ||
    name === "analogThreshold" ||
    name === "analogUnit"
  ) {
    const signal = chosen[active];
    if (!signal?.real) return status("请选择一条实数波形。", "warn");
    if (name === "analogMeasure" && (cursorB === null || cursorA === cursorB))
      return status("请用 A/B 游标选择测量区间。", "warn");
    vscode.postMessage({
      type: "analogOperation",
      id: signal.id,
      scope: signal.scope,
      name: signal.name,
      operation:
        name === "analogMeasure"
          ? "measure"
          : name === "analogUnit"
            ? "unit"
            : "threshold",
      unit: signal.unit,
      start: String(Math.min(cursorA, cursorB ?? cursorA)),
      end: String(Math.max(cursorA, cursorB ?? cursorA)),
    });
  } else if (
    name === "traceDrivers" ||
    name === "traceStaticContinuations" ||
    name === "traceLoads" ||
    name === "traceContext" ||
    name === "traceContinuations" ||
    name === "traceRecordedContext" ||
    name === "traceExecution"
  ) {
    postRtlTrace(
      chosen[active],
      name === "traceLoads"
        ? "loads"
        : name === "traceContext" || name === "traceContinuations"
          ? "context"
          : name === "traceRecordedContext"
            ? "recordedContext"
            : name === "traceExecution"
              ? "execution"
              : "drivers",
      name === "traceContinuations" || name === "traceStaticContinuations",
    );
  } else if (name === "attachKdb") vscode.postMessage({ type: "attachKdb" });
  else if (name === "instance" || name === "definition") source(name);
  else if (name === "expandBus") {
    expandBus();
    return 1;
  }
  if (name === "collapseBus") {
    collapseBus();
    return 1;
  }
  if (name === "next" || name === "prev") {
    const events = chosen[active] ? eventsForSignal(chosen[active]) : [];
    const next =
      name === "next"
        ? events.find((e) => Number(e[0]) > cursorA)
        : events.findLast((e) => Number(e[0]) < cursorA);
    if (next && Number(next[0]) >= start && Number(next[0]) <= end) {
      cursorA = Number(next[0]);
      persist();
      render();
      return cursorA;
    } else {
      status("当前已读取窗口内没有更多边沿；平移窗口或在截断时放大。", "warn");
      return null;
    }
  }
}
document
  .querySelectorAll<HTMLButtonElement>("[data-action]")
  .forEach((b) => (b.onclick = () => action(b.dataset.action)));
$("search").oninput = () => {
  clearTimeout(searchTimer);
  searchTimer = window.setTimeout(
    () => setCatalog($("search").value, true),
    180,
  );
};
$("radix").onchange = (e) => {
  radix = (e.target as HTMLInputElement)
    .value as import("../shared/protocol").Radix;
  for (const s of selectedSignals())
    s.displayRadix = radix as import("../shared/protocol").Radix;
  persist();
  render();
};
const canvas = $("canvas");
canvas.onpointerdown = (e) => {
  canvas.focus();
  canvas.setPointerCapture(e.pointerId);
  const rect = canvas.getBoundingClientRect();
  if (e.button === 1 || e.button === 2) {
    pan = { x: e.clientX, start, end };
    e.preventDefault();
    return;
  }
  const t = Math.round(
    start + ((e.clientX - rect.left) / rect.width) * (end - start),
  );
  if (e.shiftKey) cursorB = t;
  else cursorA = t;
  persist();
  render();
};
canvas.onpointerup = (e) => {
  if (pan) {
    const shift =
      ((pan.x - e.clientX) / canvas.clientWidth) * (pan.end - pan.start);
    setWindow(pan.start + shift, pan.end + shift);
    pan = null;
  }
};
canvas.onpointercancel = () => {
  pan = null;
};
canvas.oncontextmenu = (e) => e.preventDefault();
canvas.addEventListener(
  "wheel",
  (e) => {
    if (!meta) return;
    const factor =
        e.deltaMode === 1 ? rowHeight : e.deltaMode === 2 ? viewportHeight : 1,
      delta = e.deltaY * factor,
      dx = e.deltaX * factor;
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      zoom(
        e.deltaY > 0 ? 1.4 : 1 / 1.4,
        (e.clientX - canvas.getBoundingClientRect().left) / canvas.clientWidth,
        true,
      );
    } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      e.preventDefault();
      const shift =
        ((end - start) * (dx || delta)) / Math.max(1, canvas.clientWidth);
      setWindow(start + shift, end + shift, true);
    }
  },
  { passive: false },
);
document.addEventListener("keydown", (e) => {
  if (
    ["INPUT", "SELECT", "TEXTAREA"].includes(
      (e.target as HTMLElement).tagName,
    ) ||
    e.ctrlKey ||
    e.metaKey ||
    e.altKey
  )
    return;
  const names = {
    f: "fit",
    F: "fit",
    "+": "in",
    "=": "in",
    "-": "out",
    "[": "prev",
    "]": "next",
    ArrowLeft: "left",
    ArrowRight: "right",
    Delete: "remove",
  };
  if (names[e.key]) {
    e.preventDefault();
    action(names[e.key]);
  }
});
let kdbScope = "",
  kdbRows = [];
const kdbSpace = document.createElement("div"),
  kdbViewport = document.createElement("div");
kdbSpace.id = "kdbSpace";
kdbViewport.id = "kdbViewport";
$("kdbTree").append(kdbSpace, kdbViewport);
function renderKdb() {
  const box = $("kdbTree"),
    height = Math.max(28, box.clientHeight);
  kdbSpace.style.height = Math.max(28, kdbRows.length * 28) + "px";
  kdbViewport.style.top = box.scrollTop + "px";
  kdbViewport.style.height = height + "px";
  kdbViewport.replaceChildren();
  for (
    let i = Math.max(0, Math.floor(box.scrollTop / 28) - OVERSCAN);
    i <
    Math.min(
      kdbRows.length,
      Math.ceil((box.scrollTop + height) / 28) + OVERSCAN,
    );
    i++
  ) {
    const item = kdbRows[i],
      button = document.createElement("button");
    button.style.top = i * 28 - box.scrollTop + "px";
    button.textContent = `▸ ${item.fullname.split(".").at(-1)} · ${item.module || item.kind}`;
    button.title = item.fullname;
    button.onclick = () =>
      vscode.postMessage({ type: "kdbChildren", scope: item.fullname });
    kdbViewport.append(button);
  }
  if (!kdbRows.length) kdbViewport.textContent = "当前实例没有子实例";
}
$("kdbTree").addEventListener(
  "scroll",
  () => requestAnimationFrame(renderKdb),
  { passive: true },
);
new ResizeObserver(() => requestAnimationFrame(renderKdb)).observe(
  $("kdbTree"),
);
$("kdbUp").onclick = () => {
  vscode.postMessage({ type: "kdbParent", scope: kdbScope });
};
$("kdbDefinition").onclick = () => {
  if (kdbScope)
    vscode.postMessage({
      type: "kdbSource",
      scope: kdbScope,
      target: "definition",
    });
};
$("tracks").addEventListener(
  "scroll",
  () => {
    persist();
    scheduleViewport();
  },
  { passive: true },
);
new ResizeObserver(scheduleViewport).observe($("tracks"));
function setRowHeight(height: number) {
  const tracks = $("tracks");
  const topRow = tracks.scrollTop / rowHeight;
  rowHeight = normalizeRowHeight(height);
  clearWaveHover?.();
  applyTrackLayout();
  if (meta) {
    render();
    tracks.scrollTop = topRow * rowHeight;
  }
  persist();
}
$("waveRowHeight").oninput = (event) =>
  setRowHeight(Number((event.target as HTMLInputElement).value));
function setBusLabelMode(value: unknown) {
  busLabelMode = value === "full" ? "full" : "auto";
  $("busLabelMode").value = busLabelMode;
}
$("busLabelMode").value = busLabelMode;
$("busLabelMode").onchange = () => updateBusLabels($("busLabelMode").value);
function updateBusLabels(value: unknown) {
  setBusLabelMode(value);
  persist();
  if (meta) draw();
}
const waveSplit = $("waveSplit");
function setNamesFraction(value: number | undefined) {
  namesFraction = normalizeNamesFraction(value);
  clearWaveHover?.();
  applyTrackLayout();
  scheduleViewport();
  persist();
}
waveSplit.onpointerdown = (event) => {
  if (event.button !== 0) return;
  waveSplit.setPointerCapture(event.pointerId);
  event.preventDefault();
};
waveSplit.onpointermove = (event) => {
  if (!waveSplit.hasPointerCapture(event.pointerId)) return;
  const bounds = $("trackContent").getBoundingClientRect();
  setNamesFraction((event.clientX - bounds.left) / bounds.width);
};
waveSplit.ondblclick = () => setNamesFraction(undefined);
waveSplit.onkeydown = (event) => {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  event.preventDefault();
  const ratio = $("names").clientWidth / $("trackContent").clientWidth;
  setNamesFraction(ratio + (event.key === "ArrowRight" ? 0.025 : -0.025));
};
new ResizeObserver(() => renderCatalog()).observe($("tree"));
window.addEventListener("message", async (e) => {
  const msg = e.data;
  if (msg.type === "metadata") {
    uartReads.clear();
    uartFlight = undefined;
    meta = msg;
    data = {};
    cursorValues = {};
    inflight = null;
    cursorFlight = null;
    $("file").textContent = msg.title;
    $("backend").textContent =
      `${msg.backendLabel || msg.backend} · Vide ${msg.vide || "未安装"}`;
    start = Number.isFinite(saved.start) ? saved.start : Number(msg.start);
    end = Number.isFinite(saved.end)
      ? saved.end
      : Math.max(start + 1, Number(msg.end));
    cursorA = saved.cursorA ?? start;
    cursorB = saved.cursorB ?? null;
    radix = saved.radix || "hex";
    $("radix").value = radix;
    markers = saved.markers || [];
    displayScale = saved.displayScale || null;
    displayFactor = saved.displayFactor || 1;
    chosen = [];
    if (saved.chosen?.length)
      vscode.postMessage({
        type: "restore",
        signals: saved.chosen.slice(0, MAX_SIGNALS),
        virtualDefinitions,
      });
    else publishProjectState(true);
    renderTree();
    request();
  } else if (msg.type === "backendChanged") {
    uartReads.clear();
    uartFlight = undefined;
    meta = msg;
    $("backend").textContent =
      `${msg.backendLabel || msg.backend} · Vide ${msg.vide || "未安装"}`;
    data = {};
    inflight = cursorFlight = null;
    cursorValues = {};
    catalog.pages.clear();
    catalog.flight = null;
    catalog.revision = ++searchRequest;
    catalog.total = catalog.query ? 0 : meta.total;
    renderTree();
    await uiAction("restoreView", msg.view);
  } else if (msg.type === "ui") {
    try {
      const result = await uiAction(msg.action, msg.payload || {});
      vscode.postMessage({ type: "uiResult", id: msg.id, result });
    } catch (e) {
      vscode.postMessage({ type: "uiResult", id: msg.id, error: e.message });
    }
  } else if (msg.type === "sidebarVisibility") {
    document.body.classList.toggle("sidebar-connected", msg.visible);
    if (msg.visible && !document.body.dataset.sidebarLayout) {
      $("catalogPanel").open = false;
      document.body.dataset.sidebarLayout = "1";
    }
  } else if (msg.type === "analogUnit") {
    const signal = chosen.find(
      (signal) => signal.real && key(signal) === key(msg.signal),
    );
    if (signal) {
      signal.unit = msg.unit || undefined;
      request();
    }
  } else if (msg.type === "virtualCreated") {
    virtualDefinitions = msg.definitions;
    add(msg.signal);
  } else if (msg.type === "sidebarAdd") {
    await uiAction("addSignals", { signals: msg.signals });
    if (msg.editAnnotation && msg.signals.length) {
      await uiAction("selectSignals", {
        signals: msg.signals.slice(0, 1),
        reveal: true,
      });
      window.waveWorkflow?.editAnnotation();
    }
  } else if (msg.type === "waveDecoderResult") {
    const lane = decoderLanes.get(msg.instanceId);
    if (lane && msg.request === lane.request) {
      if (msg.error) lane.status.textContent = msg.error;
      else showDecoderResult(lane, msg.decoded);
    }
  } else if (msg.type === "scopeSelected") {
    window.waveWorkflow?.scope(msg.scope);
  } else if (msg.type === "commandLog") {
    appendLog(msg.text);
  } else if (msg.type === "kdbAttached") {
    $("kdbState").textContent = `已接入 · ${msg.path}`;
  } else if (msg.type === "kdbDetached") {
    $("kdbState").textContent = "未接入设计数据库";
    kdbScope = "";
    kdbRows = [];
    renderKdb();
  } else if (msg.type === "kdbHierarchy") {
    kdbScope = msg.scope;
    kdbRows = msg.children;
    $("kdbTree").scrollTop = 0;
    $("kdbState").textContent = kdbScope || "顶层实例";
    renderKdb();
  } else if (msg.type === "searchResult") {
    if (
      catalog.flight?.revision === msg.request &&
      catalog.flight.page * CATALOG_PAGE === (msg.offset || 0)
    )
      catalog.flight = null;
    if (msg.request === catalog.revision) {
      catalog.total = msg.total;
      catalog.pages.set(
        Math.floor((msg.offset || 0) / CATALOG_PAGE),
        msg.signals,
      );
      while (catalog.pages.size > 8)
        catalog.pages.delete(catalog.pages.keys().next().value);
    }
    renderCatalog();
  } else if (msg.type === "restore") {
    chosen = msg.signals.filter((s) => s.supported);
    publishProjectState(true);
    window.waveWorkflow?.scope(saved.scope || chosen[active]?.scope || "");
    request();
    $("tracks").scrollTop = saved.scrollTop || 0;
    scheduleViewport();
  } else if (msg.type === "projectSaved") {
    if (signatureOf(snapshot()) === signatureOf(msg.view)) {
      publishProjectState(true);
    } else {
      projectSignature = signatureOf(msg.view);
      projectTimer ??= window.setTimeout(publishProjectState, 100);
    }
  } else if (msg.type === "data") {
    if (uartFlight && msg.request === uartFlight.request) {
      const { id, through } = uartFlight;
      uartFlight = undefined;
      const block = msg.result[id] as Block;
      if (block) uartReads.set(id, { through, block, decoded: new WeakMap() });
      render();
      return;
    }
    if (cursorFlight && msg.request === cursorFlight.request) {
      const flight = cursorFlight;
      cursorFlight = null;
      if (flight.time === cursorA) {
        for (const [id, block] of Object.entries(msg.result as QueryResult))
          if (retainedIds.has(id))
            cursorValues[id] = {
              time: cursorA,
              value: block.events[valueAt(block.events, cursorA)]?.[1],
            };
      }
      render();
      return;
    }
    if (!inflight || msg.request !== inflight.request) return;
    const range = inflight;
    if (range.start <= end && range.end >= start) {
      for (const [id, block] of Object.entries(msg.result as QueryResult)) {
        if (!retainedIds.has(id) || !needsData(id)) continue;
        data[id] = { start: range.start, end: range.end, block };
      }
    }
    inflight = null;
    scheduleViewport();
  } else if (msg.type === "error") {
    if (uartFlight && msg.request === uartFlight.request) {
      const { id, through } = uartFlight;
      uartFlight = undefined;
      uartReads.set(id, {
        through,
        block: { events: [], truncated: true },
        decoded: new WeakMap(),
      });
    }
    if (String(msg.request).startsWith("hover:")) return;
    status(msg.message, "error");
    if (!msg.origin || msg.origin === "query" || msg.origin === "ready") {
      inflight = null;
      cursorFlight = null;
      for (const p of dataWaiters.splice(0)) p.reject(new Error(msg.message));
    }
  } else if (msg.type === "add") {
    window.waveWorkflow?.scope(msg.signal.scope);
    add(msg.signal);
  }
});
const dataWaiters = [];
function waitData() {
  return neededIds.some(needsData)
    ? new Promise((resolve, reject) => dataWaiters.push({ resolve, reject }))
    : Promise.resolve();
}
function appendLog(text) {
  const log = $("commandLog");
  log.textContent = (log.textContent + "\n" + text).slice(-20000);
  log.scrollTop = log.scrollHeight;
}
function snapshot(): WaveState & { chosen: Signal[] } {
  return {
    virtualDefinitions,
    signalFilter,
    expandedBuses: [...expandedBuses],
    groupOrder,
    collapsedGroups: [...collapsedGroups],
    activeGroup,
    chosen,
    radix,
    start,
    end,
    cursorA,
    cursorB,
    markers,
    markersVisible,
    tooltipEnabled,
    showInlineTags: showInlineTags.checked,
    tagStyle: tagStyle(waveTagStyle.value),
    tagColors,
    showDecodedValues: showDecodedValues.checked,
    ...(decoderInstances.length ? { decoderInstances } : {}),
    busLabelMode,
    rowHeight,
    namesFraction,
    valueFraction,
    scrollTop: $("tracks").scrollTop,
    displayScale,
    displayFactor,
  };
}
async function uiAction(name, p) {
  if (name === "snapshot") return snapshot();
  if (name === "decoderAttach") {
    if (decoderInstances.length >= 4) throw Error("最多同时显示四条解码行。");
    const instances = [...decoderInstances, p];
    if (!validDecoderInstances(instances)) throw Error("无效的解码实例。");
    decoderInstances = instances;
    scheduleDecoder(p.instanceId);
    publishProjectState();
    return { instance: p };
  }
  if (name === "decoderDetach") {
    const id = p?.instanceId ?? decoderInstances.at(-1)?.instanceId;
    if (id) detachDecoder(id);
    return { detached: !!id };
  }
  if (name === "decoderReload") {
    const id = p?.instanceId ?? decoderInstances.at(-1)?.instanceId;
    if (id) scheduleDecoder(id);
    return { reloaded: !!id };
  }
  if (name === "decoderStatus")
    return {
      instances: decoderInstances.map((instance) => ({
        instance,
        status:
          decoderLanes.get(instance.instanceId!)?.status.textContent ?? "",
      })),
    };
  if (name === "decoderRefresh") {
    for (const { instanceId } of decoderInstances) scheduleDecoder(instanceId);
    return;
  }
  if (name === "tagAppearance") {
    if (p.style !== undefined) waveTagStyle.value = tagStyle(p.style);
    if (
      typeof p.tag === "string" &&
      isTagColor(p.color) &&
      chosen.some((signal) => signal.annotation?.tags.includes(p.tag))
    ) {
      tagColors = { ...tagColors, [p.tag]: p.color };
    }
    persist();
    if (meta) render();
    return 1;
  }
  if (name === "activeSignal") return chosen[active] || null;
  if (name === "setDecoder" || name === "annotateSignal") {
    const signal = chosen.find((s) => key(s) === key(p.signal));
    if (!signal) throw Error("信号还未添加到当前波形");
    if (name === "setDecoder") {
      const profile = p.profile && validateProfile(p.profile);
      if (profile && (signal.real || !supportsProfile(profile, signal.width)))
        throw Error("解码配置与信号位宽不符");
      signal.decoder = profile;
    } else {
      signal.annotation = normalizeAnnotation(p.tags, p.note);
    }
    request();
    return 1;
  }
  if (name === "clipContext") {
    const explicit = chosen.filter((signal) => selectedKeys.has(key(signal)));
    const displayed = displayRows
      .filter((row) => row.index !== undefined)
      .map((row) => chosen[row.index]);
    const selected = explicit.length ? explicit : displayed;
    return { start, end, cursorA, cursorB, selected, displayed, markers };
  }
  if (name === "renderClipImage")
    return renderClipImage(p, busLabelMode, showDecodedValues.checked);
  if (name === "restoreView") {
    if (p.projectBaseline) projectSignature = undefined;
    for (const [id, lane] of decoderLanes) {
      cancelDecoder(id);
      lane.lane.remove();
    }
    decoderLanes.clear();
    decoderInstances = validDecoderInstances(p.decoderInstances)
      ? p.decoderInstances
      : [];
    virtualDefinitions = p.virtualDefinitions || [];
    chosen = p.chosen;
    data = {};
    cursorValues = {};
    inflight = null;
    cursorFlight = null;
    expandedBuses = new Set(p.expandedBuses || []);
    groupOrder = p.groupOrder || [];
    collapsedGroups = new Set(p.collapsedGroups || []);
    activeGroup = p.activeGroup || "";
    signalFilter = p.signalFilter || "";
    cursorA = p.cursorA;
    cursorB = p.cursorB ?? null;
    radix = p.radix || "hex";
    displayScale = p.displayScale || null;
    displayFactor = p.displayFactor || 1;
    markers = p.markers || [];
    markersVisible = p.markersVisible !== false;
    applyValueDisplay(p);
    setTooltip(p.tooltipEnabled !== false);
    setBusLabelMode(p.busLabelMode);
    rowHeight = normalizeRowHeight(p.rowHeight);
    namesFraction = normalizeNamesFraction(p.namesFraction);
    valueFraction = normalizeValueFraction(p.valueFraction);
    applyTrackLayout();
    active = 0;
    selectedKeys.clear();
    rebuildRows();
    setWindow(p.start, p.end);
    $("tracks").scrollTop = p.scrollTop || 0;
    render();
    if (p.projectBaseline) publishProjectState(true);
    return 1;
  }

  if (name === "batchAdd") {
    const existing = new Set(chosen.map(key)),
      fresh = p.signals.filter((s) => !existing.has(key(s)));
    if (chosen.length + fresh.length > MAX_SIGNALS)
      throw Error("批量添加超过 100000 个信号的会话上限");
    const added = fresh.length;
    await uiAction("addSignals", { signals: p.signals });
    if (added) ensureActive();
    return { added, duplicates: p.signals.length - added };
  }
  if (name === "addSignals") {
    if (p.clear) {
      expandedBuses.clear();
      groupOrder = [];
      activeGroup = "";
      collapsedGroups.clear();
    }
    const next = p.clear ? [] : [...chosen],
      keys = new Set(next.map(key));
    let lastAdded: Signal;
    const targetGroup = activeGroup;
    for (const signal of p.signals) {
      if (!keys.has(key(signal))) {
        const entry = {
          ...signal,
          group: signal.group ?? (targetGroup || undefined),
        };
        next.push(entry);
        keys.add(key(entry));
        lastAdded = entry;
      }
    }
    if (next.length > MAX_SIGNALS)
      throw new Error("已达到 100000 个已添加信号的会话上限");
    chosen = next;
    if (lastAdded || p.clear) {
      active = Math.max(0, chosen.length - 1);
      selectedKeys = new Set(chosen[active] ? [key(chosen[active])] : []);
      activateSignalGroup(lastAdded);
    }
    request();
    return 1;
  }
  if (name === "clear") {
    expandedBuses.clear();
    groupOrder = [];
    activeGroup = "";
    collapsedGroups.clear();
    chosen = [];
    selectedKeys.clear();
    markers = [];
    cursorB = null;
    active = 0;
    request();
    return 1;
  }
  if (name === "deleteSignals") {
    const old = chosen.length,
      keys = new Set(p.signals.map(key));
    chosen = chosen.filter((s) => !keys.has(key(s)) && !keys.has(s.parentBus));
    selectedKeys = new Set(
      chosen.filter((s) => selectedKeys.has(key(s))).map(key),
    );
    active = Math.min(active, Math.max(0, chosen.length - 1));
    request();
    return old - chosen.length;
  }
  if (name === "selectSignals") {
    const keys = new Set(p.signals.map(key)),
      indices = chosen
        .map((s, i) => (keys.has(key(s)) ? i : -1))
        .filter((i) => i >= 0);
    if (indices.length !== keys.size)
      throw new Error("Signal is not displayed");
    active = indices[0] ?? 0;
    selectedKeys = keys as Set<string>;
    activateSignalGroup(chosen[active]);
    if (p.reveal && signalFilter) {
      rebuildRows();
      if (!displayRows.some((row) => row.index === active)) {
        signalFilter = "";
        $("filterSignals").value = "";
      }
    }
    ensureActive();
    persist();
    return keys.size;
  }
  if (name === "groups") {
    if (p.operation === "list")
      return {
        activeGroup,
        order: [...groupOrder],
        collapsed: [...collapsedGroups],
      };
    if (p.operation === "target" || p.operation === "create") {
      if (p.operation === "create" && !p.group) throw Error("分组名称为空");
      if (p.operation === "create" && !groupOrder.includes(p.group))
        groupOrder.push(p.group);
      if (p.group && !groupOrder.includes(p.group)) throw Error("分组不存在");
      activeGroup = p.group;
      request();
    } else {
      if (p.operation !== "assign" && !groupOrder.includes(p.group))
        throw Error("分组不存在");
      if (p.operation === "assign") {
        if (
          p.signals.some(
            (signal) => !chosen.some((row) => key(row) === key(signal)),
          )
        )
          throw Error("信号尚未添加到波形");
        assignGroup(p.group, p.signals);
      } else if (p.operation === "move") moveGroup(p.group, p.target, p.after);
      else if (p.operation === "rename") renameGroup(p.group, p.target);
      else if (p.operation === "remove") removeGroup(p.group);
      else if (p.operation === "collapse" || p.operation === "expand") {
        if (p.operation === "collapse") collapsedGroups.add(p.group);
        else collapsedGroups.delete(p.group);
        request();
      } else throw Error("未知分组操作");
    }
    return 1;
  }
  if (name === "trackLayout") {
    if (p.rowHeight !== undefined) setRowHeight(p.rowHeight);
    if (p.namesFraction !== undefined) setNamesFraction(p.namesFraction);
    return { rowHeight, namesFraction };
  }
  if (name === "tooltip") {
    if (p.enabled !== undefined) setTooltip(p.enabled);
    return Number(tooltipEnabled);
  }
  if (name === "busLabelMode") {
    if (p.mode !== undefined) updateBusLabels(p.mode);
    return busLabelMode;
  }
  if (name === "cursor") {
    cursorA = p.time;
    if (p.reveal && (cursorA < start || cursorA > end)) {
      const width = Math.max(1, end - start);
      setWindow(cursorA - width / 2, cursorA + width / 2);
    }
    persist();
    render();
    return 1;
  }
  if (name === "marker") {
    if (
      !Number.isSafeInteger(p.time) ||
      p.time < Number(meta.start) ||
      p.time > Number(meta.end)
    )
      throw Error("标记时间超出波形范围");
    const name = String(p.name || "B").trim();
    if (!name || name.length > 120) throw Error("标记名称应为 1–120 个字符");
    let item = markers.find((m) => m.name === (p.oldName || name));
    if (
      p.oldName &&
      p.oldName !== name &&
      markers.some((m) => m !== item && m.name === name)
    )
      throw Error("标记名称已存在");
    if (!item) {
      if (markers.length >= 2000) throw Error("最多支持 2000 个时间标记");
      item = { name, time: p.time };
      markers.push(item);
    }
    item.name = name;
    item.time = p.time;
    if (/^#[0-9a-f]{6}$/i.test(p.color || "")) item.color = p.color;
    if (!p.independent || name === "B") cursorB = p.time;
    if (!p.keepView && (p.time < start || p.time > end)) {
      const half = (end - start) / 2;
      setWindow(p.time - half, p.time + half);
    } else {
      persist();
      render();
    }
    return 1;
  }
  if (name === "deleteMarker") {
    markers = markers.filter((m) => m.name !== p.name);
    persist();
    render();
    return 1;
  }
  if (name === "window") {
    setWindow(p.start, p.end);
    return 1;
  }
  if (name === "between") {
    if (cursorB == null || cursorA === cursorB)
      throw new Error("Set distinct cursor and marker first");
    setWindow(Math.min(cursorA, cursorB), Math.max(cursorA, cursorB));
    return 1;
  }
  if (name === "timeUnit") {
    displayScale = p.scale;
    displayFactor = p.factor;
    persist();
    render();
    return 1;
  }
  if (name === "radix") {
    const targets = p.signals
      ? chosen.filter((s) => p.signals.some((x) => key(x) === key(s)))
      : selectedSignals();
    if (!targets.length) throw new Error("Select or add a signal first");
    for (const s of targets) s.displayRadix = p.radix;
    persist();
    render();
    return 1;
  }
  if (name === "expandBus") {
    expandBus();
    return 1;
  }
  if (name === "collapseBus") {
    collapseBus();
    return 1;
  }
  if (name === "next" || name === "prev") {
    ensureActive();
    await waitData();
    return action(name);
  }
  action(name);
  return 1;
}
$("commandForm").onsubmit = (e) => {
  e.preventDefault();
  const script = $("commandInput").value.trim();
  if (script) {
    appendLog("> " + script);
    vscode.postMessage({ type: "executeTcl", script });
  }
};
$("commandInput").onkeydown = (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    $("commandForm").requestSubmit();
  }
};
const themeObserver = new MutationObserver(() => {
  readTheme();
  scheduleViewport();
});
themeObserver.observe(document.head, {
  childList: true,
  subtree: true,
  characterData: true,
});
for (const node of [document.documentElement, document.body])
  themeObserver.observe(node, {
    attributes: true,
    attributeFilter: [
      "class",
      "style",
      "data-vscode-theme-id",
      "data-vscode-theme-kind",
    ],
  });
window.addEventListener("wave-rebuild", () => request());
vscode.postMessage({ type: "ready" });

/* global meta, $, vscode, chosen, key, rowHeight, active, start, end, cursorA, cursorB, displayFactor, selectedKeys, collapsedGroups, selectedSignals, uiAction, action, source, persist, render, setWindow, add */
(() => {
  const toolMenus = [
    ...document.querySelectorAll<HTMLDetailsElement>(".toolMenu"),
  ];
  function closeMenus() {
    for (const item of toolMenus) item.open = false;
  }
  function positionMenu(item: HTMLDetailsElement) {
    const box = item.querySelector("summary").getBoundingClientRect(),
      panel = item.querySelector<HTMLElement>(".menuPanel");
    panel.style.left =
      Math.max(4, Math.min(box.left, innerWidth - panel.offsetWidth - 4)) +
      "px";
    panel.style.top = box.bottom + 3 + "px";
  }
  for (const item of toolMenus) {
    item.addEventListener("toggle", () => {
      if (item.open) {
        for (const other of toolMenus) if (other !== item) other.open = false;
        positionMenu(item);
      }
    });
    item.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest("button")) item.open = false;
    });
  }
  function closeEditor() {
    for (const form of $("editPopover").querySelectorAll("form"))
      form.hidden = true;
    $("editPopover").hidden = true;
  }
  function openEditor(form) {
    closeMenus();
    closeEditor();
    $("editPopover").hidden = false;
    form.hidden = false;
  }
  document.addEventListener("pointerdown", (e) => {
    if (!(e.target as HTMLElement).closest(".toolMenu")) closeMenus();
    if (!$("editPopover").contains(e.target as Node)) closeEditor();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeMenus();
      closeEditor();
    }
  });
  window.addEventListener("resize", closeMenus);
  $("compactToolbar").addEventListener("scroll", closeMenus, { passive: true });
  const pane = $("scopeSignals"),
    space = document.createElement("div"),
    viewport = document.createElement("div"),
    bar = document.createElement("div");
  bar.className = "scopeActions";
  const addButton = document.createElement("button");
  addButton.textContent = "添加选中 → 波形";
  const sourceButton = document.createElement("button");
  sourceButton.textContent = "打开声明";
  const driversButton = document.createElement("button");
  driversButton.textContent = "追踪驱动";
  driversButton.disabled = true;
  const loadsButton = document.createElement("button");
  loadsButton.textContent = "追踪负载";
  loadsButton.disabled = true;
  bar.append(addButton, sourceButton, driversButton, loadsButton);
  pane.before(bar);
  space.className = "scopeSpace";
  viewport.className = "scopeViewport";
  pane.append(space, viewport);
  let scope = "",
    revision = 0,
    total = 0,
    pages = new Map(),
    flight = null,
    selection = new Map(),
    anchor = 0;
  function pageRequest(page) {
    if (flight) return;
    flight = { page, revision };
    vscode.postMessage({
      type: "scopeSignals",
      scope,
      request: revision,
      offset: page * 512,
    });
  }
  function scopeRows() {
    driversButton.disabled = loadsButton.disabled = selection.size !== 1;
    const height = Math.max(24, pane.clientHeight),
      top = pane.scrollTop;
    space.style.height = Math.max(24, total * 24) + "px";
    viewport.style.top = top + "px";
    viewport.style.height = height + "px";
    viewport.replaceChildren();
    let missing = null;
    for (
      let i = Math.max(0, Math.floor(top / 24) - 4);
      i < Math.min(total, Math.ceil((top + height) / 24) + 4);
      i++
    ) {
      const page = Math.floor(i / 512),
        s = pages.get(page)?.[i % 512],
        b = document.createElement("button");
      b.style.top = i * 24 - top + "px";
      b.className =
        "scopeSignal" + (s && selection.has(key(s)) ? " selected" : "");
      b.textContent = s ? `${s.name} · ${s.width} bit` : "读取信号…";
      b.disabled = !s || !s.supported;
      if (!s) {
        missing ??= page;
      } else {
        b.title = `${s.scope}.${s.name}`;
        b.onclick = (e) => {
          if (e.shiftKey) {
            if (!e.ctrlKey && !e.metaKey) selection.clear();
            for (let j = Math.min(anchor, i); j <= Math.max(anchor, i); j++) {
              const v = pages.get(Math.floor(j / 512))?.[j % 512];
              if (v) selection.set(key(v), v);
            }
          } else if (e.ctrlKey || e.metaKey) {
            if (selection.has(key(s))) selection.delete(key(s));
            else selection.set(key(s), s);
            anchor = i;
          } else {
            selection = new Map([[key(s), s]]);
            anchor = i;
          }
          scopeRows();
        };
        b.ondblclick = () => add(s);
        b.draggable = true;
        b.ondragstart = (e) => {
          if (!selection.has(key(s))) selection = new Map([[key(s), s]]);
          e.dataTransfer.setData(
            "application/x-wave-signals",
            JSON.stringify([...selection.values()]),
          );
        };
      }
      viewport.append(b);
    }
    if (missing !== null) pageRequest(missing);
    if (!total && !flight)
      viewport.textContent = scope
        ? "此实例没有已 dump 的直属信号"
        : "选择实例查看直属信号";
  }
  function selectScope(value) {
    if (scope === value && pages.size) return;
    scope = value;
    revision++;
    total = 0;
    pages.clear();
    selection.clear();
    pane.scrollTop = 0;
    $("scopeTitle").textContent = "Signals · " + value;
    $("scopeTitle").title = value;
    pageRequest(0);
    scopeRows();
    persist();
  }
  addButton.onclick = () =>
    uiAction("addSignals", { signals: [...selection.values()] }).catch(
      (e) => ($("status").textContent = e.message),
    );
  sourceButton.onclick = () => {
    const s = selection.values().next().value;
    if (s)
      vscode.postMessage({
        type: "source",
        id: s.id,
        scope: s.scope,
        name: s.name,
        target: "declaration",
      });
  };
  driversButton.onclick = () =>
    postRtlTrace(selection.values().next().value, "drivers");
  loadsButton.onclick = () =>
    postRtlTrace(selection.values().next().value, "loads");
  pane.addEventListener("scroll", () => requestAnimationFrame(scopeRows), {
    passive: true,
  });
  new ResizeObserver(() => requestAnimationFrame(scopeRows)).observe(pane);
  window.addEventListener("message", (e) => {
    const m = e.data;
    if (m.type === "backendChanged") {
      flight = null;
      pages.clear();
      if (scope) selectScope(scope);
      return;
    }
    if (m.type !== "scopeSignals") return;
    if (flight?.revision === m.request) flight = null;
    if (m.request === revision && m.scope === scope) {
      total = m.total;
      pages.set(Math.floor(m.offset / 512), m.signals);
      while (pages.size > 8) pages.delete(pages.keys().next().value);
    }
    scopeRows();
    if (!flight && !pages.size && scope) pageRequest(0);
  });
  const menu = $("contextMenu");
  function showMenu(x, y) {
    menu.replaceChildren();
    for (const [label, run] of [
      ["在 A 处添加时间标记…", () => editMarker()],
      ["管理时间标记…", () => manageMarkers()],
      ["拼接 / 逻辑虚拟信号…", () => editVirtual()],
      [
        "查找信号 Ctrl+F",
        () => {
          $("findSignal").focus();
        },
      ],
      ["显示过滤 Ctrl+Shift+F", () => toggleFilter()],
      ["拆分为独立位", () => splitBus()],
      ["同源位还原总线", () => restoreSourceBus()],
      ["展开 Bus 位", () => expandBus()],
      ["收回 Bus 位", () => collapseBus()],
      [
        "设置 A 游标",
        () => {
          $("cursorAInput").focus();
        },
      ],
      [
        "定位到 A 游标",
        () => {
          const half = (end - start) / 2;
          setWindow(cursorA - half, cursorA + half);
        },
      ],
      ["上一边沿", () => action("prev")],
      ["下一边沿", () => action("next")],
      [
        "折叠到所属组",
        () => {
          const s = chosen[active];
          if (s?.parentBus) collapseBus([s]);
          else if (s?.group) {
            collapsedGroups.add(s.group);
            requestRows();
          }
        },
      ],
      ["重命名显示名称", () => editAlias()],
      ["选择解码配置…", () => action("selectDecoder")],
      ["标签和注释…", () => editAnnotation()],
      ["上移", () => move(-1)],
      ["下移", () => move(1)],
      ["复制完整路径", () => copyPaths()],
      ["复制信号 Ctrl+C", () => copySignals()],
      [
        "剪切信号 Ctrl+X",
        () => {
          copySignals();
          action("remove");
        },
      ],
      ["粘贴信号 Ctrl+V", () => pasteSignals()],
      ["高亮颜色…", () => highlight()],
      [
        "取消高亮",
        () => {
          for (const s of selectedSignals()) delete s.highlight;
          requestRows();
        },
      ],
      ["Verilog 数值表示", () => notation("verilog")],
      ["普通数值表示", () => notation("plain")],
      [
        "信号事件报告…",
        () => eventReport().catch((e) => status(e.message, "error")),
      ],
      ["添加到分组…", () => editGroup()],
      ["删除所选信号", () => action("remove")],
      ["信号声明", () => source()],
      ["实例位置", () => source("instance")],
      ["模块定义", () => source("definition")],
      ...[
        ["Hex", "hex"],
        ["Binary", "bin"],
        ["Octal", "oct"],
        ["Unsigned", "unsigned"],
        ["Signed", "signed"],
      ].map(
        ([label, radix]) =>
          [label, () => uiAction("radix", { radix })] as const,
      ),
      [
        "展开全部分组",
        () => {
          collapsedGroups.clear();
          requestRows();
        },
      ],
      [
        "折叠全部分组",
        () => {
          for (const name of groupOrder) collapsedGroups.add(name);
          requestRows();
        },
      ],
    ] as const) {
      const b = document.createElement("button");
      b.textContent = label;
      b.setAttribute("role", "menuitem");
      b.onclick = () => {
        menu.hidden = true;
        run();
      };
      menu.append(b);
    }
    menu.hidden = false;
    menu.style.left = Math.min(x, window.innerWidth - 220) + "px";
    menu.style.top =
      Math.max(0, Math.min(y, window.innerHeight - menu.offsetHeight)) + "px";
  }
  let renaming = null;
  function groupsChanged() {
    const select = $("groupTarget");
    const old = [...select.options].map((o) => o.value);
    if (old.join("\0") !== ["", ...groupOrder].join("\0")) {
      select.replaceChildren();
      for (const name of ["", ...groupOrder]) {
        const o = document.createElement("option");
        o.value = name;
        o.textContent = name || "未分组";
        select.append(o);
      }
    }
    select.value = activeGroup;
    $("renameGroup").disabled = !activeGroup;
  }
  function editGroup(name = null) {
    renaming = name;
    openEditor($("groupForm"));
    let n = 1;
    while (groupOrder.includes("G" + n)) n++;
    $("groupName").value = name || "G" + n;
    $("groupName").focus();
    $("groupName").select();
  }
  $("newGroup").onclick = () => editGroup();
  $("renameGroup").onclick = () => {
    if (activeGroup) editGroup(activeGroup);
  };
  $("cancelGroup").onclick = () => {
    closeEditor();
  };
  $("groupForm").onsubmit = (e) => {
    e.preventDefault();
    const name = $("groupName").value.trim();
    if (!name) return;
    try {
      if (renaming) renameGroup(renaming, name);
      else assignGroup(name);
      closeEditor();
    } catch (err) {
      $("status").textContent = err.message;
    }
  };
  $("groupTarget").onchange = (e) => {
    activeGroup = (e.target as HTMLInputElement).value;
    persist();
    render();
    groupsChanged();
  };
  $("assignGroup").onclick = () => assignGroup(activeGroup);
  $("ungroupSignals").onclick = () => assignGroup("");
  $("expandGroups").onclick = () => {
    collapsedGroups.clear();
    requestRows();
  };
  $("collapseGroups").onclick = () => {
    for (const name of groupOrder) collapsedGroups.add(name);
    requestRows();
  };
  function groupMenu(x, y, name) {
    showMenu(x, y);
    menu.replaceChildren();
    for (const [label, run] of [
      ["重命名分组", () => editGroup(name)],
      ["选中信号移入此组", () => assignGroup(name)],
      ["移除分组（保留信号）", () => removeGroup(name)],
    ] as const) {
      const button = document.createElement("button");
      button.textContent = label;
      button.setAttribute("role", "menuitem");
      button.onclick = () => {
        menu.hidden = true;
        run();
      };
      menu.append(button);
    }
  }
  let virtualInputs = [];
  function editVirtual() {
    const selected = selectedSignals(),
      keys = new Set(selected.map(key)),
      ordered = displayRows
        .filter((r) => r.index !== undefined && keys.has(key(chosen[r.index])))
        .map((r) => chosen[r.index]);
    for (const s of selected) if (!ordered.includes(s)) ordered.push(s);
    virtualInputs = ordered.map((s) => ({
      id: s.id,
      scope: s.scope,
      name: s.name,
      bitOffset: Number.isInteger(s.bitOffset) ? s.bitOffset : null,
    }));
    if (!virtualInputs.length) {
      status("先选择输入信号", "warn");
      return;
    }
    openEditor($("virtualForm"));
    $("virtualName").value = "";
    $("virtualName").focus();
  }
  $("createVirtual").onclick = editVirtual;
  $("cancelVirtual").onclick = () => {
    closeEditor();
  };
  $("virtualForm").onsubmit = (e) => {
    e.preventDefault();
    vscode.postMessage({
      type: "defineVirtual",
      name: $("virtualName").value.trim(),
      definition: { op: $("virtualOp").value, inputs: virtualInputs },
    });
    closeEditor();
  };
  let editedMarker = null,
    draggingMarker = false,
    lastMarkerLayer = "",
    lastMarkerList = "";
  function namedMarkers() {
    return markers
      .filter((m) => m.name !== "B")
      .sort((a, b) => a.time - b.time || a.name.localeCompare(b.name));
  }
  function editMarker(item = null) {
    editedMarker = item?.name || null;
    openEditor($("markerForm"));
    let n = 1;
    while (markers.some((m) => m.name === "M" + n)) n++;
    $("markerName").value = item?.name || "M" + n;
    $("markerTime").value = String((item?.time ?? cursorA) / displayFactor);
    const swatch = document.createElement("canvas").getContext("2d");
    swatch.fillStyle = colors[0] || "#4ec9b0";
    $("markerColor").value =
      item?.color ||
      (/^#[0-9a-f]{6}$/i.test(String(swatch.fillStyle))
        ? String(swatch.fillStyle)
        : "#4ec9b0");
    $("markerError").textContent = "";
    $("markerName").focus();
    $("markerName").select();
  }
  $("addMarker").onclick = () => editMarker();
  $("cancelMarker").onclick = closeEditor;
  $("markerForm").onsubmit = async (e) => {
    e.preventDefault();
    try {
      const name = $("markerName").value.trim(),
        text = $("markerTime").value.trim().replace(/[,_]/g, ""),
        rawTime = Number(text) * displayFactor,
        time = Math.round(rawTime);
      if (!Number.isFinite(rawTime) || Math.abs(rawTime - time) > 1e-5)
        throw Error("时间无法精确表示为波形 tick");
      if (!text || !name || name === "A" || name === "B")
        throw Error("请输入有效时间，名称请避开游标 A/B");
      if (!editedMarker && markers.some((m) => m.name === name))
        throw Error("标记名称已存在，请编辑现有标记或换一个名称");
      await uiAction("marker", {
        time,
        name,
        oldName: editedMarker,
        color: $("markerColor").value,
        keepView: true,
        independent: true,
      });
      closeEditor();
    } catch (err) {
      $("markerError").textContent = err.message;
    }
  };
  function goMarker(m) {
    cursorA = m.time;
    if (m.time < start || m.time > end) {
      const half = (end - start) / 2;
      setWindow(m.time - half, m.time + half);
    } else {
      persist();
      render();
    }
  }
  function stepMarker(direction) {
    const sorted = namedMarkers(),
      item =
        direction > 0
          ? sorted.find((m) => m.time > cursorA)
          : sorted.findLast((m) => m.time < cursorA);
    if (item) goMarker(item);
    else status("这个方向没有更多时间标记", "warn");
  }
  $("previousMarker").onclick = () => stepMarker(-1);
  $("nextMarker").onclick = () => stepMarker(1);
  $("toggleMarkers").onclick = () => {
    markersVisible = !markersVisible;
    persist();
    render();
  };
  function manageMarkers() {
    $("markerManager").hidden = false;
    lastMarkerList = "";
    renderMarkerList();
  }
  function renderMarkerList() {
    if ($("markerManager").hidden) return;
    const signature = JSON.stringify([markers, displayFactor, displayScale]);
    if (signature === lastMarkerList) return;
    lastMarkerList = signature;
    const list = $("markerList");
    list.replaceChildren();
    for (const m of namedMarkers()) {
      const row = document.createElement("div");
      row.className = "markerItem";
      const name = document.createElement("span");
      name.textContent = m.name;
      name.style.color = m.color || colors[0];
      name.title = m.name;
      const time = document.createElement("span");
      time.textContent = timeLabel(m.time);
      row.append(name, time);
      for (const [label, run] of [
        ["跳转", () => goMarker(m)],
        ["编辑", () => editMarker(m)],
        ["删除", () => uiAction("deleteMarker", { name: m.name })],
      ] as const) {
        const button = document.createElement("button");
        button.textContent = label;
        button.onclick = run;
        row.append(button);
      }
      list.append(row);
    }
    if (!list.childNodes.length)
      list.textContent = "尚无命名时间标记。在 A 处按 M 添加。";
  }
  $("manageMarkers").onclick = manageMarkers;
  $("closeMarkerManager").onclick = () => {
    $("markerManager").hidden = true;
  };
  function renderMarkers() {
    if (draggingMarker) return;
    renderMarkerList();
    const signature = JSON.stringify([
      markers,
      markersVisible,
      start,
      end,
      $("canvas").clientWidth,
      displayFactor,
      displayScale,
      colors[0],
    ]);
    if (signature === lastMarkerLayer) return;
    lastMarkerLayer = signature;
    const layer = $("markerLayer");
    layer.replaceChildren();
    layer.style.display = markersVisible ? "block" : "none";
    if (!markersVisible) {
      renderMarkerList();
      return;
    }
    const width = $("canvas").clientWidth,
      items = namedMarkers().filter((m) => m.time >= start && m.time <= end),
      grouped = [];
    for (const m of items) {
      const group = grouped.at(-1);
      if (
        group &&
        Math.abs(((m.time - group.time) / (end - start)) * width) < 20
      )
        group.items.push(m);
      else grouped.push({ time: m.time, items: [m] });
    }
    grouped.forEach((group, i) => {
      const m = group.items[0],
        left = ((m.time - start) / (end - start)) * width,
        next = grouped[i + 1],
        available =
          (next ? ((next.time - start) / (end - start)) * width : width) -
          left -
          3;
      const button = document.createElement("button");
      button.className = "timeMarker";
      button.textContent =
        m.name +
        (group.items.length > 1 ? " +" + (group.items.length - 1) : "");
      button.title =
        group.items.map((m) => m.name + " · " + timeLabel(m.time)).join("\n") +
        "\n点击跳转 · 双击编辑 · 拖动调整时间";
      button.setAttribute("aria-label", "时间标记 " + m.name);
      button.style.left = Math.min(left, Math.max(0, width - 16)) + "px";
      button.style.maxWidth = Math.max(16, Math.min(200, available)) + "px";
      button.style.color = m.color || colors[0];
      let origin = null;
      button.onpointerdown = (e) => {
        e.stopPropagation();
        if (e.button !== 0) return;
        origin = e.clientX;
        button.setPointerCapture(e.pointerId);
        draggingMarker = true;
      };
      button.onpointermove = (e) => {
        if (origin === null) return;
        button.style.transform = "translateX(" + (e.clientX - origin) + "px)";
      };
      button.onpointerup = (e) => {
        e.stopPropagation();
        if (origin === null) return;
        const delta = e.clientX - origin;
        origin = null;
        draggingMarker = false;
        if (Math.abs(delta) > 3) {
          const time = Math.round(
            Math.max(
              Number(meta.start),
              Math.min(
                Number(meta.end),
                m.time + (delta / width) * (end - start),
              ),
            ),
          );
          uiAction("marker", { ...m, time, keepView: true, independent: true });
        } else {
          goMarker(m);
        }
      };
      button.onpointercancel = () => {
        origin = null;
        draggingMarker = false;
        render();
      };
      button.oncontextmenu = (e) => {
        e.preventDefault();
        editMarker(m);
      };
      button.ondblclick = (e) => {
        e.stopPropagation();
        editMarker(m);
      };
      button.onkeydown = (e) => {
        if (e.key === "Enter") goMarker(m);
      };
      layer.append(button);
    });
    renderMarkerList();
  }
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") $("markerManager").hidden = true;
    if (
      e.key.toLowerCase() === "m" &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      !["INPUT", "TEXTAREA", "SELECT"].includes(
        (e.target as HTMLElement).tagName,
      )
    ) {
      e.preventDefault();
      editMarker();
    }
  });
  window.waveMarkers = { render: renderMarkers };
  let copied = [],
    findIndex = -1;
  function find() {
    const text = $("findSignal").value.trim().toLowerCase();
    if (!text) return;
    for (let offset = 1; offset <= chosen.length; offset++) {
      const index = (findIndex + offset) % chosen.length,
        s = chosen[index];
      if (
        `${WaveSignal.label(s)} ${s.scope}.${s.name}`
          .toLowerCase()
          .includes(text)
      ) {
        findIndex = index;
        signalFilter = "";
        $("filterSignals").value = "";
        selectedKeys = new Set([key(s)]);
        active = index;
        ensureActive();
        persist();
        return;
      }
    }
    status("没有匹配的已添加信号", "warn");
  }
  function toggleFilter() {
    $("filterSignals").hidden = !$("filterSignals").hidden;
    if (!$("filterSignals").hidden) $("filterSignals").focus();
    else {
      signalFilter = "";
      $("filterSignals").value = "";
      requestRows();
    }
  }
  $("findNext").onclick = find;
  $("findSignal").onkeydown = (e) => {
    if (e.key === "Enter") find();
  };
  $("findSignal").oninput = () => {
    findIndex = -1;
  };
  $("toggleFilter").onclick = toggleFilter;
  $("filterSignals").value = signalFilter;
  $("filterSignals").hidden = !signalFilter;
  $("filterSignals").oninput = (e) => {
    signalFilter = (e.target as HTMLInputElement).value;
    requestRows();
  };
  function editAlias() {
    const s = chosen[active];
    if (!s) return;
    openEditor($("renameSignalForm"));
    $("signalAlias").value = WaveSignal.label(s);
    $("signalAlias").focus();
    $("signalAlias").select();
  }
  $("renameSignal").onclick = editAlias;
  let decoderTarget: Signal;
  let decoderEdit: { group: DecoderGroup; profile: DecoderProfile } | undefined;
  let decoderCatalog:
    | (DecoderCatalog & { workspaceAvailable: boolean })
    | undefined;
  let decoderSaveRequest = 0;
  let pendingDecoderSave = 0;
  const ruleFields = ["mask", "value", "label"] as const;
  const ruleLabels = { mask: "掩码", value: "匹配值", label: "显示文本" };
  const decodeMenu = $("decoderMenu");
  function renderDecoderGroups(reset = false) {
    const signal = chosen[active];
    const activeId = signal?.decoder?.id;
    const listed = decoderCatalog?.groups.some((group) =>
      group.profiles.some((profile) => profile.id === activeId),
    );
    $("decoderSelection").textContent = signal
      ? `${WaveSignal.label(signal)} · ${activeId && !listed ? "✓ " : ""}${signal.decoder?.label || "原始值"}`
      : "先选中波形信号";
    $("editSignalDecoder").disabled = !signal;
    $("clearSignalDecoder").disabled = !signal?.decoder;
    const list = $("decoderGroups");
    const expanded = new Set(
      reset
        ? []
        : [...list.querySelectorAll<HTMLDetailsElement>("details[open]")].map(
            (node) => node.dataset.group,
          ),
    );
    list.replaceChildren();
    $("decoderWorkspace").disabled =
      decoderCatalog?.workspaceAvailable === false;
    if (!decoderCatalog) return;
    for (const group of decoderCatalog.groups) {
      const file = document.createElement("details");
      file.className = "decoderGroup";
      file.dataset.group = group.id;
      const current = group.profiles.some((profile) => profile.id === activeId);
      file.open = expanded.has(group.id) || current;
      const summary = document.createElement("summary");
      summary.textContent = (current ? "✓ " : "") + group.label;
      const origin = document.createElement("small");
      origin.textContent =
        (group.builtin ? "内置" : "工作区") + " · " + group.filename;
      summary.append(origin);
      file.append(summary);
      for (const profile of group.profiles) {
        const row = document.createElement("div");
        row.className = "decoderProfile";
        const label = document.createElement("label");
        const choice = document.createElement("input");
        choice.type = "radio";
        choice.name = "decoderProfile";
        const compatible =
          !!signal && !signal.real && supportsProfile(profile, signal.width);
        choice.checked = profile.id === activeId;
        choice.disabled = !compatible;
        choice.onchange = async () => {
          await uiAction("setDecoder", { signal, profile });
          renderDecoderGroups();
        };
        const caption = document.createElement("span");
        caption.textContent = profile.label;
        label.append(choice, caption);
        const edit = document.createElement("button");
        edit.textContent = group.builtin ? "编辑副本…" : "编辑…";
        edit.setAttribute("aria-label", edit.textContent + " " + profile.label);
        edit.disabled = !compatible || !decoderCatalog.workspaceAvailable;
        edit.onclick = () => openDecoderEditor(signal, { group, profile });
        row.append(label, edit);
        file.append(row);
      }
      list.append(file);
    }
    for (const message of decoderCatalog.warnings) {
      const notice = document.createElement("small");
      notice.className = "decoderWarning";
      notice.textContent = message;
      list.append(notice);
    }
  }
  decodeMenu.addEventListener("toggle", (event) => {
    if (event.target !== decodeMenu || !decodeMenu.open) return;
    renderDecoderGroups(true);
    vscode.postMessage({ type: "decoderCatalog" });
  });
  window.addEventListener("message", async ({ data: message }) => {
    if (message.type === "decoderCatalog") {
      decoderCatalog = message;
      if (decodeMenu.open) renderDecoderGroups();
    } else if (
      message.type === "decoderProfileSaved" &&
      message.request === pendingDecoderSave
    ) {
      pendingDecoderSave = 0;
      $("applyDecoderRule").disabled = false;
      if (message.error) {
        $("decoderError").textContent = message.error;
        return;
      }
      if (chosen.some((signal) => key(signal) === key(decoderTarget)))
        await uiAction("setDecoder", {
          signal: decoderTarget,
          profile: message.profile,
        });
      if (!$("decoderForm").hidden) closeEditor();
      vscode.postMessage({ type: "decoderCatalog" });
    }
  });
  function appendDecoderRule(rule: Rule) {
    const rows = $("decoderRules");
    const row = rows.insertRow();
    for (const field of ruleFields) {
      const input = document.createElement("input");
      input.value = rule[field];
      input.maxLength = field === "label" ? 160 : 258;
      input.required = true;
      input.spellcheck = false;
      input.autocapitalize = "off";
      input.setAttribute("aria-label", ruleLabels[field]);
      row.insertCell().append(input);
    }
    const branches = document.createElement("details");
    branches.className = "ruleBranches";
    const summary = document.createElement("summary");
    summary.textContent = rule.branches?.length
      ? `条件分支 (${rule.branches.length})`
      : "条件分支";
    const branchEditor = document.createElement("textarea");
    branchEditor.setAttribute("aria-label", "条件分支 JSON");
    branchEditor.rows = 5;
    branchEditor.spellcheck = false;
    branchEditor.placeholder =
      '[{"when":[{"mask":"0x1","value":"0x1"}],"label":"奇数"}]';
    branchEditor.value = rule.branches?.length
      ? JSON.stringify(rule.branches, null, 2)
      : "";
    branches.append(summary, branchEditor);
    row.cells[2].append(branches);
    const controls = row.insertCell();
    const up = document.createElement("button");
    up.type = "button";
    up.textContent = "↑";
    up.setAttribute("aria-label", "上移规则");
    up.onclick = () => {
      const previous = row.previousElementSibling;
      if (previous) rows.insertBefore(row, previous);
    };
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "删除";
    remove.onclick = () => row.remove();
    controls.append(up, remove);
  }
  function addDefaultDecoderRule() {
    if ($("decoderRules").rows.length >= 256) {
      $("decoderError").textContent = "最多可添加 256 条解码规则";
      return;
    }
    const width = $("decoderUart").hidden
      ? decoderTarget.width
      : Number($("uartDataBits").value);
    const mask = "0x" + ((1n << BigInt(width)) - 1n).toString(16);
    appendDecoderRule({ mask, value: "0", label: "" });
  }
  function openDecoderEditor(signal: Signal, edit?: typeof decoderEdit) {
    if (pendingDecoderSave) return;
    decoderTarget = signal;
    decoderEdit = edit;
    if (!decoderTarget) return;
    const profile = edit?.profile ?? decoderTarget.decoder;
    if (
      !profile?.uart &&
      (decoderTarget.width < 2 || decoderTarget.width > 256)
    ) {
      status("自定义规则适用于 2–256 位信号", "warn");
      return;
    }
    $("decoderSignal").textContent =
      `${WaveSignal.label(decoderTarget)} · ${decoderTarget.width} 位`;
    $("decoderLabel").value = edit?.group.builtin
      ? (profile.label + " 副本").slice(0, 120)
      : profile?.rules || profile?.uart || edit
        ? profile.label
        : "自定义解码";
    $("decoderEngine").hidden = !edit?.profile.builtin;
    $("decoderUart").hidden = $("decoderUart").disabled = !profile?.uart;
    if (profile?.uart) {
      $("uartBaud").value = String(profile.uart.baud);
      $("uartDataBits").value = String(profile.uart.dataBits);
      $("uartParity").value = profile.uart.parity;
      $("uartStopBits").value = String(profile.uart.stopBits);
      $("uartBitOrder").value = profile.uart.bitOrder;
      $("uartInverted").checked = profile.uart.inverted;
    }
    $("applyDecoderRule").textContent = edit
      ? edit.group.builtin
        ? "保存副本并应用"
        : "保存并应用"
      : "应用到信号";
    $("decoderError").textContent = "";
    $("decoderRules").replaceChildren();
    if (profile?.rules) profile.rules.forEach(appendDecoderRule);
    else if (!edit?.profile.builtin && !profile?.uart) addDefaultDecoderRule();
    openEditor($("decoderForm"));
    $("decoderLabel").focus();
  }
  $("editSignalDecoder").onclick = () => openDecoderEditor(chosen[active]);
  $("addDecoderRule").onclick = addDefaultDecoderRule;
  $("cancelSignalDecoder").onclick = closeEditor;
  $("clearSignalDecoder").onclick = async () => {
    const signal = chosen[active];
    if (signal) await uiAction("setDecoder", { signal });
  };
  $("decoderForm").onsubmit = async (event) => {
    event.preventDefault();
    try {
      const rules = Array.from($("decoderRules").rows, (row, index) => {
        const [mask, value, label] = Array.from(
          row.querySelectorAll("input"),
          (input) => input.value.trim(),
        );
        const branches = row.querySelector("textarea").value.trim();
        try {
          return {
            mask,
            value,
            label,
            ...(branches ? { branches: JSON.parse(branches) } : {}),
          };
        } catch {
          throw Error(`第 ${index + 1} 条规则的条件分支不是有效 JSON`);
        }
      });
      const uart: UartOptions | undefined = $("decoderUart").hidden
        ? undefined
        : {
            baud: Number($("uartBaud").value),
            dataBits: Number($("uartDataBits").value),
            parity: $("uartParity").value as UartOptions["parity"],
            stopBits: Number(
              $("uartStopBits").value,
            ) as UartOptions["stopBits"],
            bitOrder: $("uartBitOrder").value as UartOptions["bitOrder"],
            inverted: $("uartInverted").checked,
          };
      const profile = validateProfile({
        id: decoderEdit?.profile.id || "signal-custom",
        label: $("decoderLabel").value.trim(),
        width: decoderEdit ? decoderEdit.profile.width : decoderTarget.width,
        builtin: decoderEdit?.profile.builtin,
        uart,
        rules,
      });
      if (decoderEdit) {
        pendingDecoderSave = ++decoderSaveRequest;
        $("applyDecoderRule").disabled = true;
        $("decoderError").textContent = "";
        vscode.postMessage({
          type: "saveDecoderProfile",
          request: pendingDecoderSave,
          group: decoderEdit.group.id,
          original: decoderEdit.profile,
          edited: profile,
        });
        return;
      }
      await uiAction("setDecoder", { signal: decoderTarget, profile });
      closeEditor();
    } catch (error) {
      $("decoderError").textContent = error.message;
    }
  };
  let annotationTarget: Signal;
  function editAnnotation(signal: Signal = chosen[active]) {
    if (!signal) return;
    annotationTarget = signal;
    $("annotationSignal").textContent = WaveSignal.label(annotationTarget);
    $("annotationTags").value =
      annotationTarget.annotation?.tags.join(", ") || "";
    $("annotationNote").value = annotationTarget.annotation?.note || "";
    $("annotationError").textContent = "";
    openEditor($("annotationForm"));
    $("annotationTags").focus();
  }
  $("editAnnotation").onclick = () => editAnnotation();
  $("cancelAnnotation").onclick = closeEditor;
  $("annotationForm").onsubmit = async (e) => {
    e.preventDefault();
    try {
      await uiAction("annotateSignal", {
        signal: annotationTarget,
        tags: $("annotationTags").value.split(/[,，]/),
        note: $("annotationNote").value,
      });
      closeEditor();
    } catch (error) {
      $("annotationError").textContent = error.message;
    }
  };
  $("cancelSignalRename").onclick = () => {
    closeEditor();
  };
  $("renameSignalForm").onsubmit = (e) => {
    e.preventDefault();
    if (chosen[active])
      chosen[active].displayName = $("signalAlias").value.trim() || undefined;
    closeEditor();
    requestRows();
  };
  function move(direction) {
    const targets = new Set(selectedSignals().map(key)),
      keep = chosen[active];
    if (direction < 0) {
      for (let i = 1; i < chosen.length; i++)
        if (
          targets.has(key(chosen[i])) &&
          !targets.has(key(chosen[i - 1])) &&
          chosen[i].group === chosen[i - 1].group
        )
          [chosen[i - 1], chosen[i]] = [chosen[i], chosen[i - 1]];
    } else {
      for (let i = chosen.length - 2; i >= 0; i--)
        if (
          targets.has(key(chosen[i])) &&
          !targets.has(key(chosen[i + 1])) &&
          chosen[i].group === chosen[i + 1].group
        )
          [chosen[i], chosen[i + 1]] = [chosen[i + 1], chosen[i]];
    }
    active = Math.max(0, chosen.indexOf(keep));
    requestRows();
    ensureActive();
  }
  $("expandBus").onclick = () => expandBus();
  $("collapseBus").onclick = () => collapseBus();
  $("moveUp").onclick = () => move(-1);
  $("moveDown").onclick = () => move(1);
  function copyPaths() {
    vscode.postMessage({
      type: "copyPaths",
      text: selectedSignals()
        .map(
          (s) =>
            s.scope +
            "." +
            (Number.isInteger(s.bitOffset)
              ? WaveSignal.label({ ...s, displayName: undefined })
              : s.name),
        )
        .join("\n"),
    });
  }
  function copySignals() {
    const selected = new Set(selectedSignals().map(key));
    copied = chosen
      .filter((s) => selected.has(key(s)) || selected.has(s.parentBus))
      .map((s) => ({ ...s }));
    status("已复制 " + copied.length + " 个信号");
  }
  function pasteSignals() {
    uiAction("addSignals", {
      signals: copied.map((s) => ({ ...s, group: activeGroup || undefined })),
    }).catch((e) => status(e.message, "error"));
  }
  function notation(value) {
    for (const s of selectedSignals()) s.notation = value;
    requestRows();
  }
  function highlight() {
    const input = document.createElement("input");
    input.type = "color";
    input.value = chosen[active]?.highlight || "#4ec9b0";
    input.setAttribute("aria-label", "高亮颜色");
    menu.replaceChildren(input);
    menu.hidden = false;
    input.oninput = () => {
      for (const s of selectedSignals()) s.highlight = input.value;
      requestRows();
    };
    input.click();
  }
  async function eventReport() {
    const selected = selectedSignals().map((s) => ({ ...s })),
      a = start,
      b = end;
    const rows = [
      ["Signal", "Time (" + (meta?.scale || "tick") + ")", "Value"].join("\t"),
    ];
    let truncated = false,
      count = 0;
    for (let i = 0; i < selected.length; i += 64) {
      const signals = selected.slice(i, i + 64);
      const blocks = await reportQuery(
        signals.map((s) => s.id),
        a,
        b,
      );
      for (const s of signals) {
        const block = blocks[s.id];
        truncated ||= !!block?.truncated;
        let lastBit;
        for (const [time, value] of block?.events || []) {
          if (Number.isInteger(s.bitOffset)) {
            const bit = WaveSignal.project(value, s);
            if (bit === lastBit) continue;
            lastBit = bit;
          }
          if (count >= 5000) {
            truncated = true;
            break;
          }
          rows.push(
            [
              s.scope +
                "." +
                WaveSignal.label({ ...s, displayName: undefined }),
              time,
              formatSignal(value, s),
            ].join("\t"),
          );
          count++;
        }
      }
      if (count >= 5000) break;
    }
    $("eventReport").hidden = false;
    $("eventReport").open = true;
    $("reportSummary").textContent =
      `${a} → ${b} · ${selected.length} 个信号 · ${count} 条状态记录（含窗口起点值）` +
      (truncated ? " · 结果截断，请缩小窗口/选择范围" : "");
    $("reportBody").textContent = rows.join("\n");
  }
  const reports = new Map();
  let reportSequence = 0;
  function reportQuery(signals, a, b) {
    return new Promise((resolve, reject) => {
      const request = "report:" + ++reportSequence;
      const timer = window.setTimeout(() => {
        reports.delete(request);
        reject(Error("事件报告读取超时"));
      }, 120000);
      reports.set(request, { resolve, reject, timer });
      vscode.postMessage({
        type: "query",
        signals,
        start: Math.floor(a),
        end: Math.ceil(b),
        request,
        report: true,
        limit: Math.max(2, Math.floor(5000 / signals.length)),
      });
    });
  }
  window.addEventListener("message", (e) => {
    const m = e.data;
    if (m.type === "data" && reports.has(m.request)) {
      const p = reports.get(m.request);
      reports.delete(m.request);
      clearTimeout(p.timer);
      p.resolve(m.result);
    } else if (
      m.type === "error" &&
      m.origin === "query" &&
      (!m.request || reports.has(m.request))
    ) {
      for (const p of reports.values()) {
        clearTimeout(p.timer);
        p.reject(Error(m.message));
      }
      reports.clear();
    }
  });
  $("signalReport").onclick = () =>
    eventReport().catch((e) => status(e.message, "error"));
  $("closeReport").onclick = () => {
    $("eventReport").hidden = true;
  };
  document.addEventListener("keydown", (e) => {
    if (
      ["INPUT", "TEXTAREA", "SELECT"].includes(
        (e.target as HTMLElement).tagName,
      ) ||
      !(e.ctrlKey || e.metaKey)
    )
      return;
    const k = e.key.toLowerCase();
    if (k === "f") {
      e.preventDefault();
      if (e.shiftKey) toggleFilter();
      else $("findSignal").focus();
    } else if (["c", "x", "v"].includes(k)) {
      if (window.getSelection()?.toString()) return;
      e.preventDefault();
      if (k === "v") pasteSignals();
      else {
        copySignals();
        if (k === "x") action("remove");
      }
    } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      move(e.key === "ArrowUp" ? -1 : 1);
    }
  });
  function requestRows() {
    window.dispatchEvent(new CustomEvent("wave-rebuild"));
  }
  document.addEventListener("pointerdown", (e) => {
    if (!menu.contains(e.target as Node)) menu.hidden = true;
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") menu.hidden = true;
  });
  $("tracks").addEventListener("dragover", (e) => {
    if (e.dataTransfer.types.includes("application/x-wave-signals"))
      e.preventDefault();
  });
  $("tracks").addEventListener("drop", (e) => {
    const raw = e.dataTransfer.getData("application/x-wave-signals");
    if (!raw) return;
    e.preventDefault();
    try {
      const signals = JSON.parse(raw);
      if (
        !Array.isArray(signals) ||
        signals.length > 100000 ||
        signals.some(
          (s) => typeof s.id !== "string" || typeof s.name !== "string",
        )
      )
        throw Error("Invalid signal drag");
      uiAction("addSignals", { signals }).catch(
        (e) => ($("status").textContent = e.message),
      );
    } catch (err) {
      $("status").textContent = err.message;
    }
  });
  for (const [id, isB] of [
    ["cursorAInput", false],
    ["cursorBInput", true],
  ] as const)
    $(id).onchange = () => {
      if (!meta) return;
      const ticks = Number($(id).value.replace(/[,_]/g, "")) * displayFactor;
      const value = Math.round(ticks);
      if (
        !Number.isSafeInteger(value) ||
        Math.abs(ticks - value) > 1e-5 ||
        value < Number(meta.start) ||
        value > Number(meta.end)
      ) {
        const cursor = isB ? cursorB : cursorA;
        $(id).value = cursor == null ? "" : String(cursor / displayFactor);
        return;
      }
      $(id).value = String(value / displayFactor);
      if (isB) cursorB = value;
      else cursorA = value;
      persist();
      render();
    };
  const canvas = $("canvas"),
    box = document.createElement("div");
  box.id = "zoomBox";
  box.hidden = true;
  $("plot").append(box);
  let pointer = null;
  const tick = (x) =>
    Math.round(
      start +
        (Math.max(
          0,
          Math.min(canvas.clientWidth, x - canvas.getBoundingClientRect().left),
        ) /
          canvas.clientWidth) *
          (end - start),
    );
  canvas.onpointerdown = (e) => {
    canvas.focus();
    canvas.setPointerCapture(e.pointerId);
    if (e.button === 3 || e.button === 4) {
      e.preventDefault();
      vscode.postMessage({
        type: "navigateScope",
        direction: e.button === 3 ? "back" : "forward",
      });
      return;
    }
    pointer = { x: e.clientX, start, end, button: e.button, shift: e.shiftKey };
    if (e.button !== 0) e.preventDefault();
  };
  canvas.onpointermove = (e) => {
    if (!pointer) return;
    if (pointer.button === 1 || pointer.button === 2) {
      const dx = e.clientX - pointer.x;
      if (Math.abs(dx) > 5 || pointer.panning) {
        pointer.panning = true;
        const shift =
          (-dx / canvas.clientWidth) * (pointer.end - pointer.start);
        setWindow(pointer.start + shift, pointer.end + shift, true);
      }
      return;
    }
    if (pointer.button !== 0 || pointer.shift) return;
    const left = canvas.getBoundingClientRect().left,
      a = pointer.x - left,
      b = e.clientX - left;
    if (Math.abs(a - b) > 5) {
      box.hidden = false;
      box.style.left = Math.max(0, Math.min(a, b)) + "px";
      box.style.width = Math.abs(a - b) + "px";
    }
  };
  canvas.onpointerup = (e) => {
    if (!pointer) return;
    const p = pointer;
    pointer = null;
    box.hidden = true;
    const dx = e.clientX - p.x;
    if (p.button === 0) {
      if (Math.abs(dx) > 5 && !p.shift) {
        const a = tick(p.x),
          b = tick(e.clientX);
        if (a !== b) setWindow(Math.min(a, b), Math.max(a, b));
      } else {
        if (p.shift) cursorB = tick(e.clientX);
        else cursorA = tick(e.clientX);
        persist();
        render();
      }
    } else if (p.panning || Math.abs(dx) > 5) {
      const shift = (-dx / canvas.clientWidth) * (p.end - p.start);
      setWindow(p.start + shift, p.end + shift);
    } else if (p.button === 2) showMenu(e.clientX, e.clientY);
  };
  canvas.onpointercancel = () => {
    pointer = null;
    box.hidden = true;
  };
  canvas.oncontextmenu = (e) => e.preventDefault();
  // Hover uses loaded source blocks first. Point reads are debounced and never
  // populate the viewport cache or change either cursor.
  const tooltip = $("waveTooltip"),
    hoverLine = document.createElement("div"),
    hoverBand = document.createElement("div");
  hoverLine.id = "hoverLine";
  hoverBand.id = "hoverBand";
  hoverLine.hidden = true;
  hoverBand.hidden = true;
  $("plot").append(hoverBand, hoverLine);
  let hover = null,
    hoverTimer = 0,
    hoverFrame = 0,
    hoverFlight = null,
    hoverSequence = 0;
  const hoverCache = new Map();
  function hideHover() {
    hover = null;
    clearTimeout(hoverTimer);
    tooltip.hidden = true;
    hoverLine.hidden = true;
    hoverBand.hidden = true;
  }
  clearWaveHover = hideHover;
  const tooltipToggle = $("toggleTooltip");
  tooltipToggle.checked = tooltipEnabled;
  tooltipToggle.onchange = () => setTooltip(tooltipToggle.checked);
  function hoverHit(e) {
    if (!tooltipEnabled || !meta || e.buttons || pointer || draggingMarker)
      return null;
    const rect = canvas.getBoundingClientRect(),
      y = e.clientY - rect.top;
    if (y < timelineHeight || y >= canvas.clientHeight) return null;
    const position = Math.floor(
        (y - timelineHeight + $("tracks").scrollTop) / rowHeight,
      ),
      item = displayRows[position];
    if (item?.index === undefined) return null;
    const signal = chosen[item.index];
    if (!signal) return null;
    const time = Math.round(
      start +
        (Math.max(0, Math.min(rect.width, e.clientX - rect.left)) /
          rect.width) *
          (end - start),
    );
    return {
      signal,
      time,
      x: e.clientX,
      y: e.clientY,
      plotX: e.clientX - rect.left,
      rowY: timelineHeight + position * rowHeight - $("tracks").scrollTop,
      window: start + ":" + end,
    };
  }
  function hoverBlock(hit) {
    const read = data[hit.signal.id];
    if (coversTick(read, hit.time)) {
      const events = read.block.events;
      return { raw: events[valueAt(events, hit.time)]?.[1] };
    }
    return hoverCache.get(hit.signal.id + ":" + hit.time);
  }
  function showHover() {
    if (!hover) return;
    const hit = hover;
    if (hit.window !== start + ":" + end) {
      hideHover();
      return;
    }
    const result = hoverBlock(hit),
      signal = hit.signal,
      raw = result?.raw,
      projected = WaveSignal.project(raw, signal),
      label = WaveSignal.label(signal),
      path =
        signal.scope +
        "." +
        WaveSignal.label({ ...signal, displayName: undefined });
    tooltip.replaceChildren();
    const title = document.createElement("strong");
    title.textContent = label + " · " + signal.width + " bit";
    const full = document.createElement("div");
    full.className = "hoverPath";
    full.textContent = path;
    const time = document.createElement("div");
    time.textContent =
      "时间：" + timeLabel(hit.time) + " · ΔA " + timeLabel(hit.time - cursorA);
    tooltip.append(title, full, time);
    if (signal.annotation) {
      const annotation = document.createElement("div");
      annotation.className = "hoverAnnotation";
      annotation.textContent = [
        signal.annotation.tags.map((tag) => "#" + tag).join(" "),
        signal.annotation.note,
      ]
        .filter(Boolean)
        .join("\n");
      tooltip.append(annotation);
    }
    if (result?.error) {
      const note = document.createElement("div");
      note.className = "hoverWarning";
      note.textContent = result.error;
      tooltip.append(note);
    } else if (!result) {
      const loading = document.createElement("div");
      loading.textContent = "读取此时刻的值…";
      tooltip.append(loading);
    } else if (raw == null) {
      const empty = document.createElement("div");
      empty.textContent = "此时刻没有已记录的值";
      tooltip.append(empty);
    } else {
      const decoded =
        uartLabelAt(signal, hit.time) ||
        (showDecodedValues.checked &&
          signal.decoder &&
          decodeWord(signal.decoder, projected, signal.width));
      for (const [name, value] of [
        ...(decoded ? [["解码", decoded]] : []),
        ["值", formatSignal(raw, signal)],
        ["Hex", format(projected, signal.width, "hex")],
        ["Binary", format(projected, signal.width, "bin")],
        [
          "Unsigned / Signed",
          format(projected, signal.width, "unsigned") +
            " / " +
            format(projected, signal.width, "signed"),
        ],
      ]) {
        const row = document.createElement("div"),
          key = document.createElement("span"),
          text = document.createElement("code");
        key.textContent = name;
        row.className = "hoverValue";
        key.className = "hoverKey";
        text.textContent =
          value.length > 1024
            ? value.slice(0, 1024) + "…（值过长，已截断显示）"
            : value;
        row.append(key, text);
        tooltip.append(row);
      }
    }
    if (data[signal.id]?.block.truncated && readEnd(data[signal.id]) < end) {
      const warning = document.createElement("div");
      warning.className = "hoverWarning";
      warning.textContent = "图形数据已截断；超出已读范围时单独查询悬停值。";
      tooltip.append(warning);
    }
    tooltip.hidden = false;
    const bounds = tooltip.getBoundingClientRect();
    tooltip.style.left =
      Math.max(6, Math.min(hit.x + 14, innerWidth - bounds.width - 6)) + "px";
    tooltip.style.top =
      Math.max(
        6,
        hit.y + bounds.height + 16 > innerHeight
          ? hit.y - bounds.height - 12
          : hit.y + 16,
      ) + "px";
    hoverLine.hidden = false;
    hoverLine.style.left = hit.plotX + "px";
    hoverLine.style.top = timelineHeight + "px";
    hoverBand.hidden = false;
    const bandTop = Math.max(timelineHeight, hit.rowY);
    const bandBottom = Math.min(canvas.clientHeight, hit.rowY + rowHeight);
    hoverBand.style.top = bandTop + "px";
    hoverBand.style.height = bandBottom - bandTop + "px";
  }
  function requestHover() {
    if (!hover || hoverFlight || hoverBlock(hover)) return;
    const hit = hover,
      request = "hover:" + ++hoverSequence;
    hoverFlight = { request, key: hit.signal.id + ":" + hit.time };
    vscode.postMessage({
      type: "query",
      signals: [hit.signal.id],
      start: hit.time,
      end: hit.time,
      request,
    });
  }
  canvas.addEventListener("pointermove", (e) => {
    const next = hoverHit(e);
    if (!next) {
      hideHover();
      return;
    }
    const changed =
      !hover ||
      key(next.signal) !== key(hover.signal) ||
      next.time !== hover.time;
    hover = next;
    if (!hoverFrame)
      hoverFrame = requestAnimationFrame(() => {
        hoverFrame = 0;
        showHover();
      });
    if (changed) {
      clearTimeout(hoverTimer);
      hoverTimer = window.setTimeout(requestHover, 180);
    }
  });
  canvas.addEventListener("pointerleave", hideHover);
  canvas.addEventListener("blur", hideHover);
  canvas.addEventListener("pointerdown", hideHover);
  canvas.addEventListener("wheel", hideHover, { passive: true });
  $("tracks").addEventListener("scroll", hideHover, { passive: true });
  window.addEventListener("resize", hideHover);
  document.addEventListener("visibilitychange", hideHover);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideHover();
  });
  document.addEventListener("pointerdown", (e) => {
    if (e.target !== canvas) hideHover();
  });
  window.addEventListener("message", (e) => {
    const m = e.data;
    if (m.type === "metadata" || m.type === "backendChanged") {
      hoverCache.clear();
      hoverFlight = null;
      hideHover();
    }
    if (m.type === "data" && hoverFlight?.request === m.request) {
      const flight = hoverFlight;
      hoverFlight = null;
      const block = Object.values(m.result as QueryResult)[0],
        value = block?.truncated
          ? { error: "该时刻事件被截断，无法确认精确值" }
          : { raw: block?.events.at(-1)?.[1] };
      hoverCache.set(flight.key, value);
      while (hoverCache.size > 128)
        hoverCache.delete(hoverCache.keys().next().value);
      if (hover) {
        showHover();
        clearTimeout(hoverTimer);
        hoverTimer = window.setTimeout(requestHover, 180);
      }
    } else if (
      m.type === "error" &&
      m.origin === "query" &&
      hoverFlight &&
      m.request === hoverFlight.request
    ) {
      const flight = hoverFlight;
      hoverFlight = null;
      hoverCache.set(flight.key, { error: m.message });
      while (hoverCache.size > 128)
        hoverCache.delete(hoverCache.keys().next().value);
      showHover();
    }
  });
  window.waveHover = {
    refresh: () => {
      if (hover) {
        const updated = hoverHit({
          clientX: hover.x,
          clientY: hover.y,
          buttons: 0,
        });
        if (updated && key(updated.signal) === key(hover.signal))
          hover = updated;
        else hideHover();
        showHover();
      }
    },
  };
  window.waveWorkflow = {
    scope: selectScope,
    selectedScope: () => scope,
    menu: showMenu,
    groupsChanged,
    editGroup,
    editAnnotation,
    groupMenu,
  };
  groupsChanged();
})();
