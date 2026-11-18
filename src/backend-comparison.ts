// SPDX-License-Identifier: MPL-2.0

import type { Backend } from "./backend";
import type { backendPlan } from "./backend-selection";
import type { KdbSession } from "./kdb";
import { mapPrefix } from "./kdb";
import type { Block, ClipContext, Signal } from "./shared/protocol";
import { key, label, project } from "./shared/signals";

type Plan = ReturnType<typeof backendPlan>;

function valueChanges(
  block: Block,
  signal: Signal,
  start: bigint,
  end: bigint,
) {
  const values = new Map<bigint, string>();
  for (const [tick, bits] of block.events) {
    const time = BigInt(tick);
    if (time > end) break;
    values.set(
      time < start ? start : time,
      project(bits.toLowerCase(), signal)!,
    );
  }
  return values;
}

function firstDifference(
  verdi: Block,
  independent: Block,
  signal: Signal,
  start: bigint,
  end: bigint,
) {
  // Beyond a truncated reader's last returned tick, the effective value is unknown.
  const checkedEnd = [verdi, independent].reduce((last, block) => {
    if (!block.truncated) return last;
    const event = block.events.at(-1);
    const tick = event ? BigInt(event[0]) - 1n : start - 1n;
    return tick < last ? tick : last;
  }, end);
  if (checkedEnd < start) return undefined;
  const left = valueChanges(verdi, signal, start, checkedEnd);
  const right = valueChanges(independent, signal, start, checkedEnd);
  const ticks = [...new Set([start, ...left.keys(), ...right.keys()])].sort(
    (a, b) => (a < b ? -1 : a > b ? 1 : 0),
  );
  let a: string | undefined;
  let b: string | undefined;
  for (const tick of ticks) {
    a = left.get(tick) ?? a;
    b = right.get(tick) ?? b;
    if (a !== b) return { tick, a, b };
  }
}

async function read(
  backend: Backend,
  signal: Signal,
  start: bigint,
  end: bigint,
): Promise<Block> {
  const query = signal.scope ? `${signal.scope}.${signal.name}` : signal.name;
  const matches = new Map<string, Signal>();
  for (let offset = 0; ; offset += 512) {
    const page = await backend.request("search", { query, offset, limit: 512 });
    for (const candidate of page.signals) {
      if (candidate.scope === signal.scope && candidate.name === signal.name)
        matches.set(candidate.id, candidate);
    }
    if (offset + page.signals.length >= page.total || !page.signals.length)
      break;
  }
  const [found] = matches.values();
  if (matches.size !== 1)
    throw Error(matches.size ? "信号名有歧义" : "找不到信号");
  if (!found.supported) throw Error("波形值编码不支持");
  if (found.width !== (signal.sourceWidth ?? signal.width))
    throw Error(
      `信号位宽为 ${found.width}，视图位宽为 ${signal.sourceWidth ?? signal.width}`,
    );
  return (
    await backend.request("query", {
      signals: [found.id],
      start: start.toString(),
      end: end.toString(),
      limit: Math.min(
        20000,
        Math.max(1, Math.floor((1024 * 1024) / found.width)),
      ),
    })
  )[found.id];
}

export async function compareBackends(
  plans: readonly [Plan, Plan],
  waveform: string,
  view: ClipContext,
  range: "view" | "cursors",
  kdbPath?: string,
  hierarchyMappings?: Record<string, string>,
) {
  let start = BigInt(
    range === "cursors" ? Math.min(view.cursorA, view.cursorB!) : view.start,
  );
  let end = BigInt(
    range === "cursors" ? Math.max(view.cursorA, view.cursorB!) : view.end,
  );
  const requested = view.selected.length ? view.selected : view.displayed;
  const physical = [
    ...new Map(
      requested
        .filter((s) => !s.definition && s.scope !== "$virtual")
        .map((signal) => [key(signal), signal]),
    ).values(),
  ];
  const signals = physical.slice(0, 32);
  const output = [
    "# Wave Workbench 后端对比",
    "",
    waveform,
    `时间窗 ${start}–${end} ticks，已纳入 ${signals.length}/${physical.length} 个物理信号`,
    "",
  ];
  if (!signals.length) throw Error("选择至少一个物理信号后再对比");
  if (physical.length < requested.length)
    output.push("范围以物理信号及其单比特投影为准。", "");

  const waves: Backend[] = [];
  const kdbs: (KdbSession | undefined)[] = [];
  try {
    const opened = await Promise.allSettled(
      plans.map(async (plan) => {
        const backend = plan.createWave();
        waves.push(backend);
        return {
          backend,
          meta: await backend.request("open", { path: waveform }),
        };
      }),
    );
    opened.forEach((entry, index) => {
      const prefix = plans[index].label;
      if (entry.status === "rejected")
        output.push(`- ${prefix}打开失败：${entry.reason}`);
      else {
        const { meta } = entry.value;
        output.push(
          `- ${prefix} · ${meta.backend} · ${meta.scale} · ${meta.start}–${meta.end} · ${meta.total} 条声明`,
        );
      }
    });
    const [verdi, independent] = opened;
    if (verdi.status !== "fulfilled" || independent.status !== "fulfilled")
      return output.join("\n");
    if (verdi.value.meta.scale !== independent.value.meta.scale) {
      output.push("", "时间单位不同，无法按相同 tick 对齐。");
      return output.join("\n");
    }
    const requestedStart = start;
    const requestedEnd = end;
    for (const { meta } of [verdi.value, independent.value]) {
      const first = BigInt(meta.start);
      const last = BigInt(meta.end);
      if (first > start) start = first;
      if (last < end) end = last;
    }
    if (start > end) {
      output.push("", "选定区间与两端的共同时间范围没有重叠。");
      return output.join("\n");
    }
    if (start !== requestedStart || end !== requestedEnd)
      output.push("", `两端共同覆盖的区间为 ${start}–${end} ticks。`);
    if (kdbPath) {
      output.push("", `KDB ${kdbPath}`);
      const kdbResults = await Promise.allSettled(
        plans.map(async (plan, index) => {
          const session = plan.createKdb();
          kdbs[index] = session;
          const result = await session.open(kdbPath);
          return result.backend;
        }),
      );
      kdbResults.forEach((entry, index) =>
        output.push(
          `- ${plans[index].label} · ${entry.status === "fulfilled" ? entry.value : entry.reason}`,
        ),
      );
      if (kdbResults.some((entry) => entry.status !== "fulfilled")) {
        kdbs.forEach((session) => session?.dispose());
        kdbs.length = 0;
      }
    }
    for (const signal of signals) {
      const fullname = signal.scope
        ? `${signal.scope}.${label({ ...signal, displayName: undefined })}`
        : signal.name;
      const results = await Promise.allSettled([
        read(verdi.value.backend, signal, start, end),
        read(independent.value.backend, signal, start, end),
      ]);
      const [a, b] = results;
      output.push("", `## ${fullname.replace(/[\r\n]/g, " ")}`);
      if (a.status === "fulfilled" && b.status === "fulfilled") {
        const diff = firstDifference(a.value, b.value, signal, start, end);
        if (diff) {
          output.push(
            `- 首次差异 @ ${diff.tick} · Verdi ${diff.a ?? "无值"} · WaveBench Reader ${diff.b ?? "无值"}`,
          );
        } else if (a.value.truncated || b.value.truncated) {
          output.push("- 返回的数据已截断，完整区间待核对。");
        } else if (!a.value.events.length && !b.value.events.length) {
          output.push("- 两端均无事件。");
        } else {
          output.push("- 波形一致。");
        }
        output.push(
          `- 原始事件数 · Verdi ${a.value.events.length}${a.value.truncated ? "（截断）" : ""} · WaveBench Reader ${b.value.events.length}${b.value.truncated ? "（截断）" : ""}`,
        );
      } else {
        results.forEach((entry, index) => {
          if (entry.status === "rejected")
            output.push(`- ${plans[index].label}读取失败：${entry.reason}`);
        });
      }
      if (kdbs.length) {
        const name = signal.name.replace(/\s*\[\s*-?\d+\s*:\s*-?\d+\s*\]$/, "");
        const query = mapPrefix(
          signal.scope ? `${signal.scope}.${name}` : name,
          hierarchyMappings,
        );
        const locations = await Promise.allSettled(
          kdbs.map((session) => session!.resolve(query)),
        );
        const signatures = locations.map((entry) => {
          if (entry.status === "rejected") return undefined;
          const location = entry.value;
          return location
            ? JSON.stringify([location.kind, location.file, location.line])
            : null;
        });
        if (
          signatures.every((value) => value !== undefined) &&
          signatures[0] !== signatures[1]
        )
          output.push("- KDB 声明位置不同。");
        locations.forEach((entry, index) => {
          if (entry.status === "rejected") {
            output.push(`- ${plans[index].label}声明查询失败：${entry.reason}`);
            return;
          }
          const location = entry.value;
          output.push(
            `- ${plans[index].label}声明 · ${location ? `${location.kind} · ${location.file}:${location.line}` : "无源码位置"}`,
          );
        });
      }
    }
    return output.join("\n") + "\n";
  } finally {
    waves.forEach((wave) => wave.dispose());
    kdbs.forEach((session) => session?.dispose());
  }
}
