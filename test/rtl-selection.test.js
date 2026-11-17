// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

const {test}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {identifiers,resolveSelection}=require('../dist/rtl-selection'),{Backend}=require('../dist/backend');
test('large RTL block extracts references and excludes comments, strings, literals, keywords and named port labels',()=>{
 const code=`logic [7:0] data; assign valid = en ? data[0] : fallback;
 always_ff @(posedge clk) if (rst) data <= 8'hA5;
 u_thing u_i(.clk_i(clk), .data_i(data[idx]));
 // should_not_appear
 $display("ignore_me", valid); /* nor_this */`;
 assert.deepEqual(identifiers(code),['data','valid','en','data[0]','fallback','clk','rst','u_thing','idx']);assert.deepEqual(identifiers('a + a + b[15:8]'),['a','b']);const full='/* clk hidden */ assign out = clk;';const masked=require('../dist/rtl-selection').codeOnly(full);assert.deepEqual(identifiers(masked.slice(3)),['out','clk']);
});
test('bulk native matching: exact scope, bit projection, relative hierarchy, ambiguity and no arbitrary substring',async t=>{
 const backend=new Backend(path.resolve(__dirname,'../bin/wave-backend'));t.after(()=>backend.dispose());await backend.request('open',{path:path.resolve(__dirname,'../examples/demo.vcd')});
 const r=await resolveSelection(backend,identifiers('clk + data[7] + data[0] + valid + unknown + cl'), 'tb.dut');assert.deepEqual(r.signals.map(s=>s.name),['clk','data[7:0]','data[7:0]','valid']);assert.deepEqual(r.signals.slice(1,3).map(s=>s.bitOffset),[7,0]);assert.deepEqual(r.missing,['unknown','cl']);assert.equal(r.truncated,false);
 const relative=await resolveSelection(backend,['dut.clk'],'tb');assert.equal(relative.signals[0].scope,'tb.dut');const wrong=await resolveSelection(backend,['clk'],'some_other_scope');assert.equal(wrong.signals.length,0);
});
