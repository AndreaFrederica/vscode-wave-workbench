// SPDX-License-Identifier: MPL-2.0

import type { Backend } from "./backend";
import type { DecoderScheduler } from "./decoder-runtime/scheduler";
import type { DecoderInstance } from "./decoder-runtime/types";
import type { decoderRegistry } from "./decoder-runtime/registry";
import type { Metadata } from "./shared/protocol";
import { findSignal } from "./signal-lookup";

export async function decodeWaveWindow(
  source: { backend: Backend; meta: Metadata },
  scheduler: DecoderScheduler,
  registry: Awaited<ReturnType<typeof decoderRegistry>>,
  instance: DecoderInstance,
  start: string,
  end: string,
  signal?: AbortSignal,
) {
  const { definitions } = registry;
  const definition = definitions.get(instance.decoderId);
  if (!definition)
    throw Error("Decoder not found or disabled: " + instance.decoderId);
  if (
    instance.engine !== undefined &&
    instance.engine !== definition.manifest.engine
  )
    throw Error("The saved decoder engine no longer matches its definition.");
  const { backend, meta } = source;
  if (
    !instance.bindings ||
    typeof instance.bindings !== "object" ||
    Array.isArray(instance.bindings) ||
    Object.keys(instance.bindings).some(
      (id) => !definition.manifest.inputs.some((input) => input.id === id),
    )
  )
    throw Error("Invalid decoder signal binding.");
  const bindings = await Promise.all(
    definition.manifest.inputs.map(async ({ id, width, required, real }) => {
      const name = instance.bindings[id];
      if (name === undefined && required === false) return null;
      if (typeof name !== "string" || !name || name.length > 1024)
        throw Error("Bind decoder input " + id);
      const bound = await findSignal(backend, name);
      if (!!bound.real !== !!real)
        throw Error("Incompatible signal type for decoder input " + id);
      if (
        bound.width < 1 ||
        bound.width > 4096 ||
        (width !== undefined && bound.width !== width)
      )
        throw Error("Incompatible width for decoder input " + id);
      return bound;
    }),
  );
  if (!bindings.some(Boolean))
    throw Error("Select at least one waveform signal.");
  return scheduler.decode({
    provider: { backend, meta },
    definition,
    bindings,
    options: instance.options,
    start,
    end,
    signal,
  });
}
