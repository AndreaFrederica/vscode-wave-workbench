// SPDX-License-Identifier: MPL-2.0

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const sparseCaseFixture = process.env.WAVE_TEST_GENERATE_WITHOUT_DEFAULT;
const hierarchicalReadFixture = process.env.WAVE_TEST_VCS_XMR;
for (const [suffix, intermediateXmrFixture] of [
  ["", process.env.WAVE_TEST_VCS_XMR_INTERMEDIATE],
  [" via an included macro", process.env.WAVE_TEST_VCS_XMR_INTERMEDIATE_MACRO],
  [" via nested token-pasting macros", process.env.WAVE_TEST_VCS_XMR_NESTED_MACRO],
]) test("standalone MCP expands a cross-file Load from an intermediate signal" + suffix, {
  skip: !intermediateXmrFixture,
}, () => {
  const fixture = path.resolve(intermediateXmrFixture);
  const waveform = path.join(fixture, "trace.vcd");
  const options = { waveform, filelist: path.join(fixture, "sources.f"), maxDepth: 4 };
  const [, , loads, other, context, continued] = callTraceMcp(fixture, [
    ["wave_open", { path: waveform, backend: "independent" }],
    ["wave_design_attach", { waveform, path: path.join(fixture, "simv.daidir") }],
    ["wave_trace_loads", { ...options, signal: "mid_tb.u_leaf.stimulus" }],
    ["wave_trace_loads", { ...options, signal: "mid_tb.u_other.stimulus" }],
    ["wave_trace_context", {
      ...options, signal: "mid_tb.u_observer.observed", tick: "2", historyStart: "0",
    }],
    ["wave_trace_context", {
      ...options, signal: "mid_tb.u_observer.observed", tick: "2", historyStart: "0",
      output: "paged", continueFrom: { signal: "mid_tb.u_leaf.middle", tick: "2", historyStart: "0" },
    }],
  ]);
  const name = (trace, id) => {
    const signal = trace.signals.find(signal => signal.id === id);
    return signal.instance + "." + signal.name;
  };
  assert(loads.assignments.some(assignment =>
    assignment.targets.some(id => name(loads, id) === "mid_tb.u_observer.observed") &&
    assignment.inputs.some(({signal}) => name(loads, signal) === "mid_tb.u_leaf.middle")));
  assert(!other.signals.some(({instance}) => instance === "mid_tb.u_observer"));
  const {nodes, edges} = context.context.temporalTrace;
  assert(edges.some(({source, target}) =>
    name(context, nodes[source].signal) === "mid_tb.u_leaf.middle" &&
    nodes[source].tick === "2" && nodes[source].value === "1" &&
    nodes[target].signal === context.root));
  assert.equal(continued.graphSnapshot.metadata.gapSummary.byReason.selectedContinuation.joined, 1);
});

const macroMapFixture = process.env.WAVE_TEST_VERILATOR_MACRO_MAP;
test("standalone MCP maps both Verilator assignment macro sites in each instance", {
  skip: !macroMapFixture,
}, () => {
  const fixture = path.resolve(macroMapFixture);
  const waveform = path.join(fixture, "macro.vcd");
  const source = path.join(fixture, "macro_map_tb.sv");
  const instances = ["macro_map_tb.left", "macro_map_tb.right"];
  const [, , ...maps] = callTraceMcp(fixture, [
    ["wave_open", { path: waveform }],
    ["wave_design_attach", { waveform, path: path.join(fixture, "obj_dir/Vmacro_map_tb.tree.json") }],
    ...instances.map(instance => ["wave_execution_map", { waveform, instance, signal: "q" }]),
  ]);
  for (const [index, map] of maps.entries()) {
    assert.equal(map.instance, instances[index]);
    assert.deepEqual(map.statements.map(statement => [
      statement.source.file, statement.source.line, statement.source.column,
      statement.process.line, statement.diagnostic, statement.macro.name,
      statement.macro.definition.line, statement.macro.definition.column,
    ]), [
      [source, 5, 5, 4, undefined, "WRITE_Q", 2, 1],
      [source, 6, 14, 4, undefined, "WRITE_Q", 2, 1],
    ]);
  }
  const statements = maps.flatMap(map => map.statements);
  assert.equal(new Set(statements.map(({statementId}) => statementId)).size, 4);
  assert(statements.every(({statementId}) => /^[a-f0-9]{64}$/.test(statementId)));
});

const driverLoadFixture = process.env.WAVE_TEST_VCS_DRIVER_LOAD;
test("standalone MCP traces VCS case data, NBA overrides, holds and async reset", {
  skip: !driverLoadFixture,
}, () => {
  const fixture = path.resolve(driverLoadFixture);
  const waveform = path.join(fixture, "trace.vcd");
  const options = { waveform, filelist: path.join(fixture, "sources.f") };
  const scope = "driver_load_tb.dut.";
  const expected = [
    ["1", "1", "0000", 18],
    ["3", "3", "0101", 24],
    ["5", "3", "0101", 24],
    ["7", "7", "0010", 21],
    ["9", "9", "0011", 21],
    ["10", "10", "0000", 18],
  ];
  const loads = {
    "a[1]": [["continuous", "data"], ["blocking", "data"]],
    b: [["blocking", "data"]],
    c: [["blocking", "data"]],
    d: [["nonblocking", "data"]],
    e: [["nonblocking", "data"]],
    rst_n: [["nonblocking", "control"], ["nonblocking", "trigger", "falling"]],
    clk: [["nonblocking", "trigger", "rising"]],
    en: [["nonblocking", "control"], ["blocking", "control"]],
    replace: [["nonblocking", "control"]],
    mode: [["nonblocking", "control"]],
    sel: [["blocking", "control"]],
    acc: [["blocking", "data"]],
  };
  const [, , ...traces] = callTraceMcp(fixture, [
    ["wave_open", { path: waveform, backend: "independent" }],
    ["wave_design_attach", { waveform, path: path.join(fixture, "simv.daidir") }],
    ...expected.map(([tick]) => ["wave_trace_context", {
      ...options, signal: scope + "q", tick, historyStart: "0",
    }]),
    ...Object.keys(loads).map(signal => ["wave_trace_loads", {
      ...options, signal: scope + signal,
    }]),
  ]);
  for (const [index, [, tick, value, line]] of expected.entries()) {
    const { context: { temporalTrace, assignmentCandidates } } = traces[index];
    assert.deepEqual([temporalTrace.nodes[0].tick, temporalTrace.nodes[0].value], [tick, value]);
    const candidate = assignmentCandidates.candidates
      .find(({ location }) => location.range.start.line + 1 === line);
    assert.equal(candidate.status, value === "0000" ? "possible" : "consistentWithObservations");
  }
  for (const [index, [signal, relations]] of Object.entries(loads).entries()) {
    const { assignments, root } = traces[expected.length + index];
    for (const [kind, inputKind, edge] of relations) {
      assert(assignments.some(assignment =>
        assignment.kind === kind && assignment.inputs.some(input =>
          input.signal === root && input.kind === inputKind && (input.edge ?? undefined) === edge
        )), signal + " " + [kind, inputKind, edge].join(" "));
    }
  }
});

const virtualInterfaceFixture = process.env.WAVE_TEST_VCS_VIRTUAL_INTERFACE;
test("standalone MCP preserves the VCS virtual-interface access gaps and observed values", {
  skip: !virtualInterfaceFixture,
}, () => {
  const fixture = path.resolve(virtualInterfaceFixture);
  const waveform = path.join(fixture, "trace.vcd");
  const options = { waveform, filelist: path.join(fixture, "sources.f") };
  const cases = [
    ["result", "2", "0011"],
    ["result", "5", "1001"],
    ["left.data", "1", "0011"],
    ["right.data", "4", "1001"],
  ];
  const [, , loads, ...reads] = callTraceMcp(fixture, [
    ["wave_open", { path: waveform, backend: "independent" }],
    ["wave_design_attach", { waveform, path: path.join(fixture, "simv.daidir") }],
    ["wave_trace_loads", { ...options, signal: "virtual_if_tb.stimulus" }],
    ...cases.map(([signal, tick]) => ["wave_trace_context", {
      ...options, signal: "virtual_if_tb." + signal, tick, historyStart: "0",
    }]),
  ]);
  const accessLines = trace => trace.frontier
    .filter(({ reason }) => reason === "unresolvedVirtualInterfaceBinding")
    .map(({ location }) => location.range.start.line + 1);
  assert.deepEqual(accessLines(loads), [20, 25]);
  assert(loads.assignments.every(({ targets }) => !targets.length));
  assert(loads.signals.every(({ name }) => name !== "write_port"));
  for (const [index, trace] of reads.entries()) {
    const [, tick, value] = cases[index];
    assert.deepEqual(accessLines(trace), index < 2 ? [21, 26] : []);
    const root = trace.context.temporalTrace.nodes[0];
    assert.deepEqual([root.tick, root.value], [tick, value]);
  }
});

const virtualInterfaceExecution = process.env.WAVE_TEST_VCS_VIRTUAL_INTERFACE_EXECUTION;
test("standalone MCP replays the physical interface accesses on both sides of rebinding", {
  skip: !virtualInterfaceExecution,
}, () => {
  const fixture = path.resolve(virtualInterfaceExecution);
  const waveform = path.join(fixture, "trace.vcd");
  const executionLog = path.join(fixture, "execution-v2.jsonl");
  const top = "virtual_if_tb";
  const [, ...readings] = callTraceMcp(fixture, [
    ["wave_open", { path: waveform, backend: "independent" }],
    ...[[top + ".left", "data"], [top + ".right", "data"], [top, "result"]]
      .map(([instance, signal]) => ["wave_execution_trace", {
        waveform, executionLog, instance, signal, historyStart: "0", tick: "5",
      }]),
  ]);
  const accesses = ({ events }) => events.flatMap(({ tick, statementSite, interfaceAccesses }) =>
    (interfaceAccesses ?? []).map(({ direction, instance, signal }) =>
      [tick, statementSite.line, direction, instance, signal]));
  const left = [
    ["1", 20, "write", top + ".left", "data"],
    ["2", 21, "read", top + ".left", "data"],
  ];
  const right = [
    ["4", 25, "write", top + ".right", "data"],
    ["5", 26, "read", top + ".right", "data"],
  ];
  assert.deepEqual(readings.map(accesses), [left, right, [left[1], right[1]]]);
  assert.deepEqual(readings.map(({ events }) => events
    .filter(({ kind }) => kind === "signal-value-changed")
    .map(({ value }) => value)), [["0011"], ["1001"], ["0011", "1001"]]);
});

const dynamicOutputFixture = process.env.WAVE_TEST_VERILATOR_DYNAMIC_OUTPUT;
test("standalone MCP tracks the index and data of a Verilator output part-select", {
  skip: !dynamicOutputFixture,
}, () => {
  const fixture = path.resolve(dynamicOutputFixture);
  const waveform = path.join(fixture, "dynamic.vcd");
  const filelist = path.join(fixture, "sources.f");
  const options = { waveform, filelist, tick: "2", historyStart: "0" };
  const [, , changed, held, loads] = callTraceMcp(fixture, [
    ["wave_open", { path: waveform }],
    ["wave_design_attach", { waveform, path: path.join(fixture, "obj_dir/Vdynamic_output_tb.tree.json") }],
    ["wave_trace_context", { ...options, signal: "dynamic_output_tb.bus[3]" }],
    ["wave_trace_context", { ...options, signal: "dynamic_output_tb.bus[0]" }],
    ["wave_trace_loads", { waveform, filelist, signal: "dynamic_output_tb.idx" }],
  ]);
  const driver = changed.assignments.find(a => a.kind === "port" && a.targets.includes(changed.root));
  assert.deepEqual(driver.targetIndexedPart, { width: 2, ascendingIndices: true });
  const index = changed.signals.find(({ id }) => id === driver.targetIndex.args);
  assert.equal(index.name, "idx");
  const { nodes, edges } = changed.context.temporalTrace;
  assert.deepEqual([nodes[0].tick, nodes[0].bit, nodes[0].value], ["2", 3, "1"]);
  assert(edges.some(({ source, target }) => target === 0 && nodes[source].signal === index.id));
  assert(edges.some(({ source, target }) => target === 0 &&
    changed.signals.some(({ id, instance, name }) => id === nodes[source].signal &&
      instance === "dynamic_output_tb.dut" && name === "result")));
  assert.deepEqual([held.context.temporalTrace.nodes[0].tick, held.context.temporalTrace.nodes[0].value], ["0", "1"]);
  assert(loads.assignments.some(({ targets, targetIndex }) => targetIndex?.args === loads.root &&
    loads.signals.some(({ id, name }) => targets.includes(id) && name === "bus")));
});

const outputMatrix = process.env.WAVE_TEST_VERILATOR_OUTPUT_MATRIX;
test("standalone MCP maps physical Verilator output offsets to declared packed indices", {
  skip: !outputMatrix,
}, () => {
  const fixture = path.resolve(outputMatrix);
  const waveform = path.join(fixture, "ports.vcd");
  const options = { waveform, filelist: path.join(fixture, "sources.f") };
  const cases = [
    ["plain", 3, "a", true],
    ["expr", 4, "b", true],
    ["minus", 3, "c", true],
    ["asc", 2, "d", false],
    ["offset", 7, "e", true],
  ];
  const [, , loads, ...traces] = callTraceMcp(fixture, [
    ["wave_open", { path: waveform }],
    ["wave_design_attach", { waveform, path: path.join(fixture, "obj_dir/Vports.tree.json") }],
    ["wave_trace_loads", { ...options, signal: "ports.idx" }],
    ...cases.map(([signal, bit]) => ["wave_trace_context", {
      ...options, signal: `ports.${signal}[${bit}]`, tick: "2", historyStart: "0",
    }]),
  ]);
  const loaded = loads.assignments.flatMap(({ targetIndex, targets }) =>
    targetIndex ? targets.map(id => loads.signals.find(signal => signal.id === id)?.name) : []);
  assert.deepEqual(loaded.sort(), cases.map(([signal]) => signal).sort());
  for (const [index, [signal, bit, scope, ascendingIndices]] of cases.entries()) {
    const trace = traces[index];
    const driver = trace.assignments.find(a => a.kind === "port" && a.targets.includes(trace.root));
    assert.deepEqual(driver.targetIndexedPart, { width: 2, ascendingIndices });
    const names = new Map(trace.signals.map(({ id, name, instance }) => [id, `${instance}.${name}`]));
    const { nodes, edges } = trace.context.temporalTrace;
    assert.deepEqual([names.get(nodes[0].signal), nodes[0].bit, nodes[0].tick, nodes[0].value],
      [`ports.${signal}`, bit, "2", "1"]);
    const inputs = edges.filter(({ target }) => target === 0).map(({ source }) => names.get(nodes[source].signal));
    assert(inputs.includes(`ports.${scope}.result`));
    assert(inputs.includes("ports.idx"));
  }
});

const concurrentTaskFixture = process.env.WAVE_TEST_VCS_CONCURRENT_TASK;
test("standalone MCP matches concurrent VCS task calls to reverse-order writes", {
  skip: !concurrentTaskFixture,
}, () => {
  const fixture = path.resolve(concurrentTaskFixture);
  const waveform = path.join(fixture, "task.vcd");
  const [, , trace] = callTraceMcp(fixture, [
    ["wave_open", { path: waveform, backend: "independent" }],
    ["wave_design_attach", { waveform, path: path.join(fixture, "simv.daidir") }],
    ["wave_trace_context", {
      waveform, filelist: path.join(fixture, "sources.f"),
      executionLog: path.join(fixture, "sealed.jsonl"),
      signal: "concurrent_task_tb.result", tick: "3", historyStart: "0", maxDepth: 8,
    }],
  ]);
  const transfers = trace.context.temporalTrace.nodes
    .filter(({ recordedTaskTransfer }) => recordedTaskTransfer)
    .sort((left, right) => left.orderAtTick - right.orderAtTick)
    .map(({ value, recordedTaskTransfer: { index, input, write, reads } }) =>
      [index, value, input.tick, input.ordinal, write.tick, write.ordinal, reads[0].operation]);
  assert.deepEqual(transfers, [
    [2, "00001011", "1", 11, "3", 17, "$fgetc at byte 1"],
    [1, "00001010", "1", 7, "3", 23, "$fgetc at byte 0"],
  ]);
});

const equalDriversFixture = process.env.WAVE_TEST_VCS_EQUAL_DRIVERS;
test("standalone MCP preserves both equal VCS drivers and same-tick changes", {
  skip: !equalDriversFixture,
}, () => {
  const fixture = path.resolve(equalDriversFixture);
  const waveform = path.join(fixture, "equal_drivers.vcd");
  const [, , trace] = callTraceMcp(fixture, [
    ["wave_open", { path: waveform, backend: "independent" }],
    ["wave_design_attach", { waveform, path: path.join(fixture, "simv.daidir") }],
    ["wave_trace_context", {
      waveform,
      filelist: path.join(fixture, "sources.f"),
      signal: "equal_drivers_tb.q",
      tick: "2",
      historyStart: "0",
    }],
  ]);
  const { candidates, changesAtTick } = trace.context.assignmentCandidates;
  assert.deepEqual(candidates.map(({ status }) => status), ["possible", "possible"]);
  assert.deepEqual(candidates.map(({ location }) => location.range.start.line).sort(), [5, 6]);
  assert.deepEqual(changesAtTick.map(({ value, orderAtTick }) => [value, orderAtTick]), [
    ["x", 1],
    ["1", 2],
  ]);
});

const upwardReferenceFixture = process.env.WAVE_TEST_VCS_XMR_UPWARD;
const parameterReferenceFixture = process.env.WAVE_TEST_VCS_XMR_PARAMETER;
test("standalone MCP binds an XMR generate index using the actual VCS parameter", {
  skip: !parameterReferenceFixture,
}, () => {
  const fixture = path.resolve(parameterReferenceFixture);
  const waveform = path.join(fixture, "parameter.vcd");
  const options = { waveform, filelist: path.join(fixture, "sources.f") };
  const cases = [["u_left", 0, "2"], ["u_right", 1, "4"]];
  const [, , ...traces] = callTraceMcp(fixture, [
    ["wave_open", { path: waveform, backend: "independent" }],
    ["wave_design_attach", { waveform, path: path.join(fixture, "simv.daidir") }],
    ...cases.map(([instance, , tick]) => ["wave_trace_context", {
      ...options, signal: `xmr_parameter_tb.${instance}.result`, tick, historyStart: "0",
    }]),
    ...cases.flatMap(([instance, lane]) => [lane, 1 - lane].map(index => ["wave_trace_loads", {
      ...options, signal: `xmr_parameter_tb.${instance}.lane[${index}].u_indexed.local_value`,
    }])),
    ...cases.map(([instance, lane]) => ["wave_trace_context", {
      ...options, signal: `xmr_parameter_tb.${instance}.result_expr`,
      tick: lane ? "2" : "4", historyStart: "0",
    }]),
  ]);
  for (const [index, [instance, lane, tick]] of cases.entries()) {
    const scope = `xmr_parameter_tb.${instance}`;
    const trace = traces[index];
    assert.deepEqual(trace.signals.filter(({ name }) => name === "local_value")
      .map(({ instance }) => instance), [`${scope}.lane[${lane}].u_indexed`]);
    const { nodes, edges } = trace.context.temporalTrace;
    assert(edges.some(({ source, target }) =>
      nodes[target].signal === trace.root &&
      nodes[source].tick === tick &&
      trace.signals.some(({ id, name }) => id === nodes[source].signal && name === "local_value")));
    const [loads, unused] = traces.slice(cases.length + 2 * index, cases.length + 2 * index + 2);
    assert(loads.signals.some(({ instance, name }) => instance === scope && name === "result"));
    assert(!unused.signals.some(({ instance, name }) => instance === scope && name === "result"));
    assert(!loads.signals.some(({ instance, name }) => instance === scope && name === "result_expr"));
    assert(unused.signals.some(({ instance, name }) => instance === scope && name === "result_expr"));
    const expression = traces[cases.length * 3 + index];
    assert.deepEqual(expression.signals.filter(({ name }) => name === "local_value")
      .map(({ instance }) => instance), [`${scope}.lane[${1 - lane}].u_indexed`]);
    const continued = expression.context.temporalTrace;
    assert(continued.edges.some(({ source, target }) =>
      continued.nodes[target].signal === expression.root &&
      continued.nodes[source].tick === (lane ? "2" : "4") &&
      expression.signals.some(({ id, name }) => id === continued.nodes[source].signal &&
        name === "local_value")));
  }
});

test("standalone MCP binds VCS upward references to each nearest ancestor", {
  skip: !upwardReferenceFixture,
}, () => {
  const fixture = path.resolve(upwardReferenceFixture);
  const waveform = path.join(fixture, "upward.vcd");
  const options = { waveform, filelist: path.join(fixture, "sources.f") };
  const cases = [["u_left", "2"], ["u_right", "4"]];
  const [, , ...traces] = callTraceMcp(fixture, [
    ["wave_open", { path: waveform, backend: "independent" }],
    ["wave_design_attach", { waveform, path: path.join(fixture, "simv.daidir") }],
    ...cases.map(([parent, tick]) => ["wave_trace_context", {
      ...options, signal: `xmr_up_tb.${parent}.u_leaf.result`, tick, historyStart: "0",
    }]),
    ...cases.map(([parent]) => ["wave_trace_loads", {
      ...options, signal: `xmr_up_tb.${parent}.u_leaf.write_value`,
    }]),
    ...cases.map(([parent]) => ["wave_trace_loads", {
      ...options, signal: `xmr_up_tb.${parent}.shared_value`,
    }]),
    ...cases.map(([parent]) => ["wave_trace_drivers", {
      ...options, signal: `xmr_up_tb.${parent}.external_value`,
    }]),
  ]);
  for (const [index, [parent, tick]] of cases.entries()) {
    const trace = traces[index];
    const instance = `xmr_up_tb.${parent}`;
    const [source] = trace.signals.filter(({ name }) => name === "shared_value");
    assert.equal(source.instance, instance);
    const drivers = trace.assignments.filter(({ targets }) => targets.includes(trace.root));
    assert.equal(drivers.length, 1);
    assert.deepEqual(drivers[0].inputs.map(({ signal }) => signal), [source.id]);
    assert(!trace.staticCoverage.stops.some(({ reason }) =>
      reason === "unresolvedHierarchicalRead"));
    const { nodes, edges } = trace.context.temporalTrace;
    assert(edges.some(({ source: from, target }) =>
      nodes[from].signal === source.id &&
      nodes[from].tick === tick &&
      nodes[target].signal === trace.root));
    const loads = traces[cases.length + index];
    const [write] = loads.signals.filter(({ name }) => name === "external_value");
    assert.equal(write.instance, instance);
    assert(loads.assignments.some(({ targets, inputs }) =>
      targets.includes(write.id) && inputs.some(({ signal }) => signal === loads.root)));
    const consumers = traces[2 * cases.length + index];
    const reads = consumers.signals.filter(({ name, instance: scope }) =>
      name === "result" && scope.endsWith(".u_leaf"));
    assert.deepEqual(reads.map(({ instance: scope }) => scope), [instance + ".u_leaf"]);
    assert(consumers.assignments.some(({ targets, inputs }) =>
      targets.includes(reads[0].id) && inputs.some(({ signal }) => signal === consumers.root)));
    const writers = traces[3 * cases.length + index];
    const sources = writers.signals.filter(({ name }) => name === "write_value");
    assert.deepEqual(sources.map(({ instance: scope }) => scope), [instance + ".u_leaf"]);
    assert(writers.assignments.some(({ targets, inputs }) =>
      targets.includes(writers.root) && inputs.some(({ signal }) => signal === sources[0].id)));
  }
});

for (const [layout, fixturePath] of [
  ["split source files", hierarchicalReadFixture],
  ["one source file", process.env.WAVE_TEST_VCS_XMR_SINGLE],
])
test(`standalone MCP binds VCS hierarchical reads to distinct elaborated instances in ${layout}`, {
  skip: !fixturePath,
}, () => {
  const fixture = path.resolve(fixturePath);
  const waveform = path.join(fixture, "xmr.vcd");
  const options = { waveform, filelist: path.join(fixture, "sources.f") };
  const cases = [
    ["q_port", [["xmr_tb.u_leaf", "p"]]],
    ["q_local", [["xmr_tb.u_leaf", "local_value"]]],
    ["q_pair", [["xmr_tb.u_leaf", "local_value"], ["xmr_tb.u_other", "local_value"]]],
    ["q_indexed", [["xmr_tb.lane[1].u_indexed", "local_value"]]],
  ];
  const [, , ...results] = callTraceMcp(fixture, [
    ["wave_open", { path: waveform, backend: "independent" }],
    ["wave_design_attach", { waveform, path: path.join(fixture, "simv.daidir") }],
    ...cases.map(([signal]) => ["wave_trace_drivers", { ...options, signal: "xmr_tb." + signal }]),
    ["wave_trace_context", { ...options, signal: "xmr_tb.q_pair", tick: "4", historyStart: "0" }],
    ["wave_trace_loads", { ...options, signal: "xmr_tb.stimulus" }],
    ["wave_trace_loads", { ...options, signal: "xmr_tb.u_leaf.local_value" }],
    ["wave_trace_loads", { ...options, signal: "xmr_tb.u_other.local_value" }],
    ["wave_trace_drivers", { ...options, signal: "xmr_tb.u_leaf.external_value" }],
    ["wave_trace_loads", { ...options, signal: "xmr_tb.lane[1].u_indexed.local_value" }],
    ["wave_trace_loads", { ...options, signal: "xmr_tb.lane[0].u_indexed.local_value" }],
    ["wave_trace_loads", { ...options, signal: "xmr_tb.u_leaf.local_value", maxDepth: 0 }],
  ]);
  for (const [index, [, expected]] of cases.entries()) {
    const graph = results[index];
    const signals = new Map(graph.signals.map(signal => [signal.id, signal]));
    const [assignment] = graph.assignments.filter(candidate => candidate.targets.includes(graph.root));
    assert.equal(assignment.hasUnresolvedOperands, false);
    assert.deepEqual(assignment.inputs.map(({ signal }) => {
      const operand = signals.get(signal);
      return [operand.instance, operand.name];
    }), expected);
    assert(!graph.staticCoverage.stops.some(({ reason }) => reason === "unresolvedHierarchicalRead"));
  }
  const [trace, loads, leafLoads, otherLoads, written, indexedLoads, unusedLoads, limitedLoads] =
    results.slice(cases.length);
  const { nodes, edges } = trace.context.temporalTrace;
  assert(edges.some(({ source, target }) => {
    const input = nodes[source];
    return nodes[target].signal === trace.root &&
      input.tick === "4" &&
      trace.signals.some(({ id, instance, name }) =>
        id === input.signal && instance === "xmr_tb.u_other" && name === "local_value");
  }));
  const target = loads.signals.find(({ instance, name }) =>
    instance === "xmr_tb.u_leaf" && name === "external_value");
  assert(target);
  assert(loads.assignments.some(assignment =>
    assignment.targets.includes(target.id) &&
    assignment.inputs.some(({ signal }) => signal === loads.root)));
  function destinations(graph) {
    const targets = new Set(graph.assignments.flatMap(({ targets }) => targets));
    return graph.signals
      .filter(({ id, instance }) => targets.has(id) && instance === "xmr_tb")
      .map(({ name }) => name)
      .sort();
  }
  assert.deepEqual(destinations(leafLoads), ["q_follow", "q_local", "q_pair"]);
  assert.deepEqual(destinations(otherLoads), ["q_pair"]);
  assert.deepEqual(destinations(indexedLoads), ["q_indexed"]);
  assert.deepEqual(destinations(unusedLoads), []);
  for (const graph of [leafLoads, otherLoads, indexedLoads, unusedLoads])
    assert(!graph.staticCoverage.stops.some(({ reason }) => reason === "unresolvedHierarchicalLoad"));
  assert.deepEqual(destinations(limitedLoads), []);
  assert(limitedLoads.staticCoverage.stops.some(({ reason }) => reason === "depth"));
  const stimulus = written.signals.find(({ instance, name }) =>
    instance === "xmr_tb" && name === "stimulus");
  assert(stimulus);
  assert(written.assignments.some(({ targets, inputs }) =>
    targets.includes(written.root) && inputs.some(({ signal }) => signal === stimulus.id)));
});

test("standalone MCP keeps only elaborated writers in a generate case without default", {
  skip: !sparseCaseFixture,
  timeout: 45000,
}, () => {
  const top = "generate_without_default_tb";
  const bits = [[0, "edge_data", "5"], [1, "center_data", "6"], [2, "edge_data", "5"], [3, null, "6"]];
  const loads = [["edge_data", [0, 2]], ["center_data", [1]]];
  for (const [provider, design] of [
    ["vcs", "simv.daidir"],
    ["verilator", "generate_without_default.tree.json"],
  ]) {
    const fixture = path.resolve(sparseCaseFixture, provider);
    const waveform = path.join(fixture, "generate_without_default.vcd");
    const options = { waveform, filelist: path.join(fixture, "sources.f"), detail: "full", format: "mermaid" };
    const [, , ...results] = callTraceMcp(fixture, [
      ["wave_open", { path: waveform, backend: "independent" }],
      ["wave_design_attach", { waveform, path: path.join(fixture, design) }],
      ...bits.map(([bit, , tick]) => ["wave_trace_context", {
        ...options, signal: `${top}.result_bus[${bit}]`, tick, historyStart: "0",
      }]),
      ...loads.map(([name]) => ["wave_trace_loads", { ...options, signal: top + "." + name }]),
    ]);
    for (const [bit, input, tick] of bits) {
      const result = results[bit];
      const writers = result.assignments.filter(({ targets }) => targets.includes(result.root));
      assert.deepEqual(writers.map(({ generateIndices }) => generateIndices?.lane), input ? [bit - 1] : []);
      assert(!result.staticCoverage.stops.some(({ reason }) => reason === "unresolvedGenerateBranch"));
      const { nodes, edges } = result.context.temporalTrace;
      assert.equal(edges.length, input ? 1 : 0);
      if (input) assert(nodes.some(({ signal, tick: sourceTick }) =>
        sourceTick === tick && result.signals.some(({ id, name }) => id === signal && name === input),
      ));
      assert.match(result.temporalMermaid, /flowchart/);
    }
    for (const [index, [, expected]] of loads.entries()) {
      const { assignments } = results[bits.length + index];
      assert.deepEqual(assignments.flatMap(({ targetRange }) => targetRange ? [targetRange[0]] : []).sort(), expected);
    }
  }
});

const recordedSelectors = process.env.WAVE_TEST_VCS_RECORDED_SELECTORS;
test("standalone MCP replays recorded VCS shift and mux operands at a live commit", {
  skip: !recordedSelectors,
  timeout: 30000,
}, (t) => {
  const fixture = path.resolve(recordedSelectors);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wave-live-selectors-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const probe = path.join(fixture, "probe");
  const waveform = path.join(probe, "reference.vcd");
  const executionLog = path.join(probe, "sealed.jsonl");
  const recording = path.join(directory, "live.jsonl");
  const { sites } = JSON.parse(fs.readFileSync(path.join(probe, "generated/execution-probes.json")));
  const statement = sites.find(({ signal }) => signal === "q");
  assert.ok(statement);
  const events = fs.readFileSync(executionLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const evaluation = events.find(({ kind, signal }) => kind === "assignment-evaluated" && signal === "q");
  assert.equal(evaluation.operandValues.amount, "010");
  evaluation.operandValues.amount = "011";
  const changedLog = path.join(directory, "changed.jsonl");
  fs.writeFileSync(changedLog, events.map((event) => JSON.stringify(event)).join("\n") + "\n");

  const options = { waveform, executionLog, tick: "3", historyStart: "0", detail: "full", format: "mermaid" };
  const step = ["wave_live_control", { action: "stepClock", signal: "tb.clk", cycles: 2 }];
  const calls = [
    ["wave_open", { path: waveform }],
    ["wave_design_attach", { waveform, path: path.join(fixture, "original/simv.daidir") }],
    ["wave_live_start", {
      backend: "vcs",
      program: path.join(probe, "simv"),
      cwd: directory,
      signals: ["clk", "a", "b", "amount", "choose", "q", "r"].map((name) => "tb." + name),
      recording,
    }],
    ["wave_live_control", {
      action: "setStatementBreakpoint", instance: "tb", statementId: statement.statementId,
      eventKind: "assignment-committed", timing: "simulator-commit",
    }],
    step,
    ["wave_live_trace", { ...options, signal: "tb.q[5]" }],
    ["wave_live_trace", { ...options, signal: "tb.r[3]" }],
    ["wave_live_trace", { ...options, signal: "tb.q[5]", executionLog: changedLog }],
    ["wave_live_status", {}],
    ["wave_live_control", { action: "clearBreakpoint" }],
    step,
  ];
  const child = spawnSync(process.execPath, [path.resolve(__dirname, "../dist/mcp-headless.js"), directory], {
    input: calls.map(([name, args], id) =>
      JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })
    ).join("\n") + "\n",
    encoding: "utf8",
    timeout: 25000,
  });
  assert.equal(child.status, 0, child.stderr || child.error);
  const responses = child.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(responses.length, calls.length);
  const values = responses.map(({ id, result }, index) => {
    assert.equal(id, index);
    assert.equal(result.isError, undefined, result.content[0].text);
    return JSON.parse(result.content[0].text);
  });
  const [, , , , stopped, shift, mux, mismatch, afterQueries, , finished] = values;
  assert.equal(stopped.snapshot.tick, "3");
  assert.equal(stopped.breakEvent.ordinal, 5);
  assert.equal(stopped.breakEvent.timing, "simulator-commit");
  for (const [result, commit, ordinal, name, bits] of [
    [shift, 5, 2, "amount", "010"],
    [mux, 7, 3, "choose", "01"],
  ]) {
    assert.equal(result.executionReplayMatch.status, "matched");
    const root = result.context.temporalTrace.nodes[0];
    assert.equal(root.recordedWriter.commitOrdinal, commit);
    assert.equal(root.recordedWriter.evaluation.ordinal, ordinal);
    assert.equal(root.recordedWriter.evaluation.operandValues[name], bits);
    const range = name === "amount" ? "[2:0]" : "[1:0]";
    assert.ok(result.context.observations.some(({ waveformSignal }) => waveformSignal === "tb." + name + range));
    assert.ok(result.context.temporalTrace.nodes.some(({ signal, bit, tick }) =>
      result.signals.find(({ id }) => id === signal)?.name === "a" && bit === 4 && tick === "1"));
    assert.match(result.report, /matches recorded RHS/);
  }
  assert.equal(mismatch.executionReplayMatch.status, "eventSequenceDiffers");
  assert.equal(mismatch.context.temporalTrace.nodes[0].recordedWriter, undefined);
  assert.equal(afterQueries.snapshot.tick, "3");
  assert.equal(finished.state, "exited");
  assert.equal(fs.readFileSync(recording, "utf8"), fs.readFileSync(path.join(probe, "raw.jsonl"), "utf8"));
});

const fixedGuardFixture = process.env.WAVE_TEST_VCS_FIXED_GUARD;
test("standalone MCP traces a fixed-target NBA to the recorded branch entry", {
  skip: !fixedGuardFixture,
  timeout: 25000,
}, () => {
  const fixture = path.resolve(fixedGuardFixture);
  const waveform = path.join(fixture, "probe/reference.vcd");
  const request = {
    waveform,
    executionLog: path.join(fixture, "probe/sealed.jsonl"),
    signal: "fixed_guard_tb.q",
    historyStart: "0",
    detail: "full",
    format: "mermaid",
  };
  const [, , yes, no] = callTraceMcp(fixture, [
    ["wave_open", { path: waveform }],
    ["wave_design_attach", { waveform, path: path.join(fixture, "original/simv.daidir") }],
    ["wave_trace_context", { ...request, tick: "5" }],
    ["wave_trace_context", { ...request, tick: "9" }],
  ]);
  for (const [result, commit, expected] of [[yes, 6, "1"], [no, 12, "0"]]) {
    const { nodes, edges } = result.context.temporalTrace;
    const target = nodes.findIndex(({ recordedWriter }) => recordedWriter?.commitOrdinal === commit);
    assert(target >= 0);
    const evaluation = nodes[target].recordedWriter.evaluation;
    assert.equal(evaluation.operandValues.select_a, "0");
    assert.deepEqual(Object.values(evaluation.guardEntryValues), [expected]);
    const sources = edges.filter(edge => edge.target === target && edge.controlSampleEvidence === "recordedBranchEntry");
    assert.deepEqual(sources.map(edge => nodes[edge.source].value), [expected]);
    assert.match(result.temporalMermaid, /matches recorded branch entry/);
    assert.match(result.report, /Recorded branch entry/);
  }
});

for (const { fixture: directory, top, commit, innerValue, innerCallback, innerEntry } of [
  {
    fixture: process.env.WAVE_TEST_VCS_NESTED_PACKED_GUARD,
    top: "nested_packed_guard_tb",
    commit: 7,
    innerValue: "1",
    innerCallback: 1,
    innerEntry: 3,
  },
  {
    fixture: process.env.WAVE_TEST_VCS_NESTED_PACKED_NBA_GUARD,
    top: "nested_packed_nba_guard_tb",
    commit: 9,
    innerValue: "x",
    innerCallback: 3,
    innerEntry: 5,
  },
]) test(`standalone MCP projects each nested packed guard in ${top} using its recorded entry`, {
  skip: !directory,
  timeout: 25000,
}, () => {
  const fixture = path.resolve(directory);
  const waveform = path.join(fixture, "probe/reference.vcd");
  const executionLog = path.join(fixture, "probe/covered.jsonl");
  const [, , result] = callTraceMcp(path.join(fixture, "workspace"), [
    ["wave_open", { path: waveform }],
    ["wave_design_attach", { waveform, path: path.join(fixture, "original/simv.daidir") }],
    ["wave_trace_context", {
      waveform, executionLog, signal: top + ".q", tick: "7",
      historyStart: "0", detail: "full", format: "mermaid",
    }],
  ]);
  const { nodes, edges } = result.context.temporalTrace;
  assert.equal(nodes[0].recordedWriter.commitOrdinal, commit);
  assert.deepEqual(nodes[0].recordedWriter.evaluation.operandValues, {
    req: "100", idx: "10",
  });
  const reads = edges.filter(edge => edge.target === 0 &&
    result.signals.find(({ id }) => id === nodes[edge.source].signal)?.name === "req");
  assert.deepEqual(reads.map(edge => {
    const source = nodes[edge.source];
    return [source.bit, source.tick, source.value, source.valueChangeOrdinal, edge.branchEntry];
  }).sort((left, right) => left[0] - right[0]), [
    [0, "2", "1", 0, { line: 12, column: 9, tick: "3", nextOrdinal: 1 }],
    [1, "4", innerValue, innerCallback, { line: 14, column: 11, tick: "5", nextOrdinal: innerEntry }],
  ]);
  assert.match(result.report, /matches recorded branch entry at L12:9#44; tick 3/);
  assert.match(result.report, /matches recorded branch entry at L14:11#44; tick 5/);
});

for (const { fixture: directory, top, commit, range, noTarget } of [
  {
    fixture: process.env.WAVE_TEST_VCS_GUARDED_INDEXED_NBA,
    top: "guarded_indexed_nba_tb",
    commit: 9,
    range: [2, 3],
  },
  {
    fixture: process.env.WAVE_TEST_VCS_GUARDED_INDEXED_BLOCKING,
    top: "guarded_indexed_blocking_tb",
    commit: 8,
    range: [2, 2],
    noTarget: true,
  },
]) test(`standalone MCP retains the recorded guards and target in ${top}`, {
  skip: !directory,
  timeout: 25000,
}, () => {
  const fixture = path.resolve(directory);
  const waveform = path.join(fixture, "probe/reference.vcd");
  const executionLog = path.join(fixture, "probe/covered.jsonl");
  const [, , result, execution] = callTraceMcp(path.join(fixture, "workspace"), [
    ["wave_open", { path: waveform }],
    ["wave_design_attach", { waveform, path: path.join(fixture, "original/simv.daidir") }],
    ["wave_trace_context", {
      waveform, executionLog, signal: top + ".q[2]",
      tick: "7", historyStart: "0", detail: "full", format: "mermaid",
    }],
    ...(noTarget ? [["wave_execution_trace", {
      waveform, executionLog, instance: top, signal: "q", tick: "8",
    }]] : []),
  ]);
  const { nodes, edges } = result.context.temporalTrace;
  assert.equal(nodes[0].recordedWriter.commitOrdinal, commit);
  assert.deepEqual(nodes[0].recordedWriter.targetRange, range);
  const reads = name => edges.filter(edge => edge.target === 0 &&
    result.signals.find(({ id }) => id === nodes[edge.source].signal)?.name === name);
  assert.deepEqual(reads("dest").map(edge => [
    edge.role, edge.packedIndexEvidence, nodes[edge.source].tick, nodes[edge.source].value,
  ]), [["index", "recordedTarget", "6", "10"]]);
  assert.deepEqual(reads("req").map(edge => [
    nodes[edge.source].bit, nodes[edge.source].tick, edge.branchEntry.tick,
  ]).sort((a, b) => a[0] - b[0]), [[0, "2", "3"], [1, "4", "5"]]);
  assert.match(result.temporalMermaid, /matches recorded packed target index/);
  if (noTarget) {
    const outcome = execution.events.find(event => event.kind === "assignment-no-target");
    assert.equal(outcome?.evaluationOrdinal, 10);
    const evaluation = execution.events.find(event => event.ordinal === outcome.evaluationOrdinal);
    assert.deepEqual(evaluation.guardEntryTicks, {
      g13_9_idx: "3", g13_9_req: "3", g15_11f_idx: "5", g15_11f_req: "5",
    });
    assert(!execution.events.some(event => event.kind === "assignment-committed"));
  }
});

const blockingPartFixture = process.env.WAVE_TEST_VCS_BLOCKING_PART;
test("standalone MCP traces clipped blocking part selects to the corresponding RHS bit", {
  skip: !blockingPartFixture,
  timeout: 25000,
}, () => {
  const fixture = path.resolve(blockingPartFixture);
  const waveform = path.join(fixture, "probe/reference.vcd");
  const executionLog = path.join(fixture, "probe/covered.jsonl");
  const instance = "blocking_part_select_tb";
  const options = { waveform, executionLog, historyStart: "0", detail: "full", format: "mermaid" };
  const [, , a, b, aWrites, bWrites] = callTraceMcp(path.join(fixture, "workspace"), [
    ["wave_open", { path: waveform }],
    ["wave_design_attach", { waveform, path: path.join(fixture, "original/simv.daidir") }],
    ["wave_trace_context", { ...options, signal: instance + ".a[3]", tick: "4" }],
    ["wave_trace_context", { ...options, signal: instance + ".b[0]", tick: "6" }],
    ["wave_execution_trace", { ...options, instance, signal: "a", tick: "12" }],
    ["wave_execution_trace", { ...options, instance, signal: "b", tick: "12" }],
  ]);
  for (const [result, commit, attempted, bit, base] of [
    [a, 9, [3, 4], 3, "0011"],
    [b, 13, [0, -1], 0, "0000"],
  ]) {
    const { nodes, edges } = result.context.temporalTrace;
    assert.equal(nodes[0].recordedWriter.commitOrdinal, commit);
    assert.deepEqual(nodes[0].recordedWriter.targetRange, [bit, bit]);
    assert.deepEqual(nodes[0].recordedWriter.attemptedTargetRange, attempted);
    const reads = name => edges.filter(edge => edge.target === 0 &&
      result.signals.find(({ id }) => id === nodes[edge.source].signal)?.name === name);
    assert.deepEqual(reads("d").map(({ source }) => nodes[source].bit), [1]);
    assert.deepEqual(reads("base").map(edge => [
      edge.packedIndexEvidence, nodes[edge.source].value,
    ]), [["recordedTarget", base]]);
  }
  for (const [result, noTarget, clipped, attempted] of [
    [aWrites, 22, 16, [-1, 0]], [bWrites, 24, 19, [4, 3]],
  ]) {
    assert.equal(result.events.find(event => event.ordinal === noTarget)?.kind, "assignment-no-target");
    const commit = result.events.find(event => event.ordinal === clipped);
    assert.equal(commit?.kind, "assignment-committed");
    assert.equal(commit.value, "0");
    assert.deepEqual(commit.attemptedTargetRange, attempted);
  }
});

const sameRangeFixture = process.env.WAVE_TEST_NBA_SAME_RANGE;
test("standalone MCP preserves simulator evidence for same-range NBA writes", {
  skip: !sameRangeFixture,
  timeout: 25000,
}, () => {
  const fixture = path.resolve(sameRangeFixture);
  const instance = "same_range_tb";
  const signal = instance + ".q[2]";
  const vcs = path.join(fixture, "probe/reference.vcd");
  const xcelium = path.join(fixture, "xcelium/live.vcd");
  const filelist = path.join(fixture, "original/sources.f");
  const vcsOptions = {
    waveform: vcs,
    executionLog: path.join(fixture, "probe/covered.jsonl"),
    historyStart: "0",
  };
  const xceliumOptions = {
    waveform: xcelium,
    executionLog: path.join(fixture, "xcelium/sealed.jsonl"),
    filelist,
    historyStart: "0",
  };
  const [, , execution, changed, held, , , first, second] = callTraceMcp(
    path.join(fixture, "workspace"),
    [
      ["wave_open", { path: vcs }],
      ["wave_design_attach", { waveform: vcs, path: path.join(fixture, "original/simv.daidir") }],
      ["wave_execution_trace", { ...vcsOptions, instance, signal: "q", tick: "4" }],
      ["wave_trace_context", { ...vcsOptions, signal, tick: "2" }],
      ["wave_trace_context", { ...vcsOptions, signal, tick: "4" }],
      ["wave_open", { path: xcelium }],
      ["wave_design_attach", {
        waveform: xcelium, path: path.join(fixture, "original/same_range.tree.json"),
      }],
      ["wave_trace_context", { ...xceliumOptions, signal, tick: "4", changeOrder: 1 }],
      ["wave_trace_context", { ...xceliumOptions, signal, tick: "4", changeOrder: 2 }],
    ],
  );
  assert.equal(execution.waveformMatch, "verified");
  assert.deepEqual(execution.coverage.gaps, ["unobservedCommit"]);
  for (const [result, tick, evaluationBase, values, waveformValues] of [
    [changed, "2", 6, ["01", "11", "10"], ["1"]],
    [held, "4", 15, ["00", "01", "10"], []],
  ]) {
    const events = execution.events.filter(event => event.tick === tick);
    const evaluations = events.filter(event => event.kind === "assignment-evaluated");
    assert.deepEqual(evaluations.map(event => [event.ordinal, event.value, event.targetRange]),
      values.map((value, offset) => [evaluationBase + offset, value, [2, 1]]));
    assert.deepEqual(events.filter(event => event.kind === "assignment-unobserved")
      .map(event => event.evaluationOrdinal), [evaluationBase, evaluationBase + 1]);
    const commits = events.filter(event => event.kind === "assignment-committed");
    assert.deepEqual(commits.map(event => [event.ordinal, event.evaluationOrdinal, event.value]),
      [[evaluationBase + 5, evaluationBase + 2, "10"]]);
    assert.deepEqual(events.filter(event => event.kind === "signal-value-changed")
      .map(event => event.value), tick === "2" ? ["1101"] : []);
    const transition = result.executionTransitions.find(event => event.tick === tick);
    assert.deepEqual(transition?.waveformValues, waveformValues);
    assert.deepEqual(transition?.commitOrdinals, [evaluationBase + 5]);
    assert.equal(transition?.status, "incomplete");
    assert(!result.context.temporalTrace.nodes.some(node => node.recordedWriter));
  }
  for (const [result, changeOrder, value, ordinal] of [[first, 1, "0", 9], [second, 2, "1", 11]]) {
    const { nodes, edges } = result.context.temporalTrace;
    const node = nodes[0];
    assert.deepEqual([node.tick, node.orderAtTick, node.value, node.valueChangeOrdinal],
      ["4", changeOrder, value, ordinal]);
    assert.equal(node.recordedWriter, undefined);
    const transition = result.executionTransitions.find(event => event.tick === "4");
    assert.equal(transition?.status, "valueChangesMatch");
    assert.deepEqual(transition?.recordedChangeValues, ["0", "1"]);
    assert.deepEqual(transition?.commitOrdinals, []);
    const inputs = edges.filter(edge => edge.target === 0);
    assert.equal(inputs.length, 3);
    assert(inputs.every(edge => edge.confidence === "possible"));
  }
});

const timedCaseFixture = process.env.WAVE_TEST_VCS_TIMED_CASE;
test("standalone MCP traces a delayed NBA through its earlier case entry", {
  skip: !timedCaseFixture,
  timeout: 25000,
}, () => {
  const fixture = path.resolve(timedCaseFixture);
  const waveform = path.join(fixture, "probe/reference.vcd");
  const request = {
    waveform,
    executionLog: path.join(fixture, "probe/sealed.jsonl"),
    signal: "timed_case_tb.q",
    tick: "8",
    detail: "full",
    format: "mermaid",
  };
  const [, , full, windowed] = callTraceMcp(fixture, [
    ["wave_open", { path: waveform }],
    ["wave_design_attach", { waveform, path: path.join(fixture, "original/simv.daidir") }],
    ["wave_trace_context", { ...request, historyStart: "0" }],
    ["wave_trace_context", { ...request, historyStart: "7" }],
  ]);
  for (const [result, sourceTick, captured] of [[full, "2", false], [windowed, "5", true]]) {
    const { nodes, edges } = result.context.temporalTrace;
    const target = nodes.findIndex(({ recordedWriter }) => recordedWriter?.commitOrdinal === 8);
    assert(target >= 0);
    const { evaluation } = nodes[target].recordedWriter;
    assert.equal(evaluation.tick, "8");
    assert.deepEqual(Object.values(evaluation.guardEntryTicks), ["5"]);
    const branch = edges.find(edge => edge.target === target && edge.controlSampleEvidence === "recordedBranchEntry");
    assert(branch);
    assert.equal(nodes[branch.source].tick, sourceTick);
    assert.equal(!!nodes[branch.source].branchEntrySample, captured);
    assert.match(result.report, /Case L9:15 · sel = 1 @ 5/);
  }
});

const waitResumeFixture = process.env.WAVE_TEST_VCS_WAIT_RESUME;
test("standalone MCP distinguishes a case entry from a wait resume", {
  skip: !waitResumeFixture,
  timeout: 25000,
}, () => {
  const fixture = path.resolve(waitResumeFixture);
  const waveform = path.join(fixture, "probe/reference.vcd");
  const [, , result] = callTraceMcp(fixture, [
    ["wave_open", { path: waveform }],
    ["wave_design_attach", { waveform, path: path.join(fixture, "original/simv.daidir") }],
    ["wave_trace_context", {
      waveform,
      executionLog: path.join(fixture, "probe/sealed.jsonl"),
      signal: "wait_resume_tb.q",
      tick: "9",
      historyStart: "0",
      detail: "full",
      format: "mermaid",
    }],
  ]);
  const { nodes, edges } = result.context.temporalTrace;
  const target = nodes.findIndex(({ recordedWriter }) => recordedWriter?.commitOrdinal === 8);
  assert(target >= 0);
  const sources = edges.filter(edge => edge.target === target);
  assert.equal(nodes[sources.find(edge => edge.controlSampleEvidence === "recordedBranchEntry").source].tick, "2");
  assert.equal(nodes[sources.find(edge => edge.controlSampleEvidence === "recordedWaitResume").source].tick, "9");
  assert.equal(nodes[sources.find(edge => edge.kind === "data").source].tick, "8");
  assert.match(result.report, /Case L10:15 · sel = 1 @ 5/);
  assert.match(result.report, /Wait resume L12:23 · ready = 1 @ 9/);
});

const standaloneWaitFixture = process.env.WAVE_TEST_VCS_STANDALONE_WAIT;
test("standalone MCP keeps the timestamp of an independent wait before an NBA", {
  skip: !standaloneWaitFixture,
  timeout: 25000,
}, () => {
  const fixture = path.resolve(standaloneWaitFixture);
  const waveform = path.join(fixture, "probe/reference.vcd");
  const [, , result] = callTraceMcp(fixture, [
    ["wave_open", { path: waveform }],
    ["wave_design_attach", { waveform, path: path.join(fixture, "original/simv.daidir") }],
    ["wave_trace_context", {
      waveform,
      executionLog: path.join(fixture, "probe/sealed.jsonl"),
      signal: "standalone_wait_tb.q",
      tick: "10",
      historyStart: "0",
      detail: "full",
      format: "mermaid",
    }],
  ]);
  const { nodes, edges } = result.context.temporalTrace;
  const target = nodes.findIndex(({ recordedWriter }) => recordedWriter?.commitOrdinal === 8);
  assert(target >= 0);
  const sources = edges.filter(edge => edge.target === target);
  assert.equal(nodes[sources.find(edge => edge.controlSampleEvidence === "recordedWaitResume").source].tick, "7");
  assert.equal(nodes[sources.find(edge => edge.kind === "data").source].tick, "9");
  assert.match(result.report, /Wait resume L9:15 · ready = 1 @ 7/);
});

const compoundWaitFixture = process.env.WAVE_TEST_VCS_COMPOUND_WAIT;
test("standalone MCP traces recorded VCS compound wait operands at resume", {
  skip: !compoundWaitFixture,
  timeout: 25000,
}, () => {
  const fixture = path.resolve(compoundWaitFixture);
  const waveform = path.join(fixture, "probe/reference.vcd");
  const common = { waveform, executionLog: path.join(fixture, "probe/sealed.jsonl"), detail: "full", format: "mermaid" };
  const delayed = { ...common, signal: "compound_wait_tb.q", tick: "10" };
  const direct = { ...common, signal: "compound_wait_tb.q_direct", tick: "7" };
  const [, , ...results] = callTraceMcp(fixture, [
    ["wave_open", { path: waveform }],
    ["wave_design_attach", { waveform, path: path.join(fixture, "original/simv.daidir") }],
    ["wave_trace_context", { ...delayed, historyStart: "0" }],
    ["wave_trace_context", { ...direct, historyStart: "0" }],
    ["wave_trace_context", { ...delayed, historyStart: "9" }],
  ]);
  for (const [index, result] of results.entries()) {
    const direct = index === 1;
    const short = index === 2;
    const { nodes, edges } = result.context.temporalTrace;
    const target = nodes.findIndex(({ recordedWriter }) => recordedWriter?.commitOrdinal === (direct ? 8 : 14));
    assert(target >= 0);
    const waits = edges.filter(edge => edge.target === target && edge.controlSampleEvidence === "recordedWaitResume");
    assert.deepEqual(waits.map(({ source }) => {
      const node = nodes[source];
      return [result.signals.find(({ id }) => id === node.signal).name, node.tick, node.value];
    }).sort(), [
      ["inhibit", "7", "0"], ["ready", short ? "7" : "6", "1"], ["rescue", short ? "7" : "0", "0"],
    ]);
    if (short) assert(waits.every(({ source }) => nodes[source].waitResumeSample));
    const causes = waits.filter(({ waitResumeCause }) => waitResumeCause === "uniqueObservedTransition");
    assert.deepEqual(causes.map(({ source }) => nodes[source].signal),
      short ? [] : [result.signals.find(({ name }) => name === "inhibit").id]);
    if (!short) {
      assert.match(result.temporalMermaid, /observed transition enabled wait/);
      assert.match(result.report, /inhibit\x60 became \x600\x60 at tick 7 and enabled the wait/);
    } else {
      assert.doesNotMatch(result.report, /## Observed changes that enabled a wait/);
    }
    const data = edges.find(edge => edge.target === target && edge.kind === "data");
    assert.equal(nodes[data.source].tick, direct ? "4" : "9");
    assert.match(result.report, new RegExp("Wait resume L" + (direct ? "17:23" : "9:15") + " · inhibit = 0 @ 7"));
    if (direct) assert.match(result.report, /Case L15:15 · select_path = 1 @ 5/);
  }
});

const compareWaitFixture = process.env.WAVE_TEST_VCS_COMPARE_WAIT;
test("standalone MCP traces a masked four-state comparison and signed threshold in a VCS wait", {
  skip: !compareWaitFixture,
  timeout: 25000,
}, () => {
  const fixture = path.resolve(compareWaitFixture);
  const waveform = path.join(fixture, "probe/reference.vcd");
  const executionLog = path.join(fixture, "probe/sealed.jsonl");
  const samples = [["q", "10", 15, "11:15", "9"], ["q_direct", "7", 9, "19:23", "4"]];
  const [, , ...results] = callTraceMcp(fixture, [
    ["wave_open", { path: waveform }],
    ["wave_design_attach", { waveform, path: path.join(fixture, "original/simv.daidir") }],
    ...samples.map(([signal, tick]) => ["wave_trace_context", {
      waveform, executionLog, signal: "compare_wait_tb." + signal, tick,
      historyStart: "0", detail: "full", format: "mermaid",
    }]),
  ]);
  for (const [index, result] of results.entries()) {
    const [, , commit, location, dataTick] = samples[index];
    const { nodes, edges } = result.context.temporalTrace;
    const target = nodes.findIndex(({ recordedWriter }) => recordedWriter?.commitOrdinal === commit);
    assert(target >= 0);
    const uses = edges.filter(edge => edge.target === target);
    const causes = uses.filter(({ waitResumeCause }) => waitResumeCause === "uniqueObservedTransition");
    assert.equal(causes.length, 1);
    const source = nodes[causes[0].source];
    assert.equal(result.signals.find(({ id }) => id === source.signal).name, "status");
    assert.deepEqual([source.tick, source.value], ["7", "11x1"]);
    assert.equal(nodes[uses.find(edge => edge.kind === "data").source].tick, dataTick);
    assert(result.report.includes("Wait resume L" + location + " · balance = 1111 @ 7"));
    if (index === 1) assert.match(result.report, /Case L17:15 · select_path = 1 @ 5/);
  }
});

const lateContinuousFixture = process.env.WAVE_TEST_VCS_LATE_CONTINUOUS_CALLBACK;
test("standalone MCP excludes a VCS input callback after a continuous output change", {
  skip: !lateContinuousFixture,
  timeout: 25000,
}, () => {
  const fixture = path.resolve(lateContinuousFixture);
  const waveform = path.join(fixture, "original/trace.vcd");
  const executionLog = path.join(fixture, "original/sealed.jsonl");
  const options = { waveform, signal: "late_continuous_callback_tb.q", tick: "5", historyStart: "0", detail: "full", format: "mermaid" };
  const [, , waveformOnly, recorded] = callTraceMcp(fixture, [
    ["wave_open", { path: waveform }],
    ["wave_design_attach", { waveform, path: path.join(fixture, "original/simv.daidir") }],
    ["wave_trace_context", options],
    ["wave_trace_context", { ...options, executionLog }],
  ]);
  const sources = result => {
    const { nodes, edges } = result.context.temporalTrace;
    return edges.filter(edge => edge.target === 0).map(edge => {
      const node = nodes[edge.source];
      return [result.signals.find(signal => signal.id === node.signal).name,
        node.bit, node.value, node.valueChangeOrdinal, edge.callbackOrder];
    });
  };
  assert(sources(waveformOnly).some(([name, bit, value]) => name === "b" && bit === 1 && value === "1"));
  assert.deepEqual(sources(recorded), [
    ["a", 1, "1", 0, "sourceBeforeTarget"],
    ["b", 1, "0", undefined, undefined],
  ]);
  assert.equal(recorded.context.temporalTrace.nodes[0].valueChangeOrdinal, 1);
  assert(waveformOnly.context.temporalTrace.edges.every(edge => !edge.continuousCause));
  const cause = recorded.context.temporalTrace.edges.filter(edge => edge.continuousCause);
  assert.equal(cause.length, 1);
  assert.equal(recorded.context.temporalTrace.nodes[cause[0].source].valueChangeOrdinal, 0);
  assert.deepEqual(cause[0].continuousCause, { sourceOrdinal: 0, targetOrdinal: 1 });
  assert.match(recorded.temporalMermaid, /callback 0 changed RHS before output callback 1/);
  assert.match(recorded.report, /callback 0 changed RHS before output callback 1/);
});

for (const { fixture, captureWriter, stateOrdinal, commits, branchCommits } of [
  {
    fixture: process.env.WAVE_TEST_VCS_RV32A_READY,
    captureWriter: false,
    stateOrdinal: 135,
    commits: [[136, 131, 132], [174, 168, 169]],
  },
  {
    fixture: process.env.WAVE_TEST_VCS_RV32A_READY_WRITER,
    captureWriter: true,
    stateOrdinal: 167,
    commits: [[168, 163, 164, 162], [226, 220, 221, 219]],
  },
  {
    fixture: process.env.WAVE_TEST_VCS_RV32A_BRANCH,
    captureWriter: true,
    stateOrdinal: 199,
    commits: [[200, 195, 196, 194], [274, 260, 269, 259]],
    branchCommits: [187, 213],
  },
]) test("standalone MCP traces both RV32A commits to their observed ready callbacks" +
  (branchCommits ? " and arbiter branch entries" : captureWriter ? " and guarded bit writes" : ""), {
  skip: !fixture,
  timeout: branchCommits ? 45000 : 25000,
}, () => {
  const root = path.resolve(fixture);
  const build = path.join(root, "rebuild");
  const waveform = path.join(build, "rv32a_atomic_adapter.vcd");
  const executionLog = path.join(build, "covered.jsonl");
  const instance = "rv32a_atomic_adapter_tb.dut";
  const options = {
    waveform, executionLog, signal: instance + ".hart_q", historyStart: "365000",
    maxDepth: 5, detail: "full", format: "mermaid",
  };
  const [, , hart1, hart0, state, ...held] = callTraceMcp(path.join(root, "workspace"), [
    ["wave_open", { path: waveform }],
    ["wave_design_attach", { waveform, path: path.join(build, "simv.daidir") }],
    ["wave_trace_context", { ...options, tick: "375000" }],
    ["wave_trace_context", { ...options, tick: "465000" }],
    ["wave_execution_trace", { waveform, executionLog, instance, signal: "state_q", tick: "375000" }],
    ...(branchCommits
      ? ["380000", "470000"].map(tick => ["wave_trace_context", { ...options, tick }])
      : []),
  ], branchCommits ? 40000 : undefined);
  for (const [index, result] of held.entries()) {
    const winner = 1 - index;
    const node = result.context.temporalTrace.nodes[0];
    assert.equal(node.tick, ["375000", "465000"][index]);
    assert.equal(node.value, String(winner));
    assert.equal(node.recordedWriter.commitOrdinal, commits[index][0]);
  }
  for (const [hart, result] of [[1, hart1], [0, hart0]]) {
    const [commit, readyOrdinal, captureOrdinal, readyCommit] = commits[1 - hart];
    const { nodes, edges } = result.context.temporalTrace;
    const name = node => result.signals.find(({ id }) => id === node.signal)?.name;
    assert.equal(nodes[0].recordedWriter.commitOrdinal, commit);
    const capture = edges.find(edge => edge.target === 0 && name(nodes[edge.source]) === "capture_atomic");
    assert.ok(capture);
    const causes = edges.filter(edge => edge.target === capture.source && edge.continuousCause);
    assert.equal(causes.length, 1);
    const [cause] = causes;
    assert.equal(name(nodes[cause.source]), "atomic_req_ready_o");
    assert.equal(nodes[cause.source].bit, hart);
    assert.deepEqual(cause.continuousCause, { sourceOrdinal: readyOrdinal, targetOrdinal: captureOrdinal });
    if (captureWriter) {
      const writer = nodes[cause.source].recordedWriter;
      assert.equal(writer.commitOrdinal, readyCommit);
      assert.deepEqual(writer.targetRange, [hart, hart]);
      assert.deepEqual(writer.evaluation.operandValues, {
        state_q: "0000", StIdle: "0000", init_busy_i: "0", selected_valid: "1",
      });
      assert.ok(edges.some(edge => edge.target === cause.source &&
        edge.controlSampleEvidence === "recordedEvaluation" &&
        name(nodes[edge.source]) === "state_q"));
    }
    if (branchCommits) {
      const branchEdge = edges.find(edge => edge.target === cause.source &&
        name(nodes[edge.source]) === "selected_valid");
      assert.ok(branchEdge);
      const branch = nodes[branchEdge.source];
      assert.equal(branch.recordedWriter.commitOrdinal, branchCommits[1 - hart]);
      assert.equal(branch.tick, hart ? "370000" : "380000");
      const controls = edges.filter(edge => edge.target === branchEdge.source &&
        edge.controlSampleEvidence === "recordedBranchEntry");
      const request = controls.filter(edge => name(nodes[edge.source]) === "atomic_req_valid_i");
      assert.deepEqual(request.map(({ source }) => [nodes[source].bit, nodes[source].tick]),
        [[hart, "370000"]]);
      const index = controls.find(edge => edge.role === "index" && name(nodes[edge.source]) === "idx");
      assert.ok(index);
      assert.equal(BigInt("0b" + nodes[index.source].value), BigInt(hart));
    }
  }
  assert(state.events.some(event =>
    event.kind === "signal-value-changed" && event.ordinal === stateOrdinal && event.value === "0001"));
});

const orderedWaitFixture = process.env.WAVE_TEST_VCS_ORDERED_WAIT;
const repeatedWaitFixture = process.env.WAVE_TEST_VCS_REPEATED_WAIT;
test("standalone MCP resolves a VCS wait from ordered callbacks in the same tick", {
  skip: !orderedWaitFixture,
  timeout: 25000,
}, () => checkOrderedWait(orderedWaitFixture, "ordered_wait_tb", [14, 8]));
test("standalone MCP locates the exact VCS wait callback after repeated same-value changes", {
  skip: !repeatedWaitFixture,
  timeout: 25000,
}, () => checkOrderedWait(repeatedWaitFixture, "repeated_wait_tb", [16, 10]));

const pulsedWaitFixture = process.env.WAVE_TEST_VCS_PULSED_WAIT;
test("standalone MCP uses the VCS wait resume ordinal when the condition is true twice", {
  skip: !pulsedWaitFixture,
  timeout: 25000,
}, () => {
  const fixture = path.resolve(pulsedWaitFixture);
  const waveform = path.join(fixture, "probe/reference.vcd");
  const executionLog = path.join(fixture, "probe/sealed.jsonl");
  const [, , ...results] = callTraceMcp(fixture, [
    ["wave_open", { path: waveform }],
    ["wave_design_attach", { waveform, path: path.join(fixture, "original/simv.daidir") }],
    ...[["q", "10"], ["q_direct", "7"]].map(([signal, tick]) => ["wave_trace_context", {
      waveform, executionLog, signal: "pulsed_wait_tb." + signal, tick,
      historyStart: "0", detail: "full", format: "mermaid",
    }]),
  ]);
  for (const [index, result] of results.entries()) {
    const { nodes, edges } = result.context.temporalTrace;
    const target = nodes.findIndex(({ recordedWriter }) => recordedWriter?.commitOrdinal === (index ? 10 : 16));
    assert(target >= 0);
    const recorded = nodes[target].recordedWriter.evaluation.guardEntryNextOrdinals;
    assert.equal(recorded[index ? "p17_23_inhibit" : "p9_15_inhibit"], 6);
    const causes = edges.filter(edge => edge.target === target && edge.waitResumeCause);
    assert.equal(causes.length, 1);
    assert.equal(causes[0].waitResumeCallbackOrdinal, 5);
    const { signal, tick, value, orderAtTick } = nodes[causes[0].source];
    assert.equal(result.signals.find(({ id }) => id === signal).name, "inhibit");
    assert.deepEqual([tick, value, orderAtTick], ["7", "0", 1]);
    assert.match(result.report, /at tick 7 \(recorded callback 5\) and enabled the wait/);
  }
});

const waitDriverFixture = process.env.WAVE_TEST_VCS_WAIT_DRIVER;
test("standalone MCP follows the exact VCS wait cause through its blocking writer", {
  skip: !waitDriverFixture,
  timeout: 25000,
}, () => {
  const fixture = path.resolve(waitDriverFixture);
  const waveform = path.join(fixture, "probe/reference.vcd");
  const executionLog = path.join(fixture, "probe/sealed.jsonl");
  const [, , result] = callTraceMcp(fixture, [
    ["wave_open", { path: waveform }],
    ["wave_design_attach", { waveform, path: path.join(fixture, "original/simv.daidir") }],
    ["wave_trace_context", { waveform, executionLog, signal: "wait_driver_tb.q", tick: "10", historyStart: "0", detail: "full" }],
  ]);
  const { nodes, edges } = result.context.temporalTrace;
  const target = nodes.findIndex(({ recordedWriter }) => recordedWriter?.commitOrdinal === 21);
  assert(target >= 0);
  const cause = edges.find(edge => edge.target === target && edge.waitResumeCallbackOrdinal === 7);
  assert(cause);
  const driver = nodes[cause.source];
  assert.equal(driver.valueChangeOrdinal, 7);
  assert.equal(driver.recordedWriter.commitOrdinal, 8);
  assert.equal(result.assignments[driver.recordedWriter.assignment].location.range.start.line + 1, 33);
  const data = edges.find(edge => edge.target === cause.source && edge.kind === "data");
  assert.equal(nodes[data.source].tick, "3");
  assert.equal(result.signals.find(({ id }) => id === nodes[data.source].signal).name, "trigger_value");
});

function checkOrderedWait(directory, top, commits) {
  const repeated = top === "repeated_wait_tb";
  const fixture = path.resolve(directory);
  const waveform = path.join(fixture, "probe/reference.vcd");
  const executionLog = path.join(fixture, "probe/sealed.jsonl");
  const [, , ...results] = callTraceMcp(fixture, [
    ["wave_open", { path: waveform }],
    ["wave_design_attach", { waveform, path: path.join(fixture, "original/simv.daidir") }],
    ...[["q", "10"], ["q_direct", "7"]].map(([signal, tick]) => ["wave_trace_context", {
      waveform, executionLog, signal: top + "." + signal, tick,
      historyStart: "0", detail: "full", format: "mermaid",
    }]),
  ]);
  for (const [index, result] of results.entries()) {
    const { nodes, edges } = result.context.temporalTrace;
    const target = nodes.findIndex(({ recordedWriter }) => recordedWriter?.commitOrdinal === commits[index]);
    assert(target >= 0);
    const cause = edges.filter(edge => edge.target === target && edge.waitResumeCause);
    assert.equal(cause.length, 1);
    assert.equal(cause[0].waitResumeCause, "orderedCallbacks");
    const ordinal = repeated ? 7 : 5;
    assert.equal(cause[0].waitResumeCallbackOrdinal, ordinal);
    const { signal, tick, value, orderAtTick } = nodes[cause[0].source];
    assert.equal(result.signals.find(({ id }) => id === signal).name, repeated ? "ready" : "inhibit");
    assert.deepEqual([tick, value, orderAtTick], repeated ? ["7", "1", 3] : ["7", "0", undefined]);
    if (repeated) assert(edges.some(edge => {
      const source = nodes[edge.source];
      return edge.target === target && !edge.waitResumeCause && source.signal === signal &&
        source.tick === tick && source.value === value && source.orderAtTick === 1;
    }));
    assert(result.report.includes("at tick 7 (recorded callback " + ordinal + ") and enabled the wait"));
  }
}

const anonymousLoop = process.env.WAVE_TEST_VCS_ANONYMOUS_LOOP;
const verilatorLoop = process.env.WAVE_TEST_VERILATOR_ANONYMOUS_LOOP;
const verilatorInlineLoop = process.env.WAVE_TEST_VERILATOR_INLINE_LOOP;
test("standalone MCP specializes anonymous generate iterations in VCS FSDB and VCD", {
  skip: !anonymousLoop,
  timeout: 45000,
}, () => checkAnonymousLoop(path.resolve(anonymousLoop), false));
test("standalone MCP specializes anonymous generate iterations in Verilator VCD and FST", {
  skip: !verilatorLoop,
  timeout: 45000,
}, () => checkAnonymousLoop(path.resolve(verilatorLoop), true));
test("standalone MCP specializes single-statement Verilator generate branches inside a loop", {
  skip: !verilatorInlineLoop,
  timeout: 45000,
}, () => checkAnonymousLoop(path.resolve(verilatorInlineLoop), true));

function checkAnonymousLoop(fixture, verilator) {
  const top = "anonymous_generate_loop_tb";
  for (const extension of verilator ? ["vcd", "fst"] : ["fsdb", "vcd"]) {
    const directory = verilator && extension === "fst" ? path.join(fixture, "fst") : fixture;
    const waveform = path.join(directory, "anonymous_generate_loop." + extension);
    const options = {
      waveform,
      filelist: path.join(directory, "sources.f"),
      detail: "full",
      format: "mermaid",
    };
    const backend = verilator || process.env.WAVE_TEST_INDEPENDENT ? "independent" : "verdi";
    const design = verilator ? "anonymous_generate_loop.tree.json" : "simv.daidir";
    const calls = [
      ["wave_open", { path: waveform, backend }],
      ["wave_design_attach", { waveform, path: path.join(directory, design) }],
      ...[[0, "5"], [1, "6"], [2, "5"]].map(([bit, tick]) => [
        "wave_trace_context",
        { ...options, signal: top + `.result_bus[${bit}]`, tick, historyStart: "0" },
      ]),
      ["wave_trace_context", {
        ...options, signal: top + ".genblk1[-1].result_value", tick: "5", historyStart: "0",
      }],
      ...["src_a", "src_b"].map((name) => [
        "wave_trace_loads", { ...options, signal: top + "." + name },
      ]),
    ];
    const values = callTraceMcp(fixture, calls);
    const traces = values.slice(2, 5);
    for (const [bit, trace] of traces.entries()) {
      const iteration = bit - 1;
      const inputName = iteration === 0 ? "src_b" : "src_a";
      const scope = top + `.genblk1[${iteration}]`;
      assert.deepEqual(
        trace.assignments.filter((assignment) => assignment.targets.includes(trace.root))
          .map(({ instance, generateIndices, targetRange }) => ({ instance, generateIndices, targetRange })),
        [{ instance: scope, generateIndices: { index: iteration }, targetRange: [bit, bit] }],
      );
      const actual = trace.context.temporalTrace.nodes.map(({ signal }) =>
        trace.signals.find(({ id }) => id === signal));
      assert.ok(actual.some(({ instance, name }) => instance === top && name === inputName));
      assert.ok(actual.some(({ instance, name }) => instance === scope && name === "result_value"));
      assert.ok(actual.some(({ instance, name }) => instance === scope && name === "intermediate"));
      assert.ok(!trace.staticCoverage.stops.some(({ reason }) => reason === "unresolvedGenerateBranch"));
      assert.match(trace.temporalMermaid, /flowchart/);
    }
    const local = values[5];
    const root = local.signals.find(({ id }) => id === local.root);
    assert.equal(root.instance, top + ".genblk1[-1]");
    assert.equal(root.name, "result_value");
    for (const [trace, expectedBits] of [[values[6], [0, 2]], [values[7], [1]]]) {
      assert.deepEqual(trace.assignments.flatMap(({ targetRange }) => targetRange ? [targetRange[0]] : []), expectedBits);
      assert.ok(!trace.staticCoverage.stops.some(({ reason }) => reason === "unresolvedGenerateBranch"));
    }
  }
}

function callTraceMcp(workspace, calls, timeout = 20000) {
  const child = spawnSync(process.execPath, [path.resolve(__dirname, "../dist/mcp-headless.js"), workspace], {
    input: calls.map(([name, args], id) =>
      JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })
    ).join("\n") + "\n",
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout,
  });
  assert.equal(child.status, 0, child.error || child.stderr);
  const values = child.stdout.trim().split("\n").map((line, index) => {
    const { id, result } = JSON.parse(line);
    assert.equal(id, index);
    assert.equal(result.isError, undefined, result.content[0].text);
    return JSON.parse(result.content[0].text);
  });
  assert.equal(values.length, calls.length);
  return values;
}

const shmFixture = process.env.WAVE_TEST_SHM_FIXTURES;
test("SHM and PSFXL backend switching preserves channels and time windows", {
  skip: !shmFixture || process.platform !== "linux" || process.arch !== "x64",
}, () => {
  const workspace = path.resolve(shmFixture);
  for (const [relative, names, start, end] of [
    ["mixed/waves.shm/waves.dsn", ["mixed_tb.tick", "mixed_tb.filtered"], "20", "5000"],
    ["digital/waves.shm/waves.dsn", ["diff_tb.tick", "diff_tb.real_value"], "5", "50"],
    ["analog/raw/tran1.tran.tran.dat", ["step", "filtered"], "0", "100000"],
  ]) {
    const waveform = path.join(workspace, relative);
    const open = backend => ["wave_open", { path: waveform, backend }];
    const view = (action, args = {}) => ["wave_view", { waveform, action, ...args }];
    const [, , , cadence, cadenceView, independent, independentView] = callTraceMcp(workspace, [
      open("independent"),
      view("add", { signals: names }),
      view("window", { start, end }),
      open("cadence"),
      view("snapshot"),
      open("independent"),
      view("snapshot"),
    ]);
    assert.equal(cadence.backend, "shm-lib");
    assert.equal(independent.backend, "rust-independent-shm");
    for (const snapshot of [cadenceView, independentView]) {
      assert.deepEqual([snapshot.start, snapshot.end], [Number(start), Number(end)]);
      assert.deepEqual(snapshot.chosen.map(({ scope, name }) => scope ? scope + "." + name : name), names);
    }
  }
});

test("standalone MCP opens, clips and exports without a VS Code connection", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wave-headless-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "mixed.vcd"), [
    "$timescale 1 ns $end", "$scope module tb $end",
    "$var real 64 r voltage $end", "$var wire 1 w ready $end",
    "$upscope $end", "$enddefinitions $end",
    "#0", "r0.125 r", "0w", "#5", "r-2.5 r", "1w", "#12", "",
  ].join("\n"));
  const clip = { signals: ["tb.voltage", "tb.ready"], start: "2", end: "12" };
  const calls = [
    ["wave_open", { path: "mixed.vcd" }],
    ["wave_search", { query: "voltage" }],
    ["wave_clip", clip],
    ["wave_export", { ...clip, format: "png" }],
    ["wave_export", { ...clip, format: "vcd", path: "cut.vcd" }],
    ["wave_export", { ...clip, format: "vcd", path: "cut.vcd" }],
    ["wave_close", {}],
    ["wave_list", {}],
  ];
  const input = calls.map(([name, args], id) =>
    JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })
  ).join("\n") + "\n";
  const child = spawnSync(process.execPath, [path.resolve(__dirname, "../dist/mcp-headless.js"), dir], {
    input,
    encoding: "utf8",
    env: { ...process.env, TMPDIR: dir, DISPLAY: "", VSCODE_IPC_HOOK_CLI: "" },
    timeout: 15000,
  });
  assert.equal(child.status, 0, child.stderr);
  const responses = child.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(responses.map(({ id }) => id), calls.map((_, id) => id));
  for (const { result, id } of responses) assert.equal(Boolean(result.isError), id === 5, JSON.stringify(result.content[0]));
  const data = (index) => JSON.parse(responses[index].result.content[0].text);
  assert.equal(data(0).scale, "1ns");
  assert.ok(data(1).signals[0].real);
  assert.deepEqual(data(2).traces[0].events, [["2", "0.125"], ["5", "-2.5"]]);
  assert.equal(responses[3].result.content[1].mimeType, "image/png");
  assert.equal(Buffer.from(responses[3].result.content[1].data, "base64").readUInt32BE(16), 1440);
  assert.match(fs.readFileSync(path.join(dir, "cut.vcd"), "utf8"), /#3\nr-2\.5 s0/);
  assert.match(responses[5].result.content[0].text, /EEXIST/);
  assert.deepEqual(data(7), { selected: null, views: [] });
});

test("standalone MCP and Tcl honor the configured FSDB backend and explicit overrides", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wave-backend-preference-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, ".vscode"));
  fs.writeFileSync(path.join(dir, ".vscode", "settings.json"),
    JSON.stringify({ "waveWorkbench.fsdbBackend": "verdi" }));
  fs.writeFileSync(path.join(dir, "bench.fsdb"), "");
  const calls = [
    ["wave_open", { path: "bench.fsdb" }, "missing-verdi"],
    ["wave_tcl", { script: "wvOpenFile bench.fsdb" }, "missing-verdi"],
    ["wave_open", { path: "bench.fsdb", backend: "independent" }, "missing-independent"],
    ["wave_open", { path: "bench.fsdb", backend: "auto" }, "missing-independent"],
  ];
  const child = spawnSync(process.execPath, [path.resolve(__dirname, "../dist/mcp-headless.js"), dir], {
    input: calls.map(([name, args], id) => JSON.stringify({
      jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args },
    })).join("\n") + "\n",
    encoding: "utf8",
    env: {
      ...process.env,
      WAVE_WORKBENCH_INDEPENDENT_BACKEND: path.join(dir, "missing-independent"),
      WAVE_WORKBENCH_VERDI_BACKEND: path.join(dir, "missing-verdi"),
    },
    timeout: 15000,
  });
  assert.equal(child.status, 0, child.stderr);
  const replies = child.stdout.trim().split("\n").map(JSON.parse);
  assert.equal(replies.length, calls.length);
  for (const { id, result } of replies) {
    assert.equal(result.isError, true);
    assert.ok(result.content[0].text.includes(calls[id][2]), result.content[0].text);
  }
});

test("both MCP hosts publish the same schema and Tcl can run math and live debug", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wave-tools-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "mixed.vcd"), [
    "$timescale 1 ns $end", "$scope module tb $end", "$var real 64 r voltage $end",
    "$upscope $end", "$enddefinitions $end", "#0", "r0.125 r", "#5", "r0.75 r", "#12", "",
  ].join("\n"));
  const harness = path.join(dir, "harness");
  fs.writeFileSync(harness, [
    "#!/usr/bin/env node",
    "let tick = 0;",
    "require('node:readline').createInterface({input: process.stdin}).on('line', (command) => {",
    "  if (command === 'advance') tick++;",
    "  console.log(JSON.stringify({snapshot: {tick: String(tick), scale: '1ns', done: false, values: {'tb.clk': String(tick % 2)}}}));",
    "});",
  ].join("\n"), { mode: 0o700 });

  const run = (entry, calls) => {
    const result = spawnSync(process.execPath, [path.resolve(__dirname, "../dist", entry), dir], {
      input: calls.map(({ method, params }, id) => JSON.stringify({ jsonrpc: "2.0", id, method, params })).join("\n") + "\n",
      encoding: "utf8",
      env: { ...process.env, TMPDIR: dir, DISPLAY: "" },
      timeout: 15000,
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim().split("\n").map((line) => JSON.parse(line).result);
  };
  const list = { method: "tools/list" };
  const call = (name, args = {}) => ({ method: "tools/call", params: { name, arguments: args } });
  const launch = process.platform === "win32" ? [] : [
    call("wave_live_start", { program: harness }),
    call("wave_live_debug", { action: "attach" }),
    call("wave_debug_request", { command: "evaluate", arguments: { expression: "$tick" } }),
    call("wave_live_debug", { action: "detach" }),
    call("wave_live_control", { action: "stepClock", signal: "tb.clk", cycles: 3 }),
    call("wave_live_stop"),
    call("wave_live_history", { start: "0", end: "6", limit: 3 }),
    call("wave_live_history", { start: "3", end: "6", limit: 4 }),
  ];
  const [catalog, ...responses] = run("mcp-headless.js", [
    list,
    call("wave_tcl", { script: 'waveTool wave_open {{"path":"mixed.vcd"}}' }),
    call("wave_tcl", { script: 'set conversion adc; waveTool wave_math {{"operation":"adc","signals":["tb.voltage"],"options":{"bits":4,"name":"adc"}}}' }),
    call("wave_tcl", { script: "if {$conversion ne {adc}} {error {Tcl variables were lost}}; waveView" }),
    call("wave_save_project", { path: "mixed.waveproj" }),
    call("wave_close"),
    call("wave_open", { path: "mixed.waveproj" }),
    call("wave_clip", { start: "0", end: "12" }),
    ...launch,
  ]);
  assert.deepEqual(catalog, run("mcp.js", [list])[0]);
  for (const { name, inputSchema } of catalog.tools) {
    if (["wave_trace_drivers", "wave_trace_loads", "wave_trace_context", "wave_live_trace"].includes(name))
      assert.equal(inputSchema.properties.followContinuations.minimum, 0, name);
    if (name === "wave_trace_resume")
      assert.equal(inputSchema.properties.followContinuations.minimum, 1, name);
  }
  const data = responses.map((response) => {
    assert.equal(response.isError, undefined, response.content[0].text);
    return JSON.parse(response.content[0].text);
  });
  const converted = JSON.parse(data[1].result).signal;
  assert.equal(converted.width, 4);
  assert.equal(JSON.parse(data[2].result).chosen[0].name, "adc");
  assert.deepEqual(data[6].traces[0].events.slice(0, 2), [["0", "0010"], ["5", "1011"]]);
  if (launch.length) {
    assert.equal(data[9].body.result, "0");
    assert.equal(data[12].state, "exited");
    assert.deepEqual(data[13].samples.map(({ tick }) => tick), ["0", "1", "2"]);
    assert.equal(data[13].nextStart, "3");
    assert.deepEqual(data[14].samples.map(({ tick }) => tick), ["3", "4", "5"]);
  }
});
