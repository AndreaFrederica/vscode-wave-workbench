// SPDX-License-Identifier: MPL-2.0

import { createHash } from "node:crypto";
import { readFile, realpath, readdir, stat } from "node:fs/promises";
import * as path from "node:path";
import type { DecoderProfile } from "../shared/decoders";
import { idPattern, readOptions, type DecoderManifest } from "./types";

export type DecoderDefinition = {
  manifest: DecoderManifest;
  hash: string;
  source?: string;
  filename?: string;
  profile?: DecoderProfile;
};

function validateManifest(raw: unknown): DecoderManifest {
  const item = raw as DecoderManifest;
  if (
    !item ||
    item.apiVersion !== 1 ||
    typeof item.id !== "string" ||
    !idPattern.test(item.id) ||
    typeof item.name !== "string" ||
    !item.name.trim() ||
    item.name.length > 120 ||
    typeof item.version !== "string" ||
    !/^[\w.-]{1,64}$/.test(item.version) ||
    !["lua", "javascript"].includes(item.engine) ||
    typeof item.entry !== "string" ||
    !Array.isArray(item.inputs) ||
    item.inputs.length < 1 ||
    item.inputs.length > 64
  )
    throw Error("Invalid decoder manifest.");
  const ids = new Set<string>();
  const inputs = item.inputs.map((input) => {
    if (
      !input ||
      typeof input.id !== "string" ||
      !idPattern.test(input.id) ||
      ids.has(input.id) ||
      (input.width !== undefined &&
        (!Number.isInteger(input.width) ||
          input.width < 1 ||
          input.width > 4096)) ||
      (input.required !== undefined && typeof input.required !== "boolean")
    )
      throw Error("Invalid or duplicate decoder input.");
    ids.add(input.id);
    return { id: input.id, width: input.width, required: input.required };
  });
  return {
    apiVersion: 1,
    id: item.id,
    name: item.name,
    version: item.version,
    engine: item.engine,
    entry: item.entry,
    inputs,
    options: readOptions(item.options),
    capabilities: { checkpoints: item.capabilities?.checkpoints === true },
  };
}

function inside(root: string, child: string) {
  const relative = path.relative(root, child);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(".." + path.sep) ||
    path.isAbsolute(relative)
  )
    throw Error("Decoder file must be inside its extension directory.");
  return child;
}

async function textFile(filename: string) {
  const info = await stat(filename);
  if (!info.isFile() || info.size > 512 * 1024)
    throw Error("Decoder file exceeds 512 KiB.");
  return readFile(filename, "utf8");
}

export async function decoderRegistry(
  profiles: DecoderProfile[],
  workspace?: string,
) {
  const definitions = new Map<string, DecoderDefinition>();
  const warnings: string[] = [];
  for (const profile of profiles) {
    const manifest: DecoderManifest = {
      apiVersion: 1,
      id: profile.id,
      name: profile.label,
      version: "1",
      engine: "builtin",
      inputs: [{ id: "data", width: profile.width }],
    };
    definitions.set(profile.id, {
      manifest,
      profile,
      hash: JSON.stringify(profile),
    });
  }
  if (!workspace) return { definitions, warnings };
  const root = await realpath(workspace);
  for (const engine of ["lua", "javascript"] as const) {
    for (const parent of [
      path.join(root, "wave-decoders", engine),
      path.join(root, ".vscode", "wave-decoders", engine),
    ]) {
      const folders = await readdir(parent, { withFileTypes: true }).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT")
            warnings.push(parent + " · " + error.message);
          return [];
        },
      );
      for (const folder of folders.sort((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        if (!folder.isDirectory()) continue;
        try {
          const directory = inside(
            root,
            await realpath(path.join(parent, folder.name)),
          );
          const manifestText = await textFile(
            inside(
              directory,
              await realpath(path.join(directory, "decoder.json")),
            ),
          );
          const manifest = validateManifest(JSON.parse(manifestText));
          if (manifest.engine !== engine || definitions.has(manifest.id))
            throw Error("Engine mismatch or duplicate decoder ID.");
          const extension = path.extname(manifest.entry!);
          if (
            path.isAbsolute(manifest.entry!) ||
            !(engine === "lua"
              ? extension === ".lua"
              : [".js", ".cjs"].includes(extension))
          )
            throw Error("Select a Lua file or a built JavaScript entry.");
          const filename = inside(
            directory,
            await realpath(path.resolve(directory, manifest.entry!)),
          );
          const source = await textFile(filename);
          const hash = createHash("sha256")
            .update(manifestText)
            .update("\0")
            .update(source)
            .digest("hex");
          definitions.set(manifest.id, { manifest, hash, source, filename });
        } catch (error) {
          warnings.push(
            path.join(parent, folder.name) + " · " + (error as Error).message,
          );
        }
      }
    }
  }
  return { definitions, warnings };
}
