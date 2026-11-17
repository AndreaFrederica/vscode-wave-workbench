import type * as vscode from "vscode";
import type { Backend } from "./backend";
import type { KdbSession } from "./kdb";
import type { TclRunner } from "./tcl";
import type { Metadata, Location } from "./shared/protocol";
export interface Viewer {
  panel: vscode.WebviewPanel;
  backend: Backend;
  meta: Metadata;
  uri: vscode.Uri;
  kdb: KdbSession;
  treeCache: Map<string, Location[]>;
  treeExpanded: Set<string>;
  sourceInstances: Map<string, string>;
  selectedScope: string;
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
  attachKdb: (database?: string) => Promise<boolean>;
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
