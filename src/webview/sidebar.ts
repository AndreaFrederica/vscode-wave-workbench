// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { getElement as $ } from "./dom";
export {};
/* global acquireVsCodeApi */
const vscode = acquireVsCodeApi<{ draft?: string }>();
const saved = vscode.getState() || {};
$("input").value = saved.draft || "";
let pending = false,
  running = false,
  instanceNodes = [],
  lastReveal = "";
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
      npiModule: "模块实例",
      npiModuleArray: "模块数组",
      npiInterface: "接口",
      npiInterfaceArray: "接口数组",
      npiGenScope: "Generate 层级",
      npiPackage: "Package",
      npiFunction: "函数",
      npiTask: "任务",
    }[kind] || "作用域";
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
function renderInstances() {
  const box = $("instanceTree"),
    height = box.clientHeight,
    top = box.scrollTop;
  $("instanceSpace").style.height =
    Math.max(26, instanceNodes.length * 26) + "px";
  const rows = $("instanceRows");
  rows.style.top = top + "px";
  rows.style.height = height + "px";
  rows.replaceChildren();
  for (
    let i = Math.max(0, Math.floor(top / 26) - 4);
    i < Math.min(instanceNodes.length, Math.ceil((top + height) / 26) + 4);
    i++
  ) {
    const n = instanceNodes[i],
      row = document.createElement("div");
    row.className = "instanceRow" + (n.selected ? " selected" : "");
    row.style.top = i * 26 - top + "px";
    row.style.paddingInlineStart = n.depth * 16 + "px";
    const expand = document.createElement("button");
    expand.className = "expand";
    expand.textContent = n.expanded ? "▾" : "▸";
    expand.title = "展开/折叠 " + n.fullname;
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
    row.append(expand, objectIcon(n.kind), name, module);
    rows.append(row);
  }
  if (!instanceNodes.length)
    rows.textContent = "接入 KDB 后浏览实例，点击实例打开 RTL";
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
  $("execute").textContent = pending || running ? "执行中…" : "执行 Ctrl+Enter";
}
$("form").onsubmit = (e) => {
  e.preventDefault();
  send($("input").value);
};
$("input").oninput = () => vscode.setState({ draft: $("input").value });
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
    vscode.setState({ draft: $("input").value });
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
  $("showOtherObjects").checked = !!m.includeOther;
  setSignalScope(m.scope || "", m.activeId || "");
  if (m.executing === 0) pending = false;
  instanceNodes = m.tree || [];
  $("instanceSpace").style.height =
    Math.max(26, instanceNodes.length * 26) + "px";
  if (
    m.revealScope &&
    m.activeId + ":" + m.revealId + ":" + m.revealScope !== lastReveal
  ) {
    const index = instanceNodes.findIndex((n) => n.fullname === m.revealScope);
    if (index >= 0) {
      const box = $("instanceTree"),
        top = index * 26;
      if (top < box.scrollTop || top + 26 > box.scrollTop + box.clientHeight)
        box.scrollTop = Math.max(0, top - box.clientHeight / 2);
      lastReveal = m.activeId + ":" + m.revealId + ":" + m.revealScope;
    }
  }
  renderInstances();
  $("session").replaceChildren();
  if (!m.sessions.length) {
    const o = document.createElement("option");
    o.textContent = "尚未打开波形";
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
    ? `${session.running ? "执行中 · " : ""}${session.ready ? "已加载" : "加载中"} · KDB ${session.kdb || "未接入"}\n${session.id}`
    : "先打开 FSDB / VCD，再输入 nWave 命令。waveHelp 可直接查看帮助。";
  $("history").replaceChildren();
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "选择历史指令填入输入框…";
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
  $("sidebarSignals").scrollTop = 0;
  $("sidebarScope").textContent = "Signals · " + (scope || "选择实例");
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
function addScopeSignals(signals) {
  if (signals.length)
    vscode.postMessage({
      type: "addSignals",
      signals: signals.map((s) => ({ id: s.id, scope: s.scope, name: s.name })),
    });
}
function renderSignals() {
  const box = $("sidebarSignals"),
    top = box.scrollTop,
    height = box.clientHeight,
    rows = $("signalRows");
  $("signalSpace").style.height = Math.max(24, signalTotal * 24) + "px";
  rows.style.top = top + "px";
  rows.style.height = height + "px";
  rows.replaceChildren();
  let missing = null;
  for (
    let i = Math.max(0, Math.floor(top / 24) - 4);
    i < Math.min(signalTotal, Math.ceil((top + height) / 24) + 4);
    i++
  ) {
    const s = signalPages.get(Math.floor(i / 512))?.[i % 512],
      b = document.createElement("button");
    b.style.top = i * 24 - top + "px";
    b.disabled = !s || !s.supported;
    b.textContent = s ? `${s.name} · ${s.width} bit` : "读取信号…";
    if (s) {
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
      ? "没有已 dump 的直属信号"
      : "点击上方实例查看信号";
}
$("addScopeSignals").onclick = () =>
  addScopeSignals([...signalSelection.values()]);
$("sidebarSignals").addEventListener(
  "scroll",
  () => requestAnimationFrame(renderSignals),
  { passive: true },
);
new ResizeObserver(renderSignals).observe($("sidebarSignals"));
vscode.postMessage({ type: "ready" });
