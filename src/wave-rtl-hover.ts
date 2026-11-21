// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import * as path from "node:path";
import type * as vscode from "vscode";
import type { Viewer } from "./viewer";
import type { Location } from "./shared/protocol";
import { mapPrefix } from "./kdb";
import { codeOnly, identifiers, portConnection } from "./rtl-selection";
import { findRtlSignals, readSignalsAt } from "./signal-lookup";
import { commonScope, moduleAt, type SourceFiles } from "./source-sync";
import { formatValue } from "./commands";
import { decodeWord } from "./shared/decoders";
import * as WaveSignal from "./shared/signals";
import type { GetViewer, WaveAnalysis } from "./wave-extension-types";

function rtlValue(raw: string, width: number) {
  const shown =
    width > 1 && /^[01xz]+$/i.test(raw)
      ? "0x" + formatValue(raw, width, "Hex", true)
      : raw;
  return shown.length > 256 ? shown.slice(0, 256) + "…" : shown;
}

type VSCodeApi = typeof vscode;

export function registerWaveRtlHover(
  vscode: VSCodeApi,
  {
    context,
    output,
    languages,
    getCurrent,
    sourceFiles,
    sourceInstances,
    dumpScope,
  }: {
    context: vscode.ExtensionContext;
    output: vscode.OutputChannel;
    languages: string[];
    getCurrent: GetViewer;
    sourceFiles: SourceFiles;
    sourceInstances: (
      viewer: Viewer,
      file: string,
      module: string,
      valid: () => boolean,
    ) => Promise<Location[]>;
    dumpScope: WaveAnalysis["dumpScope"];
  },
) {
  if (!vscode.languages?.registerHoverProvider) return;

  const rtlDocuments = new WeakMap<
    vscode.TextDocument,
    { version: number; text: string; code: string }
  >();
  async function connectedInstance(
    viewer: Viewer,
    parent: string,
    name: string,
    file: string,
    line: number,
    valid: () => boolean,
  ) {
    const session = viewer.kdb;
    const mappings = vscode.workspace
      .getConfiguration("waveWorkbench", viewer.uri)
      .get<Record<string, string>>("sourcePathMappings");
    async function matches(fullname: string) {
      const record = await session.resolve(fullname).catch((error) => {
        if (!String(error.message).startsWith("KDB object not found:"))
          throw error;
        return undefined;
      });
      return (
        valid() &&
        record?.fullname === fullname &&
        ["npiModule", "npiInterface"].includes(record.kind) &&
        record.line === line &&
        !!record.file &&
        sourceFiles.same(
          file,
          path.resolve(
            path.dirname(session.path),
            mapPrefix(record.file, mappings),
          ),
        )
      );
    }
    const direct = parent + "." + name;
    if (await matches(direct)) return direct;
    const scopes = [parent];
    const candidates: string[] = [];
    for (const scope of scopes) {
      if (!valid()) return;
      for (const child of await session.children(scope, true)) {
        if (child.kind === "npiGenScope") scopes.push(child.fullname);
        else if (
          child.fullname !== direct &&
          child.fullname.endsWith("." + name) &&
          ["npiModule", "npiInterface"].includes(child.kind) &&
          (await matches(child.fullname))
        )
          candidates.push(child.fullname);
      }
    }
    return candidates.length === 1
      ? candidates[0]
      : candidates.find(
          (scope) =>
            viewer.selectedScope === scope ||
            viewer.selectedScope.startsWith(scope + "."),
        );
  }
  async function provideRtlHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ) {
    const viewer = getCurrent();
    if (!viewer?.meta || !viewer.kdb || !viewer.rtlCursor) return;
    const session = viewer.kdb;
    const cursor = viewer.rtlCursor;
    const selectedScope = viewer.selectedScope;
    const valid = () =>
      !token.isCancellationRequested &&
      getCurrent() === viewer &&
      !viewer.disposed &&
      viewer.kdb === session &&
      viewer.rtlCursor === cursor &&
      viewer.selectedScope === selectedScope;
    if (!valid()) return;

    let source = rtlDocuments.get(document);
    if (source?.version !== document.version) {
      const text = document.getText();
      source = { version: document.version, text, code: codeOnly(text) };
      rtlDocuments.set(document, source);
    }
    const nameRange = document.getWordRangeAtPosition(
      position,
      /[A-Za-z_$][\w$]*/,
    );
    if (!nameRange) return;
    const start = document.offsetAt(nameRange.start);
    const end = document.offsetAt(nameRange.end);
    const name = document.getText(nameRange);
    if (source.code.slice(start, end) !== name || identifiers(name)[0] !== name)
      return;
    const line = document.lineAt(position.line).text;
    const before = line.slice(0, nameRange.start.character).trimEnd();
    const after = line.slice(nameRange.end.character);
    const connection = portConnection(source.text, source.code, start, end);
    if (
      !connection?.portAtCursor &&
      (/(?:[.`\\]|::)$/.test(before) || /^\s*(?:::|\.|\()/.test(after))
    )
      return;
    const indices = /^(?:\s*\[\s*-?\d+\s*\])*/.exec(after)[0];
    const target = name + indices.replace(/\s/g, "");
    const module = moduleAt(source.text, position.line);
    if (!module) return;

    const file = document.uri.fsPath;
    const matches = await sourceInstances(viewer, file, module, valid);
    if (!valid() || !matches.length) return;
    const selected = matches
      .filter(
        ({ fullname }) =>
          selectedScope === fullname ||
          selectedScope.startsWith(fullname + "."),
      )
      .sort((a, b) => b.fullname.length - a.fullname.length)[0];
    const remembered = viewer.sourceInstances.get(file);
    const best = Math.max(
      ...matches.map(({ fullname }) => commonScope(fullname, selectedScope)),
    );
    const closest = matches.filter(
      ({ fullname }) => commonScope(fullname, selectedScope) === best,
    );
    const instance =
      selected ||
      closest.find(({ fullname }) => fullname === remembered) ||
      (closest.length === 1 ? closest[0] : undefined);
    if (!instance)
      return new vscode.Hover(
        "Wave Workbench · 请在波形侧边栏选择要查看的实例",
        nameRange,
      );

    const scope = dumpScope(viewer, instance.fullname);
    const child =
      connection &&
      (await connectedInstance(
        viewer,
        instance.fullname,
        connection.instance,
        file,
        document.positionAt(connection.instanceOffset).line + 1,
        valid,
      ));
    if (!valid() || (connection?.portAtCursor && !child)) return;
    const targets =
      connection && child
        ? [
            { scope: dumpScope(viewer, child), name: connection.port },
            ...(connection.actual ? [{ scope, name: connection.actual }] : []),
          ]
        : [{ scope, name: target }];
    if (connection && !connection.portAtCursor) targets.reverse();
    const groups = await Promise.all(
      targets.map(async (target) => ({
        ...target,
        ...(await findRtlSignals(viewer.backend, target.scope, target.name)),
      })),
    );
    if (
      !connection &&
      session.kind === "verilator" &&
      !groups[0].signals.length &&
      selectedScope.startsWith(instance.fullname + ".")
    ) {
      const selected = await session.resolve(selectedScope);
      if (["npiGenScope", "npiNamedBegin"].includes(selected?.kind)) {
        const scope = dumpScope(viewer, selectedScope);
        groups[0] = {
          scope,
          name: target,
          ...(await findRtlSignals(viewer.backend, scope, target)),
        };
      }
    }
    const signals = groups.flatMap((group) => group.signals);
    if (!valid() || !signals.length) return;
    const values = await readSignalsAt(viewer.backend, signals, cursor.tick);
    if (!valid() || values.every((value) => value === undefined)) return;
    const unit = cursor.displayScale || viewer.meta.scale;
    const time = Number((cursor.tick / cursor.displayFactor).toPrecision(15));
    const markdown = new vscode.MarkdownString();
    markdown.appendMarkdown("**Wave Workbench · 游标 A**\n\n");
    markdown.appendText(
      `${time} × ${unit} · ${path.basename(viewer.uri.fsPath)}`,
    );
    markdown.appendMarkdown("\n\n");
    const [signal] = signals;
    if (groups.length > 1 || signals.length > 1 || groups[0].partial) {
      let offset = 0;
      for (const group of groups) {
        const rows = group.signals.map((member, index) => {
          const value = values[offset + index];
          return `${member.name} = ${value === undefined ? "—" : rtlValue(value, member.width)}`;
        });
        offset += group.signals.length;
        if (!rows.length) continue;
        markdown.appendCodeblock(
          [`${group.scope}.${group.name}`, ...rows].join("\n"),
          "text",
        );
        if (group.partial) markdown.appendText("仅显示部分已记录元素");
      }
      return new vscode.Hover(markdown, nameRange);
    }
    const [raw] = values;
    const style = viewer.document.view?.chosen.find(
      (entry) => WaveSignal.key(entry) === WaveSignal.key(signal),
    );
    const decoded =
      viewer.document.view?.showDecodedValues !== false &&
      style?.decoder &&
      decodeWord(style.decoder, raw, signal.width);
    markdown.appendCodeblock(
      `${signal.scope}.${WaveSignal.label(signal)}`,
      "text",
    );
    const bits = /^[01xz]+$/i.test(raw);
    markdown.appendText(`值  ${rtlValue(raw, signal.width)}`);
    if (bits && signal.width > 1 && signal.width <= 128) {
      markdown.appendMarkdown("\n\n");
      markdown.appendText(
        "Binary  " + formatValue(raw, signal.width, "Bin", true),
      );
    }
    if (decoded) {
      markdown.appendMarkdown("\n\n");
      markdown.appendText("解码  " + decoded);
    }
    if (style?.annotation) {
      markdown.appendMarkdown("\n\n");
      markdown.appendText(
        style.annotation.tags.map((tag) => "#" + tag).join(" "),
      );
      if (style.annotation.note) {
        markdown.appendMarkdown("\n\n");
        markdown.appendText(style.annotation.note);
      }
    }
    return new vscode.Hover(markdown, nameRange);
  }
  context.subscriptions.push(
    vscode.languages.registerHoverProvider(
      [...languages, { pattern: "**/*.{sv,svh,v,vh}" }],
      {
        async provideHover(document, position, token) {
          try {
            return await provideRtlHover(document, position, token);
          } catch (error) {
            if (
              !token.isCancellationRequested &&
              !String(error.message).startsWith("Dumped signal not found:")
            )
              output.appendLine("RTL hover: " + error.message);
          }
        },
      },
    ),
  );
}
