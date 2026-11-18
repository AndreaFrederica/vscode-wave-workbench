// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

const {test}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {identifiers,resolveSelection}=require('../dist/rtl-selection'),{Backend}=require('../dist/backend');
const {findRtlSignals, readSignalsAt} = require('../dist/signal-lookup');
const {codeOnly, portConnection} = require('../dist/rtl-selection');
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

test('RTL hover resolves separately dumped array members in the selected instance', async () => {
  const scope = 'tb.id_stage_i';
  const member = (id, name, instance = scope) => ({id, name, scope: instance, supported: true, width: 32});
  const records = [
    member('2', 'operands[2][31:0]'),
    member('1', 'operands[1][31:0]'),
    member('0', 'operands[0][31:0]'),
    member('other', 'operands[0][31:0]', 'tb.alt.id_stage_i'),
    member('different', 'operands_copy[0][31:0]'),
  ];
  const backend = {
    async request(action, args) {
      if (action === 'search') {
        const signals = records.filter((record) => (record.scope + '.' + record.name).includes(args.query));
        return {signals, total: signals.length};
      }
      assert.equal(action, 'query');
      assert.equal(args.start, '458002');
      assert.equal(args.end, args.start);
      return Object.fromEntries(args.signals.map((id) => [id, {events: [[args.start, id === '0' ? '1' : '0']]}]));
    },
  };
  const group = await findRtlSignals(backend, scope, 'operands');
  assert.deepEqual(group.signals.map(({id}) => id), ['0', '1', '2']);
  assert.equal(group.partial, false);
  assert.deepEqual(await readSignalsAt(backend, group.signals, 458002), ['1', '0', '0']);
  const element = await findRtlSignals(backend, scope, 'operands[1]');
  assert.deepEqual(element.signals.map(({id}) => id), ['1']);
  const bit = await findRtlSignals(backend, scope, 'operands[0][0]');
  assert.equal(bit.signals[0].bitOffset, 0);
  assert.deepEqual(await readSignalsAt(backend, bit.signals, 458002), ['1']);
});

test('RTL hover recognizes both endpoints of a named port connection', () => {
  const text = 'child #(.P(32)) u_child (\n  .data_o(bus[0]),\n  .lat_i(lat + 1)\n);';
  function at(name) {
    const start = text.indexOf(name);
    return portConnection(text, codeOnly(text), start, start + name.length);
  }
  const data = {instance: 'u_child', instanceOffset: text.indexOf('u_child'), port: 'data_o', actual: 'bus[0]'};
  assert.deepEqual(at('data_o'), {...data, portAtCursor: true});
  assert.deepEqual(at('bus'), {...data, portAtCursor: false});
  assert.equal(at('lat +'), undefined);
  assert.equal(at('lat_i').actual, undefined);
  assert.equal(at('P'), undefined);
});
