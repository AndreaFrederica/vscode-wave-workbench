// SPDX-License-Identifier: MPL-2.0

import * as fs from "node:fs";
import * as path from "node:path";
import { mapPrefix } from "./kdb";

export type RtlNavigationTarget = "design" | "testbench";

export interface RtlProjectBinding {
  designRoot: string;
  testbenchRoot: string;
  dutInstance: string;
  waveformScope?: string;
  target?: RtlNavigationTarget;
  sourcePathMappings?: Record<string, string>;
}

export function readRtlProjectBinding(value: unknown, directory: string) {
  if (value === undefined) return;
  const binding = value as Partial<RtlProjectBinding>;
  const valid = (text: unknown): text is string =>
    typeof text === "string" && Boolean(text.trim()) && !text.includes("\0");
  if (
    !binding ||
    !valid(binding.designRoot) ||
    !valid(binding.testbenchRoot) ||
    !valid(binding.dutInstance) ||
    (binding.waveformScope !== undefined && !valid(binding.waveformScope)) ||
    (binding.target !== undefined &&
      binding.target !== "design" &&
      binding.target !== "testbench")
  )
    throw Error("Invalid RTL project binding.");
  const mappings = binding.sourcePathMappings;
  if (
    mappings !== undefined &&
    (!mappings ||
      typeof mappings !== "object" ||
      Array.isArray(mappings) ||
      Object.entries(mappings).some(([from, to]) => !valid(from) || !valid(to)))
  )
    throw Error("Invalid source path mappings in the RTL project binding.");
  const resolve = (file: string) => path.resolve(directory, file);
  return mapBindingPaths(binding as RtlProjectBinding, resolve);
}

export function mapBindingPaths(
  binding: RtlProjectBinding,
  map: (file: string) => string,
): RtlProjectBinding {
  return {
    designRoot: map(binding.designRoot),
    testbenchRoot: map(binding.testbenchRoot),
    dutInstance: binding.dutInstance,
    waveformScope: binding.waveformScope,
    target: binding.target,
    sourcePathMappings:
      binding.sourcePathMappings &&
      Object.fromEntries(
        Object.entries(binding.sourcePathMappings).map(([from, to]) => [
          from,
          map(to),
        ]),
      ),
  };
}

export function boundSourceMappings(
  binding?: RtlProjectBinding,
  settings?: Record<string, string>,
) {
  return { ...settings, ...binding?.sourcePathMappings };
}

export function boundHierarchyMappings(
  binding?: RtlProjectBinding,
  settings?: Record<string, string>,
) {
  return binding?.waveformScope
    ? { ...settings, [binding.waveformScope]: binding.dutInstance }
    : settings;
}

export function resolveBoundSource(
  file: string,
  directory: string,
  binding?: RtlProjectBinding,
  settings?: Record<string, string>,
) {
  const mapped = mapPrefix(file, boundSourceMappings(binding, settings));
  const resolved = path.resolve(directory, mapped);
  if (
    !binding ||
    path.isAbsolute(mapped) ||
    mapped !== file ||
    isFile(resolved)
  )
    return resolved;
  const matches = [
    ...new Set(
      [binding.designRoot, binding.testbenchRoot].map((root) =>
        path.resolve(root, file),
      ),
    ),
  ].filter(isFile);
  if (matches.length > 1)
    throw Error(
      "Multiple RTL source paths match " +
        file +
        ". Configure a source path mapping in the waveform project.",
    );
  return matches[0] ?? resolved;
}

function isFile(filename: string) {
  return fs.statSync(filename, { throwIfNoEntry: false })?.isFile() ?? false;
}

export function belongsToBoundDut(
  binding: RtlProjectBinding | undefined,
  file: string,
  scope: string,
) {
  if (!binding || !inDirectory(file, binding.designRoot)) return true;
  if (
    inDirectory(file, binding.testbenchRoot) &&
    inDirectory(binding.testbenchRoot, binding.designRoot)
  )
    return true;
  return (
    scope === binding.dutInstance || scope.startsWith(binding.dutInstance + ".")
  );
}

export function rtlSourceTarget(
  binding: RtlProjectBinding,
  file: string,
): RtlNavigationTarget | undefined {
  const design = inDirectory(file, binding.designRoot);
  const testbench = inDirectory(file, binding.testbenchRoot);
  if (design && testbench) {
    if (binding.designRoot === binding.testbenchRoot) return;
    return inDirectory(binding.designRoot, binding.testbenchRoot)
      ? "design"
      : "testbench";
  }
  return design ? "design" : testbench ? "testbench" : undefined;
}

export function inDirectory(file: string, directory: string) {
  const relative = path.relative(directory, file);
  return (
    !path.isAbsolute(relative) &&
    relative !== ".." &&
    !relative.startsWith(".." + path.sep)
  );
}
