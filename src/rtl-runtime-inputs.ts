// SPDX-License-Identifier: MPL-2.0

import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  TraceBuildManifest,
  TraceRuntimeInputs,
} from "./rtl-build-verification";
import { waveformHash } from "./rtl-execution";
import type { VideTrace } from "./rtl-trace";

type FileIdentity = "matched" | "mismatched" | "missing" | "unverified";

export type RuntimeInputEvidence = {
  signal: number;
  location: NonNullable<VideTrace["frontier"][number]["location"]>;
  call: "$test$plusargs" | "$value$plusargs" | "$readmemh" | "$readmemb";
  literal: string;
  argument?: { present: boolean; value?: string };
  file?: { path: string; sha256?: string; identity: FileIdentity };
};

export async function traceRuntimeInputs(
  manifest: TraceBuildManifest,
  trace: VideTrace,
  runtime: TraceRuntimeInputs | undefined = manifest.runtime,
) {
  if (!runtime) return [];
  const { workingDirectory } = runtime;

  const canonical = (file: string) => realpath(file).catch(() => file);
  const sourceHashes = new Map(
    await Promise.all(
      manifest.files.map(
        async ({ path, sha256 }) => [await canonical(path), sha256] as const,
      ),
    ),
  );
  const sources = new Map<string, string[] | undefined>();
  const fileHashes = new Map(
    runtime.files?.map(({ path, sha256 }) => [path, sha256]),
  );
  const files = new Map<string, NonNullable<RuntimeInputEvidence["file"]>>();
  const seen = new Set<string>();
  const inputs: RuntimeInputEvidence[] = [];

  async function stimulus(filename: string) {
    const resolved = path.resolve(workingDirectory, filename);
    const existing = files.get(resolved);
    if (existing) return existing;
    const sha256 = fileHashes.get(resolved);
    let identity: FileIdentity = "unverified";
    if (sha256) {
      try {
        identity =
          (await waveformHash(resolved)) === sha256 ? "matched" : "mismatched";
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          identity = "missing";
      }
    }
    const file = { path: resolved, sha256, identity };
    files.set(resolved, file);
    return file;
  }

  for (const { signal, location, reason } of trace.frontier) {
    if (
      reason !== "unresolvedRuntimeInput" ||
      !location?.uri.startsWith("file:")
    )
      continue;
    const {
      uri,
      range: { start, end },
    } = location;
    if (!end) continue;
    const key = JSON.stringify([signal, uri, start, end]);
    if (seen.has(key)) continue;
    seen.add(key);
    if (!sources.has(uri)) {
      let lines: string[] | undefined;
      const filename = await canonical(fileURLToPath(uri));
      const sha256 = sourceHashes.get(filename);
      if (sha256) {
        try {
          const info = await stat(filename);
          if (info.isFile() && info.size <= 16 * 1024 * 1024) {
            const bytes = await readFile(filename);
            if (createHash("sha256").update(bytes).digest("hex") === sha256)
              lines = bytes.toString("utf8").split(/\r\n|\n/);
          }
        } catch {
          // The call site may be unavailable from the current source snapshot.
        }
      }
      sources.set(uri, lines);
    }
    const lines = sources.get(uri);
    if (
      !lines ||
      !lines[start.line] ||
      end.line < start.line ||
      end.line >= lines.length
    )
      continue;
    const text =
      start.line === end.line
        ? lines[start.line].slice(start.character, end.character)
        : [
            lines[start.line].slice(start.character),
            ...lines.slice(start.line + 1, end.line),
            lines[end.line].slice(0, end.character),
          ].join("\n");
    // Only associate an unambiguous literal with the source range returned by VIDE.
    const invocation =
      /^\s*(\$test\$plusargs|\$value\$plusargs|\$readmem[hb])\s*\(\s*"([^"\\\r\n]+)"\s*([,)])/.exec(
        text,
      );
    if (!invocation) continue;
    const call = invocation[1] as RuntimeInputEvidence["call"];
    const literal = invocation[2];
    const input: RuntimeInputEvidence = { signal, location, call, literal };
    if (call === "$readmemh" || call === "$readmemb") {
      if (invocation[3] !== ",") continue;
      input.file = await stimulus(literal);
    } else if (runtime.plusargs) {
      if (call === "$test$plusargs") {
        if (invocation[3] !== ")") continue;
        input.argument = {
          present: runtime.plusargs.some((arg) =>
            arg.startsWith("+" + literal),
          ),
        };
      } else {
        const format = /^([^%]*)%([bodhexfgs])$/i.exec(literal);
        if (!format || invocation[3] !== ",") continue;
        const prefix = "+" + format[1];
        const match = runtime.plusargs.find((arg) => arg.startsWith(prefix));
        const value = match?.slice(prefix.length);
        input.argument = { present: match !== undefined, value };
        if (
          format[2].toLowerCase() === "s" &&
          value &&
          fileHashes.has(path.resolve(runtime.workingDirectory, value))
        )
          input.file = await stimulus(value);
      }
    } else {
      continue;
    }
    inputs.push(input);
  }
  return inputs;
}

export function runtimeInputLabel(input: RuntimeInputEvidence) {
  const { call, literal, argument, file } = input;
  return [
    call + '("' + literal + '")',
    argument &&
      (!argument.present
        ? "argument absent"
        : argument.value === undefined
          ? "argument present"
          : "argument = " + argument.value),
    file && "file " + file.identity,
  ]
    .filter(Boolean)
    .join(" · ");
}
