// SPDX-License-Identifier: MPL-2.0

import type * as vscode from "vscode";
import { LiveDebugAdapter, type DebugHost } from "./live-debug";

interface DebugReply {
  seq: number;
  type: string;
  request_seq?: number;
  success?: boolean;
  event?: string;
  body?: Record<string, unknown>;
  message?: string;
}

class DebugEmitter<T> implements vscode.EventEmitter<T> {
  private listeners = new Set<(event: T) => unknown>();
  readonly event: vscode.Event<T> = (listener, thisArgs, disposables) => {
    const callback = (event: T) => listener.call(thisArgs, event);
    this.listeners.add(callback);
    const subscription = {
      dispose: () => {
        this.listeners.delete(callback);
      },
    };
    disposables?.push(subscription);
    return subscription;
  };

  fire(event: T) {
    for (const listener of this.listeners) listener(event);
  }

  dispose() {
    this.listeners.clear();
  }
}

export class AutomationDebugger {
  private adapter?: LiveDebugAdapter;
  private sequence = 0;
  private events: DebugReply[] = [];
  private droppedEvents = 0;
  private waiters = new Map<number, (message: DebugReply) => void>();

  constructor(private readonly host: Omit<DebugHost, "release">) {}

  get attached() {
    return this.adapter !== undefined;
  }

  private session() {
    if (this.adapter) return this.adapter;
    this.adapter = new LiveDebugAdapter(
      { EventEmitter: DebugEmitter },
      {
        ...this.host,
        release: () => {
          this.adapter = undefined;
        },
      },
    );
    this.adapter.onDidSendMessage((value) => {
      const message = value as DebugReply;
      if (message.type === "response")
        this.waiters.get(message.request_seq!)?.(message);
      if (message.type === "event") {
        if (this.events.length >= 64) {
          this.events.shift();
          this.droppedEvents++;
        }
        this.events.push(message);
      }
    });
    return this.adapter;
  }

  private takeEvents() {
    const result = { events: this.events, droppedEvents: this.droppedEvents };
    this.events = [];
    this.droppedEvents = 0;
    return result;
  }

  async request(args: Record<string, unknown>, signal: AbortSignal) {
    const command = String(args.command);
    if (command === "events") return this.takeEvents();
    const operation = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
    operation.throwIfAborted();
    const adapter = this.session();
    const seq = ++this.sequence;
    const reply = await new Promise<DebugReply>((resolve, reject) => {
      const abort = () => {
        this.waiters.delete(seq);
        // Terminate in-flight launches so they cannot become orphaned.
        adapter.dispose();
        reject(operation.reason);
      };
      operation.addEventListener("abort", abort, { once: true });
      this.waiters.set(seq, (value) => {
        operation.removeEventListener("abort", abort);
        this.waiters.delete(seq);
        resolve(value);
      });
      adapter.handleMessage({
        seq,
        type: "request",
        command,
        arguments: args.arguments,
      } as vscode.DebugProtocolMessage);
    });
    if (
      ["terminate", "disconnect"].includes(command) ||
      (!reply.success && ["launch", "attach"].includes(command))
    )
      adapter.dispose();
    if (!reply.success)
      throw Error(reply.message ?? "RTL debug request failed.");
    return { body: reply.body, ...this.takeEvents() };
  }

  async attachOrDetach(args: Record<string, unknown>, signal: AbortSignal) {
    if (args.action === "detach") {
      if (!this.adapter)
        throw Error("No active automation debugger to detach.");
      const response = await this.request(
        { command: "disconnect", arguments: { terminateDebuggee: false } },
        signal,
      );
      return { attached: false, ...response };
    }
    if (this.adapter)
      throw Error("A Wave Workbench RTL debugger is already active.");
    const initialized = await this.request(
      { command: "attach", arguments: args.configuration },
      signal,
    );
    const configured = await this.request(
      { command: "configurationDone" },
      signal,
    );
    return {
      attached: true,
      events: [...initialized.events, ...configured.events],
      droppedEvents: initialized.droppedEvents + configured.droppedEvents,
    };
  }

  dispose() {
    this.adapter?.dispose();
  }
}
