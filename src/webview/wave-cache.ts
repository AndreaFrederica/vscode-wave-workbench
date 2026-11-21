// SPDX-License-Identifier: MPL-2.0

import { localize } from "../shared/localization";
import type {
  CacheStats,
  CacheUsage,
  WaveCacheProjectUsage,
} from "../shared/protocol";

const vscode = acquireVsCodeApi();
const waveform = document.querySelector<HTMLElement>("#waveform")!;
const route = document.querySelector<HTMLElement>("#route")!;
const feedback = document.querySelector<HTMLElement>("#feedback")!;
const canvas = document.querySelector<HTMLCanvasElement>("#history")!;
const chart = canvas.getContext("2d")!;
const encodings = document.querySelector<HTMLTableElement>("#encodings")!;
const psfxlSource = document.querySelector<HTMLElement>("#psfxl-source")!;
const projectsTable = document.querySelector<HTMLTableElement>("#projects")!;
const projectSummary = document.querySelector<HTMLElement>("#project-summary")!;
const mib = 1024 * 1024;
const historyMs = 120_000;
const series = ["memory", "samples", "disk"] as const;
const history: ({ time: number } & Partial<
  Record<(typeof series)[number], number>
>)[] = [];
const cards = Array.from(
  document.querySelectorAll<HTMLElement>("[data-cache]"),
);
let session: number | undefined;
let sampleSession: number | undefined;
let applying = false;

type Snapshot = {
  type: "snapshot";
  path?: string;
  backend?: string;
  stats?: CacheStats;
  psfxl?: CacheStats["psfxl"];
  psfxlPath?: string;
  projects: WaveCacheProjectUsage[];
  settings: {
    cacheSizeMB: number;
    psfxlMemoryCacheSizeMB: number;
    psfxlCacheSizeMB: number;
  };
  session: number;
  sampleSession: number;
};

function refresh() {
  if (!document.hidden && !applying) vscode.postMessage({ type: "refresh" });
}

function setApplying(value: boolean) {
  applying = value;
  for (const card of cards) card.querySelector("button")!.disabled = applying;
}

for (const card of cards) {
  const input = card.querySelector("input")!;
  input.addEventListener("input", () => {
    input.dataset.edited = "true";
  });
  card.querySelector("form")!.addEventListener("submit", (event) => {
    event.preventDefault();
    if (applying) return;
    setApplying(true);
    feedback.classList.remove("error");
    feedback.textContent = localize("正在应用容量…");
    vscode.postMessage({
      type: "save",
      key: card.dataset.cache,
      size: input.valueAsNumber,
    });
  });
}

function occupancy(stats?: CacheUsage) {
  if (!stats) return;
  return stats.budget ? stats.bytes / stats.budget : 0;
}
const percent = (part: number) => `${(part * 100).toFixed(1)}%`;

function renderCard(
  card: HTMLElement,
  stats: CacheUsage | undefined,
  size: number,
  decoded?: CacheStats,
) {
  const input = card.querySelector("input")!;
  if (!input.dataset.edited) input.value = String(size);
  card.querySelector<HTMLElement>(".usage")!.textContent = stats
    ? `${(stats.bytes / mib).toFixed(1)} / ${stats.budget / mib} MiB`
    : "— / " + size + " MiB";
  const progress = card.querySelector("progress")!;
  progress.value = occupancy(stats) ?? 0;
  progress.title = stats ? percent(progress.value) : "";

  const total = (stats?.hits ?? 0) + (stats?.misses ?? 0);
  const values = [
    [localize("缓存条目"), stats?.entries],
    [
      localize("命中率"),
      total && stats ? percent(stats.hits / total) : undefined,
    ],
    [localize("淘汰"), stats?.evictions],
    ...(decoded ? [[localize("后端读取"), decoded.reads] as const] : []),
  ] as const;
  const counters = card.querySelector(".stats")!;
  counters.replaceChildren(
    ...values.map(([label, count]) => {
      const metric = document.createElement("div");
      const term = document.createElement("dt");
      const value = document.createElement("dd");
      term.textContent = label;
      value.textContent = count?.toLocaleString() ?? "—";
      metric.append(term, value);
      return metric;
    }),
  );

  const hits = card.querySelector<HTMLElement>(".hits")!;
  const legend = card.querySelector<HTMLElement>(".legend")!;
  hits.hidden = !stats || !total;
  if (!stats || !total) {
    legend.textContent = localize("暂无缓存查询");
    return;
  }
  const matching = decoded?.containingHits ?? 0;
  const segments = [
    [decoded ? localize("精确命中") : localize("命中"), stats.hits - matching],
    ...(decoded ? [[localize("区间命中"), matching] as const] : []),
    [localize("未命中"), stats.misses],
  ] as const;
  hits.replaceChildren(
    ...segments.map(([label, count]) => {
      const bar = document.createElement("span");
      bar.style.width = percent(count / total);
      bar.title = `${label} ${count.toLocaleString()}`;
      return bar;
    }),
  );
  legend.textContent = segments
    .map(([label, count]) => `${label} ${count.toLocaleString()}`)
    .join(" · ");
  hits.setAttribute("aria-label", legend.textContent);
}

function renderEncodings(stats?: CacheStats) {
  const digital = stats?.digital;
  const real = stats?.real;
  encodings.hidden = !digital || !real;
  if (!digital || !real) return;
  encodings.tBodies[0].replaceChildren(
    ...(
      [
        [localize("数字"), digital],
        [localize("实数"), real],
      ] as const
    ).map(([label, usage]) => {
      const row = document.createElement("tr");
      const heading = document.createElement("th");
      heading.scope = "row";
      heading.textContent = label;
      row.append(heading);
      for (const value of [
        `${(usage.bytes / mib).toFixed(2)} MiB`,
        usage.entries.toLocaleString(),
        usage.hits.toLocaleString(),
        usage.misses.toLocaleString(),
      ]) {
        row.insertCell().textContent = value;
      }
      return row;
    }),
  );
}

function cacheRoute(backend?: string, path?: string) {
  switch (backend) {
    case "shm-lib":
      return localize(
        "SHM 数字信号使用解码事件缓存，未命中时由 SHM 读取器读取。PSFXL 模拟信号依次查解码事件、样本内存和样本磁盘。",
      );
    case "rust-independent-shm":
      return localize(
        "SHM 数字信号使用解码事件缓存，未命中时读取 SST2 数据。PSFXL 模拟信号依次查解码事件、样本内存和样本磁盘。",
      );
    case "wdb-lib":
      return localize(
        "WDB 的数字和实数事件共用解码缓存，未命中时由 XSim SDK 读取。",
      );
    case "rust-fst":
      return localize(
        "FST 的数字和实数事件共用解码缓存，未命中时按时间窗读取和解压文件块。",
      );
    case "rust-independent-fsdb":
      return localize(
        "独立 FSDB 读取器在解码缓存下有 24 MiB 的索引和数据页缓存。",
      );
    case "native-fsdb":
      return localize(
        "FSDB 的数字和实数事件共用解码缓存，未命中时由 Verdi SDK 读取。",
      );
    case "rust-vcd":
      return path?.toLowerCase().endsWith(".wlf")
        ? localize("WLF 转为 VCD 后在内存中读取，查询结果进入解码事件缓存。")
        : localize("VCD 在打开时解析到内存，查询结果进入解码事件缓存。");
    case "rust-psfascii":
    case "rust-ngspice-raw":
      return localize("模拟文件在打开时解析到内存，查询结果进入解码事件缓存。");
    default:
      return "";
  }
}

function renderProjects(projects: WaveCacheProjectUsage[]) {
  projectsTable.hidden = projects.length === 0;
  if (!projects.length) {
    projectSummary.textContent = localize("当前窗口没有打开的波形项目");
    return;
  }
  const totals = {
    sessions: 0,
    pending: 0,
    failed: 0,
    decoded: 0,
    samples: 0,
    disk: 0,
  };
  const byUsage = (project: WaveCacheProjectUsage) =>
    project.decoded + project.samples;
  function fillRow(row: HTMLTableRowElement, usage: typeof totals) {
    const hasStats = usage.sessions > usage.pending + usage.failed;
    row.insertCell().textContent = String(usage.sessions);
    for (const bytes of [
      usage.decoded + usage.samples,
      usage.decoded,
      usage.samples,
      usage.disk,
    ]) {
      row.insertCell().textContent = hasStats
        ? `${(bytes / mib).toFixed(2)} MiB`
        : "—";
    }
  }
  const rows = [...projects]
    .sort(
      (a, b) =>
        byUsage(b) - byUsage(a) ||
        b.disk - a.disk ||
        a.name.localeCompare(b.name),
    )
    .map((project) => {
      for (const key of Object.keys(totals) as (keyof typeof totals)[])
        totals[key] += project[key];
      const row = document.createElement("tr");
      const title = document.createElement("th");
      title.scope = "row";
      title.textContent = project.name;
      if (project.active) title.append(localize(" · 当前"));
      const detail = document.createElement("small");
      const status = [
        project.pending && localize("{0} 个读取中", project.pending),
        project.failed && localize("{0} 个读取失败", project.failed),
      ].filter(Boolean);
      detail.textContent = [project.path, ...status].join(" · ");
      title.append(detail);
      row.append(title);
      fillRow(row, project);
      return row;
    });
  projectsTable.tBodies[0].replaceChildren(...rows);
  const totalRow = document.createElement("tr");
  const totalLabel = document.createElement("th");
  totalLabel.scope = "row";
  totalLabel.textContent =
    totals.pending || totals.failed ? localize("已读取小计") : localize("合计");
  totalRow.append(totalLabel);
  fillRow(totalRow, totals);
  projectsTable.tFoot!.replaceChildren(totalRow);
  projectSummary.textContent = localize(
    "当前窗口 · {0} 个项目 · {1} 个会话",
    projects.length,
    totals.sessions,
  );
}

function drawHistory() {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (!width || !height) return;
  const ratio = window.devicePixelRatio || 1;
  canvas.width = width * ratio;
  canvas.height = height * ratio;
  chart.setTransform(ratio, 0, 0, ratio, 0, 0);
  const style = getComputedStyle(canvas);
  const top = 9;
  const bottom = height - 22;
  const left = 39;
  const right = width - 14;
  const y = (fraction: number) => bottom - fraction * (bottom - top);
  const color = (variable: string, fallback: string) =>
    style.getPropertyValue(variable).trim() || fallback;
  chart.font = "11px sans-serif";
  chart.fillStyle = color("--vscode-descriptionForeground", "#999");
  chart.strokeStyle = color("--border", "#444");
  for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
    chart.fillText(`${fraction * 100}%`, 0, y(fraction) + 4);
    chart.beginPath();
    chart.moveTo(left, y(fraction));
    chart.lineTo(right, y(fraction));
    chart.stroke();
  }
  chart.fillText(localize("−2 分钟"), left, height - 4);
  chart.textAlign = "right";
  chart.fillText(localize("现在"), right, height - 4);
  const now = Date.now();
  for (const key of series) {
    chart.strokeStyle = color(`--${key}`, "#4daafc");
    chart.lineWidth = 2;
    chart.beginPath();
    let previous: number | undefined;
    for (const point of history) {
      const value = point[key];
      if (value === undefined || now - point.time > historyMs) {
        previous = undefined;
        continue;
      }
      const x = right - ((now - point.time) / historyMs) * (right - left);
      if (previous !== undefined && point.time - previous < 6000)
        chart.lineTo(x, y(value));
      else {
        chart.moveTo(x, y(value));
        chart.lineTo(x + 1, y(value));
      }
      previous = point.time;
    }
    chart.stroke();
  }
}

window.addEventListener(
  "message",
  (
    event: MessageEvent<
      | Snapshot
      | { type: "feedback"; error?: boolean; text: string; key?: string }
    >,
  ) => {
    const message = event.data;
    if (message.type === "feedback") {
      if (message.key) {
        const input = cards
          .find((card) => card.dataset.cache === message.key)
          ?.querySelector("input");
        if (input) delete input.dataset.edited;
      }
      setApplying(false);
      feedback.classList.toggle("error", !!message.error);
      feedback.textContent = message.text;
      return;
    }
    if (message.type !== "snapshot") return;
    if (session !== message.session) {
      session = message.session;
      history.length = 0;
      delete cards[0].querySelector("input")!.dataset.edited;
    }
    if (sampleSession !== message.sampleSession) {
      sampleSession = message.sampleSession;
      history.length = 0;
      for (const card of cards.slice(1))
        delete card.querySelector("input")!.dataset.edited;
    }
    const { stats, settings, psfxl, psfxlPath } = message;
    waveform.textContent = message.path ?? localize("打开波形后查看实时统计");
    route.textContent = cacheRoute(message.backend, message.path);
    route.hidden = !route.textContent;
    renderCard(cards[0], stats, settings.cacheSizeMB, stats);
    document.querySelector<HTMLElement>(".chart-legend .samples")!.hidden =
      !psfxl?.memory;
    document.querySelector<HTMLElement>(".chart-legend .disk")!.hidden = !psfxl;
    renderCard(cards[1], psfxl?.memory, settings.psfxlMemoryCacheSizeMB);
    renderCard(cards[2], psfxl, settings.psfxlCacheSizeMB);
    psfxlSource.textContent = psfxlPath
      ? localize("L2、L3 {0} · {1}", psfxl ? "数据来源" : "正在读取", psfxlPath)
      : localize("打开含 PSFXL 样本的波形后显示 L2、L3 实际占用。");
    renderEncodings(stats);
    renderProjects(message.projects);
    const time = Date.now();
    while (history.length && time - history[0].time > historyMs)
      history.shift();
    history.push({
      time,
      memory: occupancy(stats),
      samples: occupancy(psfxl?.memory),
      disk: occupancy(psfxl),
    });
    drawHistory();
  },
);
document.querySelector("#refresh")!.addEventListener("click", refresh);
document.addEventListener("visibilitychange", refresh);
new ResizeObserver(drawHistory).observe(canvas);
window.setInterval(refresh, 2000);
refresh();
