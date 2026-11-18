// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { Location } from "./shared/protocol";
import { Backend } from "./backend";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
function mapPrefix(value: string, mappings: Record<string, string> = {}) {
  const prefix = Object.keys(mappings)
    .filter(
      (p) =>
        value === p || value.startsWith(p + ".") || value.startsWith(p + "/"),
    )
    .sort((a, b) => b.length - a.length)[0];
  return prefix ? mappings[prefix] + value.slice(prefix.length) : value;
}
class KdbSession {
  childrenCache: Map<string, Promise<Location[]>>;
  locationCache: Map<string, Promise<Location | undefined>>;
  instanceCache: Map<string, Promise<Location[]>>;
  scratch: string;
  backend: Backend;
  path: string = "";
  constructor(
    binary: string,
    home: string | undefined,
    log: (text: string) => void = () => {},
    launch: {
      args?: string[];
      useVerdiLibraries?: boolean;
      env?: NodeJS.ProcessEnv;
    } = {},
  ) {
    this.childrenCache = new Map();
    this.locationCache = new Map();
    this.instanceCache = new Map();
    this.scratch = fs.mkdtempSync(path.join(os.tmpdir(), "wave-kdb-"));
    this.backend = new Backend(binary, {
      ...launch,
      cwd: this.scratch,
      env: home
        ? {
            ...(launch.env || process.env),
            VERDI_HOME: home,
            LD_LIBRARY_PATH: [
              path.join(home, "share/NPI/lib/linux64"),
              path.join(home, "share/KDB/lib/linux64"),
              path.join(home, "etc/lib/linux64"),
              (launch.env || process.env).LD_LIBRARY_PATH,
            ]
              .filter(Boolean)
              .join(path.delimiter),
          }
        : launch.env,
      onLog: log,
    });
    this.backend.child.once("close", () =>
      fs.rm(this.scratch, { recursive: true, force: true }, () => {}),
    );
  }
  async open(database: string) {
    let candidate = database;
    if (fs.statSync(candidate).isFile()) candidate = path.dirname(candidate);
    if (
      !fs.existsSync(path.join(candidate, "simv.kdb")) &&
      !fs.existsSync(path.join(candidate, "kdb.elab++"))
    )
      throw new Error(
        "Choose a VCS simv.daidir directory containing simv.kdb / kdb.elab++.",
      );
    this.path = candidate;
    return this.backend.request("kdbOpen", { path: candidate });
  }
  cached<T>(
    cache: Map<string, Promise<T>>,
    key: string,
    load: () => Promise<T>,
  ): Promise<T> {
    const existing = cache.get(key);
    if (existing) return existing;
    const request = load().catch((e) => {
      cache.delete(key);
      throw e;
    });
    cache.set(key, request);
    while (cache.size > 512) {
      const oldest = cache.keys().next();
      if (!oldest.done) cache.delete(oldest.value);
    }
    return request;
  }
  resolve(fullname: string) {
    return this.cached(
      this.locationCache,
      fullname,
      async () =>
        (await this.backend.request("kdbResolve", { query: fullname }))[0],
    );
  }
  children(fullname = "", all = false) {
    return this.cached(this.childrenCache, `${all}:${fullname}`, () =>
      this.backend
        .request(all ? "kdbScopes" : "kdbChildren", { query: fullname })
        .then((rows) =>
          rows.sort((a, b) =>
            a.fullname.localeCompare(b.fullname, "en", { numeric: true }),
          ),
        ),
    );
  }
  instances(module: string) {
    return this.cached(this.instanceCache, module, () =>
      this.backend.request("kdbInstances", { query: module }),
    );
  }
  async parent(fullname: string) {
    return (
      (await this.backend.request("kdbParent", { query: fullname }))[0]
        ?.fullname || ""
    );
  }
  dispose() {
    this.backend.dispose();
  }
}
export { KdbSession, mapPrefix };
