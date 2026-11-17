const {test}=require('node:test'),assert=require('node:assert/strict');const W=require('../dist/shared/signals');const {restoreView}=require('../dist/view-state');
test('bit projections preserve ranges, four states, padding and source identity',()=>{
 for(const [name,labels] of [['bus[7:0]',['bus[7]','bus[0]']],['bus[0:7]',['bus[0]','bus[7]']],['bus[15:8]',['bus[15]','bus[8]']],['bus[-1:-8]',['bus[-1]','bus[-8]']]]){const s={id:'x',scope:'top',name,width:8};const bits=W.bits(s);assert.equal(W.label(bits[0]),labels[0]);assert.equal(W.label(bits[7]),labels[1]);assert.equal(W.project('10100101',bits[0]),'1');assert.equal(W.project('1',bits[0]),'0');assert.equal(W.project('x',bits[7]),'x');assert.equal(W.project('z',bits[0]),'z');assert.equal(bits[0].id,s.id);assert.notEqual(W.key(bits[0]),W.key(bits[7]));}
});
test('view restoration validates canonical width and keeps repeated ID bit styles separate',async()=>{
 const parent={id:'x',scope:'top',name:'bus[3:0]',width:4,supported:true},bits=W.bits(parent);const state={chosen:[parent,...bits],start:0,end:40,cursorA:20};const backend={request:async()=>state.chosen.map(()=>parent)};const restored=await restoreView(backend,state,{start:'0',end:'50'});assert.deepEqual(restored.chosen.slice(1).map(s=>s.bitOffset),[3,2,1,0]);assert.equal(restored.chosen[0].width,4);assert.equal(restored.chosen[1].width,1);await assert.rejects(restoreView(backend,{...state,chosen:[{...bits[0],bitOffset:99}]},{start:'0',end:'50'}));
});

test('saved marker times are validated before view restoration',async()=>{const backend={request:async()=>[]};await assert.rejects(restoreView(backend,{chosen:[],start:0,end:40,cursorA:0,markers:[{name:'bad',time:100}]},{start:0,end:50}),/markers/);});
