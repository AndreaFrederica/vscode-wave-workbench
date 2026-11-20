// SPDX-License-Identifier: MPL-2.0

import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LiveWaveSample, LiveWaveWindow } from "./shared/live-wave";

interface Block {
  first: bigint;
  last: bigint;
  offset: number;
  length: number;
  count: number;
}

function upperBound<T>(
  items: readonly T[],
  tick: bigint,
  coordinate: (item: T) => bigint,
) {
  let first = 0;
  let last = items.length;
  while (first < last) {
    const middle = Math.floor((first + last) / 2);
    if (coordinate(items[middle]) <= tick) first = middle + 1;
    else last = middle;
  }
  return first;
}

export class LiveWaveHistory {
  private directory?: string;
  private readonly blocks: Block[] = [];
  private offset = 0;
  private pending: LiveWaveSample[] = [];
  private pendingSize = 0;
  private latestSize = 0;
  private firstTick?: string;
  private latest?: LiveWaveSample;
  private overview: { index: number; size: number; sample: LiveWaveSample }[] =
    [];
  private overviewSize = 0;
  private tail: { size: number; sample: LiveWaveSample }[] = [];
  private tailSize = 0;
  private overviewStride = 1;
  private index = -1;
  private revision = 0;
  private failure?: string;
  private disposed = false;

  constructor(
    private readonly chunkPoints = 256,
    private readonly chunkBytes = 256 * 1024,
    private readonly overviewPoints = 512,
  ) {}

  push(sample: LiveWaveSample) {
    if (this.failure || this.disposed) return;
    let size = sample.tick.length + 32;
    for (const [name, value] of Object.entries(sample.values))
      size += (name.length + value.length) * 2 + 8;
    const repeated = this.latest?.tick === sample.tick;
    if (repeated) {
      this.pending[this.pending.length - 1] = sample;
      this.pendingSize -= this.latestSize;
      this.tailSize -= this.tail.pop()!.size;
      if (this.overview.at(-1)?.index === this.index) {
        this.overviewSize -= this.overview.pop()!.size;
      }
    } else {
      if (
        this.pending.length >= this.chunkPoints ||
        this.pendingSize >= this.chunkBytes
      ) {
        try {
          this.flush();
        } catch (error) {
          this.failure = error instanceof Error ? error.message : String(error);
          this.revision++;
          return;
        }
      }
      this.index++;
      this.pending.push(sample);
    }
    this.firstTick ??= sample.tick;
    this.pendingSize += size;
    this.latest = sample;
    this.latestSize = size;
    this.revision++;
    this.tail.push({ size, sample });
    this.tailSize += size;
    while (
      this.tail.length > 128 ||
      (this.tail.length > 1 && this.tailSize > 256 * 1024)
    )
      this.tailSize -= this.tail.shift()!.size;
    if (this.index % this.overviewStride === 0) {
      this.overview.push({ index: this.index, size, sample });
      this.overviewSize += size;
    }
    while (
      this.overview.length > this.overviewPoints ||
      (this.overview.length > 2 && this.overviewSize > 512 * 1024)
    ) {
      this.overviewStride *= 2;
      this.overview = this.overview.filter(
        ({ index }) => index % this.overviewStride === 0,
      );
      this.overviewSize = this.overview.reduce(
        (sum, item) => sum + item.size,
        0,
      );
    }
  }

  private flush() {
    this.directory ??= mkdtempSync(join(tmpdir(), "wave-workbench-live-"));
    const block = Buffer.from(JSON.stringify(this.pending), "utf8");
    appendFileSync(join(this.directory, "samples"), block);
    this.blocks.push({
      first: BigInt(this.pending[0].tick),
      last: BigInt(this.pending.at(-1)!.tick),
      offset: this.offset,
      length: block.length,
      count: this.pending.length,
    });
    this.offset += block.length;
    this.pending = [];
    this.pendingSize = 0;
  }

  overviewFrame() {
    const tailStart = this.index - this.tail.length + 1;
    const samples = this.overview
      .filter(({ index }) => index < tailStart)
      .map(({ sample }) => sample);
    samples.push(...this.tail.map(({ sample }) => sample));
    return {
      revision: this.revision,
      firstTick: this.firstTick,
      lastTick: this.latest?.tick,
      historyFailure: this.failure,
      approximate: samples.length < this.index + 1,
      samples,
    };
  }

  private async readBlock(
    file: FileHandle,
    block: Block,
  ): Promise<LiveWaveSample[]> {
    const buffer = Buffer.alloc(block.length);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(
        buffer,
        offset,
        buffer.length - offset,
        block.offset + offset,
      );
      if (!bytesRead) throw Error("Live wave history ended inside a block.");
      offset += bytesRead;
    }
    const samples: LiveWaveSample[] = JSON.parse(buffer.toString("utf8"));
    return samples;
  }

  async page(start: bigint, end: bigint, limit: number, signal: AbortSignal) {
    if (this.disposed || !this.latest)
      return { samples: [], approximate: false };
    const pending = this.pending.slice();
    const first = upperBound(this.blocks, start - 1n, (block) => block.last);
    const last = upperBound(this.blocks, end, (block) => block.first);
    const samples: LiveWaveSample[] = [];
    let bytes = 0;
    const add = (batch: LiveWaveSample[]) => {
      for (const sample of batch) {
        const tick = BigInt(sample.tick);
        if (tick < start || tick > end) continue;
        bytes += Buffer.byteLength(JSON.stringify(sample));
        if (
          samples.length > 0 &&
          (samples.length >= limit || bytes > 768 * 1024)
        )
          return sample.tick;
        samples.push(sample);
      }
    };
    const file =
      first < last
        ? await open(join(this.directory!, "samples"), "r")
        : undefined;
    try {
      for (let index = first; index < last; index++) {
        signal.throwIfAborted();
        const nextStart = add(await this.readBlock(file!, this.blocks[index]));
        if (nextStart !== undefined)
          return { samples, approximate: false, nextStart };
      }
      signal.throwIfAborted();
      const nextStart = add(pending);
      return { samples, approximate: false, nextStart };
    } finally {
      await file?.close();
    }
  }

  async read(
    start: bigint,
    end: bigint,
    cursor: bigint,
  ): Promise<LiveWaveWindow> {
    if (this.disposed || !this.latest)
      return { samples: [], approximate: false };
    const pending = this.pending.slice();
    const first = Math.max(
      0,
      upperBound(this.blocks, start, (block) => block.last) - 1,
    );
    const last = upperBound(this.blocks, end, (block) => block.first);
    const cursorBlock = Math.max(
      0,
      upperBound(this.blocks, cursor, (block) => block.first) - 1,
    );
    const cursorInPending =
      pending.length > 0 && BigInt(pending[0].tick) <= cursor;
    const path = this.directory && join(this.directory, "samples");
    // A coarse window uses a bounded overview. A point query still reads the exact sample.
    const blocks =
      last - first <= 8 ? this.blocks.slice(first, last) : undefined;
    const sample = (samples: LiveWaveSample[], tick: bigint) =>
      samples[upperBound(samples, tick, (item) => BigInt(item.tick)) - 1];
    const overview = this.overviewFrame();
    const index = this.blocks[cursorBlock];
    const file =
      path && (blocks?.length || (!cursorInPending && index))
        ? await open(path, "r")
        : undefined;
    try {
      const loaded = new Map<number, LiveWaveSample[]>();
      const readBlock = async (block: Block) => {
        const cached = loaded.get(block.offset);
        if (cached) return cached;
        const samples = await this.readBlock(file!, block);
        loaded.set(block.offset, samples);
        return samples;
      };
      const count = blocks?.reduce(
        (sum, block) => sum + block.count,
        pending.length,
      );
      const bytes = blocks?.reduce(
        (sum, block) => sum + block.length,
        this.pendingSize,
      );
      const exact = blocks && count! <= 4096 && bytes! <= 2 * 1024 * 1024;
      const series: LiveWaveSample[] = [];
      if (exact) {
        for (const block of blocks) series.push(...(await readBlock(block)));
        series.push(...pending);
      } else series.push(...overview.samples);
      const from = Math.max(
        0,
        upperBound(series, start, (item) => BigInt(item.tick)) - 1,
      );
      const to = upperBound(series, end, (item) => BigInt(item.tick));
      const cursorSample = cursorInPending
        ? sample(pending, cursor)
        : index && sample(await readBlock(index), cursor);
      return {
        samples: series.slice(from, to),
        approximate: !exact && overview.approximate,
        cursor: cursorSample,
      };
    } finally {
      await file?.close();
    }
  }

  dispose() {
    this.disposed = true;
    if (this.directory)
      rmSync(this.directory, { recursive: true, force: true });
  }
}
