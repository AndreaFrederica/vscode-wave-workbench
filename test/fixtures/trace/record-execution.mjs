// SPDX-License-Identifier: MPL-2.0
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const [rtl, waveform, rawEvents, output, coverageFile, mappingFile] = process.argv.slice(2);
if (!output) throw Error("Usage: node record-execution.mjs RTL WAVEFORM RAW_EVENTS OUTPUT [COVERAGE_JSON [EXECUTION_MAPS_JSON]]");
const digest = (data) => createHash("sha256").update(data).digest("hex");
async function digestFile(filename) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest("hex");
}
const sourceBytes = await fs.readFile(rtl);
const source = sourceBytes.toString("utf8");
const sourceHash = digest(sourceBytes);
const statements = Object.create(null);
for (const [line, text] of source.split("\n").entries()) {
  const id = /\/\/ wave-trace: ([\w.]+)/.exec(text)?.[1];
  if (!id) continue;
  if (Object.hasOwn(statements, id)) throw Error("Duplicate statement marker " + id);
  statements[id] = {
    file: path.relative(path.dirname(path.resolve(output)), path.resolve(rtl)),
    line: line + 1,
    column: text.search(/\S/) + 1,
    sha256: sourceHash,
  };
}
if (path.resolve(output) === path.resolve(rawEvents)) throw Error("Use a separate output file.");
const [waveformSha256, rawHash] = await Promise.all([digestFile(waveform), digestFile(rawEvents)]);
const coverage = coverageFile
  ? JSON.parse(await fs.readFile(coverageFile, "utf8"))
  : { start: "0", instance: "TOP.trace_tb.dut", signal: "owner_q", writers: ["owner"] };
const processIds = new Map();
const statementIds = new Map();
const position = ({ sha256, line, column }) => JSON.stringify([sha256, line, column]);
const identity = (instance, name) => JSON.stringify([instance, name]);
const normalizedStatements = mappingFile ? Object.create(null) : statements;
const coverageEntries = Array.isArray(coverage) ? coverage : [coverage];
if (mappingFile) {
  const maps = JSON.parse(await fs.readFile(mappingFile, "utf8"));
  const mappedTargets = new Map(maps.map((map) => [identity(map.instance, map.signal), map]));
  const originalStatements = new Map(Object.entries(statements).map(([id, source]) => [position(source), id]));
  for (const entry of coverageEntries) {
    const map = mappedTargets.get(identity(entry.instance, entry.signal));
    const processes = new Set(map?.statements.map(({ processId }) => processId));
    if (map?.schemaVersion !== 1 || processes.size !== 1 || entry.writers.length !== 1)
      throw Error("Expected an execution map with one writer for " + entry.instance + "." + entry.signal);
    const processId = processes.values().next().value;
    if (!processId) throw Error("The execution map has an unresolved process.");
    processIds.set(identity(entry.instance, entry.writers[0]), processId);
    entry.writers = [processId];
    for (const target of map.statements) {
      const legacy = originalStatements.get(position(target.source));
      if (!legacy || !target.statementId)
        throw Error("The execution map has no matching probe at line " + target.source.line);
      statementIds.set(identity(entry.instance, legacy), target.statementId);
      normalizedStatements[target.statementId] = statements[legacy];
    }
  }
}

async function* events() {
  if (!mappingFile) {
    yield* createReadStream(rawEvents);
    return;
  }
  const lines = createInterface({ input: createReadStream(rawEvents), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const event = JSON.parse(line);
    if (event.type !== "end") {
      const processId = processIds.get(identity(event.instance, event.processId));
      if (!processId) throw Error("Unmapped process " + event.processId);
      event.processId = processId;
      if (event.statementId) {
        const statementId = statementIds.get(identity(event.instance, event.statementId));
        if (!statementId) throw Error("Unmapped statement " + event.statementId);
        event.statementId = statementId;
      }
    }
    yield JSON.stringify(event) + "\n";
  }
}
const header = {
  format: "wave-workbench-execution",
  schemaVersion: 1,
  waveformSha256,
  buildId: digest(source + "\0" + waveformSha256 + "\0" + rawHash +
    (mappingFile ? "\0" + JSON.stringify(normalizedStatements) : "")),
  scale: "1ps",
  statements: normalizedStatements,
  coverage,
};
await pipeline(Readable.from((async function* () {
  yield JSON.stringify(header) + "\n";
  yield* events();
})()), createWriteStream(output));
