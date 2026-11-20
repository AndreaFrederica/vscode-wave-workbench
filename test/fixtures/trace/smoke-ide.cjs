// SPDX-License-Identifier: MPL-2.0

const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");
const vscode = require("vscode");

async function run(workspace) {
  const wave = vscode.extensions.getExtension("andreafrederica.wave-workbench");
  const vide = vscode.extensions.getExtension("pascal-lab.vide-code-extension");
  assert(wave && vide, "Both VSIX packages must be installed.");
  await vide.activate();
  await wave.activate();
  const bridge = join(wave.extensionPath, "dist", "mcp.js");
  const source = vscode.Uri.file(join(workspace, "trace_tb.sv"));
  const filelist = join(workspace, "sources.f");
  const signal = "TOP.trace_tb.dut.owner_q";

  function call(name, args) {
    return new Promise((resolve, reject) => {
      const child = execFile(
        process.env.WAVE_SMOKE_NODE,
        [bridge, workspace],
        { encoding: "utf8", timeout: 30_000 },
        (error, stdout) => {
          if (error) return reject(error);
          try {
            const { result } = JSON.parse(stdout);
            assert(
              result && !result.isError,
              result?.content?.[0]?.text ?? stdout,
            );
            resolve(JSON.parse(result.content[0].text));
          } catch (error) {
            reject(error);
          }
        },
      );
      child.stdin.on("error", reject);
      child.stdin.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: args },
        }) + "\n",
      );
    });
  }

  let reference;
  const formats = {};
  for (const extension of ["vcd", "fst"]) {
    const waveform = join(workspace, "trace." + extension);
    await vscode.commands.executeCommand(
      "waveWorkbench.open",
      vscode.Uri.file(waveform),
    );
    await call("wave_design_attach", {
      waveform,
      path: join(workspace, "obj_dir", "Vtrace_tb.tree.json"),
    });
    await vscode.commands.executeCommand(
      "waveWorkbench.useVideProject",
      vscode.Uri.file(filelist),
      workspace,
    );
    const args = { waveform, signal, detail: "full", format: "mermaid" };
    const drivers = await call("wave_trace_drivers", args);
    assert.equal(drivers.simulationProject.filelist, filelist);
    assert(drivers.compilation.defines.includes("TRACE_PREFER_HART_1"));
    const assignment = drivers.assignments.find((entry) =>
      entry.targets.includes(drivers.root),
    );
    assert(assignment, "The root must have a source assignment.");
    await vscode.commands.executeCommand(
      "waveWorkbench.traceOpenSource",
      assignment.location,
    );
    const editor = vscode.window.activeTextEditor;
    assert.equal(editor.document.uri.toString(), source.toString());
    assert.equal(
      editor.selection.active.line,
      assignment.location.range.start.line,
    );

    const loads = await call("wave_trace_loads", {
      ...args,
      signal: "TOP.trace_tb.request",
    });
    assert(loads.signals.some(({ name }) => name === "grant"));
    const offline = await call("wave_trace_context", {
      ...args,
      tick: "5",
      historyStart: "0",
    });
    assert.equal(
      offline.context.observations.find(({ signal }) => signal === offline.root)
        .value,
      "1",
    );
    assert.equal(offline.context.assignmentCandidates.change.tick, "3");
    assert(offline.context.cursorWriters);
    assert.match(offline.report, /flowchart/);
    const { nodes, edges } = offline.context.temporalTrace;
    assert(edges.length > 0);
    if (reference) assert.deepEqual({ nodes, edges }, reference);
    reference = { nodes, edges };
    const compact = await call("wave_trace_context", {
      waveform,
      signal,
      tick: "5",
      historyStart: "0",
      output: "temporal",
      format: "mermaid",
    });
    assert.equal(compact.output, "temporal");
    assert.equal(compact.context.observations.length, 1);
    assert.deepEqual(
      compact.context.temporalTrace,
      offline.context.temporalTrace,
    );
    for (const edge of edges) {
      for (const id of [edge.assignment, ...(edge.alsoAssignments ?? [])]) {
        assert.deepEqual(
          compact.assignmentSources[id].location,
          offline.assignments[id].location,
        );
      }
    }
    assert.equal(compact.temporalMermaid, offline.temporalMermaid);
    const automatic = await call("wave_trace_context", {
      ...args,
      tick: "5",
      historyStart: "0",
      maxDepth: 1,
      followAllContinuations: true,
    });
    assert.equal(automatic.output, "paged");
    const continuation = automatic.continuation;
    const sections = automatic.graphSnapshot.sections;
    assert.equal(sections.frontier, continuation.remaining);
    assert.equal(sections.queryFailures, 0);
    assert(sections.nodes > 0 && sections.edges > 0);
    assert(sections.mermaid > 0 && sections.report > 0);
    const page = await call("wave_trace_graph_page", {
      graphCursor: automatic.graphSnapshot.graphCursor,
      section: "report",
      limit: 1,
    });
    assert.match(page.items[0].replaceAll("\\_", "_"), /RTL trace of `?TOP\.trace_tb\.dut\.owner_q/);
    const saves = {
      "static.mmd": drivers.mermaid,
      "temporal.mmd": offline.temporalMermaid,
      "report.md": offline.report,
    };
    for (const [name, contents] of Object.entries(saves))
      writeFileSync(join(workspace, extension + "-" + name), contents);
    formats[extension] = {
      assignments: drivers.assignments.length,
      nodes: nodes.length,
      edges: edges.length,
    };
  }
  return {
    platform: process.platform,
    arch: process.arch,
    vscode: vscode.version,
    wave: wave.packageJSON.version,
    vide: vide.packageJSON.version,
    signal,
    formats,
  };
}

module.exports.run = async () => {
  const workspace = vscode.workspace.workspaceFolders[0].uri.fsPath;
  try {
    const result = await run(workspace);
    writeFileSync(
      join(workspace, "verified.json"),
      JSON.stringify(result, null, 2) + "\n",
    );
  } catch (error) {
    writeFileSync(join(workspace, "failure.log"), error.stack ?? String(error));
    throw error;
  }
};
