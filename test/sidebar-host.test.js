// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

const {test}=require('node:test'),assert=require('node:assert/strict');
const os=require('node:os');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
test('registered sidebar drives real Tcl/VCD, keeps per-wave variables, reveals hidden target, and updates after close',async t=>{
  const root=path.resolve(__dirname,'..'),commands=new Map(),states=[],disposable={dispose(){}};let provider,sidebar,sideReceive,autoSplit;const layouts=[];
  const uri=fsPath=>({fsPath,toString(){return fsPath;}});
  class EventEmitter {
    constructor() { this.listeners = []; }
    event = listener => {
      this.listeners.push(listener);
      return { dispose: () => { this.listeners = this.listeners.filter(item => item !== listener); } };
    };
    fire(event) { for (const listener of this.listeners) listener(event); }
    dispose() { this.listeners = []; }
  }
  const vscode={EventEmitter,Uri:{file:uri,joinPath:(u,...p)=>uri(path.join(u.fsPath,...p))},ViewColumn:{Two:2},extensions:{getExtension:()=>null},
    debug:{registerDebugConfigurationProvider:()=>disposable,registerDebugAdapterDescriptorFactory:(type)=>{assert.ok(['wave-workbench-live','wave-workbench-tcl'].includes(type));return disposable;}},
    workspace:{getConfiguration:()=>({get:key=>key==="autoSplit"?autoSplit:undefined})},
    window:{registerWebviewViewProvider:(id,p)=>{if(id==='waveWorkbench.control')sidebar=p;else assert.ok(['waveWorkbench.liveWave','waveWorkbench.panelWave','waveWorkbench.panelTcl'].includes(id));return disposable;},registerCustomEditorProvider:(_id,p)=>{provider=p;return disposable;},registerWebviewPanelSerializer:()=>disposable,createOutputChannel:()=>({append(){},appendLine(){},dispose(){}}),showErrorMessage:m=>{throw Error(m);}},
    commands:{registerCommand:(name,fn)=>{
      assert.ok(!commands.has(name), `Duplicate command registration for ${name}`);
      commands.set(name,fn);
      return disposable;
    },executeCommand:async(name,...args)=>{
      if(name==="vscode.setEditorLayout") layouts.push(args[0]);
      return commands.get(name)?.(...args);
    }}};
  const context={extensionUri:uri(root),asAbsolutePath:p=>path.join(root,p),subscriptions:[],workspaceState:{get:(_key,fallback)=>fallback,update:async()=>{}}};t.after(()=>context.subscriptions.forEach(d=>d.dispose()));
  const mod={exports:{}};vm.runInThisContext('(function(require,module,exports){'+fs.readFileSync(path.join(root,'dist/extension.js'),'utf8')+'\n})')(name=>name==='vscode'?vscode:name.startsWith('.')?require(path.join(root,'dist',name)):require(name),mod,mod.exports);mod.exports.activate(context);
  for (const { command } of require('../package.json').contributes.commands) {
    assert.ok(commands.has(command), `Missing command registration for ${command}`);
  }
  const sideView={visible:true,onDidDispose:()=>{},onDidChangeVisibility:()=>{},webview:{cspSource:"'self'",asWebviewUri:u=>u,onDidReceiveMessage:fn=>{sideReceive=fn;},postMessage:async m=>{states.push(m);}}};sidebar.resolveWebviewView(sideView);await sideReceive({type:'ready'});
  const assertResources=(webview,script)=>{const scriptPath=path.join(root,'dist/webview',script);assert.ok(webview.html.includes(scriptPath));assert.ok(webview.options.localResourceRoots.some(uri=>scriptPath.startsWith(uri.fsPath+path.sep)));assert.ok(fs.existsSync(scriptPath));};
  assertResources(sideView.webview,'sidebar.js');
  await sideReceive({type:'execute',script:'waveHelp'});assert.ok(sidebar.logs.some(e=>e.text.includes('wvAddSignal')));
  const open=async file=>{let receive,closed;const reveals=[],errors=[];const panel={active:true,visible:true,viewColumn:3,reveal:(...args)=>{reveals.push(args);panel.visible=true;},onDidChangeViewState:()=>{},onDidDispose:fn=>{closed=fn;},webview:{cspSource:"'self'",asWebviewUri:u=>u,onDidReceiveMessage:fn=>{receive=fn;},postMessage:async m=>{if(m.type==='error')errors.push(m.message);if(m.type==='ui')queueMicrotask(()=>receive({type:'uiResult',id:m.id,result:{displayScale:null}}));}}};const fileUri=uri(path.isAbsolute(file)?file:path.join(root,'examples',file));const doc=await provider.openCustomDocument(fileUri);await provider.resolveCustomEditor(doc,panel);await receive({type:'ready'});assert.deepEqual(errors,[]);return {panel,uri:doc.uri,close:()=>closed(),reveals};};
  const a=await open('demo.vcd');assertResources(a.panel.webview,'wave.js');assert.equal(layouts.length,0);a.panel.visible=false;
  await sideReceive({type:'execute',script:'set value 8; puts "sidebar stdout"; wvGetSigValueByTime {/tb/dut/data[7:0]} -time 20 -format Hex'});
  assert.ok(sidebar.logs.some(e=>e.text==='2a'));assert.ok(sidebar.logs.some(e=>e.text==='sidebar stdout'));assert.deepEqual(a.reveals.at(-1),[3,true]);
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wave-sidebar-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const second=path.join(dir,'second.vcd');fs.copyFileSync(path.join(root,'examples/demo.vcd'),second);autoSplit=true;const b=await open(second);
  assert.equal(layouts.length,1);
  assert.deepEqual(b.reveals.at(-1),[2,true]);
  autoSplit=false;
  await sideReceive({type:'action',action:'debugLayout'});
  assert.equal(layouts.length,2);
  await sideReceive({type:'execute',script:'set value 99'});
  // Select the first session explicitly after viewing a different editor/session.
  await sideReceive({type:'select',id:a.uri.toString()});await sideReceive({type:'execute',script:'set value'});
  assert.equal(sidebar.logs.at(-1).text,'8');assert.equal(sidebar.logs.at(-1).session,a.uri.fsPath);
  await sideReceive({type:'execute',script:'wvUnsupportedSidebarCommand'});assert.match(sidebar.logs.at(-1).text,/ERROR: Unsupported/);
  await sideReceive({type:'clear'});assert.equal(sidebar.logs.length,0);assert.ok(sidebar.history.includes('set value'));
  a.close();assert.equal(states.findLast(m=>m.type==='state').sessions.length,1);b.close();assert.equal(states.findLast(m=>m.type==='state').sessions.length,0);
});
