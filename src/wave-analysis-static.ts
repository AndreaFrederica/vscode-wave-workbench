// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { Location, Signal } from "./shared/protocol";
import type * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs";
import { codeOnly } from "./rtl-selection";
import { findSignal, kdbGenerateScope } from "./signal-lookup";
import { isMissingKdbDeclaration, mapPrefix } from "./kdb";
import {
  declarationColumns,
  declaredSignalName,
  queryTrace,
  UnresolvedTraceSignal,
  type TraceDirection,
  type TraceOptions,
  type VideTrace,
  type VideTraceProject,
} from "./rtl-trace";
import { tracePackedSelection } from "./rtl-trace-observations";
import {
  expandInstanceTrace,
  seedModportAlias,
  type TraceModuleQuery,
  type TracePortQuery,
} from "./rtl-trace-instances";
import {
  verilatorArtifactMismatches,
  type TraceBuildManifest,
} from "./rtl-build-verification";

import type { AnalysisView, TraceHost } from "./wave-analysis-types";

export type ProjectTrace = {
  trace: VideTrace;
  instance: string;
  signal: Signal;
  design: AnalysisView["kdb"];
  interfaceRange: [number, number] | undefined;
  analysisProject: VideTraceProject | undefined;
};

export function createStaticAnalysis<V extends AnalysisView>(host: TraceHost) {
  const portTraceCache = new WeakMap<
    VideTraceProject,
    { revision: string; traces: Map<string, VideTrace> }
  >();

  async function traceRtlPosition(
    direction: TraceDirection,
    uri: vscode.Uri,
    position: vscode.Position,
    options?: TraceOptions,
    token?: vscode.CancellationToken,
    project?: VideTraceProject,
  ) {
    const params = {
      textDocument: { uri: uri.toString() },
      position: { line: position.line, character: position.character },
      options,
    };
    if (project) {
      if (project.closed) throw Error("The RTL trace project was closed.");
      const trace = await queryTrace(
        { version: 1, capabilities: { staticTraceVersion: 1 }, ...project },
        direction,
        params,
        token,
      );
      if (project.closed) throw Error("The RTL trace project was closed.");
      return trace;
    }
    return queryTrace(await host.getVide(), direction, params, token);
  }

  async function traceWithProject(
    viewer: V,
    direction: TraceDirection,
    fullname: string,
    options: TraceOptions,
    token?: vscode.CancellationToken,
    project?: VideTraceProject,
    buildManifest?: TraceBuildManifest,
    unverifiedVcsParameterPaths = false,
  ): Promise<ProjectTrace> {
    if (token?.isCancellationRequested)
      throw Error("The RTL trace was cancelled.");
    await viewer.ready;
    let signal = await findSignal(viewer.backend, fullname, ".");
    const design = viewer.kdb;
    if (!design) throw Error("Attach a design database to the waveform first.");
    const cfg = host.workspace.getConfiguration("waveWorkbench", viewer.uri);
    const sourcePath = (file: string) =>
      path.resolve(
        path.dirname(design.path),
        mapPrefix(file, cfg.get("sourcePathMappings")),
      );
    const mappedScope = mapPrefix(signal.scope, cfg.get("hierarchyMappings"));
    const scope =
      design.kind === "kdb" ? kdbGenerateScope(mappedScope) : mappedScope;
    const name = declaredSignalName(signal.name);
    let resolveFailure: unknown;
    let record = await design.resolve(scope + "." + name).catch((error) => {
      resolveFailure = error;
      return undefined;
    });
    let compound: Location[] | undefined;
    if (!record || record.kind === "npiMpPort" || record.kind === "npiRefObj") {
      if (design.interfaceMembers) {
        const members = await design
          .interfaceMembers(scope, name)
          .catch((error) => {
            resolveFailure ??= error;
            return [];
          });
        if (members.length > 1) compound = members;
        record = members[0] ?? record;
      } else if (design.interfaceMember) {
        const member = await design
          .interfaceMember(scope, name)
          .catch((error) => {
            resolveFailure ??= error;
            return undefined;
          });
        if (member) record = member;
      }
    }
    if (!record && resolveFailure) throw resolveFailure;
    let declarationName = signal.name;
    if (
      record?.instance &&
      record.fullname.startsWith(record.instance + ".") &&
      (record.fullname !== scope + "." + name ||
        (design.kind === "kdb" &&
          viewer.meta?.backend === "rust-vcd" &&
          record.instance.startsWith(scope + ".")))
    )
      declarationName = record.fullname.slice(record.instance.length + 1);
    if (!record?.file || !Number.isInteger(record.line) || record.line < 1) {
      throw Error("No RTL declaration location for " + fullname);
    }
    let aliasDeclaration:
      | VideTrace["assignments"][number]["location"]
      | undefined;
    let alias = record.interfaceRange;
    if (compound) {
      const width = signal.sourceWidth ?? signal.width;
      const source = record.interfaceDeclaration;
      const partsWidth = compound.reduce(
        (sum, member) => sum + (member.interfaceWidth ?? 0),
        0,
      );
      if (
        !source ||
        width !== partsWidth ||
        compound.some(
          (member) =>
            member.instance !== record.instance ||
            !member.fullname.startsWith(member.instance + ".") ||
            !member.interfaceWidth ||
            member.interfaceDeclaration?.file !== source.file ||
            member.interfaceDeclaration.line !== source.line,
        )
      )
        throw Error(
          "The dumped modport alias does not match its elaborated members: " +
            fullname,
        );
      const document = await host.workspace.openTextDocument(
        host.file(sourcePath(source.file)),
      );
      const line = source.line - 1;
      if (document.isDirty || line < 0 || line >= document.lineCount)
        throw Error("Could not verify the RTL declaration for " + fullname);
      const code = codeOnly(document.lineAt(line).text);
      const columns = declarationColumns(code, name).filter(
        (column) =>
          code.slice(0, column).trimEnd().endsWith(".") &&
          code
            .slice(column + name.length)
            .trimStart()
            .startsWith("("),
      );
      if (columns.length !== 1)
        throw Error(
          "Could not locate the RTL modport declaration for " + fullname,
        );
      aliasDeclaration = {
        uri: document.uri.toString(),
        range: { start: { line, character: columns[0] } },
      };
      alias = [width - 1, 0];
      const packed = tracePackedSelection(signal).range;
      if (packed && (packed[0] !== alias[0] || packed[1] !== alias[1]))
        throw Error(
          "The dumped range does not match the modport alias: " + fullname,
        );
      signal = { ...signal, packedRange: alias };
    } else if (
      alias &&
      alias[0] === alias[1] &&
      signal.width === 1 &&
      signal.bitOffset === undefined &&
      !tracePackedSelection(signal).range
    ) {
      signal = { ...signal, packedRange: alias };
    }
    const genericTypes = new Map<
      string,
      Promise<TraceOptions["genericInterfaces"]>
    >();
    function genericInterfaces(instance: string) {
      let pending = genericTypes.get(instance);
      if (!pending) {
        pending = readGenericInterfaces(instance);
        genericTypes.set(instance, pending);
      }
      return pending;
    }
    async function readGenericInterfaces(instance: string) {
      const types = await design
        .genericInterfaceTypes?.(instance)
        .catch(() => undefined);
      if (!types?.length) return;
      async function position(file: string, oneBased: number, name: string) {
        const uri = host.file(sourcePath(file));
        const document = await host.workspace.openTextDocument(uri).then(
          (document) => document,
          () => undefined,
        );
        const line = oneBased - 1;
        if (
          !document ||
          document.isDirty ||
          line < 0 ||
          line >= document.lineCount
        )
          return;
        const text = document.lineAt(line).text;
        const columns = declarationColumns(text, name);
        if (columns.length === 1)
          return {
            textDocument: { uri: uri.toString() },
            position: {
              line,
              character: declarationQueryColumn(text, columns[0]),
            },
          };
      }
      const bindings: NonNullable<TraceOptions["genericInterfaces"]> = [];
      for (const type of types) {
        const [formal, actual] = await Promise.all([
          position(type.formalFile, type.formalLine, type.formal),
          position(type.interfaceFile, type.interfaceLine, type.interface),
        ]);
        if (formal && actual)
          bindings.push({ formal, interface: actual, modport: type.modport });
      }
      return bindings.length ? bindings : undefined;
    }
    const file = sourcePath(record.file);
    const document = await host.workspace.openTextDocument(host.file(file));
    if (project && document.isDirty)
      throw Error(
        "Save the RTL declaration before tracing it against a simulation build.",
      );
    const line = record.line - 1;
    if (line >= document.lineCount)
      throw Error("RTL declaration is outside " + file);
    const text = document.lineAt(line).text;
    const columns = declarationColumns(text, declarationName);
    let character: number | undefined;
    let local: VideTrace | undefined;
    for (const column of columns) {
      const candidate = await traceRtlPosition(
        direction,
        document.uri,
        host.position(line, declarationQueryColumn(text, column)),
        {
          ...options,
          maxDepth: compound ? 0 : options.maxDepth,
          includeHierarchicalModules: design.kind === "kdb",
          genericInterfaces: await genericInterfaces(record.instance),
        },
        token,
        project,
      ).catch((error) => {
        if (columns.length > 1 && error instanceof UnresolvedTraceSignal)
          return;
        throw error;
      });
      if (
        candidate &&
        (columns.length === 1 ||
          matchesTraceDeclaration(candidate, document.uri, line, column))
      ) {
        local = candidate;
        character = column;
        break;
      }
    }
    if (!local || character === undefined)
      throw Error("Could not locate the RTL declaration for " + fullname);
    let cache = project && portTraceCache.get(project);
    if (project && cache?.revision !== local.revision) {
      cache = { revision: local.revision, traces: new Map() };
      portTraceCache.set(project, cache);
    }
    let reusedPortTrace = false;
    const designMatches = !verilatorArtifactMismatches(
      buildManifest?.verilatorArtifacts,
      design.verilatorArtifacts,
    ).length;
    const sourceUri = (file: string) => host.file(sourcePath(file)).toString();
    function checkTraceSession() {
      if (project?.closed) throw Error("The RTL trace project was closed.");
      if (
        token?.isCancellationRequested ||
        viewer.disposed ||
        design !== viewer.kdb
      ) {
        throw Error("The waveform trace was cancelled or the design changed.");
      }
    }
    async function traceDocument(file: string) {
      const uri = host.file(sourcePath(file));
      const document = await host.workspace.openTextDocument(uri).then(
        (document) => document,
        async (error: unknown) => {
          try {
            await fs.promises.stat(uri.fsPath);
          } catch (failure) {
            if ((failure as NodeJS.ErrnoException).code === "ENOENT")
              return undefined;
            throw error;
          }
          throw error;
        },
      );
      if (project && document?.isDirty)
        throw Error(
          "Save the connected RTL declaration before tracing it against a simulation build.",
        );
      return document;
    }
    const queryModule: TraceModuleQuery = async (file, line, module) => {
      checkTraceSession();
      const document = await traceDocument(file);
      if (!document || line > document.lineCount) return;
      try {
        return await traceRtlPosition(
          direction,
          document.uri,
          host.position(line - 1, 0),
          {
            module,
            hierarchicalOnly: true,
            maxSignals: 4096,
            maxAssignments: 4096,
          },
          token,
          project,
        );
      } catch (error) {
        if (!(error instanceof UnresolvedTraceSignal)) throw error;
      }
    };
    const query: TracePortQuery = async (
      port,
      depth,
      queryDirection = direction,
      site,
    ) => {
      checkTraceSession();
      const location =
        site ??
        (await design
          .resolve(port.instance + "." + port.signal)
          .catch((error) => {
            if (!isMissingKdbDeclaration(error)) throw error;
            return undefined;
          }));
      if (
        !location?.file ||
        location.line < 1 ||
        (!("interfacePath" in location) && location.instance !== port.instance)
      )
        return;
      const doc = await traceDocument(location.file);
      if (!doc) return;
      const line = location.line - 1;
      if (line >= doc.lineCount) return;
      const text = doc.lineAt(line).text;
      const interfacePath =
        site && "interfacePath" in site ? site.interfacePath : undefined;
      const [formalElement, member] = interfacePath?.split(".") ?? [];
      const element = formalElement?.match(/\[-?\d+\]$/)?.[0];
      const formal = element
        ? formalElement.slice(0, -element.length)
        : formalElement;
      const interfaceMember = element ? element + "." + member : member;
      const columns =
        site && "column" in site
          ? [
              Buffer.from(text)
                .subarray(0, site.column - 1)
                .toString("utf8").length,
            ]
          : declarationColumns(text, formal ?? port.signal);
      const portOptions = {
        ...options,
        maxDepth: depth,
        includeHierarchicalModules: design.kind === "kdb",
        interfaceMember,
        interfaceBacking: interfaceMember ? port.signal : undefined,
        genericInterfaces: await genericInterfaces(location.instance),
      };
      for (const column of columns) {
        const position = host.position(
          line,
          site && "column" in site
            ? column
            : declarationQueryColumn(text, column),
        );
        const key = JSON.stringify([
          queryDirection,
          doc.uri.toString(),
          doc.version,
          line,
          column,
          portOptions,
        ]);
        let result = cache?.traces.get(key);
        if (result) {
          reusedPortTrace = true;
        } else {
          try {
            result = await traceRtlPosition(
              queryDirection,
              doc.uri,
              position,
              portOptions,
              token,
              project,
            );
          } catch (error) {
            if (
              (interfaceMember || columns.length > 1) &&
              error instanceof UnresolvedTraceSignal
            )
              continue;
            throw error;
          }
          if (cache && result.revision === cache.revision) {
            if (cache.traces.size >= 128) {
              const oldest = cache.traces.keys().next();
              if (!oldest.done) cache.traces.delete(oldest.value);
            }
            cache.traces.set(key, result);
          }
        }
        if (
          result.signals.find(({ id }) => id === result.root)?.name ===
            port.signal &&
          (site ||
            columns.length === 1 ||
            matchesTraceDeclaration(result, doc.uri, line, column))
        )
          return result;
      }
    };
    const instance = compound ? scope : record.instance;
    const initial =
      compound && aliasDeclaration
        ? await seedModportAlias(
            local,
            { instance, signal: name },
            aliasDeclaration,
            compound,
            direction,
            options,
            sourceUri,
            query,
          )
        : local;
    const element = /^(.*)\[\s*(-?\d+)\s*\]$/.exec(name);
    const rootName = initial.signals.find(
      ({ id }) => id === initial.root,
    )?.name;
    const elementIndex =
      element?.[1] === rootName && element ? Number(element[2]) : undefined;
    const trace = await expandInstanceTrace(
      initial,
      instance,
      design,
      direction,
      options,
      sourceUri,
      query,
      design.kind === "kdb" && unverifiedVcsParameterPaths
        ? "unverifiedVcsParameterPath"
        : designMatches,
      elementIndex !== undefined && Number.isSafeInteger(elementIndex)
        ? elementIndex
        : undefined,
      queryModule,
    );
    if (
      record.packedRange &&
      !alias &&
      designMatches &&
      !unverifiedVcsParameterPaths &&
      !document.isDirty &&
      matchesTraceDeclaration(local, document.uri, line, character)
    ) {
      const root = trace.signals.find(({ id }) => id === trace.root);
      if (root && !root.packedRange) root.packedRange = record.packedRange;
    }
    if (reusedPortTrace) {
      const current = await traceRtlPosition(
        direction,
        document.uri,
        host.position(line, declarationQueryColumn(text, character)),
        { maxDepth: 0 },
        token,
        project,
      );
      if (current.revision !== local.revision)
        throw Error("RTL changed during the instance trace.");
    }
    checkTraceSession();
    return {
      trace,
      instance,
      signal,
      design,
      interfaceRange: alias,
      analysisProject: project,
    };
  }

  function declarationQueryColumn(text: string, column: number) {
    // A macro's source map can leave an offset at the edge of two tokens.
    // Query inside an identifier when possible and keep its start for validation.
    return /^[A-Za-z_$][\w$]|^\\\S/.test(text.slice(column))
      ? column + 1
      : column;
  }

  function matchesTraceDeclaration(
    trace: VideTrace,
    uri: vscode.Uri,
    line: number,
    character: number,
  ) {
    const declaration = trace.signals.find(
      ({ id }) => id === trace.root,
    )?.declaration;
    return (
      declaration?.uri === uri.toString() &&
      declaration.range.start.line === line &&
      declaration.range.start.character === character
    );
  }

  return {
    traceRtlPosition,
    traceWithProject,
    clearPortTraceCache: (project: VideTraceProject) =>
      portTraceCache.delete(project),
  };
}
