// SPDX-License-Identifier: MPL-2.0

// SPDX-License-Identifier: MPL-2.0
import { pathToFileURL } from "node:url";
import type { Uri } from "vscode";
import type { Backend } from "./backend";
import type { DesignSession } from "./kdb";
import type { Metadata, Signal, WaveState } from "./shared/protocol";
import { key, project } from "./shared/signals";
import type { RtlProjectBinding } from "./rtl-project-binding";

export class HeadlessWaveView {
  readonly uri: Uri;
  scriptDirectory?: string;
  readonly ready = Promise.resolve();
  disposed = false;
  kdb: DesignSession | undefined;
  snapshot: Omit<WaveState, "chosen"> & { chosen: Signal[] };
  private selected = new Set<string>();

  constructor(
    readonly backend: Backend,
    readonly meta: Metadata,
    filename: string,
    state?: Omit<WaveState, "chosen"> & { chosen: Signal[] },
    readonly attachKdb: (
      database?: string,
      edited?: boolean,
    ) => Promise<boolean> = async () => false,
    readonly document?: { rtlBinding?: RtlProjectBinding },
  ) {
    this.uri = {
      fsPath: filename,
      toString: () => pathToFileURL(filename).href,
    } as Uri;
    this.snapshot = state ?? {
      chosen: [],
      start: Number(meta.start),
      end: Number(meta.end),
      cursorA: Number(meta.start),
      cursorB: null,
      markers: [],
      radix: "hex",
      displayScale: null,
      displayFactor: 1,
      groupOrder: [],
      activeGroup: "",
      collapsedGroups: [],
      expandedBuses: [],
      signalFilter: "",
      virtualDefinitions: [],
    };
  }

  clipContext() {
    const { start, end, cursorA, cursorB, markers, chosen } = this.snapshot;
    const selected = chosen.filter((signal) => this.selected.has(key(signal)));
    return {
      start,
      end,
      cursorA,
      cursorB,
      markers,
      displayed: chosen,
      selected: selected.length ? selected : chosen,
    };
  }

  addVirtual(signal: Signal) {
    const definitions = this.snapshot.virtualDefinitions;
    if (!definitions.some((entry) => entry.id === signal.id))
      definitions.push(signal);
    this.add([signal]);
  }

  private add(signals: Signal[], clear = false) {
    const state = this.snapshot;
    const rows = new Map(
      (clear ? [] : state.chosen).map((signal) => [key(signal), signal]),
    );
    for (const signal of signals) {
      const group = signal.group ?? state.activeGroup;
      if (group && !state.groupOrder.includes(group))
        state.groupOrder.push(group);
      if (!rows.has(key(signal))) rows.set(key(signal), { ...signal, group });
    }
    state.chosen = [...rows.values()];
    if (clear) this.selected.clear();
  }

  private zoom(start: number, end: number) {
    this.snapshot.start = Math.max(Number(this.meta.start), start);
    this.snapshot.end = Math.min(Number(this.meta.end), end);
  }

  async ui(action: string, args: any = {}) {
    const state = this.snapshot;
    const min = Number(this.meta.start);
    const max = Number(this.meta.end);
    switch (action) {
      case "snapshot":
        return structuredClone(state);
      case "restoreView":
        this.snapshot = args;
        this.selected.clear();
        return 1;
      case "addSignals":
        this.add(args.signals, args.clear);
        return 1;
      case "clear":
        state.chosen = [];
        this.selected.clear();
        return 1;
      case "selectSignals":
      case "deleteSignals": {
        const targets = new Set<string>(args.signals.map(key));
        if (action === "selectSignals") {
          this.selected = new Set(
            state.chosen.map(key).filter((id) => targets.has(id)),
          );
          return this.selected.size;
        }
        const before = state.chosen.length;
        state.chosen = state.chosen.filter(
          (signal) => !targets.has(key(signal)),
        );
        for (const target of targets) this.selected.delete(target);
        return before - state.chosen.length;
      }
      case "cursor":
        state.cursorA = args.time;
        return 1;
      case "marker": {
        const name = String(args.name || "B").trim();
        if (!name || name.length > 120)
          throw Error("Choose a marker name of 1–120 characters.");
        const point = state.markers.find((item) => item.name === name);
        if (!point && state.markers.length >= 2000)
          throw Error("At most 2000 markers are supported.");
        if (point) point.time = args.time;
        else state.markers.push({ name, time: args.time });
        if (!args.independent || name === "B") state.cursorB = args.time;
        if (
          !args.keepView &&
          (args.time < state.start || args.time > state.end)
        ) {
          const span = state.end - state.start;
          const left = Math.max(
            min,
            Math.min(max - span, Math.round(args.time - span / 2)),
          );
          this.zoom(left, left + span);
        }
        return 1;
      }
      case "window":
        this.zoom(args.start, args.end);
        return 1;
      case "fit":
        this.zoom(min, max);
        return 1;
      case "between":
        if (state.cursorB === null || state.cursorB === state.cursorA)
          throw Error("Set distinct cursor and marker first");
        this.zoom(
          Math.min(state.cursorA, state.cursorB),
          Math.max(state.cursorA, state.cursorB),
        );
        return 1;
      case "in":
      case "out": {
        const span = Math.min(
          max - min,
          Math.max(
            1,
            Math.round((state.end - state.start) * (action === "in" ? 0.5 : 2)),
          ),
        );
        const cursor = Math.max(
          state.start,
          Math.min(state.end, state.cursorA),
        );
        const ratio =
          (cursor - state.start) / Math.max(1, state.end - state.start);
        const start = Math.max(
          min,
          Math.min(max - span, Math.round(cursor - ratio * span)),
        );
        this.zoom(start, start + span);
        return 1;
      }
      case "timeUnit":
        state.displayScale = args.scale;
        state.displayFactor = args.factor;
        return 1;
      case "radix": {
        if (!args.signals) state.radix = args.radix;
        else {
          const targets = new Set(args.signals.map(key));
          for (const row of state.chosen)
            if (targets.has(key(row))) row.displayRadix = args.radix;
        }
        return 1;
      }
      case "setDecoder":
      case "annotateSignal": {
        const row = state.chosen.find(
          (signal) => key(signal) === key(args.signal),
        );
        if (!row) return 0;
        if (action === "setDecoder") row.decoder = args.profile;
        else
          row.annotation = {
            tags: args.tags.map((tag: string) => tag.trim()).filter(Boolean),
            note: args.note,
          };
        return 1;
      }
      case "trackLayout":
        if (args.rowHeight !== undefined) state.rowHeight = args.rowHeight;
        if (args.namesFraction !== undefined)
          state.namesFraction = args.namesFraction;
        return {
          rowHeight: state.rowHeight ?? 30,
          namesFraction: state.namesFraction ?? 0.25,
        };
      case "tooltip":
        if (args.enabled !== undefined) state.tooltipEnabled = args.enabled;
        return state.tooltipEnabled !== false ? 1 : 0;
      case "busLabelMode":
        if (args.mode !== undefined) state.busLabelMode = args.mode;
        return state.busLabelMode ?? "auto";
      case "groups":
        return this.groups(args);
      case "next":
      case "prev": {
        const selected = this.clipContext().selected;
        const signals = [...new Set(selected.map(({ id }) => id))];
        if (!signals.length) return null;
        const blocks = await this.backend.request("query", {
          signals,
          start: String(action === "next" ? state.cursorA : state.start),
          end: String(action === "next" ? state.end : state.cursorA),
          limit: 100_000,
        });
        let nearest: number | undefined;
        for (const row of selected) {
          const block = blocks[row.id];
          if (block?.truncated)
            throw Error("Too many events in the current window.");
          let previous: string | undefined;
          for (const [tick, value] of block?.events ?? []) {
            const time = Number(tick);
            const next = project(value, row);
            if (
              previous !== undefined &&
              next !== previous &&
              (action === "next"
                ? time > state.cursorA &&
                  (nearest === undefined || time < nearest)
                : time < state.cursorA &&
                  (nearest === undefined || time > nearest))
            )
              nearest = time;
            previous = next;
          }
        }
        if (nearest !== undefined) state.cursorA = nearest;
        return nearest ?? null;
      }
      default:
        throw Error("Unsupported waveform view operation: " + action);
    }
  }

  private groups({
    operation,
    group,
    target,
    after,
    signals,
  }: {
    operation: string;
    group: string;
    target: string;
    after: boolean;
    signals?: Signal[];
  }) {
    const state = this.snapshot;
    if (operation === "list")
      return state.groupOrder.map((name) => ({
        name,
        collapsed: state.collapsedGroups.includes(name),
        size: state.chosen.filter((signal) => signal.group === name).length,
      }));
    if (operation === "create" || operation === "target") {
      if (!state.groupOrder.includes(group)) state.groupOrder.push(group);
      if (operation === "target") state.activeGroup = group;
      return 1;
    }
    if (!state.groupOrder.includes(group))
      throw Error("Unknown group: " + group);
    if (operation === "assign") {
      const targets = new Set(signals?.map(key));
      for (const row of state.chosen)
        if (targets.has(key(row))) row.group = group;
    } else if (operation === "collapse" || operation === "expand") {
      state.collapsedGroups = state.collapsedGroups.filter(
        (name) => name !== group,
      );
      if (operation === "collapse") state.collapsedGroups.push(group);
    } else if (operation === "rename" || operation === "remove") {
      if (operation === "rename" && state.groupOrder.includes(target))
        throw Error("Group already exists: " + target);
      const updated = operation === "rename" ? target : "";
      state.groupOrder = state.groupOrder
        .map((name) => (name === group ? updated : name))
        .filter(Boolean);
      state.collapsedGroups = state.collapsedGroups
        .map((name) => (name === group ? updated : name))
        .filter(Boolean);
      for (const row of state.chosen)
        if (row.group === group) row.group = updated;
      if (state.activeGroup === group) state.activeGroup = updated;
    } else if (operation === "move" && target !== group) {
      const order = state.groupOrder.filter((name) => name !== group);
      const index = order.indexOf(target);
      if (index < 0) throw Error("Unknown group: " + target);
      order.splice(index + Number(after), 0, group);
      state.groupOrder = order;
    }
    return 1;
  }
}
