// SPDX-License-Identifier: MPL-2.0

import { realValue } from "../shared/analog";
import type { Signal } from "../shared/protocol";
import { key, label } from "../shared/signals";
import { analogOrdinate, type AnalogRange } from "./analog-render";
import { getElement as $ } from "./dom";

interface Geometry {
  range: AnalogRange;
  top: number;
  bottom: number;
}

const clamp = (ratio: number) => Math.max(0, Math.min(1, ratio));

function levelAt({ min, max }: AnalogRange, ratio: number) {
  const level = (1 - ratio) * min + ratio * max;
  return Math.max(min, Math.min(max, Number(level.toPrecision(12))));
}

export function amplitudeCursors(
  selection: () => Signal | undefined,
  redraw: () => void,
  warn: (message: string) => void,
) {
  const toggle = $("toggleAmplitudeCursors");
  const toolbar = $("amplitudeCursorToolbar");
  const layer = $("amplitudeCursorLayer");
  const source = $("amplitudeCursorSource");
  const delta = $("amplitudeCursorDelta");
  const controls = [
    { input: $("amplitudeY1"), handle: $("amplitudeY1Handle") },
    { input: $("amplitudeY2"), handle: $("amplitudeY2Handle") },
  ];
  let enabled = false;
  let signal: Signal | undefined;
  let values: [number | undefined, number | undefined] = [undefined, undefined];
  let geometry: Geometry | undefined;
  let rulerHeight = 0;

  function render() {
    const unit = signal?.unit ? " " + signal.unit : "";
    const [first, second] = values;
    const difference =
      first === undefined || second === undefined
        ? undefined
        : Math.abs(first - second);
    delta.textContent =
      difference === undefined
        ? "ΔY —"
        : "ΔY " +
          (Number.isFinite(difference)
            ? Number(difference.toPrecision(10)) + unit
            : "—");

    layer.hidden = !enabled || !geometry;
    if (geometry) layer.style.top = rulerHeight + "px";
    for (const [index, { input, handle }] of controls.entries()) {
      const value = values[index];
      input.disabled = !signal;
      if (document.activeElement !== input)
        input.value = value === undefined ? "" : String(value);
      const line = handle.parentElement;
      if (!geometry || value === undefined) {
        line.hidden = true;
        continue;
      }
      const { range, top, bottom } = geometry;
      const outOfRange = value < range.min || value > range.max;
      const ordinate = analogOrdinate(range, top, bottom)(value);
      const y = value > range.max ? top : value < range.min ? bottom : ordinate;
      const text = value + unit + (outOfRange ? "（超出当前纵轴）" : "");
      line.hidden = y < rulerHeight || y >= rulerHeight + layer.clientHeight;
      line.style.top = y - rulerHeight + "px";
      handle.textContent =
        (index === 0 ? "Y1" : "Y2") +
        (value > range.max ? " ↑" : value < range.min ? " ↓" : "");
      handle.title = text + " · 拖动调整";
      handle.setAttribute("aria-valuetext", text);
      handle.setAttribute("aria-valuenow", String(value));
      handle.setAttribute("aria-valuemin", String(Math.min(range.min, value)));
      handle.setAttribute("aria-valuemax", String(Math.max(range.max, value)));
    }
  }

  function attach() {
    const selected = selection();
    if (!selected?.real) {
      warn("请先在波形列表中选择一条实数信号。");
      return false;
    }
    if (!signal || key(signal) !== key(selected))
      values = [undefined, undefined];
    signal = selected;
    return true;
  }

  toggle.onclick = () => {
    if (!enabled && !signal && !attach()) return;
    enabled = !enabled;
    toggle.setAttribute("aria-pressed", String(enabled));
    toolbar.hidden = !enabled;
    layer.hidden = true;
    redraw();
  };
  $("attachAmplitudeCursors").onclick = () => {
    if (attach()) redraw();
  };

  for (const [index, { input, handle }] of controls.entries()) {
    const commit = (value: number | undefined) => {
      if (value !== undefined) values[index] = value;
      input.value = values[index] === undefined ? "" : String(values[index]);
      render();
    };
    input.onchange = () => commit(realValue(input.value.trim()));
    input.onkeydown = (event) => {
      if (event.key === "Enter") input.blur();
      if (event.key === "Escape") {
        commit(undefined);
        input.blur();
      }
    };

    let grabOffset = 0;
    handle.onpointerdown = (event) => {
      if (event.button !== 0 || !geometry) return;
      const bounds = handle.getBoundingClientRect();
      grabOffset = event.clientY - (bounds.top + bounds.height / 2);
      handle.focus({ preventScroll: true });
      handle.setPointerCapture(event.pointerId);
      event.preventDefault();
    };
    handle.onpointermove = (event) => {
      if (!handle.hasPointerCapture(event.pointerId) || !geometry) return;
      const { range, top, bottom } = geometry;
      if (range.min === range.max) return;
      const y =
        event.clientY -
        layer.getBoundingClientRect().top +
        rulerHeight -
        grabOffset;
      commit(levelAt(range, clamp((bottom - y) / (bottom - top))));
    };
    handle.onkeydown = (event) => {
      if (!geometry) return;
      const { range, top, bottom } = geometry;
      const current = values[index];
      if (current === undefined || range.min === range.max) return;
      const step = event.shiftKey ? 0.1 : 0.01;
      const ratio =
        (bottom - analogOrdinate(range, top, bottom)(current)) / (bottom - top);
      const target = {
        ArrowUp: ratio + step,
        ArrowDown: ratio - step,
        Home: 0,
        End: 1,
      }[event.key];
      if (target === undefined) return;
      event.preventDefault();
      event.stopPropagation();
      commit(levelAt(range, clamp(target)));
    };
  }

  return {
    target(chosen: Signal[]) {
      if (!enabled || !signal) return;
      const current = signal;
      signal = chosen.includes(current)
        ? current
        : chosen.find(
            (row) =>
              row.real &&
              row.name === current.name &&
              key(row) === key(current),
          );
      if (!signal) values = [undefined, undefined];
      return signal;
    },
    update(next: Geometry | undefined, timeline: number) {
      geometry = next;
      rulerHeight = timeline;
      if (!enabled) return;
      if (next) {
        values[0] ??= levelAt(next.range, 0.75);
        values[1] ??= levelAt(next.range, 0.25);
      }
      source.textContent = signal
        ? label(signal) +
          (signal.unit ? " · " + signal.unit : "") +
          (next ? "" : " · 纵轴暂不可用")
        : "请选择实数信号";
      source.title = signal ? signal.scope + "/" + label(signal) : "";
      render();
    },
  };
}
