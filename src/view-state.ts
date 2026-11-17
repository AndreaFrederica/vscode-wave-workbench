import type { Backend } from "./backend";
import type {
  WaveState,
  Metadata,
  Signal,
  SavedSignal,
} from "./shared/protocol";
import * as WaveSignal from "./shared/signals";
async function restoreView(backend: Backend, state: WaveState, meta: Metadata) {
  if (!state || !Array.isArray(state.chosen) || state.chosen.length > 100000)
    throw Error("Invalid wave view state");
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
  await registerVirtuals(backend, state.virtualDefinitions || []);
  const signals = [];
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
      descriptors: saved.map(({ id, scope, name }) => ({ id, scope, name })),
    });
    if (described.length !== saved.length)
      throw Error("A saved signal is missing in this waveform");
    for (const s of described) {
      const style = styles.get(WaveSignal.baseKey(s))?.shift();
      if (!style) throw Error("Saved signal does not match this waveform");
      if (
        style.bitOffset !== undefined &&
        (!Number.isSafeInteger(style.bitOffset) ||
          style.bitOffset < 0 ||
          style.bitOffset >= s.width)
      )
        throw Error("Invalid saved bit selection");
      signals.push(WaveSignal.restore(style, s));
    }
  }
  return { ...state, chosen: signals };
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
