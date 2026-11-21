// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

const {test,expect}=require('@playwright/test');
const fs=require('node:fs'),path=require('node:path');
const {Sidebar}=require('../dist/sidebar'),{Backend}=require('../dist/backend'),{TclRunner}=require('../dist/tcl'),{WaveCommands}=require('../dist/commands');
test('sidebar UI: real Tcl/VCD result, history, target selection, action buttons, errors and focus state',async({page})=>{
  const root=path.resolve(__dirname,'..'),backend=new Backend(path.join(root,'bin/wave-backend'));let tagState, receive,selected='a',actions=[],treeActions=[],expanded=false,coreExpanded=false,scope='',includeOther=false;
  const uri=fsPath=>({fsPath,toString(){return fsPath;}}),sessions=[{id:'a',title:'demo.vcd',ready:true,kdb:''},{id:'b',title:'second.vcd',ready:true,kdb:''}];
  const viewer={uri:uri(path.join(root,'examples/demo.vcd')),backend,meta:await backend.request('open',{path:path.join(root,'examples/demo.vcd')}),ui:async()=>({displayScale:null})};
  let sidebar;const engine=new WaveCommands({getViewer:()=>viewer});const runner=new TclRunner((name,args)=>engine.execute(name,args),{log:text=>sidebar.log(text,selected)});
  const context={extensionUri:uri(root),asAbsolutePath:p=>path.join(root,p)};
  const vscode={Uri:{joinPath:(base,...parts)=>uri(path.join(base.fsPath,...parts))}};
  sidebar=new Sidebar(vscode,context,{state:()=>({sessions,activeId:selected,scope,includeOther,tagState,tree:[{fullname:'top',module:'top_module',kind:'npiModule',depth:0,expanded},...(includeOther?[{fullname:'top.link',module:'link_if',kind:'npiInterface',depth:0},{fullname:'top.gen_fpu',kind:'npiGenScope',depth:1},{fullname:'fpu_pkg',kind:'npiPackage',depth:0}]:[]),...(expanded?[{fullname:'top.core',module:'core_module',kind:'npiModule',depth:1,expanded:coreExpanded}]:[])]}),scopeSignals:async m=>({...await backend.request('scopeSignals',{query:m.scope==='top.core'?'tb.dut':m.scope,offset:m.offset,limit:m.limit||512}),scope:m.scope}),addSignals:async (signals,edit)=>actions.push(...signals.map(s=>edit?'edit:'+s.name:s.name)),
    searchSignals:(query,offset)=>backend.request('search',{query,offset,limit:32}),
    taggedFocus:async signal=>actions.push(signal.id),
    tagAppearance:async ({style,tag,color})=>{
      if(style) tagState.tagStyle=style;
      if(tag) tagState.tagColors[tag]=color;
    },tree:async(value,action)=>{treeActions.push({scope:value,action});if(action==='mode')includeOther=value==='all';else if(action==='expand'){if(value==='top.core')coreExpanded=!coreExpanded;else expanded=!expanded;}else scope='tb.dut';},select:id=>{selected=id;},action:async action=>actions.push(action),execute:async script=>{sidebar.log('> '+script,selected);try{sidebar.log(await runner.run(script),selected);}catch(e){sidebar.log('ERROR: '+e.message,selected);e.sidebarLogged=true;throw e;}}});
  const view={visible:true,onDidDispose(){},onDidChangeVisibility(){},webview:{cspSource:'http://sidebar.test',asWebviewUri:u=>({toString:()=>'/'+path.basename(u.fsPath)}),onDidReceiveMessage:fn=>{receive=fn;},postMessage:async m=>page.evaluate(m=>window.dispatchEvent(new MessageEvent('message',{data:m})),m)}};
  sidebar.resolveWebviewView(view);
  await page.exposeFunction('bridge',m=>receive(m));
  await page.addInitScript(()=>{window.acquireVsCodeApi=()=>({getState:()=>({draft:''}),setState(){},postMessage:m=>window.bridge(m)});});
  await page.route('http://sidebar.test/**',async route=>{const name=new URL(route.request().url()).pathname.slice(1);if(!['','sidebar.css','sidebar.js'].includes(name)){await route.abort();return;}await route.fulfill({body:name?fs.readFileSync(path.join(root,name.endsWith('.js')?'dist/webview':'media',name),'utf8'):view.webview.html,contentType:name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html'});});
  try{
    await page.setViewportSize({width:360,height:900});await page.goto('http://sidebar.test/');await expect(page.locator('#session option')).toHaveCount(2);await expect(page.locator('.instanceRow')).toHaveCount(1);await expect(page.locator('.objectIcon.module')).toHaveCount(1);await page.locator('.expand').click();await expect(page.locator('.instanceRow')).toHaveCount(2);await expect(page.locator('.instanceRow').nth(1)).toHaveCSS('padding-left','16px');await page.locator('.instanceName').filter({hasText:'core'}).click();expect(treeActions.at(-1)).toEqual({scope:'top.core',action:'select'});await expect(page.locator('#signalRows button')).toHaveCount(4);await page.locator('#signalRows button').filter({hasText:'data'}).dblclick();await expect.poll(()=>actions).toContain('data[7:0]');
    await page.getByRole('searchbox',{name:'搜索波形信号'}).fill('tb.dut.clk');
    await page.locator('#sidebarSearchRows button').filter({hasText:'clk'}).click();
    await expect.poll(()=>actions).toContain('clk');
    await page.getByRole('searchbox',{name:'搜索波形信号'}).fill('');
    await expect(page.locator('#sidebarSearchResults')).toBeHidden();
    const data = (await backend.request('scopeSignals',{query:'tb.dut'})).signals.find(signal=>signal.name==='data[7:0]');
    tagState={tagStyle:'pill',tagColors:{Bus:'#20a080'},taggedSignals:[
      {...data,instanceScope:'top.core',tags:['Bus','TX']},
    ]};
    await sidebar.refresh();
    await expect(page.locator('#taggedRows .tagBadge')).toHaveText(['#Bus','#TX']);
    await expect(page.locator('.instanceRow').nth(1).locator('.instanceTags .tagBadge')).toHaveCount(2);
    await expect(page.locator('#signalRows button').filter({hasText:'data'}).locator('.tagBadge')).toHaveCount(2);
    await page.getByLabel('显示信号', {exact:true}).check();
    await page.getByTitle('展开/折叠 top.core', {exact:true}).click();
    const treeSignal = page.locator('.treeSignal').filter({hasText:'data[7:0]'});
    await expect(treeSignal.locator('.tagBadge')).toHaveText(['#Bus','#TX']);
    await treeSignal.getByRole('button',{name:'编辑 data[7:0] 的标签和注释'}).click();
    await expect.poll(()=>actions).toContain('edit:data[7:0]');
    await page.getByLabel('显示信号', {exact:true}).uncheck();
    await expect(page.locator('.treeSignal')).toHaveCount(0);
    await page.getByRole('combobox',{name:'筛选标签'}).selectOption('Bus');
    await page.getByLabel('标签颜色').fill('#3366ff');
    await expect(page.locator('#taggedRows .tagBadge').first()).toHaveCSS('--tag-color','#3366ff');
    await page.getByRole('combobox',{name:'标签样式'}).selectOption('dot');
    await expect(page.locator('#taggedRows .tagStyle-dot')).toHaveCount(1);
    await page.locator('#taggedRows .taggedSignal').click();
    await expect.poll(()=>actions).toContain(data.id);
    tagState.tagStyle = 'pill';
    tagState.taggedSignals[0].tags.push('pipeline_stage_'.repeat(8) + 'TAIL');
    await sidebar.refresh();
    const signalPane = page.locator('#sidebarSignals');
    await expect.poll(() => signalPane.evaluate(el => el.scrollWidth - el.clientWidth)).toBeGreaterThan(100);
    await signalPane.evaluate(el => { el.scrollLeft = el.scrollWidth; });
    await expect.poll(() => signalPane.evaluate(el => el.scrollLeft)).toBeGreaterThan(100);
    await page.locator('#showOtherObjects').check();await expect(page.locator('.objectIcon.interface')).toHaveCount(1);await expect(page.locator('.objectIcon.interface')).toHaveAttribute('aria-label','npiInterface');await page.screenshot({path:'test-results/sidebar-line-icons.png'});await page.locator('#showOtherObjects').uncheck();await expect(page.locator('.objectIcon.interface')).toHaveCount(0);
    await page.locator('#sidebarConsole summary').click();
    await page.locator('#input').fill('set n 7; puts {sidebar output}; wvGetSigValueByTime {/tb/dut/data[7:0]} -time 20 -format Hex');await page.locator('#input').press('Control+Enter');
    await expect(page.locator('#output')).toContainText('sidebar output');await expect(page.locator('#output')).toContainText('2a');await expect(page.locator('#execute')).toBeEnabled();
    await page.locator('#session').selectOption('b');await expect.poll(()=>selected).toBe('b');
    await page.locator('#input').fill('expr {7+1}');await page.locator('#execute').click();await expect(page.locator('#output .entry').last()).toContainText('8');
    await page.locator('#history').selectOption({index:2});await expect(page.locator('#input')).toHaveValue(/set n 7/);
    await page.locator('.sidebarMenu summary').filter({hasText:'文件'}).click();
    await page.locator('[data-action="openPicker"]').click();await expect.poll(()=>actions).toContain('openPicker');
    await page.locator('#input').fill('wvNoSuchCommand');await page.locator('#execute').click();await expect(page.locator('#output .entry').last()).toContainText('ERROR: Unsupported');await expect(page.locator('#execute')).toBeEnabled();
    await page.screenshot({path:'test-results/sidebar-console.png'});
    await page.locator('#clear').click();await expect(page.locator('#output .entry')).toHaveCount(0);await expect(page.locator('#history option')).toHaveCount(4);
    await page.evaluate(()=>window.dispatchEvent(new MessageEvent('message',{data:{type:'state',executing:0,sessions:[{id:'a',title:'demo.vcd',ready:true}],activeId:'a',scope:'',logs:[],history:[],revealScope:'top.n95',revealId:1,tree:Array.from({length:100},(_,i)=>({fullname:'top.n'+i,kind:'npiModule',module:'block',depth:1,selected:i===95}))}})));
    await expect(page.locator('.instanceRow.selected .instanceName')).toHaveText('n95');await expect(page.locator('.instanceRow.selected')).toBeVisible();expect(await page.locator('#instanceTree').evaluate(e=>e.scrollTop)).toBeGreaterThan(0);

  }finally{runner.dispose();backend.dispose();}
});
