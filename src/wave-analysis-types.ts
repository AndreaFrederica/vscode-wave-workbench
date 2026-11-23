// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
import type { Viewer, WaveDocument } from "./viewer";
import type * as vscode from "vscode";
import { type VideAnalysisApi } from "./rtl-trace";

import type { LiveTraceSession } from "./rtl-live-trace";
import type { TraceProjectSelection } from "./project";

export type AnalysisView = Pick<
  Viewer,
  "uri" | "disposed" | "backend" | "meta" | "kdb"
> &
  Partial<Pick<Viewer, "backendKind">> & {
    ready: Promise<unknown>;
    document?: Pick<WaveDocument, "rtlBinding">;
  };

export interface TraceHost {
  file(filename: string): vscode.Uri;
  position(line: number, character: number): vscode.Position;
  cancellation(): vscode.CancellationTokenSource;
  getVide(): PromiseLike<VideAnalysisApi | undefined>;
  workspace: {
    getConfiguration(
      section: string,
      uri?: vscode.Uri,
    ): Pick<vscode.WorkspaceConfiguration, "get">;
    openTextDocument(
      uri: vscode.Uri,
    ): PromiseLike<
      Pick<
        vscode.TextDocument,
        "uri" | "lineCount" | "lineAt" | "isDirty" | "version"
      >
    >;
    readonly textDocuments: ReadonlyArray<
      Pick<vscode.TextDocument, "uri" | "isDirty" | "version" | "getText">
    >;
  };
}

export type SelectTraceProject<V> = (
  viewer: V,
) => TraceProjectSelection | null | undefined;
export type GetLiveTrace = () => LiveTraceSession | undefined;
