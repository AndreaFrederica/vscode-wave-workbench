// SPDX-License-Identifier: MPL-2.0

type Sample = { tick: string; input: number; value: string };
type Batch = { events(): Iterable<Sample> };

export default {
  init(ctx: { getOption(name: string): unknown }) {
    return { clock: String(ctx.getOption("cpol") ?? 0), data: "x", select: "1", bits: "", first: "", tick: "", pending: [] as Sample[] };
  },
  decode(ctx, state, batch: Batch) {
    const polarity = String(ctx.getOption("cpol") ?? 0);
    const trailing = Number(ctx.getOption("cpha") ?? 0) === 1;
    function apply() {
      if (!state.pending.length) return;
      const clock = state.clock;
      for (const { input, value } of state.pending) {
        if (input === 0) state.clock = value;
        else if (input === 1) state.data = value;
        else if (input === 2) state.select = value;
      }
      if (state.select !== "0") state.bits = "";
      else if (clock !== state.clock && /^[01]$/.test(clock) && /^[01]$/.test(state.clock) &&
          (state.clock === polarity) === trailing) {
        if (!state.bits) state.first = state.tick;
        state.bits += state.data;
        if (state.bits.length === 8) {
          const known = /^[01]+$/.test(state.bits);
          ctx.emit({ start: state.first, end: state.tick,
            label: known ? "0x" + parseInt(state.bits, 2).toString(16).padStart(2, "0") : state.bits });
          state.bits = "";
        }
      }
      state.pending = [];
    }
    for (const event of batch.events()) {
      if (state.tick !== event.tick) apply();
      state.tick = event.tick;
      state.pending.push(event);
    }
    apply();
  },
  saveState(state) { return state; },
  restoreState(state) { return state; },
};
