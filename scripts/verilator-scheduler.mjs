// SPDX-License-Identifier: MPL-2.0

import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

const cppRef = String.raw`vlSelfRef(?:\.\w+)+`;
const probeStore = new RegExp(
  String.raw`\b\w+____Vdpiimwrap_wave_workbench_write_\w+\([^;]*?\);\s*(?<destination>__Vdly__\w+|` +
    cppRef +
    String.raw`)\s*=\s*(?<sample>(?:vlSelfRef\.)?\w*wave_probe_(?<prefix>[a-f0-9]{16}));`,
  "g",
);
const constantStore = new RegExp(
  String.raw`\b\w+____Vdpiimwrap_wave_workbench_write_\w+\([^;]*?(?<site>"[a-f0-9]{64}"s),\s*"(?<bits>[01]{1,64})"s,\s*0U\);\s*(?<destination>` +
    cppRef +
    String.raw`)\s*=\s*(?<constant>0x[0-9a-fA-F]+|[0-9]+)U(?:LL)?;`,
  "g",
);
const nbaFunction = /^void \w+___nba_sequent__\w+\([^\n]*\) \{\n[\s\S]*?^\}/gm;
const storageCommit = new RegExp(
  String.raw`^\s*(?<target>` +
    cppRef +
    String.raw`)\s*=\s*(?<value>[^;]+);\s*(?<mask>__Vdly_Mask__\w+)\s*=\s*0U;`,
  "gm",
);
const quoted = (value) => JSON.stringify(value);
const targetArgs = ({ instance, signal }) =>
  [instance, signal].map(quoted).join(", ");

function instrumentBody(body, probes, seen) {
  const edits = [];
  const stores = new Map();
  const candidates = [
    ...body.matchAll(probeStore),
    ...body.matchAll(constantStore),
  ];
  for (const match of candidates) {
    const { destination, sample, prefix, bits, constant } = match.groups;
    const scope = /\bvlSymsp->__Vscopep_(\w+)\b/.exec(match[0])?.[1];
    const site = /"([a-f0-9]{64})"s,/.exec(match[0])?.[1];
    const probe = probes.get(scope + "/" + site);
    if (!probe) continue;
    const width =
      bits?.length ??
      Number(/VL_SFORMATF_N_NX\("%b",\s*(\d+)/.exec(match[0])?.[1]);
    const originalSignal =
      "vlSelfRef." +
      probe.instance.slice(4).split(".").join("__DOT__") +
      "__DOT__" +
      probe.signal;
    const matchingStore =
      bits === undefined
        ? site.startsWith(prefix) &&
          match[0].slice(0, match[0].indexOf(";")).includes("," + sample + ")")
        : destination === originalSignal &&
          BigInt(constant) === BigInt("0b" + bits);
    if (
      seen.has(probe) ||
      !matchingStore ||
      !Number.isInteger(width) ||
      width < 1 ||
      width > 64 ||
      !/,\s*0U\);\s*[^;]+;$/.test(match[0])
    )
      throw Error(
        "Cannot verify generated evaluation for " +
          probe.instance +
          "." +
          probe.signal,
      );
    seen.add(probe);
    const pending = "wave_pending_" + destination.replace(/\./g, "_");
    const stage =
      "wave_workbench_stage_nba(" +
      targetArgs(probe) +
      ", " +
      quoted(probe.statementId);
    const offset = match.index + match[0].length;
    if (destination.startsWith("vlSelfRef.")) {
      edits.push({
        offset,
        text:
          "\n    wave_workbench_commit_nba(" +
          targetArgs(probe) +
          ", " +
          stage +
          ", 0), " +
          destination +
          ", " +
          width +
          ");",
      });
      continue;
    }
    const entries = stores.get(destination) ?? [];
    entries.push({ probe, width, offset, pending, stage });
    stores.set(destination, entries);
  }

  const commits = [...body.matchAll(storageCommit)];
  for (const [temporary, entries] of stores) {
    const first = entries[0];
    const { probe, width, pending } = first;
    const fail = () =>
      Error(
        "Cannot verify generated NBA storage for " +
          probe.instance +
          "." +
          probe.signal,
      );
    if (
      entries.some(
        (entry) =>
          entry.width !== width ||
          targetArgs(entry.probe) !== targetArgs(probe),
      )
    )
      throw fail();
    const storeRefs = [
      ...body.matchAll(
        new RegExp(String.raw`\b` + temporary + String.raw`\b`, "g"),
      ),
    ];
    const initializer = new RegExp(
      String.raw`\b` +
        temporary +
        String.raw`;\s*` +
        temporary +
        String.raw` = 0;`,
    ).exec(body);
    if (!initializer) throw fail();
    const stageWrites = () => {
      edits.push({
        offset: initializer.index + initializer[0].length,
        text: "\n    std::uint64_t " + pending + " = 0;",
      });
      for (const entry of entries)
        edits.push({
          offset: entry.offset,
          text:
            "\n        " +
            pending +
            " = " +
            entry.stage +
            ", " +
            pending +
            ");",
        });
    };
    const direct = [
      ...body.matchAll(
        new RegExp(
          String.raw`^\s*(?<target>` +
            cppRef +
            String.raw`)\s*=\s*` +
            temporary +
            String.raw`\s*;`,
          "gm",
        ),
      ),
    ];
    if (direct.length) {
      const seeds = [
        ...body.matchAll(
          new RegExp(
            String.raw`^\s*` +
              temporary +
              String.raw`\s*=\s*(?<target>` +
              cppRef +
              String.raw`)\s*;`,
            "gm",
          ),
        ),
      ];
      const [commit] = direct;
      const [seed] = seeds;
      if (
        direct.length !== 1 ||
        seeds.length !== 1 ||
        seed.groups.target !== commit.groups.target ||
        storeRefs.length !== entries.length + 4 ||
        seed.index <= initializer.index ||
        entries.some(
          ({ offset }) => offset <= seed.index || offset >= commit.index,
        )
      )
        throw fail();
      stageWrites();
      edits.push({
        offset: commit.index + commit[0].length,
        text:
          "\n    wave_workbench_commit_nba(" +
          targetArgs(probe) +
          ", " +
          pending +
          ", " +
          commit.groups.target +
          ", " +
          width +
          ");",
      });
      continue;
    }
    if (storeRefs.length !== entries.length + 3) throw fail();
    const matches = commits.filter(({ groups }) => {
      const { target, mask, value } = groups;
      const unsignedCast = width <= 32 ? "::IData" : "::QData";
      const merge =
        "(((" +
        unsignedCast +
        ")(" +
        temporary +
        ")&(" +
        unsignedCast +
        ")(" +
        mask +
        "))|((" +
        unsignedCast +
        ")(" +
        target +
        ")&(~(" +
        unsignedCast +
        ")(" +
        mask +
        "))))";
      const uncast =
        "((" + temporary + "&" + mask + ")|(" + target + "&(~" + mask + ")))";
      return [merge, uncast].includes(value.replace(/\s/g, ""));
    });
    if (matches.length !== 1) throw fail();
    const commit = matches[0];
    const { target, mask } = commit.groups;
    const beforeReset = commit[0].lastIndexOf(mask + " =");
    if (beforeReset < 0 || entries.some(({ offset }) => offset >= commit.index))
      throw fail();

    const maskWrites = [
      ...body.matchAll(
        new RegExp(String.raw`\b` + mask + String.raw`\s*=\s*([^;]+);`, "g"),
      ),
    ];
    const maskReferences = [
      ...body.matchAll(new RegExp(String.raw`\b` + mask + String.raw`\b`, "g")),
    ];
    if (maskReferences.length !== maskWrites.length + 3) throw fail();
    const full = (1n << BigInt(width)) - 1n;
    const set = maskWrites.filter((assignment) => {
      const value = /^(0x[\da-f]+|\d+)(?:ULL|U)?$/i.exec(assignment[1].trim());
      if (!value) throw fail();
      const bits = BigInt(value[1]);
      if (bits !== 0n && bits !== full) throw fail();
      return bits === full;
    });
    if (
      !set.length ||
      set.some(
        ({ index }) => index < initializer.index || index >= commit.index,
      )
    )
      throw fail();

    stageWrites();
    edits.push({
      offset: commit.index + beforeReset,
      text:
        "if (" +
        mask +
        ") wave_workbench_commit_nba(" +
        targetArgs(probe) +
        ", " +
        pending +
        ", " +
        target +
        ", " +
        width +
        ");\n    " +
        pending +
        " = 0;\n    ",
    });
  }
  for (const { offset, text } of edits.sort((a, b) => b.offset - a.offset))
    body = body.slice(0, offset) + text + body.slice(offset);
  return body;
}

export async function instrumentScheduler(
  probesFile,
  modelDirectory,
  outputDirectory,
) {
  const { sites } = JSON.parse(await readFile(probesFile, "utf8"));
  const probes = new Map();
  for (const site of sites.filter(({ kind }) => kind === "nonblocking")) {
    if (
      !/^TOP\.\w+(?:\.\w+)*$/.test(site.instance) ||
      !/^\w+$/.test(site.signal) ||
      !/^[a-f0-9]{64}$/.test(site.site) ||
      !/^[a-f0-9]{64}$/.test(site.statementId)
    )
      throw Error(
        "Unsupported generated NBA probe " + site.instance + "." + site.signal,
      );
    const scope = site.instance.slice(4).replace(/\./g, "__");
    const key = scope + "/" + site.site;
    if (probes.has(key)) throw Error("Ambiguous generated NBA probe " + key);
    probes.set(key, site);
  }
  if (!probes.size) throw Error("No NBA probes were selected.");
  const files = (await readdir(modelDirectory, { withFileTypes: true }))
    .filter(
      (entry) =>
        entry.isFile() && /\.(?:cpp|h|mk|cmake|json|xml)$/i.test(entry.name),
    )
    .map(({ name }) => name);
  const patches = new Map();
  const seen = new Set();
  let singleThreaded = false;
  for (const file of files.filter((name) => name.endsWith(".cpp"))) {
    const text = await readFile(path.join(modelDirectory, file), "utf8");
    if (!text.startsWith("// Verilated -*- C++ -*-")) continue;
    const threads =
      /^unsigned \w+::threads\(\) const \{ return (\d+); \}$/m.exec(text);
    if (threads) {
      if (threads[1] !== "1")
        throw Error("NBA recording needs a single-threaded Verilator model.");
      singleThreaded = true;
    }
    const transformed = text.replace(nbaFunction, (body) =>
      instrumentBody(body, probes, seen),
    );
    if (transformed !== text)
      patches.set(file, '#include "verilator_execution.h"\n' + transformed);
  }
  if (!singleThreaded)
    throw Error("Cannot verify the Verilator model's thread count.");
  for (const probe of probes.values())
    if (!seen.has(probe))
      throw Error(
        "No recognized NBA store for " +
          probe.instance +
          "." +
          probe.signal +
          " at " +
          probe.statementId,
      );
  // A fresh model directory avoids retaining compiled objects from the input.
  await mkdir(outputDirectory);
  try {
    for (const file of files) {
      const output = path.join(outputDirectory, file);
      const patch = patches.get(file);
      if (patch) await writeFile(output, patch, { flag: "wx" });
      else await copyFile(path.join(modelDirectory, file), output);
    }
  } catch (error) {
    await rm(outputDirectory, { recursive: true, force: true });
    throw error;
  }
}
