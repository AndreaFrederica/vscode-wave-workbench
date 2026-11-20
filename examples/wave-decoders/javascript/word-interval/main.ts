// SPDX-License-Identifier: MPL-2.0

type State = { tick?: string; value?: string; finish?: string };
type Context = { emit(value: { start: string; end: string; label: string }): void };
type Batch = { end: string; events(): Iterable<{ tick: string; value: string }> };

function close(ctx: Context, state: State, finish?: string) {
  if (state.tick && finish && state.tick !== finish && state.value === "10101010")
    ctx.emit({ start: state.tick, end: finish, label: "word 0xaa" });
}

export default {
  init(): State {
    return {};
  },
  decode(ctx: Context, state: State, batch: Batch) {
    for (const event of batch.events()) {
      close(ctx, state, event.tick);
      state.tick = event.tick;
      state.value = event.value;
    }
    state.finish = batch.end;
  },
  saveState: (state: State) => state,
  restoreState: (state: State) => state,
  flush(ctx: Context, state: State) {
    close(ctx, state, state.finish);
  },
};
