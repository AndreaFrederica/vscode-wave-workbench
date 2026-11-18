// SPDX-License-Identifier: MPL-2.0

import { readFile, stat } from "node:fs/promises";
import { builtinProfiles, validateProfile } from "./shared/decoders";

export async function loadDecoderProfiles(filename?: string) {
  const profiles = new Map(builtinProfiles.map((p) => [p.id, p]));
  if (!filename) return [...profiles.values()];
  let document: { version: number; profiles: unknown[] };
  try {
    const info = await stat(filename);
    if (!info.isFile() || info.size > 512 * 1024)
      throw Error("解码配置文件大小上限为 512 KiB");
    document = JSON.parse(await readFile(filename, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return [...profiles.values()];
    throw Error(filename + " · " + (error as Error).message);
  }
  if (
    document?.version !== 1 ||
    !Array.isArray(document.profiles) ||
    document.profiles.length > 64
  )
    throw Error("配置需要 version 为 1，profiles 最多 64 项");
  for (const item of document.profiles) {
    const profile = validateProfile(item);
    if (profiles.has(profile.id))
      throw Error("重复的解码配置 ID " + profile.id);
    profiles.set(profile.id, profile);
  }
  return [...profiles.values()];
}
