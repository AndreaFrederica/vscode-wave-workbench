const { createHash } = require("node:crypto");
const { readFileSync, writeFileSync } = require("node:fs");
const { resolve } = require("node:path");

const file = resolve("recorded_dpi_tb.sv");
const rtl = readFileSync(file, "utf8").split("\n");
const worker = readFileSync("worker.cc", "utf8").split("\n");
const hash = (text) => createHash("sha256").update(text).digest("hex");
const sha256 = hash(rtl.join("\n"));
function position(lines, text) {
  const line = lines.findIndex((line) => line.includes(text));
  if (line < 0) throw new Error("Fixture source is missing " + text);
  return { line: line + 1, column: lines[line].indexOf(text) + 1 };
}

const source = { file, ...position(rtl, "result = consume"), sha256 };
const process = { file, ...position(rtl, "always @"), sha256 };
const instance = "TOP.recorded_dpi_tb";
const signal = "result";
const kind = "blocking";
const processId = hash(
  JSON.stringify([instance, sha256, process.line, process.column]),
);
const statementId = hash(
  JSON.stringify([instance, signal, kind, sha256, source.line, source.column]),
);
const statement = {
  kind,
  source,
  process,
  processId,
  statementId,
  operator: { file, ...position(rtl, "= consume") },
  processBody: { begin: { file, ...position(rtl, "begin") }, first: source },
};

const steps = {
  "worker.input": {
    file: "worker.cc",
    ...position(worker, 'wave_workbench_external_step("worker.input"'),
  },
  "worker.result": {
    file: "worker.cc",
    ...position(worker, 'wave_workbench_external_step("worker.result"'),
  },
  "worker.complete": {
    file: "worker.cc",
    ...position(worker, "wave_workbench_observe_external("),
  },
};
writeFileSync(
  "maps.json",
  JSON.stringify([
    { schemaVersion: 1, instance, signal, statements: [statement] },
  ]),
);
writeFileSync(
  "external.json",
  JSON.stringify({ assignments: [statementId], steps }),
);
writeFileSync(
  "coverage.json",
  JSON.stringify([{ instance, signal, start: "0", writers: [processId] }]),
);
