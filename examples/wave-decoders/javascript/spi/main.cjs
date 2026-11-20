"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var main_exports = {};
__export(main_exports, {
  default: () => main_default
});
module.exports = __toCommonJS(main_exports);
var main_default = {
  init(ctx) {
    return { clock: String(ctx.getOption("cpol") ?? 0), data: "x", select: "1", bits: "", first: "", tick: "", pending: [] };
  },
  decode(ctx, state, batch) {
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
      else if (clock !== state.clock && /^[01]$/.test(clock) && /^[01]$/.test(state.clock) && state.clock === polarity === trailing) {
        if (!state.bits) state.first = state.tick;
        state.bits += state.data;
        if (state.bits.length === 8) {
          const known = /^[01]+$/.test(state.bits);
          ctx.emit({
            start: state.first,
            end: state.tick,
            label: known ? "0x" + parseInt(state.bits, 2).toString(16).padStart(2, "0") : state.bits
          });
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
  saveState(state) {
    return state;
  },
  restoreState(state) {
    return state;
  }
};
