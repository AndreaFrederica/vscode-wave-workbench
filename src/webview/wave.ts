// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { getElement as $ } from "./dom";
import * as WaveSignal from "../shared/signals";
import type {
  Signal,
  Metadata,
  WaveState,
  Block,
  Marker,
  QueryResult,
} from "../shared/protocol";
/* global acquireVsCodeApi */
const vscode = acquireVsCodeApi<Partial<WaveState>>();

const ROW = 32;
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
let meta: Metadata,
  chosen: Signal[] = [],
  data: QueryResult = {},
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
  inflight = null,
  neededIds = [],
  dragIndex = null,
  pan = null,
  searchRequest = 0,
  searchTimer;
const saved = vscode.getState() || {};
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
let timelineHeight = ROW;
let persistTimer;
let cursorValues = {},
  cursorFlight = null,
  cursorSequence = 0;
function persist() {
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
        })),
        start,
        end,
        cursorA,
        cursorB,
        radix,
        markers,
        markersVisible,
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
    const matches = (i) =>
      !signalFilter ||
      `${WaveSignal.label(chosen[i])} ${chosen[i].scope}.${chosen[i].name}`
        .toLowerCase()
        .includes(signalFilter.toLowerCase());
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
  const events = data[s.id]?.events || [];
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
  render();
}
function visibleRange() {
  const height = Math.max(1, $("tracks").clientHeight - timelineHeight),
    top = $("tracks").scrollTop;
  return [
    Math.max(0, Math.floor(top / ROW) - OVERSCAN),
    Math.min(displayRows.length, Math.ceil((top + height) / ROW) + OVERSCAN),
  ];
}
function refreshNeeded() {
  const [a, b] = visibleRange();
  firstRow = a;
  lastRow = b;
  neededIds = [
    ...new Set(
      displayRows
        .slice(a, b)
        .filter((r) => r.index !== undefined)
        .map((r) => chosen[r.index].id),
    ),
  ];
  const keep = new Set(neededIds);
  for (const id of Object.keys(data)) if (!keep.has(id)) delete data[id];
  for (const id of Object.keys(cursorValues))
    if (!keep.has(id)) delete cursorValues[id];
  pump();
  pumpCursor();
}
// Values at A must remain correct when A lies outside the displayed time window.
function pumpCursor() {
  if (!meta || cursorFlight) return;
  const required = neededIds.filter((id) => {
    const block = data[id],
      events = block?.events || [];
    return (
      !(
        cursorA >= start &&
        cursorA <= end &&
        (!block || !block.truncated || cursorA <= Number(events.at(-1)?.[0]))
      ) && cursorValues[id]?.time !== cursorA
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
  const block = data[id],
    events = block?.events || [];
  if (
    cursorA >= start &&
    cursorA <= end &&
    block &&
    (!block.truncated || cursorA <= Number(events.at(-1)?.[0]))
  )
    return events[valueAt(events, cursorA)]?.[1];
  return cursorValues[id]?.time === cursorA ? cursorValues[id].value : null;
}
function add(signal) {
  if (chosen.some((s) => key(s) === key(signal))) return;
  if (chosen.length >= MAX_SIGNALS) {
    status("已达到 100000 个已添加信号的会话上限", "warn");
    return;
  }
  if (!signal.group && activeGroup) signal.group = activeGroup;
  chosen.push(signal);
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
  if (!meta || inflight) return;
  const missing = neededIds.filter((id) => !Object.hasOwn(data, id));
  if (!missing.length) {
    settled();
    return;
  }
  const ids = missing.slice(0, 64);
  inflight = { request: ++generation, window: `${start}:${end}`, ids };
  status(
    `正在读取可见信号… ${chosen.length} 个已添加 / ${neededIds.length} 个视口信号`,
  );
  vscode.postMessage({
    type: "query",
    signals: ids,
    start: Math.floor(start),
    end: Math.ceil(end),
    request: inflight.request,
  });
}
function settled() {
  const clipped = Object.values(data).some((v) => v.truncated);
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
    top = Math.max(0, position) * ROW,
    bottom = top + ROW;
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
function setWindow(a, b) {
  const low = Number(meta.start),
    high = Math.max(low + 1, Number(meta.end)),
    length = Math.min(high - low, Math.max(1, b - a));
  start = Math.round(Math.max(low, Math.min(a, high - length)));
  end = Math.min(high, start + Math.round(length));
  data = {};
  request();
}
function zoom(factor, anchor = 0.5) {
  const length = (end - start) * factor,
    point = start + (end - start) * anchor;
  setWindow(point - length * anchor, point + length * (1 - anchor));
}
function render() {
  timelineHeight =
    markersVisible &&
    markers.some((m) => m.name !== "B" && m.time >= start && m.time <= end)
      ? 56
      : ROW;
  $("names").querySelector<HTMLElement>(".ruler").style.height =
    timelineHeight + "px";
  $("zoomBox")?.style.setProperty("top", timelineHeight + "px");
  viewportHeight = Math.max(1, $("tracks").clientHeight);
  $("trackContent").style.height =
    Math.max(viewportHeight, ROW * displayRows.length + timelineHeight) + "px";
  $("plot").style.height = viewportHeight + "px";
  $("tracks").dataset.total = String(chosen.length);
  [firstRow, lastRow] = visibleRange();
  const rows = $("rows");
  rows.style.top = timelineHeight + firstRow * ROW + "px";
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
      group.title = "点击折叠/展开 · 双击重命名 · 可拖入信号";
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
        e.preventDefault();
        group.classList.add("dropTarget");
      };
      group.ondragleave = () => group.classList.remove("dropTarget");
      group.ondrop = async (e) => {
        e.preventDefault();
        e.stopPropagation();
        group.classList.remove("dropTarget");
        if (e.dataTransfer.types.includes("application/x-wave-reorder")) {
          assignGroup(item.group);
          dragIndex = null;
        } else {
          try {
            const signals = JSON.parse(
              e.dataTransfer.getData("application/x-wave-signals"),
            );
            if (!Array.isArray(signals)) return;
            const keys = new Set(signals.map(key));
            for (const s of chosen) if (keys.has(key(s))) s.group = item.group;
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
    name.textContent = WaveSignal.label(s);
    row.classList.toggle("groupChild", !!s.group);
    row.classList.toggle("busBit", Number.isInteger(s.bitOffset));
    row.style.setProperty(
      "--signal-color",
      s.highlight || colors[i % colors.length],
    );
    const value = document.createElement("span");
    value.className = "value";
    value.textContent = formatSignal(cursorValue(s.id), s);
    const toggle = document.createElement("button");
    toggle.className = "busToggle";
    toggle.textContent =
      s.width > 1 ? (expandedBuses.has(key(s)) ? "▾" : "▸") : "";
    toggle.disabled = s.width <= 1;
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
    row.append(grab, group, name, value);
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
        dragIndex = null;
        request();
      }
    };
    rows.append(row);
  }
  const cursorDetails = `A: ${timeLabel(cursorA)}${cursorB == null ? " · Shift+单击设置 B" : `   B: ${timeLabel(cursorB)}   Δ: ${timeLabel(Math.abs(cursorA - cursorB))}`}`;
  $("cursors").textContent =
    (cursorB == null
      ? `单位: ${displayScale || meta?.scale || "tick"}`
      : `Δ: ${timeLabel(Math.abs(cursorA - cursorB))}`) +
    (cursorA < start || cursorA > end ? " · A 在视窗外" : "");
  $("cursors").classList.toggle("offscreen", cursorA < start || cursorA > end);
  $("cursors").title = cursorDetails;
  $("cursorAInput").value = String(cursorA / displayFactor);
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
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  canvas.style.width = width + "px";
  canvas.style.height = height + "px";
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
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
    ctx.moveTo(px, ROW);
    ctx.lineTo(px, height);
    ctx.stroke();
    ctx.fillText(
      Number((t / displayFactor).toPrecision(6)).toString(),
      px + 4,
      20,
    );
  }
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, timelineHeight, width, Math.max(0, height - timelineHeight));
  ctx.clip();
  const top = $("tracks").scrollTop;
  for (let position = firstRow; position < lastRow; position++) {
    const item = displayRows[position];
    if (item.index === undefined) continue;
    const i = item.index,
      s = chosen[i];
    const y = timelineHeight + ROW * position - top,
      middle = y + 16,
      events = eventsForSignal(s);
    ctx.strokeStyle = theme.grid;
    ctx.beginPath();
    ctx.moveTo(0, y + ROW);
    ctx.lineTo(width, y + ROW);
    ctx.stroke();
    let index = Math.max(0, valueAt(events, start)),
      lastPixel = -2;
    for (; index < events.length; index++) {
      const [t, raw] = events[index];
      const v = WaveSignal.project(raw, s);
      if (Number(t) > end) break;
      const left = Math.max(0, x(t));
      const right = Math.min(
        width,
        x(events[index + 1]?.[0] ?? (data[s.id]?.truncated ? t : end)),
      );
      if (right < 0) continue;
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
        const level = v === "1" ? y + 7 : y + 25;
        ctx.moveTo(left, y + 7);
        ctx.lineTo(left, y + 25);
        ctx.moveTo(left, level);
        ctx.lineTo(right, level);
      } else {
        const bevel = Math.min(4, (right - left) / 2);
        ctx.moveTo(left, middle);
        ctx.lineTo(left + bevel, y + 7);
        ctx.lineTo(right - bevel, y + 7);
        ctx.lineTo(right, middle);
        ctx.lineTo(right - bevel, y + 25);
        ctx.lineTo(left + bevel, y + 25);
        ctx.closePath();
      }
      ctx.stroke();
      if (s.width > 1 && right - left > 28) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(left + 5, y, right - left - 10, ROW);
        ctx.clip();
        ctx.fillText(formatSignal(raw, s), left + 8, y + 20);
        ctx.restore();
      }
    }
    if (data[s.id]?.truncated) {
      const last = Number(data[s.id]?.events.at(-1)?.[0] ?? start);
      ctx.save();
      ctx.globalAlpha = 0.18;
      ctx.fillStyle = theme.warning;
      ctx.fillRect(Math.max(0, x(last)), y, width - Math.max(0, x(last)), ROW);
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
function action(name) {
  if (["openWaveform", "runScript"].includes(name)) {
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
  else if (name === "attachKdb") vscode.postMessage({ type: "attachKdb" });
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
        e.deltaMode === 1 ? ROW : e.deltaMode === 2 ? viewportHeight : 1,
      delta = e.deltaY * factor,
      dx = e.deltaX * factor;
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      zoom(
        e.deltaY > 0 ? 1.4 : 1 / 1.4,
        (e.clientX - canvas.getBoundingClientRect().left) / canvas.clientWidth,
      );
    } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      e.preventDefault();
      const shift =
        ((end - start) * (dx || delta)) / Math.max(1, canvas.clientWidth);
      setWindow(start + shift, end + shift);
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
new ResizeObserver(() => renderCatalog()).observe($("tree"));
window.addEventListener("message", async (e) => {
  const msg = e.data;
  if (msg.type === "metadata") {
    meta = msg;
    $("file").textContent = msg.title;
    $("backend").textContent = `${msg.backend} · Vide ${msg.vide || "未安装"}`;
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
    renderTree();
    request();
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
  } else if (msg.type === "virtualCreated") {
    virtualDefinitions = msg.definitions;
    add(msg.signal);
  } else if (msg.type === "sidebarAdd") {
    await uiAction("addSignals", { signals: msg.signals });
  } else if (msg.type === "scopeSelected") {
    window.waveWorkflow?.scope(msg.scope);
  } else if (msg.type === "commandLog") {
    appendLog(msg.text);
  } else if (msg.type === "kdbAttached") {
    $("kdbState").textContent = `已接入 · ${msg.path}`;
  } else if (msg.type === "kdbHierarchy") {
    kdbScope = msg.scope;
    kdbRows = msg.children;
    $("kdbTree").scrollTop = 0;
    $("kdbState").textContent =
      (kdbScope || "KDB 顶层实例") +
      (msg.children.length >= 1500 ? " · 仅显示前 1500 个子项" : "");
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
    window.waveWorkflow?.scope(saved.scope || chosen[active]?.scope || "");
    request();
    $("tracks").scrollTop = saved.scrollTop || 0;
    scheduleViewport();
  } else if (msg.type === "data") {
    if (cursorFlight && msg.request === cursorFlight.request) {
      const flight = cursorFlight;
      cursorFlight = null;
      if (flight.time === cursorA) {
        const required = new Set(neededIds);
        for (const [id, block] of Object.entries(msg.result as QueryResult))
          if (required.has(id))
            cursorValues[id] = {
              time: cursorA,
              value: block.events[valueAt(block.events, cursorA)]?.[1],
            };
      }
      render();
      return;
    }
    if (!inflight || msg.request !== inflight.request) return;
    if (inflight.window === `${start}:${end}`) {
      const required = new Set(neededIds);
      for (const [id, block] of Object.entries(msg.result as QueryResult))
        if (required.has(id)) data[id] = block;
    }
    inflight = null;
    render();
  } else if (msg.type === "error") {
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
  return inflight || neededIds.some((id) => !Object.hasOwn(data, id))
    ? new Promise((resolve, reject) => dataWaiters.push({ resolve, reject }))
    : Promise.resolve();
}
function appendLog(text) {
  const log = $("commandLog");
  log.textContent = (log.textContent + "\n" + text).slice(-20000);
  log.scrollTop = log.scrollHeight;
}
function snapshot() {
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
    displayScale,
    displayFactor,
  };
}
async function uiAction(name, p) {
  if (name === "snapshot") return snapshot();
  if (name === "restoreView") {
    virtualDefinitions = p.virtualDefinitions || [];
    chosen = p.chosen;
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
    active = 0;
    selectedKeys.clear();
    setWindow(p.start, p.end);
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
    for (const signal of p.signals) {
      if (!keys.has(key(signal))) {
        if (!signal.group && activeGroup) signal.group = activeGroup;
        next.push(signal);
        keys.add(key(signal));
      }
    }
    if (next.length > MAX_SIGNALS)
      throw new Error("已达到 100000 个已添加信号的会话上限");
    chosen = next;
    active = Math.max(0, chosen.length - 1);
    selectedKeys = new Set(chosen[active] ? [key(chosen[active])] : []);
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
    ensureActive();
    return keys.size;
  }
  if (name === "cursor") {
    cursorA = p.time;
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

/* global meta, $, vscode, chosen, key, ROW, active, start, end, cursorA, cursorB, displayFactor, selectedKeys, collapsedGroups, selectedSignals, uiAction, action, source, persist, render, setWindow, add */
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
    panel.style.left = Math.max(4, Math.min(box.left, innerWidth - 240)) + "px";
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
  bar.append(addButton, sourceButton);
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
  pane.addEventListener("scroll", () => requestAnimationFrame(scopeRows), {
    passive: true,
  });
  new ResizeObserver(() => requestAnimationFrame(scopeRows)).observe(pane);
  window.addEventListener("message", (e) => {
    const m = e.data;
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
      [
        "移除分组（保留信号）",
        () => {
          for (const s of chosen) if (s.group === name) s.group = undefined;
          groupOrder = groupOrder.filter((g) => g !== name);
          collapsedGroups.delete(name);
          if (activeGroup === name) activeGroup = "";
          requestRows();
        },
      ],
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
      const value = Number($(id).value.replace(/[,_]/g, "")) * displayFactor;
      if (
        !Number.isSafeInteger(value) ||
        value < Number(meta.start) ||
        value > Number(meta.end)
      ) {
        render();
        return;
      }
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
    if (!pointer || pointer.button !== 0 || pointer.shift) return;
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
    } else if (Math.abs(dx) > 5) {
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
  function hoverHit(e) {
    if (!meta || e.buttons || pointer || draggingMarker) return null;
    const rect = canvas.getBoundingClientRect(),
      y = e.clientY - rect.top;
    if (y < timelineHeight || y >= canvas.clientHeight) return null;
    const position = Math.floor(
        (y - timelineHeight + $("tracks").scrollTop) / ROW,
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
      rowY: timelineHeight + position * ROW - $("tracks").scrollTop,
      window: start + ":" + end,
    };
  }
  function hoverBlock(hit) {
    const block = data[hit.signal.id];
    if (
      block &&
      (!block.truncated || hit.time < Number(block.events.at(-1)?.[0]))
    ) {
      return { raw: block.events[valueAt(block.events, hit.time)]?.[1] };
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
      for (const [name, value] of [
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
    if (data[signal.id]?.truncated) {
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
    hoverBand.style.top = hit.rowY + "px";
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
    if (m.type === "metadata") {
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
    groupMenu,
  };
  groupsChanged();
})();
