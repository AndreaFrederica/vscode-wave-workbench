// SPDX-License-Identifier: MPL-2.0

import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";

const maxEntryBytes = 2 * 1024 * 1024;
const slotCount = 32;

function digest(data: string | Buffer) {
  return createHash("sha256").update(data).digest("hex");
}

async function cacheSlot(key: string) {
  const directory =
    process.env.WAVE_WORKBENCH_REPLAY_CACHE_DIR ??
    path.join(homedir(), ".wave-workbench", "execution-index-v1");
  if (!path.isAbsolute(directory)) return;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  const uid = process.getuid?.();
  if (
    !info.isDirectory() ||
    (uid !== undefined && (info.uid !== uid || info.mode & 0o077))
  )
    return;
  const slot = Number.parseInt(digest(key).slice(0, 8), 16) % slotCount;
  return path.join(directory, slot + ".json");
}

export async function readReplayCache(key: string): Promise<unknown> {
  try {
    const filename = await cacheSlot(key);
    if (!filename || !(await lstat(filename)).isFile()) return;
    const file = await open(filename, "r");
    try {
      const info = await file.stat();
      const uid = process.getuid?.();
      if (
        !info.isFile() ||
        info.size < 66 ||
        info.size > maxEntryBytes ||
        (uid !== undefined && (info.uid !== uid || info.mode & 0o077))
      )
        return;
      const data = Buffer.alloc(info.size + 1);
      const { bytesRead } = await file.read(data);
      if (bytesRead !== info.size || data[64] !== 10) return;
      const json = data.subarray(65, bytesRead);
      if (digest(json) !== data.toString("ascii", 0, 64)) return;
      const entry = JSON.parse(json.toString("utf8"));
      if (entry?.key === key) return entry.value;
    } finally {
      await file.close();
    }
  } catch {
    // A missing or unreadable cache leaves the recording as the source of truth.
  }
}

export async function writeReplayCache(key: string, value: unknown) {
  let temporary: string | undefined;
  try {
    const filename = await cacheSlot(key);
    if (!filename) return;
    const json = JSON.stringify({ key, value });
    if (Buffer.byteLength(json) + 65 > maxEntryBytes) return;
    temporary = filename + "." + randomUUID() + ".tmp";
    await writeFile(temporary, digest(json) + "\n" + json, {
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, filename);
    temporary = undefined;
  } catch {
    // Cache writes are optional, including when another process owns the slot.
  } finally {
    if (temporary) await unlink(temporary).catch(() => {});
  }
}
