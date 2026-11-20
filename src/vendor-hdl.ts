// SPDX-License-Identifier: MPL-2.0

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import type { DesignSession } from "./kdb";
import { mapPrefix } from "./kdb";
import type { HdlLocation, Location } from "./shared/protocol";

const exec = promisify(execFile);
const maxIndexBytes = 128 * 1024 * 1024;

export function shmDirectory(waveform: string) {
  const directory = /\.shm$/i.test(waveform)
    ? waveform
    : path.dirname(waveform);
  return /\.shm$/i.test(directory) ? directory : undefined;
}

export function shmSourceIndex(waveform: string) {
  const directory = shmDirectory(waveform);
  return directory && directory + ".hdl.json";
}

function validPosition(value: HdlLocation["declaration"]) {
  return value &&
    typeof value.file === "string" &&
    value.file &&
    Number.isSafeInteger(value.line) &&
    value.line > 0
    ? value
    : undefined;
}

export async function readHdlIndex(filename: string): Promise<HdlLocation[]> {
  if ((await fs.stat(filename)).size > maxIndexBytes)
    throw Error("HDL index exceeds 128 MiB");
  const index = JSON.parse(await fs.readFile(filename, "utf8"));
  if (index?.version !== 1 || !Array.isArray(index.locations))
    throw Error("Invalid SHM HDL source index");
  return index.locations;
}

export async function exportXceliumHdl(
  shim: string,
  home: string | undefined,
  directory: string,
  filename: string,
) {
  const temp = await fs.mkdtemp(path.join(tmpdir(), "wave-hdl-"));
  try {
    const library = path.join(temp, "hdl.so");
    const output = path.join(temp, "locations.jsonl");
    const commands = path.join(temp, "export.tcl");
    const xrun = home ? path.join(home, "tools", "bin", "xrun") : "xrun";
    const include = home && path.join(home, "tools", "include");
    if (!include || !existsSync(path.join(include, "vpi_user.h")))
      throw Error(
        "请设置 waveWorkbench.xceliumHome 或 XCELIUM_HOME，指向含 VPI 头文件的安装目录。",
      );
    await exec("cc", ["-shared", "-fPIC", "-I", include, shim, "-o", library], {
      timeout: 20_000,
    });
    await fs.writeFile(commands, "exit\n");
    await exec(
      xrun,
      [
        "-64bit",
        "-R",
        "-loadvpisim",
        library + ":wave_workbench_hdl_boot",
        "-input",
        commands,
        "-l",
        path.join(temp, "xrun.log"),
      ],
      {
        cwd: directory,
        timeout: 90_000,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, WAVE_WORKBENCH_HDL_OUTPUT: output },
      },
    );
    if (!existsSync(output) || (await fs.stat(output)).size > maxIndexBytes)
      throw Error(
        "Xcelium 没有导出可用的 HDL 索引，请确认选中了原仿真快照目录。",
      );
    const locations: HdlLocation[] = (await fs.readFile(output, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    if (!locations.some((location) => validPosition(location.declaration)))
      throw Error("Xcelium 快照缺少 HDL 源文件位置。");
    for (const row of locations)
      for (const position of [row.declaration, row.instance])
        if (position?.file)
          position.file = path.resolve(directory, position.file);
    // Write atomically in the same directory so other viewers cannot read a partial index.
    const staged = filename + "." + path.basename(temp);
    try {
      await fs.writeFile(staged, JSON.stringify({ version: 1, locations }), {
        flag: "wx",
      });
      await fs.rename(staged, filename);
    } finally {
      await fs.unlink(staged).catch(() => undefined);
    }
    return locations;
  } finally {
    await fs.rm(temp, { force: true, recursive: true });
  }
}

export class VendorHdlDesign implements DesignSession {
  readonly kind = "vendor-hdl";
  private records = new Map<string, Location>();
  private byParent = new Map<string, Location[]>();
  private byModule = new Map<string, Location[]>();
  private parents = new Map<string, string>();
  private aliases = new Map<string, Location | null>();

  private constructor(readonly path: string) {}

  static async open(
    filename: string,
    source: HdlLocation[],
    mappings?: Record<string, string>,
  ) {
    const design = new VendorHdlDesign(filename);
    const rows = new Map<string, HdlLocation>();
    for (const row of source) {
      if (
        !row ||
        typeof row.fullname !== "string" ||
        !row.fullname ||
        typeof row.scope !== "boolean"
      )
        continue;
      const previous = rows.get(row.fullname);
      if (previous && (validPosition(previous.declaration) || !row.declaration))
        continue;
      rows.set(row.fullname, row);
    }
    const files = new Map<string, Promise<string[]>>();
    const parentName = (row: HdlLocation) =>
      row.parent ??
      row.fullname.slice(0, Math.max(0, row.fullname.lastIndexOf(".")));
    for (const row of rows.values()) {
      if (!row.scope) continue;
      const parent = parentName(row);
      const declaration = validPosition(row.declaration);
      const instance =
        validPosition(row.instance) ?? (!parent ? declaration : undefined);
      let module = typeof row.module === "string" ? row.module : "";
      let kind = module
        ? "npiModule"
        : row.generate
          ? "npiGenScope"
          : "npiNamedBegin";
      if (!module && declaration) {
        const file = path.resolve(
          path.dirname(filename),
          mapPrefix(declaration.file, mappings),
        );
        let lines = files.get(file);
        if (!lines) {
          lines = fs
            .stat(file)
            .then((stat) =>
              stat.isFile() && stat.size <= 16 * 1024 * 1024
                ? fs.readFile(file, "utf8").then((text) => text.split(/\r?\n/))
                : [],
            )
            .catch(() => []);
          files.set(file, lines);
        }
        const text = (await lines)[declaration.line - 1] ?? "";
        const found =
          /\b(module|interface|program|entity|architecture)\s+(?:(?:automatic|static)\s+)?(\\\S+|[\w$]+)(?:\s+of\s+([\w$]+))?/i.exec(
            text,
          );
        if (found) {
          module = (found[3] ?? found[2]).replace(/^\\/, "");
          kind = found[1] === "interface" ? "npiInterface" : "npiModule";
        }
      }
      design.add(row.fullname, parent, {
        fullname: row.fullname,
        kind,
        module,
        instance: row.fullname,
        file: instance?.file ?? "",
        line: instance?.line ?? 0,
        definitionFile: declaration?.file ?? "",
        definitionLine: declaration?.line ?? 0,
      });
    }
    for (const row of rows.values()) {
      if (row.scope) continue;
      const instance = parentName(row);
      let owner = design.records.get(instance);
      while (owner && !owner.module) {
        const parent = design.parents.get(owner.fullname);
        // Reject malformed cycles and preserve file navigation for named scopes.
        owner =
          parent && parent.length < owner.fullname.length
            ? design.records.get(parent)
            : undefined;
      }
      const declaration = validPosition(row.declaration);
      design.add(row.fullname, instance, {
        fullname: row.fullname,
        kind: "npiNet",
        instance: owner?.instance ?? instance,
        module: owner?.module ?? "",
        file: declaration?.file ?? "",
        line: declaration?.line ?? 0,
        definitionFile: owner?.definitionFile ?? "",
        definitionLine: owner?.definitionLine ?? 0,
      });
    }
    for (const row of rows.values()) {
      if (row.waveName && row.waveName !== row.fullname) {
        const location = design.records.get(row.fullname);
        if (!location) continue;
        design.aliases.set(
          row.waveName,
          design.aliases.has(row.waveName) ? null : location,
        );
      }
    }
    if (!design.records.size) throw Error("HDL 索引为空。");
    return design;
  }

  private add(fullname: string, parent: string, record: Location) {
    this.records.set(fullname, record);
    this.parents.set(fullname, parent);
    const children = this.byParent.get(parent) ?? [];
    children.push(record);
    this.byParent.set(parent, children);
    if (record.instance === fullname && record.module) {
      const list = this.byModule.get(record.module) ?? [];
      list.push(record);
      this.byModule.set(record.module, list);
    }
  }

  async resolve(fullname: string) {
    return (
      this.records.get(fullname) ?? this.aliases.get(fullname) ?? undefined
    );
  }

  async children(fullname = "", all = false) {
    const children = this.byParent.get(fullname) ?? [];
    return children.filter(
      ({ fullname, instance, kind }) =>
        fullname === instance &&
        (all || ["npiModule", "npiInterface", "npiGenScope"].includes(kind)),
    );
  }

  async instances(module: string) {
    return this.byModule.get(module) ?? [];
  }

  async parent(fullname: string) {
    return this.parents.get(fullname) ?? "";
  }

  dispose() {
    this.records.clear();
    this.byParent.clear();
    this.byModule.clear();
    this.parents.clear();
    this.aliases.clear();
  }
}
