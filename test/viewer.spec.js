async function clickTool(page,selector){const target=page.locator(selector),parent=target.locator('xpath=ancestor::details[contains(@class,"toolMenu")]');if(await parent.count()&&!await parent.evaluate(e=>e.open)){await parent.locator('summary').click();}await target.click();}
const {test,expect}=require('@playwright/test');
const fs=require('node:fs');const path=require('node:path');const {Backend}=require('../dist/backend');
test('native-backed webview: tree, bus, zoom, cursors, edge, source, remove and state',async({page})=>{
  const backend=new Backend(path.resolve(__dirname,'../bin/wave-backend'));
  const errors=[];page.on('pageerror',e=>errors.push(e.message));let state,source;
  await page.exposeFunction('bridge',async message=>{
    let reply;
    if(message.type==='ready')reply={type:'metadata',...await backend.request('open',{path:path.resolve(__dirname,'../examples/demo.vcd')}),title:'demo.vcd',vide:'1.2.5'};
    else if(message.type==='query')reply={type:'data',request:message.request,result:await backend.request('query',{signals:message.signals,start:String(message.start),end:String(message.end),limit:20000})};
    else if(message.type==='search')reply={type:'searchResult',request:message.request,...await backend.request('search',{query:message.query,offset:message.offset,limit:message.limit})};
    else if(message.type==='source')source=message;
    if(reply)await page.evaluate(msg=>window.dispatchEvent(new MessageEvent('message',{data:msg})),reply);
  });
  await page.exposeFunction('saveState',s=>{state=s;});
  await page.addInitScript(()=>{window.acquireVsCodeApi=()=>({getState:()=>null,setState:s=>window.saveState(s),postMessage:m=>window.bridge(m)});});
  await page.route('http://wave.test/**',async route=>{
    const name=new URL(route.request().url()).pathname.slice(1)||'index.html';
    if(!['index.html','wave.js','wave.css'].includes(name)){await route.abort();return;}
    let body=fs.readFileSync(path.resolve(__dirname,name.endsWith('.js')?'../dist/webview':'../media',name),'utf8');
    if(name==='index.html')body=body.replaceAll('{{csp}}',"http://wave.test").replaceAll('{{nonce}}','testnonce').replace('{{css}}','/wave.css').replace('{{script}}','/wave.js');
    await route.fulfill({body,contentType:name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html'});
  });
  try{
    await page.goto('http://wave.test/');
    await expect(page.locator('#backend')).toContainText('rust-vcd · Vide 1.2.5');
    const rootScope=page.locator('#treeViewport .scope[title="tb"]'),childScope=page.locator('#treeViewport .scope[title="tb.dut"]'),clock=page.locator('.leaf').filter({hasText:'+ clk'});
    await expect(rootScope).toHaveCSS('padding-left','8px');await expect(childScope).toHaveCSS('padding-left','24px');await expect(clock).toHaveCSS('padding-left','40px');
    await childScope.click({position:{x:28,y:12}});await expect(clock).toHaveCount(0);await childScope.click({position:{x:28,y:12}});await expect(clock).toHaveCSS('padding-left','40px');
    // VS Code injects theme variables and changes body theme attributes at runtime.
    async function setTheme(kind,values){await page.evaluate(({kind,values})=>{document.body.className=kind;document.body.style.cssText='';for(const [name,value] of Object.entries(values))document.body.style.setProperty('--vscode-'+name,value);document.body.dataset.vscodeThemeId=kind;},{kind,values});}
    const light={'editor-background':'#ffffff','sideBar-background':'#f3f3f3','foreground':'#242424','descriptionForeground':'#555555','input-background':'#ffffff','input-foreground':'#242424','panel-border':'#cccccc','charts-green':'#187a38','charts-blue':'#005fb8','editorIndentGuide-background1':'#dddddd','errorForeground':'#b00020','editorWarning-foreground':'#795e00','charts-purple':'#812da8','list-activeSelectionBackground':'#005fb8','list-activeSelectionForeground':'#ffffff'};
    await setTheme('vscode-light',light);await expect(page.locator('body')).toHaveCSS('background-color','rgb(255, 255, 255)');await expect(page.locator('aside')).toHaveCSS('background-color','rgb(243, 243, 243)');await expect(clock).toHaveCSS('padding-left','40px');
    const canvasBackground=()=>page.locator('canvas').evaluate(c=>Array.from(c.getContext('2d').getImageData(2,c.height-3,1,1).data).slice(0,3));
    await expect.poll(canvasBackground).toEqual([255,255,255]);

    await page.locator('.leaf').filter({hasText:'+ clk'}).dblclick();
    await page.locator('.leaf').filter({hasText:'+ data'}).dblclick();
    await expect(page.locator('.row')).toHaveCount(2);
    await expect(page.locator('#status')).toContainText('2 个信号');
    await expect(page.locator('.row').first().locator('.name')).toHaveCSS('color','rgb(24, 122, 56)');
    await clock.hover();await expect(clock).toHaveCSS('background-color','rgb(255, 255, 255)');await expect(clock).toHaveCSS('color','rgb(36, 36, 36)');
    await page.screenshot({path:'test-results/viewer-light.png'});
    await setTheme('vscode-dark',{'editor-background':'#202020','sideBar-background':'#252526','foreground':'#dddddd','input-background':'#333333','input-foreground':'#dddddd','charts-green':'#65dc8c','charts-blue':'#6fbfff','editorIndentGuide-background1':'#444444'});
    await expect(page.locator('body')).toHaveCSS('background-color','rgb(32, 32, 32)');await expect.poll(canvasBackground).toEqual([32,32,32]);await expect(page.locator('.row').first().locator('.name')).toHaveCSS('color','rgb(101, 220, 140)');
    await setTheme('vscode-high-contrast',{'editor-background':'#000000','foreground':'#ffffff','contrastBorder':'#ffffff','contrastActiveBorder':'#ffff00'});await expect(page.locator('#compactToolbar')).toHaveCSS('border-bottom-color','rgb(255, 255, 255)');await expect.poll(canvasBackground).toEqual([0,0,0]);
    await setTheme('vscode-light',light);await expect.poll(canvasBackground).toEqual([255,255,255]);

    await page.locator('[data-action="in"]').click();await expect(page.locator('#range')).not.toHaveText('0 → 50 × 1ns');
    await page.locator('[data-action="fit"]').click();
    const box=await page.locator('canvas').boundingBox();
    await page.mouse.click(box.x+box.width*.4,box.y+50);
    await page.keyboard.down('Shift');await page.mouse.click(box.x+box.width*.6,box.y+50);await page.keyboard.up('Shift');
    await expect(page.locator('#cursors')).toContainText('Δ:');
    await page.locator('#radix').selectOption('unsigned');await expect(page.locator('.row').nth(1).locator('.value')).toHaveText('42');
    await page.locator('.row').first().click();await page.locator('[data-action="next"]').click();await expect(page.locator('#cursorAInput')).toHaveValue('25');
    await clickTool(page,'[data-action="source"]');await expect.poll(()=>source?.name).toBe('clk');
    await page.screenshot({path:'test-results/viewer.png'});
    await clickTool(page,'[data-action="remove"]');await expect(page.locator('.row')).toHaveCount(1);
    await expect.poll(()=>state?.chosen?.length).toBe(1);
    await page.locator('#search').fill('nonexistent');await expect(page.locator('.leaf')).toHaveCount(0);
    expect(errors).toEqual([]);
  }finally{backend.dispose();}
});

test('real FSDB/KDB webview: attach, browse elaborated design and resolve selected wave',async({page})=>{
  test.skip(!process.env.WAVE_TEST_KDB,'Set WAVE_TEST_KDB for licensed NPI integration');
  const {KdbSession}=require('../dist/kdb');
  const wave=new Backend(path.resolve(__dirname,'../bin/wave-backend'));
  const kdb=new KdbSession(path.resolve(__dirname,'../bin/wave-backend'),process.env.VERDI_HOME);
  let resolved;
  await page.exposeFunction('bridge',async m=>{
    const send=msg=>page.evaluate(msg=>window.dispatchEvent(new MessageEvent('message',{data:msg})),msg);
    if(m.type==='ready')await send({type:'metadata',...await wave.request('open',{path:path.resolve(process.env.WAVE_TEST_KDB,'../waves.fsdb')}),title:'waves.fsdb',vide:'1.2.5'});
    else if(m.type==='query')await send({type:'data',request:m.request,result:await wave.request('query',{signals:m.signals,start:String(m.start),end:String(m.end),limit:20000})});
    else if(m.type==='search')await send({type:'searchResult',request:m.request,...await wave.request('search',{query:m.query,offset:m.offset,limit:m.limit})});
    else if(m.type==='attachKdb'){await kdb.open(process.env.WAVE_TEST_KDB);await send({type:'kdbAttached',path:kdb.path});await send({type:'kdbHierarchy',scope:'',children:await kdb.children()});}
    else if(m.type==='kdbChildren')await send({type:'kdbHierarchy',scope:m.scope,children:await kdb.children(m.scope)});
    else if(m.type==='source')resolved=await kdb.resolve(m.scope+'.'+m.name);
  });
  await page.addInitScript(()=>{window.acquireVsCodeApi=()=>({getState:()=>null,setState(){},postMessage:m=>window.bridge(m)});});
  await page.route('http://wave.test/**',async route=>{const name=new URL(route.request().url()).pathname.slice(1)||'index.html';if(!['index.html','wave.js','wave.css'].includes(name)){await route.abort();return;}let body=fs.readFileSync(path.resolve(__dirname,name.endsWith('.js')?'../dist/webview':'../media',name),'utf8');if(name==='index.html')body=body.replaceAll('{{csp}}','http://wave.test').replaceAll('{{nonce}}','testnonce').replace('{{css}}','/wave.css').replace('{{script}}','/wave.js');await route.fulfill({body,contentType:name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html'});});
  try{
    await page.goto('http://wave.test/');await expect(page.locator('#backend')).toContainText('native-fsdb');
    await clickTool(page,'[data-action="attachKdb"]');
    await expect(page.locator('#kdbTree')).toContainText('cv32e40p_mac_trace_tb');
    await page.locator('#kdbTree button').filter({hasText:'▸ cv32e40p_mac_trace_tb ·'}).click();await expect(page.locator('#kdbState')).toHaveText('cv32e40p_mac_trace_tb');
    await expect(page.locator('#kdbTree')).toContainText('dut');
    const full='cv32e40p_mac_trace_tb.dut.u_core.u_core.core_i.clk_i';
    await page.locator('#search').fill(full);await expect(page.locator('.leaf')).toHaveCount(1);await page.locator('.leaf').dblclick();
    await expect(page.locator('.row')).toHaveCount(1);await expect(page.locator('#status')).toContainText('1 个信号');
    await clickTool(page,'[data-action="source"]');await expect.poll(()=>resolved?.line).toBe(45);expect(resolved.fullname).toBe(full);
    await page.screenshot({path:'test-results/native-kdb-viewer.png'});
  }finally{wave.dispose();kdb.dispose();}
});
