// SPDX-License-Identifier: MPL-2.0

export interface TclConsoleEntry {
  id: number;
  kind: "command" | "output" | "result" | "error";
  text: string;
  json?: true;
}

export interface TclConsoleState {
  type: "state";
  sessions: { id: number; name: string; path: string }[];
  active?: number;
  running: boolean;
  entries: TclConsoleEntry[];
  history: string[];
  completion?: TclConsoleCompletion;
}

export interface TclConsoleCompletion {
  request: number;
  incomplete: boolean;
}

export interface TclConsoleConfig {
  type: "config";
  fontFamily?: string;
  fontSize?: number;
  lineHeight?: number;
  commands: string[];
  options: Record<string, Record<string, number>>;
  tools: string[];
}

export interface TclSignalSuggestions {
  type: "signals";
  request: number;
  signals: { label: string; detail?: string; insertText: string }[];
}
