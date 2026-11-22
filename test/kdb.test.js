// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

const {projectFile}=require('./fixtures');
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');
const {KdbSession,mapPrefix}=require('../dist/kdb');
const {Backend}=require('../dist/backend');
const independent=process.env.WAVE_TEST_INDEPENDENT==='1';
const binary=path.resolve(__dirname,independent?'../bin/wave-backend-independent':'../bin/wave-backend');
const options=independent?{args:['--independent'],useVerdiLibraries:false}:{};
const createSession=()=>new KdbSession(binary,independent?undefined:process.env.VERDI_HOME,undefined,options);
test('explicit path mappings use longest prefix and keep unrelated paths',()=>{
  assert.equal(mapPrefix('/old/src/a.sv',{'/old':'/new','/old/src':'/snapshot'}),'/snapshot/a.sv');
  assert.equal(mapPrefix('tb.dut.clk',{'tb':'top','tb.dut':'top.core'}),'top.core.clk');
  assert.equal(mapPrefix('/older/a.sv',{'/old':'/new'}),'/older/a.sv');
});

test('VCS KDB returns the elaborated library source for a module', {
  skip: !process.env.WAVE_TEST_VCS_LIBRARY_KDB,
}, async (t) => {
  const database = process.env.WAVE_TEST_VCS_LIBRARY_KDB;
  const session = createSession();
  t.after(() => session.dispose());
  await session.open(database);
  const sources = await session.moduleSourceFiles();
  assert.deepEqual(
    sources.filter((source) => path.basename(source) === 'leaf_model.sv'),
    [path.resolve(database, '../../lib/leaf_model.sv')],
  );
  const requests = session.backend.sequence;
  assert.equal(await session.moduleSourceFiles(), sources);
  assert.equal(session.backend.sequence, requests);
});

test('KDB packed ranges use each elaborated instance override', {
  skip: !process.env.WAVE_TEST_PACKED_PARAMETER_KDB,
}, async (t) => {
  const session = new KdbSession(
    process.env.WAVE_TEST_PACKED_PARAMETER_BACKEND || binary,
    independent ? undefined : process.env.VERDI_HOME,
    undefined,
    options,
  );
  t.after(() => session.dispose());
  await session.open(process.env.WAVE_TEST_PACKED_PARAMETER_KDB);
  const short = await session.resolve('tb.short_lane.middle');
  const long = await session.resolve('tb.long_lane.middle');
  assert.equal(short.file, long.file);
  assert.equal(short.line, long.line);
  assert.deepEqual(short.packedRange, [2, 0]);
  assert.deepEqual(long.packedRange, [5, 0]);
});

test('real KDB: hierarchy, signal declaration, instance, definition and FSDB correlation',{skip:!process.env.WAVE_TEST_KDB},async t=>{
  const session=createSession();
  const wave=new Backend(binary,options);t.after(()=>{session.dispose();wave.dispose();});
  const result=await session.open(process.env.WAVE_TEST_KDB);assert.equal(result.backend,independent?'rust-independent-kdb':'native-npi-kdb');
  const roots=await session.children();assert.ok(roots.some(r=>r.fullname==='cv32e40p_mac_trace_tb'));
  const core='cv32e40p_mac_trace_tb.dut.u_core.u_core.core_i';
  assert.equal(await session.parent(core),'cv32e40p_mac_trace_tb.dut.u_core.u_core');
  assert.ok((await session.children('cv32e40p_mac_trace_tb.dut.u_core.u_core')).some(c=>c.fullname===core));
  const signal=await session.resolve(core+'.clk_i');assert.equal(signal.instance,core);assert.equal(signal.line,45);assert.match(signal.file,/cv32e40p_core\.sv$/);
  assert.match(fs.readFileSync(signal.file,'utf8').split('\n')[signal.line-1],/clk_i/);
  const inst=await session.resolve(signal.instance);assert.equal(inst.line,112);assert.equal(inst.definitionLine,31);
  assert.match(fs.readFileSync(inst.file,'utf8').split('\n')[inst.line-1],/core_i/);
  assert.match(fs.readFileSync(inst.definitionFile,'utf8').split('\n')[inst.definitionLine-1],/module cv32e40p_core/);
  if(result.portLinks){
    const clock=(await session.portLinks(core,'clk_i')).find(link=>link.to.instance===core&&link.to.signal==='clk_i');
    assert.equal(clock?.from.instance,await session.parent(core));
    assert.match(fs.readFileSync(clock.file,'utf8').split('\n')[clock.line-1],/clk/);
    const tb = "cv32e40p_mac_trace_tb";
    const dspClock = (await session.portLinks(tb + ".dut", "clk_dsp_i")).find(
      (link) => link.from?.instance === tb && link.from.signal === "clk_dsp_i" &&
        link.to.instance === tb + ".dut" && link.to.signal === "clk_dsp_i",
    );
    assert.ok(dspClock);
    const interrupt = (await session.portLinks(tb, "intr_done")).find(
      (link) => link.from?.instance === tb + ".dut" &&
        link.from.signal === "intr_done_o" && link.to.signal === "intr_done",
    );
    assert.ok(interrupt);
    if (independent) {
      assert.equal(
        await session.unresolvedPortExpression(tb + ".dut", "corei_tl_h_i", "drivers"),
        true,
      );
      assert.equal(
        await session.unresolvedPortExpression(tb + ".dut", "clk_dsp_i", "drivers"),
        false,
      );
    }
    const requests=session.backend.sequence;
    await session.portLinks(core,'rst_ni');
    assert.equal(session.backend.sequence,requests);
  }
  await assert.rejects(session.resolve(core+'.does_not_exist'),/not found/);
  await wave.request('open',{path:path.resolve(process.env.WAVE_TEST_KDB,'../waves.fsdb')});
  const matches=await wave.request('search',{query:core+'.clk_i'});assert.ok(matches.signals.length);
  const dumped=matches.signals.find(s=>s.scope+'.'+s.name===core+'.clk_i');assert.ok(dumped);
  const declaration=await session.resolve(dumped.scope+'.'+dumped.name);assert.equal(declaration.file,signal.file);assert.equal(declaration.line,signal.line);
});

test('full-chip FPU hierarchy excludes interfaces and lazily resolves source',{skip:!process.env.WAVE_TEST_FPU_RUN},async t=>{
  const settings=JSON.parse(fs.readFileSync(projectFile('.vscode/settings.json'),'utf8'));
  const session=createSession();t.after(()=>session.dispose());await session.open(settings['waveWorkbench.kdbPath']);
  const roots=await session.children();assert.ok(roots.some(n=>n.fullname==='tb'));assert.ok(roots.every(n=>n.kind==='npiModule'));assert.ok(roots.every(n=>!n.file&&!n.definitionFile));
  const before=session.backend.sequence;assert.strictEqual(await session.children(),roots);assert.equal(session.backend.sequence,before);
  const tb=await session.children('tb');assert.ok(tb.some(n=>n.fullname==='tb.dut'&&n.module==='chip_earlgrey_asic'));assert.ok(!tb.some(n=>n.fullname.includes('alert_if[')));
  const all=await session.children('tb',true);const iface=all.find(n=>n.fullname==='tb.alert_if[0]');assert.equal(iface.kind,'npiInterface');assert.equal(iface.module,'alert_esc_if');
  const top=await session.children('tb.dut.top_earlgrey');assert.ok(top.some(n=>n.fullname.endsWith('.u_aes')));assert.ok(top.every(n=>['npiModule','npiGenScope','npiModuleArray','npiProgram'].includes(n.kind)));
  const parent='tb.dut.top_earlgrey.u_cv32e40p_dsp.u_core.u_core';const generated=(await session.children(parent)).find(n=>n.fullname===parent+'.fpu_gen');assert.equal(generated.kind,'npiGenScope');assert.ok((await session.children(generated.fullname)).some(n=>n.fullname.endsWith('.fp_wrapper_i')));
  const source=await session.resolve('tb.dut.top_earlgrey');assert.ok(fs.existsSync(source.definitionFile));assert.ok(source.definitionLine>0);
});

test('real KDB: interface members retain their own elaborated instances', {
  skip: !process.env.WAVE_TEST_MODPORT_KDB,
}, async t => {
  const session = createSession();
  t.after(() => session.dispose());
  const opened = await session.open(process.env.WAVE_TEST_MODPORT_KDB);
  for (const name of ['x', 'y']) {
    const instance = `alias_tb.${name}`;
    const scope = await session.resolve(instance);
    const member = await session.resolve(`${instance}.datum`);
    assert.equal(scope.kind, 'npiInterface');
    assert.equal(scope.instance, instance);
    assert.equal(member.instance, instance);
    assert.equal(member.module, 'channel');
    assert.equal(member.definitionFile, scope.definitionFile);
    assert.match(fs.readFileSync(member.definitionFile, 'utf8').split('\n')[member.definitionLine - 1], /interface channel/);
    assert.match(fs.readFileSync(member.file, 'utf8').split('\n')[member.line - 1], /logic datum/);
    if (opened.interfaceMembers) {
      const sender = name === 'x' ? 'sx' : 'sy';
      const receiver = name === 'x' ? 'rx' : 'ry';
      assert.deepEqual(await session.interfaceMember(`alias_tb.${sender}`, 'link.tx_data'), member);
      assert.deepEqual(await session.interfaceMember(instance, 'receiver.rx_data'), member);
      assert.deepEqual((await session.interfaceUsers(instance, 'datum'))
        .map(({ instance, interfacePath }) => `${instance}.${interfacePath}`).sort(),
        [`alias_tb.${sender}.link.tx_data`, `alias_tb.${receiver}.link.rx_data`].sort());
      assert.deepEqual(await session.interfaceUsers(instance, 'alternative'), []);
    }
  }
});

test('VCS KDB: modport aliases retain the backing packed selection', {
  skip: !process.env.WAVE_TEST_MODPORT_SLICE_KDB,
}, async t => {
  const session = createSession();
  t.after(() => session.dispose());
  await session.open(process.env.WAVE_TEST_MODPORT_SLICE_KDB);
  for (const [signal, range, sender, receiver] of [
    ['datum', [7, 6], 'tx', 'rx'],
    ['datum', [5, 4], 'low', 'low'],
    ['ascending', [1, 2], 'order', 'order'],
  ]) {
    const physical = await session.resolve('slice_tb.x.' + signal);
    const expected = { ...physical, interfaceRange: range };
    assert.deepEqual(await session.interfaceMember('slice_tb.tx', 'link.' + sender), expected);
    assert.deepEqual(await session.interfaceMember('slice_tb.rx', 'link.' + receiver), expected);
    assert.deepEqual(await session.interfaceMember('slice_tb.x', 'receiver.' + receiver), expected);
    const users = await session.interfaceUsers('slice_tb.x', signal);
    for (const [instance, member] of [['slice_tb.tx', sender], ['slice_tb.rx', receiver]]) {
      const user = users.find(item => item.instance === instance && item.interfacePath === 'link.' + member);
      assert.deepEqual(user?.interfaceRange, range);
    }
  }
});

test('VCS KDB: wildcard port binding preserves composite modport targets', {
  skip: !process.env.WAVE_TEST_WILDCARD_KDB,
}, async t => {
  const session = createSession();
  t.after(() => session.dispose());
  await session.open(process.env.WAVE_TEST_WILDCARD_KDB);
  const members = await session.interfaceMembers('wildcard_tb.sink', 'link.selected');
  assert.deepEqual(
    members.map(({ fullname, packedRange, interfaceRange }) => [fullname, packedRange, interfaceRange]),
    [
      ['wildcard_tb.link.data', [7, 4], [7, 7]],
      ['wildcard_tb.link.data', [7, 4], [5, 4]],
    ],
  );
  const links = await session.portLinks('wildcard_tb.sink', 'result');
  assert.ok(links.some(({ from, to }) => from.instance === 'wildcard_tb.sink' &&
    from.signal === 'result' && to.instance === 'wildcard_tb' && to.signal === 'result'));
});

test('VCS KDB: modport bit and part selections preserve negative and wide indices', {
  skip: !process.env.WAVE_TEST_MODPORT_BOUNDS_KDB,
}, async t => {
  const session = createSession();
  t.after(() => session.dispose());
  await session.open(process.env.WAVE_TEST_MODPORT_BOUNDS_KDB);
  for (const [member, physical, range] of [
    ['w', 'wide', [140, 139]],
    ['wi', 'wide', [140, 140]],
    ['ww', 'wider', [300, 299]],
    ['wwi', 'wider', [300, 300]],
    ['n', 'neg', [-2, -3]],
    ['ni', 'neg', [-2, -2]],
    ['z', 'bits', [7, 0]],
    ['zr', 'bits', [0, 0]],
    ['zi', 'bits', [0, 0]],
  ]) {
    const location = await session.interfaceMember('bounds_tb.r', 'link.' + member);
    assert.equal(location?.fullname, 'bounds_tb.x.' + physical);
    assert.deepEqual(location?.interfaceRange, range);
    assert.deepEqual(await session.interfaceMember('bounds_tb.x', 'mp.' + member), location);
  }
});

test('VCS KDB: modport concatenations retain source order and repeated operands', {
  skip: !process.env.WAVE_TEST_MODPORT_CONCAT_KDB,
}, async t => {
  const session = createSession();
  t.after(() => session.dispose());
  await session.open(process.env.WAVE_TEST_MODPORT_CONCAT_KDB);
  const members = await session.interfaceMembers('concat_tb.rx', 'link.with_repeat');
  assert.deepEqual(members.map(({ fullname, interfaceRange, interfaceWidth }) =>
    [fullname, interfaceRange, interfaceWidth]), [
    ['concat_tb.x.datum', [4, 4], 1],
    ['concat_tb.x.ascending', [2, 2], 1],
    ['concat_tb.x.datum', [7, 7], 1],
    ['concat_tb.x.datum', [4, 4], 1],
  ]);
  assert.equal(await session.interfaceMember('concat_tb.rx', 'link.with_repeat'), undefined);
  const alias = await session.interfaceMembers('concat_tb.x.receiver', 'with_repeat');
  assert.deepEqual(alias, members);
  assert(alias.every(member =>
    member.interfaceDeclaration?.file === member.file && member.interfaceDeclaration.line === 7));
  const users = await session.interfaceUsers('concat_tb.x', 'datum');
  assert.equal(users.filter(user => user.interfacePath === 'link.with_repeat').length, 1);
});

test('VCS KDB: flattens nested modport aliases while retaining overlapping parts', {
  skip: !process.env.WAVE_TEST_MODPORT_NESTED_KDB,
}, async t => {
  const session = createSession();
  t.after(() => session.dispose());
  await session.open(process.env.WAVE_TEST_MODPORT_NESTED_KDB);
  const receive = await session.interfaceMembers('nested_tb.nested.receive', 'joined');
  const send = await session.interfaceMembers('nested_tb.overlap.send', 'joined');
  const operands = parts => parts.map(({ fullname, interfaceRange, interfaceWidth }) =>
    [fullname, interfaceRange, interfaceWidth]);
  assert.deepEqual(operands(receive), [
    ['nested_tb.nested.data', [7, 7], 1],
    ['nested_tb.nested.ascending', [1, 2], 2],
    ['nested_tb.nested.data', [4, 4], 1],
    ['nested_tb.nested.data', [7, 7], 1],
  ]);
  assert.deepEqual(operands(send), [
    ['nested_tb.overlap.data', [3, 1], 3],
    ['nested_tb.overlap.bypass', undefined, 1],
    ['nested_tb.overlap.data', [2, 0], 3],
  ]);
  const users = await session.interfaceUsers('nested_tb.overlap', 'data');
  const writers = users.filter(user =>
    user.instance === 'nested_tb.writer' && user.interfacePath === 'bus_if.joined');
  assert.equal(writers.length, 1);
});

test('independent KDB: interface array aliases map formal and physical indices by position', {
  skip: !independent || !process.env.WAVE_TEST_MODPORT_ARRAY_KDB,
}, async t => {
  const session = createSession();
  t.after(() => session.dispose());
  await session.open(process.env.WAVE_TEST_MODPORT_ARRAY_KDB);
  for (const [element, writer, reader] of [[4, 7, -1], [5, 6, 0]]) {
    const physical = `array_tb.channels[${element}]`;
    const member = await session.resolve(physical + '.data');
    assert.deepEqual(await session.interfaceMember('array_tb.src', `link[${writer}].tx`), member);
    assert.deepEqual(await session.interfaceMember('array_tb.sink', `link[${reader}].rx`), member);
    assert.deepEqual(await session.interfaceMember(physical, 'receiver.rx'), member);
    assert.deepEqual(
      (await session.interfaceUsers(physical, 'data'))
        .map(({ instance, interfacePath }) => `${instance}.${interfacePath}`),
      [`array_tb.sink.link[${reader}].rx`, `array_tb.src.link[${writer}].tx`],
    );
  }
});

test('independent KDB: resolves signed interface indices from each instance parameter set', {
  skip: !independent || !process.env.WAVE_TEST_PARAMETER_INTERFACE_KDB,
}, async t => {
  const session = createSession();
  t.after(() => session.dispose());
  await session.open(process.env.WAVE_TEST_PARAMETER_INTERFACE_KDB);
  for (const [owner, value] of [['lx', 7], ['ly', 6], ['rx', -1], ['ry', 0]]) {
    const parameter = await session.resolve(`array_tb.${owner}.DEST`);
    assert.equal(parameter.kind, 'npiParameter');
    assert.deepEqual(parameter.parameterValue, {
      bits: BigInt.asUintN(32, BigInt(value)).toString(2).padStart(32, '0'),
      signed: true,
    });
  }
});

test('independent KDB: generic formals retain their actual interface type and member', {
  skip: !independent || !process.env.WAVE_TEST_GENERIC_INTERFACE_KDB,
}, async t => {
  const session = createSession();
  t.after(() => session.dispose());
  await session.open(process.env.WAVE_TEST_GENERIC_INTERFACE_KDB);
  for (const [owner, type, element] of [['lx', 'narrow_channel', 'x'], ['ly', 'alternate_channel', 'y']]) {
    const instance = `generic_tb.${owner}`;
    const [binding] = await session.genericInterfaceTypes(instance);
    const member = await session.interfaceMember(instance, 'link.data');
    assert.equal(binding.formal, 'link');
    assert.equal(binding.interface, type);
    assert.equal(binding.interfaceFile, member.definitionFile);
    assert.equal(binding.interfaceLine, member.definitionLine);
    assert.equal(member.instance, `generic_tb.${element}`);
  }
});

test('independent KDB: generic ports preserve explicitly passed and forwarded modports', {
  skip: !independent || !process.env.WAVE_TEST_GENERIC_MODPORT_KDB,
}, async t => {
  const session = createSession();
  t.after(() => session.dispose());
  await session.open(process.env.WAVE_TEST_GENERIC_MODPORT_KDB);
  for (const [element, writer, reader] of [['x', 'lx', 'rx'], ['y', 'ly.inner', 'ry.inner']]) {
    const member = await session.resolve(`generic_tb.${element}.data`);
    for (const [path, modport, alias] of [[writer, 'sender', 'tx'], [reader, 'receiver', 'rx']]) {
      const owner = `generic_tb.${path}`;
      const [binding] = await session.genericInterfaceTypes(owner);
      assert.equal(binding.modport, modport);
      assert.deepEqual(await session.interfaceMember(owner, 'link.' + alias), member);
      assert.equal(await session.interfaceMember(owner, 'link.unused'), undefined);
    }
  }
});

test('independent KDB: generic interface arrays keep their element type and declared order', {
  skip: !independent || !process.env.WAVE_TEST_GENERIC_ARRAY_KDB,
}, async t => {
  const session = createSession();
  t.after(() => session.dispose());
  await session.open(process.env.WAVE_TEST_GENERIC_ARRAY_KDB);
  for (const [owner, type, elements] of [
    ['lx', 'lane', ['x[4]', 'x[5]']],
    ['ly', 'other_lane', ['y[3]', 'y[2]']],
  ]) {
    const scope = `generic_tb.${owner}`;
    const [binding] = await session.genericInterfaceTypes(scope);
    assert.equal(binding.formal, 'link');
    assert.equal(binding.interface, type);
    for (const [ordinal, element] of elements.entries()) {
      const member = await session.interfaceMember(scope, `link[${7 - ordinal}].data`);
      assert.equal(member.instance, `generic_tb.${element}`);
      assert.equal(member.definitionFile, binding.interfaceFile);
      assert.equal(member.definitionLine, binding.interfaceLine);
    }
  }
});

test('independent KDB: elaborated port directions, instances, and gaps', {
  skip: !independent || !process.env.WAVE_TEST_INDEPENDENT_PORTS_KDB,
}, async t => {
  const session = createSession();
  t.after(() => session.dispose());
  assert.equal((await session.open(process.env.WAVE_TEST_INDEPENDENT_PORTS_KDB)).portLinks, true);
  const endpoints = links => links.filter(link => link.from)
    .map(({ from, to }) => `${from.instance}.${from.signal} -> ${to.instance}.${to.signal}`);
  assert.deepEqual(endpoints(await session.portLinks('ports_tb', 'a')), ['ports_tb.a -> ports_tb.lx.d']);
  assert.deepEqual(endpoints(await session.portLinks('ports_tb', 'n')), ['ports_tb.ly.q -> ports_tb.n']);
  assert.deepEqual(endpoints(await session.portLinks('ports_tb', 'd')), ['ports_tb.d -> ports_tb.lw.d']);
  assert.deepEqual(endpoints(await session.portLinks('ports_tb', 'legacy_q')), ['ports_tb.ld.q -> ports_tb.legacy_q']);
  assert.deepEqual(endpoints(await session.portLinks('ports_tb.gen', 'internal')), ['ports_tb.gen.internal -> ports_tb.gen.lg.d']);
  assert.equal((await session.resolve('ports_tb.gen.internal')).instance, 'ports_tb.gen');
  assert.deepEqual(endpoints(await session.portLinks('ports_tb', 'z')).sort(), ['ports_tb.io.z -> ports_tb.z', 'ports_tb.z -> ports_tb.io.z']);
  assert.deepEqual(await session.portLinks('ports_tb.lo', 'd'), []);
  assert.equal(await session.unresolvedPortExpression('ports_tb.lo', 'd', 'drivers'), false);
  const [concat] = await session.portLinks('ports_tb.ls', 'd');
  assert.deepEqual(concat.expression, {
    operands: [{instance: 'ports_tb', signal: 'a'}, {instance: 'ports_tb', signal: 'b'}],
    value: {op: 'concat', args: [{op: 'signal', args: 0}, {op: 'signal', args: 1}]},
  });
  assert.deepEqual(concat.conversion, {fromWidth: 2, toWidth: 1, twoState: false});
  assert.equal(await session.unresolvedPortExpression('ports_tb.ls', 'd', 'drivers'), false);
  assert.equal(await session.unresolvedPortExpression('ports_tb', 'a', 'loads'), false);
  assert.equal(await session.unresolvedPortExpression('ports_tb', 'en', 'loads'), false);
});

test('KDB: input expressions preserve operand order and instance bindings', {
  skip: !process.env.WAVE_TEST_COMPLEX_PORTS_KDB,
}, async t => {
  const session = createSession();
  t.after(() => session.dispose());
  await session.open(process.env.WAVE_TEST_COMPLEX_PORTS_KDB);
  const top = 'expr_tb';
  const mapping = (op, args) => ({op, args});
  const [ordered] = await session.portLinks(top + '.ordered_inst', 'a');
  assert.deepEqual(ordered.expression, {
    operands: ['enable', 'mask', 'data'].map(signal => ({instance: top, signal})),
    value: mapping('concat', [
      mapping('literal', ['1', false]), mapping('signal', 0), mapping('literal', ['0', false]),
      mapping('select', [1, 0, 0]), mapping('select', [2, 3, 3]),
    ]),
  });
  for (const {signal} of ordered.expression.operands) {
    assert((await session.portLinks(top, signal)).some(link => link.to.instance === ordered.to.instance));
  }
  const [coerced] = await session.portLinks(top + '.coerced_inst', 'a');
  assert.deepEqual(coerced.conversion, {fromWidth: 4, toWidth: 4, twoState: true});
  const [mixed] = await session.portLinks(top + '.mixed_inst', 'a');
  assert.deepEqual(mixed.expression.operands.map(operand => operand.signal), ['data', 'index', 'mask']);
  assert.deepEqual(mixed.expression.indexOperands, [1]);
  assert.equal(mixed.expression.value.args[0].args[0].op, 'bitSelect');
  assert.equal(mixed.expression.value.args[1].args[0], 'bitNot');
  const [repeat] = await session.portLinks(top + '.repeat_slice_inst', 'a');
  assert.deepEqual(repeat.expression, {
    operands: ['data', 'enable'].map(signal => ({instance: top, signal})),
    value: mapping('repeat', [2, mapping('concat', [
      mapping('select', [0, 1, 2]), mapping('literal', ['z', false]), mapping('signal', 1),
    ])]),
  });
  const [zero] = await session.portLinks(top + '.zero_repeat_inst', 'a');
  assert.deepEqual(zero.expression.operands.map(operand => operand.signal), ['data', 'enable']);
  assert(!(await session.portLinks(top, 'unrelated_data')).some(link => link.to.instance === zero.to.instance));
  const [narrowed] = await session.portLinks(top + '.compact_inst', 'a');
  assert.deepEqual(narrowed.conversion, { fromWidth: 4, toWidth: 3, twoState: false });
  for (const [instance, operation, ascendingIndices] of [
    ['complex_bit_inst', 'add', undefined], ['complex_up_inst', 'bitXor', true], ['complex_down_inst', 'subtract', false],
  ]) {
    const [link] = await session.portLinks(top + '.' + instance, 'a');
    const { operands, value, indexOperands } = link.expression;
    assert.deepEqual(operands.map(operand => operand.signal), ['data', 'index', 'offset']);
    assert.deepEqual(indexOperands, [1, 2]);
    assert.equal(value.args[1].args[0], operation);
    assert.deepEqual(value.args[2], ascendingIndices === undefined ? undefined : {width: 2, ascendingIndices});
    assert((await session.portLinks(top, 'offset')).some(link => link.to.instance === top + '.' + instance));
  }
});

test('independent KDB: packed selections and effective constant port values', {
  skip: !independent || !process.env.WAVE_TEST_INDEPENDENT_PACKED_KDB,
}, async t => {
  const session = createSession();
  t.after(() => session.dispose());
  await session.open(process.env.WAVE_TEST_INDEPENDENT_PACKED_KDB);
  const top = 'port_slice_tb';
  const dut = top + '.dut';
  const [input] = await session.portLinks(dut, 'request');
  assert.deepEqual(input.from, { instance: top, signal: 'tb_request', range: [2, 3] });
  const [output] = await session.portLinks(dut, 'result');
  assert.deepEqual(output.to, { instance: top, signal: 'dut_response', range: [5, 4] });
  for (const child of ['two', 'rev']) {
    const [link] = await session.portLinks(top + '.' + child, 'a');
    assert.deepEqual(link.from.range, [2, 3]);
  }
  const [bit] = await session.portLinks(top + '.bit_x', 'a');
  assert.equal(bit.from.bit, 2);
  for (const [child, signal, fromWidth, toWidth, twoState] of [
    ['widen', 'a', 2, 4, false],
    ['narrow', 'a', 3, 2, false],
    ['extend_output', 'q', 2, 4, false],
    ['convert', 'a', 2, 2, true],
    ['whole_widen_signed', 'a', 2, 4, false],
    ['whole_widen_unsigned', 'a', 2, 4, false],
    ['whole_extend_output', 'q', 2, 4, false],
    ['whole_narrow', 'a', 4, 2, false],
    ['whole_convert', 'a', 2, 2, true],
  ]) {
    const [link] = await session.portLinks(top + '.' + child, signal);
    assert.deepEqual(link.conversion, { fromWidth, toWidth, twoState });
  }
  for (const [child, signal, expected] of [
    ['dut', 'constant_select', '1'],
    ['signed_const', 'a', '11'],
    ['unsigned_const', 'a', '01'],
    ['unknown_const', 'a', 'xz'],
    ['fill', 'a', '11'],
  ]) {
    const instance = top + '.' + child;
    assert.deepEqual(await session.portLinks(instance, signal), []);
    const constant = await session.constantPortDriver(instance, signal);
    assert.equal(constant?.bits, expected);
    assert.equal(constant.signed, child === 'signed_const');
    assert.match(fs.readFileSync(constant.file, 'utf8').split('\n')[constant.line - 1], /\.(a|constant_select)\(/);
  }
  const dynamicInstance = top + '.bit_dynamic';
  const [dynamic] = await session.portLinks(dynamicInstance, 'a');
  assert.deepEqual(dynamic.from, { instance: top, signal: 'tb_request' });
  assert.deepEqual(dynamic.selectIndex, { instance: top, signal: 'index' });
  assert.equal(await session.unresolvedPortExpression(dynamicInstance, 'a', 'drivers'), false);
  const parts = [
    ['range_asc_plus', 'tb_request', 'index', true],
    ['range_asc_minus', 'tb_request', 'index', false],
    ['range_desc_plus', 'descending_data', 'signed_index', true],
    ['range_desc_minus', 'descending_data', 'index', false],
  ];
  for (const [child, base, index, ascendingIndices] of parts) {
    const instance = top + '.' + child;
    const [part] = await session.portLinks(instance, 'a');
    assert.deepEqual(part.from, { instance: top, signal: base });
    assert.deepEqual(part.selectIndex, { instance: top, signal: index, part: { width: 2, ascendingIndices } });
    assert((await session.portLinks(top, index)).some(link => link.to.instance === instance));
    assert.equal(await session.unresolvedPortExpression(instance, 'a', 'drivers'), false);
  }
  assert.equal(await session.unresolvedPortExpression(top, 'index', 'loads'), false);

  const {expandInstanceTrace} = require('../dist/rtl-trace-instances');
  const query = async ({ instance, signal }) => {
    const declaration = await session.resolve(`${instance}.${signal}`);
    return {
      root: 0, revision: 1, diagnostics: [], assignments: [], frontier: [],
      signals: [{
        id: 0, name: signal, declaration: {
          uri: declaration.file, range: { start: { line: declaration.line - 1, character: 0 } },
        },
      }],
    };
  };
  for (const [direction, instance, signal] of [
    ['drivers', dynamicInstance, 'a'], ['loads', top, 'index'], ['loads', top, 'tb_request'],
  ]) {
    const trace = await expandInstanceTrace(await query({ instance, signal }), instance, session,
      direction, { maxDepth: 1 }, file => file, query);
    const selected = trace.assignments.find(assignment => assignment.value?.op === 'bitSelect');
    assert.ok(selected);
    const [base, index] = selected.value.args;
    assert.equal(trace.signals[base].name, 'tb_request');
    assert.equal(trace.signals[index.args].name, 'index');
    assert.deepEqual(selected.inputs.map(input => input.signal), [base, index.args]);
    assert.equal(selected.port.indexSignal, index.args);
    assert.equal(trace.signals[selected.targets[0]].instance, dynamicInstance);
  }
  for (const [direction, instance, signal] of [
    ['drivers', top + '.range_asc_plus', 'a'], ['loads', top, 'index'],
    ['loads', top, 'tb_request'],
  ]) {
    const trace = await expandInstanceTrace(await query({ instance, signal }), instance, session,
      direction, { maxDepth: 1 }, file => file, query);
    const selected = trace.assignments.find(assignment => assignment.value?.op === 'indexedPartSelect' &&
      trace.signals[assignment.targets[0]].instance === top + '.range_asc_plus');
    assert.ok(selected);
    const [base, index, part] = selected.value.args;
    assert.equal(trace.signals[base].name, 'tb_request');
    assert.equal(trace.signals[index.args].name, 'index');
    assert.deepEqual(part, {width: 2, ascendingIndices: true});
    assert.deepEqual(selected.port.indexedPart, part);
    assert.deepEqual(selected.inputs.map(input => input.signal), [base, index.args]);
  }
});

test('independent KDB: loop generate ports use the local parameter of each iteration', {
  skip: !independent || !process.env.WAVE_TEST_GENERATE_PORTS_KDB,
}, async t => {
  const session = createSession();
  t.after(() => session.dispose());
  await session.open(process.env.WAVE_TEST_GENERATE_PORTS_KDB);
  const top = 'generate_ports_tb';
  for (const [index, branch, inputBit, outputBit] of [
    [-1, 'outer', 0, 1], [0, 'center', 3, 2], [1, 'outer', 4, 5],
  ]) {
    const iteration = top + '.lanes[' + index + ']';
    const instance = iteration + '.' + branch + '.cell_inst';
    const [input] = await session.portLinks(instance, 'a');
    const [output] = await session.portLinks(instance, 'q');
    assert.deepEqual(input.from, {instance: top, signal: 'input_bus', bit: inputBit});
    assert.deepEqual(output.to, {instance: top, signal: 'output_bus', bit: outputBit});
    const [shifted] = await session.portLinks(iteration + '.shifted', 'a');
    const { operands, indexOperands, value } = shifted.expression;
    assert.deepEqual(operands.map(operand => operand.signal), ['input_bus', 'shift']);
    assert.deepEqual(indexOperands, [1]);
    assert.equal(value.op, 'bitSelect');
    assert.equal(value.args[1].args[0], 'add');
    assert.deepEqual(value.args[1].args[1].args, [((index + 1) * 2).toString(2).padStart(32, '0'), true]);
    assert.equal(await session.unresolvedPortExpression(iteration + '.shifted', 'a', 'drivers'), false);
  }
  assert.equal((await session.portLinks(top, 'shift')).length, 3);
});

test('independent KDB: loop-local assignments retain iteration identity and active parents', {
  skip: !independent || !process.env.WAVE_TEST_GENERATE_ASSIGNMENTS_KDB,
}, async t => {
  const session = createSession();
  t.after(() => session.dispose());
  await session.open(process.env.WAVE_TEST_GENERATE_ASSIGNMENTS_KDB);
  const { expandInstanceTrace } = require('../dist/rtl-trace-instances');
  const top = 'generate_assignments_tb';
  const center = top + '.lanes[0]';
  const location = (uri, line) => ({uri, range: {start: {line: line - 1, character: 0}}});
  const names = ['src_a', 'src_b', 'gate', 'intermediate', 'result_value', 'input_bits', 'output_bits'];
  const signals = await Promise.all(names.map(async (name, id) => {
    const instance = id === 3 || id === 4 ? center : top;
    const declaration = await session.resolve(instance + '.' + name);
    return {id, name, declaration: location(declaration.file, declaration.line)};
  }));
  const uri = signals[0].declaration.uri;
  const source = fs.readFileSync(uri, 'utf8').split('\n');
  const line = (text) => source.findIndex(value => value.includes(text)) + 1;
  const label = (name) => ({name, uri, line: line('begin : ' + name) - 1, byteColumn: 0});
  const loop = {selected: label('lanes'), alternatives: [], loopScope: true, loopVariable: 'index'};
  const branch = (name, other) => ({selected: label(name), alternatives: [label(other)]});
  const assign = (text, targets, inputs, generateBranches) => ({
    kind: 'continuous', location: location(uri, line(text)), targets, generateBranches,
    inputs: inputs.map(signal => ({signal, kind: 'data', edge: null, location: location(uri, line(text))})),
    hasUnresolvedOperands: false,
  });
  const relations = [
    assign('intermediate = src_a', [3], [0], [loop, branch('outer', 'center')]),
    assign('intermediate = src_b', [3], [1], [loop, branch('center', 'outer')]),
    assign('result_value = intermediate', [4], [3, 2], [loop]),
    {
      ...assign('assign output_bits', [6], [5, 4], [loop]),
      targetIndex: {op: 'binary', args: ['subtract', {op: 'unsignedBit', args: true}, {op: 'generateIndex', args: 'index'}]},
      value: {op: 'bitSelect', args: [5, {op: 'generateIndex', args: 'index'}]},
    },
  ];
  const trace = (root) => ({root, signals, revision: '1', diagnostics: [], frontier: [], assignments: relations});
  for (const [index, upstream] of [[-1, 'src_a'], [0, 'src_b'], [1, 'src_a']]) {
    const instance = top + '.lanes[' + index + ']';
    const result = await expandInstanceTrace(trace(4), instance, session, 'drivers',
      {maxDepth: 3}, file => file, async () => undefined);
    assert.deepEqual(result.signals.map(node => node.name).sort(), [upstream, 'gate', 'intermediate', 'result_value'].sort());
    assert.equal(result.assignments.length, 2);
    assert(result.assignments.some(node => node.instance === instance + (index === 0 ? '.center' : '.outer')));
  }
  const loads = await expandInstanceTrace(trace(0), top, session, 'loads',
    {maxDepth: 3}, file => file, async () => undefined);
  assert.deepEqual(loads.signals.filter(node => node.name === 'result_value').map(node => node.instance).sort(),
    [top + '.lanes[-1]', top + '.lanes[1]']);
  const bits = await expandInstanceTrace(trace(6), top, session, 'drivers',
    {maxDepth: 5}, file => file, async () => undefined);
  const writes = bits.assignments.filter(node => node.targets.includes(bits.root));
  assert.deepEqual(writes.map(node => [node.instance, node.targetRange[0],
    Number(BigInt.asIntN(32, BigInt('0b' + node.value.args[1].args[0]))) ]).sort(), [
    [top + '.lanes[-1]', 2, -1], [top + '.lanes[0]', 1, 0], [top + '.lanes[1]', 0, 1],
  ]);
});

test('Independent VCS KDB retains shift, multiplication and conditional port operands', {
  skip: !independent || !process.env.WAVE_TEST_KDB_EXTRA_PORTS,
}, async t => {
  const session = createSession();
  t.after(() => session.dispose());
  await session.open(process.env.WAVE_TEST_KDB_EXTRA_PORTS);
  const instance = 'extra_port_tb';
  const expected = [
    ['left_shift', 'shiftLeft', ['data', 'amount']],
    ['right_shift', 'shiftRight', ['data', 'amount']],
    ['multiply', 'multiply', ['data', 'alternate']],
    ['conditional', undefined, ['choose', 'data', 'alternate']],
  ];
  for (const [name, operator, operands] of expected) {
    const scope = instance + '.' + name;
    const [link] = await session.portLinks(scope, 'value');
    assert.equal(await session.unresolvedPortExpression(scope, 'value', 'drivers'), false);
    assert.deepEqual(link.expression.operands, operands.map(signal => ({ instance, signal })));
    if (operator) {
      assert.deepEqual(link.expression.value, {
        op: 'binary', args: [operator, { op: 'signal', args: 0 }, { op: 'signal', args: 1 }],
      });
    } else {
      assert.deepEqual(link.expression.value, {
        op: 'conditional', args: [0, 1, 2].map(args => ({ op: 'signal', args })),
      });
    }
  }
});

test('Verdi NPI KDB: generate port selections retain instance indices and runtime operands', {
  skip: independent || !process.env.WAVE_TEST_GENERATE_PORTS_KDB,
}, async t => {
  const session = createSession();
  t.after(() => session.dispose());
  await session.open(process.env.WAVE_TEST_GENERATE_PORTS_KDB);
  const top = 'generate_ports_tb';
  for (const [index, branch, inputBit, outputBit] of [
    [-1, 'outer', 0, 1], [0, 'center', 3, 2], [1, 'outer', 4, 5],
  ]) {
    const instance = top + '.lanes[' + index + '].' + branch + '.cell_inst';
    const [input] = await session.portLinks(instance, 'a');
    const [output] = await session.portLinks(instance, 'q');
    assert.deepEqual(input.from, { instance: top, signal: 'input_bus', range: [inputBit, inputBit] });
    assert.deepEqual(output.to, { instance: top, signal: 'output_bus', range: [outputBit, outputBit] });
    assert.equal(await session.unresolvedPortExpression(instance, 'q', 'loads'), false);
  }
  const outputs = await session.portLinks(top, 'output_bus');
  assert.deepEqual(outputs.map(({ to }) => to.range[0]).sort((a, b) => a - b), [1, 2, 5]);
  assert.equal(await session.unresolvedPortExpression(top, 'output_bus', 'drivers'), false);
  for (const index of [-1, 0, 1]) {
    const shifted = top + '.lanes[' + index + '].shifted';
    const [link] = await session.portLinks(shifted, 'a');
    assert.deepEqual(link.expression.operands, [
      { instance: top, signal: 'input_bus' }, { instance: top, signal: 'shift' },
    ]);
    assert.deepEqual(link.expression.indexOperands, [1]);
    assert.deepEqual(link.expression.value, { op: 'bitSelect', args: [0, {
      op: 'binary', args: ['add',
        { op: 'literal', args: [((index + 1) * 2).toString(2).padStart(32, '0'), true] },
        { op: 'signal', args: 1 },
      ],
    }] });
    assert.equal(await session.unresolvedPortExpression(shifted, 'a', 'drivers'), false);
  }
  const uses = await session.portLinks(top, 'shift');
  assert.equal(uses.length, 3);
  assert.equal(await session.unresolvedPortExpression(top, 'input_bus', 'loads'), false);
});

test('Verdi NPI KDB: integral parameters preserve instance overrides, width and four states', {
  skip: independent || !process.env.WAVE_TEST_NPI_PARAMETER_KDB,
}, async t => {
  const session = new KdbSession(process.env.WAVE_WORKBENCH_VERDI_BACKEND || binary, process.env.VERDI_HOME);
  t.after(() => session.dispose());
  await session.open(process.env.WAVE_TEST_NPI_PARAMETER_KDB);
  for (const [instance, delta, wide, four] of [
    ['a', '111111110', 0xdecaf0123456789abn, '10xz'],
    ['b', '000010001', 0x123456789abcdefffn, '01zx'],
  ]) {
    const scope = 'parameter_tb.' + instance;
    const signed = await session.resolve(scope + '.DELTA');
    assert.equal(signed.kind, 'npiParameter');
    assert.equal(signed.instance, scope);
    assert.equal(signed.line, 4);
    assert.deepEqual(signed.parameterValue, { bits: delta, signed: true });
    assert.deepEqual((await session.resolve(scope + '.WIDE')).parameterValue, {
      bits: wide.toString(2).padStart(68, '0'), signed: false,
    });
    assert.deepEqual((await session.resolve(scope + '.FOUR')).parameterValue, {
      bits: four, signed: false,
    });
    assert.equal((await session.resolve(scope + '.GAIN')).parameterValue, undefined);
    assert.equal((await session.resolve(scope + '.LABEL')).parameterValue, undefined);
  }
});

test('Verdi NPI KDB: dynamic part-select inputs preserve width and index direction', {
  skip: independent || !process.env.WAVE_TEST_INDEPENDENT_PACKED_KDB,
}, async t => {
  const session = createSession();
  t.after(() => session.dispose());
  await session.open(process.env.WAVE_TEST_INDEPENDENT_PACKED_KDB);
  const top = 'port_slice_tb';
  for (const [child, base, index, ascendingIndices] of [
    ['range_asc_plus', 'tb_request', 'index', true],
    ['range_asc_minus', 'tb_request', 'index', false],
    ['range_desc_plus', 'descending_data', 'signed_index', true],
    ['range_desc_minus', 'descending_data', 'index', false],
  ]) {
    const instance = top + '.' + child;
    const [link] = await session.portLinks(instance, 'a');
    assert.deepEqual(link.from, { instance: top, signal: base });
    assert.deepEqual(link.selectIndex, {
      instance: top, signal: index, part: { width: 2, ascendingIndices },
    });
    assert((await session.portLinks(top, index)).some(link => link.to.instance === instance));
    assert.equal(await session.unresolvedPortExpression(instance, 'a', 'drivers'), false);
  }
});

test('KDB: instance arrays split packed ports in declaration order', {
  skip: !process.env.WAVE_TEST_ARRAY_PORTS_KDB,
}, async t => {
  const session = createSession();
  t.after(() => session.dispose());
  await session.open(process.env.WAVE_TEST_ARRAY_PORTS_KDB);
  const top = 'arrays_tb';
  for (const [instance, input, fromRange, output, toRange] of [
    ['desc[3]', 'high', [7, 6], 'desc_out', [5, 6]],
    ['desc[2]', 'high', [5, 4], 'desc_out', [7, 8]],
    ['asc[-1]', 'low', [2, 3], 'asc_out', [9, 8]],
    ['asc[0]', 'low', [4, 5], 'asc_out', [7, 6]],
    ['slices[1]', 'shared', undefined, 'slice_out', [5, 4]],
    ['slices[0]', 'shared', undefined, 'slice_out', [3, 2]],
  ]) {
    const lane = `${top}.${instance}`;
    const [receiver] = await session.portLinks(lane, 'i');
    const [sender] = await session.portLinks(lane, 'o');
    const [enable] = await session.portLinks(lane, 'en');
    assert.deepEqual(receiver.from, {
      instance: top, signal: input, ...(fromRange ? { range: fromRange } : {}),
    });
    assert.deepEqual(sender.to, { instance: top, signal: output, range: toRange });
    assert.deepEqual(enable.from, { instance: top, signal: 'enable' });
    const upstream = (await session.portLinks(top, output)).find(({ from }) =>
      from.instance === lane && from.signal === 'o');
    const downstream = (await session.portLinks(top, input)).find(({ to }) =>
      to.instance === lane && to.signal === 'i');
    assert(upstream);
    assert(downstream);
    assert.deepEqual(upstream.to, sender.to);
    assert.deepEqual(downstream.from, receiver.from);
    assert.equal(await session.unresolvedPortExpression(lane, 'i', 'drivers'), false);
    assert.equal(await session.unresolvedPortExpression(lane, 'o', 'loads'), false);
  }
  for (const [instance, bits, signed] of [
    ['constants[1]', '10', false], ['constants[0]', '01', false],
    ['broadcast[0]', '10', true], ['broadcast[1]', '10', true],
  ]) {
    const lane = `${top}.${instance}`;
    assert.deepEqual(await session.portLinks(lane, 'i'), []);
    const literal = await session.constantPortDriver(lane, 'i');
    assert.equal(literal?.bits, bits);
    assert.equal(literal.signed, signed);
    assert.equal(await session.unresolvedPortExpression(lane, 'i', 'drivers'), false);
  }
});

test('Verdi NPI KDB: literal drivers preserve four-state bits and port width', {
  skip: independent || !process.env.WAVE_TEST_INDEPENDENT_PACKED_KDB,
}, async t => {
  const session = createSession();
  t.after(() => session.dispose());
  await session.open(process.env.WAVE_TEST_INDEPENDENT_PACKED_KDB);
  for (const [instance, bits, signed] of [
    ['signed_const', '11', true],
    ['unsigned_const', '01', false],
    ['unknown_const', 'xz', false],
    ['fill', '11', false],
  ]) {
    const scope = 'port_slice_tb.' + instance;
    assert.deepEqual(await session.portLinks(scope, 'a'), []);
    const driver = await session.constantPortDriver(scope, 'a');
    assert.deepEqual([driver?.bits, driver?.signed], [bits, signed]);
    assert.match(fs.readFileSync(driver.file, 'utf8').split('\n')[driver.line - 1], /\.a\(/);
    assert.equal(await session.unresolvedPortExpression(scope, 'a', 'drivers'), false);
  }
});

test('KDB: packed output concatenations map nested targets in declaration order', {
  skip: !process.env.WAVE_TEST_OUTPUT_CONCAT_KDB,
}, async t => {
  const session = createSession();
  t.after(() => session.dispose());
  await session.open(process.env.WAVE_TEST_OUTPUT_CONCAT_KDB);
  const links = await session.portLinks('tb.dut', 'q');
  assert.deepEqual(links.map(({ from, to }) => [to.signal, from.range, to.range]), [
    ['upper', [0, 1], [2, 1]],
    ['lane', [2, 3], [1, 2]],
    ['tail_a', [4, 4], undefined],
    ['tail_b', [5, 5], undefined],
  ]);
  assert.equal(await session.unresolvedPortExpression('tb.dut', 'q', 'loads'), false);
  for (const link of links) {
    assert.equal(link.to.instance, 'tb');
    assert.deepEqual(await session.portLinks('tb', link.to.signal), [link]);
    assert.equal(await session.unresolvedPortExpression('tb', link.to.signal, 'drivers'), false);
  }
});

test('KDB: sized output concatenations extend or retain the low bits', {
  skip: !process.env.WAVE_TEST_OUTPUT_CONCAT_KDB,
}, async t => {
  const session = createSession();
  t.after(() => session.dispose());
  await session.open(process.env.WAVE_TEST_OUTPUT_CONCAT_KDB);

  const signed = await session.portLinks('tb', 'sign_hi');
  assert.deepEqual(signed.map(({ from, to }) => [from?.range, to.range]), [
    [undefined, [1, 1]],
    [[0, 0], [0, 0]],
  ]);
  assert.deepEqual(signed[0].expression, {
    operands: [{ instance: 'tb.s', signal: 'q' }],
    value: { op: 'repeat', args: [1, { op: 'select', args: [0, 0, 0] }] },
  });
  assert.deepEqual((await session.portLinks('tb.s', 'q')).slice(0, 2), signed);

  const unsigned = await session.portLinks('tb', 'zero_hi');
  assert.deepEqual(unsigned.map(({ from, to }) => [from?.range, to.range]), [
    [undefined, [1, 1]],
    [[2, 2], [0, 0]],
  ]);
  assert.deepEqual(unsigned[0].expression, {
    operands: [],
    value: { op: 'literal', args: ['0', false] },
  });
  assert.deepEqual((await session.portLinks('tb.u', 'q'))[0], unsigned[1]);

  const narrowed = await session.portLinks('tb.n', 'q');
  assert.deepEqual(narrowed.map(({ from, to }) => [from.range, to.signal]), [
    [[1, 1], 'narrow_hi'],
    [[2, 2], 'narrow_lo'],
  ]);
  assert.deepEqual(await session.portLinks('tb', 'narrow_hi'), narrowed.slice(0, 1));
  for (const signal of ['sign_hi', 'zero_hi', 'narrow_hi'])
    assert.equal(await session.unresolvedPortExpression('tb', signal, 'drivers'), false);
});

test('VCS KDB module schematic keeps array ports, slices, constants and hierarchy', {
  skip: !process.env.WAVE_TEST_ARRAY_PORTS_KDB,
}, async (t) => {
  const {kdbModuleSchematic, kdbSchematicRoots} = require('../dist/kdb-schematic');
  const session = createSession();
  t.after(() => session.dispose());
  await session.open(process.env.WAVE_TEST_ARRAY_PORTS_KDB);
  const roots = await kdbSchematicRoots(session);
  assert.ok(roots.some((root) => root.fullname === 'arrays_tb'));
  const graph = await kdbModuleSchematic(session, 'arrays_tb');
  assert.equal(graph.partial, false);
  const modules = graph.nodes.filter((node) => node.kind === 'module');
  assert.equal(modules.length, 10);
  const slice = modules.find((node) => node.label === 'slices[0]');
  const output = slice.ports.find((pin) => pin.label === 'o');
  assert.equal(output.direction, 'output');
  assert.ok(graph.edges.some((edge) =>
    edge.fromPort === output.id && edge.to === 'net:arrays_tb.slice_out' && edge.label,
  ));
  assert.ok(graph.nodes.some((node) => node.kind === 'constant'));
  const detail = await kdbModuleSchematic(session, slice.instance);
  assert.equal(detail.module.parent, 'arrays_tb');
  assert.deepEqual(detail.nodes.filter((node) => node.kind === 'port')
    .map(({label, direction}) => [label, direction]), [['en', 'input'], ['i', 'input'], ['o', 'output']]);
});
