// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

const {projectFile}=require('./fixtures');
async function clickTool(page,selector){const target=page.locator(selector),parent=target.locator('xpath=ancestor::details[contains(@class,"toolMenu")]');if(await parent.count()&&!await parent.evaluate(e=>e.open)){await parent.locator('summary').click();}await target.click();}
const {test,expect}=require('@playwright/test');
const path=require('node:path'),fs=require('node:fs'),os=require('node:os');
const {Backend}=require('../dist/backend');const {TclRunner}=require('../dist/tcl');const {WaveCommands,quote}=require('../dist/commands');const {KdbSession}=require('../dist/kdb');
async function setup(page,filename,kdbPath){
  const backend=new Backend(path.resolve(__dirname,'../bin/wave-backend'));const pending=new Map();let sequence=0,queryDelay=0;const logs=[],queries=[],catalogRequests=[];
  const viewer={backend,uri:{fsPath:filename},meta:await backend.request('open',{path:filename})};
  const send=m=>page.evaluate(m=>window.dispatchEvent(new MessageEvent('message',{data:m})),m);
  viewer.ui=(action,payload)=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});send({type:'ui',id,action,payload}).catch(reject);});
  if(kdbPath){viewer.kdb=new KdbSession(path.resolve(__dirname,'../bin/wave-backend'),process.env.VERDI_HOME);await viewer.kdb.open(kdbPath);}
  const engine=new WaveCommands({getViewer:()=>viewer,open:async file=>{if(path.resolve(file)!==filename)throw Error('Unexpected test open');},scope:async name=>{await send({type:'kdbHierarchy',scope:name,children:await viewer.kdb.children(name)});}});
  const runner=new TclRunner((name,args,dir)=>{viewer.scriptDirectory=dir;return engine.execute(name,args);},{log:text=>logs.push(text)});
  await page.exposeFunction('bridge',async m=>{
    if(m.type==='ready'){await send({type:'metadata',...viewer.meta,title:path.basename(filename),vide:'1.2.5'});}
    else if(m.type==='uiResult'){const p=pending.get(m.id);if(p){pending.delete(m.id);if(m.error)p.reject(new Error(m.error));else p.resolve(m.result);}}
    else if(m.type==='query'){queries.push(m);if(queryDelay)await new Promise(r=>setTimeout(r,queryDelay));await send({type:'data',request:m.request,result:await backend.request('query',{signals:m.signals,start:String(m.start),end:String(m.end),limit:m.limit||20000})});}
    else if(m.type==='defineVirtual')await send({type:'virtualCreated',...await backend.request('defineVirtual',{definition:m.definition,name:m.name})});
    else if(m.type==='search'){catalogRequests.push(m);await send({type:'searchResult',request:m.request,...await backend.request('search',{query:m.query,offset:m.offset,limit:m.limit})});}
    else if(m.type==='scopeSignals')await send({type:'scopeSignals',request:m.request,...await backend.request('scopeSignals',{query:m.scope,offset:m.offset,limit:512})});
    else if(m.type==='executeTcl'){try{const result=await runner.run(m.script,path.dirname(filename));await send({type:'commandLog',text:result||'OK'});}catch(e){await send({type:'commandLog',text:'ERROR: '+e.message});}}
  });
  await page.addInitScript(()=>{window.acquireVsCodeApi=()=>({getState:()=>null,setState(s){window.__savedWaveState=s;},postMessage:m=>window.bridge(m)});});
  await page.route('http://wave.test/**',async route=>{const name=new URL(route.request().url()).pathname.slice(1)||'index.html';if(!['index.html','wave.js','wave.css'].includes(name)){await route.abort();return;}let body=fs.readFileSync(path.resolve(__dirname,name.endsWith('.js')?'../dist/webview':'../media',name),'utf8');if(name==='index.html')body=body.replaceAll('{{csp}}','http://wave.test').replaceAll('{{nonce}}','testnonce').replace('{{css}}','/wave.css').replace('{{script}}','/wave.js');await route.fulfill({body,contentType:name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html'});});
  await page.goto('http://wave.test/');await expect(page.locator('#backend')).toContainText(viewer.meta.backend);
  return {viewer,logs,queries,catalogRequests,running:()=>!!runner.pending,setQueryDelay(ms){queryDelay=ms;},run:(script,directory)=>runner.run(script,directory||path.dirname(filename)),dispose(){runner.dispose();backend.dispose();viewer.kdb?.dispose();}};
}
test('real Tcl and wave UI: groups, units, values, markers, transition, export/replay, errors',async({page})=>{
  const env=await setup(page,path.resolve(__dirname,'../examples/demo.vcd'));
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wave-save-test-'));
  try{
    await clickTool(page,'[data-action="console"]');
    await page.locator('#commandInput').fill('set w [wvCreateWindow]; foreach s {clk data[7:0]} {wvAddSignal -win $w -group [list MAC [list /tb/dut/$s]]}; wvSetCursor 20; wvSetMarker -name EX 30');
    await page.locator('#commandForm button').click();await expect(page.locator('.row')).toHaveCount(2);await expect(page.locator('#commandLog')).not.toContainText('ERROR');
    await expect(page.locator('.row .group').first()).toHaveText('MAC');await expect.poll(()=>env.running()).toBe(false);
    expect(await env.run('wvGetSigValueByTime {/tb/dut/data[7:0]} -time 20 -format Hex')).toBe('2a');
    expect(await env.run('wvSetWindowTimeUnit 0.001 us; wvGetWindowTimeUnit')).toBe('0.001 us');
    await env.run('wvSetRadix -format Dec {/tb/dut/data[7:0]}; wvSelectSignal /tb/dut/clk');
    expect(await env.run('wvSearchNext')).toBe('1 25');
    await env.run('wvSetWindowTimeUnit 10 ns; wvSetCursor 2');await expect(page.locator('#cursorAInput')).toHaveValue('2');expect(await env.run('wvGetSigValueByTime {/tb/dut/data[7:0]} -time 2')).toBe('2a');await env.run('wvSetWindowTimeUnit 1 ns; wvSetCursor 25');
    await env.run('wvZoomCursorMarker');await expect(page.locator('#range')).toContainText('25');
    const saved=path.join(dir,'saved.tcl');await env.run('wvSaveSignal '+quote(saved));expect(fs.readFileSync(saved,'utf8')).toContain('wvAddSignal -group');
    await env.run('wvDeleteSignal /tb/dut/clk {/tb/dut/data[7:0]}');await expect(page.locator('.row')).toHaveCount(0);
    await env.run('wvRestoreSignal '+quote(saved));await expect(page.locator('.row')).toHaveCount(2);await expect(page.locator('.row .group').first()).toHaveText('MAC');
    await expect(page.locator('#cursorAInput')).toHaveValue('25');
    await expect(env.run('wvRestoreSignal '+quote(path.join(dir,'missing.tcl')))).rejects.toThrow('Signal script not found');await expect(page.locator('.row')).toHaveCount(2);
    await expect(env.run('wvSaveSignal '+quote(path.join(dir,'native.sav')))).rejects.toThrow('Native Verdi .sav');expect(fs.existsSync(path.join(dir,'native.sav'))).toBe(false);
    await page.locator('#commandInput').fill('wvUnsupportedFeature');await page.locator('#commandForm button').click();await expect(page.locator('#commandLog')).toContainText('Unsupported Verdi/nWave command');
  }finally{env.dispose();fs.rmSync(dir,{recursive:true,force:true});}
});
test('existing MAC Tcl script runs against native FSDB and KDB',{timeout:120000},async({page})=>{
  test.skip(!process.env.WAVE_TEST_KDB,'Set WAVE_TEST_KDB for real Verdi script compatibility');
  const run=fs.realpathSync(path.resolve(process.env.WAVE_TEST_KDB,'..'));
  const env=await setup(page,path.join(run,'waves.fsdb'),process.env.WAVE_TEST_KDB);
  try{
    const result=await env.run('set ::env(CV32E40P_MAC_RUN_DIR) '+quote(run)+'; source '+quote(projectFile('doc/cv32e40p_mac_trace/verdi_cv32e40p_mac.tcl')),run);
    expect(env.logs.join('\n')).toContain('MAC_VERDI_READY');expect(env.logs.join('\n')).toContain('WAVE_CHECK');expect(result).toBe('');
    const count=Number(/MAC_VERDI_READY: (\d+) signals/.exec(env.logs.join('\n'))[1]);await expect(page.locator('#tracks')).toHaveAttribute('data-total',String(count));expect(await page.locator('.row').count()).toBeLessThanOrEqual(count);
    await expect(page.locator('#kdbState')).toContainText('mult_i');
    await expect(page.locator('#status')).toContainText(count+' 个信号',{timeout:30000});
    await page.screenshot({path:'test-results/nwave-mac-script.png'});
  }finally{env.dispose();}
});

test('10000 signals: viewport DOM/canvas/query bounds, scroll alignment, Rust cache reuse and paged catalogue',async({page})=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wave-virtual-test-')),file=path.join(dir,'many.vcd');
  let vcd='$timescale 1 ns $end\n$scope module top $end\n';
  for(let i=0;i<10000;i++)vcd+=`$var wire 8 v${i} sig_${i} [7:0] $end\n`;
  vcd+='$upscope $end\n$enddefinitions $end\n#0\n';for(let i=0;i<10000;i++)vcd+=`b${(i%256).toString(2)} v${i}\n`;
  vcd+='#50\n';for(let i=0;i<10000;i++)vcd+=`b${((i+1)%256).toString(2)} v${i}\n`;vcd+='#100\n';fs.writeFileSync(file,vcd);
  const env=await setup(page,file);
  try{
    const all=[];for(let offset=0;offset<10000;offset+=1500)all.push(...(await env.viewer.backend.request('search',{query:'',offset,limit:1500})).signals);
    await env.viewer.ui('addSignals',{signals:all});await expect(page.locator('#tracks')).toHaveAttribute('data-total','10000');
    await expect(page.locator('.row[data-index="0"] .value')).toHaveText('00');
    expect(await page.locator('.row').count()).toBeLessThan(50);
    const sizes=await page.evaluate(()=>({canvas:document.querySelector('canvas').clientHeight,viewport:document.querySelector('#tracks').clientHeight,extent:document.querySelector('#tracks').scrollHeight}));
    expect(sizes.canvas).toBeLessThanOrEqual(sizes.viewport+1);expect(sizes.extent).toBeGreaterThan(300000);
    expect(env.queries.every(q=>q.signals.length<=64)).toBe(true);expect(env.queries[0].signals.length).toBeLessThan(50);expect(env.queries.flatMap(q=>q.signals)).not.toContain('v9999');
    await page.locator('#tracks').evaluate(e=>{e.scrollTop=e.scrollHeight;});
    await expect(page.locator('.row[data-index="9999"] .value')).toHaveText('0F');
    const before=await env.viewer.backend.request('cacheStats');
    await page.locator('#tracks').evaluate(e=>{e.scrollTop=0;});await expect(page.locator('.row[data-index="0"] .value')).toHaveText('00');
    const after=await env.viewer.backend.request('cacheStats');expect(after.hits).toBeGreaterThan(before.hits);expect(after.reads).toBe(before.reads);expect(after.bytes).toBeLessThanOrEqual(after.budget);fs.mkdirSync('test-results',{recursive:true});fs.writeFileSync('test-results/virtual-metrics.json',JSON.stringify({selected:10000,initialRows:await page.locator('.row').count(),...sizes,readsBeforeReturn:before.reads,readsAfterReturn:after.reads,hitsAfterReturn:after.hits,cacheBytes:after.bytes,cacheBudget:after.budget},null,2));
    // A request for an old viewport/window must not populate the latest viewport.
    await env.run('wvZoom 0 40');await expect(page.locator('.row[data-index="0"] .value')).toHaveText('00');
    env.setQueryDelay(200);await page.locator('#tracks').evaluate(e=>{e.scrollTop=120000;});
    await expect.poll(()=>env.queries.some(q=>q.signals.includes('v3750'))).toBe(true);
    await env.run('wvZoom 60 100; wvSetCursor 75');await page.locator('#tracks').evaluate(e=>{e.scrollTop=e.scrollHeight;});
    await expect(page.locator('.row[data-index="9999"] .value')).toHaveText('10');env.setQueryDelay(0);
    // More than 64 visible rows are split into transport batches, not rejected.
    await page.setViewportSize({width:1440,height:3000});await page.locator('#tracks').evaluate(e=>{e.scrollTop=0;});
    await expect(page.locator('.row[data-index="60"] .value')).toHaveText('3D');expect(env.queries.some(q=>q.signals.length===64)).toBe(true);expect(env.queries.every(q=>q.signals.length<=64)).toBe(true);
    await page.setViewportSize({width:1440,height:850});
    await page.locator('#catalogAll').click();await expect(page.locator('#count')).toContainText('10000 个匹配信号');
    await page.locator('#tree').evaluate(e=>{e.scrollTop=e.scrollHeight;});
    await expect(page.locator('.leaf').filter({hasText:'top.sig_9999[7:0]'})).toHaveCount(1);
    expect(await page.locator('.leaf').count()).toBeLessThan(60);expect(env.catalogRequests.some(r=>r.offset>1500)).toBe(true);
    const scrollBefore=await page.locator('#tracks').evaluate(e=>e.scrollTop),windowBefore=await env.viewer.ui('snapshot'),canvasBox=await page.locator('canvas').boundingBox();await page.mouse.move(canvasBox.x+80,canvasBox.y+100);await page.mouse.wheel(0,120);await expect.poll(()=>page.locator('#tracks').evaluate(e=>e.scrollTop)).toBeGreaterThan(scrollBefore);const windowAfter=await env.viewer.ui('snapshot');expect(windowAfter.start).toBe(windowBefore.start);expect(windowAfter.end).toBe(windowBefore.end);
    await page.screenshot({path:'test-results/virtual-10000.png'});
  }finally{env.dispose();fs.rmSync(dir,{recursive:true,force:true});}
});

test('million-signal native FSDB catalogue: compressed scrollbar reaches the final declaration',{timeout:120000},async({page})=>{
  test.skip(!process.env.WAVE_TEST_LARGE_FSDB,'Set WAVE_TEST_LARGE_FSDB for large native catalogue integration');
  const env=await setup(page,process.env.WAVE_TEST_LARGE_FSDB);
  try{
    const total=env.viewer.meta.total;expect(total).toBeGreaterThan(1000000);
    const expected=(await env.viewer.backend.request('search',{query:'',offset:total-1,limit:1})).signals[0];
    await page.locator('#catalogAll').click();await expect(page.locator('#count')).toContainText(total+' 个匹配信号');
    await page.locator('#tree').evaluate(e=>{e.scrollTop=e.scrollHeight;});
    await expect(page.locator('.leaf').filter({hasText:expected.scope+'.'+expected.name})).toHaveCount(1);
    expect(await page.locator('.leaf').count()).toBeLessThan(60);expect(env.catalogRequests.some(r=>r.offset>1000000)).toBe(true);
    await page.screenshot({path:'test-results/million-catalogue.png'});
  }finally{env.dispose();}
});

test('previous full-chip FPU trace: original view script and matching KDB',{timeout:120000},async({page})=>{
  test.setTimeout(120000);test.skip(!process.env.WAVE_TEST_FPU_RUN,'Set WAVE_TEST_FPU_RUN for the previous full-chip FPU trace');
  const run=fs.realpathSync(process.env.WAVE_TEST_FPU_RUN),manifest=JSON.parse(fs.readFileSync(path.join(run,'trace_manifest.json'),'utf8'));
  const workspaceFile=projectFile('doc/cv32e40p_fpu_trace/fpu-wave-workbench.code-workspace');
  const workspace=JSON.parse(fs.readFileSync(workspaceFile,'utf8')),workspaceRoot=path.resolve(path.dirname(workspaceFile),workspace.folders[0].path);
  const configuredFile=path.resolve(workspaceRoot,workspace.settings['waveWorkbench.defaultWaveform']);expect(fs.realpathSync(configuredFile)).toBe(path.join(run,'fpu_soc.fsdb'));expect(workspace.settings['waveWorkbench.kdbPath']).toBe(manifest.kdb);
  const env=await setup(page,configuredFile,workspace.settings['waveWorkbench.kdbPath']);
  try{
    await env.run('source '+quote(projectFile('doc/cv32e40p_fpu_trace/wave_workbench_fpu.tcl')),run);
    expect(env.logs.join('\n')).toContain('FPU_VERDI_READY');
    const snapshot=await env.viewer.ui('snapshot');expect(snapshot.chosen.length).toBeGreaterThanOrEqual(100);expect(snapshot.cursorA).toBe(3707211701);
    const component='tb.dut.top_earlgrey.u_cv32e40p_dsp.u_core.u_core.fpu_gen.fp_wrapper_i.i_fpnew_bulk';
    const location=await env.viewer.kdb.resolve(component);expect(fs.existsSync(location.definitionFile)).toBe(true);
    expect(location.definitionFile).toContain('fpnew_top.sv');
    await expect(page.locator('#status')).toContainText(snapshot.chosen.length+' 个信号',{timeout:30000});
    await page.screenshot({path:'test-results/fpu-fdiv-view.png'});
  }finally{env.dispose();}
});

test('Verdi-style workflow: scoped signals, drag add, multiselect, context group, folding, cursor inputs, wheel and box zoom',async({page})=>{
  const env=await setup(page,path.resolve(__dirname,'../examples/demo.vcd'));
  try{
    await page.locator('#treeViewport .scope[title="tb.dut"]').click({position:{x:90,y:12}});
    await expect(page.locator('#scopeTitle')).toContainText('tb.dut');await expect(page.locator('.scopeSignal')).toHaveCount(4);
    await page.locator('.scopeSignal').filter({hasText:'clk'}).dblclick();await expect(page.locator('.row')).toHaveCount(1);
    await page.locator('.scopeSignal').filter({hasText:'data'}).dragTo(page.locator('canvas'));await expect(page.locator('.row')).toHaveCount(2);
    await page.locator('.scopeSignal').filter({hasText:'valid'}).dblclick();await expect(page.locator('.row')).toHaveCount(3);
    await page.locator('.row').nth(0).click();await page.locator('.row').nth(1).click({modifiers:['Control']});await expect(page.locator('.row.active')).toHaveCount(2);
    await page.locator('.row').first().click({button:'right'});await page.getByRole('menuitem',{name:'添加到分组…'}).click();await page.getByRole('textbox',{name:'分组名称'}).fill('GROUP1');await page.getByRole('button',{name:'确定分组'}).click();
    await expect(page.locator('.groupRow')).toContainText('GROUP1 (2)');await page.locator('.groupRow').click();await expect(page.locator('.row')).toHaveCount(1);await page.locator('.groupRow').click();await expect(page.locator('.row')).toHaveCount(3);
    await page.locator('#cursorAInput').fill('20');await page.locator('#cursorAInput').press('Tab');await page.locator('#cursorBInput').fill('30');await page.locator('#cursorBInput').press('Tab');
    await expect(page.locator('#cursors')).toContainText('Δ: 10');await page.locator('[data-action="between"]').click();await expect(page.locator('#range')).toContainText('20 → 30 × 1ns');
    await env.run('wvZoomAll');const box=await page.locator('canvas').boundingBox();await page.mouse.move(box.x+box.width*.2,box.y+50);await page.mouse.down();await page.mouse.move(box.x+box.width*.6,box.y+50);await page.mouse.up();await expect(page.locator('#range')).toContainText('10 → 30 × 1ns');
    const before=(await env.viewer.ui('snapshot'));await page.mouse.move(box.x+50,box.y+100);await page.mouse.wheel(0,160);expect((await env.viewer.ui('snapshot')).end-before.start).toBe(before.end-before.start);
    await page.keyboard.down('Control');await page.mouse.wheel(0,-100);await page.keyboard.up('Control');await expect.poll(async()=>{const s=await env.viewer.ui('snapshot');return s.end-s.start;}).toBeLessThan(before.end-before.start);
    await page.screenshot({path:'test-results/verdi-workflow.png'});
  }finally{env.dispose();}
});

// A is independent of the display window: neither an initial-value gap nor
// extrapolating the last visible event may produce a wrong Value @ A.
test('offscreen cursor values and sidebar layout remain synchronized',async({page})=>{
  const env=await setup(page,path.resolve(__dirname,'../examples/demo.vcd'));
  try{
    await env.run('wvAddSignal {/tb/dut/data[7:0]}; wvZoom 10 20; wvSetCursor 35');
    await expect(page.locator('.row .value')).toHaveText('F0');
    await env.run('wvSetCursor 15; wvZoom 30 40');
    await expect(page.locator('.row .value')).toHaveText('00');
    env.setQueryDelay(150);
    await env.run('wvSetCursor 25; wvSetCursor 35');
    await expect(page.locator('.row .value')).toHaveText('F0');
    await page.evaluate(()=>window.dispatchEvent(new MessageEvent('message',{data:{type:'sidebarVisibility',visible:true}})));
    await expect(page.locator('#catalogPanel')).not.toHaveAttribute('open','');
    await expect(page.locator('#legacyKdb')).toBeHidden();
    await page.evaluate(()=>window.dispatchEvent(new MessageEvent('message',{data:{type:'scopeSelected',scope:'tb.dut'}})));
    await expect(page.locator('.scopeSignal')).toHaveCount(4);
    await expect(page.locator('main>aside')).toBeHidden();
    await page.evaluate(()=>window.dispatchEvent(new MessageEvent('message',{data:{type:'sidebarVisibility',visible:false}})));
    await expect(page.locator('#legacyKdb')).toBeVisible();await page.locator('#catalogPanel summary').click();await expect(page.locator('#treeViewport .scope').first()).toBeVisible();
  }finally{env.dispose();}
});

test('visible waveform group controls: empty groups, drag, rename, folding and persisted state',async({page})=>{
  const env=await setup(page,path.resolve(__dirname,'../examples/demo.vcd'));
  try{
    await clickTool(page,'#newGroup');await page.locator('#groupName').fill('FPU');await page.locator('#groupForm button[type=submit]').click();
    await expect(page.locator('.groupRow')).toContainText('FPU (0)');
    await env.run('wvAddSignal /tb/dut/clk {/tb/dut/data[7:0]} /tb/dut/valid');
    await expect(page.locator('.groupRow')).toContainText('FPU (3)');
    await clickTool(page,'#collapseGroups');await expect(page.locator('.row')).toHaveCount(0);await expect(page.locator('.groupRow')).toHaveAttribute('aria-expanded','false');
    const count=env.queries.length;await page.waitForTimeout(150);expect(env.queries.length).toBe(count);
    await clickTool(page,'#expandGroups');await expect(page.locator('.row')).toHaveCount(3);
    await clickTool(page,'#renameGroup');await page.locator('#groupName').fill('FPU Result');await page.locator('#groupForm button[type=submit]').click();await expect(page.locator('.groupRow')).toContainText('FPU Result (3)');
    await page.locator('.row').first().click();await clickTool(page,'#ungroupSignals');await expect(page.locator('.groupRow')).toContainText('FPU Result (2)');
    await clickTool(page,'#newGroup');await page.locator('#groupName').fill('Clock');await page.locator('#groupForm button[type=submit]').click();await expect(page.locator('.groupRow')).toHaveCount(2);
    await page.locator('.row').filter({hasText:'data'}).dragTo(page.locator('.groupRow[data-group="Clock"]'));await expect(page.locator('.groupRow[data-group="Clock"]')).toContainText('Clock (2)');await expect(page.locator('.groupRow[data-group="FPU Result"]')).toContainText('(1)');
    await clickTool(page,'#collapseGroups');await expect(page.locator('.row')).toHaveCount(0);
    await expect.poll(()=>page.evaluate(()=>window.__savedWaveState?.collapsedGroups?.length)).toBe(2);
    const snapshot=await env.viewer.ui('snapshot');expect(snapshot.groupOrder).toEqual(['FPU Result','Clock']);expect(snapshot.chosen.filter(s=>s.group==='Clock')).toHaveLength(2);
    await clickTool(page,'#expandGroups');await page.evaluate(()=>window.dispatchEvent(new MessageEvent('message',{data:{type:'sidebarVisibility',visible:true}})));await page.screenshot({path:'test-results/waveform-groups.png'});
    await env.run('wvAddSignal -clear -group {A {/tb/dut/clk}}; wvAddSignal -group {B {/tb/dut/valid}}; wvAddSignal -group {A {/tb/dut/data[7:0]}}');await expect(page.locator('.groupRow')).toHaveCount(2);await expect(page.locator('.groupRow[data-group="A"]')).toContainText('A (2)');
  }finally{env.dispose();}
});

test('signal tools: rename, find, filter, move, cut/paste, notation and bounded report',async({page})=>{
 const env=await setup(page,path.resolve(__dirname,'../examples/demo.vcd'));
 try{
  await env.run('wvAddSignal /tb/dut/clk {/tb/dut/data[7:0]} /tb/dut/valid; wvSetCursor 20');
  await page.locator('.row').filter({hasText:'data'}).click();await clickTool(page,'#renameSignal');await page.locator('#signalAlias').fill('Result Bus');await page.locator('#renameSignalForm button[type=submit]').click();await expect(page.locator('.row .name').nth(1)).toHaveText('Result Bus');
  await page.locator('#toggleFilter').click();await page.locator('#filterSignals').fill('Result Bus');await expect(page.locator('.row')).toHaveCount(1);expect((await env.viewer.ui('snapshot')).chosen).toHaveLength(3);
  await page.locator('#filterSignals').fill('');await page.locator('#findSignal').fill('Result');await page.locator('#findNext').click();await expect(page.locator('.row.active .name')).toHaveText('Result Bus');
  await clickTool(page,'#moveUp');await expect(page.locator('.row .name').first()).toHaveText('Result Bus');
  await page.locator('.row.active').click({button:'right'});await page.getByRole('menuitem',{name:'高亮颜色…',exact:true}).click();await page.getByLabel('高亮颜色',{exact:true}).fill('#ff8800');expect((await env.viewer.ui('snapshot')).chosen[0].highlight).toBe('#ff8800');await page.locator('canvas').click();
  await page.locator('.row.active').click({button:'right'});await page.getByRole('menuitem',{name:'Verilog 数值表示',exact:true}).click();await env.run('wvSetCursor 20');await expect(page.locator('.row.active .value')).toHaveText("8'h2A");
  await page.locator('canvas').focus();await page.keyboard.press('Control+x');await expect(page.locator('.row')).toHaveCount(2);await page.keyboard.press('Control+v');await expect(page.locator('.row')).toHaveCount(3);await expect(page.locator('.row.active .name')).toHaveText('Result Bus');
  await clickTool(page,'#signalReport');await expect(page.locator('#eventReport')).toBeVisible();await expect(page.locator('#reportBody')).toContainText('tb.dut.data[7:0]');await expect(page.locator('#reportBody')).toContainText("8'h2A");await expect(page.locator('#reportSummary')).toContainText('含窗口起点值');
  expect(env.queries.filter(q=>String(q.request).startsWith('report:')).every(q=>q.signals.length<=64)).toBe(true);await page.locator('#closeReport').click();await expect(page.locator('#eventReport')).toBeHidden();
  await page.screenshot({path:'test-results/signal-tools.png'});
 }finally{env.dispose();}
});

test('Bus bits: values, X/Z, shared reads, bit edges, collapse and Tcl replay',async({page})=>{
 const env=await setup(page,path.resolve(__dirname,'../examples/demo.vcd'));const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wave-bits-'));
 try{
  await env.run('wvAddSignal {/tb/dut/data[7:0]}; wvSetCursor 20');await expect(page.locator('.row .value')).toHaveText('2A');const before=await env.viewer.backend.request('cacheStats');
  await clickTool(page,'#expandBus');await expect(page.locator('.row')).toHaveCount(9);
  const bit=n=>page.locator('.row').filter({has:page.locator('.name',{hasText:new RegExp('^data\\['+n+'\\]$')})});
  await expect(bit(7).locator('.value')).toHaveText('0');await expect(bit(5).locator('.value')).toHaveText('1');await expect(bit(0).locator('.value')).toHaveText('0');expect((await env.viewer.backend.request('cacheStats')).reads).toBe(before.reads);
  await bit(0).click();expect(await env.run('wvSearchNext')).toBe('1 40');await expect(bit(0).locator('.value')).toHaveText(/^[zZ]$/);await env.run('wvSetCursor 0');await expect(bit(5).locator('.value')).toHaveText(/^[xX]$/);
  await clickTool(page,'#collapseBus');await expect(page.locator('.row')).toHaveCount(1);await clickTool(page,'#expandBus');await expect(page.locator('.row')).toHaveCount(9);
  await env.run('wvZoom 0 25; wvSetCursor 30');await expect(bit(7).locator('.value')).toHaveText('1');await expect(bit(0).locator('.value')).toHaveText('0');
  await env.run('wvSetWindowTimeUnit 10 ns');const file=path.join(dir,'bits.tcl');await env.run('wvSaveSignal '+quote(file));expect(fs.readFileSync(file,'utf8')).toContain('waveRestoreView');await env.run('wvRestoreSignal '+quote(file));expect(await env.run('wvGetWindowTimeUnit')).toBe('10 ns');await env.run('wvSetWindowTimeUnit 1 ns');await expect(page.locator('.row')).toHaveCount(9);await expect(bit(7).locator('.value')).toHaveText('1');
  const snapshot=await env.viewer.ui('snapshot');expect(snapshot.chosen.slice(1).map(s=>s.bitOffset)).toEqual([7,6,5,4,3,2,1,0]);expect(snapshot.chosen.slice(1).every(s=>s.width===1&&s.sourceWidth===8)).toBe(true);
  expect(await env.run('wvGetSigValueByTime {/tb/dut/data[7]} -time 30')).toBe('1');expect(await env.run('wvGetSigValueByTime {/tb/dut/data[0]} -time 40')).toBe('z');
  expect(env.queries.every(q=>new Set(q.signals).size===q.signals.length)).toBe(true);await page.screenshot({path:'test-results/bus-bits.png'});
  await page.locator('.row').first().click({button:'right'});await page.getByRole('menuitem',{name:'拆分为独立位',exact:true}).click();await expect(page.locator('.row')).toHaveCount(8);expect((await env.viewer.ui('snapshot')).chosen.every(s=>!s.parentBus)).toBe(true);
  await page.locator('.row').first().click({button:'right'});await page.getByRole('menuitem',{name:'同源位还原总线',exact:true}).click();await expect(page.locator('.row')).toHaveCount(1);await expect(page.locator('.row .value')).toHaveText('F0');
 }finally{env.dispose();fs.rmSync(dir,{recursive:true,force:true});}
});

test('Rust virtual UI: concat, nested NOT, Bus expansion and Tcl replay',async({page})=>{
 const env=await setup(page,path.resolve(__dirname,'../examples/demo.vcd'));const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wave-virtual-ops-'));
 try{
  await env.run('wvAddSignal /tb/dut/clk /tb/dut/valid; wvSetCursor 25');await page.locator('.row').first().click();await page.locator('.row').nth(1).click({modifiers:['Control']});
  await clickTool(page,'#createVirtual');await page.locator('#virtualName').fill('control_bundle');await page.locator('#virtualOp').selectOption('concat');await page.locator('#virtualForm button[type=submit]').click();await expect(page.locator('.row')).toHaveCount(3);await expect(page.locator('.row.active .value')).toHaveText('3');
  await clickTool(page,'#createVirtual');await page.locator('#virtualName').fill('inverted');await page.locator('#virtualOp').selectOption('not');await page.locator('#virtualForm button[type=submit]').click();await expect(page.locator('.row')).toHaveCount(4);await expect(page.locator('.row.active .value')).toHaveText('0');
  await clickTool(page,'#expandBus');await expect(page.locator('.row')).toHaveCount(6);await expect(page.locator('.row.busBit .value')).toHaveText(['0','0']);
  const snapshot=await env.viewer.ui('snapshot');expect(snapshot.virtualDefinitions).toHaveLength(2);const saved=path.join(dir,'virtual.tcl');await env.run('wvSaveSignal '+quote(saved));await env.run('wvRestoreSignal '+quote(saved));await expect(page.locator('.row')).toHaveCount(6);await expect(page.locator('.row.busBit .value')).toHaveText(['0','0']);
  const restored=await env.viewer.ui('snapshot');expect(restored.virtualDefinitions).toHaveLength(2);expect(restored.chosen.filter(s=>s.id.startsWith('@virtual:'))).toHaveLength(4);await page.screenshot({path:'test-results/virtual-operations.png'});
 }finally{env.dispose();fs.rmSync(dir,{recursive:true,force:true});}
});

test('RTL batch delivery adds many signals once and reports existing rows',async({page})=>{
 const env=await setup(page,path.resolve(__dirname,'../examples/demo.vcd'));try{const result=await require('../dist/rtl-selection').resolveSelection(env.viewer.backend,['clk','valid','data[0]','data[7]'],'tb.dut');expect(result.signals).toHaveLength(4);expect(await env.viewer.ui('batchAdd',{signals:result.signals})).toEqual({added:4,duplicates:0});await expect(page.locator('.row')).toHaveCount(4);expect(await env.viewer.ui('batchAdd',{signals:result.signals})).toEqual({added:0,duplicates:4});await expect(page.locator('.row')).toHaveCount(4);}finally{env.dispose();}
});

test('compact controls leave waveform height available; editors float and menus close',async({page})=>{
 const env=await setup(page,path.resolve(__dirname,'../examples/demo.vcd'));try{
  await page.setViewportSize({width:1200,height:480});await page.evaluate(()=>window.dispatchEvent(new MessageEvent('message',{data:{type:'sidebarVisibility',visible:true}})));await env.run('wvAddSignal -group {G1 {/tb/dut/clk} {/tb/dut/data[7:0]} {/tb/dut/valid}}; wvSetCursor 20');
  const height=()=>page.locator('#tracks').evaluate(e=>e.clientHeight);expect(await height()).toBeGreaterThanOrEqual(390);await expect(page.locator('header')).toHaveCount(0);
  await clickTool(page,'#newGroup');await expect(page.locator('#editPopover')).toBeVisible();expect(await height()).toBeGreaterThanOrEqual(390);await page.keyboard.press('Escape');await expect(page.locator('#editPopover')).toBeHidden();
  await page.locator('#signalMenu summary').click();await expect(page.locator('#expandBus')).toBeVisible();await page.locator('#groupMenu summary').click();await expect(page.locator('#expandBus')).toBeHidden();await page.keyboard.press('Escape');
  await page.screenshot({path:'test-results/compact-waveform.png'});
  await page.setViewportSize({width:720,height:400});expect(await height()).toBeGreaterThanOrEqual(310);await page.locator('#sourceMenu summary').click();await expect(page.locator('[data-action=source]')).toBeVisible();const rect=await page.locator('#sourceMenu .menuPanel').boundingBox();expect(rect.x).toBeGreaterThanOrEqual(0);expect(rect.x+rect.width).toBeLessThanOrEqual(720);await page.keyboard.press('Escape');await page.screenshot({path:'test-results/compact-waveform-narrow.png'});
 }finally{env.dispose();}
});

test('named time markers: add, render dashed line, drag, edit, navigate, hide and replay',async({page})=>{
 const env=await setup(page,path.resolve(__dirname,'../examples/demo.vcd'));const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wave-markers-'));
 try{
  await page.setViewportSize({width:1200,height:480});await page.evaluate(()=>window.dispatchEvent(new MessageEvent('message',{data:{type:'sidebarVisibility',visible:true}})));await env.run('wvAddSignal /tb/dut/clk {/tb/dut/data[7:0]}; wvSetCursor 20');
  await page.locator('canvas').focus();await page.keyboard.press('m');await page.locator('#markerName').fill('fdiv_accept');await page.locator('#markerTime').fill('999');await page.locator('#markerForm button[type=submit]').click();await expect(page.locator('#markerError')).toContainText('超出');expect((await env.viewer.ui('snapshot')).markers).toHaveLength(0);await page.locator('#markerTime').fill('20');await page.locator('#markerForm button[type=submit]').click();await expect(page.getByRole('button',{name:'时间标记 fdiv_accept',exact:true})).toBeVisible();expect((await env.viewer.ui('snapshot')).cursorB).toBeNull();
  await env.run('wvSetMarker -name fdiv_result -keepViewRange 30');await expect(page.getByRole('button',{name:'时间标记 fdiv_result',exact:true})).toBeVisible();
  const geometry=await page.locator('canvas').boundingBox();const marker=page.getByRole('button',{name:'时间标记 fdiv_accept',exact:true});const markerBox=await marker.boundingBox();await page.mouse.move(markerBox.x+5,markerBox.y+8);await page.mouse.down();await page.mouse.move(markerBox.x+5+geometry.width*.1,markerBox.y+8);await page.mouse.up();expect((await env.viewer.ui('snapshot')).markers.find(m=>m.name==='fdiv_accept').time).toBe(25);
  await clickTool(page,'#manageMarkers');await expect(page.locator('.markerItem')).toHaveCount(2);await page.locator('.markerItem').filter({hasText:'fdiv_accept'}).getByRole('button',{name:'编辑',exact:true}).click();await page.locator('#markerName').fill('fdiv_round');await page.locator('#markerTime').fill('26');await page.locator('#markerForm button[type=submit]').click();await expect(page.getByRole('button',{name:'时间标记 fdiv_round',exact:true})).toBeVisible();await page.locator('#closeMarkerManager').click();
  const saved=path.join(dir,'markers.tcl');await env.run('wvSaveSignal '+quote(saved));await env.run('wvRestoreSignal '+quote(saved));expect((await env.viewer.ui('snapshot')).markers.map(m=>m.name).sort()).toEqual(['fdiv_result','fdiv_round']);
  await clickTool(page,'#toggleMarkers');await expect(page.locator('#markerLayer')).toBeHidden();await clickTool(page,'#toggleMarkers');await expect(page.getByRole('button',{name:'时间标记 fdiv_round',exact:true})).toBeVisible();
  await env.run('wvSetCursor 10');await clickTool(page,'#nextMarker');expect((await env.viewer.ui('snapshot')).cursorA).toBe(26);
  const dashed=await page.locator('canvas').evaluate(canvas=>{const ctx=canvas.getContext('2d'),x=Math.round(canvas.width*26/50);let green=0,gaps=0;for(let y=80;y<144;y++){const d=ctx.getImageData(x-1,y,3,1).data;let hit=false;for(let p=0;p<12;p+=4)if(d[p+1]>d[p]+25&&d[p+2]>d[p]+25)hit=true;if(hit)green++;else gaps++;}return {green,gaps};});expect(dashed.green).toBeGreaterThan(15);expect(dashed.gaps).toBeGreaterThan(15);
  await page.screenshot({path:'test-results/named-time-markers.png'});
  await clickTool(page,'#manageMarkers');await page.locator('.markerItem').filter({hasText:'fdiv_round'}).getByRole('button',{name:'删除',exact:true}).click();await expect(page.locator('.markerItem')).toHaveCount(1);
 }finally{env.dispose();fs.rmSync(dir,{recursive:true,force:true});}
});

test('waveform hover shows position value, bit and virtual content without changing cursors',async({page})=>{
 const env=await setup(page,path.resolve(__dirname,'../examples/demo.vcd'));
 try{
  await env.run('wvAddSignal -group {G1 {/tb/dut/clk} {/tb/dut/data[7:0]} {/tb/dut/valid}}; wvSetCursor 10; wvSetMarker -name test_marker -keepViewRange 15');await expect(page.locator('.row').nth(1).locator('.value')).toHaveText('00');
  async function hoverRow(row,time){const c=await page.locator('canvas').boundingBox(),r=await row.boundingBox();await page.mouse.move(c.x+c.width*time/50,r.y+r.height/2);}
  const before=await env.viewer.ui('snapshot'),queries=env.queries.length;await hoverRow(page.locator('.row').nth(1),20);await expect(page.locator('#waveTooltip')).toContainText('tb.dut.data[7:0]');await expect(page.locator('#waveTooltip')).toContainText('20 × 1ns');await expect(page.locator('#waveTooltip')).toContainText('2A');await expect(page.locator('#waveTooltip')).toContainText('00101010');
  await page.waitForTimeout(220);expect(env.queries.length).toBe(queries);expect((await env.viewer.ui('snapshot')).cursorA).toBe(before.cursorA);expect((await env.viewer.ui('snapshot')).cursorB).toBe(before.cursorB);await page.screenshot({path:'test-results/waveform-hover.png'});
  await hoverRow(page.locator('.row').nth(1),40);await expect(page.locator('#waveTooltip')).toContainText('zzzzzzzz');
  await page.locator('.row').nth(1).click();await clickTool(page,'#expandBus');const bit=page.locator('.row').filter({has:page.locator('.name',{hasText:/^data\[5\]$/})});await hoverRow(bit,20);await expect(page.locator('#waveTooltip')).toContainText('tb.dut.data[5]');await expect(page.locator('#waveTooltip')).toContainText('1 bit');
  await page.mouse.move(5,5);await expect(page.locator('#waveTooltip')).toBeHidden();
  await page.locator('.row').first().click();await clickTool(page,'#createVirtual');await page.locator('#virtualName').fill('invert_clock');await page.locator('#virtualOp').selectOption('not');await page.locator('#virtualForm button[type=submit]').click();await expect(page.locator('.row.active .value')).not.toHaveText('—');await hoverRow(page.locator('.row.active'),20);await expect(page.locator('#waveTooltip')).toContainText('$virtual.invert_clock');await expect(page.locator('#waveTooltip')).toBeVisible();
  await page.screenshot({path:'test-results/waveform-hover-virtual.png'});await page.keyboard.press('Escape');await expect(page.locator('#waveTooltip')).toBeHidden();
 }finally{env.dispose();}
});

test('hover reads truncated tail on demand and drops tooltip on leave',async({page})=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wave-hover-tail-')),file=path.join(dir,'dense.vcd');let text='$timescale 1 ns $end\n$scope module top $end\n$var wire 8 v bus [7:0] $end\n$upscope $end\n$enddefinitions $end\n';for(let i=0;i<=25000;i++)text+='#'+i+'\nb'+(i%256).toString(2)+' v\n';fs.writeFileSync(file,text);const env=await setup(page,file);
 try{await env.run('wvAddSignal {/top/bus[7:0]}');await expect(page.locator('#status')).toContainText('超限');const c=await page.locator('canvas').boundingBox(),r=await page.locator('.row').boundingBox();await page.mouse.move(c.x+c.width*24000/25000,r.y+16);await expect.poll(()=>env.queries.filter(q=>String(q.request).startsWith('hover:')).length).toBe(1);await expect(page.locator('#waveTooltip')).toContainText('24000 × 1ns');await expect(page.locator('#waveTooltip')).toContainText('C0');expect((await env.viewer.ui('snapshot')).cursorA).toBe(0);
 env.setQueryDelay(200);await page.mouse.move(c.x+c.width*24500/25000,r.y+16);await expect.poll(()=>env.queries.filter(q=>String(q.request).startsWith('hover:')).length).toBe(2);await page.mouse.move(0,0);await page.waitForTimeout(300);await expect(page.locator('#waveTooltip')).toBeHidden();
 }finally{env.dispose();fs.rmSync(dir,{recursive:true,force:true});}
});

test('group headers reorder, row selection sets the add target and projects restore the view', async ({page}) => {
  const file = path.resolve(__dirname, '../examples/demo.vcd');
  const env = await setup(page, file);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wave-project-test-'));
  const {saveWaveProject, readWaveProject} = require('../dist/project');
  const {restoreView} = require('../dist/view-state');
  try {
    await env.run('wvAddSignal -group {A {/tb/dut/clk}}; wvAddSignal -group {B {/tb/dut/valid}}');
    await page.locator('.groupRow[data-group="B"]').dragTo(
      page.locator('.groupRow[data-group="A"]'), {targetPosition: {x: 10, y: 4}}
    );
    await expect.poll(async () => (await env.viewer.ui('snapshot')).groupOrder).toEqual(['B', 'A']);
    await page.getByText('clk', {exact: true}).first().click();
    await env.run('wvAddSignal {/tb/dut/data[7:0]}');
    await expect(page.locator('.groupRow[data-group="A"]')).toContainText('A (2)');
    await page.locator('#toggleTooltip').click();
    await expect(page.locator('#toggleTooltip')).toHaveAttribute('aria-pressed', 'false');
    await page.locator('#displayMenu summary').click();
    await page.locator('#waveRowHeight').fill('48');
    await expect.poll(() => page.locator('.row').first().evaluate(row => row.getBoundingClientRect().height)).toBe(48);
    const separator = await page.locator('#waveSplit').boundingBox();
    const width = (await page.locator('#names').boundingBox()).width;
    await page.mouse.move(separator.x + 3, separator.y + 12);
    await page.mouse.down();
    await page.mouse.move(separator.x + 140, separator.y + 12, {steps: 5});
    await page.mouse.up();
    await expect.poll(async () => (await page.locator('#names').boundingBox()).width).toBeGreaterThan(width + 80);
    await env.run('wvZoom 10 40; wvSetCursor 20; wvSetMarker -name Result 30');
    const state = await env.viewer.ui('snapshot');
    const filename = path.join(directory, 'demo.waveproj');
    await saveWaveProject(filename, file, state);
    await env.run('waveGroup move B A after; waveTooltip 1; waveLayout 32 30; wvZoomAll');
    const project = await readWaveProject(filename);
    expect(project.waveform).toBe(file);
    await env.viewer.ui('restoreView', await restoreView(env.viewer.backend, project.view, env.viewer.meta));
    const restored = await env.viewer.ui('snapshot');
    expect(restored.groupOrder).toEqual(['B', 'A']);
    expect(restored.activeGroup).toBe('A');
    expect(restored.tooltipEnabled).toBe(false);
    expect(restored.rowHeight).toBe(48);
    expect(restored.namesFraction).toBe(state.namesFraction);
    expect(restored.markers).toEqual(state.markers);
    expect([restored.start, restored.end, restored.cursorA]).toEqual([10, 40, 20]);
  } finally {
    env.dispose();
    fs.rmSync(directory, {recursive: true, force: true});
  }
});
