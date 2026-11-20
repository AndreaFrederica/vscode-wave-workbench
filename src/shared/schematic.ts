// SPDX-License-Identifier: MPL-2.0

export type SchematicPortDirection = "input" | "output" | "inout";

export interface SchematicPort {
  id: string;
  label: string;
  direction: SchematicPortDirection;
  status?: "open" | "unresolved";
}

export interface SchematicNode {
  id: string;
  label: string;
  detail: string;
  kind:
    | "signal"
    | "logic"
    | "register"
    | "mux"
    | "module"
    | "port"
    | "net"
    | "constant"
    | "gap";
  ports?: SchematicPort[];
  direction?: SchematicPortDirection;
  instance?: string;
  signal?: string;
  location?: { file: string; line: number };
  wave?: boolean;
  source?: boolean;
}

export interface SchematicGraph {
  nodes: SchematicNode[];
  edges: {
    from: string;
    to: string;
    fromPort?: string;
    toPort?: string;
    label?: string;
    bidirectional?: boolean;
    control?: boolean;
  }[];
  module?: {
    instance: string;
    name: string;
    parent?: string;
    logicStatus?: string;
  };
  root: string;
  roots?: string[];
  partial: boolean;
}
