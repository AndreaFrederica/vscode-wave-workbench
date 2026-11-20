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
function close(ctx, state, finish) {
  if (state.tick && finish && state.tick !== finish && state.value === "10101010")
    ctx.emit({ start: state.tick, end: finish, label: "word 0xaa" });
}
var main_default = {
  init() {
    return {};
  },
  decode(ctx, state, batch) {
    for (const event of batch.events()) {
      close(ctx, state, event.tick);
      state.tick = event.tick;
      state.value = event.value;
    }
    state.finish = batch.end;
  },
  saveState: (state) => state,
  restoreState: (state) => state,
  flush(ctx, state) {
    close(ctx, state, state.finish);
  }
};
