// SPDX-License-Identifier: MPL-2.0

import { localize } from "../shared/localization";
import {
  measurementAcceptsSignal,
  type Measurement,
} from "../shared/measurements";
import type { Metadata, Signal } from "../shared/protocol";
import { key, label } from "../shared/signals";
import { getElement as $ } from "./dom";

type Reading = [string, string];
type Reply = { request: number; rows?: Reading[]; error?: string };
interface Card {
  operation: Measurement;
  signals: Signal[];
  revision: number;
  source: HTMLElement;
  element: HTMLElement;
  status: HTMLElement;
  rows: HTMLTableSectionElement;
  measured?: string;
  pending?: string;
}
interface Bounds {
  start: string;
  end: string;
  reverse: boolean;
}

interface View {
  meta: Metadata | null;
  start: number;
  end: number;
  cursorA: number;
  cursorB: number | null;
}

export function measurementPanel(
  view: () => View,
  send: (message: unknown) => void,
  action: (name: string) => void,
  channels: () => Signal[],
) {
  const panel = $("measurementPanel");
  const list = $("measurementCards");
  const toggle = $("toggleMeasurements");
  const gate = $("measurementGate");
  const cards = new Map<string, Card>();
  const waiting = new Map<Card, { bounds: Bounds; signature: string }>();
  let request = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let flight: { card: Card; request: number; signature: string } | undefined;

  const bindingKey = (operation: Measurement, signals: Signal[]) =>
    JSON.stringify([operation, ...signals.map(key)]);
  const readingKey = (card: Card, bounds?: Bounds) =>
    JSON.stringify([card.revision, bounds ?? null]);
  function range(card: Card): Bounds | undefined {
    const { meta, start, end, cursorA, cursorB } = view();
    if (!meta) return;
    if (card.operation === "cursors" || gate.value === "auto") {
      if (cursorB !== null && cursorA !== cursorB)
        return {
          start: String(Math.min(cursorA, cursorB)),
          end: String(Math.max(cursorA, cursorB)),
          reverse: card.operation === "cursors" && cursorA > cursorB,
        };
      if (card.operation === "cursors") return;
    }
    return {
      start: gate.value === "full" ? meta.start : String(start),
      end: gate.value === "full" ? meta.end : String(end),
      reverse: false,
    };
  }

  function dispatch() {
    if (panel.hidden || list.hidden || flight || timer !== undefined) return;
    const [first] = waiting;
    if (!first) return;
    const [card, { bounds, signature }] = first;
    waiting.delete(card);
    flight = { card, signature, request: ++request };
    send({
      type: "measureWave",
      request,
      operation: card.operation,
      signals: card.signals.map(({ id, name, scope, bitOffset, unit }) => ({
        id,
        name,
        scope,
        bitOffset,
        unit,
      })),
      ...bounds,
    });
  }

  function refresh() {
    if (panel.hidden || list.hidden) return;
    let changed = false;
    for (const card of cards.values()) {
      const bounds = range(card);
      const signature = readingKey(card, bounds);
      if (card.measured === signature || card.pending === signature) continue;
      card.measured = undefined;
      card.pending = signature;
      card.rows.replaceChildren();
      card.status.textContent = bounds
        ? localize("正在测量…")
        : localize("请设置两个不同位置的 A/B 游标。");
      if (bounds) {
        waiting.set(card, { bounds, signature });
        changed = true;
      } else {
        waiting.delete(card);
        card.measured = signature;
      }
    }
    if (changed) {
      clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        dispatch();
      }, 130);
    } else {
      dispatch();
    }
  }

  function expand(open: boolean) {
    list.hidden = !open;
    toggle.textContent = open ? localize("收起") : localize("展开");
    toggle.setAttribute("aria-expanded", String(open));
    refresh();
  }

  toggle.onclick = () => expand(list.hidden);
  gate.onchange = refresh;
  $("clearMeasurements").onclick = () => {
    waiting.clear();
    cards.clear();
    list.replaceChildren();
    panel.hidden = true;
    document.querySelector<HTMLElement>("#measurementMenu > summary")?.focus();
  };

  const layout = $("measurementLayout");
  const move = $("moveMeasurements");
  const viewer = $("viewer");
  const add = $("addMeasurement");
  for (const item of document.querySelectorAll<HTMLButtonElement>(
    "#measurementMenu [data-action]",
  ))
    add.add(new Option(item.textContent, item.dataset.action));
  add.onchange = () => {
    const name = add.value;
    add.value = "";
    if (name) action(name);
  };

  let position: { x: number; y: number } | undefined;
  let drag: { x: number; y: number } | undefined;
  function place(x: number, y: number) {
    const clamp = (value: number, max: number) =>
      Math.max(0, Math.min(value, max));
    position = {
      x: clamp(x, viewer.clientWidth - panel.offsetWidth),
      y: clamp(y, viewer.clientHeight - panel.offsetHeight),
    };
    panel.dataset.moved = "";
    panel.style.setProperty("--measurement-x", position.x + "px");
    panel.style.setProperty("--measurement-y", position.y + "px");
  }
  function origin() {
    const area = viewer.getBoundingClientRect();
    const rect = panel.getBoundingClientRect();
    return { x: rect.left - area.left, y: rect.top - area.top };
  }
  layout.onchange = () => {
    const floating = layout.value === "floating";
    panel.dataset.layout = layout.value;
    move.hidden = !floating;
    if (floating && position) place(position.x, position.y);
  };
  move.onpointerdown = (event) => {
    if (event.button !== 0) return;
    const { x, y } = origin();
    drag = { x: event.clientX - x, y: event.clientY - y };
    move.setPointerCapture(event.pointerId);
  };
  move.onpointermove = (event) => {
    if (!drag || !move.hasPointerCapture(event.pointerId)) return;
    place(event.clientX - drag.x, event.clientY - drag.y);
  };
  move.onlostpointercapture = () => {
    drag = undefined;
  };
  move.onkeydown = (event) => {
    const step = event.shiftKey ? 48 : 12;
    const offset = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    }[event.key];
    if (!offset) return;
    event.preventDefault();
    event.stopPropagation();
    const { x, y } = origin();
    place(x + offset[0], y + offset[1]);
  };
  const observer = new ResizeObserver(() => {
    if (!panel.hidden && layout.value === "floating" && position)
      place(position.x, position.y);
  });
  observer.observe(viewer);
  observer.observe(panel);

  const sourceDialog = $("measurementSourceDialog");
  const sourceSearch = $("measurementSourceSearch");
  const sourceOptions = $("measurementSourceOptions");
  const sourceStatus = $("measurementSourceStatus");
  const bind = $("applyMeasurementSource");
  let editor: { card: Card; index: number } | undefined;
  let candidates: Signal[] = [];

  function role(operation: Measurement, index: number) {
    return operation === "delay"
      ? [localize("源 / 数据"), localize("目标 / 时钟")][index]
      : localize("通道");
  }

  function path(signal: Signal) {
    return signal.scope + "/" + label({ ...signal, displayName: undefined });
  }

  function showSources(card: Card) {
    card.source.replaceChildren(
      ...card.signals.map((signal, index) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "measurement-source-button";
        const kind = role(card.operation, index);
        const name = label(signal);
        button.title = path(signal);
        button.setAttribute(
          "aria-label",
          localize("更换") + kind + " · " + name,
        );
        button.setAttribute("aria-haspopup", "dialog");
        const prefix = document.createElement("span");
        prefix.className = "measurement-source-role";
        prefix.textContent = kind;
        const text = document.createElement("span");
        text.className = "measurement-source-name";
        text.textContent = name;
        button.append(prefix, text);
        button.onclick = () => {
          editor = { card, index };
          $("measurementSourceTitle").textContent = localize("更换") + kind;
          sourceSearch.value = "";
          renderOptions();
          sourceDialog.showModal();
        };
        return button;
      }),
    );
  }

  function renderOptions() {
    if (!editor) return;
    const { card, index } = editor;
    const current = key(card.signals[index]);
    const query = sourceSearch.value.trim().toLocaleLowerCase();
    const options: HTMLOptionElement[] = [];
    candidates = [];
    let hasMore = false;
    for (const signal of channels()) {
      if (!measurementAcceptsSignal(card.operation, signal)) continue;
      const fullPath = path(signal);
      const name = label(signal);
      const description = signal.displayName
        ? name + " · " + fullPath
        : fullPath;
      if (query && !description.toLocaleLowerCase().includes(query)) continue;
      if (options.length === 100) {
        hasMore = true;
        break;
      }
      const value = String(candidates.length);
      const selected = key(signal) === current;
      candidates.push(signal);
      options.push(new Option(description, value, selected, selected));
    }
    sourceOptions.replaceChildren(...options);
    bind.disabled = !sourceOptions.value;
    sourceStatus.textContent = hasMore
      ? localize("显示前 100 条匹配通道，可继续输入筛选。")
      : options.length
        ? ""
        : localize("没有匹配的波形通道。");
  }

  sourceSearch.oninput = renderOptions;
  sourceOptions.onchange = () => {
    bind.disabled = !sourceOptions.value;
    sourceStatus.textContent = "";
  };
  $("cancelMeasurementSource").onclick = () => sourceDialog.close();
  sourceDialog.onclose = () => {
    const context = editor;
    editor = undefined;
    candidates = [];
    if (context)
      context.card.source.querySelectorAll("button")[context.index]?.focus();
  };
  $("measurementSourceForm").onsubmit = (event) => {
    event.preventDefault();
    const selected =
      sourceOptions.value && candidates[Number(sourceOptions.value)];
    if (!editor || !selected) return;
    const { card, index } = editor;
    const previous = bindingKey(card.operation, card.signals);
    if (cards.get(previous) !== card) {
      sourceDialog.close();
      return;
    }
    const signals = [...card.signals];
    const other = signals.findIndex((signal) => key(signal) === key(selected));
    if (other !== -1) signals[other] = signals[index];
    signals[index] = selected;
    const next = bindingKey(card.operation, signals);
    if (next !== previous) {
      if (cards.has(next)) {
        sourceStatus.textContent = localize("这组通道已用于同一测量。");
        return;
      }
      cards.delete(previous);
      cards.set(next, card);
      card.signals = signals;
      card.revision++;
      showSources(card);
      refresh();
    }
    sourceDialog.close();
  };

  function addCard(operation: Measurement, title: string, selected: Signal[]) {
    const identity = bindingKey(operation, selected);
    let card = cards.get(identity);
    if (!card) {
      const element = document.createElement("section");
      element.className = "measurement-card";
      element.setAttribute("aria-label", title);
      element.tabIndex = 0;
      const header = document.createElement("div");
      header.className = "measurement-card-heading";
      const titleRow = document.createElement("div");
      titleRow.className = "measurement-card-title";
      const heading = document.createElement("strong");
      heading.textContent = title;
      const remove = document.createElement("button");
      remove.className = "measurement-remove";
      remove.textContent = "×";
      remove.setAttribute("aria-label", localize("移除此项测量"));
      remove.onclick = () => {
        cards.delete(bindingKey(card.operation, card.signals));
        waiting.delete(card);
        element.remove();
        panel.hidden = !cards.size;
        if (panel.hidden)
          document
            .querySelector<HTMLElement>("#measurementMenu > summary")
            ?.focus();
        else toggle.focus();
      };
      titleRow.append(heading, remove);
      const source = document.createElement("div");
      source.className = "measurement-card-source";
      if (operation === "delay") source.dataset.pair = "";
      header.append(titleRow, source);
      const status = document.createElement("p");
      status.className = "measurement-card-status";
      status.setAttribute("role", "status");
      const table = document.createElement("table");
      const rows = table.createTBody();
      element.append(header, status, table);
      card = {
        operation,
        signals: selected,
        revision: 0,
        source,
        element,
        status,
        rows,
      };
      showSources(card);
      cards.set(identity, card);
      list.append(element);
    }
    return card;
  }

  return {
    refresh,
    add(operation: Measurement, title: string, selected: Signal[]) {
      const frequency = view().meta?.axis === "frequency";
      if (frequency && operation !== "peaks" && operation !== "cursors")
        return localize("频谱支持 A/B 游标读数和频谱峰值测量。");
      if (!frequency && operation === "peaks")
        return localize("请先打开 FFT 频谱并选择幅值行。");
      let sources: Signal[][];
      if (operation === "delay") {
        if (
          selected.length !== 2 ||
          selected.some(
            (signal) => !measurementAcceptsSignal(operation, signal),
          )
        )
          return localize("请选择两路实数信号、单比特信号或总线位。");
        sources = [selected];
      } else if (operation === "cursors") {
        sources = [];
        for (let first = 0; first < selected.length; first += 8)
          sources.push(selected.slice(first, first + 8));
      } else {
        const eligible = selected.filter((signal) =>
          measurementAcceptsSignal(operation, signal),
        );
        if (!eligible.length)
          return operation === "pulse" || operation === "timing"
            ? localize("请选择实数信号、单比特数字信号或总线位。")
            : localize("请选择实数信号。");
        sources = eligible.map((signal) => [signal]);
      }

      const added = sources.map((source) => addCard(operation, title, source));
      panel.hidden = false;
      expand(true);
      const first = added[0].element;
      if (
        first.offsetLeft < list.scrollLeft ||
        first.offsetLeft + first.offsetWidth >
          list.scrollLeft + list.clientWidth
      )
        list.scrollLeft = first.offsetLeft;
      const skipped =
        operation === "delay" || operation === "cursors"
          ? 0
          : selected.length - added.length;
      if (skipped)
        return (
          localize("已添加匹配的通道，跳过 ") +
          skipped +
          localize(" 条类型不匹配的信号。")
        );
    },
    receive(reply: Reply) {
      if (flight?.request !== reply.request) return;
      const { card, signature } = flight;
      flight = undefined;
      if (
        card.element.isConnected &&
        signature === readingKey(card, range(card))
      ) {
        waiting.delete(card);
        card.measured = signature;
        card.pending = undefined;
        card.status.textContent = reply.error || "";
        card.rows.replaceChildren(
          ...(reply.rows ?? []).map(([label, value]) => {
            const row = document.createElement("tr");
            const name = document.createElement("th");
            const reading = document.createElement("td");
            name.scope = "row";
            name.textContent = name.title = label;
            reading.textContent = reading.title = value;
            row.append(name, reading);
            return row;
          }),
        );
      }
      refresh();
    },
    invalidate() {
      flight = undefined;
      waiting.clear();
      for (const card of cards.values()) {
        card.measured = undefined;
        card.pending = undefined;
      }
    },
  };
}
