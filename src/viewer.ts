// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type * as vscode from "vscode";
import type { Backend } from "./backend";
import type { FsdbBackend } from "./backend-selection";
import type { DesignSession } from "./kdb";
import type { TclRunner } from "./tcl";
import type { Metadata, Location, WaveState } from "./shared/protocol";
import type { DesignView } from "./project";

export interface WaveDocument extends vscode.CustomDocument {
  view?: WaveState;
  savedView?: WaveState;
  projectPath?: string;
  savedKdb?: string;
  savedDesignView?: DesignView;
  backup?: {
    view: WaveState;
    kdb?: string;
    savedView?: WaveState;
    savedKdb?: string;
    designView?: DesignView;
    savedDesignView?: DesignView;
    projectPath?: string;
  };
  dirty?: boolean;
}

export interface Viewer {
  document: WaveDocument;
  panel: vscode.WebviewPanel;
  backend: Backend;
  backendKind: "independent" | "verdi" | "vcd" | "fst";
  switchBackend: (choice: FsdbBackend) => Promise<string>;
  meta: Metadata;
  uri: vscode.Uri;
  kdb: DesignSession;
  treeCache: Map<string, Location[]>;
  treeExpanded: Set<string>;
  sourceInstances: Map<string, string>;
  selectedScope: string;
  rtlCursor?: {
    tick: number;
    displayFactor: number;
    displayScale: string | null;
  };
  scopeHistory: string[];
  scopeIndex: number;
  pendingUI: Map<
    number,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >;
  uiSequence: number;
  ready: Promise<Viewer>;
  resolveReady: (viewer: Viewer) => void;
  ui: (action: string, payload?: any) => Promise<any>;
  showHierarchy: (scope?: string) => Promise<void>;
  restoreDesignView: (view?: DesignView) => Promise<void>;
  attachKdb: (database?: string, edited?: boolean) => Promise<boolean>;
  disposed?: boolean;
  running?: boolean;
  debugLayout?: boolean;
  syncedEditor?: string;
  revealScope?: string;
  revealId?: number;
  includeOther?: boolean;
  attaching?: Promise<boolean>;
  tcl?: TclRunner;
  scriptDirectory?: string;
}
