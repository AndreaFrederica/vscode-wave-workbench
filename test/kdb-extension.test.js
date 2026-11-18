// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
test('extension host adapter: real FSDB + KDB opens declaration / instantiation / definition',{skip:!process.env.WAVE_TEST_KDB},async t=>{
  const root=path.resolve(__dirname,'..'),messages=[],opened=[],disposable={dispose(){}};let provider,receive,sidebarProvider,sidebarReceive;const commands=new Map(),stored=new Map(),openedWaves=[];let editorChanged;let dialogs=0;const layoutCalls=[];let clipboard='';const batchExisting=new Set();
  const uri=file=>({fsPath:file,toString(){return file;}});
  class Position{constructor(line,character){this.line=line;this.character=character;}}
  class Range{constructor(start,end){this.start=start;this.end=end;}}
  class EventEmitter {
    constructor() { this.listeners = []; }
    event = listener => {
      this.listeners.push(listener);
      return { dispose: () => { this.listeners = this.listeners.filter(item => item !== listener); } };
    };
    fire(event) { for (const listener of this.listeners) listener(event); }
    dispose() { this.listeners = []; }
  }
  const vscode={EventEmitter,
    Uri:{file:uri,joinPath:(base,...parts)=>uri(path.join(base.fsPath,...parts))},Position,Range,Selection:Range,ViewColumn:{Beside:2},
    env:{clipboard:{writeText:async text=>{clipboard=text;}}},
    extensions:{getExtension:()=>({packageJSON:{version:'1.2.5'}})},
    workspace:{getConfiguration:()=>({get:name=>({verdiHome:process.env.VERDI_HOME,independentBackendPath:process.env.WAVE_TEST_BACKEND,eventsPerSignal:20000})[name]}),openTextDocument:async file=>({uri:file,lineCount:fs.readFileSync(file.fsPath,'utf8').split('\n').length})},
    window:{onDidChangeActiveTextEditor:fn=>{editorChanged=fn;return disposable;},registerWebviewViewProvider:(_id,p)=>{sidebarProvider=p;return disposable;},createOutputChannel:()=>({append(){},appendLine(){},dispose(){}}),registerCustomEditorProvider:(_id,p)=>{provider=p;return disposable;},showTextDocument:async (doc,options)=>{const editor={doc,options,revealRange(){}};opened.push(editor);return editor;},showOpenDialog:async()=>{dialogs++;return [uri(path.join(root,'examples/demo.vcd'))];},showInformationMessage:()=>{},showErrorMessage:message=>{throw new Error(message);}},
    commands:{registerCommand:(name,handler)=>{commands.set(name,handler);return disposable;},executeCommand:async(name,file)=>{if(name==='vscode.openWith')openedWaves.push(file.fsPath);if(name==='vscode.setEditorLayout')layoutCalls.push(file);}}
  };
  const context={extensionUri:uri(root),asAbsolutePath:p=>path.join(root,p),subscriptions:[],workspaceState:{get:(key,fallback)=>stored.has(key)?stored.get(key):fallback,update:async(key,value)=>stored.set(key,value)}};
  t.after(()=>context.subscriptions.forEach(d=>d.dispose()));
  const module={exports:{}};
  const wrapped=vm.runInThisContext('(function(require,module,exports){'+fs.readFileSync(path.join(root,'dist/extension.js'),'utf8')+'\n})');
  wrapped(name=>name==='vscode'?vscode:name.startsWith('.')?require(path.join(root,'dist',name)):require(name),module,module.exports);
  module.exports.activate(context);
  const panel={active:true,reveal(){},onDidChangeViewState:()=>disposable,onDidDispose:()=>disposable,webview:{cspSource:"'self'",asWebviewUri:u=>u,onDidReceiveMessage:fn=>{receive=fn;return disposable;},postMessage:async m=>{messages.push(m);if(m.type==='ui'){const fresh=m.payload.signals.filter(s=>!batchExisting.has(s.scope+'.'+s.name));for(const s of fresh)batchExisting.add(s.scope+'.'+s.name);queueMicrotask(()=>receive({type:'uiResult',id:m.id,result:{added:fresh.length,duplicates:m.payload.signals.length-fresh.length}}));}return true;}}};
  const document=await provider.openCustomDocument(uri(path.resolve(process.env.WAVE_TEST_KDB,'../waves.fsdb')));
  await provider.resolveCustomEditor(document,panel);
  await receive({type:'ready'});
  assert.ok(messages.some(m=>m.type==='kdbAttached'), JSON.stringify(messages.filter(m=>m.type==='error')));assert.deepEqual(layoutCalls[0],{orientation:1,groups:[{size:.6},{size:.4}]});
  const sidebarStates=[];sidebarProvider.resolveWebviewView({visible:true,onDidDispose(){},onDidChangeVisibility(){},webview:{cspSource:"'self'",asWebviewUri:u=>u,onDidReceiveMessage:fn=>{sidebarReceive=fn;},postMessage:async m=>sidebarStates.push(m)}});
  await sidebarReceive({type:'ready'});assert.ok(sidebarStates.at(-1).tree.some(n=>n.fullname==='cv32e40p_mac_trace_tb'));
  const parts=['cv32e40p_mac_trace_tb','dut','u_core','u_core'];let parent='';for(const part of parts){parent=parent?parent+'.'+part:part;await sidebarReceive({type:'tree',scope:parent,action:'expand'});}
  assert.ok(sidebarStates.at(-1).tree.some(n=>n.fullname===parent+'.core_i'&&n.depth===4));
  await sidebarReceive({type:'tree',scope:parent+'.core_i',action:'select'});assert.equal(opened.at(-1).selection.start.line,30);assert.equal(opened.at(-1).options.viewColumn,1);
  await sidebarReceive({type:'tree',scope:parent,action:'select'});await sidebarReceive({type:'tree',scope:'',action:'back'});assert.ok(sidebarStates.at(-1).tree.some(n=>n.fullname===parent+'.core_i'&&n.selected));
  const sourceUri=opened.at(-1).doc.uri;vscode.window.activeTextEditor={document:{uri:sourceUri,getText:()=> 'clk_i'},selection:{isEmpty:false}};
  await commands.get('waveWorkbench.addSelection')();assert.equal(messages.findLast(m=>m.type==='ui'&&m.action==='batchAdd').payload.signals[0].scope,parent+'.core_i');
  vscode.window.activeTextEditor.document.getText=()=> 'always_ff @(posedge clk_i or negedge rst_ni) begin if (!rst_ni) clk_i <= 1\'b0; end // fake_signal';await commands.get('waveWorkbench.addSelection')();const batch=messages.findLast(m=>m.type==='ui'&&m.action==='batchAdd').payload.signals;assert.ok(batch.some(s=>s.name==='rst_ni'));assert.ok(batch.every(s=>s.scope===parent+'.core_i'));
  await receive({type:'scopeSignals',scope:parent+'.core_i',request:123,offset:0});const scopeReply=messages.findLast(m=>m.type==='scopeSignals');assert.ok(scopeReply.signals.length);assert.ok(scopeReply.signals.every(s=>s.scope===parent+'.core_i'));await sidebarReceive({type:'scopePage',scope:parent+'.core_i',request:8,offset:0});const sideReply=sidebarStates.findLast(m=>m.type==='scopePage');assert.equal(sideReply.request,8);assert.ok(sideReply.signals.length);await sidebarReceive({type:'addSignals',signals:sideReply.signals.slice(0,2)});assert.equal(messages.findLast(m=>m.type==='sidebarAdd').signals.length,2);

  await receive({type:'copyPaths',text:'tb.dut.clk'});assert.equal(clipboard,'tb.dut.clk');
  const meta=messages.find(m=>m.type==='metadata');const scope='cv32e40p_mac_trace_tb.dut.u_core.u_core.core_i';await receive({type:'search',query:scope+'.clk_i',request:1});const signal=messages.findLast(m=>m.type==='searchResult').signals.find(s=>s.scope===scope&&s.name==='clk_i');assert.ok(signal);
  for(const [target,line,file] of [['declaration',45,'cv32e40p_core.sv'],['instance',112,'cv32e40p_top.sv'],['definition',31,'cv32e40p_core.sv']]){
    await receive({type:'source',id:signal.id,scope:signal.scope,name:signal.name,target});
    const editor=opened.at(-1);assert.equal(editor.selection.start.line,line-1);assert.equal(path.basename(editor.doc.uri.fsPath),file);assert.equal(messages.findLast(m=>m.type==='scopeSelected').scope,target==='instance'?scope.slice(0,scope.lastIndexOf('.')):scope);
  }
  await receive({type:'kdbChildren',scope});assert.ok(messages.findLast(m=>m.type==='kdbHierarchy').children.length>0);
  assert.deepEqual(messages.filter(m=>m.type==='error'),[]);
  // Open another RTL manually; the extension follows the KDB without opening or
  // moving an editor, and expands every ancestor even after the tree was folded.
  for(const part of parts.slice(0,1))await sidebarReceive({type:'tree',scope:part,action:'expand'});
  const alu=uri(path.join(path.dirname(sourceUri.fsPath),'cv32e40p_alu.sv'));
  // Pick the declaration's actual module from the KDB snapshot (no filename guess).
  const manual={document:{uri:alu,languageId:'systemverilog',version:1,getText:()=>fs.readFileSync(alu.fsPath,'utf8')},selection:{active:{line:0}}};
  const openCount=opened.length;vscode.window.activeTextEditor=manual;editorChanged(manual);
  const wanted=scope+'.ex_stage_i.alu_i';
  for(let i=0;i<100&&!sidebarStates.at(-1)?.tree?.some(n=>n.fullname===wanted&&n.selected);i++)await new Promise(r=>setTimeout(r,30));
  assert.ok(sidebarStates.at(-1).tree.some(n=>n.fullname===wanted&&n.selected));assert.equal(opened.length,openCount);assert.equal(messages.findLast(m=>m.type==='scopeSelected').scope,wanted);
  // A file absent from this KDB leaves the selected design unchanged.
  const other={document:{uri:uri('/tmp/not-in-design.sv'),languageId:'systemverilog',version:1,getText:()=> 'module not_in_this_design; endmodule'},selection:{active:{line:0}}};vscode.window.activeTextEditor=other;editorChanged(other);await new Promise(r=>setTimeout(r,250));assert.equal(messages.findLast(m=>m.type==='scopeSelected').scope,wanted);

  await commands.get('waveWorkbench.open')(document.uri);
  await commands.get('waveWorkbench.openLast')();
  // A title button on an RTL file reopens the workspace's last wave.
  await commands.get('waveWorkbench.open')(uri('/tmp/example.sv'));
  assert.deepEqual(openedWaves,[]);assert.equal(dialogs,0);
  await commands.get('waveWorkbench.openPicker')();assert.equal(dialogs,1);assert.equal(openedWaves.at(-1),path.join(root,'examples/demo.vcd'));
  assert.equal(stored.get('lastWaveform'),path.join(root,'examples/demo.vcd'));
});
