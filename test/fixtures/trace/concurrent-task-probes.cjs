const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const file = path.resolve("concurrent_task_tb.sv");
const source = fs.readFileSync(file, "utf8");
const hash = (s) => createHash("sha256").update(s).digest("hex");
const at = (text) => {
  const lines = source.split("\n");
  const line = lines.findIndex((line) => line.includes(text));
  if (line < 0) throw Error(text);
  return {
    file,
    line: line + 1,
    column: lines[line].indexOf(text) + 1,
    sha256: hash(source),
  };
};
const defs = {
  argument: ["arg_data", "8'(index == 1", "task"],
  argument_index: ["arg_index", "8'(index == 1", "task"],
  write: ["field_write", "bus.data = data", "task"],
  write_index: ["field_index", "bus.data = data", "task"],
  read_first: ["fd_first", "first_value = \$fgetc", "run"],
  read_second: ["fd_second", "second_value = \$fgetc", "run"],
};
const sites = Object.entries(defs).map(
  ([site, [signal, pattern, process]]) => ({
    site,
    signal,
    instance: "concurrent_task_tb",
    statementId: hash(site),
    processId: hash(process),
    kind: "blocking",
    source: at(pattern),
  }),
);
const statements = Object.fromEntries(
  sites.map(({ statementId, source }) => [statementId, source]),
);
statements["read.first"] = at("first_value = \$fgetc");
statements["read.second"] = at("second_value = \$fgetc");
const map = JSON.stringify({
  sites: sites.map(({ source, ...site }) => site),
  statements,
  vcsNba: false,
});
fs.writeFileSync("probes.json", map);
const config = {
  instance: "concurrent_task_tb",
  signal: "bus.data",
  input: hash("argument"),
  inputIndex: hash("argument_index"),
  write: hash("write"),
  writeIndex: hash("write_index"),
  fileReads: ["read.first", "read.second"],
};
fs.writeFileSync("task-transfers.json", JSON.stringify(config));
fs.writeFileSync(
  "wave_workbench_probes.h",
  '#define WAVE_WORKBENCH_PROBES_SHA256 "' +
    hash(map) +
    '"\n' +
    sites
      .map(
        ({ site, instance, signal, statementId, processId, kind }) =>
          "{" +
          [site, instance, signal, statementId, processId, kind]
            .map(JSON.stringify)
            .join(",") +
          "},",
      )
      .join("\n") +
    "\n",
);
