// SPDX-License-Identifier: MPL-2.0

import * as path from "node:path";
import { PassThrough } from "node:stream";
import { make, registerFont, encodePNGToStream } from "pureimage";
import { clipImageSize, paintClipImage } from "./webview/clip-image";
import type { BusLabelMode, WaveClip } from "./shared/protocol";

let fontsLoaded = false;

export async function renderHeadlessClip(
  clip: WaveClip,
  labelMode: BusLabelMode,
  decoded: boolean,
) {
  if (!fontsLoaded) {
    const font = path.resolve(__dirname, "../media/DejaVuSansMono.ttf");
    registerFont(font, "monospace").loadSync();
    registerFont(font, "sans-serif").loadSync();
    fontsLoaded = true;
  }
  const { width, height } = clipImageSize(clip);
  const image = make(width, height);
  const ctx = image.getContext("2d");
  const drawMove = ctx.moveTo.bind(ctx);
  const drawLine = ctx.lineTo.bind(ctx);
  let point: [number, number];
  ctx.moveTo = (x, y) => {
    point = [x, y];
    drawMove(x, y);
  };
  ctx.lineTo = (x, y) => {
    if (point?.[0] === x && point[1] === y) return;
    point = [x, y];
    drawLine(x, y);
  };
  paintClipImage(ctx, clip, labelMode, decoded, "21px sans-serif");
  const output = new PassThrough();
  const chunks: Buffer[] = [];
  output.on("data", (chunk) => chunks.push(chunk));
  await encodePNGToStream(image, output);
  return Buffer.concat(chunks);
}
