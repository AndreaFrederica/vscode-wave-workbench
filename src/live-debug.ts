// SPDX-License-Identifier: MPL-2.0

import * as path from "node:path";
import { realpath } from "node:fs/promises";
import type * as vscode from "vscode";
import {
  readExecutionSourceMap,
  waveformHash,
  type ExecutionEvent,
} from "./rtl-execution";
import { parseLiveLaunch, type LiveTraceSession } from "./rtl-live-trace";

export const liveDebugType = "wave-workbench-live";

type Request = {
  type: "request";
  seq: number;
  command: string;
  arguments?: Record<string, unknown>;
};
type EventBody = Record<string, unknown>;
type Binding = {
  id: number;
  verified: boolean;
  line?: number;
  message?: string;
};
type SourceMap = Awaited<ReturnType<typeof readExecutionSourceMap>>;
type StartOptions = Parameters<typeof LiveTraceSession.start>;

export interface DebugHost {
  root: string;
  active(): LiveTraceSession | undefined;
  start(...args: StartOptions): Promise<LiveTraceSession>;
  stop(session: LiveTraceSession): void;
  showWave?(): void;
  release(): void;
}

export class LiveDebugAdapter implements vscode.DebugAdapter {
  readonly onDidSendMessage: vscode.Event<vscode.DebugProtocolMessage>;
  private readonly messages: vscode.EventEmitter<vscode.DebugProtocolMessage>;
  private session?: LiveTraceSession;
  private detachStop?: () => void;
  private ownsSession = false;
  private disposed = false;
  private ended = false;
  private configured = false;
  private stopOnEntry = true;
  private clock?: string;
  private stopReason = "entry";
  private source?: SourceMap;
  private readonly sourceBindings = new Map<string, Map<string, number>>();
  private readonly pendingSites = new Set<number>();
  private signalBindings: { id: number; signal: string; value: string }[] = [];
  private sequence = 0;
  private nextBreakpoint = 0;
  private breakpointRevision = 0;
  private readonly sourceRevisions = new Map<string, number>();

  constructor(
    code: Pick<typeof vscode, "EventEmitter">,
    private readonly host: DebugHost,
  ) {
    this.messages = new code.EventEmitter<vscode.DebugProtocolMessage>();
    this.onDidSendMessage = this.messages.event;
  }

  handleMessage(message: vscode.DebugProtocolMessage) {
    const request = message as Request;
    if (request.type === "request") void this.handle(request);
  }

  private event(event: string, body?: EventBody) {
    if (!this.disposed)
      this.messages.fire({ seq: ++this.sequence, type: "event", event, body });
  }

  private respond(request: Request, body?: EventBody, error?: unknown) {
    if (this.disposed) return;
    this.messages.fire({
      seq: ++this.sequence,
      type: "response",
      request_seq: request.seq,
      command: request.command,
      success: error === undefined,
      body,
      ...(error === undefined
        ? {}
        : { message: error instanceof Error ? error.message : String(error) }),
    });
  }

  private resolve(filename: unknown, label: string) {
    if (
      typeof filename !== "string" ||
      !filename.trim() ||
      filename.includes("\0")
    )
      throw Error(label + " must be a file path.");
    return path.resolve(this.host.root, filename);
  }

  private async connect(request: Request) {
    if (this.session) throw Error("A simulation is already connected.");
    const args = request.arguments ?? {};
    const attach = request.command === "attach";
    this.stopOnEntry = args.stopOnEntry !== false;
    if (
      args.clock !== undefined &&
      (typeof args.clock !== "string" || !args.clock.trim())
    )
      throw Error("Set clock to a sampled one-bit signal path.");
    this.clock = args.clock as string | undefined;
    if (args.executionLog !== undefined)
      this.source = await readExecutionSourceMap(
        this.resolve(args.executionLog, "executionLog"),
      );
    if (this.disposed) return;
    let session: LiveTraceSession;
    if (attach) {
      session = this.host.active();
      if (!session || ["exited", "error"].includes(session.status().state))
        throw Error("Start a Wave Workbench live simulation before attaching.");
    } else {
      const executable = this.resolve(args.program, "program");
      const launch = parseLiveLaunch({
        workingDirectory:
          args.cwd === undefined
            ? this.host.root
            : this.resolve(args.cwd, "cwd"),
        plusargs: args.plusargs,
        stimulusFiles: args.stimulusFiles,
      });
      if (
        args.backend !== undefined &&
        args.backend !== "harness" &&
        args.backend !== "vcs"
      )
        throw Error("Use harness or vcs for backend.");
      let vcs: StartOptions[3];
      if (args.backend === "vcs") {
        if (
          !Array.isArray(args.signals) ||
          !args.signals.every((signal) => typeof signal === "string")
        )
          throw Error(
            "VCS launch requires a signals array with the watched signal paths.",
          );
        if (
          args.statementScopes !== undefined &&
          (!Array.isArray(args.statementScopes) ||
            !args.statementScopes.every((scope) => typeof scope === "string"))
        )
          throw Error(
            "VCS statementScopes must be an array of instance paths.",
          );
        const recording =
          args.recording === undefined
            ? undefined
            : this.resolve(args.recording, "recording");
        if (
          recording &&
          args.executionLog !== undefined &&
          recording === this.resolve(args.executionLog, "executionLog")
        )
          throw Error(
            "Choose different files for the VCS recording output and the source map.",
          );
        vcs = {
          signals: args.signals,
          statementScopes: args.statementScopes as string[] | undefined,
          recording,
        };
      }
      session = await this.host.start(
        executable,
        path.dirname(executable),
        (output) =>
          this.event("output", {
            category: "console",
            output: output.endsWith("\n") ? output : output + "\n",
          }),
        vcs,
        launch,
      );
      this.ownsSession = true;
    }
    if (this.disposed) {
      if (this.ownsSession) this.host.stop(session);
      return;
    }
    this.session = session;
    if (
      this.clock &&
      !/^[01]$/.test(session.status().snapshot?.values[this.clock] ?? "")
    )
      throw Error("The selected clock is unavailable or currently not binary.");
    this.detachStop = session.onStop(() => this.onStop());
    this.respond(request);
    this.event("initialized");
  }

  private onStop() {
    if (!this.configured || this.ended || this.disposed) return;
    const status = this.session?.status();
    if (!status) return;
    if (status.state === "exited" || status.state === "error") {
      if (status.failure)
        this.event("output", {
          category: "stderr",
          output: status.failure + "\n",
        });
      this.terminate();
      return;
    }
    if (status.state !== "paused") return;
    const hit = status.debugHit;
    if (hit !== undefined && this.pendingSites.delete(hit)) {
      this.event("breakpoint", {
        reason: "changed",
        breakpoint: {
          id: hit,
          verified: true,
          line: status.breakEvent?.statementSite?.line,
        },
      });
    }
    const reason =
      hit !== undefined || status.breakHit ? "breakpoint" : this.stopReason;
    const tick = status.snapshot
      ? status.snapshot.tick + " × " + status.snapshot.scale
      : "—";
    this.event("stopped", {
      reason,
      threadId: 1,
      allThreadsStopped: true,
      description: "RTL · " + tick,
      ...(hit === undefined ? {} : { hitBreakpointIds: [hit] }),
    });
    this.stopReason = "pause";
  }

  private async configure(request: Request) {
    const session = this.requireSession();
    if (this.configured) throw Error("The simulation is already configured.");
    this.configured = true;
    this.host.showWave?.();
    const { state } = session.status();
    if (state === "paused" && !this.stopOnEntry) {
      this.stopReason = "pause";
      session.resume();
      this.respond(request);
      return;
    }
    this.respond(request);
    if (this.stopOnEntry && (state === "running" || state === "stepping"))
      await session.pause();
    else this.onStop();
  }

  private terminate() {
    if (this.ended) return;
    this.ended = true;
    this.event("terminated");
  }

  private requireSession() {
    if (!this.session || this.ended)
      throw Error("The debugger has no active live simulation.");
    return this.session;
  }

  private updateBreakpoints() {
    const cwd =
      this.session?.runtimeInputs().workingDirectory ?? this.host.root;
    this.session?.setDebugBreakpoints({
      statement: (event) => {
        const site = event.statementSite;
        const siteKey =
          site && this.siteKey(path.resolve(cwd, site.file), site.line);
        for (const breakpoints of this.sourceBindings.values()) {
          const id =
            breakpoints.get(event.kind + "\0" + event.statementId) ??
            (event.kind === "assignment-entered" && siteKey
              ? breakpoints.get(siteKey)
              : undefined);
          if (id !== undefined) return id;
        }
      },
      sample: ({ values }) =>
        this.signalBindings.find(
          ({ signal, value }) => values[signal]?.toLowerCase() === value,
        )?.id,
    });
  }

  private siteKey(filename: string, line: number) {
    return "site\0" + filename + "\0" + line;
  }

  private async setSourceBreakpoints(args: Record<string, unknown>) {
    const session = this.requireSession();
    const source = args.source as { path?: string } | undefined;
    const filename = source?.path && path.resolve(source.path);
    const requested = (args.breakpoints ?? []) as {
      line: number;
      condition?: string;
      hitCondition?: string;
      logMessage?: string;
    }[];
    if (!filename || !Array.isArray(requested)) return { breakpoints: [] };
    const revision = ++this.breakpointRevision;
    this.sourceRevisions.set(filename, revision);
    const resolved = await realpath(filename).catch(() => filename);
    const kinds = session.status().capabilities.statementEventKinds;
    const kind = kinds.includes("assignment-entered")
      ? "assignment-entered"
      : kinds.includes("assignment-evaluated")
        ? "assignment-evaluated"
        : undefined;
    const byLine = new Map<number, string[]>();
    let changed = false;
    if (kind && this.source && args.sourceModified !== true) {
      let sha: string | undefined;
      for (const [id, statement] of this.source) {
        if (statement.file !== filename && statement.file !== resolved)
          continue;
        if (statement.sha256) {
          sha ??= await waveformHash(resolved).catch(() => "");
          if (sha !== statement.sha256) {
            changed = true;
            continue;
          }
        }
        const ids = byLine.get(statement.line) ?? [];
        ids.push(id);
        byLine.set(statement.line, ids);
      }
    }
    const bound = new Map<string, number>();
    const pending: number[] = [];
    const breakpoints = requested.map(
      ({ line, condition, hitCondition, logMessage }): Binding => {
        const id = ++this.nextBreakpoint;
        const sites = byLine.get(line);
        const unverified = (message: string) => ({
          id,
          verified: false,
          line,
          message,
        });
        if (condition || hitCondition || logMessage)
          return unverified(
            "Source breakpoint conditions and logpoints are unavailable.",
          );
        if (!kind)
          return unverified(
            "This simulation has no assignment-entry or evaluation events.",
          );
        if (changed || args.sourceModified === true)
          return unverified("RTL source differs from the execution recording.");
        if (sites?.length) {
          for (const site of sites) bound.set(kind + "\0" + site, id);
          return { id, verified: true, line };
        }
        if (
          kind === "assignment-entered" &&
          Number.isSafeInteger(line) &&
          line > 0
        ) {
          bound.set(this.siteKey(filename, line), id);
          bound.set(this.siteKey(resolved, line), id);
          pending.push(id);
          return unverified(
            "Waiting to observe this source line in the simulator.",
          );
        }
        return unverified(
          this.source
            ? "No recorded assignment on this line."
            : "Set executionLog to a matching Wave Workbench execution recording.",
        );
      },
    );
    if (!this.disposed && this.sourceRevisions.get(filename) === revision) {
      for (const id of this.sourceBindings.get(filename)?.values() ?? [])
        this.pendingSites.delete(id);
      for (const id of pending) this.pendingSites.add(id);
      if (bound.size) this.sourceBindings.set(filename, bound);
      else this.sourceBindings.delete(filename);
      this.updateBreakpoints();
    }
    return { breakpoints };
  }

  private setSignalBreakpoints(args: Record<string, unknown>) {
    const values = this.requireSession().status().snapshot?.values ?? {};
    const requested = (args.breakpoints ?? []) as {
      name: string;
      condition?: string;
      hitCondition?: string;
    }[];
    this.signalBindings = [];
    const breakpoints = requested.map(
      ({ name, condition, hitCondition }): Binding => {
        const id = ++this.nextBreakpoint;
        const match = /^(\S+)\s*==\s*([01xz]+)$/i.exec(name);
        if (
          !match ||
          !Object.hasOwn(values, match[1]) ||
          condition ||
          hitCondition
        )
          return {
            id,
            verified: false,
            message:
              "Use a sampled path and binary value, such as tb.dut.q == 0010.",
          };
        this.signalBindings.push({
          id,
          signal: match[1],
          value: match[2].toLowerCase(),
        });
        return { id, verified: true };
      },
    );
    this.updateBreakpoints();
    return { breakpoints };
  }

  private stack() {
    const { snapshot, breakEvent, events } = this.requireSession().status();
    const event =
      breakEvent ??
      events.findLast(
        (entry) =>
          entry.tick === snapshot?.tick &&
          (entry.statementSite || this.source?.has(entry.statementId)),
      );
    const site = this.location(event);
    return {
      stackFrames: [
        {
          id: 1,
          name:
            (event?.instance ?? "RTL simulation") +
            " · tick " +
            (snapshot?.tick ?? "—"),
          line: site?.line ?? 0,
          column: site?.column ?? 0,
          ...(site
            ? { source: { name: path.basename(site.file), path: site.file } }
            : {}),
        },
      ],
      totalFrames: 1,
    };
  }

  private location(event?: ExecutionEvent) {
    if (!event) return;
    const position = this.source?.get(event.statementId);
    if (position) return position;
    if (event.statementSite)
      return {
        ...event.statementSite,
        file: path.resolve(
          this.session?.runtimeInputs().workingDirectory ?? this.host.root,
          event.statementSite.file,
        ),
        column: 1,
      };
  }

  private async handle(request: Request) {
    const args = request.arguments ?? {};
    try {
      switch (request.command) {
        case "initialize":
          this.respond(request, {
            supportsConfigurationDoneRequest: true,
            supportsFunctionBreakpoints: true,
            supportsEvaluateForHovers: true,
            supportTerminateDebuggee: true,
          });
          return;
        case "launch":
        case "attach":
          await this.connect(request);
          return;
        case "configurationDone":
          await this.configure(request);
          return;
        case "setExceptionBreakpoints":
          this.respond(request, { breakpoints: [] });
          return;
        case "setBreakpoints":
          this.respond(request, await this.setSourceBreakpoints(args));
          return;
        case "setFunctionBreakpoints":
          this.respond(request, this.setSignalBreakpoints(args));
          return;
        case "threads":
          this.respond(request, {
            threads:
              this.session && !this.ended
                ? [{ id: 1, name: "RTL simulation" }]
                : [],
          });
          return;
        case "stackTrace":
          this.respond(request, this.stack());
          return;
        case "scopes":
          this.respond(request, {
            scopes: [
              { name: "Signals", variablesReference: 1, expensive: false },
              { name: "Simulation", variablesReference: 2, expensive: false },
            ],
          });
          return;
        case "variables": {
          const snapshot = this.requireSession().status().snapshot;
          const values =
            args.variablesReference === 1
              ? snapshot?.values
              : args.variablesReference === 2 && snapshot
                ? { tick: snapshot.tick, scale: snapshot.scale }
                : {};
          this.respond(request, {
            variables: Object.entries(values ?? {}).map(([name, value]) => ({
              name,
              value,
              variablesReference: 0,
            })),
          });
          return;
        }
        case "evaluate": {
          const snapshot = this.requireSession().status().snapshot;
          const name = String(args.expression ?? "").trim();
          const result =
            name === "$tick"
              ? snapshot?.tick
              : Object.hasOwn(snapshot?.values ?? {}, name)
                ? snapshot!.values[name]
                : undefined;
          if (result === undefined)
            throw Error("Enter a sampled signal path or $tick.");
          this.respond(request, { result, variablesReference: 0 });
          return;
        }
        case "continue":
          this.stopReason = "pause";
          this.requireSession().resume();
          this.respond(request, { allThreadsContinued: true });
          return;
        case "next":
        case "stepIn": {
          const session = this.requireSession();
          if (session.status().state !== "paused")
            throw Error("Pause the simulation before stepping.");
          this.stopReason = "step";
          const step = this.clock
            ? session.stepClock(this.clock, 1)
            : session.stepSlot();
          this.respond(request);
          void step.catch((error) =>
            this.event("output", {
              category: "stderr",
              output: String(error) + "\n",
            }),
          );
          return;
        }
        case "pause":
          const session = this.requireSession();
          this.stopReason = "pause";
          this.respond(request);
          await session.pause();
          return;
        case "disconnect":
        case "terminate":
          this.respond(request);
          this.disconnect(
            request.command === "terminate" ||
              args.terminateDebuggee === true ||
              (this.ownsSession && args.terminateDebuggee !== false),
          );
          this.terminate();
          return;
        default:
          throw Error("Unsupported RTL debug request: " + request.command);
      }
    } catch (error) {
      this.respond(request, undefined, error);
      if (request.command === "launch" || request.command === "attach") {
        this.disconnect(this.ownsSession);
        this.terminate();
      }
    }
  }

  private disconnect(stop: boolean) {
    this.detachStop?.();
    this.detachStop = undefined;
    this.session?.setDebugBreakpoints();
    if (stop && this.session) this.host.stop(this.session);
    this.session = undefined;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.disconnect(this.ownsSession);
    this.messages.dispose();
    this.host.release();
  }
}
