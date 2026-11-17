// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {Backend}=require('../dist/backend');
const binary=path.resolve(__dirname,'../bin/wave-backend');
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
  const b=new Backend(binary,{onLog:()=>{}});t.after(()=>b.dispose());
  const m=await b.request('open',{path:process.env.WAVE_TEST_FSDB});
  assert.equal(m.backend,'native-fsdb');assert.ok(m.signals.length>0);assert.ok(BigInt(m.end)>=BigInt(m.start));
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
 const b=new Backend(binary);t.after(()=>b.dispose());const m=await b.request('open',{path:process.env.WAVE_TEST_FSDB});const s=m.signals.find(s=>s.supported&&s.width===1&&s.name.includes('clk'));assert.ok(s);const d=await b.request('defineVirtual',{name:'inverted_clk',definition:{op:'not',inputs:[{id:s.id,scope:s.scope,name:s.name,bitOffset:null}]}});const time=String(Math.floor(Number(m.end)/2));const r=await b.request('query',{signals:[s.id,d.signal.id],start:time,end:time,limit:100});const raw=r[s.id].events.at(-1)[1].toLowerCase();assert.equal(r[d.signal.id].events.at(-1)[1],raw==='0'?'1':raw==='1'?'0':'x');
});
