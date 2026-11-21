// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type {
  BackendProtocol,
  DesignPortLink,
  Location,
} from "./shared/protocol";
import { portSources } from "./shared/protocol";
import { Backend } from "./backend";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type { DesignPortLink } from "./shared/protocol";

export interface ConstantPortDriver {
  bits: string;
  signed: boolean;
  file: string;
  line: number;
}

export interface DesignGenerateLabel {
  name: string;
  file: string;
  line: number;
  column: number;
  unnamed?: boolean;
}

export interface DesignGenerateScope {
  fullname: string;
  file: string;
  line: number;
  column: number;
}

export interface DesignHierarchicalAccess {
  file: string;
  line: number;
  column: number;
  instance: string;
  signal: string;
  consumer?: { instance: string; signal: string };
  owner: string;
  write: boolean;
}

export interface DesignInterfaceUser {
  instance: string;
  interfacePath: string;
  file: string;
  line: number;
  interfaceRange?: [number, number];
}

export interface VerilatorArtifacts {
  treeSha256: string;
  metadataSha256: string;
}

export interface DesignSession {
  readonly kind: "kdb" | "verilator" | "vendor-hdl";
  readonly path: string;
  readonly verilatorArtifacts?: VerilatorArtifacts;
  resolve(fullname: string): Promise<Location | undefined>;
  children(fullname?: string, all?: boolean): Promise<Location[]>;
  instances(module: string): Promise<Location[]>;
  parent(fullname: string): Promise<string>;
  portLinks?(instance: string, signal: string): Promise<DesignPortLink[]>;
  interfaceMember?(
    instance: string,
    member: string,
  ): Promise<Location | undefined>;
  interfaceMembers?(instance: string, member: string): Promise<Location[]>;
  interfaceUsers?(
    instance: string,
    member: string,
  ): Promise<DesignInterfaceUser[]>;
  genericInterfaceTypes?(
    instance: string,
  ): Promise<BackendProtocol["kdbGenericInterfaceTypes"]["result"]>;
  generateLabels?(instance: string): readonly DesignGenerateLabel[];
  generateScopes?(instance: string): readonly DesignGenerateScope[];
  hierarchicalAccesses?(instance: string): readonly DesignHierarchicalAccess[];
  hierarchicalConsumers?(
    instance: string,
    signal: string,
  ): readonly DesignHierarchicalAccess[];
  hierarchicalWriters?(
    instance: string,
    signal: string,
  ): readonly DesignHierarchicalAccess[];
  hierarchicalAccessSites?(signal: string): readonly DesignHierarchicalAccess[];
  constantPortDriver?(
    instance: string,
    signal: string,
  ): ConstantPortDriver | undefined | Promise<ConstantPortDriver | undefined>;
  unresolvedPortExpression?(
    instance: string,
    signal: string,
    direction: "drivers" | "loads",
  ): boolean | Promise<boolean>;
  dispose(): void;
}

function mapPrefix(value: string, mappings: Record<string, string> = {}) {
  const prefix = Object.keys(mappings)
    .filter(
      (p) =>
        value === p || value.startsWith(p + ".") || value.startsWith(p + "/"),
    )
    .sort((a, b) => b.length - a.length)[0];
  return prefix ? mappings[prefix] + value.slice(prefix.length) : value;
}
class KdbSession implements DesignSession {
  readonly kind = "kdb";
  private moduleSources?: Promise<string[]>;
  childrenCache: Map<string, Promise<Location[]>>;
  locationCache: Map<string, Promise<Location | undefined>>;
  instanceCache: Map<string, Promise<Location[]>>;
  private portCache = new Map<
    string,
    Promise<BackendProtocol["kdbPortLinks"]["result"]>
  >();
  portLinks?: (instance: string, signal: string) => Promise<DesignPortLink[]>;
  unresolvedPortExpression?: DesignSession["unresolvedPortExpression"];
  constantPortDriver?: DesignSession["constantPortDriver"];
  interfaceMember?: (
    instance: string,
    member: string,
  ) => Promise<Location | undefined>;
  interfaceMembers?: DesignSession["interfaceMembers"];
  interfaceUsers?: (
    instance: string,
    member: string,
  ) => Promise<DesignInterfaceUser[]>;
  private interfaceMemberCache = new Map<string, Promise<Location[]>>();
  private interfaceUserCache = new Map<
    string,
    Promise<DesignInterfaceUser[]>
  >();
  genericInterfaceTypes?: DesignSession["genericInterfaceTypes"];
  private genericInterfaceTypeCache = new Map<
    string,
    Promise<BackendProtocol["kdbGenericInterfaceTypes"]["result"]>
  >();
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
    const opened = await this.backend.request("kdbOpen", { path: candidate });
    if (opened.genericInterfaceTypes) {
      this.genericInterfaceTypes = (instance) =>
        this.cached(this.genericInterfaceTypeCache, instance, () =>
          this.backend.request("kdbGenericInterfaceTypes", { query: instance }),
        );
    }
    if (opened.interfaceMembers) {
      const members = (instance: string, member: string) =>
        this.cached(this.interfaceMemberCache, instance + "." + member, () =>
          this.backend.request("kdbInterfaceMember", {
            query: instance + "." + member,
          }),
        );
      this.interfaceMembers = members;
      this.interfaceMember = async (instance, member) => {
        const result = await members(instance, member);
        return result.length === 1 ? result[0] : undefined;
      };
      this.interfaceUsers = (instance, member) =>
        this.cached(
          this.interfaceUserCache,
          instance + "." + member,
          async () =>
            (
              await this.backend.request("kdbInterfaceUsers", {
                query: instance + "." + member,
              })
            ).flatMap(({ fullname, instance, file, line, interfaceRange }) => {
              if (
                !instance ||
                !fullname.startsWith(instance + ".") ||
                !file ||
                line < 1
              )
                return [];
              const interfacePath = fullname.slice(instance.length + 1);
              return /^[a-zA-Z_][\w$]*(?:\[-?\d+\])?\.[a-zA-Z_][\w$]*$/.test(
                interfacePath,
              )
                ? [
                    {
                      instance,
                      interfacePath,
                      file,
                      line,
                      ...(interfaceRange && { interfaceRange }),
                    },
                  ]
                : [];
            }),
        );
    }
    if (opened.portLinks) {
      this.portLinks = async (instance, signal) => {
        const { links, truncated } = await this.scanPorts(instance);
        if (truncated)
          throw Error("KDB port scan exceeded its relation budget.");
        const matches = (endpoint: { instance: string; signal: string }) =>
          endpoint.instance === instance && endpoint.signal === signal;
        return links.filter(
          (link) => matches(link.to) || portSources(link).some(matches),
        );
      };
      this.unresolvedPortExpression = async (instance, signal, direction) =>
        (await this.portCache.get(instance))?.gaps?.some(
          (gap) =>
            gap.instance === instance &&
            (gap.signal === null || gap.signal === signal) &&
            gap.direction === direction,
        ) ?? false;
      this.constantPortDriver = async (instance, signal) =>
        (await this.portCache.get(instance))?.constants?.find(
          (value) => value.instance === instance && value.signal === signal,
        );
    }
    return opened;
  }
  scanPorts(instance: string) {
    return this.cached(this.portCache, instance, () =>
      this.backend.request("kdbPortLinks", { query: instance }),
    );
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
  moduleSourceFiles() {
    return (this.moduleSources ??= this.backend
      .request("kdbModuleSources", {})
      .catch((error) => {
        this.moduleSources = undefined;
        throw error;
      }));
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
export function isMissingKdbDeclaration(error: unknown) {
  return (
    error instanceof Error &&
    /^KDB (?:object|declaration) not found:/.test(error.message)
  );
}

export { KdbSession, mapPrefix };
