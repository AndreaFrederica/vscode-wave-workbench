// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { Backend } from "./backend";
import type {
  WaveState,
  Metadata,
  Signal,
  SavedSignal,
} from "./shared/protocol";
import * as WaveSignal from "./shared/signals";
async function restoreView(
  backend: Backend,
  state: WaveState,
  meta: Metadata,
  switchingShm = false,
) {
  if (!state || !Array.isArray(state.chosen) || state.chosen.length > 100000)
    throw Error("Invalid wave view state");
  if (switchingShm) {
    const start = Number(meta.start);
    const end = Number(meta.end);
    const clamp = (tick: number) => Math.min(end, Math.max(start, tick));
    const visibleStart = clamp(state.start);
    const visibleEnd = clamp(state.end);
    state = {
      ...state,
      start: visibleEnd > visibleStart ? visibleStart : start,
      end: visibleEnd > visibleStart ? visibleEnd : end,
      cursorA: clamp(state.cursorA),
      cursorB: state.cursorB === null ? null : clamp(state.cursorB),
      markers: state.markers?.filter(
        (marker) => marker.time >= start && marker.time <= end,
      ),
    };
  }
  for (const name of ["start", "end", "cursorA"] as const)
    if (
      !Number.isSafeInteger(state[name]) ||
      state[name] < Number(meta.start) ||
      state[name] > Number(meta.end)
    )
      throw Error("Invalid saved time: " + name);
  if (state.end <= state.start) throw Error("Invalid saved time window");
  if (
    state.markers &&
    (!Array.isArray(state.markers) ||
      state.markers.length > 2000 ||
      state.markers.some(
        (m) =>
          typeof m.name !== "string" ||
          !m.name.trim() ||
          m.name.length > 120 ||
          !Number.isSafeInteger(m.time) ||
          m.time < Number(meta.start) ||
          m.time > Number(meta.end),
      ))
  )
    throw Error("Invalid saved time markers");
  const virtuals = switchingShm
    ? await rebindVirtuals(backend, state.virtualDefinitions || [])
    : undefined;
  if (!virtuals)
    await registerVirtuals(backend, state.virtualDefinitions || []);
  const signals: Signal[] = [];
  for (let i = 0; i < state.chosen.length; i += 1000) {
    const saved = state.chosen.slice(i, i + 1000),
      styles = new Map<string, SavedSignal[]>();
    for (const s of saved) {
      if (
        typeof s.id !== "string" ||
        typeof s.scope !== "string" ||
        typeof s.name !== "string"
      )
        throw Error("Invalid signal descriptor");
      const key = WaveSignal.baseKey(s);
      if (!styles.has(key)) styles.set(key, []);
      styles.get(key)!.push(s);
    }
    const described = await backend.request("describe", {
      descriptors: saved.map(({ id, scope, name }) => {
        const signal = virtuals?.get(id);
        return signal
          ? { id: signal.id, scope: signal.scope, name: signal.name }
          : { id, scope, name };
      }),
    });
    if (described.length !== saved.length)
      throw Error("A saved signal is missing in this waveform");
    for (const [index, s] of described.entries()) {
      const style = switchingShm
        ? saved[index]
        : styles.get(WaveSignal.baseKey(s))?.shift();
      if (!style) throw Error("Saved signal does not match this waveform");
      if (
        style.bitOffset !== undefined &&
        (!Number.isSafeInteger(style.bitOffset) ||
          style.bitOffset < 0 ||
          style.bitOffset >= s.width)
      )
        throw Error("Invalid saved bit selection");
      signals.push(
        WaveSignal.restore(
          {
            ...style,
            parentBus:
              switchingShm && style.parentBus
                ? WaveSignal.baseKey(s)
                : style.parentBus,
          },
          s,
        ),
      );
    }
  }
  if (!switchingShm) return { ...state, chosen: signals };
  const expanded = new Map(
    state.chosen.map((signal, index) => [
      WaveSignal.baseKey(signal),
      WaveSignal.baseKey(signals[index]),
    ]),
  );
  return {
    ...state,
    chosen: signals,
    virtualDefinitions: [...virtuals!.values()],
    expandedBuses: state.expandedBuses?.map((key) => expanded.get(key) ?? key),
  };
}
async function rebindVirtuals(backend: Backend, definitions: Signal[]) {
  if (!Array.isArray(definitions) || definitions.length > 4096)
    throw Error("Invalid virtual definitions");
  const virtuals = new Map<string, Signal>();
  for (const signal of definitions) {
    const definition = signal.definition;
    if (!definition) throw Error("Missing virtual signal definition");
    const inputs = definition.inputs;
    const rebound = inputs.length
      ? await backend.request("describe", {
          descriptors: inputs.map((input) => {
            const previous = virtuals.get(input.id);
            return previous
              ? { id: previous.id, scope: previous.scope, name: previous.name }
              : input;
          }),
        })
      : [];
    if (rebound.length !== inputs.length)
      throw Error("A virtual input is missing in this waveform");
    const result = await backend.request("defineVirtual", {
      name: signal.name,
      definition:
        definition.op === "samples"
          ? definition
          : {
              ...definition,
              inputs: inputs.map((input, index) => ({
                ...input,
                id: rebound[index].id,
                scope: rebound[index].scope,
                name: rebound[index].name,
              })),
            },
    });
    virtuals.set(signal.id, result.signal);
  }
  return virtuals;
}
async function registerVirtuals(backend: Backend, definitions: Signal[]) {
  if (!Array.isArray(definitions) || definitions.length > 4096)
    throw Error("Invalid virtual definitions");
  for (const d of definitions) {
    if (!d.definition) throw Error("Missing virtual signal definition");
    const result = await backend.request("defineVirtual", {
      definition: d.definition,
      name: d.name,
    });
    if (result.signal.id !== d.id)
      throw Error("Virtual definition identity mismatch");
  }
}
export { restoreView, registerVirtuals };
