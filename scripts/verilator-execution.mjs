// SPDX-License-Identifier: MPL-2.0

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  codeOnly,
  simpleAssignmentMacro,
  vcsCaseEntry,
  vcsStandaloneWait,
  vcsGuardEntry,
  vcsWaitEntry,
  vcsWaitOperands,
  vscOperandExpression,
} from "../dist/rtl-selection.js";
import {
  isObservationCoverage,
  isTaskTransferProbes,
} from "../dist/rtl-execution.js";
import { instrumentScheduler } from "./verilator-scheduler.mjs";

const identifier = /^[A-Za-z_$][\w$]*$/;
const instancePath =
  /^[A-Za-z_$][\w$]*(?:\[-?\d+\])?(?:\.[A-Za-z_$][\w$]*(?:\[-?\d+\])?)*$/;
const hash = /^[a-f0-9]{64}$/;
const digest = (data) => createHash("sha256").update(data).digest("hex");

function offset(lineStarts, position) {
  if (
    !Number.isSafeInteger(position?.line) ||
    position.line < 1 ||
    !Number.isSafeInteger(position.column) ||
    position.column < 1
  )
    throw Error("An execution map has an invalid source position.");
  const start = lineStarts[position.line - 1];
  const offset = start + position.column - 1;
  if (!Number.isSafeInteger(offset) || offset >= lineStarts[position.line])
    throw Error("An execution map position is outside its source line.");
  return offset;
}

async function generate(mapsFile, output, externalFile, vcsNba = false) {
  const maps = JSON.parse(await readFile(mapsFile, "utf8"));
  if (!Array.isArray(maps) || !maps.length)
    throw Error("Supply an array of execution maps.");
  const files = new Map();
  const statements = {};
  const sites = [];
  const processSites = new Map();
  const seen = new Set();
  const externalAssignments = new Set();
  const fileReads = new Map();
  if (externalFile) {
    const external = JSON.parse(await readFile(externalFile, "utf8"));
    if (
      !Array.isArray(external.assignments) ||
      !external.steps ||
      typeof external.steps !== "object" ||
      Array.isArray(external.steps)
    )
      throw Error(
        "External execution requires assignment IDs and source step mappings.",
      );
    for (const assignment of external.assignments)
      externalAssignments.add(assignment);
    for (const [id, source] of Object.entries(external.steps)) {
      if (
        !/^[\w.-]{1,128}$/.test(id) ||
        ["__proto__", "prototype", "constructor"].includes(id)
      )
        throw Error("Invalid external execution step ID.");
      const file = path.resolve(path.dirname(externalFile), source.file);
      const bytes = await readFile(file);
      const lines = bytes.toString("utf8").split(/\r?\n/);
      if (
        !Number.isInteger(source.line) ||
        source.line < 1 ||
        source.line > lines.length ||
        !Number.isInteger(source.column) ||
        source.column < 1 ||
        source.column > lines[source.line - 1].length + 1
      )
        throw Error("Invalid external execution source position for " + id);
      statements[id] = {
        file,
        line: source.line,
        column: source.column,
        sha256: digest(bytes),
      };
    }
    if (external.fileReads !== undefined) {
      if (
        !vcsNba ||
        !external.fileReads ||
        typeof external.fileReads !== "object" ||
        Array.isArray(external.fileReads)
      )
        throw Error(
          "Use generate-vcs-nba with a fileReads map of assignment IDs to source step IDs.",
        );
      for (const [assignment, step] of Object.entries(external.fileReads)) {
        if (typeof step !== "string" || !Object.hasOwn(statements, step))
          throw Error("Missing source step for file read " + assignment);
        externalAssignments.add(assignment);
        fileReads.set(assignment, step);
      }
    }
    if (vcsNba && [...externalAssignments].some((id) => !fileReads.has(id)))
      throw Error("VCS external captures currently require a fileReads entry.");
  }
  for (const map of maps) {
    const target = /^([A-Za-z_$][\w$]*)(?:\[(-?(?:0|[1-9]\d*))\])?$/.exec(
      map.signal ?? "",
    );
    const [, signal, word] = target ?? [];
    if (
      map.schemaVersion !== 1 ||
      !target ||
      !Array.isArray(map.statements) ||
      (word !== undefined &&
        (!vcsNba ||
          !map.statements.length ||
          String(Number(word)) !== word ||
          Number(word) < -2147483648 ||
          Number(word) > 2147483647)) ||
      !instancePath.test(map.instance ?? "")
    )
      throw Error("Invalid execution map.");
    for (const entry of map.statements) {
      const {
        statementId,
        processId,
        source,
        operator,
        kind,
        processBody,
        branches = [],
        targetRange,
        targetIndex,
        targetIndexedPart,
        sampleOperands,
        sampleGuards,
        guardEntries,
        arrayElement,
        modport,
        macro,
      } = entry;
      const arraySelector = arrayElement?.selector;
      if (
        word === undefined
          ? arrayElement !== undefined
          : kind !== "nonblocking" ||
            targetIndex !== undefined ||
            sampleOperands !== undefined ||
            typeof arraySelector !== "string" ||
            !(identifier.test(arraySelector) || arraySelector === word)
      )
        throw Error(
          "Select a VCS array word write with a fixed packed range or a whole word.",
        );
      if (
        sampleOperands !== undefined &&
        (!vcsNba ||
          (kind !== "nonblocking" && kind !== "blocking") ||
          targetIndex !== undefined ||
          !Array.isArray(sampleOperands) ||
          !sampleOperands.length ||
          sampleOperands.length > 8 ||
          new Set(sampleOperands).size !== sampleOperands.length ||
          !sampleOperands.every(
            (name) =>
              typeof name === "string" && /^[A-Za-z_][\w$]{0,63}$/.test(name),
          ))
      )
        throw Error(
          "VCS operand capture requires up to eight distinct local operands on a fixed assignment.",
        );
      if (
        sampleGuards !== undefined &&
        (!vcsNba ||
          !Array.isArray(sampleGuards) ||
          !sampleGuards.length ||
          new Set(sampleGuards).size !== sampleGuards.length ||
          new Set([...(sampleOperands ?? []), ...sampleGuards]).size > 8 ||
          !sampleGuards.every(
            (name) =>
              typeof name === "string" && /^[A-Za-z_][\w$]{0,63}$/.test(name),
          ))
      )
        throw Error(
          "VCS guard capture requires up to eight distinct local operands on a supported assignment.",
        );
      if (
        guardEntries !== undefined &&
        (!sampleGuards ||
          !Array.isArray(guardEntries) ||
          !guardEntries.length ||
          guardEntries.length > 8 ||
          guardEntries.some(
            (entry) =>
              !Array.isArray(entry?.names) ||
              !entry.names.length ||
              (kind === "blocking" &&
                (entry.wait !== undefined || entry.caseBody !== undefined)) ||
              (entry.takenWhenTrue !== undefined &&
                typeof entry.takenWhenTrue !== "boolean") ||
              (entry.caseBody !== undefined &&
                (typeof entry.caseBody?.defaultBranch !== "boolean" ||
                  entry.takenWhenTrue !== undefined ||
                  entry.names.length !== 1)) ||
              (entry.wait !== undefined &&
                ((entry.wait !== true && entry.wait !== "standalone") ||
                  entry.caseBody !== undefined ||
                  entry.takenWhenTrue !== undefined)) ||
              new Set(entry.names).size !== entry.names.length ||
              entry.names.some((name) => !sampleGuards.includes(name)),
          ) ||
          guardEntries.reduce((count, entry) => count + entry.names.length, 0) >
            8)
      )
        throw Error("Invalid VCS guard entry capture.");
      if (
        !hash.test(statementId ?? "") ||
        !hash.test(processId ?? "") ||
        !hash.test(source?.sha256 ?? "") ||
        (kind !== "blocking" && kind !== "nonblocking") ||
        operator?.file !== source?.file
      )
        throw Error(
          "Select mapped procedural assignments with an original source operator.",
        );
      if (
        macro &&
        (vcsNba ||
          !identifier.test(macro.name ?? "") ||
          macro.definition?.file !== source.file ||
          macro.definition?.sha256 !== source.sha256)
      )
        throw Error("Invalid Verilator macro source mapping.");
      if (
        targetRange !== undefined &&
        (!vcsNba ||
          !Array.isArray(targetRange) ||
          targetRange.length !== 2 ||
          !targetRange.every(
            (index) =>
              Number.isInteger(index) &&
              index >= -2147483648 &&
              index <= 2147483647,
          ) ||
          Math.abs(targetRange[0] - targetRange[1]) >= 4096)
      )
        throw Error(
          "Fixed packed slices require the VCS generator and a valid range.",
        );
      if (
        targetIndex !== undefined &&
        (!vcsNba ||
          (kind !== "nonblocking" && kind !== "blocking") ||
          targetRange !== undefined ||
          typeof targetIndex !== "string" ||
          !identifier.test(targetIndex))
      )
        throw Error("Dynamic packed targets require a simple VCS index.");
      if (
        targetIndexedPart !== undefined &&
        (!targetIndex ||
          !targetIndexedPart ||
          !Number.isInteger(targetIndexedPart.width) ||
          targetIndexedPart.width < 1 ||
          targetIndexedPart.width > 4096 ||
          typeof targetIndexedPart.ascendingIndices !== "boolean")
      )
        throw Error(
          "Indexed VCS targets require a constant positive width and direction.",
        );
      if (
        modport !== undefined &&
        (!vcsNba ||
          !modport ||
          kind !== "blocking" ||
          word !== undefined ||
          !instancePath.test(modport.owner ?? "") ||
          !/^[A-Za-z_][\w$]*\.[A-Za-z_][\w$]*$/.test(modport.lhs ?? "") ||
          !Number.isInteger(modport.component) ||
          modport.component < 0 ||
          modport.component >= 64 ||
          !Number.isInteger(modport.width) ||
          modport.width < 2 ||
          modport.width > 4096 ||
          !Array.isArray(modport.rhsRange) ||
          modport.rhsRange.length !== 2 ||
          !modport.rhsRange.every(
            (bit) => Number.isInteger(bit) && bit >= 0 && bit < modport.width,
          ) ||
          modport.rhsRange[0] - modport.rhsRange[1] !==
            (targetRange ? Math.abs(targetRange[0] - targetRange[1]) : 0) ||
          externalAssignments.has(statementId))
      )
        throw Error("Invalid VCS output modport component.");
      if (seen.has(statementId))
        throw Error("Duplicate selected statement " + statementId);
      if (Object.hasOwn(statements, statementId))
        throw Error(
          "External step ID overlaps an RTL statement " + statementId,
        );
      seen.add(statementId);
      const filename = path.resolve(source.file);
      const file = files.get(filename) ?? {
        replacements: new Map(),
        processes: new Map(),
        modports: new Map(),
        sha256: source.sha256,
      };
      if (file.sha256 !== source.sha256)
        throw Error("Conflicting source hashes for " + filename);
      files.set(filename, file);
      if (modport) {
        const key = digest(
          JSON.stringify([source.sha256, source.line, source.column]),
        );
        const site = digest(JSON.stringify([key, modport.component]));
        const group = file.modports.get(key) ?? {
          source,
          operator,
          ...modport,
          calls: new Map(),
        };
        const existing = group.calls.get(site);
        if (
          group.lhs !== modport.lhs ||
          group.width !== modport.width ||
          group.operator.line !== operator.line ||
          group.operator.column !== operator.column ||
          (existing && existing.join(":") !== modport.rhsRange.join(":"))
        )
          throw Error(
            "Conflicting modport probe mappings at " +
              filename +
              ":" +
              source.line,
          );
        if (
          sites.some(
            (entry) => entry.site === site && entry.owner === modport.owner,
          )
        )
          throw Error("Duplicate modport component in " + modport.owner);
        group.calls.set(site, modport.rhsRange);
        file.modports.set(key, group);
        statements[statementId] = source;
        sites.push({
          site,
          instance: map.instance,
          owner: modport.owner,
          signal: map.signal,
          statementId,
          processId,
          kind,
          modportWidth: modport.width,
          ...(targetRange ? { targetRange } : {}),
        });
        continue;
      }
      const site = digest(
        JSON.stringify([source.sha256, source.line, source.column, map.signal]),
      );
      const previous = file.replacements.get(site);
      if (
        previous &&
        (JSON.stringify(previous.sampleOperands) !==
          JSON.stringify(sampleOperands) ||
          JSON.stringify(previous.sampleGuards) !==
            JSON.stringify(sampleGuards) ||
          JSON.stringify(previous.guardEntries) !==
            JSON.stringify(guardEntries))
      )
        throw Error(
          "Conflicting operand capture options for " +
            filename +
            ":" +
            source.line,
        );
      const fileRead = fileReads.get(statementId);
      if (word !== undefined && fileRead)
        throw Error("VCS file reads require direct blocking assignments.");
      if (previous?.fileRead && fileRead && previous.fileRead !== fileRead)
        throw Error(
          "Conflicting source steps for file read at " +
            filename +
            ":" +
            source.line,
        );
      file.replacements.set(site, {
        site,
        signal,
        ...(arrayElement ? { word, arraySelector } : {}),
        source,
        operator,
        macro,
        kind,
        targetRange,
        targetIndex,
        targetIndexedPart,
        sampleOperands,
        sampleGuards,
        guardEntries,
        fileRead: fileRead ?? previous?.fileRead,
        recordExternal:
          externalAssignments.has(statementId) ||
          file.replacements.get(site)?.recordExternal,
      });
      statements[statementId] = macro ? { ...source, macro } : source;
      sites.push({
        site,
        instance: map.instance,
        signal: map.signal,
        statementId,
        processId,
        kind,
        ...(targetRange ? { targetRange } : {}),
        ...(targetIndex ? { targetIndex } : {}),
        ...(targetIndexedPart ? { targetIndexedPart } : {}),
        ...(sampleOperands ? { sampleOperands } : {}),
        ...(sampleGuards ? { sampleGuards } : {}),
        ...(guardEntries ? { guardEntries } : {}),
        ...(arrayElement ? { arrayElement } : {}),
      });
      for (const [body, kind] of [
        [processBody, "process"],
        ...branches.map((body) => [body, "branch"]),
      ]) {
        if (body?.begin.file !== source.file || body.first.file !== source.file)
          continue;
        const site = digest(JSON.stringify([kind, source.sha256, body.begin]));
        file.processes.set(site, { body, kind });
        const bySite = processSites.get(site) ?? new Map();
        bySite.set(map.instance, processId);
        processSites.set(site, bySite);
      }
    }
  }
  for (const assignment of externalAssignments)
    if (!seen.has(assignment))
      throw Error("Unknown external evaluation assignment " + assignment);
  if (!sites.length) throw Error("No assignments were selected.");
  const nbaTags = new Map();
  const names = new Set([
    "wave_workbench_probe.sv",
    "wave_workbench_probes.h",
    "execution-probes.json",
  ]);
  for (const [filename, file] of files) {
    const bytes = await readFile(filename);
    if (digest(bytes) !== file.sha256)
      throw Error("Source changed since mapping " + filename);
    const text = bytes.toString("utf8");
    const lexical = codeOnly(text);
    const lineStarts = [
      0,
      ...Array.from(text.matchAll(/\n/g), (match) => match.index + 1),
      text.length,
    ];
    const edits = [];
    const nbaDeclarations = new Map();
    const nbaGroups = new Map();
    const arrayWrites = new Map();
    const guardLocals = new Map();
    if (vcsNba) {
      for (const write of file.replacements.values()) {
        if (write.kind !== "nonblocking") continue;
        const start = offset(lineStarts, write.source);
        const headerEnd = moduleHeaderEnd(lexical, start, filename);
        const key = JSON.stringify([headerEnd, write.signal, write.word]);
        const group = nbaGroups.get(key) ?? { headerEnd, writes: [] };
        group.writes.push(write);
        nbaGroups.set(key, group);
      }
      for (const { headerEnd, writes } of nbaGroups.values()) {
        const declarations = nbaDeclarations.get(headerEnd) ?? new Set();
        for (const [tag, group] of groupVcsNbaTags(writes)) {
          if (lexical.includes(tag))
            throw Error("NBA probe variable already exists in " + filename);
          declarations.add(tag);
          for (const write of group) nbaTags.set(write.site, tag);
        }
        nbaDeclarations.set(headerEnd, declarations);
      }
    }
    for (const {
      site,
      signal,
      source,
      operator,
      macro,
      kind,
      targetRange,
      targetIndex,
      targetIndexedPart,
      sampleOperands,
      sampleGuards,
      guardEntries,
      recordExternal,
      fileRead,
      word,
      arraySelector,
    } of file.replacements.values()) {
      const start = offset(lineStarts, source);
      const op = offset(lineStarts, operator);
      const token = kind === "blocking" ? "=" : "<=";
      const expanded =
        macro &&
        simpleAssignmentMacro(text.split(/\r?\n/), source.line, source.column);
      if (
        macro &&
        (!expanded ||
          expanded.name !== macro.name ||
          expanded.lhs !== signal ||
          expanded.operator !== token ||
          expanded.definition.line !== macro.definition.line ||
          expanded.definition.column !== macro.definition.column)
      )
        throw Error(
          "The selected macro no longer matches its definition at " +
            filename +
            ":" +
            source.line,
        );
      const end = expanded
        ? start + expanded.length - 1
        : lexical.indexOf(";", op + token.length);
      const left =
        expanded?.lhs ?? lexical.slice(start, op).trim().replace(/\s+/g, "");
      const base =
        arraySelector === undefined
          ? signal
          : signal + "[" + arraySelector + "]";
      const selection =
        targetRange &&
        (targetRange[0] === targetRange[1]
          ? [
              base + "[" + targetRange[0] + "]",
              base + "[" + targetRange.join(":") + "]",
            ]
          : [base + "[" + targetRange.join(":") + "]"]);
      const indexedSuffix = targetIndexedPart
        ? (targetIndexedPart.ascendingIndices ? "+:" : "-:") +
          targetIndexedPart.width
        : "";
      if (
        !expanded &&
        (op <= start ||
          !(
            selection ?? [
              targetIndex
                ? base + "[" + targetIndex + indexedSuffix + "]"
                : base,
            ]
          ).includes(left) ||
          !lexical.startsWith(token, op) ||
          end < 0)
      )
        throw Error(
          "Source does not match a complete assignment at " +
            filename +
            ":" +
            source.line,
        );
      const originalRhs = expanded?.rhs ?? text.slice(op + token.length, end);
      let rhs = vcsNba ? originalRhs : originalRhs.trim();
      const descriptor =
        fileRead &&
        /^\s*\$fgetc\s*\(\s*([A-Za-z_][\w$]*)\s*\)\s*$/.exec(
          lexical.slice(op + token.length, end),
        )?.[1];
      if (
        fileRead &&
        (kind !== "blocking" || !descriptor || targetRange || targetIndex)
      )
        throw Error(
          "File reads require a blocking whole-variable assignment from $fgetc with a simple descriptor.",
        );
      if (
        !rhs.trim() ||
        (!expanded && /[`#]/.test(lexical.slice(op + token.length, end)))
      )
        throw Error(
          "Select an assignment without macros or intra-assignment delays.",
        );
      if (
        (targetIndex || arraySelector !== undefined) &&
        /(?:[\w$]\s*\(|\+\+|--|(?<![=!<>])=(?!=))/.test(
          lexical.slice(op + token.length, end),
        )
      )
        throw Error(
          "Select a dynamic or array word assignment with a side-effect-free RHS.",
        );
      const sample = "wave_probe_" + site.slice(0, 16);
      if (lexical.includes(sample))
        throw Error("Probe variable already exists in " + filename);
      const { bareCaptures, entryValues, standaloneWait } = vcsGuardCaptures(
        guardEntries,
        text,
        lexical,
        lineStarts,
        start,
        guardLocals,
        filename,
      );
      if (arraySelector !== undefined) {
        const existing = arrayWrites.get(start);
        const write = existing ?? {
          start,
          end: end + 1,
          signal,
          arraySelector,
          suffix: left.slice(base.length),
          rhs: originalRhs,
          precedingLines: text.slice(start, op).match(/\n/g)?.length ?? 0,
          variants: [],
        };
        if (
          write.end !== end + 1 ||
          write.arraySelector !== arraySelector ||
          write.suffix !== left.slice(base.length)
        )
          throw Error(
            "Conflicting array write selections for " +
              filename +
              ":" +
              source.line,
          );
        if (bareCaptures.size) {
          if (
            write.guardLocals &&
            JSON.stringify([...write.guardLocals]) !==
              JSON.stringify([...bareCaptures])
          )
            throw Error("Conflicting VCS guard entry operands.");
          write.guardLocals = bareCaptures;
        }
        if (
          existing &&
          JSON.stringify(write.standaloneWait) !==
            JSON.stringify(standaloneWait)
        )
          throw Error("Conflicting standalone wait mapping.");
        write.standaloneWait = standaloneWait;
        write.variants.push({
          word,
          site,
          tag: nbaTags.get(site),
          sampleGuards,
          entryValues,
        });
        arrayWrites.set(start, write);
        continue;
      }
      const operandLocals = new Map();
      if (sampleOperands) {
        const expression = vscOperandExpression(originalRhs);
        if (
          recordExternal ||
          !expression ||
          expression.names.length !== sampleOperands.length ||
          !expression.names.every((name) => sampleOperands.includes(name))
        )
          throw Error(
            "Operand capture requires a supported expression that reads each listed local once.",
          );
        for (const [index, name] of expression.names.entries())
          operandLocals.set(name, sample + "_operand_" + index);
        rhs = expression.code.replace(/[A-Za-z_][\w$]*/g, (name) =>
          operandLocals.get(name),
        );
      }
      for (const name of sampleGuards ?? [])
        if (!operandLocals.has(name))
          operandLocals.set(name, sample + "_operand_" + operandLocals.size);
      const operandArguments = operandLocals.size
        ? ", $sformatf(" +
          JSON.stringify(
            [...operandLocals.keys()].map((name) => name + "=%b").join(","),
          ) +
          ", " +
          [...operandLocals.values()].join(", ") +
          ")"
        : "";
      const sampledBlockingEvaluation =
        "wave_workbench_probe::wave_workbench_blocking_evaluate_" +
        (entryValues.length ? "guarded(" : "sampled(") +
        JSON.stringify(site) +
        ', $sformatf("%b", ' +
        sample +
        ")" +
        operandArguments +
        vcsGuardArguments(entryValues) +
        ");";
      const probe = (value, committed) =>
        "wave_workbench_probe::wave_workbench_write(" +
        JSON.stringify(site) +
        ', $sformatf("%b", ' +
        value +
        "), " +
        committed +
        ");";
      const savedIndex = targetIndex && sample + "_index";
      const sampledNbaIndex =
        kind === "nonblocking" && savedIndex && operandLocals.size;
      const guardArguments = vcsGuardArguments(entryValues);
      const savedTarget = savedIndex
        ? signal + "[" + savedIndex + indexedSuffix + "]"
        : left;
      const indexedBlocking = kind === "blocking" && !!savedIndex;
      const blockingPartProbe = (committed) =>
        "wave_workbench_probe::wave_workbench_blocking_write_part(" +
        [
          JSON.stringify(site),
          '$sformatf("%b", ' + sample + ")",
          '$sformatf("%0d", ' + savedIndex + ")",
          "$left(" + signal + ")",
          "$right(" + signal + ")",
          committed,
          committed ? '$sformatf("%b", ' + signal + ")" : '""',
        ].join(", ") +
        (committed
          ? ', "", ""'
          : (operandArguments || ', ""') + (guardArguments || ', ""')) +
        ");";
      const indexedProbe = (value, committed) =>
        "wave_workbench_probe::" +
        (!committed && guardArguments
          ? "wave_workbench_blocking_evaluate_index_guarded("
          : "wave_workbench_blocking_write_index(") +
        JSON.stringify(site) +
        ', $sformatf("%b", ' +
        value +
        ")" +
        ', $sformatf("%0d", ' +
        savedIndex +
        ")" +
        ", $low(" +
        signal +
        "), $high(" +
        signal +
        ")" +
        (!committed && guardArguments
          ? operandArguments + guardArguments
          : ", " +
            committed +
            (committed || !operandLocals.size ? ', ""' : operandArguments)) +
        ");";
      let write = savedTarget + " " + token + " " + sample + ";";
      let nbaToken;
      if (kind === "nonblocking" && vcsNba) {
        const tag = nbaTags.get(site);
        nbaToken = sample + "_ordinal";
        write =
          "if (" +
          nbaToken +
          " != 0) { " +
          savedTarget +
          ", " +
          tag +
          " } <= { " +
          sample +
          ", " +
          nbaToken +
          " }; else " +
          write;
      }
      const replacement = [
        "begin",
        ...vcsGuardDeclarations(bareCaptures),
        ...(savedIndex
          ? [
              "automatic type(" +
                targetIndex +
                ") " +
                savedIndex +
                " = " +
                targetIndex +
                ";",
            ]
          : []),
        ...Array.from(
          operandLocals,
          ([name, local]) =>
            "automatic type(" + name + ") " + local + " = " + name + ";",
        ),
        "automatic type(" +
          savedTarget +
          ") " +
          sample +
          (recordExternal ? ";" : " = " + rhs + ";"),
        ...(descriptor
          ? [
              "automatic int " + sample + "_offset;",
              "automatic int " + sample + "_byte;",
            ]
          : []),
        ...(recordExternal
          ? [
              "wave_workbench_probe::wave_workbench_begin_evaluation(" +
                JSON.stringify(site) +
                ");",
              ...(descriptor
                ? [
                    sample + "_offset = $ftell(" + descriptor + ");",
                    sample + "_byte = $fgetc(" + descriptor + ");",
                    "wave_workbench_probe::wave_workbench_file_read(" +
                      JSON.stringify(fileRead) +
                      ", " +
                      sample +
                      "_offset, " +
                      sample +
                      "_byte);",
                    sample + " = " + sample + "_byte;",
                  ]
                : [sample + " = " + rhs + ";"]),
            ]
          : []),
        ...(nbaToken
          ? [
              "automatic longint unsigned " +
                nbaToken +
                " = wave_workbench_probe::" +
                (savedIndex
                  ? sampledNbaIndex
                    ? "wave_workbench_nba_evaluate_index_sampled"
                    : "wave_workbench_nba_evaluate_index"
                  : entryValues.length
                    ? "wave_workbench_nba_evaluate_guarded"
                    : operandLocals.size
                      ? "wave_workbench_nba_evaluate_sampled"
                      : "wave_workbench_nba_evaluate") +
                "(" +
                JSON.stringify(site) +
                ', $sformatf("%b", ' +
                sample +
                ")" +
                (savedIndex ? ', $sformatf("%0d", ' + savedIndex + ")" : "") +
                operandArguments +
                (guardArguments || (sampledNbaIndex ? ', ""' : "")) +
                ");",
            ]
          : [
              indexedBlocking
                ? targetIndexedPart
                  ? blockingPartProbe(0)
                  : indexedProbe(sample, 0)
                : operandLocals.size
                  ? sampledBlockingEvaluation
                  : probe(sample, 0),
            ]),
        write,
        ...(kind === "blocking"
          ? [
              indexedBlocking
                ? targetIndexedPart
                  ? blockingPartProbe(1)
                  : indexedProbe(savedTarget, 1)
                : probe(left, 1),
            ]
          : []),
        "end",
      ].join(vcsNba ? " " : "\n");
      edits.push(
        wrapStandaloneWait(
          text,
          {
            start,
            end: end + 1,
            // Preserve subsequent KDB line numbers when the generated path is mapped to the original RTL.
            replacement:
              replacement +
              (vcsNba
                ? "\n".repeat(
                    text.slice(start, fileRead ? end : op).match(/\n/g)
                      ?.length ?? 0,
                  )
                : ""),
          },
          standaloneWait,
        ),
      );
    }
    for (const write of arrayWrites.values())
      edits.push(
        wrapStandaloneWait(text, vcsArrayNbaEdit(write), write.standaloneWait),
      );
    for (const [key, group] of file.modports) {
      const start = offset(lineStarts, group.source);
      const operator = offset(lineStarts, group.operator);
      const end = lexical.indexOf(";", operator + 1);
      const left = lexical.slice(start, operator).replace(/\s+/g, "");
      if (
        start >= operator ||
        end < 0 ||
        left !== group.lhs ||
        lexical[operator] !== "=" ||
        !/^\s*[A-Za-z_][\w$]*\s*$/.test(lexical.slice(operator + 1, end))
      )
        throw Error(
          "Source does not match a simple modport assignment at " +
            filename +
            ":" +
            group.source.line,
        );
      const sample = "wave_probe_" + key.slice(0, 16);
      if (lexical.includes(sample))
        throw Error("Probe variable already exists in " + filename);
      const covered = new Set();
      for (const range of group.calls.values())
        for (let bit = range[1]; bit <= range[0]; bit++) {
          if (covered.has(bit))
            throw Error("Overlapping modport RHS probe ranges.");
          covered.add(bit);
        }
      const calls = (complete) =>
        [...group.calls].map(
          ([site, range]) =>
            "wave_workbench_probe::wave_workbench_write(" +
            JSON.stringify(site) +
            ', $sformatf("%b", ' +
            sample +
            "[" +
            range.join(":") +
            "]), " +
            complete +
            ");",
        );
      edits.push({
        start,
        end: end + 1,
        replacement:
          [
            "begin automatic logic [" +
              (group.width - 1) +
              ":0] " +
              sample +
              " = " +
              lexical.slice(operator + 1, end).trim() +
              ";",
            ...calls(0),
            group.lhs + " = " + sample + ";",
            ...calls(1),
            "end",
          ].join(" ") +
          "\n".repeat(text.slice(start, end).match(/\n/g)?.length ?? 0),
      });
    }
    for (const [position, captures] of guardLocals) {
      edits.push({
        start: position,
        end: position,
        replacement: " " + vcsGuardDeclarations(captures).join(" "),
      });
    }
    for (const [offset, declarations] of nbaDeclarations)
      edits.push({
        start: offset,
        end: offset,
        replacement: [...declarations]
          .map((tag) => " bit [63:0] " + tag + ";")
          .join(""),
      });
    for (const [site, { body, kind }] of file.processes) {
      if (
        !body.begin.line ||
        !body.first.line ||
        !body.begin.column ||
        !body.first.column
      )
        continue;
      const begin = offset(lineStarts, body.begin);
      const first = offset(lineStarts, body.first);
      if (!/^begin\s+$/.test(lexical.slice(begin, first))) continue;
      edits.push({
        start: first,
        end: first,
        replacement:
          "wave_workbench_probe::wave_workbench_" +
          kind +
          "(" +
          JSON.stringify(site) +
          ");\n",
      });
      for (const [instance, processId] of processSites.get(site)) {
        const statementId =
          kind === "branch" ? digest(JSON.stringify([instance, site])) : "";
        if (statementId)
          statements[statementId] = { ...body.begin, sha256: file.sha256 };
        sites.push({
          site,
          instance,
          processId,
          statementId,
          signal: "",
          kind,
        });
      }
    }
    edits.sort((a, b) => b.start - a.start || b.end - a.end);
    let previous = text.length;
    file.contents = text;
    for (const edit of edits) {
      if (edit.end > previous)
        throw Error("Selected assignments overlap in " + filename);
      file.contents =
        file.contents.slice(0, edit.start) +
        edit.replacement +
        file.contents.slice(edit.end);
      previous = edit.start;
    }
    file.name = path.basename(filename);
    if (names.has(file.name))
      throw Error("Duplicate generated filename " + file.name);
    names.add(file.name);
  }
  await mkdir(output);
  if (vcsNba)
    for (const site of sites) {
      if (nbaTags.has(site.site)) site.nbaTag = nbaTags.get(site.site);
    }
  const hasModports = sites.some(({ owner }) => owner);
  const probeMap =
    JSON.stringify(
      {
        statements,
        sites,
        ...(vcsNba ? { vcsNba: true } : {}),
        ...(hasModports ? { vcsModportCallbacks: true } : {}),
      },
      null,
      2,
    ) + "\n";
  const vcsMetadata = vcsNba
    ? "#define WAVE_WORKBENCH_VCS_NBA_TAGS 1\n#define WAVE_WORKBENCH_VCS_PROBE_TARGETS { " +
      sites
        .map(({ nbaTag, targetRange, targetIndex, targetIndexedPart }) => {
          const tag = nbaTag ? JSON.stringify(nbaTag) : "0";
          const delta = targetIndexedPart
            ? (targetIndexedPart.width - 1) *
              (targetIndexedPart.ascendingIndices ? 1 : -1)
            : 0;
          return (
            "{ " +
            [
              tag,
              targetIndex ? 2 : targetRange ? 1 : 0,
              ...(targetRange ?? [delta, 0]),
            ].join(", ") +
            " }"
          );
        })
        .join(", ") +
      " }\n"
    : "";
  const probeOwners = hasModports
    ? "#define WAVE_WORKBENCH_VCS_MODPORT_CALLBACKS 1\n#define WAVE_WORKBENCH_VCS_PROBE_OWNERS { " +
      sites
        .map(({ owner }) => (owner ? JSON.stringify(owner) : "0"))
        .join(", ") +
      " }\n#define WAVE_WORKBENCH_VCS_MODPORT_WIDTHS { " +
      sites.map(({ modportWidth }) => modportWidth ?? 0).join(", ") +
      " }\n"
    : "";
  await Promise.all([
    ...Array.from(files.values(), (file) =>
      writeFile(path.join(output, file.name), file.contents),
    ),
    writeFile(path.join(output, "execution-probes.json"), probeMap),
    writeFile(
      path.join(output, "wave_workbench_probe.sv"),
      [
        "/* verilator lint_off TIMESCALEMOD */",
        "package wave_workbench_probe;",
        '  import "DPI-C" context function void wave_workbench_write(input string site, input string value, input bit committed);',
        ...(vcsNba
          ? [
              '  import "DPI-C" context function longint unsigned wave_workbench_nba_evaluate(input string site, input string value);',
              '  import "DPI-C" context function longint unsigned wave_workbench_nba_evaluate_index(input string site, input string value, input string index_value);',
              ...(sites.some(
                ({ kind, targetIndex, sampleGuards }) =>
                  kind === "nonblocking" && targetIndex && sampleGuards,
              )
                ? [
                    '  import "DPI-C" context function longint unsigned wave_workbench_nba_evaluate_index_sampled(input string site, input string value, input string index_value, input string operands, input string guards);',
                  ]
                : []),
              ...(sites.some(
                ({ kind, targetIndex }) => kind === "blocking" && targetIndex,
              )
                ? [
                    '  import "DPI-C" context function void wave_workbench_blocking_write_index(input string site, input string value, input string index_value, input int low_index, input int high_index, input bit committed, input string operands);',
                  ]
                : []),
              ...(sites.some(
                ({ kind, targetIndexedPart }) =>
                  kind === "blocking" && targetIndexedPart,
              )
                ? [
                    '  import "DPI-C" context function void wave_workbench_blocking_write_part(input string site, input string value, input string index_value, input int left, input int right, input bit committed, input string storage, input string operands, input string guards);',
                  ]
                : []),
              ...(sites.some(
                ({ kind, targetIndex, guardEntries }) =>
                  kind === "blocking" && targetIndex && guardEntries,
              )
                ? [
                    '  import "DPI-C" context function void wave_workbench_blocking_evaluate_index_guarded(input string site, input string value, input string index_value, input int low_index, input int high_index, input string operands, input string guards);',
                  ]
                : []),
              ...(sites.some(
                ({ sampleOperands, sampleGuards }) =>
                  sampleOperands || sampleGuards,
              )
                ? [
                    '  import "DPI-C" context function longint unsigned wave_workbench_nba_evaluate_sampled(input string site, input string value, input string operands);',
                  ]
                : []),
              ...(sites.some(
                ({ kind, targetIndex, sampleOperands, sampleGuards }) =>
                  kind === "blocking" &&
                  !targetIndex &&
                  (sampleOperands || sampleGuards),
              )
                ? [
                    '  import "DPI-C" context function void wave_workbench_blocking_evaluate_sampled(input string site, input string value, input string operands);',
                  ]
                : []),
              ...(sites.some(({ guardEntries }) => guardEntries)
                ? [
                    '  import "DPI-C" context function longint unsigned wave_workbench_nba_evaluate_guarded(input string site, input string value, input string operands, input string guards);',
                    '  import "DPI-C" context function longint unsigned wave_workbench_guard_tick();',
                    '  import "DPI-C" context function longint unsigned wave_workbench_guard_next_ordinal();',
                  ]
                : []),
              ...(sites.some(
                ({ kind, guardEntries }) => kind === "blocking" && guardEntries,
              )
                ? [
                    '  import "DPI-C" context function void wave_workbench_blocking_evaluate_guarded(input string site, input string value, input string operands, input string guards);',
                  ]
                : []),
            ]
          : []),
        '  import "DPI-C" context function void wave_workbench_begin_evaluation(input string site);',
        ...(fileReads.size
          ? [
              '  import "DPI-C" context function void wave_workbench_file_read(input string site, input int offset, input int value);',
            ]
          : []),
        '  import "DPI-C" context function void wave_workbench_process(input string site);',
        '  import "DPI-C" context function void wave_workbench_branch(input string site);',
        "endpackage",
        "/* verilator lint_on TIMESCALEMOD */",
        "",
      ].join("\n"),
    ),
    writeFile(
      path.join(output, "wave_workbench_probes.h"),
      '#define WAVE_WORKBENCH_PROBES_SHA256 "' +
        digest(probeMap) +
        '"\n' +
        vcsMetadata +
        probeOwners +
        sites
          .map(
            (site) =>
              "{ " +
              [
                site.site,
                site.instance,
                site.signal,
                site.statementId,
                site.processId,
                site.kind,
              ]
                .map((field) => JSON.stringify(field))
                .join(", ") +
              " },",
          )
          .join("\n") +
        "\n",
    ),
  ]);
}

function moduleHeaderEnd(lexical, start, filename) {
  let moduleStart;
  let inModule = false;
  for (const match of lexical.matchAll(
    /\b(?:module|macromodule|endmodule)\b/g,
  )) {
    if (match.index > start) {
      inModule = match[0] === "endmodule" && moduleStart !== undefined;
      break;
    }
    moduleStart = match[0] === "endmodule" ? undefined : match.index;
  }
  if (!inModule) throw Error("Select a VCS NBA inside a module in " + filename);
  let nesting = 0;
  for (let index = moduleStart; index < start; index++) {
    const character = lexical[index];
    if (character === ";" && nesting === 0) {
      let position = index + 1;
      // Timing declarations must precede other module items.
      for (
        let timing = /^\s*time(?:unit|precision)\b[^;]*;/.exec(
          lexical.slice(position, start),
        );
        timing;
        timing = /^\s*time(?:unit|precision)\b[^;]*;/.exec(
          lexical.slice(position, start),
        )
      ) {
        position += timing[0].length;
      }
      return position;
    }
    if (character === "(") nesting++;
    if (character === ")") nesting--;
  }
  throw Error("Cannot find the VCS module header end in " + filename);
}

function groupVcsNbaTags(writes) {
  const { signal, word } = writes[0];
  const encode = (index) =>
    Number(index) < 0 ? "m" + Math.abs(Number(index)) : String(index);
  const prefix =
    "wave_workbench_nba_tag_" +
    signal.length +
    "_" +
    signal +
    (word === undefined ? "" : "_word_" + encode(word));
  const groups = new Map();
  // Reuse a tag for identical lvalues. Distinct selections can be observed
  // independently, even when their evaluated target bits overlap.
  for (const write of writes) {
    let tag = prefix;
    if (write.targetRange) {
      const low = Math.min(...write.targetRange);
      const high = Math.max(...write.targetRange);
      tag += "_" + encode(low) + "_" + encode(high);
    } else if (write.targetIndex) {
      const part = write.targetIndexedPart;
      const selection = [
        write.targetIndex,
        part?.width,
        part?.ascendingIndices,
      ];
      tag += "_dynamic_" + digest(JSON.stringify(selection)).slice(0, 16);
    }
    const group = groups.get(tag) ?? [];
    group.push(write);
    groups.set(tag, group);
  }
  return groups;
}

function vcsGuardDeclarations(captures) {
  return [...(captures ?? [])].flatMap(([name, local]) => [
    "automatic type(" + name + ") " + local + " = " + name + ";",
    "automatic longint unsigned " +
      local +
      "_tick = wave_workbench_probe::wave_workbench_guard_tick();",
    `automatic longint unsigned ${local}_ordinal = wave_workbench_probe::wave_workbench_guard_next_ordinal();`,
  ]);
}

function vcsGuardCaptures(
  entries,
  source,
  lexical,
  lineStarts,
  assignment,
  guardLocals,
  filename,
) {
  const bareCaptures = new Map();
  const entryValues = [];
  let standaloneWait;
  for (const entry of entries ?? []) {
    const first = offset(lineStarts, entry.first);
    const last = offset(lineStarts, entry.last);
    const takenWhenTrue = entry.takenWhenTrue !== false;
    const arm = entry.caseBody;
    const waitOperands =
      entry.wait && vcsWaitOperands(source.slice(first, last));
    if (
      entry.wait &&
      (!waitOperands ||
        waitOperands.names.length !== entry.names.length ||
        waitOperands.names.some((name, index) => name !== entry.names[index]))
    )
      throw Error("VCS wait operands differ from its source map.");
    const standalone =
      entry.wait === "standalone" &&
      vcsStandaloneWait(lexical, first, last, assignment);
    const branch =
      entry.wait === "standalone"
        ? undefined
        : entry.wait
          ? vcsWaitEntry(lexical, first, last, assignment)
          : arm
            ? lexical.slice(first, last) === entry.names[0] &&
              vcsCaseEntry(
                lexical,
                first,
                last,
                offset(lineStarts, arm.first),
                offset(lineStarts, arm.last),
                assignment,
                source,
              )
            : vcsGuardEntry(lexical, first, last, assignment, takenWhenTrue);
    if (!branch && !standalone)
      throw Error("VCS guard entry differs from its source map.");
    const captures = new Map(
      entry.names.map((name, index) => [
        name,
        "wave_guard_" +
          first +
          (entry.wait
            ? "_wait_"
            : arm
              ? "_case_"
              : takenWhenTrue
                ? "_"
                : "_else_") +
          index,
      ]),
    );
    if (standalone) {
      if (
        standaloneWait ||
        [...captures.values()].some((local) => lexical.includes(local))
      )
        throw Error("Conflicting standalone wait operands.");
      standaloneWait = { ...standalone, captures: [...captures] };
    }
    const previous = standalone
      ? undefined
      : branch.bare
        ? bareCaptures
        : guardLocals.get(branch.at);
    if (
      previous?.size &&
      JSON.stringify([...previous]) !== JSON.stringify([...captures])
    )
      throw Error("Conflicting VCS guard entry operands.");
    if (!standalone && !previous?.size) {
      if ([...captures.values()].some((local) => lexical.includes(local)))
        throw Error("Guard capture variable already exists in " + filename);
      if (branch.bare) {
        for (const [name, local] of captures) bareCaptures.set(name, local);
      } else guardLocals.set(branch.at, captures);
    }
    for (const [name, local] of captures) {
      const key =
        (entry.wait ? (waitOperands.compound ? "p" : "w") : arm ? "c" : "g") +
        entry.first.line +
        "_" +
        entry.first.column +
        (arm ? (arm.defaultBranch ? "d_" : "_") : takenWhenTrue ? "_" : "f_") +
        name;
      if (key.length > 64) throw Error("Guard entry capture name is too long.");
      entryValues.push([key, local]);
    }
  }
  return { bareCaptures, entryValues, standaloneWait };
}

function wrapStandaloneWait(text, edit, wait) {
  if (!wait) return edit;
  const declarations = wait.captures.map(
    ([name, local]) =>
      `automatic type(${name}) ${local}; automatic longint unsigned ${local}_tick, ${local}_ordinal;`,
  );
  const samples = wait.captures.map(
    ([name, local]) =>
      `${local} = ${name}; ${local}_tick = wave_workbench_probe::wave_workbench_guard_tick(); ${local}_ordinal = wave_workbench_probe::wave_workbench_guard_next_ordinal();`,
  );
  return {
    start: wait.start,
    end: edit.end,
    replacement: `begin ${declarations.join(" ")} ${text.slice(wait.start, wait.semicolon)} begin ${samples.join(" ")} end${text.slice(wait.semicolon + 1, edit.start)}${edit.replacement} end`,
  };
}

function vcsGuardArguments(entryValues) {
  return entryValues.length
    ? ", $sformatf(" +
        JSON.stringify(
          entryValues.map(([key]) => key + "=%b@%0d#%0d").join(","),
        ) +
        ", " +
        entryValues
          .flatMap(([, local]) => [local, local + "_tick", local + "_ordinal"])
          .join(", ") +
        ")"
    : "";
}

function vcsArrayNbaEdit({
  start,
  end,
  signal,
  arraySelector,
  suffix,
  rhs,
  precedingLines,
  variants,
  guardLocals,
}) {
  const local = "wave_probe_" + variants[0].site.slice(0, 16);
  const index = local + "_word";
  const value = local + "_value";
  const ordinal = local + "_ordinal";
  const target = signal + "[" + index + "]" + suffix;
  const write = target + " <= " + value + ";";
  const replacement = [
    "begin",
    ...vcsGuardDeclarations(guardLocals),
    "automatic type(" +
      arraySelector +
      ") " +
      index +
      " = " +
      arraySelector +
      ";",
    "automatic type(" + target + ") " + value + " = " + rhs + ";",
    'case ($sformatf("%0d", ' + index + "))",
    ...variants.map(({ word, site, tag, sampleGuards, entryValues }) => {
      const evaluate = entryValues.length
        ? "wave_workbench_nba_evaluate_guarded"
        : sampleGuards
          ? "wave_workbench_nba_evaluate_sampled"
          : "wave_workbench_nba_evaluate";
      const operands = sampleGuards
        ? ", $sformatf(" +
          JSON.stringify(sampleGuards.map((name) => name + "=%b").join(",")) +
          ", " +
          sampleGuards.join(", ") +
          ")"
        : "";
      return (
        JSON.stringify(word) +
        ": begin automatic longint unsigned " +
        ordinal +
        " = wave_workbench_probe::" +
        evaluate +
        "(" +
        JSON.stringify(site) +
        ', $sformatf("%b", ' +
        value +
        ")" +
        operands +
        vcsGuardArguments(entryValues) +
        "); if (" +
        ordinal +
        " != 0) { " +
        target +
        ", " +
        tag +
        " } <= { " +
        value +
        ", " +
        ordinal +
        " }; else " +
        write +
        " end"
      );
    }),
    "default: " + write,
    "endcase end",
  ].join(" ");
  return { start, end, replacement: replacement + "\n".repeat(precedingLines) };
}

async function generateVcsPli(configFile, output) {
  const config = JSON.parse(await readFile(configFile, "utf8"));
  if (
    !Array.isArray(config.calls) ||
    !config.calls.length ||
    config.calls.length > 128
  )
    throw Error("Supply an array of VCS PLI call sites.");
  const base = path.dirname(path.resolve(configFile));
  async function source(location) {
    const file = path.resolve(base, location.file);
    const bytes = await readFile(file);
    const lines = bytes.toString("utf8").split(/\r?\n/);
    const { line, column } = location;
    if (
      !Number.isInteger(line) ||
      line < 1 ||
      line > lines.length ||
      !Number.isInteger(column) ||
      column < 1 ||
      column > lines[line - 1].length
    )
      throw Error("Invalid PLI source location in " + file);
    return {
      file,
      line,
      column,
      sha256: digest(bytes),
      text: lines[line - 1].slice(column - 1),
    };
  }
  const statements = Object.create(null);
  for (const [id, location] of Object.entries(config.steps ?? {})) {
    if (!/^[\w.-]{1,128}$/.test(id)) throw Error("Invalid PLI step ID.");
    const { text, ...position } = await source(location);
    statements[id] = position;
  }
  const sites = [];
  const seen = new Set();
  for (const {
    site,
    instance,
    signal,
    call,
    location,
    compiledFile,
    compiledLine,
  } of config.calls) {
    if (
      !/^[\w.-]{1,128}$/.test(site) ||
      !instancePath.test(instance ?? "") ||
      !identifier.test(signal ?? "") ||
      !/^\$[A-Za-z_][\w$]*$/.test(call ?? "")
    )
      throw Error("Invalid VCS PLI call or target.");
    const { text, ...position } = await source(location);
    if (text.match(/^\$[A-Za-z_][\w$]*/)?.[0] !== call)
      throw Error("Point the PLI probe at the original RTL call.");
    const file = compiledFile ?? position.file;
    const line = compiledLine ?? position.line;
    const key = JSON.stringify([site, instance, file, line]);
    if (
      typeof file !== "string" ||
      !file ||
      /[\x00-\x1f]/.test(file) ||
      !Number.isSafeInteger(line) ||
      line < 1 ||
      line > 2147483647 ||
      seen.has(key)
    )
      throw Error("Invalid or ambiguous compiled PLI call location.");
    seen.add(key);
    const statementId = digest(JSON.stringify([instance, signal, position]));
    const processId = digest(JSON.stringify([instance, position, call]));
    if (Object.hasOwn(statements, statementId))
      throw Error("Duplicate PLI statement ID.");
    statements[statementId] = position;
    sites.push({
      site,
      instance,
      signal,
      statementId,
      processId,
      kind: "subroutineCall",
      file,
      line,
    });
  }
  const probeMap = JSON.stringify({ statements, sites }, null, 2) + "\n";
  const cLiteral = (value) => JSON.stringify(value);
  const header = [
    "#define WAVE_WORKBENCH_PROBES_SHA256 " + cLiteral(digest(probeMap)),
    "#define WAVE_WORKBENCH_VCS_PLI_SITES { " +
      sites
        .map(({ file, line }) => "{ " + cLiteral(file) + ", " + line + " }")
        .join(", ") +
      " }",
    ...sites.map(
      ({ site, instance, signal, statementId, processId, kind }) =>
        "{ " +
        [site, instance, signal, statementId, processId, kind]
          .map(cLiteral)
          .join(", ") +
        " },",
    ),
    "",
  ].join("\n");
  await mkdir(output);
  await Promise.all([
    writeFile(path.join(output, "execution-probes.json"), probeMap),
    writeFile(path.join(output, "wave_workbench_probes.h"), header),
  ]);
}

function validateCoverage(coverage, sites) {
  if (
    !Array.isArray(coverage) ||
    coverage.length === 0 ||
    !Array.isArray(sites)
  )
    throw Error("Supply an array of execution coverage entries.");
  const targets = new Map();
  for (const site of sites) {
    if (!["blocking", "nonblocking", "subroutineCall"].includes(site.kind))
      continue;
    const target = site.instance + "\0" + site.signal;
    const writers = targets.get(target) ?? new Set();
    writers.add(site.processId);
    targets.set(target, writers);
  }
  const seen = new Set();
  for (const entry of coverage) {
    if (
      typeof entry?.start !== "string" ||
      !/^\d{1,20}$/.test(entry.start) ||
      typeof entry.instance !== "string" ||
      typeof entry.signal !== "string" ||
      !Array.isArray(entry.writers)
    )
      throw Error("Invalid execution coverage entry.");
    const target = entry.instance + "\0" + entry.signal;
    const writers = targets.get(target);
    if (
      !writers ||
      seen.has(target) ||
      entry.writers.length !== writers.size ||
      new Set(entry.writers).size !== writers.size ||
      !entry.writers.every((writer) => writers.has(writer))
    )
      throw Error(
        "Coverage must list the generated write processes for " +
          entry.instance +
          "." +
          entry.signal,
      );
    seen.add(target);
  }
}

async function seal(probesFile, waveform, scale, raw, output, coverageFile) {
  const probes = await readFile(probesFile);
  const { statements, sites } = JSON.parse(probes);
  const coverage =
    coverageFile && JSON.parse(await readFile(coverageFile, "utf8"));
  if (coverageFile) validateCoverage(coverage, sites);
  async function* events() {
    yield* createReadStream(raw);
  }
  await sealRecording(waveform, scale, events(), output, probes, {
    statements,
    ...(coverage ? { coverage } : {}),
  });
}

async function sealVpi(
  waveform,
  raw,
  output,
  probesFile,
  coverageFile,
  taskTransferFile,
) {
  const probes = probesFile && (await readFile(probesFile));
  const { statements = {}, sites } = probes ? JSON.parse(probes) : {};
  const writerCoverage =
    coverageFile && JSON.parse(await readFile(coverageFile, "utf8"));
  if (coverageFile) validateCoverage(writerCoverage, sites);
  const taskTransferBytes =
    taskTransferFile && (await readFile(taskTransferFile));
  const taskTransferProbes = taskTransferBytes && JSON.parse(taskTransferBytes);
  if (
    taskTransferBytes &&
    (!isTaskTransferProbes(taskTransferProbes) ||
      ![
        taskTransferProbes.input,
        taskTransferProbes.inputIndex,
        taskTransferProbes.write,
        taskTransferProbes.writeIndex,
        ...taskTransferProbes.fileReads,
      ].every((id) => Object.hasOwn(statements, id)))
  )
    throw Error("Task transfer probes require a matching execution probe map.");
  const capture = createReadStream(raw);
  const lines = createInterface({ input: capture, crlfDelay: Infinity });
  try {
    const iterator = lines[Symbol.asyncIterator]();
    const first = await iterator.next();
    const header = first.done ? undefined : JSON.parse(first.value);
    const precision = header?.timePrecision;
    if (
      header?.type !== "vpi-capture" ||
      !Number.isInteger(precision) ||
      precision < -15 ||
      precision > 0
    )
      throw Error(
        "The VPI recording must declare a supported simulation time precision.",
      );
    const coverage = header.observationCoverage;
    if (coverage !== undefined && !isObservationCoverage(coverage))
      throw Error("The VPI recording declares invalid observation coverage.");
    if ((header.dpiExecutionEvents === true) !== Boolean(probes))
      throw Error("Supply the matching probe map for a VCS DPI recording.");
    if (probes && header.probeMapSha256 !== digest(probes))
      throw Error("The VCS capture and probe map SHA-256 differ.");
    const unit = Math.ceil(-precision / 3);
    const scale =
      10 ** (precision + 3 * unit) + ["s", "ms", "us", "ns", "ps", "fs"][unit];
    const events = (async function* () {
      for (
        let next = await iterator.next();
        !next.done;
        next = await iterator.next()
      )
        yield next.value + "\n";
    })();
    const identity = Buffer.concat([
      Buffer.from(first.value),
      ...(probes ? [probes] : []),
      ...(taskTransferBytes ? [taskTransferBytes] : []),
    ]);
    await sealRecording(waveform, scale, events, output, identity, {
      statements,
      ...(writerCoverage ? { coverage: writerCoverage } : {}),
      ...(coverage ? { observationCoverage: coverage } : {}),
      ...(taskTransferProbes ? { taskTransferProbes } : {}),
    });
  } finally {
    lines.close();
    capture.destroy();
  }
}

async function sealRecording(
  waveform,
  scale,
  events,
  output,
  identity,
  metadata,
) {
  const waveformHash = createHash("sha256");
  for await (const chunk of createReadStream(waveform))
    waveformHash.update(chunk);
  const waveformSha256 = waveformHash.digest("hex");
  const header = {
    format: "wave-workbench-execution",
    schemaVersion: 1,
    scale,
    buildId: digest(Buffer.concat([identity, Buffer.from(waveformSha256)])),
    waveformSha256,
    ...metadata,
  };
  await pipeline(
    Readable.from(
      (async function* () {
        yield JSON.stringify(header) + "\n";
        yield* events;
      })(),
    ),
    createWriteStream(output, { flag: "wx" }),
  );
}

const [command, ...args] = process.argv.slice(2);
if (command === "generate" && [2, 3].includes(args.length))
  await generate(...args);
else if (command === "generate-vcs-nba" && [2, 3].includes(args.length))
  await generate(args[0], args[1], args[2], true);
else if (command === "generate-vcs-pli" && args.length === 2)
  await generateVcsPli(...args);
else if (command === "scheduler" && args.length === 3)
  await instrumentScheduler(...args);
else if (command === "seal" && [5, 6].includes(args.length))
  await seal(...args);
else if (
  command === "seal-vpi" &&
  args.length === 6 &&
  args[4] === "--task-transfers"
)
  await sealVpi(...args.slice(0, 4), undefined, args[5]);
else if (
  command === "seal-vpi" &&
  args.length === 7 &&
  args[5] === "--task-transfers"
)
  await sealVpi(...args.slice(0, 5), args[6]);
else if (command === "seal-vpi" && [3, 4, 5].includes(args.length))
  await sealVpi(...args);
else
  throw Error(
    "Usage: verilator-execution.mjs generate MAPS_JSON NEW_OUTPUT_DIRECTORY [EXTERNAL_JSON], generate-vcs-nba MAPS_JSON NEW_OUTPUT_DIRECTORY [EXTERNAL_JSON], generate-vcs-pli CALLS_JSON NEW_OUTPUT_DIRECTORY, scheduler PROBES_JSON MODEL_DIRECTORY NEW_MODEL_DIRECTORY, seal PROBES_JSON WAVEFORM SCALE RAW_JSONL NEW_OUTPUT_JSONL [COVERAGE_JSON], or seal-vpi WAVEFORM RAW_JSONL NEW_OUTPUT_JSONL [PROBES_JSON [COVERAGE_JSON] [--task-transfers TASK_PROBES_JSON]]",
  );
