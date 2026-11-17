// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { Backend } from "../src/backend";
import type { Metadata, QueryResult } from "../src/shared/protocol";

// Compile-only checks for the TypeScript API; this function is never executed.
export async function backendContract(backend: Backend) {
  const meta: Metadata = await backend.request("open", { path: "sample.fsdb" });
  const data: QueryResult = await backend.request("query", {
    signals: [],
    start: "0",
    end: "100",
  });
  await backend.request("cacheStats");
  // @ts-expect-error Database open requires a path.
  await backend.request("open");
  // @ts-expect-error Rust timestamps travel as decimal strings.
  await backend.request("query", { signals: [], start: 0, end: 100 });
  // @ts-expect-error Unknown methods must fail compilation.
  await backend.request("readEverything");
  // @ts-expect-error A query result is not waveform metadata.
  const invalid: Metadata = data;
  return { meta, data, invalid };
}
