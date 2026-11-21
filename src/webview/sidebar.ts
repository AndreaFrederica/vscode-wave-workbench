// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { localize } from "../shared/localization";
import { getElement as $ } from "./dom";
import { renderTags, tagColor } from "./tags";
import { baseKey, label as signalLabel } from "../shared/signals";
import type { Location, Signal, TagState } from "../shared/protocol";
export {};
/* global acquireVsCodeApi */
const vscode = acquireVsCodeApi<{
  draft?: string;
  showTreeSignals?: boolean;
}>();
const saved = vscode.getState() || {};
$("input").value = saved.draft || "";
let pending = false,
  running = false,
  instanceNodes: Location[] = [],
  lastReveal = "";
let lastError = "";
let tagState: TagState = { taggedSignals: [], tagColors: {}, tagStyle: "pill" };
let taggedLimit = 50;
const searchInput = $("sidebarSearch");
const searchRows = $("sidebarSearchRows");
const searchStatus = $("sidebarSearchStatus");
const searchPrev = $("sidebarSearchPrev");
const searchNext = $("sidebarSearchNext");
let searchRequest = 0,
  searchOffset = 0,
  searchTimer = 0;
let searchSession = "";
function searchSignals(offset = 0, delay = 0) {
  clearTimeout(searchTimer);
  const request = ++searchRequest;
  const query = searchInput.value.trim();
  searchRows.replaceChildren();
  searchPrev.disabled = searchNext.disabled = true;
  const visible = !!query && !searchInput.disabled;
  $("sidebarSearchResults").hidden = !visible;
  if (!visible) return;
  searchStatus.textContent = localize("正在搜索…");
  searchTimer = window.setTimeout(() => {
    vscode.postMessage({ type: "signalSearch", request, query, offset });
  }, delay);
}
searchInput.oninput = () => searchSignals(0, 140);
searchInput.onkeydown = (event) => {
  if (event.key === "Enter") {
    const first = searchRows.querySelector<HTMLButtonElement>("button:enabled");
    if (first) first.click();
    else searchSignals();
  }
};
searchPrev.onclick = () => searchSignals(Math.max(0, searchOffset - 32));
searchNext.onclick = () => searchSignals(searchOffset + 32);
const menus = [
  ...document.querySelectorAll<HTMLDetailsElement>(".sidebarMenu details"),
];
for (const menu of menus) {
  menu.querySelector("summary").onclick = () => {
    for (const other of menus) if (other !== menu) other.open = false;
  };
  menu.addEventListener("click", (event) => {
    if ((event.target as HTMLElement).closest("button")) menu.open = false;
  });
}
document.addEventListener("pointerdown", (event) => {
  if (!(event.target as HTMLElement).closest(".sidebarMenu"))
    for (const menu of menus) menu.open = false;
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  const menu = menus.find((item) => item.open);
  if (menu) {
    menu.open = false;
    menu.querySelector("summary").focus();
  }
});
const instanceTags = new Map<string, Set<string>>();
const descendantTags = new Map<string, Set<string>>();
const scopeSignalTags = new Map<string, Set<string>>();
function applyTagState(state: TagState | undefined, session: string) {
  tagState = state || { taggedSignals: [], tagColors: {}, tagStyle: "pill" };
  if (session !== signalSession) taggedLimit = 50;
  instanceTags.clear();
  descendantTags.clear();
  scopeSignalTags.clear();
  const all = new Set<string>();
  const addTags = (
    index: Map<string, Set<string>>,
    key: string,
    tags: string[],
  ) => {
    const stored = index.get(key) || new Set<string>();
    for (const tag of tags) stored.add(tag);
    index.set(key, stored);
  };
  for (const signal of tagState.taggedSignals) {
    for (const tag of signal.tags) all.add(tag);
    addTags(scopeSignalTags, baseKey(signal), signal.tags);
    addTags(instanceTags, signal.instanceScope, signal.tags);
    for (let scope = signal.instanceScope; scope; ) {
      addTags(descendantTags, scope, signal.tags);
      const dot = scope.lastIndexOf(".");
      scope = dot < 0 ? "" : scope.slice(0, dot);
    }
  }
  const filter = $("tagFilter");
  const old = filter.value;
  const options = document.createDocumentFragment();
  options.append(new Option(localize("所有标签"), ""));
  for (const tag of [...all].sort((a, b) => a.localeCompare(b))) {
    options.append(new Option(tag, tag));
  }
  filter.replaceChildren(options);
  filter.value = all.has(old) ? old : "";
  $("sidebarTagStyle").value = tagState.tagStyle;
  renderTaggedSignals();
}
function renderTaggedSignals() {
  const filter = $("tagFilter").value;
  const color = $("tagColor");
  color.disabled = !filter;
  if (filter) color.value = tagColor(filter, tagState.tagColors);
  const tagged = filter
    ? tagState.taggedSignals.filter((signal) => signal.tags.includes(filter))
    : tagState.taggedSignals;
  $("taggedCount").textContent = tagged.length ? String(tagged.length) : "";
  const list = $("taggedRows");
  list.replaceChildren();
  for (const signal of tagged.slice(0, taggedLimit)) {
    const row = document.createElement("button");
    row.className = "taggedSignal";
    row.type = "button";
    row.title = signal.scope + "." + signalLabel(signal);
    row.onclick = () => vscode.postMessage({ type: "taggedFocus", signal });
    const label = document.createElement("span");
    label.className = "taggedSignalName";
    label.textContent = signalLabel(signal);
    const scope = document.createElement("span");
    scope.className = "taggedSignalScope";
    scope.textContent = signal.instanceScope;
    row.append(
      label,
      scope,
      renderTags(signal.tags, tagState.tagColors, tagState.tagStyle),
    );
    list.append(row);
  }
  if (!tagged.length) {
    const empty = document.createElement("div");
    empty.className = "taggedEmpty";
    empty.textContent = localize("当前波形没有已打标签的信号");
    list.append(empty);
  }
  $("taggedMore").hidden = tagged.length <= taggedLimit;
}
$("tagFilter").onchange = () => {
  taggedLimit = 50;
  renderTaggedSignals();
};
$("taggedMore").onclick = () => {
  taggedLimit += 50;
  renderTaggedSignals();
};
$("tagColor").onchange = () =>
  vscode.postMessage({
    type: "tagAppearance",
    tag: $("tagFilter").value,
    color: $("tagColor").value,
  });
$("sidebarTagStyle").onchange = () =>
  vscode.postMessage({
    type: "tagAppearance",
    style: $("sidebarTagStyle").value,
  });
function objectIcon(kind) {
  const types = {
      npiModule: "module",
      npiModuleArray: "module",
      npiProgram: "module",
      npiInterface: "interface",
      npiInterfaceArray: "interface",
      npiGenScope: "generate",
      npiPackage: "package",
      npiFunction: "function",
      npiTask: "task",
    },
    type = types[kind] || "scope";
  const paths = {
    module: "M7 3h10v4H7z M4 7h16v14H4z M8 11h8 M8 15h5",
    interface: "M8 7l4-4 4 4v10l-4 4-4-4z M3 9h5 M16 9h5 M3 15h5 M16 15h5",
    generate: "M8 5H4v14h4 M16 5h4v14h-4 M9 9l3 3-3 3 M15 9v6",
    package: "M12 3l9 5-9 5-9-5z M3 8v9l9 5 9-5V8 M12 13v9 M7.5 5.5l9 5",
    function: "M7 6h10 M7 12h7 M7 18h10 M4 6h.01 M4 12h.01 M4 18h.01",
    task: "M9 5h11 M9 12h11 M9 19h11 M3 5l1 1 2-3 M3 12l1 1 2-3 M3 19l1 1 2-3",
    scope: "M4 5h6l2 3h8v12H4z",
  };
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.classList.add("objectIcon", type);
  icon.setAttribute("role", "img");
  icon.setAttribute("aria-label", kind);
  const title = document.createElementNS(icon.namespaceURI, "title");
  title.textContent =
    {
      npiModule: localize("模块实例"),
      npiModuleArray: localize("模块数组"),
      npiInterface: localize("接口"),
      npiInterfaceArray: localize("接口数组"),
      npiGenScope: localize("Generate 层级"),
      npiPackage: "Package",
      npiFunction: localize("函数"),
      npiTask: localize("任务"),
    }[kind] || localize("作用域");
  const shape = document.createElementNS(icon.namespaceURI, "path");
  shape.setAttribute("d", paths[type]);
  icon.append(title, shape);
  return icon;
}
$("showOtherObjects").onchange = () =>
  vscode.postMessage({
    type: "tree",
    action: "mode",
    scope: $("showOtherObjects").checked ? "all" : "design",
  });
type InstanceRow =
  | { kind: "instance"; node: Location }
  | { kind: "signal"; node: Location; signal: Signal }
  | { kind: "more"; node: Location };
type InstanceSignals = {
  signals: Signal[];
  total?: number;
  loading?: boolean;
  error?: boolean;
};
const instanceSignals = new Map<string, InstanceSignals>();
const showTreeSignals = $("showTreeSignals");
let instanceRows: InstanceRow[] = [];
let instanceSession = "";
let instanceRevision = 0;
showTreeSignals.checked = !!saved.showTreeSignals;
function saveSidebarState() {
  vscode.setState({
    draft: $("input").value,
    showTreeSignals: showTreeSignals.checked,
  });
}
showTreeSignals.onchange = () => {
  saveSidebarState();
  rebuildInstanceRows();
  renderInstances();
};
function rebuildInstanceRows() {
  instanceRows = [];
  for (const node of instanceNodes) {
    instanceRows.push({ kind: "instance", node });
    if (!showTreeSignals.checked || !node.expanded) continue;
    const page = instanceSignals.get(node.fullname);
    for (const signal of page?.signals || []) {
      instanceRows.push({ kind: "signal", node, signal });
    }
    if (page?.total === undefined || page.signals.length < page.total)
      instanceRows.push({ kind: "more", node });
  }
  $("instanceSpace").style.height =
    Math.max(26, instanceRows.length * 26) + "px";
}
function requestInstanceSignals(scope: string) {
  const page = instanceSignals.get(scope) || { signals: [] };
  if (page.loading) return;
  page.loading = true;
  page.error = false;
  instanceSignals.set(scope, page);
  vscode.postMessage({
    type: "instanceSignals",
    scope,
    request: instanceRevision,
    offset: page.signals.length,
    limit: 64,
  });
}
function renderInstanceSignal(
  row: HTMLElement,
  item: Exclude<InstanceRow, { kind: "instance" }>,
) {
  const scope = item.node.fullname;
  row.style.paddingInlineStart = ((item.node.depth || 0) + 1) * 16 + "px";
  const name = document.createElement("button");
  name.className = "instanceName";
  if (item.kind === "more") {
    row.classList.add("treeSignalMore");
    const page = instanceSignals.get(scope);
    if (!page) requestInstanceSignals(scope);
    name.disabled = !page || !!page.loading;
    name.textContent = page?.error
      ? localize("重试读取信号")
      : name.disabled
        ? localize("读取信号…")
        : localize("显示更多信号");
    name.onclick = () => {
      requestInstanceSignals(scope);
      renderInstances();
    };
    row.append(name);
    return;
  }
  const signal = item.signal;
  row.classList.add("treeSignal");
  const icon = document.createElement("span");
  icon.className = "treeSignalIcon";
  icon.textContent = "∿";
  icon.setAttribute("aria-hidden", "true");
  name.textContent = signal.name;
  name.title = signal.scope + "." + signal.name;
  name.disabled = !signal.supported;
  name.ondblclick = () => addScopeSignals([signal]);
  row.append(icon, name);
  const tags = scopeSignalTags.get(baseKey(signal));
  if (tags?.size)
    row.append(renderTags([...tags], tagState.tagColors, tagState.tagStyle));
  const edit = document.createElement("button");
  edit.className = "treeSignalEdit";
  edit.textContent = "✎";
  edit.title = localize("编辑 ") + signal.name + localize(" 的标签和注释");
  edit.setAttribute("aria-label", edit.title);
  edit.disabled = !signal.supported;
  edit.onclick = () => addScopeSignals([signal], true);
  row.append(edit);
}
function renderInstances() {
  const box = $("instanceTree"),
    height = box.clientHeight,
    top = box.scrollTop;
  const rows = $("instanceRows");
  rows.style.top = top + "px";
  rows.style.height = height + "px";
  rows.replaceChildren();
  for (
    let i = Math.max(0, Math.floor(top / 26) - 4);
    i < Math.min(instanceRows.length, Math.ceil((top + height) / 26) + 4);
    i++
  ) {
    const item = instanceRows[i];
    const row = document.createElement("div");
    row.style.top = i * 26 - top + "px";
    if (item.kind !== "instance") {
      row.className = "instanceRow";
      renderInstanceSignal(row, item);
      rows.append(row);
      continue;
    }
    const n = item.node;
    row.className = "instanceRow" + (n.selected ? " selected" : "");
    row.style.paddingInlineStart = n.depth * 16 + "px";
    const expand = document.createElement("button");
    expand.className = "expand";
    expand.textContent = n.expanded ? "▾" : "▸";
    expand.title = localize("展开/折叠 ") + n.fullname;
    expand.onclick = () =>
      vscode.postMessage({ type: "tree", action: "expand", scope: n.fullname });
    const name = document.createElement("button");
    name.className = "instanceName";
    name.textContent = n.fullname.split(".").at(-1);
    name.title = n.fullname;
    name.onclick = () =>
      vscode.postMessage({ type: "tree", action: "select", scope: n.fullname });
    const module = document.createElement("span");
    module.className = "moduleName";
    module.textContent =
      n.module ||
      {
        npiGenScope: "generate",
        npiPackage: "package",
        npiFunction: "function",
        npiTask: "task",
      }[n.kind] ||
      n.kind;
    module.title = n.module || n.kind;
    row.append(expand, objectIcon(n.kind), name);
    const tags = (n.expanded ? instanceTags : descendantTags).get(n.fullname);
    if (tags?.size) {
      const badges = renderTags(
        [...tags],
        tagState.tagColors,
        tagState.tagStyle,
        3,
      );
      badges.classList.add("instanceTags");
      row.append(badges);
    }
    row.append(module);
    rows.append(row);
  }
  if (!instanceRows.length)
    rows.textContent = localize("接入设计数据库 后浏览实例，点击实例打开 RTL");
}
$("instanceTree").addEventListener(
  "scroll",
  () => requestAnimationFrame(renderInstances),
  { passive: true },
);
new ResizeObserver(() => requestAnimationFrame(renderInstances)).observe(
  $("instanceTree"),
);
$("instanceTree").addEventListener("mousedown", (e) => {
  if (e.button === 3 || e.button === 4) e.preventDefault();
});
$("instanceTree").addEventListener("mouseup", (e) => {
  if (e.button === 3 || e.button === 4) {
    e.preventDefault();
    vscode.postMessage({
      type: "tree",
      action: e.button === 3 ? "back" : "forward",
      scope: "",
    });
  }
});
function send(script) {
  if (!script.trim() || pending || running) return;
  pending = true;
  updateButton();
  vscode.postMessage({ type: "execute", script });
}
function updateButton() {
  $("execute").disabled = pending || running;
  $("execute").textContent =
    pending || running ? localize("执行中…") : localize("执行 Ctrl+Enter");
}
$("form").onsubmit = (e) => {
  e.preventDefault();
  send($("input").value);
};
$("input").oninput = saveSidebarState;
$("input").onkeydown = (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    send($("input").value);
  }
};
$("clear").onclick = () => vscode.postMessage({ type: "clear" });
$("session").onchange = () =>
  vscode.postMessage({ type: "select", id: $("session").value });
$("history").onchange = () => {
  if ($("history").value) {
    $("input").value = $("history").value;
    saveSidebarState();
    $("input").focus();
  }
};
document
  .querySelectorAll<HTMLButtonElement>("[data-action]")
  .forEach(
    (b) =>
      (b.onclick = () =>
        vscode.postMessage({ type: "action", action: b.dataset.action })),
  );
document
  .querySelectorAll<HTMLButtonElement>("[data-script]")
  .forEach((b) => (b.onclick = () => send(b.dataset.script)));
window.addEventListener("message", (e) => {
  const m = e.data;
  if (m.type === "signalSearch") {
    if (m.request !== searchRequest) return;
    if (!m.result || m.error) {
      searchStatus.textContent = localize("信号搜索失败");
      return;
    }
    const { signals, offset, total } = m.result;
    searchOffset = offset;
    searchStatus.textContent = total
      ? `${offset + 1}–${offset + signals.length} / ${total}`
      : localize("没有匹配信号");
    searchPrev.disabled = offset === 0;
    searchNext.disabled = offset + signals.length >= total;
    searchRows.scrollTop = 0;
    for (const signal of signals as Signal[]) {
      const button = document.createElement("button");
      button.type = "button";
      button.title = [signal.scope, signal.name].filter(Boolean).join(".");
      button.textContent = "+ " + signal.name;
      button.disabled = !signal.supported;
      const scope = document.createElement("small");
      scope.textContent = signal.scope;
      button.append(scope);
      button.onclick = () => addScopeSignals([signal]);
      searchRows.append(button);
    }
    return;
  }
  if (m.type === "instanceSignals") {
    const page = instanceSignals.get(m.scope);
    if (m.request !== instanceRevision || !page?.loading) return;
    page.loading = false;
    page.error = !!m.error;
    if (!m.error) {
      page.signals.push(...m.signals);
      page.total = m.total;
    }
    rebuildInstanceRows();
    renderInstances();
    return;
  }
  if (m.type === "scopePage") {
    if (m.request === signalRevision && m.scope === signalScope) {
      signalFlight = false;
      signalTotal = m.total;
      signalPages.set(Math.floor(m.offset / 512), m.signals);
      while (signalPages.size > 8)
        signalPages.delete(signalPages.keys().next().value);
      renderSignals();
    }
    return;
  }
  if (m.type === "complete") {
    pending = false;
    updateButton();
    return;
  }
  if (m.type !== "state") return;
  const activeSession = m.sessions.find((session) => session.id === m.activeId);
  const nextSession = JSON.stringify([
    m.activeId,
    activeSession?.kdb,
    activeSession?.backend,
  ]);
  searchInput.disabled = !activeSession?.ready;
  const nextSearchSession = JSON.stringify([
    m.activeId,
    activeSession?.backend,
    activeSession?.ready,
  ]);
  if (searchSession !== nextSearchSession) {
    searchSession = nextSearchSession;
    searchSignals();
  }
  applyTagState(m.tagState, nextSession);
  $("showOtherObjects").checked = !!m.includeOther;
  setSignalScope(m.scope || "", nextSession);
  if (m.executing === 0) pending = false;
  if (nextSession !== instanceSession) {
    instanceSession = nextSession;
    instanceRevision++;
    instanceSignals.clear();
  }
  instanceNodes = m.tree || [];
  rebuildInstanceRows();
  if (
    m.revealScope &&
    m.activeId + ":" + m.revealId + ":" + m.revealScope !== lastReveal
  ) {
    const index = instanceRows.findIndex(
      (row) => row.kind === "instance" && row.node.fullname === m.revealScope,
    );
    if (index >= 0) {
      const box = $("instanceTree"),
        top = index * 26;
      if (top < box.scrollTop || top + 26 > box.scrollTop + box.clientHeight)
        box.scrollTop = Math.max(0, top - box.clientHeight / 2);
      lastReveal = m.activeId + ":" + m.revealId + ":" + m.revealScope;
    }
  }
  renderInstances();
  renderSignals();
  $("session").replaceChildren();
  if (!m.sessions.length) {
    const o = document.createElement("option");
    o.textContent = localize("尚未打开波形");
    o.value = "";
    $("session").append(o);
  }
  for (const s of m.sessions) {
    const o = document.createElement("option");
    o.value = s.id;
    o.textContent = s.title;
    o.title = s.id;
    $("session").append(o);
  }
  $("session").value = m.activeId || "";
  const session = m.sessions.find((s) => s.id === m.activeId);
  running = !!session?.running;
  updateButton();
  $("sessionStatus").textContent = session
    ? session.running
      ? localize("执行 Tcl 中…")
      : !session.ready
        ? localize("正在打开波形…")
        : session.kdb
          ? localize("已接入设计数据库")
          : localize("未接入设计数据库")
    : "";
  $("sessionStatus").title = session
    ? [session.id, session.kdb].filter(Boolean).join("\n")
    : "";
  const latest = m.logs.at(-1)?.text || "";
  if (latest.startsWith("ERROR:") && latest !== lastError)
    $("sidebarConsole").open = true;
  lastError = latest;
  $("history").replaceChildren();
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = localize("选择历史指令填入输入框…");
  $("history").append(placeholder);
  for (const script of [...m.history].reverse()) {
    const o = document.createElement("option");
    o.value = script;
    o.textContent = script.slice(0, 100);
    $("history").append(o);
  }
  const output = $("output"),
    follow = output.scrollHeight - output.scrollTop - output.clientHeight < 40;
  output.replaceChildren();
  for (const entry of m.logs) {
    const row = document.createElement("div");
    row.className = "entry" + (entry.text.startsWith("ERROR:") ? " error" : "");
    if (entry.session) {
      const name = document.createElement("span");
      name.className = "session";
      name.textContent = entry.session;
      row.append(name);
    }
    row.append(document.createTextNode(entry.text));
    output.append(row);
  }
  if (follow) output.scrollTop = output.scrollHeight;
});
let signalSession = "",
  signalScope = "",
  signalRevision = 0,
  signalTotal = 0,
  signalFlight = false,
  signalPages = new Map(),
  signalSelection = new Map();
function setSignalScope(scope, session) {
  if (signalScope === scope && signalSession === session) return;
  signalSession = session;
  signalScope = scope;
  signalRevision++;
  signalTotal = 0;
  signalPages.clear();
  signalSelection.clear();
  signalFlight = false;
  $("sidebarSignals").scrollTo(0, 0);
  $("sidebarScope").textContent =
    "Signals · " + (scope || localize("选择实例"));
  $("sidebarScope").title = scope;
  if (scope) requestSignalPage(0);
  renderSignals();
}
function requestSignalPage(page) {
  if (signalFlight) return;
  signalFlight = true;
  vscode.postMessage({
    type: "scopePage",
    scope: signalScope,
    request: signalRevision,
    offset: page * 512,
  });
}
function addScopeSignals(signals: Signal[], editAnnotation = false) {
  if (signals.length)
    vscode.postMessage({
      type: "addSignals",
      editAnnotation,
      signals: signals.map((s) => ({ id: s.id, scope: s.scope, name: s.name })),
    });
}
function renderSignals() {
  const box = $("sidebarSignals"),
    top = box.scrollTop,
    height = box.clientHeight,
    rows = $("signalRows");
  $("signalSpace").style.height = Math.max(24, signalTotal * 24) + "px";
  const first = Math.max(0, Math.floor(top / 24) - 4);
  const last = Math.min(signalTotal, Math.ceil((top + height) / 24) + 4);
  rows.style.top = (signalTotal ? first * 24 : 0) + "px";
  rows.replaceChildren();
  let missing = null;
  for (let i = first; i < last; i++) {
    const s = signalPages.get(Math.floor(i / 512))?.[i % 512],
      b = document.createElement("button");
    b.disabled = !s || !s.supported;
    const label = document.createElement("span");
    label.className = "scopeSignalName";
    label.textContent = s
      ? `${s.name} · ${s.width} bit`
      : localize("读取信号…");
    b.append(label);
    if (s) {
      const tags = scopeSignalTags.get(baseKey(s));
      if (tags?.size)
        b.append(renderTags([...tags], tagState.tagColors, tagState.tagStyle));
      const key = s.scope + "\0" + s.name;
      b.className = signalSelection.has(key) ? "selected" : "";
      b.title = s.scope + "." + s.name;
      b.onclick = (e) => {
        if (!e.ctrlKey && !e.metaKey) signalSelection.clear();
        if (signalSelection.has(key)) signalSelection.delete(key);
        else signalSelection.set(key, s);
        renderSignals();
      };
      b.ondblclick = () => addScopeSignals([s]);
    } else missing ??= Math.floor(i / 512);
    rows.append(b);
  }
  if (missing !== null) requestSignalPage(missing);
  if (!signalTotal && !signalFlight)
    rows.textContent = signalScope
      ? localize("没有已 dump 的直属信号")
      : localize("点击上方实例查看信号");
}
$("addScopeSignals").onclick = () =>
  addScopeSignals([...signalSelection.values()]);
const signalScroll = $("sidebarSignals");
let renderedScrollTop = signalScroll.scrollTop;
signalScroll.addEventListener(
  "scroll",
  () => {
    if (renderedScrollTop === signalScroll.scrollTop) return;
    renderedScrollTop = signalScroll.scrollTop;
    requestAnimationFrame(renderSignals);
  },
  { passive: true },
);
new ResizeObserver(renderSignals).observe(signalScroll);
vscode.postMessage({ type: "ready" });
