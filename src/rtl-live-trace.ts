// SPDX-License-Identifier: MPL-2.0

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import * as path from "node:path";
import { createInterface } from "node:readline";
import { isDeepStrictEqual } from "node:util";
import {
  hasWriteEventCoverage,
  isExecutionEvent,
  waveformHash,
  type ExecutionEvent,
  type readExecutionEvidence,
} from "./rtl-execution";
import {
  tracePackedSelection,
  type readTraceObservations,
} from "./rtl-trace-observations";
import type { Signal } from "./shared/protocol";
import { project } from "./shared/signals";
import { normalizeBits } from "./rtl-trace-values";
import type { TraceRuntimeInputs } from "./rtl-build-verification";
import type { LiveWaveUpdate } from "./shared/live-wave";
import { scaleSeconds } from "./shared/time";
import { LiveWaveHistory } from "./live-wave-history";

export interface LiveSnapshot {
  schemaVersion?: 1;
  tick: string;
  scale: string;
  values: Record<string, string>;
  done: boolean;
  executionEvents?: boolean;
  valueChangeEvents?: boolean;
  statementEntryEvents?: boolean;
  nbaCommitEvents?: boolean;
  modportCommitEvents?: boolean;
}

interface VcsLiveOptions {
  signals: readonly string[];
  recording?: string;
  statementScopes?: readonly string[];
}

export interface LiveLaunchOptions {
  workingDirectory?: string;
  plusargs?: readonly string[];
  stimulusFiles?: readonly string[];
}

const vcsControlArg =
  /^\+wave_(?:watch|execution_events|statement_scope)(?:=|$)/;

export function parseLiveLaunch(value: unknown): LiveLaunchOptions {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Use a JSON object for the simulation launch options.");
  const { workingDirectory, plusargs, stimulusFiles } =
    value as LiveLaunchOptions;
  const validPaths = (entry: unknown) =>
    typeof entry === "string" &&
    entry.trim().length > 0 &&
    !entry.includes("\0");
  if (
    Object.keys(value).some(
      (key) => !["workingDirectory", "plusargs", "stimulusFiles"].includes(key),
    ) ||
    (workingDirectory !== undefined && !validPaths(workingDirectory)) ||
    (plusargs !== undefined &&
      (!Array.isArray(plusargs) ||
        !plusargs.every(
          (arg) => validPaths(arg) && arg.startsWith("+") && arg.length > 1,
        ))) ||
    (stimulusFiles !== undefined &&
      (!Array.isArray(stimulusFiles) || !stimulusFiles.every(validPaths)))
  )
    throw Error(
      "Use workingDirectory, plusargs (an array of +arguments), and stimulusFiles (an array of paths).",
    );
  return { workingDirectory, plusargs, stimulusFiles };
}

export function isVcsLiveSignal(signal: string) {
  return (
    signal.length <= 4096 &&
    /^[A-Za-z_$][\w$]*(?:\[-?\d+\])?(?:\.[A-Za-z_$][\w$]*(?:\[-?\d+\])?)+$/.test(
      signal,
    )
  );
}

const vcsFramePrefix = "wave-workbench ";

const statementEventKinds = [
  "assignment-entered",
  "branch-taken",
  "assignment-evaluated",
  "assignment-committed",
  "assignment-superseded",
] as const;
export const LIVE_EXECUTION_BUFFER_LIMIT = 2048;
type StatementEventKind = (typeof statementEventKinds)[number];
type ExecutionReplayMatch =
  | "matched"
  | "liveCoverageIncomplete"
  | "recordingCoverageIncomplete"
  | "eventSequenceDiffers";

export function matchLiveExecution(
  recording: Awaited<ReturnType<typeof readExecutionEvidence>>,
  live: ReturnType<LiveTraceSession["executionWindow"]>,
  primary: boolean,
): ExecutionReplayMatch {
  const { coverage } = live;
  if (
    !coverage.available ||
    coverage.missingOrdinals ||
    coverage.olderEventsDiscarded ||
    coverage.responseOmitted
  )
    return "liveCoverageIncomplete";
  const sequenceMatches = (events: readonly ExecutionEvent[]) =>
    isDeepStrictEqual(
      events,
      recording.events.map(
        ({ source: _source, resolvedExternalSteps: _external, ...event }) =>
          event,
      ),
    )
      ? "matched"
      : "eventSequenceDiffers";
  if (coverage.valueChangeEvents) {
    if (
      recording.waveformMatch !== "verified" ||
      recording.observationCoverage?.status !== "complete" ||
      recording.truncated
    )
      return "recordingCoverageIncomplete";
    return sequenceMatches(live.events);
  }
  const declared = recording.coverage.declared;
  if (
    recording.waveformMatch !== "verified" ||
    !(primary
      ? recording.coverage.status === "complete"
      : hasWriteEventCoverage(recording.coverage)) ||
    !declared ||
    (primary && BigInt(declared.start) > BigInt(recording.start)) ||
    recording.truncated
  )
    return "recordingCoverageIncomplete";
  // Secondary replay streams retain process events for declared writers only.
  const events = primary
    ? live.events
    : live.events.filter(
        (event) =>
          event.signal !== undefined ||
          declared.writers.includes(event.processId),
      );
  return sequenceMatches(events);
}

export function isStatementEventKind(
  value: unknown,
): value is StatementEventKind {
  return statementEventKinds.some((kind) => kind === value);
}
export type LiveBreakpoint =
  | { signal: string; value: string }
  | {
      instance: string;
      statementId: string;
      eventKind: StatementEventKind;
      timing?: ExecutionEvent["timing"];
    };

export class LiveTraceSession {
  readonly id = randomUUID();
  private readonly child: ChildProcessWithoutNullStreams;
  private waiting?: {
    resolve: (snapshot: LiveSnapshot) => void;
    reject: (error: Error) => void;
  };
  private events: ExecutionEvent[] = [];
  private discardedEvents = 0;
  private discardedThrough?: string;
  private missingOrdinals = 0;
  private snapshot?: LiveSnapshot;
  private snapshots: LiveSnapshot[] = [];
  private discardedSnapshots = 0;
  private breakpoint?: LiveBreakpoint;
  private breakHit?: LiveBreakpoint;
  private breakEvent?: ExecutionEvent;
  private advancing = false;
  private matchingEvent?: ExecutionEvent;
  private debugMatch?: { id: number; event: ExecutionEvent };
  private debugHit?: number;
  private debugBreakpoints?: {
    statement(event: ExecutionEvent): number | undefined;
    sample(snapshot: LiveSnapshot): number | undefined;
  };
  private readonly stopListeners = new Set<() => void>();
  private readonly waveHistory = new LiveWaveHistory();
  private readonly waveListeners = new Set<() => void>();
  private state: "paused" | "running" | "stepping" | "exited" | "error" =
    "paused";
  private failure?: string;
  private harnessSha256?: string;
  private runInputs: TraceRuntimeInputs;
  private run?: Promise<void>;

  private constructor(
    executable: string,
    cwd: string,
    log: (message: string) => void,
    plusargs: readonly string[],
    private readonly vcs?: VcsLiveOptions,
  ) {
    this.runInputs = { workingDirectory: cwd, plusargs };
    const args = [
      ...plusargs,
      ...(vcs?.signals.map((signal) => "+wave_watch=" + signal) ?? []),
    ];
    if (vcs?.recording) args.push("+wave_execution_events=" + vcs.recording);
    for (const scope of vcs?.statementScopes ?? [])
      args.push("+wave_statement_scope=" + scope);
    this.child = spawn(executable, args, {
      cwd,
      env: {
        ...process.env,
        WAVE_WORKBENCH_LIVE: "1",
        ...(vcs ? { WAVE_WORKBENCH_VPI_LIVE: "1" } : {}),
      },
      windowsHide: true,
    });
    this.child.stderr.setEncoding("utf8").on("data", log);
    this.child.on("error", (error) => this.fail(error));
    this.child.stdin.on("error", (error) => this.fail(error));
    this.child.on("close", () => {
      if (this.waiting)
        this.fail(Error("The live simulation closed before its reply."));
      if (this.state !== "error") this.state = "exited";
      if (!this.run) this.notifyStop();
    });
    const lines = createInterface({
      input: this.child.stdout,
      crlfDelay: Infinity,
    });
    lines.on("line", (line) => {
      try {
        if (vcs && !line.startsWith(vcsFramePrefix)) {
          log(line);
          return;
        }
        const frame = JSON.parse(
          vcs ? line.slice(vcsFramePrefix.length) : line,
        );
        if (vcs && typeof frame.error === "string") throw Error(frame.error);
        if (frame.execution !== undefined) {
          const event: unknown = frame.execution;
          const previous = this.events.at(-1);
          if (!isExecutionEvent(event))
            throw Error("Invalid live execution event.");
          if (
            (previous &&
              (event.ordinal <= previous.ordinal ||
                BigInt(event.tick) < BigInt(previous.tick))) ||
            (this.snapshot && BigInt(event.tick) < BigInt(this.snapshot.tick))
          )
            throw Error("Live execution events are out of order.");
          this.missingOrdinals += event.ordinal - (previous?.ordinal ?? -1) - 1;
          this.events.push(event);
          if (this.advancing && !this.debugMatch && this.debugBreakpoints) {
            const id = this.debugBreakpoints.statement(event);
            if (id !== undefined) this.debugMatch = { id, event };
          }
          const breakpoint = this.breakpoint;
          if (
            this.advancing &&
            !this.matchingEvent &&
            breakpoint &&
            "statementId" in breakpoint &&
            event.instance === breakpoint.instance &&
            event.statementId === breakpoint.statementId &&
            event.kind === breakpoint.eventKind &&
            (breakpoint.timing === undefined ||
              event.timing === breakpoint.timing)
          ) {
            this.matchingEvent = event;
          }
          if (this.events.length > LIVE_EXECUTION_BUFFER_LIMIT) {
            this.discardedThrough = this.events.shift()?.tick;
            this.discardedEvents++;
          }
          return;
        }
        const snapshot = frame.snapshot as LiveSnapshot | undefined;
        if (
          snapshot?.schemaVersion !== undefined &&
          snapshot.schemaVersion !== 1
        )
          throw Error("Unsupported live simulation snapshot schema.");
        if (
          !snapshot ||
          !/^\d{1,20}$/.test(snapshot.tick) ||
          typeof snapshot.done !== "boolean" ||
          (snapshot.executionEvents !== undefined &&
            typeof snapshot.executionEvents !== "boolean") ||
          (snapshot.valueChangeEvents !== undefined &&
            typeof snapshot.valueChangeEvents !== "boolean") ||
          (snapshot.statementEntryEvents !== undefined &&
            typeof snapshot.statementEntryEvents !== "boolean") ||
          (snapshot.nbaCommitEvents !== undefined &&
            typeof snapshot.nbaCommitEvents !== "boolean") ||
          (snapshot.modportCommitEvents !== undefined &&
            typeof snapshot.modportCommitEvents !== "boolean") ||
          typeof snapshot.scale !== "string" ||
          !snapshot.values ||
          typeof snapshot.values !== "object" ||
          Array.isArray(snapshot.values) ||
          !Object.values(snapshot.values).every(
            (value) => typeof value === "string" && /^[01xz]+$/i.test(value),
          )
        )
          throw Error("Invalid live simulation reply.");
        scaleSeconds(snapshot.scale);
        if (
          this.snapshot &&
          snapshot.schemaVersion !== this.snapshot.schemaVersion
        )
          throw Error(
            "Live simulation snapshot schema changed during the session.",
          );
        if (this.snapshot && snapshot.scale !== this.snapshot.scale)
          throw Error("Simulation time unit changed during the session.");
        const previousEvent = this.events.at(-1);
        if (
          (this.snapshot &&
            BigInt(snapshot.tick) < BigInt(this.snapshot.tick)) ||
          (previousEvent && BigInt(snapshot.tick) < BigInt(previousEvent.tick))
        )
          throw Error("Simulation time moved backwards.");
        this.snapshot = snapshot;
        const { tick, values } = snapshot;
        this.waveHistory.push({ tick, values });
        if (this.snapshots.at(-1)?.tick === snapshot.tick)
          this.snapshots[this.snapshots.length - 1] = snapshot;
        else this.snapshots.push(snapshot);
        if (this.snapshots.length > 256) {
          this.snapshots.shift();
          this.discardedSnapshots++;
        }
        if (snapshot.done) this.state = "exited";
        this.waiting?.resolve(snapshot);
        this.notifyWave();
      } catch (error) {
        this.fail(error instanceof Error ? error : Error(String(error)));
        this.dispose();
      }
    });
  }

  static async start(
    executable: string,
    cwd: string,
    log: (message: string) => void,
    vcs?: VcsLiveOptions,
    launch: LiveLaunchOptions = {},
  ) {
    if (
      vcs &&
      (!vcs.signals.length ||
        vcs.signals.length > 64 ||
        !vcs.signals.every(isVcsLiveSignal))
    )
      throw Error("Choose 1–64 fully qualified VCS signal paths.");
    if (
      vcs?.statementScopes &&
      (vcs.statementScopes.length > 16 ||
        vcs.statementScopes.some((scope) => !isVcsLiveSignal(scope + ".x")))
    )
      throw Error("Choose up to 16 VCS module instance paths.");
    const settings = parseLiveLaunch(launch);
    const runDirectory = await realpath(
      path.resolve(cwd, settings.workingDirectory ?? "."),
    );
    const plusargs = [...(settings.plusargs ?? [])];
    if (vcs && plusargs.some((arg) => vcsControlArg.test(arg)))
      throw Error(
        "Set VCS trace controls through the watch, recording, and scope options.",
      );
    const stimulusFiles = new Set(
      settings.stimulusFiles?.map((file) => path.resolve(runDirectory, file)),
    );
    const hash = (file: string) => waveformHash(file).catch(() => undefined);
    const [before, files] = await Promise.all([
      hash(executable),
      Promise.all(
        [...stimulusFiles].map(async (file) => ({
          path: file,
          sha256: await hash(file),
        })),
      ),
    ]);
    const session = new LiveTraceSession(
      executable,
      runDirectory,
      log,
      plusargs,
      vcs,
    );
    try {
      await session.request("current");
      const [after, checkedFiles] = await Promise.all([
        hash(executable),
        Promise.all(
          files.map(async (file) => ({
            path: file.path,
            sha256:
              file.sha256 && file.sha256 === (await hash(file.path))
                ? file.sha256
                : undefined,
          })),
        ),
      ]);
      if (before && before === after) session.harnessSha256 = before;
      session.runInputs.files = checkedFiles;
      return session;
    } catch (error) {
      session.dispose();
      throw error;
    }
  }

  runtimeInputs(): TraceRuntimeInputs {
    return this.runInputs;
  }

  async runtimeDifferences(reference: TraceRuntimeInputs) {
    const differences: string[] = [];
    const canonical = (file: string) => realpath(file).catch(() => file);
    const directory = await canonical(reference.workingDirectory);
    if (directory !== this.runInputs.workingDirectory)
      differences.push("Simulation working directory");
    const plusargs = this.vcs
      ? reference.plusargs?.filter((arg) => !vcsControlArg.test(arg))
      : reference.plusargs;
    if (plusargs && !isDeepStrictEqual(this.runInputs.plusargs, plusargs))
      differences.push("Simulation plusargs");
    if (reference.files) {
      const live = new Map(
        this.runInputs.files?.map((file) => [file.path, file.sha256]),
      );
      for (const file of reference.files)
        if (
          !file.sha256 ||
          file.sha256 !== live.get(file.path) ||
          file.sha256 !== (await waveformHash(file.path).catch(() => undefined))
        )
          differences.push("Simulation stimulus " + file.path);
    }
    return differences;
  }

  status() {
    return {
      state: this.state,
      liveSessionId: this.id,
      snapshot: this.snapshot,
      harnessSha256: this.harnessSha256,
      breakpoint: this.breakpoint,
      breakHit: this.breakHit,
      breakEvent: this.breakEvent,
      debugHit: this.debugHit,
      capabilities: {
        statementBreakpoints: this.breakpointKinds().length > 0,
        statementEventKinds: this.breakpointKinds(),
        statementPause: "end-of-slot" as const,
        valueChangeEvents: this.snapshot?.valueChangeEvents === true,
        nbaCommitEvents:
          this.snapshot?.nbaCommitEvents === true ||
          (!this.vcs && this.supportsExecutionEvents()),
        modportCommitEvents: this.snapshot?.modportCommitEvents === true,
      },
      failure: this.failure,
      discardedEvents: this.discardedEvents,
      missingOrdinals: this.missingOrdinals,
      discardedSnapshots: this.discardedSnapshots,
      events: this.events.slice(-256),
    };
  }

  executionWindow(
    instance: string,
    signal: string,
    start: string,
    end: string,
    responseLimit = 256,
  ) {
    const first = BigInt(start);
    const last = BigInt(end);
    const valueChangeEvents =
      this.snapshot?.valueChangeEvents === true &&
      Object.hasOwn(this.snapshot.values, instance + "." + signal);
    const matching = this.events.filter(
      (event) =>
        ((event.instance === instance &&
          (event.kind !== "assignment-entered" || event.signal !== undefined) &&
          (event.signal === undefined || event.signal === signal)) ||
          event.interfaceAccesses?.some(
            (access) =>
              access.instance === instance && access.signal === signal,
          )) &&
        first <= BigInt(event.tick) &&
        BigInt(event.tick) <= last,
    );
    return {
      events: matching.slice(-responseLimit),
      coverage: {
        available: this.supportsExecutionEvents() || valueChangeEvents,
        ...(valueChangeEvents ? { valueChangeEvents } : {}),
        missingOrdinals: this.missingOrdinals,
        olderEventsDiscarded:
          this.discardedThrough !== undefined &&
          BigInt(this.discardedThrough) >= first,
        responseOmitted: Math.max(0, matching.length - responseLimit),
      },
    };
  }

  observations(
    signals: ReadonlyMap<number, string>,
    historyStart = this.snapshots[0]?.tick,
    signedness?: ReadonlyMap<number, boolean>,
    bindings?: ReadonlyMap<number, Signal>,
    tick?: string,
    root?: number,
  ): Awaited<ReturnType<typeof readTraceObservations>> {
    if (tick !== undefined && !/^\d{1,20}$/.test(tick))
      throw Error("Invalid live trace tick.");
    const current =
      tick === undefined
        ? this.snapshot
        : this.snapshots.find(
            (snapshot) => BigInt(snapshot.tick) === BigInt(tick),
          );
    if (tick !== undefined && !current)
      throw Error("The requested tick has no retained live snapshot.");
    if (
      !current ||
      !historyStart ||
      !/^\d{1,20}$/.test(historyStart) ||
      BigInt(historyStart) > BigInt(current.tick)
    )
      throw Error(
        "The requested history is outside the live simulation window.",
      );
    const requested = BigInt(historyStart);
    const first = BigInt(this.snapshots[0].tick);
    const lower = requested > first ? requested : first;
    const cursor = current;
    const historyTruncated = requested < first && this.discardedSnapshots > 0;
    function observe(
      signal: number,
      watchedSignal: string,
      snapshots: readonly LiveSnapshot[],
      binding?: Signal,
    ): Awaited<
      ReturnType<typeof readTraceObservations>
    >["observations"][number] {
      const selection = tracePackedSelection(binding);
      const liveValue = (snapshot: LiveSnapshot) => {
        const raw = Object.hasOwn(snapshot.values, watchedSignal)
          ? snapshot.values[watchedSignal]
          : undefined;
        if (!binding || binding.real) return raw;
        return project(
          normalizeBits(raw, binding.sourceWidth ?? binding.width),
          binding,
        );
      };
      let previous: { tick: string; value: string } | undefined;
      let initial: typeof previous;
      const history: { tick: string; value: string }[] = [];
      for (const snapshot of snapshots) {
        if (BigInt(snapshot.tick) > BigInt(cursor.tick)) break;
        const value = liveValue(snapshot);
        if (value === undefined || value === previous?.value) continue;
        previous = { tick: snapshot.tick, value };
        if (BigInt(snapshot.tick) < lower) initial = previous;
        else history.push(previous);
      }
      const value = liveValue(cursor);
      const rangeLabel =
        !binding?.real && !selection.projected
          ? /\[\s*-?\d+\s*:\s*-?\d+\s*\]$/.exec(binding?.name ?? "")?.[0]
          : undefined;
      const waveformSignal =
        selection.bit === undefined
          ? watchedSignal + (rangeLabel ?? "")
          : watchedSignal + "[" + selection.bit + "]";
      return {
        signal,
        waveformSignal,
        width: binding?.width ?? value?.length ?? 0,
        real: binding?.real || undefined,
        signed: signedness?.get(signal),
        ...selection,
        value,
        status: value === undefined ? "unavailable" : "observed",
        initial,
        history,
        historyLimitedToTransition: undefined,
        historyTruncated,
        cursorSamples: undefined,
      };
    }
    const observations = Array.from(signals, ([signal, waveformSignal]) =>
      observe(signal, waveformSignal, this.snapshots, bindings?.get(signal)),
    );
    const rootBinding = root === undefined ? undefined : bindings?.get(root);
    const rootSignal = root === undefined ? undefined : signals.get(root);
    const wholeRoot =
      root !== undefined &&
      rootSignal &&
      rootBinding?.bitOffset !== undefined &&
      rootBinding.sourceWidth
        ? observe(root, rootSignal, this.snapshots, {
            ...rootBinding,
            width: rootBinding.sourceWidth,
            bitOffset: undefined,
            sourceWidth: undefined,
          })
        : undefined;
    return {
      tick: current.tick,
      historyStart: lower.toString(),
      historyEnd: current.tick,
      scale: current.scale,
      automaticSearchLimited: undefined,
      observations,
      ...(wholeRoot ? { wholeRoot } : {}),
    };
  }

  setBreakpoint(breakpoint?: LiveBreakpoint) {
    if (breakpoint && "statementId" in breakpoint) {
      const kinds = this.breakpointKinds();
      if (!kinds.length)
        throw Error(
          "The running simulation does not provide statement events.",
        );
      if (!kinds.includes(breakpoint.eventKind))
        throw Error(
          "The running simulation does not provide " +
            breakpoint.eventKind +
            " events.",
        );
      if (!breakpoint.instance.trim() || !breakpoint.statementId.trim())
        throw Error("Choose a recorded instance and statement ID.");
      if (
        breakpoint.timing !== undefined &&
        breakpoint.eventKind !== "assignment-committed"
      )
        throw Error(
          "Commit timing requires an assignment-committed breakpoint.",
        );
      if (
        breakpoint.timing === "simulator-commit" &&
        this.vcs &&
        !this.snapshot?.nbaCommitEvents &&
        !this.snapshot?.modportCommitEvents
      )
        throw Error(
          "The running VCS simulation does not provide simulator commit events.",
        );
    } else if (breakpoint && "signal" in breakpoint) {
      if (
        !Object.hasOwn(this.snapshot?.values ?? {}, breakpoint.signal) ||
        !/^[01xz]+$/i.test(breakpoint.value)
      )
        throw Error(
          "Use a sampled signal path and a binary, X or Z breakpoint value.",
        );
    }
    this.breakpoint = breakpoint;
    this.breakHit = undefined;
    this.breakEvent = undefined;
    this.matchingEvent = undefined;
    return this.status();
  }

  setDebugBreakpoints(breakpoints?: LiveTraceSession["debugBreakpoints"]) {
    this.debugBreakpoints = breakpoints;
    this.debugMatch = undefined;
  }

  onStop(listener: () => void) {
    this.stopListeners.add(listener);
    return () => this.stopListeners.delete(listener);
  }

  private notifyStop() {
    this.notifyWave();
    for (const listener of this.stopListeners) listener();
  }

  waveUpdate(): LiveWaveUpdate {
    return {
      sessionId: this.id,
      state: this.state,
      failure: this.failure,
      scale: this.snapshot?.scale,
      ...this.waveHistory.overviewFrame(),
    };
  }

  readWaveWindow(start: bigint, end: bigint, cursor: bigint) {
    return this.waveHistory.read(start, end, cursor);
  }

  readWavePage(start: bigint, end: bigint, limit: number, signal: AbortSignal) {
    return this.waveHistory.page(start, end, limit, signal);
  }

  disposeWaveHistory() {
    this.waveHistory.dispose();
  }

  onWaveUpdate(listener: () => void) {
    this.waveListeners.add(listener);
    return () => this.waveListeners.delete(listener);
  }

  private notifyWave() {
    for (const listener of this.waveListeners) listener();
  }

  private clearHit() {
    this.breakHit = undefined;
    this.breakEvent = undefined;
    this.debugHit = undefined;
  }

  private supportsExecutionEvents() {
    return this.snapshot?.executionEvents ?? this.events.length > 0;
  }

  private breakpointKinds(): readonly StatementEventKind[] {
    return statementEventKinds.filter((kind) =>
      kind === "assignment-entered"
        ? this.snapshot?.statementEntryEvents === true
        : this.supportsExecutionEvents() &&
          (kind !== "assignment-superseded" || !this.vcs),
    );
  }

  async pause() {
    if (this.state === "running" || this.state === "stepping")
      this.state = "paused";
    await this.run;
    return this.status();
  }

  resume() {
    this.requirePaused();
    this.state = "running";
    this.notifyWave();
    this.clearHit();
    this.run = (async () => {
      try {
        while (this.state === "running") await this.advance();
      } catch (error) {
        this.fail(error instanceof Error ? error : Error(String(error)));
      } finally {
        this.run = undefined;
        this.notifyStop();
      }
    })();
    return this.status();
  }

  async stepClock(clock: string, cycles: number, operation?: AbortSignal) {
    operation?.throwIfAborted();
    this.requirePaused();
    if (
      !Number.isInteger(cycles) ||
      cycles < 1 ||
      cycles > 1000 ||
      !/^[01]$/.test(this.snapshot?.values[clock] ?? "")
    )
      throw Error("Choose a sampled one-bit clock and 1–1000 cycles.");
    let remaining = cycles;
    await this.step(
      10000,
      () => remaining > 0,
      (previous, next) => {
        if (previous.values[clock] === "0" && next.values[clock] === "1")
          remaining--;
      },
      operation,
    );
    return { ...this.status(), elapsedCycles: cycles - remaining };
  }

  async stepSlot() {
    this.requirePaused();
    await this.step(1, () => true);
    return this.status();
  }

  private async step(
    limit: number,
    more: () => boolean,
    advanced?: (previous: LiveSnapshot, next: LiveSnapshot) => void,
    operation?: AbortSignal,
  ) {
    this.state = "stepping";
    this.notifyWave();
    this.clearHit();
    let slots = 0;
    this.run = (async () => {
      try {
        // Let the current command finish so the next request starts at a slot boundary.
        while (
          more() &&
          this.state === "stepping" &&
          !operation?.aborted &&
          slots++ < limit
        ) {
          const previous = this.snapshot;
          const next = await this.advance();
          advanced?.(previous, next);
        }
      } catch (error) {
        if (this.state !== "exited")
          this.fail(error instanceof Error ? error : Error(String(error)));
      } finally {
        if (this.state === "stepping") this.state = "paused";
        this.run = undefined;
        this.notifyStop();
      }
    })();
    await this.run;
    operation?.throwIfAborted();
  }

  private requirePaused() {
    if (this.state !== "paused" || this.waiting || this.run)
      throw Error("The live simulation is not ready for this action.");
  }

  private async advance() {
    this.advancing = true;
    this.matchingEvent = undefined;
    this.debugMatch = undefined;
    try {
      const next = await this.request("advance");
      const breakpoint = this.breakpoint;
      if (breakpoint) {
        const matched =
          "statementId" in breakpoint
            ? this.matchingEvent !== undefined
            : next.values[breakpoint.signal]?.toLowerCase() ===
              breakpoint.value.toLowerCase();
        if (matched) {
          this.breakHit = breakpoint;
          this.breakEvent = this.matchingEvent;
          if (!next.done) this.state = "paused";
        }
      }
      const match = this.debugMatch;
      const debugHit = match?.id ?? this.debugBreakpoints?.sample(next);
      if (debugHit !== undefined) {
        this.debugHit = debugHit;
        this.breakEvent = match?.event ?? this.breakEvent;
        if (!next.done) this.state = "paused";
      }
      return next;
    } finally {
      this.advancing = false;
      this.matchingEvent = undefined;
      this.debugMatch = undefined;
    }
  }

  private request(command: "current" | "advance"): Promise<LiveSnapshot> {
    if (this.waiting)
      return Promise.reject(Error("A live simulation request is pending."));
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.fail(Error("The live simulation timed out."));
        this.dispose();
      }, 5000);
      const settle = () => {
        clearTimeout(timeout);
        this.waiting = undefined;
      };
      this.waiting = {
        resolve: (value) => {
          settle();
          resolve(value);
        },
        reject: (error) => {
          settle();
          reject(error);
        },
      };
      this.child.stdin.write(command + "\n", (error) => {
        if (error) this.fail(error);
      });
    });
  }

  private fail(error: Error) {
    if (this.state === "exited") return;
    this.failure = error.message;
    this.state = "error";
    this.waiting?.reject(error);
  }

  dispose() {
    if (this.state !== "error") this.state = "exited";
    this.waiting?.reject(Error("Live trace session closed."));
    this.child.kill();
    if (!this.run) this.notifyStop();
  }
}
