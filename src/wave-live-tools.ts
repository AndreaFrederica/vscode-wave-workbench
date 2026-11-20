// SPDX-License-Identifier: MPL-2.0

import * as path from "node:path";
import {
  isStatementEventKind,
  LiveTraceSession,
  parseLiveLaunch,
} from "./rtl-live-trace";

export function simulationIsActive(session: LiveTraceSession | undefined) {
  return session && !["exited", "error"].includes(session.status().state);
}

export async function launchSimulation(
  root: string,
  args: Record<string, unknown>,
  log: (message: string) => void,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const program = path.resolve(root, String(args.program));
  const settings = parseLiveLaunch({
    workingDirectory:
      typeof args.cwd === "string" ? path.resolve(root, args.cwd) : root,
    plusargs: args.plusargs,
    stimulusFiles: args.stimulusFiles,
  });
  const vcs =
    args.backend === "vcs"
      ? {
          signals: (args.signals ?? []) as string[],
          recording:
            typeof args.recording === "string"
              ? path.resolve(root, args.recording)
              : undefined,
          statementScopes: args.statementScopes as string[] | undefined,
        }
      : undefined;
  if (!vcs && (args.signals || args.recording || args.statementScopes))
    throw Error(
      "Watch signals, recording, and statement scopes require the VCS provider.",
    );
  const session = await LiveTraceSession.start(
    program,
    root,
    log,
    vcs,
    settings,
  );
  if (signal.aborted) {
    session.dispose();
    session.disposeWaveHistory();
    signal.throwIfAborted();
  }
  return session;
}

export async function controlSimulation(
  session: LiveTraceSession,
  args: Record<string, unknown>,
  operation: AbortSignal,
) {
  operation.throwIfAborted();
  if (args.action === "pause") return session.pause();
  if (args.action === "resume") return session.resume();
  if (args.action === "stepClock" && typeof args.signal === "string")
    return session.stepClock(args.signal, Number(args.cycles ?? 1), operation);
  if (
    args.action === "setBreakpoint" &&
    typeof args.signal === "string" &&
    typeof args.value === "string"
  )
    return session.setBreakpoint({ signal: args.signal, value: args.value });
  if (args.action === "clearBreakpoint") return session.setBreakpoint();
  if (
    args.action === "setStatementBreakpoint" &&
    typeof args.instance === "string" &&
    typeof args.statementId === "string"
  ) {
    const { eventKind = "assignment-evaluated" } = args;
    const timing =
      args.timing === "simulator-commit" || args.timing === "end-of-slot"
        ? args.timing
        : undefined;
    if (
      isStatementEventKind(eventKind) &&
      (args.timing === undefined || timing !== undefined)
    )
      return session.setBreakpoint({
        instance: args.instance,
        statementId: args.statementId,
        eventKind,
        ...(timing === undefined ? {} : { timing }),
      });
  }
  throw Error("Live action arguments are incomplete.");
}

export async function simulationHistory(
  session: LiveTraceSession,
  args: Record<string, unknown>,
  signal: AbortSignal,
) {
  const overview = session.waveUpdate();
  if (
    args.start === undefined &&
    args.end === undefined &&
    args.cursor === undefined &&
    args.limit === undefined
  )
    return overview;
  const { samples: _, ...metadata } = overview;
  const [start, end, cursor] = [
    args.start ?? overview.firstTick,
    args.end ?? overview.lastTick,
    args.cursor ?? args.start ?? overview.firstTick,
  ];
  if (
    ![start, end, cursor].every(
      (tick) => typeof tick === "string" && /^\d{1,20}$/.test(tick),
    )
  )
    throw Error("Specify history bounds and cursor as decimal tick strings.");
  if (BigInt(String(start)) > BigInt(String(end)))
    throw Error("The end tick precedes the start tick.");
  if (args.limit !== undefined)
    return {
      ...metadata,
      ...(await session.readWavePage(
        BigInt(String(start)),
        BigInt(String(end)),
        Number(args.limit),
        signal,
      )),
    };
  return {
    ...metadata,
    ...(await session.readWaveWindow(
      BigInt(String(start)),
      BigInt(String(end)),
      BigInt(String(cursor)),
    )),
  };
}
