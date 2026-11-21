// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { Viewer } from "./viewer";
import type { createWaveAnalysis } from "./wave-analysis";
import type { createWaveTaskStatus } from "./wave-task-status";

export type WaveAnalysis = ReturnType<typeof createWaveAnalysis<Viewer>>;
export type GetViewer = () => Viewer | undefined;
export type ReportError = (error: Error & { sidebarLogged?: boolean }) => void;
export type TrackTask = ReturnType<typeof createWaveTaskStatus>;
