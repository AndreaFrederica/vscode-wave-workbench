// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

interface VsCodeApi<S> {
  getState(): S | undefined;
  setState(state: S): S;
  postMessage(message: unknown): void;
}
declare function acquireVsCodeApi<S = unknown>(): VsCodeApi<S>;
interface Window {
  waveWorkflow?: {
    scope: (value: string) => void;
    selectedScope: () => string;
    menu: (x: number, y: number) => void;
    groupsChanged: () => void;
    editGroup: (name?: string) => void;
    groupMenu: (x: number, y: number, name: string) => void;
  };
  waveMarkers?: { render: () => void };
  waveHover?: { refresh: () => void };
}
