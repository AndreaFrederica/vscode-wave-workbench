// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { AutomationDebugger } from "./wave-debug-tools";
import { LiveDebugAdapter, liveDebugType } from "./live-debug";
import { LiveWaveView, liveWaveViewId } from "./live-wave-view";
import type * as vscode from "vscode";
import * as path from "node:path";

import {
  controlSimulation,
  launchSimulation,
  simulationHistory,
  simulationIsActive,
} from "./wave-live-tools";

import {
  isVcsLiveSignal,
  LiveTraceSession,
  parseLiveLaunch,
  type LiveLaunchOptions,
} from "./rtl-live-trace";

import type { GetViewer, ReportError, TrackTask } from "./wave-extension-types";
import type { createWaveTraceView } from "./wave-trace-view";

type VSCodeApi = typeof vscode;

export function createLiveDebugSession(
  vscode: VSCodeApi,
  {
    context,
    getCurrent,
    workspace,
    output,
    report,
    trackTask,
    clearTraceContinuation,
    showSignalTrace,
  }: {
    context: vscode.ExtensionContext;
    getCurrent: GetViewer;
    workspace: string | undefined;
    output: vscode.OutputChannel;
    report: ReportError;
    trackTask: TrackTask;
    clearTraceContinuation: ReturnType<
      typeof createWaveTraceView
    >["clearTraceContinuation"];
    showSignalTrace: ReturnType<typeof createWaveTraceView>["showSignalTrace"];
  },
) {
  let liveTrace: LiveTraceSession | undefined;
  let liveDebugger: LiveDebugAdapter | undefined;
  const liveWave = new LiveWaveView(vscode, context);
  context.subscriptions.push(
    liveWave,
    vscode.window.registerWebviewViewProvider(liveWaveViewId, liveWave, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("waveWorkbench.showLiveWave", () =>
      liveWave.show(),
    ),
  );

  let latestSimulation: LiveTraceSession | undefined;
  let launchingSimulation = false;
  const debugAutomation = new AutomationDebugger({
    root: workspace ?? process.cwd(),
    active: () => liveTrace,
    start: async (...args) => {
      if (!vscode.workspace.isTrusted)
        throw Error("Launching a simulation requires a trusted workspace.");
      if (launchingSimulation || simulationIsActive(liveTrace))
        throw Error("Stop the active simulation before starting another.");
      launchingSimulation = true;
      try {
        return useLiveTrace(
          await trackTask("启动 RTL 调试", args[0], () =>
            LiveTraceSession.start(...args),
          ),
        );
      } finally {
        launchingSimulation = false;
      }
    },
    stop: stopLiveTrace,
    showWave: showLiveWave,
  });
  context.subscriptions.push(debugAutomation, {
    dispose: () => liveTrace?.dispose(),
  });

  function useLiveTrace(session: LiveTraceSession) {
    liveTrace?.dispose();
    liveTrace = latestSimulation = session;
    clearTraceContinuation("live");
    liveWave.setSession(session);
    showLiveWave();
    return session;
  }

  function showLiveWave() {
    void liveWave.show().catch((error) => output.appendLine(String(error)));
  }

  function stopLiveTrace(session: LiveTraceSession) {
    session.dispose();
    if (liveTrace === session) liveTrace = undefined;
  }

  context.subscriptions.push(
    vscode.debug.registerDebugConfigurationProvider(liveDebugType, {
      resolveDebugConfiguration(_folder, configuration) {
        return {
          ...configuration,
          internalConsoleOptions:
            configuration.internalConsoleOptions ?? "neverOpen",
        };
      },
    }),
    vscode.debug.registerDebugAdapterDescriptorFactory(liveDebugType, {
      createDebugAdapterDescriptor(debugSession) {
        if (liveDebugger || debugAutomation.attached)
          throw Error("A Wave Workbench RTL debugger is already active.");
        const adapter = new LiveDebugAdapter(vscode, {
          root:
            debugSession.workspaceFolder?.uri.fsPath ??
            workspace ??
            process.cwd(),
          active: () => liveTrace,
          start: async (...args) => {
            if (
              liveTrace &&
              ["running", "stepping", "paused"].includes(
                liveTrace.status().state,
              )
            )
              throw Error(
                "Attach to the active simulation or stop it before launching another.",
              );
            const session = await trackTask("启动 RTL 调试", args[0], () =>
              LiveTraceSession.start(...args),
            );
            if (
              liveDebugger !== adapter ||
              (liveTrace &&
                ["running", "stepping", "paused"].includes(
                  liveTrace.status().state,
                ))
            ) {
              session.dispose();
              throw Error(
                "The live simulation or debugger changed during launch.",
              );
            }
            return useLiveTrace(session);
          },
          stop: stopLiveTrace,
          showWave: showLiveWave,
          release: () => {
            if (liveDebugger === adapter) liveDebugger = undefined;
          },
        });
        liveDebugger = adapter;
        return new vscode.DebugAdapterInlineImplementation(adapter);
      },
    }),
    vscode.commands.registerCommand(
      "waveWorkbench.debugLiveTrace",
      async () => {
        if (!liveTrace)
          return report(
            Error("Start a Wave Workbench live simulation before attaching."),
          );
        await vscode.debug.startDebugging(
          vscode.workspace.workspaceFolders?.[0],
          {
            type: liveDebugType,
            request: "attach",
            name: "Wave Workbench RTL",
          },
        );
      },
    ),
  );

  async function startLiveTrace(
    selected?: vscode.Uri,
    vcs?: {
      signals?: readonly string[];
      recording?: vscode.Uri;
      statementScopes?: readonly string[];
    },
    launch?: LiveLaunchOptions,
  ) {
    try {
      const executable =
        selected ??
        (
          await vscode.window.showOpenDialog({
            title: vcs
              ? "Select a VCS simv executable"
              : "Select a live simulation harness",
            canSelectMany: false,
          })
        )?.[0];
      if (!executable) return;
      if (
        executable.scheme !== "file" ||
        (vcs?.recording && vcs.recording.scheme !== "file")
      )
        throw Error("Select a local simulation executable and recording path.");
      let options: Parameters<typeof LiveTraceSession.start>[3];
      if (vcs) {
        const paths = (input: string) =>
          input
            .trim()
            .split(/[\s,]+/)
            .filter(Boolean);
        const signals =
          vcs.signals ??
          (await vscode.window.showInputBox({
            prompt:
              "Enter up to 64 fully qualified VCS signal paths, including the clock for clock stepping",
            placeHolder: "tb.clk, tb.dut.q",
            validateInput: (input) => {
              const signals = paths(input);
              if (
                !signals.length ||
                signals.length > 64 ||
                !signals.every(isVcsLiveSignal)
              )
                return "Enter 1–64 fully qualified signal paths.";
            },
          }));
        if (signals === undefined) return;
        let statementScopes = vcs.statementScopes;
        if (!vcs.signals && !statementScopes) {
          const input = await vscode.window.showInputBox({
            prompt:
              "Module instance paths for assignment entry events. Leave blank for value changes only.",
            placeHolder: "tb.dut",
            validateInput: (value) => {
              const scopes = paths(value);
              if (
                scopes.length > 16 ||
                scopes.some((scope) => !isVcsLiveSignal(scope + ".x"))
              )
                return "Enter up to 16 module instance paths.";
            },
          });
          if (input === undefined) return;
          statementScopes = paths(input);
        }
        options = {
          signals: typeof signals === "string" ? paths(signals) : signals,
          recording: vcs.recording?.fsPath,
          statementScopes,
        };
      }
      if (launch === undefined && selected === undefined) {
        const input = await vscode.window.showInputBox({
          prompt:
            "Simulation launch options in JSON. Leave blank for the default working directory and no arguments.",
          placeHolder:
            '{"workingDirectory":".","plusargs":["+ENABLE"],"stimulusFiles":["stimulus.hex"]}',
          validateInput: (value) => {
            if (!value.trim()) return;
            try {
              parseLiveLaunch(JSON.parse(value));
            } catch (error) {
              return error instanceof Error ? error.message : String(error);
            }
          },
        });
        if (input === undefined) return;
        if (input.trim()) launch = parseLiveLaunch(JSON.parse(input));
      }
      const session = await LiveTraceSession.start(
        executable.fsPath,
        path.dirname(executable.fsPath),
        (message) => output.appendLine(message),
        options,
        launch,
      );
      useLiveTrace(session);
      const { state, snapshot } = session.status();
      vscode.window.showInformationMessage(
        "Live trace " + state + " at tick " + snapshot?.tick,
      );
    } catch (error) {
      report(error);
    }
  }
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "waveWorkbench.startLiveTrace",
      (selected?: vscode.Uri, launch?: LiveLaunchOptions) =>
        startLiveTrace(selected, undefined, launch),
    ),
    vscode.commands.registerCommand(
      "waveWorkbench.startVcsLiveTrace",
      (
        selected?: vscode.Uri,
        signals?: readonly string[],
        recording?: vscode.Uri,
        statementScopes?: readonly string[],
        launch?: LiveLaunchOptions,
      ) =>
        startLiveTrace(
          selected,
          { signals, recording, statementScopes },
          launch,
        ),
    ),
    vscode.commands.registerCommand(
      "waveWorkbench.traceLiveSignal",
      async (
        selected?: string,
        recording?: vscode.Uri,
        followContinuations = false,
      ) => {
        const session = latestSimulation;
        const viewer = getCurrent();
        try {
          if (!session) throw Error("Start a live simulation harness first.");
          if (!viewer) throw Error("Open the reference waveform first.");
          const signal =
            selected ??
            (await vscode.window.showQuickPick(
              Object.keys(session.status().snapshot?.values ?? {}),
              { placeHolder: "Choose a sampled live signal" },
            ));
          if (!signal || latestSimulation !== session || viewer.disposed)
            return;
          const { capabilities } = session.status();
          if (
            !selected &&
            (capabilities.statementBreakpoints ||
              capabilities.valueChangeEvents)
          ) {
            const choice = await vscode.window.showQuickPick([
              "Use live samples",
              "Use live samples and an execution recording",
            ]);
            if (!choice) return;
            if (choice === "Use live samples and an execution recording") {
              recording = (
                await vscode.window.showOpenDialog({
                  title: "Choose the corresponding execution recording",
                  filters: { "Execution recording": ["jsonl"] },
                  defaultUri: vscode.Uri.file(path.dirname(viewer.uri.fsPath)),
                })
              )?.[0];
              if (!recording) return;
            }
          }
          if (latestSimulation === session && !viewer.disposed)
            await showSignalTrace(
              viewer,
              signal,
              "live",
              undefined,
              recording?.fsPath,
              undefined,
              followContinuations,
            );
        } catch (error) {
          report(error);
        }
      },
    ),
    vscode.commands.registerCommand(
      "waveWorkbench.traceLiveContinuations",
      (selected?: string, recording?: vscode.Uri) =>
        vscode.commands.executeCommand(
          "waveWorkbench.traceLiveSignal",
          selected,
          recording,
          true,
        ),
    ),
    vscode.commands.registerCommand(
      "waveWorkbench.controlLiveTrace",
      async () => {
        const session = liveTrace;
        if (!session)
          return report(Error("Start a live simulation harness first."));
        try {
          const choice = await vscode.window.showQuickPick([
            "Status",
            "Pause",
            "Resume",
            "Step Clock",
            "Set Breakpoint",
            ...(session.status().capabilities.statementBreakpoints
              ? ["Set Statement Breakpoint"]
              : []),
            "Stop",
          ]);
          if (!choice) return;
          if (choice === "Pause") await session.pause();
          if (choice === "Resume") session.resume();
          if (choice === "Step Clock") {
            const clock = await vscode.window.showQuickPick(
              Object.keys(session.status().snapshot?.values ?? {}),
            );
            if (clock) await session.stepClock(clock, 1);
          }
          if (choice === "Set Breakpoint") {
            const signal = await vscode.window.showQuickPick(
              Object.keys(session.status().snapshot?.values ?? {}),
            );
            const value =
              signal &&
              (await vscode.window.showInputBox({
                prompt: "Breakpoint value in binary",
              }));
            if (signal && value) session.setBreakpoint({ signal, value });
          }
          if (choice === "Set Statement Breakpoint") {
            const instance = await vscode.window.showInputBox({
              prompt: "Recorded RTL instance path",
            });
            const statementId =
              instance?.trim() &&
              (await vscode.window.showInputBox({
                prompt: "Recorded statement ID",
              }));
            if (instance?.trim() && statementId?.trim()) {
              const {
                statementEventKinds: supported,
                nbaCommitEvents,
                modportCommitEvents,
              } = session.status().capabilities;
              const selected = await vscode.window.showQuickPick(
                (
                  [
                    {
                      label: "Assignment entry",
                      eventKind: "assignment-entered",
                    },
                    {
                      label: "Assignment evaluation",
                      eventKind: "assignment-evaluated",
                    },
                    {
                      label: "Assignment commit",
                      eventKind: "assignment-committed",
                    },
                    {
                      label: "Simulator commit",
                      eventKind: "assignment-committed",
                      timing: "simulator-commit",
                    },
                    {
                      label: "NBA superseded",
                      eventKind: "assignment-superseded",
                    },
                    { label: "Branch taken", eventKind: "branch-taken" },
                  ] as const
                ).filter(
                  (option) =>
                    supported.includes(option.eventKind) &&
                    (!("timing" in option) ||
                      nbaCommitEvents ||
                      modportCommitEvents),
                ),
              );
              if (!selected) return;
              session.setBreakpoint({
                instance: instance.trim(),
                statementId: statementId.trim(),
                eventKind: selected.eventKind,
                ...("timing" in selected ? { timing: selected.timing } : {}),
              });
            }
          }
          if (choice === "Stop") {
            stopLiveTrace(session);
            return;
          }
          const document = await vscode.workspace.openTextDocument({
            language: "json",
            content: JSON.stringify(session.status(), null, 2),
          });
          await vscode.window.showTextDocument(document);
        } catch (error) {
          report(error);
        }
      },
    ),
    {
      dispose() {
        liveTrace?.dispose();
      },
    },
  );

  async function handleTool(
    name: string,
    args: Record<string, unknown>,
    operation: AbortSignal,
  ) {
    if (name === "wave_live_start") {
      if (!vscode.workspace.isTrusted)
        throw Error("Launching a simulation requires a trusted workspace.");
      if (launchingSimulation || simulationIsActive(liveTrace))
        throw Error("Stop the active simulation before starting another.");
      launchingSimulation = true;
      try {
        const session = await launchSimulation(
          workspace,
          args,
          (message) => output.appendLine(message),
          operation,
        );
        if (simulationIsActive(liveTrace)) {
          session.dispose();
          session.disposeWaveHistory();
          throw Error("The active simulation changed during launch.");
        }
        return useLiveTrace(session).status();
      } finally {
        launchingSimulation = false;
      }
    }
    if (name === "wave_debug_request") {
      if (liveDebugger)
        throw Error(
          "Detach the VS Code debugger before opening an automation debug session.",
        );
      return debugAutomation.request(args, operation);
    }
    if (name === "wave_live_debug") {
      if (args.show !== true) {
        if (liveDebugger)
          throw Error(
            "Detach the VS Code debugger before opening an automation debug session.",
          );
        return debugAutomation.attachOrDetach(args, operation);
      }
      if (args.action === "attach") {
        if (!simulationIsActive(liveTrace))
          throw Error("Start a live simulation harness first.");
        return {
          attached: await vscode.debug.startDebugging(
            vscode.workspace.workspaceFolders?.[0],
            {
              ...(args.configuration as Record<string, unknown>),
              type: liveDebugType,
              request: "attach",
              name: "Wave Workbench RTL",
              program: undefined,
            },
          ),
        };
      }
      if (vscode.debug.activeDebugSession?.type === liveDebugType) {
        await vscode.debug.stopDebugging(vscode.debug.activeDebugSession);
        return { attached: false };
      }
      throw Error("No active VS Code Wave Workbench debugger to detach.");
    }
    if (
      name === "wave_live_status" ||
      name === "wave_live_control" ||
      name === "wave_live_history" ||
      name === "wave_live_stop"
    ) {
      operation.throwIfAborted();
      const session = latestSimulation;
      if (!session) throw Error("Start a live simulation harness first.");
      if (name === "wave_live_status") return session.status();
      if (name === "wave_live_history")
        return simulationHistory(session, args, operation);
      if (name === "wave_live_stop") {
        stopLiveTrace(session);
        return session.status();
      }
      return controlSimulation(session, args, operation);
    }
  }

  return {
    getLatest: () => liveTrace ?? latestSimulation,
    handleTool,
  };
}
