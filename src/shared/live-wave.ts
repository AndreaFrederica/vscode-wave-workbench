// SPDX-License-Identifier: MPL-2.0

export interface LiveWaveSample {
  tick: string;
  values: Record<string, string>;
}

export interface LiveWaveWindow {
  samples: LiveWaveSample[];
  approximate: boolean;
  cursor?: LiveWaveSample;
}

export interface LiveWaveUpdate extends LiveWaveWindow {
  sessionId: string;
  state: "paused" | "running" | "stepping" | "exited" | "error";
  scale?: string;
  failure?: string;
  historyFailure?: string;
  revision: number;
  firstTick?: string;
  lastTick?: string;
}
