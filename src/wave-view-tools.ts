// SPDX-License-Identifier: MPL-2.0

import type { Backend } from "./backend";
import type { Metadata } from "./shared/protocol";
import { findSignal } from "./signal-lookup";

export async function editWaveView(
  view: {
    backend: Backend;
    meta: Metadata;
    ui(action: string, args?: unknown): Promise<unknown>;
  },
  args: Record<string, unknown>,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const tick = (name: string) => {
    const raw = args[name];
    const time = Number(raw);
    if (
      typeof raw !== "string" ||
      !/^\d+$/.test(raw) ||
      !Number.isSafeInteger(time) ||
      time < Number(view.meta.start) ||
      time > Number(view.meta.end)
    )
      throw Error(`Specify ${name} as a tick within the open waveform.`);
    return time;
  };
  switch (args.action) {
    case "snapshot":
      return view.ui("snapshot");
    case "add":
    case "remove":
    case "select": {
      const selectors = args.signals as string[] | undefined;
      if (!selectors?.length) throw Error("Specify the signals to change.");
      const signals = await Promise.all(
        selectors.map((name) => findSignal(view.backend, name)),
      );
      signal.throwIfAborted();
      if (signals.some((signal) => !signal.supported))
        throw Error("A selected signal has an unsupported encoding.");
      const action = {
        add: "addSignals",
        remove: "deleteSignals",
        select: "selectSignals",
      }[args.action];
      await view.ui(action, { signals, reveal: args.reveal === true });
      break;
    }
    case "window": {
      const start = tick("start");
      const end = tick("end");
      if (start >= end) throw Error("Choose a non-empty waveform window.");
      await view.ui("window", { start, end });
      break;
    }
    case "cursor":
      await view.ui("cursor", {
        time: tick("tick"),
        reveal: args.reveal === true,
      });
      break;
    case "marker":
      await view.ui("marker", {
        time: tick("tick"),
        name: args.name ?? "B",
        keepView: args.reveal !== true,
      });
      break;
    case "fit":
      await view.ui("fit");
      break;
    default:
      throw Error("Unknown waveform view action.");
  }
  return { changed: true };
}
