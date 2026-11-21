// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {TclRunner}=require('../dist/tcl');const {formatValue,quote}=require('../dist/commands');
test('real Tcl: variables, loops, nested lists, source, persistence, errors and isolation',async t=>{
  const seen=[];const runner=new TclRunner(async(name,args)=>{seen.push({name,args});if(name==='wvZoom'&&args[0].value==='bad')throw Error('bad time');return '1';});t.after(()=>runner.dispose());
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wave-tcl-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  fs.writeFileSync(path.join(dir,'signals.tcl'),'set w [wvCreateWindow]; foreach sig {clk data} {wvAddSignal -win $w -group [list {MAC group} [list $sig]]}; set sum [expr {3+4}]');
  assert.equal(await runner.run('source signals.tcl',dir),'7');assert.equal(await runner.run('expr {$sum+1}',dir),'8');
  assert.equal(seen[1].args[3].items[0].value,'MAC group');
  assert.equal(seen[1].args[3].items[1].items[0].value,'clk');
  await assert.rejects(runner.run('wvZoom bad 10',dir),/bad time/);
  await assert.rejects(runner.run('wvNonexistent',dir),/Unsupported Verdi/);
  await assert.rejects(runner.run('exec touch should-not-exist',dir),/Unsupported Verdi/);
  assert.equal(await runner.run('set sum',dir),'7');
  assert.equal(await runner.isComplete('expr {'),false);
  assert.equal(await runner.isComplete('expr {\n  $sum + 1\n}'),true);
  assert.equal(await runner.run('set sum',dir),'7');
  const dangerous='a [$sum] $var "x" \\ {hello}\nend';assert.equal(await runner.run('set literal '+quote(dangerous),dir),dangerous);
});
test('value formats preserve bit order, signed values and partial unknown nibbles',()=>{
  assert.equal(formatValue('11110000',8,'2Com'),'-16');assert.equal(formatValue('11110000',8,'Hex'),'f0');assert.equal(formatValue('1',8,'Hex',true),'01');assert.equal(formatValue('1010xxxx',8,'Hex'),'ax');assert.equal(formatValue('zzzz',8,'Bin',true),'zzzzzzzz');
});
