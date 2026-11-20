// SPDX-License-Identifier: MPL-2.0

import type { Annotation, DecoderProfile } from "./decoders";
import type { TagColors, TagStyle } from "./tags";
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
export type Definition =
  | { op: "concat" | "and" | "or" | "xor" | "not"; inputs: Operand[] }
  | {
      op: "samples";
      inputs: [];
      width: number;
      source: string;
      samples: [string, string][];
    };
export interface Signal {
  id: string;
  scope: string;
  name: string;
  width: number;
  supported: boolean;
  real?: boolean;
  unit?: string;
  group?: string;
  displayName?: string;
  displayRadix?: Radix;
  highlight?: string;
  notation?: string;
  bitOffset?: number;
  sourceWidth?: number;
  packedRange?: [number, number];
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
  supportsOrderedHistory?: boolean;
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
  parameterValue?: { bits: string; signed: boolean };
  interfaceRange?: [number, number];
  interfaceWidth?: number;
  interfaceTwoState?: boolean;
  interfaceDeclaration?: { file: string; line: number };
  depth?: number;
  expanded?: boolean;
  selected?: boolean;
}

export interface DesignPortEndpoint {
  instance: string;
  signal: string;
  field?: string;
  bit?: number;
  range?: [number, number];
}
export interface IndexedPartSelect {
  width: number;
  ascendingIndices: boolean;
}
export type AssignmentValue =
  | { op: "signal"; args: number }
  | { op: "scopedSignal"; args: [number, number] }
  | { op: "scopedSelect"; args: [number, number, number, number] }
  | {
      op: "scopedComponent";
      args: [number, number, number, [number, number] | null];
    }
  | { op: "generateIndex"; args: string }
  | { op: "unsignedBit" | "fillBit"; args: boolean }
  | { op: "fillUnknown"; args: "x" | "z" }
  | { op: "literal"; args: [string, boolean] }
  | { op: "select"; args: [number, number, number] }
  | { op: "boundSelect"; args: [number, AssignmentValue, AssignmentValue] }
  | { op: "slice"; args: [AssignmentValue, number, number] }
  | { op: "bitSelect"; args: [number, AssignmentValue] }
  | {
      op: "indexedPartSelect";
      args: [number, AssignmentValue, IndexedPartSelect];
    }
  | { op: "concat"; args: AssignmentValue[] }
  | { op: "repeat"; args: [number, AssignmentValue] }
  | { op: "cast"; args: [number | null, boolean, boolean, AssignmentValue] }
  | { op: "unary"; args: [ValueUnary, AssignmentValue] }
  | { op: "binary"; args: [ValueBinary, AssignmentValue, AssignmentValue] }
  | {
      op: "conditional";
      args: [AssignmentValue, AssignmentValue, AssignmentValue];
    };

type ValueUnary =
  | "bitNot"
  | "negate"
  | "not"
  | "reduceAnd"
  | "reduceOr"
  | "reduceXor";
type ValueBinary =
  | "bitAnd"
  | "bitOr"
  | "bitXor"
  | "and"
  | "or"
  | "equal"
  | "notEqual"
  | "caseEqual"
  | "caseNotEqual"
  | "caseItemEqual"
  | "caseItemZ"
  | "caseItemX"
  | "less"
  | "lessEqual"
  | "greater"
  | "greaterEqual"
  | "add"
  | "subtract"
  | "multiply"
  | "divide"
  | "modulo"
  | "shiftLeft"
  | "shiftRight"
  | "arithmeticShiftRight";

export type DesignPortLink = {
  to: DesignPortEndpoint;
  file: string;
  line: number;
  conversion?: { fromWidth: number; toWidth: number; twoState: boolean };
} & (
  | {
      from: DesignPortEndpoint;
      selectIndex?: Pick<DesignPortEndpoint, "instance" | "signal"> & {
        part?: IndexedPartSelect;
      };
      expression?: never;
    }
  | {
      from?: never;
      selectIndex?: never;
      expression: {
        operands: DesignPortEndpoint[];
        value: AssignmentValue;
        indexOperands?: number[];
      };
    }
);

export function portSources(link: DesignPortLink) {
  if (link.expression) return link.expression.operands;
  return link.selectIndex ? [link.from, link.selectIndex] : [link.from];
}
export type SavedSignal = Pick<Signal, "id" | "scope" | "name"> &
  Partial<Signal>;
export type TaggedSignal = Pick<
  SavedSignal,
  "id" | "scope" | "name" | "displayName" | "bitOffset"
> & {
  instanceScope: string;
  tags: string[];
};
export interface TagState {
  taggedSignals: TaggedSignal[];
  tagColors: TagColors;
  tagStyle: TagStyle;
}
export interface WaveState {
  chosen: SavedSignal[];
  start: number;
  end: number;
  cursorA: number;
  cursorB: number | null;
  markers: Marker[];
  markersVisible?: boolean;
  tooltipEnabled?: boolean;
  showInlineTags?: boolean;
  tagColors?: TagColors;
  tagStyle?: TagStyle;
  showDecodedValues?: boolean;
  decoderInstances?: import("../decoder-runtime/types").DecoderInstance[];
  busLabelMode?: BusLabelMode;
  rowHeight?: number;
  namesFraction?: number;
  valueFraction?: number;
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
  decoderInit: {
    args: {
      source: string;
      context: import("../decoder-runtime/types").DecoderContext;
      measure?: boolean;
    };
    result: typeof import("../decoder-runtime/types").eventBatchVersion;
  };
  decoderBatch: {
    args: import("../decoder-runtime/types").EventBatchHeader;
    result: import("../decoder-runtime/types").DecodeResult;
  };
  decoderFlush: {
    args: Record<string, never>;
    result: import("../decoder-runtime/types").DecodeResult;
  };
  decoderSaveState: {
    args: Record<string, never>;
    result: import("../decoder-runtime/types").Json;
  };
  decoderRestoreState: {
    args: { state: import("../decoder-runtime/types").Json };
    result: null;
  };
  open: { args: { path: string }; result: Metadata };
  query: {
    args: {
      signals: string[];
      start: string;
      end: string;
      limit?: number;
      preserveSameTick?: boolean;
    };
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
    result: {
      attached: boolean;
      backend: string;
      portLinks?: boolean;
      interfaceMembers?: boolean;
      genericInterfaceTypes?: boolean;
    };
  };
  kdbPortLinks: {
    args: { query: string };
    result: {
      links: DesignPortLink[];
      ports?: {
        instance: string;
        signal: string;
        direction: "input" | "output" | "inout";
      }[];
      portsIncomplete?: boolean;
      truncated: boolean;
      constants?: {
        instance: string;
        signal: string;
        bits: string;
        signed: boolean;
        file: string;
        line: number;
      }[];
      gaps?: {
        instance: string;
        signal: string | null;
        direction: "drivers" | "loads";
      }[];
    };
  };
  kdbResolve: { args: { query: string }; result: Location[] };
  kdbInterfaceMember: { args: { query: string }; result: Location[] };
  kdbInterfaceUsers: { args: { query: string }; result: Location[] };
  kdbGenericInterfaceTypes: {
    args: { query: string };
    result: {
      formal: string;
      formalFile: string;
      formalLine: number;
      interface: string;
      interfaceFile: string;
      interfaceLine: number;
      modport?: string;
    }[];
  };
  kdbParent: { args: { query: string }; result: Location[] };
  kdbChildren: { args: { query: string }; result: Location[] };
  kdbScopes: { args: { query: string }; result: Location[] };
  kdbInstances: { args: { query: string }; result: Location[] };
  kdbModuleSources: { args: Record<string, never>; result: string[] };
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
    real?: boolean;
    unit?: string;
    decoder?: DecoderProfile;
    annotation?: Annotation;
    events: [string, string][];
    truncated: boolean;
  }[];
  eventLimitPerSignal: number;
  truncated: boolean;
  markers: Marker[];
  decoders?: {
    id: string;
    result: import("../decoder-runtime/types").DecodeResult;
  }[];
}
