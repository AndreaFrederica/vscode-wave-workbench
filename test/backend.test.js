// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {Backend}=require('../dist/backend');
const binary=path.resolve(__dirname,'../bin/wave-backend');
const independent=process.env.WAVE_TEST_INDEPENDENT==='1';
const fsdbBinary=independent?path.resolve(__dirname,'../bin/wave-backend-independent'):binary;
const fsdbOptions=independent?{args:['--independent'],useVerdiLibraries:false}:{};
test('VCD protocol: metadata, window seed, binary values, truncation, recoverable errors',async t=>{
  const b=new Backend(binary);t.after(()=>b.dispose());
  const m=await b.request('open',{path:path.resolve(__dirname,'../examples/demo.vcd')});
  assert.equal(m.backend,'rust-vcd');assert.equal(m.scale,'1ns');assert.equal(m.signals.length,4);
  const search=await b.request('search',{query:'tb.dut.data'});assert.equal(search.total,1);assert.equal(search.signals[0].name,'data[7:0]');
  const described=await b.request('describe',{signals:[m.signals[0].id]});assert.equal(described[0].name,m.signals[0].name);
  const clk=m.signals.find(s=>s.name==='clk');const data=m.signals.find(s=>s.name.startsWith('data'));
  const result=await b.request('query',{signals:[clk.id,data.id],start:'12',end:'31',limit:100});
  assert.deepEqual(result[clk.id].events[0],['10','0']);
  assert.deepEqual(result[data.id].events.at(-1),['30','11110000']);
  const clipped=await b.request('query',{signals:[clk.id],start:'0',end:'50',limit:2});assert.equal(clipped[clk.id].truncated,true);
  await assert.rejects(b.request('query',{signals:[clk.id],start:'30',end:'1'}),/Invalid query/);
  await assert.rejects(b.request('query',{signals:['bogus'],start:'0',end:'10'}),/Unknown signal/);
  assert.equal((await b.request('query',{signals:[clk.id],start:'50',end:'50'}))[clk.id].events[0][0],'50');
});
test('Native FSDB: metadata and digital signal seek without VCD conversion',{skip:!process.env.WAVE_TEST_FSDB},async t=>{
  const b=new Backend(fsdbBinary,{...fsdbOptions,onLog:()=>{}});t.after(()=>b.dispose());
  const m=await b.request('open',{path:process.env.WAVE_TEST_FSDB});
  assert.equal(m.backend,independent?'rust-independent-fsdb':'native-fsdb');assert.ok(m.signals.length>0);assert.ok(BigInt(m.end)>=BigInt(m.start));
  const s=m.signals.find(s=>s.supported&&/clk/.test(s.name))||m.signals.find(s=>s.supported);
  const r=await b.request('query',{signals:[s.id],start:m.start,end:m.end,limit:1000});
  assert.ok(r[s.id].events.length>0);assert.match(r[s.id].events[0][1],/^[01xz]+$/);
  const events=r[s.id].events;
  for(let i=1;i<events.length;i++)assert.ok(BigInt(events[i][0])>=BigInt(events[i-1][0]));
  const mid=events[Math.floor(events.length/2)][0];
  const seed=await b.request('query',{signals:[s.id],start:mid,end:mid,limit:100});
  assert.ok(seed[s.id].events.length>0,'seek returns value at the requested boundary');
  assert.equal(seed[s.id].events.at(-1)[1],events.findLast(e=>e[0]===mid)[1]);
});

test('VCS FSDB keeps modport alias paths and samples on their own interface instances', {
  skip: !process.env.WAVE_TEST_MODPORT_FSDB,
}, async t => {
  const backend = new Backend(fsdbBinary, fsdbOptions);
  t.after(() => backend.dispose());
  const waveform = await backend.request('open', { path: process.env.WAVE_TEST_MODPORT_FSDB });
  const byPath = new Map(waveform.signals.map(({ scope, name, id }) => [`${scope}.${name}`, id]));
  const channels = [
    ['x', '1'],
    ['y', '4'],
  ];
  for (const [channel, transition] of channels) {
    const aliases = ['sender.tx_data', 'receiver.rx_data'];
    const ids = aliases.map(alias => byPath.get(`alias_tb.${channel}.${alias}`));
    assert.ok(ids.every(Boolean), `Missing modport metadata for ${channel}`);
    const observations = await backend.request('query', { signals: [...new Set(ids)], start: '0', end: '6' });
    for (const id of ids)
      assert.deepEqual(observations[id].events, [['0', '0'], [transition, '1']]);
  }
});

test('VCS FSDB reads interface array elements and their modport alias histories', {
  skip: !process.env.WAVE_TEST_MODPORT_ARRAY_FSDB,
}, async t => {
  const backend = new Backend(fsdbBinary, fsdbOptions);
  t.after(() => backend.dispose());
  const waveform = await backend.request('open', { path: process.env.WAVE_TEST_MODPORT_ARRAY_FSDB });
  for (const [element, transition] of [[4, '1'], [5, '3']]) {
    const scope = `array_tb.channels[${element}]`;
    const ids = [['', 'data'], ['.sender', 'tx'], ['.receiver', 'rx']].map(([suffix, member]) =>
      waveform.signals.find(signal => signal.scope === scope + suffix && signal.name === member)?.id
    );
    assert.ok(ids.every(Boolean), `Missing waveform members of ${scope}`);
    const observations = await backend.request('query', {
      signals: [...new Set(ids)], start: '0', end: '5',
    });
    for (const id of ids)
      assert.deepEqual(observations[id].events, [['0', '0'], [transition, '1']]);
  }
});

test('VCS FSDB opens generic interface references and retains their respective histories', {
  skip: !process.env.WAVE_TEST_GENERIC_INTERFACE_FSDB,
}, async t => {
  const backend = new Backend(fsdbBinary, fsdbOptions);
  t.after(() => backend.dispose());
  const waveform = await backend.request('open', { path: process.env.WAVE_TEST_GENERIC_INTERFACE_FSDB });
  const channels = ['x', 'y'].map(name =>
    waveform.signals.find(signal => signal.scope === `generic_tb.${name}` && signal.name === 'data')
  );
  assert.ok(channels.every(Boolean));
  const values = await backend.request('query', {
    signals: channels.map(channel => channel.id), start: '0', end: '5',
  });
  assert.deepEqual(channels.map(channel => values[channel.id].events), [
    [['0', '0'], ['1', '1']],
    [['0', '0'], ['3', '1']],
  ]);
});

test('VCS FSDB repeated array declarations resolve to one waveform per element', {
  skip: !process.env.WAVE_TEST_GENERIC_ARRAY_FSDB,
}, async t => {
  const backend = new Backend(fsdbBinary, fsdbOptions);
  t.after(() => backend.dispose());
  await backend.request('open', { path: process.env.WAVE_TEST_GENERIC_ARRAY_FSDB });
  for (const [element, tick] of [['x[4]', '1'], ['x[5]', '2'], ['y[3]', '3'], ['y[2]', '4']]) {
    const { matches } = await backend.request('matchNames', {
      query: `generic_tb.${element}`, names: ['data'],
    });
    assert.equal(matches.data?.length, 1, `Expected one binding for ${element}`);
    const [{ id }] = matches.data;
    const observations = await backend.request('query', { signals: [id], start: '0', end: '5' });
    assert.deepEqual(observations[id].events, [['0', '0'], [tick, '1']]);
  }
});

test('Rust cache: exact and containing hits, truncation correctness, budgets and open invalidation',async t=>{
  const b=new Backend(binary);t.after(()=>b.dispose());
  const fixture=path.resolve(__dirname,'../examples/demo.vcd');await b.request('open',{path:fixture});
  const full={signals:['!'],start:'0',end:'50',limit:100};
  const result=await b.request('query',full);await b.request('query',full);
  const sub=await b.request('query',{...full,start:'12',end:'31'});
  assert.deepEqual(sub['!'].events[0],['10','0']);
  let stats=await b.request('cacheStats');assert.equal(stats.reads,1);assert.equal(stats.hits,2);assert.equal(stats.containingHits,1);
  await b.request('cacheConfigure',{bytes:0});stats=await b.request('cacheStats');assert.equal(stats.entries,0);assert.equal(stats.bytes,0);
  assert.deepEqual(await b.request('query',full),result);stats=await b.request('cacheStats');assert.equal(stats.reads,2);assert.equal(stats.entries,0);
  await b.request('cacheConfigure',{bytes:4096});
  const clipped=await b.request('query',{...full,limit:1});assert.equal(clipped['!'].truncated,true);
  stats=await b.request('cacheStats');const before=stats.reads;
  const end=await b.request('query',{...full,start:'40',end:'50'});assert.equal(end['!'].events.at(-1)[0],'50');
  stats=await b.request('cacheStats');assert.equal(stats.reads,before+1,'a truncated block cannot answer a different range');assert.ok(stats.bytes<=stats.budget);
  await b.request('open',{path:fixture});stats=await b.request('cacheStats');assert.equal(stats.reads,0);assert.equal(stats.entries,0);assert.equal(stats.budget,4096);
});
test('metadata paging and bulk alias descriptors exceed old 1500 / 64 limits',async t=>{
  const fs=require('node:fs'),os=require('node:os');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wave-pages-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'many.vcd');let input='$scope module top $end\n';for(let i=0;i<1700;i++)input+=`$var wire 1 v${i} sig_${i} $end\n`;input+='$var wire 1 v0 alias $end\n$upscope $end\n$enddefinitions $end\n#0\n0v0\n#1\n1v0\n';fs.writeFileSync(file,input);
  const b=new Backend(binary);t.after(()=>b.dispose());const meta=await b.request('open',{path:file});assert.equal(meta.total,1701);assert.equal(meta.signals.length,1500);
  const tail=await b.request('search',{query:'',offset:1500,limit:512});assert.equal(tail.offset,1500);assert.equal(tail.total,1701);assert.equal(tail.signals.length,201);assert.equal(tail.signals.at(-1).name,'alias');
  const scopePage=await b.request('scopeSignals',{query:'top',offset:1600,limit:512});assert.equal(scopePage.total,1701);assert.equal(scopePage.signals.length,101);assert.ok(scopePage.signals.every(s=>s.scope==='top'));assert.equal((await b.request('scopeSignals',{query:'missing',offset:0})).total,0);
  const descriptors=Array.from({length:1700},(_,i)=>({id:`v${i}`,scope:'top',name:`sig_${i}`}));descriptors.push({id:'v0',scope:'top',name:'alias'});
  const restored=await b.request('describe',{descriptors});assert.equal(restored.length,1701);assert.equal(restored.at(-1).name,'alias');
  const filtered=await b.request('search',{query:'top.alias',offset:0,limit:512});assert.equal(filtered.total,1);assert.equal(filtered.signals[0].id,'v0');
});

test('RV32A FSDB preserves deferred declarations and the hart transition', {
  skip: !process.env.WAVE_TEST_RV32A_FSDB,
}, async t => {
  const backend = new Backend(fsdbBinary, fsdbOptions);
  t.after(() => backend.dispose());
  const waveform = await backend.request('open', { path: process.env.WAVE_TEST_RV32A_FSDB });
  assert.equal(waveform.scale, '1ps');
  assert.equal(waveform.total, 180);
  const scope = 'rv32a_atomic_adapter_tb.dut';
  assert.equal(waveform.signals.find(signal => signal.scope === scope && signal.name === 'tl_h_o[113:0]')?.width, 114);
  const hart = waveform.signals.find(signal => signal.scope === scope && signal.name === 'hart_q[0:0]');
  assert.ok(hart);
  const observations = await backend.request('query', {
    signals: [hart.id], start: '245000', end: '280000', limit: 100,
  });
  assert.deepEqual(observations[hart.id].events.at(-1), ['275000', '1']);
});

test('VCS FSDB preserves selectively dumped scalars and packed ranges', {
  skip: !process.env.WAVE_TEST_SELECTED_FSDB,
}, async t => {
  const backend = new Backend(fsdbBinary, fsdbOptions);
  t.after(() => backend.dispose());
  const metadata = await backend.request('open', { path: process.env.WAVE_TEST_SELECTED_FSDB });
  const signals = metadata.signals.filter(signal => signal.scope === 'selective_tb');
  assert.deepEqual(signals.map(({ name, width }) => [name, width]).sort(), [
    ['bus[7:4]', 4], ['crossed[-1:2]', 4], ['scalar', 1],
  ]);
  const response = await backend.request('query', {
    signals: signals.map(({ id }) => id), start: '0', end: '3', limit: 20,
  });
  const expected = { 'bus[7:4]': '1010', 'crossed[-1:2]': '1001', scalar: '1' };
  for (const { name, id } of signals)
    assert.deepEqual(response[id].events.at(-1), ['3', expected[name]]);
});

test('VCS FSDB retains paths and samples on connections with two-state port conversion', {
  skip: !process.env.WAVE_TEST_PACKED_CONVERSION_FSDB,
}, async t => {
  const backend = new Backend(fsdbBinary, fsdbOptions);
  t.after(() => backend.dispose());
  const waveform = await backend.request('open', { path: process.env.WAVE_TEST_PACKED_CONVERSION_FSDB });
  const byPath = new Map(waveform.signals.map(({ scope, name, id }) => [`${scope}.${name}`, id]));
  const expectations = [
    ['mixed[1:0]', '1x'], ['convert.a[1:0]', '10'], ['signed_bus[7:0]', '00111000'],
    ['whole_widen_signed.a[3:0]', '1110'], ['whole_widen_unsigned.a[3:0]', '0010'],
    ['whole_signed_output[3:0]', '1110'], ['whole_narrow.a[1:0]', '01'],
    ['whole_convert.a[1:0]', '10'],
  ];
  const ids = expectations.map(([name]) => byPath.get(`port_slice_tb.${name}`));
  assert.ok(ids.every(Boolean));
  const observations = await backend.request('query', { signals: ids, start: '5', end: '5' });
  assert.deepEqual(ids.map(id => observations[id].events.at(-1)[1]), expectations.map(([, bits]) => bits));
  const dynamic = byPath.get('port_slice_tb.dynamic_bit');
  const history = await backend.request('query', { signals: [dynamic], start: '5', end: '7' });
  assert.deepEqual(history[dynamic].events.slice(-3), [['5', '1'], ['6', '0'], ['7', 'x']]);
  for (const [signal, samples] of [
    ['ascending_plus', ['10', '00', 'xx', '0x', '00']],
    ['ascending_minus', ['01', '10', 'xx', '00', 'x0']],
    ['descending_plus', ['0x', '11', 'xx', 'x1', 'x1']],
    ['descending_minus', ['10', '11', 'xx', '10', '0x']],
  ]) {
    const id = byPath.get(`port_slice_tb.${signal}[1:0]`);
    assert.ok(id, signal);
    const values = [];
    for (let tick = 5; tick <= 9; tick++) {
      const point = await backend.request('query', { signals: [id], start: String(tick), end: String(tick) });
      values.push(point[id].events.at(-1)[1]);
    }
    assert.deepEqual(values, samples, signal);
  }
});

test('VCS FSDB evaluates port expressions with four-state constants and two-state conversions', {
  skip: !process.env.WAVE_TEST_COMPLEX_PORTS_FSDB,
}, async t => {
  const backend = new Backend(fsdbBinary, fsdbOptions);
  t.after(() => backend.dispose());
  const waveform = await backend.request('open', { path: process.env.WAVE_TEST_COMPLEX_PORTS_FSDB });
  const expected = {
    'concat_out[3:0]': ['11z1', '11z0', '0zz0'],
    'binary_out[3:0]': ['1001', '10x1', '10x1'],
    'mixed_out[3:0]': ['1100', '11x1', 'z1x1'],
    'signed_out[3:0]': ['1110', '1110', '1111'],
    'compact_out[2:0]': ['1z1', '1z0', 'zz0'],
    'coerced_out[3:0]': ['1000', '0100', '0000'],
    'mixed_literal_out[3:0]': ['10x1', 'x1x1', 'x0x0'],
    'ordered_out[4:0]': ['11010', '10000', '10001'],
    'repeated[3:0]': ['1111', '0000', '0000'],
    'repeated_slice[7:0]': ['11z111z1', '11z011z0', '0zz00zz0'],
    'zero_repeat[1:0]': ['11', '10', '10'],
    'complex_bit': ['1', '0', 'x'],
    'complex_up[1:0]': ['11', '0x', 'xx'],
    'complex_down[1:0]': ['x1', '11', 'xx'],
  };
  const signals = waveform.signals.filter(({ scope, name }) => scope === 'expr_tb' && name in expected);
  assert.equal(signals.length, Object.keys(expected).length);
  const actual = Object.fromEntries(signals.map(({ name }) => [name, []]));
  for (const tick of ['5', '6', '7']) {
    const observations = await backend.request('query', { signals: signals.map(({ id }) => id), start: tick, end: tick });
    for (const {name, id} of signals) actual[name].push(observations[id].events.at(-1)[1]);
  }
  assert.deepEqual(actual, expected);
});

test('VCS FSDB binds negative generate indices and samples distinct iteration outputs', {
  skip: !process.env.WAVE_TEST_GENERATE_PORTS_FSDB,
}, async t => {
  const { findSignal, kdbGenerateScope } = require('../dist/signal-lookup');
  const backend = new Backend(fsdbBinary, fsdbOptions);
  t.after(() => backend.dispose());
  await backend.request('open', { path: process.env.WAVE_TEST_GENERATE_PORTS_FSDB });
  const top = 'generate_ports_tb';
  const aliases = [
    ['output_bus', ['000010', '000100', '100000', '100000']],
    ['shifted_bus', ['001', '010', '000', '100']],
    ['lanes[-1].outer.cell_inst.q', ['1', '0', '0', '0']],
  ];
  const signals = [];
  for (const [name] of aliases) signals.push(await findSignal(backend, top + '.' + name, '.'));
  assert.equal(kdbGenerateScope(signals[2].scope), top + '.lanes[-1].outer.cell_inst');
  assert.match(signals[2].scope, /\\lanes \[-1\]/);
  for (const [index, tick] of ['5', '6', '7', '8'].entries()) {
    const values = await backend.request('query', { signals: signals.map(signal => signal.id), start: tick, end: tick });
    assert.deepEqual(signals.map(signal => values[signal.id].events.at(-1)[1]), aliases.map(([, expected]) => expected[index]));
  }
});

test('VCS FSDB samples split instance-array ports and composite outputs', {
  skip: !process.env.WAVE_TEST_ARRAY_PORTS_FSDB,
}, async t => {
  const backend = new Backend(fsdbBinary, fsdbOptions);
  t.after(() => backend.dispose());
  const waveform = await backend.request('open', { path: process.env.WAVE_TEST_ARRAY_PORTS_FSDB });
  const byPath = new Map(waveform.signals.map(({ scope, name, id }) => [`${scope}.${name}`, id]));
  const expectations = [
    ['desc[3].i[1:0]', '10'], ['desc[2].i[1:0]', '01'],
    ['asc[-1].i[1:0]', '01'], ['asc[0].i[1:0]', '10'],
    ['slices[1].i[1:0]', '11'], ['slices[0].i[1:0]', '11'],
    ['desc_out[5:8]', '1001'], ['asc_out[9:6]', '0110'], ['slice_out[7:0]', '00111100'],
    ['literal_split[3:0]', '1001'], ['literal_broadcast[3:0]', '1010'],
  ];
  const ids = expectations.map(([name]) => byPath.get(`arrays_tb.${name}`));
  assert.ok(ids.every(Boolean));
  const observations = await backend.request('query', { signals: ids, start: '5', end: '5' });
  assert.deepEqual(ids.map(id => observations[id].events.at(-1)[1]), expectations.map(([, bits]) => bits));
});

test('Rust virtual signals: merge, four states, concat order, source identity, cache and restore metadata',async t=>{
 const backend=new Backend(path.resolve(__dirname,'../bin/wave-backend'));t.after(()=>backend.dispose());const meta=await backend.request('open',{path:path.resolve(__dirname,'../examples/demo.vcd')});
 const clk=meta.signals.find(s=>s.name==='clk'),valid=meta.signals.find(s=>s.name==='valid'),bus=meta.signals.find(s=>s.name==='data[7:0]');
 const input=s=>({id:s.id,scope:s.scope,name:s.name,bitOffset:null});
 const joined=await backend.request('defineVirtual',{name:'joined',definition:{op:'concat',inputs:[input(clk),input(valid)]}});assert.equal(joined.signal.width,2);
 const op=await backend.request('defineVirtual',{name:'masked',definition:{op:'and',inputs:[input(bus),input(valid)]}});
 const result=await backend.request('query',{signals:[joined.signal.id,op.signal.id],start:'0',end:'50',limit:100});assert.deepEqual(result[joined.signal.id].events.find(e=>e[0]==='25'),['25','11']);assert.deepEqual(result[op.signal.id].events[0],['0','00000000']);
 const before=await backend.request('cacheStats');await backend.request('query',{signals:[joined.signal.id],start:'0',end:'50',limit:100});assert.equal((await backend.request('cacheStats')).reads,before.reads);
 const described=await backend.request('describe',{descriptors:[joined.signal]});assert.equal(described[0].definition.op,'concat');await assert.rejects(backend.request('defineVirtual',{definition:{op:'not',inputs:[{...input(bus),name:'wrong'}]}}),/identity/);
 const nested=await backend.request('defineVirtual',{definition:{op:'not',inputs:[input(joined.signal)]}});assert.ok(nested.definitions.find(d=>d.id===joined.signal.id));assert.equal(nested.definitions.at(-1).id,nested.signal.id);await backend.request('open',{path:path.resolve(__dirname,'../examples/demo.vcd')});await require('../dist/view-state').registerVirtuals(backend,nested.definitions);const replay=await backend.request('query',{signals:[nested.signal.id],start:'25',end:'25',limit:100});assert.deepEqual(replay[nested.signal.id].events,[['25','00']]);
});

test('native FSDB virtual NOT matches source four-state value',{skip:!process.env.WAVE_TEST_FSDB},async t=>{
 const b=new Backend(fsdbBinary,fsdbOptions);t.after(()=>b.dispose());const m=await b.request('open',{path:process.env.WAVE_TEST_FSDB});const s=m.signals.find(s=>s.supported&&s.width===1&&s.name.includes('clk'));assert.ok(s);const d=await b.request('defineVirtual',{name:'inverted_clk',definition:{op:'not',inputs:[{id:s.id,scope:s.scope,name:s.name,bitOffset:null}]}});const time=String(Math.floor(Number(m.end)/2));const r=await b.request('query',{signals:[s.id,d.signal.id],start:time,end:time,limit:100});const raw=r[s.id].events.at(-1)[1].toLowerCase();assert.equal(r[d.signal.id].events.at(-1)[1],raw==='0'?'1':raw==='1'?'0':'x');
});
