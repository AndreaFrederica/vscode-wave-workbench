// SPDX-License-Identifier: MPL-2.0

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import {
  builtinGroups,
  validateProfile,
  type DecoderCatalog,
  type DecoderGroup,
  type DecoderProfile,
} from "./shared/decoders";

function workspaceDirectory(legacy: string) {
  return path.join(path.dirname(legacy), "wave-decoders");
}

async function readGroup(filename: string) {
  const info = await fs.stat(filename);
  if (!info.isFile() || info.size > 512 * 1024)
    throw Error("解码配置文件大小上限为 512 KiB");
  const document = JSON.parse(await fs.readFile(filename, "utf8"));
  if (
    document?.version !== 1 ||
    !Array.isArray(document.profiles) ||
    document.profiles.length > 64
  )
    throw Error("配置需要 version 为 1，profiles 最多 64 项");
  return {
    document,
    profiles: document.profiles.map(validateProfile) as DecoderProfile[],
  };
}

export async function loadDecoderCatalog(
  legacy?: string,
): Promise<DecoderCatalog> {
  const groups = [...builtinGroups];
  const warnings: string[] = [];
  if (!legacy) return { groups, warnings };
  const directory = workspaceDirectory(legacy);
  const names = await fs
    .readdir(directory, { withFileTypes: true })
    .catch((error) => {
      if (error.code === "ENOENT") return [];
      warnings.push(directory + " · " + error.message);
      return [];
    });
  const entries = [
    ...names
      .filter((entry) => entry.isFile() && /\.json$/i.test(entry.name))
      .map(({ name }) => ({
        id: "workspace/" + name,
        filename: path.join(directory, name),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    { id: "workspace/legacy", filename: legacy },
  ];
  const ids = new Set(
    groups.flatMap((group) => group.profiles.map(({ id }) => id)),
  );
  for (const { id, filename } of entries) {
    try {
      const { document, profiles } = await readGroup(filename);
      const seen = new Set(ids);
      for (const profile of profiles) {
        if (seen.has(profile.id))
          throw Error("重复的解码配置 ID " + profile.id);
        seen.add(profile.id);
      }
      const basename = path.basename(filename);
      groups.push({
        id,
        filename: basename,
        label:
          typeof document.label === "string" && document.label.trim()
            ? document.label.trim().slice(0, 120)
            : id === "workspace/legacy"
              ? "工作区规则"
              : path.basename(basename, path.extname(basename)),
        builtin: false,
        profiles,
      });
      for (const profile of profiles) ids.add(profile.id);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        warnings.push(
          path.basename(filename) + " · " + (error as Error).message,
        );
    }
  }
  return { groups, warnings };
}

export async function loadDecoderProfiles(filename?: string) {
  const { groups } = await loadDecoderCatalog(filename);
  return groups.flatMap((group) => group.profiles);
}

const pendingSaves = new Map<string, Promise<DecoderProfile>>();
export async function saveDecoderProfile(
  legacy: string,
  groupId: string,
  original: DecoderProfile,
  edited: DecoderProfile,
  checkWritable?: (filename: string) => void,
) {
  const previous = pendingSaves.get(legacy);
  const save = (async () => {
    await previous?.catch(() => undefined);
    const { groups } = await loadDecoderCatalog(legacy);
    const group = groups.find(({ id }) => id === groupId);
    const profile = group?.profiles.find(({ id }) => id === original.id);
    if (!profile || JSON.stringify(profile) !== JSON.stringify(original))
      throw Error("规则文件已更新，请重新打开解码菜单");
    const directory = workspaceDirectory(legacy);
    if (group.builtin) {
      const suffix = randomUUID().slice(0, 8);
      const stem = profile.id.slice(0, 45) + "-copy-" + suffix;
      const copy = validateProfile({
        ...edited,
        id: stem,
        builtin: profile.builtin,
      });
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(
        path.join(directory, stem + ".json"),
        JSON.stringify(
          { version: 1, label: group.label + " 副本", profiles: [copy] },
          null,
          2,
        ) + "\n",
        { flag: "wx" },
      );
      return copy;
    }
    return updateWorkspaceProfile(
      group,
      legacy,
      original,
      edited,
      checkWritable,
    );
  })();
  pendingSaves.set(legacy, save);
  try {
    return await save;
  } finally {
    if (pendingSaves.get(legacy) === save) pendingSaves.delete(legacy);
  }
}

async function updateWorkspaceProfile(
  group: DecoderGroup,
  legacy: string,
  original: DecoderProfile,
  edited: DecoderProfile,
  checkWritable?: (filename: string) => void,
) {
  const filename =
    group.id === "workspace/legacy"
      ? legacy
      : path.join(workspaceDirectory(legacy), group.filename);
  checkWritable?.(filename);
  const { document, profiles } = await readGroup(filename);
  const index = profiles.findIndex(({ id }) => id === original.id);
  if (index < 0 || JSON.stringify(profiles[index]) !== JSON.stringify(original))
    throw Error("规则文件已更新，请重新打开解码菜单");
  const profile = validateProfile({
    ...edited,
    id: original.id,
    builtin: original.builtin,
  });
  document.profiles[index] = profile;
  const temporary = path.join(
    path.dirname(filename),
    "." + randomUUID() + ".tmp",
  );
  try {
    await fs.writeFile(temporary, JSON.stringify(document, null, 2) + "\n", {
      flag: "wx",
    });
    await fs.rename(temporary, filename);
  } finally {
    await fs.rm(temporary, { force: true });
  }
  return profile;
}

export async function createDecoderGroup(legacy: string) {
  const directory = workspaceDirectory(legacy);
  await fs.mkdir(directory, { recursive: true });
  const id = "custom-" + randomUUID().slice(0, 8);
  const filename = path.join(directory, id + ".json");
  const profile = {
    id,
    label: "自定义状态",
    width: 2,
    rules: [
      { mask: "0x3", value: "0x0", label: "Idle" },
      { mask: "0x3", value: "0x1", label: "Active" },
    ],
  };
  await fs.writeFile(
    filename,
    JSON.stringify(
      { version: 1, label: "自定义规则", profiles: [profile] },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
  return filename;
}
