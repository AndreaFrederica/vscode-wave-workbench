// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

const {projectFile}=require('./fixtures');
async function clickTool(page,selector){const target=page.locator(selector),parent=target.locator('xpath=ancestor::details[contains(@class,"toolMenu")]');if(await parent.count()&&!await parent.evaluate(e=>e.open)){await parent.locator('summary').click();}await target.click();}
const {test,expect}=require('@playwright/test');
const path=require('node:path'),fs=require('node:fs'),os=require('node:os');
const {Backend}=require('../dist/backend');const {TclRunner}=require('../dist/tcl');const {WaveCommands,quote}=require('../dist/commands');const {KdbSession}=require('../dist/kdb');
async function setup(page,filename,kdbPath,decoderConfig){
  const backend=new Backend(path.resolve(__dirname,'../bin/wave-backend'));const pending=new Map();let sequence=0,queryDelay=0;const logs=[],queries=[],catalogRequests=[],decoderRequests=[],rtlRequests=[];
  const viewer={backend,uri:{fsPath:filename},meta:await backend.request('open',{path:filename})};
  const send=m=>page.evaluate(m=>window.dispatchEvent(new MessageEvent('message',{data:m})),m);
  viewer.ui=(action,payload)=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});send({type:'ui',id,action,payload}).catch(reject);});
  if(kdbPath){viewer.kdb=new KdbSession(path.resolve(__dirname,'../bin/wave-backend'),process.env.VERDI_HOME);await viewer.kdb.open(kdbPath);}
  const engine=new WaveCommands({getViewer:()=>viewer,open:async file=>{if(path.resolve(file)!==filename)throw Error('Unexpected test open');},scope:async name=>{await send({type:'kdbHierarchy',scope:name,children:await viewer.kdb.children(name)});}});
  const runner=new TclRunner((name,args,dir)=>{viewer.scriptDirectory=dir;return engine.execute(name,args);},{log:text=>logs.push(text)});
  await page.exposeFunction('bridge',async m=>{
    if(['rtlTrace','rtlSchematic','rtlModuleSchematic','rtlTraceSchematic'].includes(m.type))rtlRequests.push(m);
    if(m.type==='ready'){await send({type:'metadata',...viewer.meta,title:path.basename(filename),vide:'1.2.5'});}
    else if(m.type==='queryWaveDecoder'){decoderRequests.push(m);}
    else if(m.type==='decoderCatalog'){
      const {loadDecoderCatalog}=require('../dist/decoder-config');
      await send({type:'decoderCatalog',...await loadDecoderCatalog(decoderConfig),workspaceAvailable:!!decoderConfig});
    }
    else if(m.type==='saveDecoderProfile'){
      const {saveDecoderProfile}=require('../dist/decoder-config');
      try {
        const profile=await saveDecoderProfile(decoderConfig,m.group,m.original,m.edited);
        await send({type:'decoderProfileSaved',request:m.request,profile});
      } catch(error) {
        await send({type:'decoderProfileSaved',request:m.request,error:error.message});
      }
    }
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
  return {viewer,send,logs,queries,catalogRequests,decoderRequests,rtlRequests,running:()=>!!runner.pending,setQueryDelay(ms){queryDelay=ms;},run:(script,directory)=>runner.run(script,directory||path.dirname(filename)),dispose(){runner.dispose();backend.dispose();viewer.kdb?.dispose();}};
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
    const firstPrefetched = Number(await page.locator('.row').last().getAttribute('data-index')) + 1;
    await expect.poll(() => env.queries.some(q => q.signals.includes('v' + firstPrefetched))).toBe(true);
    await env.viewer.backend.request('cacheStats');
    env.setQueryDelay(1000);
    await page.locator('#tracks').evaluate(e => { e.scrollTop = 6 * 32; });
    await expect(page.locator(`.row[data-index="${firstPrefetched}"] .value`)).toHaveText(
      firstPrefetched.toString(16).padStart(2, '0').toUpperCase(), {timeout: 500},
    );
    env.setQueryDelay(0);
    await page.locator('#tracks').evaluate(e=>{e.scrollTop=e.scrollHeight;});
    await expect(page.locator('.row[data-index="9999"] .value')).toHaveText('0F');
    const prefetchedAbove = Number(await page.locator('.row').first().getAttribute('data-index')) - 1;
    await expect.poll(() => env.queries.some(q => q.signals.includes('v' + prefetchedAbove))).toBe(true);
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
  const height=()=>page.locator('#tracks').evaluate(e=>e.clientHeight+document.querySelector('#waveScrollbars').clientHeight);expect(await height()).toBeGreaterThanOrEqual(390);await expect(page.locator('header')).toHaveCount(0);
  await clickTool(page,'#newGroup');await expect(page.locator('#editPopover')).toBeVisible();expect(await height()).toBeGreaterThanOrEqual(390);await page.keyboard.press('Escape');await expect(page.locator('#editPopover')).toBeHidden();
  await page.locator('#signalMenu summary').click();await expect(page.locator('#expandBus')).toBeVisible();await page.locator('#groupMenu summary').click();await expect(page.locator('#expandBus')).toBeHidden();await page.keyboard.press('Escape');
  await page.screenshot({path:'test-results/compact-waveform.png'});
  await page.setViewportSize({width:720,height:400});expect(await height()).toBeGreaterThanOrEqual(310);await page.locator('#sourceMenu summary').click();await expect(page.locator('[data-action=source]')).toBeVisible();const rect=await page.locator('#sourceMenu .menuPanel').boundingBox();expect(rect.x).toBeGreaterThanOrEqual(0);expect(rect.x+rect.width).toBeLessThanOrEqual(720);await page.keyboard.press('Escape');await page.screenshot({path:'test-results/compact-waveform-narrow.png'});
 }finally{env.dispose();}
});

test('trace and schematic toolbar menus dispatch to the selected waveform signal', async ({page}) => {
  const env = await setup(page, path.resolve(__dirname,'../examples/demo.vcd'));
  try {
    await clickTool(page, '#schematicMenu [data-action=rtlSchematicTop]');
    await env.run('wvAddSignal {/tb/dut/clk}; wvSetCursor 20');
    await page.locator('.row').first().click();
    await clickTool(page, '#traceMenu [data-action=traceContext]');
    await clickTool(page, '#schematicMenu [data-action=rtlTraceSchematic]');
    await clickTool(page, '#schematicMenu [data-action=rtlSchematicLoads]');
    await clickTool(page, '#schematicMenu [data-action=rtlSchematicModule]');
    await expect.poll(() => env.rtlRequests).toMatchObject([
      {type: 'rtlModuleSchematic'},
      {type: 'rtlTrace', mode: 'context', signal: 'tb.dut.clk', tick: '20'},
      {type: 'rtlTraceSchematic'},
      {type: 'rtlSchematic', direction: 'loads', signal: 'tb.dut.clk', tick: '20'},
      {type: 'rtlModuleSchematic', signal: 'tb.dut.clk'},
    ]);
  } finally {
    env.dispose();
  }
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

test('changing row height scales the waveform and its hover band', async ({page}) => {
  const env = await setup(page, path.resolve(__dirname, '../examples/demo.vcd'));
  try {
    await env.run('wvAddSignal {/tb/dut/clk} {/tb/dut/data[7:0]}');
    await expect(page.locator('.row .value').first()).toHaveText('0');
    const traceOffsets = () => page.evaluate(() => {
      const canvas = document.querySelector('canvas');
      const ctx = canvas.getContext('2d');
      const bounds = canvas.getBoundingClientRect();
      const scale = canvas.height / bounds.height;
      const x = Math.floor(canvas.width * 0.26);
      return [...document.querySelectorAll('.row')].slice(0, 2).map((row, index) => {
        const box = row.getBoundingClientRect();
        const y = Math.round((box.top - bounds.top) * scale);
        const data = ctx.getImageData(x, y, 1, Math.round(box.height * scale)).data;
        const offsets = [];
        for (let p = 0; p < data.length; p += 4) {
          const [r, g, b] = data.subarray(p, p + 3);
          if (index === 0 ? g > r + 30 && g > b + 10 : b > r + 40 && b > g + 15)
            offsets.push(Math.round(p / 4 / scale));
        }
        return offsets;
      });
    });
    await expect.poll(async () => {
      const [clock, bus] = await traceOffsets();
      return [clock.at(-1), bus[0], bus.at(-1)];
    }).toEqual([25, 6, 25]);
    await page.locator('#displayMenu summary').click();
    await page.locator('#waveRowHeight').fill('64');
    await page.locator('#displayMenu summary').click();
    await expect.poll(async () => {
      const [clock, bus] = await traceOffsets();
      return [clock.at(-1), bus[0], bus.at(-1)];
    }).toEqual([50, 13, 50]);
    const canvas = await page.locator('canvas').boundingBox();
    const bus = await page.locator('.row').nth(1).boundingBox();
    await page.mouse.move(canvas.x + canvas.width * 0.26, bus.y + 54);
    await expect(page.locator('#waveTooltip')).toContainText('data[7:0]');
    await expect(page.locator('#hoverBand')).toHaveCSS('height', '64px');
    expect((await page.locator('#hoverBand').boundingBox()).y).toBe(bus.y);
  } finally {
    env.dispose();
  }
});

test('horizontal pan keeps cached traces visible and signal names scroll independently', async ({page}) => {
  const env = await setup(page, path.resolve(__dirname, '../examples/demo.vcd'));
  try {
    await env.run('wvZoom 10 20; wvAddSignal /tb/dut/clk; wvSetCursor 12');
    await expect(page.locator('.row .value')).toHaveText('0');
    const count = env.queries.length;
    env.setQueryDelay(1000);
    await page.locator('[data-action="right"]').click();
    await expect(page.locator('#range')).toContainText('13 → 23');
    expect(env.queries).toHaveLength(count);
    await page.locator('[data-action="right"]').click();
    await expect(page.locator('#range')).toContainText('16 → 26');
    await expect(page.locator('#status')).toContainText('正在读取');
    const overlapVisible = await page.locator('canvas').evaluate(canvas => {
      const row = document.querySelector('.row').getBoundingClientRect();
      const bounds = canvas.getBoundingClientRect();
      const scale = canvas.height / bounds.height;
      const ctx = canvas.getContext('2d');
      const pixels = ctx.getImageData(
        Math.round(canvas.width * 0.5),
        Math.round((row.top - bounds.top) * scale),
        1,
        Math.round(row.height * scale),
      ).data;
      for (let i = 0; i < pixels.length; i += 4) {
        const [red, green, blue] = pixels.subarray(i, i + 3);
        if (green > red + 30 && green > blue + 10) return true;
      }
      return false;
    });
    expect(overlapVisible).toBe(true);
    await expect(page.locator('.row .value')).toHaveText('0');
    await expect(page.locator('#status')).toContainText('1 个信号');

    const bounds = await page.locator('canvas').boundingBox();
    await page.mouse.move(bounds.x + bounds.width * 0.6, bounds.y + 80);
    await page.mouse.down({button: 'middle'});
    await page.mouse.move(bounds.x + bounds.width * 0.3, bounds.y + 80);
    await expect(page.locator('#range')).toContainText('19 → 29');
    await page.mouse.up({button: 'middle'});

    await page.locator('.row').click();
    await clickTool(page, '#renameSignal');
    await page.locator('#signalAlias').fill('pipeline_stage_'.repeat(10) + 'CLK_TAIL');
    await page.locator('#renameSignalForm button[type=submit]').click();
    await expect(page.locator('#nameScroll')).toBeVisible();
    const valueBefore = await page.locator('.row .value').boundingBox();
    const name = page.locator('.signalNameContent');
    const nameBefore = await name.boundingBox();
    const edit = page.locator('.row .signalAnnotation');
    const editBefore = await edit.boundingBox();
    await page.locator('#nameScroll').evaluate(el => { el.scrollLeft = el.scrollWidth; });
    await expect.poll(async () => (await name.boundingBox()).x).toBeLessThan(nameBefore.x - 100);
    expect(await edit.boundingBox()).toEqual(editBefore);
    await edit.click();
    await expect(page.locator('#annotationForm')).toBeVisible();
    await page.locator('#cancelAnnotation').click();
    expect(await page.locator('.row .value').boundingBox()).toEqual(valueBefore);
    await expect(page.locator('#range')).toContainText('19 → 29');
  } finally {
    env.dispose();
  }
});

test('full-wave scrollbar reflects the zoomed time range and pans to both bounds', async ({page}) => {
  const env = await setup(page, path.resolve(__dirname, '../examples/demo.vcd'));
  try {
    await env.run('wvAddSignal /tb/dut/clk; wvSetCursor 12');
    const bar = page.getByRole('scrollbar', {name: '全波形时间轴'});
    const thumb = page.locator('#timeThumb');
    await expect(bar).toHaveAttribute('aria-valuetext', /100%/);
    await expect(bar).toHaveAttribute('aria-disabled', 'true');
    const divider = page.locator('.valueHeader');
    expect(await page.locator('#valueSplit').evaluate(el => getComputedStyle(el, '::before').borderLeftWidth)).toBe('1px');
    expect((await divider.boundingBox()).x).toBeCloseTo(
      (await page.locator('.row .value').boundingBox()).x, 0,
    );

    await env.run('wvZoom 10 20');
    await expect(bar).toHaveAttribute('aria-valuetext', /20%/);
    await expect(bar).toHaveAttribute('aria-valuenow', '10');
    const track = await bar.boundingBox();
    const plot = await page.locator('canvas').boundingBox();
    const handle = await thumb.boundingBox();
    expect(track.x).toBeCloseTo(plot.x, 0);
    expect(track.width).toBeCloseTo(plot.width, 0);
    expect(handle.width / track.width).toBeCloseTo(0.2, 2);
    expect((handle.x - track.x) / track.width).toBeCloseTo(0.2, 2);

    await page.mouse.move(handle.x + 5, handle.y + 5);
    await page.mouse.down();
    await page.mouse.move(track.x + track.width - 1, handle.y + 5, {steps: 6});
    await expect(page.locator('#range')).toContainText('40 → 50');
    await page.mouse.up();
    await bar.press('Home');
    await expect(page.locator('#range')).toContainText('0 → 10');
    await bar.press('ArrowRight');
    await expect(page.locator('#range')).toContainText('1 → 11');
    await bar.press('End');
    await expect(page.locator('#range')).toContainText('40 → 50');
    await expect(page.locator('#cursorAInput')).toHaveValue('12');

    await page.locator('#waveSplit').press('ArrowRight');
    await expect.poll(async () => {
      const [updatedTrack, updatedPlot] = await Promise.all([bar.boundingBox(), page.locator('canvas').boundingBox()]);
      return Math.abs(updatedTrack.x - updatedPlot.x) + Math.abs(updatedTrack.width - updatedPlot.width);
    }).toBeLessThan(1);
    await env.run('wvZoomAll');
    await expect(bar).toHaveAttribute('aria-disabled', 'true');
    expect((await thumb.boundingBox()).width).toBeCloseTo((await bar.boundingBox()).width, 0);
  } finally {
    env.dispose();
  }
});

test('time unit selector and sidebar annotations use the current waveform project', async ({page}) => {
  const env = await setup(page, path.resolve(__dirname, '../examples/demo.vcd'));
  try {
    const units = page.getByRole('combobox', {name:'时间轴单位'});
    await units.selectOption('1ps');
    await expect(page.locator('#range')).toContainText('0 → 50000 × 1ps');
    await env.run('wvSetCursor 12000');
    await expect(page.locator('#cursorAInput')).toHaveValue('12000');
    await units.selectOption('1us');
    await expect(page.locator('#range')).toContainText('0 → 0.05 × 1us');
    await page.locator('#cursorAInput').fill('0.022');
    await page.locator('#cursorAInput').press('Tab');
    expect((await env.viewer.ui('snapshot')).cursorA).toBe(22);
    await env.run('wvSetWindowTimeUnit 10 ns');
    await expect(units).toHaveValue('10ns');
    await units.selectOption('');
    await expect(page.locator('#cursorAInput')).toHaveValue('22');

    const {signals} = await env.viewer.backend.request('scopeSignals', {query:'tb.dut'});
    const signal = signals.find((entry) => entry.name === 'data[7:0]');
    await env.send({type:'sidebarAdd', signals:[signal], editAnnotation:true});
    await expect(page.locator('#annotationForm')).toBeVisible();
    await page.locator('#annotationTags').fill('bus');
    await page.locator('#annotationForm button[type=submit]').click();
    await expect(page.locator('.row.active')).toHaveAttribute('title', /#bus/);
  } finally {
    env.dispose();
  }
});

test('narrow bus cells render compact values on the canvas and in PNG', async ({page}) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wave-bus-label-'));
  const filename = path.join(directory, 'narrow.vcd');
  fs.writeFileSync(filename, [
    '$timescale 1 ns $end', '$scope module top $end',
    '$var wire 32 v bus [31:0] $end', '$upscope $end', '$enddefinitions $end',
    '#0', 'b101 v', '#50', 'b' + (0xF7ADBEEF).toString(2) + ' v',
    '#100', 'b110 v', '#1000', '',
  ].join('\n'));
  await page.setViewportSize({width: 1100, height: 700});
  await page.addInitScript(() => {
    const fillText = CanvasRenderingContext2D.prototype.fillText;
    window.drawnLabels = [];
    CanvasRenderingContext2D.prototype.fillText = function (label, ...args) {
      window.drawnLabels.push({label: String(label), viewer: this.canvas.id === 'canvas'});
      return fillText.call(this, label, ...args);
    };
  });
  const env = await setup(page, filename);
  const labels = (viewer) => page.evaluate(
    viewer => window.drawnLabels.filter(entry => entry.viewer === viewer).map(entry => entry.label),
    viewer,
  );
  try {
    await env.run('wvAddSignal {/top/bus[31:0]}');
    await expect(page.locator('.row .value')).toHaveText('00000005');
    await expect.poll(() => labels(true)).toContain('5');
    await expect.poll(async () => (await labels(true)).some(label => /^…[A-F]*F$/.test(label))).toBe(true);
    await expect.poll(() => labels(true)).toContain('00000006');
    const {collectClip} = require('../dist/wave-clip');
    const clip = await collectClip(env.viewer, {}, true);
    await env.viewer.ui('renderClipImage', clip);
    expect((await labels(false)).some(label => /^…[A-Fa-f]*f$/i.test(label))).toBe(true);

    await page.locator('#displayMenu summary').click();
    await page.evaluate(() => { window.drawnLabels.length = 0; });
    await page.getByLabel('总线格数值').selectOption('full');
    expect(await env.run('waveBusLabels')).toBe('full');
    await expect.poll(() => labels(true)).toContain('00000006');
    expect(await labels(true)).not.toContain('5');
    expect((await labels(true)).some(label => label.startsWith('…'))).toBe(false);
    expect(await env.run('waveBusLabels auto')).toBe('auto');
    await expect(page.getByLabel('总线格数值')).toHaveValue('auto');
    await expect.poll(() => labels(true)).toContain('5');
  } finally {
    env.dispose();
    fs.rmSync(directory, {recursive: true, force: true});
  }
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
    const tooltipToggle = page.getByRole('checkbox', {name: '悬停提示'});
    await tooltipToggle.uncheck();
    await expect(tooltipToggle).not.toBeChecked();
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
    const divider = page.getByRole('separator', {name:'调整信号名与数值列宽度'});
    const dividerBounds = await divider.boundingBox();
    await page.mouse.move(dividerBounds.x + 4, dividerBounds.y + 12);
    await page.mouse.down();
    await page.mouse.move(dividerBounds.x - 66, dividerBounds.y + 12, {steps:5});
    await page.mouse.up();
    await expect(divider).toHaveAttribute('aria-valuenow', '160');
    await env.run('wvZoom 10 40; wvSetCursor 20; wvSetMarker -name Result 30; waveBusLabels full');
    const state = await env.viewer.ui('snapshot');
    const filename = path.join(directory, 'demo.waveproj');
    await saveWaveProject(filename, file, state);
    await divider.dblclick({position:{x:4,y:12}});
    await expect(divider).toHaveAttribute('aria-valuenow', '90');
    await env.run('waveGroup move B A after; waveTooltip 1; waveLayout 32 30; waveBusLabels auto; wvZoomAll');
    await expect(tooltipToggle).toBeChecked();
    const project = await readWaveProject(filename);
    expect(project.waveform).toBe(file);
    await env.viewer.ui('restoreView', await restoreView(env.viewer.backend, project.view, env.viewer.meta));
    const restored = await env.viewer.ui('snapshot');
    expect(restored.groupOrder).toEqual(['B', 'A']);
    expect(restored.activeGroup).toBe('A');
    expect(restored.tooltipEnabled).toBe(false);
    expect(restored.busLabelMode).toBe('full');
    await expect(tooltipToggle).not.toBeChecked();
    expect(restored.rowHeight).toBe(48);
    expect(restored.namesFraction).toBe(state.namesFraction);
    expect(restored.valueFraction).toBe(state.valueFraction);
    await expect(divider).toHaveAttribute('aria-valuenow', '160');
    expect(restored.markers).toEqual(state.markers);
    expect([restored.start, restored.end, restored.cursorA]).toEqual([10, 40, 20]);
  } finally {
    env.dispose();
    fs.rmSync(directory, {recursive: true, force: true});
  }
});

test('decoder and annotation bindings survive a waveform project round trip', async ({page}) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wave-decoder-'));
  const filename = path.join(directory, 'instructions.vcd');
  fs.writeFileSync(filename, [
    '$timescale 1 ns $end', '$scope module top $end',
    '$var wire 32 i instr [31:0] $end', '$var wire 1 v valid $end',
    '$upscope $end', '$enddefinitions $end',
    '#0', 'b' + (0x18c58553).toString(2) + ' i', '1v',
    '#20', 'b' + (0x00128293).toString(2) + ' i', '#40', '',
  ].join('\n'));
  const env = await setup(page, filename);
  try {
    const name = '{/top/instr[31:0]}';
    await env.run(`wvAddSignal ${name} /top/valid; wvSelectSignal ${name}; waveDecode set ${name} rv32-zfinx`);
    const row = page.locator('.row').first();
    await expect(row.locator('.value')).toHaveText('fdiv.s x10, x11, x12, rne');
    await env.run('wvSelectSignal /top/valid');
    const edit = row.getByRole('button', {name:'编辑 instr[31:0] 的标签和注释'});
    const otherEdit = page.locator('.row').nth(1).getByRole('button', {name:'编辑 valid 的标签和注释'});
    expect((await edit.boundingBox()).x).toEqual((await otherEdit.boundingBox()).x);
    await edit.click();
    await expect(page.locator('#annotationSignal')).toHaveText('instr[31:0]');
    await page.getByLabel('标签（逗号分隔）').fill('CV32, ID, CV32');
    await page.getByLabel('注释', {exact: true}).fill('IF/ID 指令\n参照 valid。');
    await page.getByRole('button', {name:'保存标签和注释'}).click();
    await expect(row).toHaveAttribute('title', /#CV32 #ID/);
    await expect(row.locator('.signalTags')).toHaveCount(0);
    await page.locator('#displayMenu summary').click();
    const inlineTags = page.getByRole('checkbox', {name: '在信号名旁显示标签'});
    const decodedValues = page.getByRole('checkbox', {name: '显示解码值'});
    await expect(inlineTags).not.toBeChecked();
    await expect(decodedValues).toBeChecked();
    await inlineTags.check();
    await expect(row.locator('.signalTags .tagBadge')).toHaveText(['#CV32', '#ID']);
    await env.viewer.ui('tagAppearance', {style: 'dot', tag: 'CV32', color: '#123456'});
    await expect(row.locator('.tagStyle-dot')).toBeVisible();
    await expect(row.locator('.tagBadge').first()).toHaveCSS('--tag-color', '#123456');
    await expect(row.locator('.value')).toHaveText('fdiv.s x10, x11, x12, rne');
    await decodedValues.uncheck();
    await expect(row.locator('.value')).toHaveText('18C58553');
    await expect(row.locator('.signalTags .tagBadge')).toHaveText(['#CV32', '#ID']);
    await page.locator('#displayMenu summary').click();
    await page.locator('#toggleFilter').click();
    await page.locator('#filterSignals').fill('tag:ID');
    await expect(page.locator('.row')).toHaveCount(1);
    const events = JSON.parse(await env.run(`waveDecodeEvents ${name} 0 39`));
    expect(events.events.map(event => event[2])).toEqual(['fdiv.s x10, x11, x12, rne', 'addi x5, x5, 1']);
    const {saveWaveProject, readWaveProject} = require('../dist/project');
    const {restoreView} = require('../dist/view-state');
    const project = path.join(directory, 'instructions.waveproj');
    await saveWaveProject(project, filename, await env.viewer.ui('snapshot'));
    await page.locator('#displayMenu summary').click();
    await inlineTags.uncheck();
    await decodedValues.check();
    await page.locator('#displayMenu summary').click();
    await env.run(`waveDecode clear ${name}; waveAnnotate ${name} {} {}`);
    const view = await restoreView(env.viewer.backend, (await readWaveProject(project)).view, env.viewer.meta);
    await env.viewer.ui('restoreView', view);
    await expect(row.locator('.value')).toHaveText('18C58553');
    await expect(row.locator('.signalTags .tagBadge')).toHaveText(['#CV32', '#ID']);
    await expect(row.locator('.tagStyle-dot')).toBeVisible();
    await expect(row.locator('.tagBadge').first()).toHaveCSS('--tag-color', '#123456');
    await expect(row).toHaveAttribute('title', /参照 valid。/);
    await page.locator('#displayMenu summary').click();
    await expect(inlineTags).toBeChecked();
    await expect(decodedValues).not.toBeChecked();
    await decodedValues.check();
    await expect(row.locator('.value')).toHaveText('fdiv.s x10, x11, x12, rne');

    await page.locator('#decoderMenu > summary').click();
    await expect(page.locator('#decoderSelection')).toContainText('Zfinx');
    await page.getByRole('button', {name: '编辑此信号的自定义规则…'}).click();
    const editor = page.locator('#decoderForm');
    await editor.getByLabel('规则名称').fill('自定义指令');
    await editor.getByLabel('掩码').fill('0');
    await editor.getByLabel('显示文本').fill('未知操作');
    await editor.getByRole('button', {name: '添加规则'}).click();
    const second = editor.locator('#decoderRules tr').nth(1);
    await second.getByLabel('掩码').fill('0x100000000');
    await second.getByLabel('匹配值').fill('0x18C58553');
    await second.getByLabel('显示文本').fill('除法 rd={11:7:dec}');
    await editor.getByRole('button', {name: '应用到信号'}).click();
    await expect(editor.locator('#decoderError')).toContainText('超出位宽');
    await expect(row.locator('.value')).toHaveText('fdiv.s x10, x11, x12, rne');
    await second.getByLabel('掩码').fill('0xFFFFFFFF');
    await second.getByRole('button', {name: '上移规则'}).click();
    await editor.getByRole('button', {name: '应用到信号'}).click();
    await expect(editor).toBeHidden();
    await expect(row.locator('.value')).toHaveText('除法 rd=10');
    await saveWaveProject(project, filename, await env.viewer.ui('snapshot'));
    const savedRules = (await readWaveProject(project)).view.chosen[0].decoder.rules;
    expect(savedRules.map(rule => rule.label)).toEqual(['除法 rd={11:7:dec}', '未知操作']);
    await page.locator('#decoderMenu > summary').click();
    await expect(page.locator('#decoderSelection')).toContainText('自定义指令');
    await page.getByRole('button', {name: '清除解码'}).click();
    await expect(row.locator('.value')).toHaveText('18C58553');
  } finally {
    env.dispose();
    fs.rmSync(directory, {recursive: true, force: true});
  }
});

test('decoder menu lists rule files and applies edited copies of built-in rules', async ({page}) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wave-decoder-files-'));
  const config = path.join(directory, 'wave-decoders.json');
  const groupDirectory = path.join(directory, 'wave-decoders');
  fs.mkdirSync(groupDirectory);
  const workspaceFile = path.join(groupDirectory, 'example.json');
  fs.writeFileSync(workspaceFile, JSON.stringify({
    version: 1, label: '工作区字节', profiles: [{
      id: 'workspace-data', label: '工作区数据', width: 8,
      rules: [{mask:'0x0', value:'0x0', label:'通道 {3:0:dec}'}],
    }],
  }));
  const env = await setup(page, path.resolve(__dirname, '../examples/demo.vcd'), undefined, config);
  try {
    await env.run('wvAddSignal {/tb/dut/data[7:0]}; wvSetCursor 20');
    const menu = page.locator('#decoderMenu');
    await menu.locator('summary').first().click();
    const uart = menu.locator('details[data-group="builtin/uart"]');
    await uart.locator('summary').click();
    await uart.getByRole('radio', {name:'UART 数据字节'}).check();
    await expect(uart.getByRole('radio', {name:'UART 数据字节'})).toBeChecked();
    await expect(page.locator('.row .value')).toHaveText('UART 0x2a');

    await uart.getByRole('button', {name:'编辑副本… UART 数据字节'}).click();
    const form = page.locator('#decoderForm');
    await form.getByLabel('规则名称').fill('串口副本');
    await form.getByLabel('显示文本').last().fill('串口 {7:0:hex}');
    await form.getByRole('button', {name:'保存副本并应用'}).click();
    await expect(form).toBeHidden();
    await expect(page.locator('.row .value')).toHaveText('串口 0x2a');
    const files = fs.readdirSync(groupDirectory);
    const copy = files.find(name => /^uart-byte-copy-/.test(name));
    expect(copy).toBeTruthy();
    await menu.locator('summary').first().click();
    await expect(menu.locator(`details[data-group="workspace/${copy}"]`).getByRole('radio', {name:'串口副本'})).toBeChecked();
    await uart.locator('summary').click();
    await uart.getByRole('radio', {name:'UART 数据字节'}).check();
    await expect(page.locator('.row .value')).toHaveText('UART 0x2a');

    const workspace = menu.locator('details[data-group="workspace/example.json"]');
    await workspace.locator('summary').click();
    await workspace.getByRole('button', {name:'编辑… 工作区数据'}).click();
    await form.getByLabel('显示文本').fill('数据 {3:0:dec}');
    await form.getByRole('button', {name:'保存并应用'}).click();
    await expect(page.locator('.row .value')).toHaveText('数据 10');
    expect(JSON.parse(fs.readFileSync(workspaceFile)).profiles[0].rules[0].label).toBe('数据 {3:0:dec}');
  } finally {
    env.dispose();
    fs.rmSync(directory, {recursive: true, force: true});
  }
});

test('UART frame parameters and rule branches decode a serial waveform', async ({page}) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wave-uart-'));
  const filename = path.join(directory, 'uart.vcd');
  const events = ['$timescale 1 ns $end', '$scope module top $end', '$var wire 1 u tx $end',
    '$upscope $end', '$enddefinitions $end', '#0', '0u'];
  function frame(start, word, parity) {
    const bits = [0, ...Array.from({length: 7}, (_, i) => (word >> (6 - i)) & 1), parity, 1, 1];
    bits.forEach((bit, i) => events.push('#' + (start + i * 1000), (1 - bit) + 'u'));
  }
  frame(1000, 0x53, 0);
  frame(12000, 0x52, 0);
  events.push('#25000', '');
  fs.writeFileSync(filename, events.join('\n'));
  const env = await setup(page, filename, undefined, path.join(directory, 'wave-decoders.json'));
  try {
    await env.run('wvAddSignal {/top/tx}; wvZoom 4000 22000; wvSetCursor 4500');
    const menu = page.locator('#decoderMenu');
    await menu.locator('summary').first().click();
    const uart = menu.locator('details[data-group="builtin/uart"]');
    await uart.locator('summary').click();
    await uart.getByRole('button', {name:'编辑副本… UART 串行帧 · 115200 8N1'}).click();
    const form = page.locator('#decoderForm');
    await form.getByLabel('波特率').fill('1000000');
    await form.getByLabel('数据位').selectOption('7');
    await form.getByLabel('校验').selectOption('even');
    await form.getByLabel('停止位').selectOption('2');
    await form.getByLabel('位序').selectOption('msb');
    await form.getByRole('checkbox', {name:'反相'}).check();
    await form.getByRole('button', {name:'添加规则'}).click();
    await form.getByLabel('掩码').fill('0');
    await form.getByLabel('显示文本').fill('数据');
    await form.getByText('条件分支', {exact:true}).click();
    await form.getByLabel('条件分支 JSON').fill(JSON.stringify([{
      when:[{mask:'0x40',value:'0x40'},{mask:'0x1',value:'0x1'}],
      label:'命令 {6:0:dec}',
    }]));
    await form.getByRole('button', {name:'保存副本并应用'}).click();
    await expect(page.locator('.row .value')).toHaveText('命令 83');
    const result = JSON.parse(await env.run('waveDecodeEvents {/top/tx} 4000 22000'));
    expect(result.frames).toEqual([
      {start:'1000',end:'12000',word:83,errors:[],label:'命令 83'},
      {start:'12000',end:'23000',word:82,errors:['parity'],label:'数据 · 校验错误'},
    ]);
    expect(result.truncated).toBe(false);
    const project = (await env.viewer.ui('snapshot')).chosen[0].decoder;
    expect(project.uart).toEqual({baud:1000000,dataBits:7,parity:'even',stopBits:2,bitOrder:'msb',inverted:true});
    expect(project.rules[0].branches).toHaveLength(1);
  } finally {
    env.dispose();
    fs.rmSync(directory, {recursive: true, force: true});
  }
});

test('waveform clips preserve initial values, reopen as VCD and return PNG through MCP', async ({page}) => {
  const file = path.resolve(__dirname, '../examples/demo.vcd');
  const env = await setup(page, file);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wave-clip-test-'));
  const {collectClip, serializeClip} = require('../dist/wave-clip');
  const {serveWaveMcp} = require('../dist/mcp');
  const {spawn} = require('node:child_process');
  const readline = require('node:readline');
  const backend = new Backend(path.resolve(__dirname, '../bin/wave-backend'));
  let host;
  let client;
  let replies;
  try {
    await env.run('wvAddSignal -group {CPU {/tb/dut/clk} {/tb/dut/data[7:0]}}; wvSelectSignal {/tb/dut/data[7:0]}');
    await env.run('wvSetCursor 17; wvSetMarker 37');
    const clip = await collectClip(env.viewer, {range: 'cursors'}, true);
    expect(clip.traces).toHaveLength(1);
    expect(clip.traces[0].events).toEqual([['17', '00000000'], ['20', '00101010'], ['30', '11110000']]);
    expect(serializeClip(clip, 'csv')).toContain('"tb.dut.data[7:0]",17,"1ns","00000000",false');
    const filename = path.join(directory, 'clip.vcd');
    fs.writeFileSync(filename, serializeClip(clip, 'vcd'));
    const meta = await backend.request('open', {path: filename});
    expect([meta.start, meta.end, meta.scale]).toEqual(['0', '20', '1ns']);
    const id = meta.signals[0].id;
    const data = await backend.request('query', {signals: [id], start: '0', end: '20', limit: 10});
    expect(data[id].events).toEqual([['0', '00000000'], ['3', '00101010'], ['13', '11110000']]);

    await new Promise((resolve, reject) => {
      host = serveWaveMcp(directory, async (name, args) => {
        if (name === 'wave_list') return {selected: file, views: [file]};
        const segment = await collectClip(env.viewer, args, name === 'wave_clip');
        if (name === 'wave_clip') return segment;
        expect(name).toBe('wave_export');
        return {start: segment.start, imagePng: await env.viewer.ui('renderClipImage', segment)};
      }, (message) => String(message).startsWith('MCP socket ') ? resolve() : reject(Error(message)));
    });
    client = spawn(process.execPath, [path.resolve(__dirname, '../dist/mcp.js'), directory], {stdio: ['pipe', 'pipe', 'inherit']});
    replies = readline.createInterface({input: client.stdout});
    const lines = replies[Symbol.asyncIterator]();
    async function call(id, name, args) {
      client.stdin.write(JSON.stringify({
        jsonrpc: '2.0', id, method: 'tools/call', params: {name, arguments: args},
      }) + '\n');
      const reply = JSON.parse((await lines.next()).value);
      expect(reply.id).toBe(id);
      expect(reply.result.isError, JSON.stringify(reply.result)).toBeUndefined();
      return reply.result.content;
    }
    const args = {start: '17', end: '37', signals: ['/tb/dut/data[5]']};
    const [content] = await call(1, 'wave_clip', args);
    expect(JSON.parse(content.text).traces[0].events).toEqual([['17', '0'], ['20', '1']]);
    const [, png] = await call(2, 'wave_export', {...args, format: 'png'});
    expect(png.mimeType).toBe('image/png');
    expect(Buffer.from(png.data, 'base64').subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    const truncated = await collectClip(env.viewer, {...args, limit: 1}, true);
    expect(truncated.truncated).toBe(true);
  } finally {
    replies?.close();
    client?.stdin.end();
    host?.dispose();
    backend.dispose();
    env.dispose();
    fs.rmSync(directory, {recursive: true, force: true});
  }
});

test('transaction rows accept only the current request and keep bindings across restore', async ({page}) => {
  const env = await setup(page, path.resolve(__dirname, '../examples/demo.vcd'));
  const first = {instanceId: 'first', decoderId: 'sample.lua', engine: 'lua', bindings: {data: 'tb.dut.data[7:0]'}};
  const second = {instanceId: 'second', decoderId: 'sample.javascript', engine: 'javascript', bindings: {data: 'tb.dut.data[7:0]'}};
  const row = index => page.locator('#decoderTracks .decoderTrack').nth(index);
  try {
    await env.viewer.ui('decoderAttach', first);
    await env.viewer.ui('decoderAttach', second);
    await expect.poll(() => env.decoderRequests.length).toBe(2);
    const [a, b] = env.decoderRequests;
    const send = (request, instanceId, label) => env.send({
      type: 'waveDecoderResult', request, instanceId,
      decoded: {transactions: [{start: '12', end: '23', label, fields: {value: '42'}}], warnings: [], truncated: false},
    });
    await send(a.request, 'first', 'Lua transaction');
    await send(b.request, 'second', 'JS transaction');
    await expect(row(0).locator('.decoderTransaction')).toHaveText('Lua transaction');
    await expect(row(1).locator('.decoderTransaction')).toHaveText('JS transaction');
    await row(0).locator('.decoderTransaction').click();
    await expect(page.locator('#cursorAInput')).toHaveValue('12');
    await row(0).getByRole('button', {name: '取消', exact: true}).click();
    await send(a.request, 'first', 'late result');
    await expect(row(0).locator('.decoderTrackStatus')).toHaveText('已取消');
    const snapshot = await env.viewer.ui('snapshot');
    expect(snapshot.decoderInstances).toEqual([first, second]);
    await env.viewer.ui('decoderDetach', {instanceId: 'second'});
    await expect(page.locator('#decoderTracks .decoderTrack')).toHaveCount(1);
    await env.viewer.ui('restoreView', snapshot);
    await expect(page.locator('#decoderTracks .decoderTrack')).toHaveCount(2);
    await expect.poll(() => env.decoderRequests.length).toBe(4);
    expect(env.decoderRequests[2].start).toBe(a.start);
    expect(env.decoderRequests[2].end).toBe(a.end);
    await env.run('wvZoom 10 20');
    await expect.poll(() => env.decoderRequests.at(-1).start).toBe('10');
    expect(env.decoderRequests.at(-1).end).toBe('20');

    const report = process.env.WAVE_DECODER_UI_REPORT;
    if (report) {
      const query = env.decoderRequests.at(-1);
      const results = await page.evaluate(({request, instance}) => {
        const lane = [...document.querySelectorAll('#decoderTracks .decoderTrack')].at(-1);
        return [32, 512, 2048].map(count => {
          const decoded = {transactions: Array.from({length: count}, (_, index) => ({
            start: '12', end: '13', label: String(index),
          })), warnings: [], truncated: false};
          const runs = [];
          for (let index = 0; index < 16; ++index) {
            const started = performance.now();
            window.dispatchEvent(new MessageEvent('message', {data: {
              type: 'waveDecoderResult', request, instanceId: instance.instanceId, decoded,
            }}));
            // Reading the final row forces layout after replacing the rendered transaction nodes.
            lane.querySelector('.decoderTransaction:last-child').getBoundingClientRect();
            if (index) runs.push(performance.now() - started);
          }
          runs.sort((a, b) => a - b);
          const at = q => runs[Math.ceil(q * runs.length) - 1];
          return {count, p50: at(0.5), p95: at(0.95), p99: at(0.99)};
        });
      }, query);
      fs.writeFileSync(report, JSON.stringify({chromium: page.context().browser().version(), repeats: 15, results}, null, 2) + '\n');
    }
  } finally {
    env.dispose();
  }
});

test('mixed wave rows preserve real cursor values and Tcl range measurements', async ({page}) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wave-real-ui-'));
  const filename = path.join(directory, 'mixed.vcd');
  fs.writeFileSync(filename, [
    '$timescale 1ns $end', '$scope module tb $end', '$var real 64 ! voltage $end',
    '$var wire 1 " ready $end', '$upscope $end', '$enddefinitions $end',
    '#0', 'r-0.125 !', '0"', '#4', 'r0.125 !', '#9', 'r0.9 !', '1"', '#17',
  ].join('\n') + '\n');
  const env = await setup(page, filename);
  try {
    await env.run('wvAddSignal /tb/voltage /tb/ready; wvSetCursor 9');
    await expect(page.locator('.row').nth(0).locator('.value')).toHaveText('0.9');
    await expect(page.locator('.row').nth(1).locator('.value')).toHaveText('1');
    expect(await env.run('wvGetSigValueByTime /tb/voltage -time 1')).toBe('-0.125');
    const stats = JSON.parse(await env.run('waveMeasureAnalog /tb/voltage 0 9'));
    expect(stats).toMatchObject({min: -0.125, max: 0.125, rms: 0.125, coveredTicks: '9'});
  } finally {
    env.dispose();
    fs.rmSync(directory, {recursive: true, force: true});
  }
});

async function openSchematic(page) {
  await page.addInitScript(() => { window.acquireVsCodeApi = () => ({postMessage: window.bridge}); });
  await page.route('http://schematic.test/**', async route => {
    const name = new URL(route.request().url()).pathname.slice(1) || 'schematic.html';
    if (!['schematic.html', 'schematic.js', 'schematic.css'].includes(name)) return route.abort();
    let body = fs.readFileSync(path.resolve(__dirname, name.endsWith('.js') ? '../dist/webview' : '../media', name), 'utf8');
    if (name === 'schematic.html') body = body.replaceAll('{{csp}}', 'http://schematic.test').replaceAll('{{nonce}}', 'testnonce').replace('{{css}}', '/schematic.css').replace('{{script}}', '/schematic.js');
    await route.fulfill({body, contentType: name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html'});
  });
  await page.goto('http://schematic.test/');
}

test('local RTL schematic lays out data and control and dispatches cross-probe actions', async ({page}) => {
  const messages = [];
  await page.exposeFunction('bridge', async message => {
    messages.push(message);
    if (message.type === 'ready' || message.type === 'follow' || message.type === 'back' || message.type === 'refresh') {
      await page.evaluate(({action, revision}) => window.dispatchEvent(new MessageEvent('message', {data: {
        type: 'schematic', title: action === 'follow' ? 'tb.a' : 'tb.q', revision, canGoBack: action === 'follow', graph: {
          root: action === 'follow' ? 'a' : 'q', partial: false,
          nodes: [
            {id: 'a', label: 'a', detail: 'tb', kind: 'signal', wave: true, source: true},
            {id: 'clk', label: 'clk', detail: 'tb', kind: 'signal', wave: true},
            {id: 'dff', label: 'DFF', detail: '', kind: 'register'},
            {id: 'q', label: 'q', detail: 'tb · 1', kind: 'signal', wave: true},
          ],
          edges: [{from: 'a', to: 'dff'}, {from: 'clk', to: 'dff', control: true}, {from: 'dff', to: 'q'}],
        },
      }})), {action: message.type, revision: (message.revision ?? -1) + 1});
    }
  });
  await openSchematic(page);
  await expect(page.locator('svg .node')).toHaveCount(4);
  await expect(page.locator('svg .edge.control')).toHaveCount(1);
  const scene = page.locator('#scene');
  const bounds = await scene.boundingBox();
  const viewBox = async () => (await page.locator('#diagram').getAttribute('viewBox')).split(' ').map(Number);
  const before = await viewBox();
  await page.mouse.move(bounds.x + bounds.width * 0.4, bounds.y + bounds.height * 0.3);
  await page.mouse.wheel(0, -160);
  await expect.poll(async () => (await viewBox())[2]).toBeLessThan(before[2]);
  const zoomed = await viewBox();
  expect(zoomed[0] + zoomed[2] * 0.4).toBeCloseTo(before[0] + before[2] * 0.4, 0);
  expect(zoomed[1] + zoomed[3] * 0.3).toBeCloseTo(before[1] + before[3] * 0.3, 0);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width * 0.4 + 60, bounds.y + bounds.height * 0.3 + 35, {steps: 4});
  await page.mouse.up();
  const shifted = await viewBox();
  expect(shifted[0]).toBeLessThan(zoomed[0]);
  expect(shifted[1]).toBeLessThan(zoomed[1]);
  expect(shifted[2]).toBeCloseTo(zoomed[2]);
  await page.getByRole('button', {name: '适应视图'}).click();
  expect(await viewBox()).toEqual(before);
  await page.getByRole('button', {name: 'a', exact: true}).click();
  await page.getByRole('button', {name: '查看源码'}).click();
  await page.getByRole('button', {name: '加入波形'}).click();
  await expect.poll(() => messages.slice(1)).toEqual([{type: 'source', id: 'a', revision: 0}, {type: 'wave', id: 'a', revision: 0}]);
  await page.getByRole('button', {name: '展开上游'}).click();
  await expect(page.locator('#title')).toHaveText('tb.a');
  await expect(page.locator('svg .node')).toHaveCount(4);
  await expect(page.locator('svg .node.root')).toHaveAttribute('aria-label', 'a');
  await page.getByRole('button', {name: '返回'}).click();
  await expect(page.locator('svg .node.root')).toHaveAttribute('aria-label', 'q');
  await page.getByRole('button', {name: '刷新 A 游标'}).click();
  await expect.poll(() => messages.at(-1)).toEqual({type: 'refresh', revision: 2});
  await expect(page.locator('svg .node')).toHaveCount(4);
});

test('dense trace renders visible nodes and keeps pan and zoom interactive', async ({page}) => {
  const nodes = Array.from({length: 800}, (_, id) => ({
    id: String(id), kind: 'signal', label: 'net' + id, detail: 'tb.dut',
  }));
  const edges = [];
  for (let id = 1; id < nodes.length; id++) {
    edges.push({from: String(id), to: String(Math.floor((id - 1) / 4))});
    for (let offset = 1; offset <= 9; offset++)
      edges.push({from: String(id), to: String((id + offset) % nodes.length)});
  }
  await page.exposeFunction('bridge', message => {
    if (message.type === 'ready') return page.evaluate(graph => {
      window.dispatchEvent(new MessageEvent('message', {data: {
        type: 'schematic', traceSnapshot: true, title: 'Dense trace', graph,
      }}));
    }, {nodes, edges, root: '0', partial: false});
  });
  await openSchematic(page);
  await expect(page.locator('#trace-edges')).toBeVisible();
  await expect(page.getByRole('button', {name: 'net0', exact: true})).toBeVisible();
  await expect(page.locator('svg .edge')).toHaveCount(0);
  expect(await page.locator('svg .node').count()).toBeLessThan(160);
  const view = await page.locator('#diagram').getAttribute('viewBox');
  const scene = page.locator('#scene');
  await scene.hover();
  await page.mouse.wheel(0, -120);
  await expect(page.locator('#diagram')).not.toHaveAttribute('viewBox', view);
  const zoomed = await page.locator('#diagram').getAttribute('viewBox');
  await page.mouse.down();
  await page.mouse.move(800, 500, {steps: 5});
  await page.mouse.up();
  await expect(page.locator('#diagram')).not.toHaveAttribute('viewBox', zoomed);
  await page.getByRole('button', {name: '适应视图'}).click();
  await expect(page.locator('#status')).toContainText('放大查看连线');
});

test('module schematic draws named pins and navigates hierarchy', async ({page}) => {
  const messages = [];
  const module = {
    id: 'module:top.dut', label: 'dut', detail: 'leaf', kind: 'module',
    ports: [{id: 'd', label: 'd', direction: 'input'}, {id: 'q', label: 'q', direction: 'output'}],
    source: true,
  };
  const input = {id: 'data', label: 'data', detail: 'input', kind: 'port', direction: 'input'};
  await page.exposeFunction('bridge', async message => {
    messages.push(message);
    const leaf = message.type === 'enter';
    const instance = leaf ? 'top.dut' : 'top';
    if (['ready', 'enter', 'parent', 'back'].includes(message.type)) {
      await page.evaluate(data => window.dispatchEvent(new MessageEvent('message', {data})), {
        type: 'schematic', title: instance, revision: (message.revision ?? -1) + 1, canGoBack: leaf,
        graph: {
          root: '', partial: false, module: {instance, name: leaf ? 'leaf' : 'top', parent: leaf ? 'top' : undefined},
          nodes: leaf ? [input] : [input, module],
          edges: leaf ? [] : [{from: 'data', to: module.id, toPort: 'd', label: '[7:4]'}],
        },
      });
    }
  });
  await openSchematic(page);
  await expect(page.getByText('[7:4]', {exact: true})).toBeVisible();
  await expect(page.locator('.node.module .pin text')).toHaveText(['d', 'q']);
  await expect(page.getByRole('button', {name: '刷新 A 游标'})).toBeHidden();
  await page.getByRole('button', {name: 'dut', exact: true}).click();
  await expect(page.locator('.edge.active')).toHaveCount(1);
  await page.getByRole('button', {name: '查看源码'}).click();
  await expect.poll(() => messages.at(-1)).toEqual({type: 'source', id: module.id, revision: 0});
  const moduleBox = await page.getByRole('button', {name: 'dut', exact: true}).boundingBox();
  await page.mouse.move(moduleBox.x + moduleBox.width / 2, moduleBox.y + moduleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(moduleBox.x + moduleBox.width / 2 + 43, moduleBox.y + moduleBox.height / 2 + 15, {steps: 4});
  await page.mouse.up();
  expect(messages.some(({type}) => type === 'enter')).toBe(false);
  await page.getByRole('button', {name: 'dut', exact: true}).dblclick();
  await expect(page.locator('#title')).toHaveText('top.dut');
  await expect(page.locator('.node.module')).toHaveCount(0);
  await page.getByRole('button', {name: '上一级'}).click();
  await expect(page.locator('.node.module')).toHaveCount(1);
  await expect(page.locator('#title')).toHaveText('top');
});
