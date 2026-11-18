// SPDX-License-Identifier: MPL-2.0

import type { Annotation, DecoderProfile } from "./decoders";
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

export type Radix = "bin" | "oct" | "hex" | "unsigned" | "signed";
export type BusLabelMode = "auto" | "full";
export interface Operand {
  id: string;
  scope?: string;
  name?: string;
  bitOffset?: number | null;
}
export interface Definition {
  op: "concat" | "and" | "or" | "xor" | "not";
  inputs: Operand[];
}
export interface Signal {
  id: string;
  scope: string;
  name: string;
  width: number;
  supported: boolean;
  group?: string;
  displayName?: string;
  displayRadix?: Radix;
  highlight?: string;
  notation?: string;
  bitOffset?: number;
  sourceWidth?: number;
  parentBus?: string;
  definition?: Definition;
  decoder?: DecoderProfile;
  annotation?: Annotation;
}
export interface Marker {
  name: string;
  time: number;
  color?: string;
}
export interface Block {
  events: [string, string][];
  truncated: boolean;
}
export type QueryResult = Record<string, Block>;
export interface Metadata {
  signals: Signal[];
  total: number;
  start: string;
  end: string;
  scale: string;
  backend: string;
  title?: string;
  vide?: string;
}
export interface Location {
  fullname: string;
  kind: string;
  file: string;
  line: number;
  module: string;
  definitionFile: string;
  definitionLine: number;
  instance: string;
  depth?: number;
  expanded?: boolean;
  selected?: boolean;
}
export type SavedSignal = Pick<Signal, "id" | "scope" | "name"> &
  Partial<Signal>;
export interface WaveState {
  chosen: SavedSignal[];
  start: number;
  end: number;
  cursorA: number;
  cursorB: number | null;
  markers: Marker[];
  markersVisible?: boolean;
  tooltipEnabled?: boolean;
  busLabelMode?: BusLabelMode;
  rowHeight?: number;
  namesFraction?: number;
  radix: Radix;
  displayScale: string | null;
  displayFactor: number;
  groupOrder: string[];
  activeGroup: string;
  collapsedGroups: string[];
  expandedBuses: string[];
  signalFilter: string;
  virtualDefinitions: Signal[];
  scrollTop?: number;
  scope?: string;
}
export interface SearchResult {
  signals: Signal[];
  offset: number;
  total: number;
  scope?: string;
}
export interface CacheStats {
  entries: number;
  bytes: number;
  budget: number;
  hits: number;
  reads: number;
  misses: number;
  evictions: number;
  containingHits: number;
}
export interface BackendProtocol {
  open: { args: { path: string }; result: Metadata };
  query: {
    args: { signals: string[]; start: string; end: string; limit?: number };
    result: QueryResult;
  };
  describe: {
    args: { descriptors?: Operand[]; signals?: string[]; query?: string };
    result: Signal[];
  };
  search: {
    args: { query: string; offset?: number; limit?: number };
    result: SearchResult;
  };
  scopeSignals: {
    args: { query: string; offset: number; limit: number };
    result: SearchResult;
  };
  matchNames: {
    args: { names: string[]; query: string };
    result: { matches: Record<string, Signal[]>; truncated: boolean };
  };
  defineVirtual: {
    args: { definition: Definition; name?: string };
    result: { signal: Signal; definitions: Signal[] };
  };
  cacheStats: { args: Record<string, never>; result: CacheStats };
  cacheConfigure: { args: { bytes: number }; result: CacheStats };
  kdbOpen: {
    args: { path: string };
    result: { attached: boolean; backend: string };
  };
  kdbResolve: { args: { query: string }; result: Location[] };
  kdbParent: { args: { query: string }; result: Location[] };
  kdbChildren: { args: { query: string }; result: Location[] };
  kdbScopes: { args: { query: string }; result: Location[] };
  kdbInstances: { args: { query: string }; result: Location[] };
}

export interface ClipContext {
  start: number;
  end: number;
  cursorA: number;
  cursorB: number | null;
  selected: Signal[];
  displayed: Signal[];
  markers: Marker[];
}

export interface WaveClip {
  waveform: string;
  timescale: string;
  start: string;
  end: string;
  traces: {
    path: string;
    label: string;
    group?: string;
    width: number;
    decoder?: DecoderProfile;
    annotation?: Annotation;
    events: [string, string][];
    truncated: boolean;
  }[];
  eventLimitPerSignal: number;
  truncated: boolean;
  markers: Marker[];
}
