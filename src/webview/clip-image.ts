// SPDX-License-Identifier: MPL-2.0

import type { BusLabelMode, WaveClip } from "../shared/protocol";
import { drawAnalog } from "./analog-render";
import { drawBusLabel } from "./bus-label";
import { decodeWord } from "../shared/decoders";

export type ClipDrawingContext = Pick<
  CanvasRenderingContext2D,
  | "fillStyle"
  | "strokeStyle"
  | "font"
  | "textAlign"
  | "fillRect"
  | "strokeRect"
  | "fillText"
  | "beginPath"
  | "moveTo"
  | "lineTo"
  | "stroke"
> & {
  measureText(text: string): { width: number };
  setLineDash?(segments: number[]): void;
};

const colors = {
  background: "#101722",
  foreground: "#e4edf5",
  muted: "#a3b6c9",
  grid: "#304155",
  digital: "#61dfb9",
  bus: "#78bfff",
  unknown: "#f5be72",
};

function compactValue(value: string) {
  if (!/^[01]+$/.test(value))
    return /^(x+|z+)$/i.test(value) ? value[0].toUpperCase() : value;
  return "0x" + BigInt("0b" + value).toString(16);
}

export function renderClipImage(
  clip: WaveClip,
  busLabelMode: BusLabelMode,
  showDecodedValues: boolean,
): string {
  const canvas = document.createElement("canvas");
  const { width, height } = clipImageSize(clip);
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw Error("Unable to render waveform PNG");
  paintClipImage(ctx, clip, busLabelMode, showDecodedValues);
  return canvas.toDataURL("image/png").slice("data:image/png;base64,".length);
}

const header = 94;
const rowHeight = 42;

export function clipImageSize(clip: WaveClip) {
  return {
    width: 1440,
    height:
      header +
      rowHeight * (clip.traces.length + (clip.decoders?.length ?? 0)) +
      34,
  };
}

export function paintClipImage(
  ctx: ClipDrawingContext,
  clip: WaveClip,
  busLabelMode: BusLabelMode,
  showDecodedValues: boolean,
  titleFont = "bold 21px sans-serif",
) {
  const { width, height } = clipImageSize(clip);
  const left = 360;
  const right = width - 28;
  const from = Number(clip.start),
    to = Number(clip.end);
  const xAt = (tick: number) =>
    left + ((tick - from) / (to - from)) * (right - left);
  const stroke = (color: string, points: [number, number][]) => {
    ctx.strokeStyle = color;
    ctx.beginPath();
    for (const [index, [x, y]] of points.entries()) {
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  };
  ctx.fillStyle = colors.background;
  ctx.fillRect(0, 0, width, height);
  ctx.font = titleFont;
  ctx.fillStyle = colors.foreground;
  ctx.fillText(
    clip.waveform.split(/[\\/]/).at(-1) || "Waveform",
    18,
    29,
    width - 36,
  );
  ctx.font = "13px monospace";
  ctx.fillStyle = colors.muted;
  ctx.fillText(
    `Ticks ${clip.start}–${clip.end}  |  ${clip.timescale}/tick  |  ${clip.traces.length} signals`,
    18,
    55,
  );
  for (let column = 0; column <= 8; column++) {
    const tick = from + Math.round(((to - from) / 8) * column);
    if (
      column > 0 &&
      tick <= from + Math.round(((to - from) / 8) * (column - 1))
    )
      continue;
    const x = xAt(tick);
    stroke(colors.grid, [
      [x, header - 10],
      [x, height - 26],
    ]);
    ctx.textAlign = column === 8 ? "right" : column === 0 ? "left" : "center";
    ctx.fillText(String(tick), x, header - 16);
  }
  ctx.textAlign = "left";
  const label = (value: string, x: number, y: number, available: number) => {
    if (!value || available <= 0) return;
    if (ctx.measureText(value).width > available) {
      const letters = Math.max(0, Math.floor(available / 8) - 2);
      value = letters ? "…" + value.slice(-letters) : "";
    }
    if (value) ctx.fillText(value, x, y, available);
  };

  for (const [row, trace] of clip.traces.entries()) {
    const top = header + row * rowHeight;
    const mid = top + rowHeight / 2;
    const high = mid - 10,
      low = mid + 10;
    stroke(colors.grid, [
      [18, top + rowHeight],
      [right, top + rowHeight],
    ]);
    ctx.fillStyle = colors.foreground;
    label(trace.label, 18, mid + (trace.group ? 0 : 4), left - 36);
    if (trace.group) {
      ctx.fillStyle = colors.muted;
      label(trace.group, 18, mid + 15, left - 36);
    }
    if (trace.real) {
      ctx.strokeStyle = colors.bus;
      const end = trace.truncated
        ? Number(trace.events.at(-1)?.[0] ?? from)
        : to;
      const range = drawAnalog(
        ctx,
        trace.events,
        from,
        end,
        xAt,
        high,
        low,
        trace.linear,
      );
      if (range) {
        ctx.fillStyle = colors.muted;
        label(
          range.min.toPrecision(4) +
            " – " +
            range.max.toPrecision(4) +
            (trace.unit ? " " + trace.unit : ""),
          18,
          mid + 15,
          left - 36,
        );
      }
      continue;
    }
    const scalarY = (value: string) =>
      value === "1" ? high : value === "0" ? low : mid;
    for (const [index, [time, value]] of trace.events.entries()) {
      const x = xAt(Number(time));
      const next = trace.events[index + 1];
      // When events were clipped by the reader, do not draw the last value beyond its timestamp.
      const after = next ? xAt(Number(next[0])) : trace.truncated ? x : right;
      const known = /^[01]+$/.test(value);
      const color = !known
        ? colors.unknown
        : trace.width === 1
          ? colors.digital
          : colors.bus;
      if (trace.width === 1) {
        const y = scalarY(value);
        stroke(color, [
          [x, y],
          [after, y],
          [after, next ? scalarY(next[1]) : y],
        ]);
      } else {
        const inset = Math.min(4, (after - x) / 2);
        stroke(color, [
          [x, mid],
          [x + inset, high],
          [after - inset, high],
          [after, mid],
          [after - inset, low],
          [x + inset, low],
          [x, mid],
        ]);
        if (after - x >= 12) {
          const decoded =
            showDecodedValues &&
            trace.decoder &&
            decodeWord(trace.decoder, value, trace.width);
          const text = decoded || compactValue(value);
          ctx.fillStyle = color;
          drawBusLabel(
            ctx,
            text,
            x,
            after,
            mid + 4,
            busLabelMode,
            decoded
              ? decoded.split(" ", 1)[0]
              : known
                ? text.slice(2)
                : undefined,
            !!decoded,
          );
        }
      }
      if (!next && trace.truncated) {
        ctx.fillStyle = "#493a29";
        ctx.fillRect(x, top + 4, right - x, rowHeight - 8);
        ctx.fillStyle = colors.unknown;
        if (right - x > 75) ctx.fillText("TRUNCATED", x + 7, mid + 4);
      }
    }
  }

  for (const marker of clip.markers) {
    const x = xAt(marker.time);
    const color = /^#[0-9a-f]{6}$/i.test(marker.color || "")
      ? marker.color
      : "#e8b86d";
    ctx.setLineDash?.([4, 4]);
    stroke(color, [
      [x, header],
      [x, height - 31],
    ]);
    ctx.setLineDash?.([]);
  }
  for (const [index, decoder] of (clip.decoders ?? []).entries()) {
    const middle = header + rowHeight * (clip.traces.length + index + 0.5);
    ctx.fillStyle = colors.foreground;
    label(decoder.id, 18, middle, left - 36);
    for (const item of decoder.result.transactions) {
      const first = xAt(Math.max(from, Number(item.start)));
      const last = xAt(Math.min(to, Number(item.end)));
      if (last <= first) continue;
      ctx.strokeStyle =
        item.severity && item.severity !== "info" ? colors.unknown : colors.bus;
      ctx.strokeRect(first, middle - 11, last - first, 22);
      label(item.label, first + 3, middle, last - first - 6);
    }
  }
  ctx.fillStyle = clip.truncated ? colors.unknown : colors.muted;
  const markers = clip.markers
    .map((m) => `${m.name} @ ${m.time}`)
    .join("  |  ");
  ctx.fillText(
    clip.truncated
      ? "Truncated traces stop at their last recorded event."
      : markers || "Wave Workbench",
    18,
    height - 10,
    width - 36,
  );
}
