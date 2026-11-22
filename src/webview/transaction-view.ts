// SPDX-License-Identifier: MPL-2.0

import { isAxiDecoder } from "../shared/axi-decoder";
import type {
  DecoderInstance,
  DecoderTransaction,
  DecodeResult,
  Json,
} from "../decoder-runtime/types";
import { transactionFilter } from "../shared/transaction-filter";
import type { protocolWorkspace } from "./protocol-workspace";
import { localize } from "../shared/localization";

export function transactionView(
  workspace: ReturnType<typeof protocolWorkspace>,
  items: HTMLElement,
  status: HTMLElement,
  instance: DecoderInstance,
  windowRange: () => [number, number],
  timeLabel: (tick: string) => string,
  jump: (tick: number, channel?: string) => void,
  zoom: (start: number, end: number) => void,
  persist: () => void,
  queryFilter: (text: string) => void,
) {
  const pane = workspace.attach(instance, draw);
  const details = pane.details;
  const root = pane.root;
  const streamExpansion = new Map<string, boolean>();
  const streamTree = document.createElement("div");
  streamTree.className = "protocolStreams";
  const search = document.createElement("input");
  search.type = "search";
  search.maxLength = 1024;
  search.placeholder = localize("筛选当前窗口：名称或字段=值");
  search.setAttribute("aria-label", search.placeholder);
  const count = pane.count;
  const browser = document.createElement("div");
  browser.className = "transactionBrowser";
  browser.append(search, streamTree);
  root.append(browser);
  let result: DecodeResult | undefined,
    selected = "";
  const identity = (item: DecoderTransaction) =>
    JSON.stringify([
      item.start,
      item.end,
      item.label,
      item.fields?.source,
      item.fields?.id,
    ]);
  function format(value: Json) {
    if (
      typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= 0 &&
      instance.fieldRadix !== "dec"
    )
      return "0x" + value.toString(16);
    return typeof value === "string" ? value : JSON.stringify(value);
  }
  let showBeats = false;
  function showDetails(item?: DecoderTransaction) {
    details.replaceChildren();
    if (!item) {
      pane.empty();
      return;
    }
    const title = document.createElement("strong");
    title.textContent =
      item.label + " · " + timeLabel(item.start) + " → " + timeLabel(item.end);
    const radix = document.createElement("select");
    radix.setAttribute("aria-label", localize("字段进制"));
    radix.add(new Option("Hex", "hex"));
    radix.add(new Option("Dec", "dec"));
    radix.value = instance.fieldRadix ?? "hex";
    radix.onchange = () => {
      instance.fieldRadix = radix.value as "hex" | "dec";
      persist();
      draw();
    };
    const head = document.createElement("div");
    const fit = document.createElement("button");
    fit.textContent = localize("缩放到事务");
    fit.onclick = () => zoom(Number(item.start), Number(item.end));
    head.append(title, radix, fit);
    const beats = document.createElement("div");
    beats.className = "transactionBeats";
    for (const point of item.points ?? []) {
      const button = document.createElement("button");
      button.textContent = point.label + " @ " + timeLabel(point.tick);
      button.onclick = () =>
        jump(Number(point.tick), point.channel ?? point.label);
      if (point.fields) {
        const row = document.createElement("div");
        row.append(button);
        for (const [key, value] of Object.entries(point.fields)) {
          const cell = document.createElement("code");
          cell.textContent = key + "=" + format(value);
          row.append(cell);
        }
        beats.append(row);
      } else beats.append(button);
    }
    details.append(head);
    for (const [name, value] of Object.entries(item.fields ?? {})) {
      const row = document.createElement("label"),
        box = document.createElement("input"),
        output = document.createElement("code");
      box.type = "checkbox";
      box.setAttribute("aria-label", name);
      box.checked = instance.pinnedFields?.includes(name) ?? false;
      box.onchange = () => {
        const pins = new Set(instance.pinnedFields);
        if (box.checked) pins.add(name);
        else pins.delete(name);
        instance.pinnedFields = [...pins];
        persist();
        draw();
      };
      output.textContent = format(value);
      row.append(box, document.createTextNode(name), output);
      details.append(row);
    }
    if (beats.childElementCount) {
      const fold = document.createElement("details"),
        summary = document.createElement("summary");
      summary.textContent = localize("握手（{0}）", beats.childElementCount);
      fold.className = "protocolHandshakes";
      fold.open = showBeats;
      fold.ontoggle = () => {
        if (fold.isConnected) showBeats = fold.open;
      };
      fold.append(summary, beats);
      details.append(fold);
    }
  }
  function select(item: DecoderTransaction) {
    selected = identity(item);
    const kind = item.kind ?? item.label,
      source = item.fields?.id ?? item.fields?.source;
    streamExpansion.set(JSON.stringify([kind]), true);
    if (source !== undefined)
      streamExpansion.set(
        JSON.stringify([
          kind,
          (item.fields?.id === undefined ? "source " : "ID ") + format(source),
        ]),
        true,
      );
    pane.activate();
    draw();
    const points = item.points ?? [];
    const [first, last] = windowRange();
    if (
      points.length &&
      (Number(item.start) < first || Number(item.end) > last)
    )
      zoom(Number(item.start), Number(item.end));
    const channel = isAxiDecoder(instance.decoderId)
      ? item.kind === "Read"
        ? "read"
        : item.kind === "Write"
          ? "write"
          : points[0]?.channel
      : (points[0]?.channel ?? points[0]?.label);
    jump(Number(item.start), channel);
  }
  function draw(timelineOnly = false) {
    const lineHeight = instance.rowHeight ?? 26;
    items.replaceChildren();
    if (!timelineOnly) streamTree.replaceChildren();
    const [start, end] = windowRange();
    const rows: number[] = [];
    const query = search.value.trim().toLowerCase();
    const matchesFilter = transactionFilter(query);
    let current: DecoderTransaction | undefined;
    let matches = 0;
    const fragment = document.createDocumentFragment();
    const streams = new Map<string, Map<string, DecoderTransaction[]>>();
    let currentKey = "";
    const dense = !!result?.overview;
    if (dense) {
      const peak = Math.max(1, ...result.overview.map((bin) => bin.count));
      for (const bin of result.overview) {
        const a = Number(bin.start),
          b = Number(bin.end);
        const left = Math.max(start, a),
          right = Math.min(end, b);
        if (!bin.count || left >= right) continue;
        const button = document.createElement("button");
        button.className =
          "protocolBin " +
          (bin.errors ? "error" : bin.warnings ? "warning" : "");
        button.style.left = ((left - start) / (end - start)) * 100 + "%";
        button.style.width = ((right - left) / (end - start)) * 100 + "%";
        button.style.height =
          4 +
          ((lineHeight - 4) * Math.log1p(bin.count)) / Math.log1p(peak) +
          "px";
        button.title = localize(
          "事务 {0} · 错误 {1} · 警告 {2}",
          bin.count,
          bin.errors,
          bin.warnings,
        );
        button.setAttribute("aria-label", button.title + " @ " + bin.start);
        button.onclick = () => zoom(a, b);
        fragment.append(button);
      }
    }
    for (const item of result?.transactions ?? []) {
      if (!matchesFilter(item)) continue;
      const first = Math.max(start, Number(item.start)),
        last = Math.min(end, Number(item.end));
      if (first > last || (first === last && first !== end)) continue;
      const id = identity(item);
      if (id === selected && pane.active()) current = item;
      const kind = item.kind ?? item.label;
      const source = item.fields?.id ?? item.fields?.source;
      const stream =
        source === undefined
          ? ""
          : (item.fields?.id === undefined ? "source " : "ID ") +
            format(source);
      let byId = streams.get(kind);
      if (!byId) streams.set(kind, (byId = new Map()));
      let entries = byId.get(stream);
      if (!entries) byId.set(stream, (entries = []));
      entries.push(item);
      if (current === item) currentKey = JSON.stringify([kind, stream]);
      matches++;
      if (dense) continue;
      const button = document.createElement("button");
      button.className = "decoderTransaction " + (item.severity ?? "");
      const fields = item.fields ?? {};
      const labels = (instance.pinnedFields ?? [])
        .filter((k) => Object.hasOwn(fields, k))
        .map((k) => k + "=" + format(fields[k]));
      button.textContent = [item.label, ...labels].join(" · ");
      button.title = [
        timeLabel(item.start) + " → " + timeLabel(item.end),
        item.label,
        ...Object.entries(fields).map(([k, v]) => k + " = " + format(v)),
      ].join("\n");
      let row = rows.findIndex((tick) => tick <= first);
      if (row < 0) row = rows.length;
      rows[row] = last;
      button.style.top = row * lineHeight + "px";
      button.style.height = lineHeight - 1 + "px";
      button.style.left =
        "min(" +
        ((first - start) / (end - start)) * 100 +
        "%, calc(100% - 3px))";
      button.style.width = ((last - first) / (end - start)) * 100 + "%";
      button.onclick = () => select(item);
      if (id === selected && pane.active()) {
        current = item;
        button.classList.add("selected");
      }
      fragment.append(button);
    }
    if (current && !dense && current.points?.some((p) => p.channel)) {
      const channelRows = new Map<string, number>();
      for (const point of current.points) {
        const tick = Number(point.tick);
        if (tick < start || tick > end || !point.channel) continue;
        if (!channelRows.has(point.channel)) {
          channelRows.set(point.channel, rows.length);
          rows.push(end);
        }
        const marker = document.createElement("button");
        marker.className = "protocolPoint";
        marker.style.top = channelRows.get(point.channel)! * lineHeight + "px";
        marker.style.left = ((tick - start) / (end - start)) * 100 + "%";
        marker.textContent = point.label;
        marker.title = point.label + " @ " + timeLabel(point.tick);
        marker.onclick = () => jump(tick, point.channel);
        fragment.append(marker);
      }
    }
    items.append(fragment);
    items.style.height = Math.max(1, rows.length) * lineHeight + "px";
    items.parentElement!.style.minHeight =
      Math.max(1, rows.length) * lineHeight + 6 + "px";
    if (timelineOnly) return;
    // Only materialize transaction options for expanded streams.
    function branch(
      parent: HTMLElement,
      name: string,
      key: string,
      total: number,
      reveal: boolean,
      fill: (node: HTMLElement) => void,
    ) {
      const node = document.createElement("details"),
        summary = document.createElement("summary");
      summary.textContent = name + " (" + total + ")";
      node.append(summary);
      parent.append(node);
      node.open = streamExpansion.get(key) ?? reveal;
      if (node.open) fill(node);
      node.ontoggle = () => {
        if (!node.isConnected) return;
        if (node.open) {
          streamExpansion.set(key, true);
          if (node.childElementCount === 1) fill(node);
        } else streamExpansion.set(key, false);
      };
    }
    function addList(parent: HTMLElement, entries: DecoderTransaction[]) {
      const list = document.createElement("select");
      list.setAttribute("aria-label", localize("事务列表"));
      list.size = Math.min(8, Math.max(2, entries.length));
      for (const [index, item] of entries.entries()) {
        list.add(
          new Option(timeLabel(item.start) + " · " + item.label, String(index)),
        );
      }
      list.selectedIndex = current ? entries.indexOf(current) : -1;
      list.onchange = () => {
        const item = entries[list.selectedIndex];
        if (item) select(item);
      };
      parent.append(list);
    }
    for (const [kind, groups] of streams) {
      const total = [...groups.values()].reduce(
        (n, entries) => n + entries.length,
        0,
      );
      branch(
        streamTree,
        kind,
        JSON.stringify([kind]),
        total,
        (!!current && (current.kind ?? current.label) === kind) ||
          matches === 1,
        (parent) => {
          for (const [stream, entries] of groups) {
            if (!stream) {
              addList(parent, entries);
              continue;
            }
            const key = JSON.stringify([kind, stream]);
            branch(
              parent,
              stream,
              key,
              entries.length,
              key === currentKey || matches === 1,
              (node) => addList(node, entries),
            );
          }
        },
      );
    }
    count.textContent =
      String(
        result?.overview?.reduce((n, bin) => n + bin.count, 0) ?? matches,
      ) + (!result?.overview && result?.truncated ? "+" : "");
    if (pane.active()) showDetails(current);
    status.textContent = result
      ? [
          result.warnings[0],
          result.truncated ? localize("结果已截断") : "",
          result.transactions.length ? "" : localize("窗口内无事务"),
        ]
          .filter(Boolean)
          .join(" · ")
      : "";
  }
  search.oninput = () => {
    pane.activate();
    draw();
    if (
      isAxiDecoder(instance.decoderId) ||
      ["opentitan.tlul", "opentitan.tluh"].includes(instance.decoderId)
    )
      queryFilter(search.value);
  };
  return {
    toggle() {
      pane.revealExplorer();
      draw();
      search.focus();
    },
    viewport() {
      draw(true);
    },
    dispose: pane.dispose,
    update(next?: DecodeResult) {
      result = next;
      draw();
    },
  };
}
