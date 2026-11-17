const {projectFile}=require('./fixtures');
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');
const {KdbSession,mapPrefix}=require('../dist/kdb');
const {Backend}=require('../dist/backend');
test('explicit path mappings use longest prefix and keep unrelated paths',()=>{
  assert.equal(mapPrefix('/old/src/a.sv',{'/old':'/new','/old/src':'/snapshot'}),'/snapshot/a.sv');
  assert.equal(mapPrefix('tb.dut.clk',{'tb':'top','tb.dut':'top.core'}),'top.core.clk');
  assert.equal(mapPrefix('/older/a.sv',{'/old':'/new'}),'/older/a.sv');
});
test('real KDB: hierarchy, signal declaration, instance, definition and FSDB correlation',{skip:!process.env.WAVE_TEST_KDB},async t=>{
  const session=new KdbSession(path.resolve(__dirname,'../bin/wave-backend'),process.env.VERDI_HOME);
  const wave=new Backend(path.resolve(__dirname,'../bin/wave-backend'));t.after(()=>{session.dispose();wave.dispose();});
  const result=await session.open(process.env.WAVE_TEST_KDB);assert.equal(result.backend,'native-npi-kdb');
  const roots=await session.children();assert.ok(roots.some(r=>r.fullname==='cv32e40p_mac_trace_tb'));
  const core='cv32e40p_mac_trace_tb.dut.u_core.u_core.core_i';
  assert.equal(await session.parent(core),'cv32e40p_mac_trace_tb.dut.u_core.u_core');
  assert.ok((await session.children('cv32e40p_mac_trace_tb.dut.u_core.u_core')).some(c=>c.fullname===core));
  const signal=await session.resolve(core+'.clk_i');assert.equal(signal.instance,core);assert.equal(signal.line,45);assert.match(signal.file,/cv32e40p_core\.sv$/);
  assert.match(fs.readFileSync(signal.file,'utf8').split('\n')[signal.line-1],/clk_i/);
  const inst=await session.resolve(signal.instance);assert.equal(inst.line,112);assert.equal(inst.definitionLine,31);
  assert.match(fs.readFileSync(inst.file,'utf8').split('\n')[inst.line-1],/core_i/);
  assert.match(fs.readFileSync(inst.definitionFile,'utf8').split('\n')[inst.definitionLine-1],/module cv32e40p_core/);
  await assert.rejects(session.resolve(core+'.does_not_exist'),/not found/);
  await wave.request('open',{path:path.resolve(process.env.WAVE_TEST_KDB,'../waves.fsdb')});
  const matches=await wave.request('search',{query:core+'.clk_i'});assert.ok(matches.signals.length);
  const dumped=matches.signals.find(s=>s.scope+'.'+s.name===core+'.clk_i');assert.ok(dumped);
  const declaration=await session.resolve(dumped.scope+'.'+dumped.name);assert.equal(declaration.file,signal.file);assert.equal(declaration.line,signal.line);
});

test('full-chip FPU hierarchy excludes interfaces and lazily resolves source',{skip:!process.env.WAVE_TEST_FPU_RUN},async t=>{
  const settings=JSON.parse(fs.readFileSync(projectFile('.vscode/settings.json'),'utf8'));
  const session=new KdbSession(path.resolve(__dirname,'../bin/wave-backend'),process.env.VERDI_HOME);t.after(()=>session.dispose());await session.open(settings['waveWorkbench.kdbPath']);
  const roots=await session.children();assert.ok(roots.some(n=>n.fullname==='tb'));assert.ok(roots.every(n=>n.kind==='npiModule'));assert.ok(roots.every(n=>!n.file&&!n.definitionFile));
  const before=session.backend.sequence;assert.strictEqual(await session.children(),roots);assert.equal(session.backend.sequence,before);
  const tb=await session.children('tb');assert.ok(tb.some(n=>n.fullname==='tb.dut'&&n.module==='chip_earlgrey_asic'));assert.ok(!tb.some(n=>n.fullname.includes('alert_if[')));
  const all=await session.children('tb',true);const iface=all.find(n=>n.fullname==='tb.alert_if[0]');assert.equal(iface.kind,'npiInterface');assert.equal(iface.module,'alert_esc_if');
  const top=await session.children('tb.dut.top_earlgrey');assert.ok(top.some(n=>n.fullname.endsWith('.u_aes')));assert.ok(top.every(n=>['npiModule','npiGenScope','npiModuleArray','npiProgram'].includes(n.kind)));
  const parent='tb.dut.top_earlgrey.u_cv32e40p_dsp.u_core.u_core';const generated=(await session.children(parent)).find(n=>n.fullname===parent+'.fpu_gen');assert.equal(generated.kind,'npiGenScope');assert.ok((await session.children(generated.fullname)).some(n=>n.fullname.endsWith('.fp_wrapper_i')));
  const source=await session.resolve('tb.dut.top_earlgrey');assert.ok(fs.existsSync(source.definitionFile));assert.ok(source.definitionLine>0);
});
