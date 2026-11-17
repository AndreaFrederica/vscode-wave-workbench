// Optional independent oracle: compare native SDK values against fsdb2vcd output.
const {execFileSync}=require('node:child_process');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {Backend}=require('../dist/backend');
(async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wave-oracle-'));
  const a=new Backend(path.resolve(__dirname,'../bin/wave-backend'));
  const b=new Backend(path.resolve(__dirname,'../bin/wave-backend'));
  try{
    const file=process.env.WAVE_TEST_FSDB;if(!file)throw Error('Set WAVE_TEST_FSDB to a small fixture');
    execFileSync('fsdb2vcd',[file,'-o',path.join(dir,'reference.vcd')],{cwd:dir,stdio:'pipe'});
    const am=await a.request('open',{path:file});const bm=await b.request('open',{path:path.join(dir,'reference.vcd')});
    let checked=0;const lookup=new Map(bm.signals.map(s=>[`${s.scope}.${s.name}`,s]));
    const normalize=(v,width)=>v.padStart(width,/^[xz]/.test(v)?v[0]:'0');
    for(const s of am.signals.filter(s=>s.supported)){
      const other=lookup.get(`${s.scope}.${s.name}`);if(!other)continue;
      const aa=(await a.request('query',{signals:[s.id],start:am.start,end:am.end,limit:100000}))[s.id];
      const bb=(await b.request('query',{signals:[other.id],start:bm.start,end:bm.end,limit:100000}))[other.id];
      if(aa.truncated||bb.truncated)continue;
      // Some tools suppress repeated values; compare stable values at every event time.
      const times=[...new Set([...aa.events,...bb.events].map(e=>e[0]))].sort((x,y)=>Number(x)-Number(y));
      let ai=-1,bi=-1;
      for(const t of times){while(ai+1<aa.events.length&&BigInt(aa.events[ai+1][0])<=BigInt(t))ai++;while(bi+1<bb.events.length&&BigInt(bb.events[bi+1][0])<=BigInt(t))bi++;
        if(ai>=0&&bi>=0)assert.equal(normalize(aa.events[ai][1],s.width),normalize(bb.events[bi][1],s.width),`${s.name} @ ${t}`);
      }
      checked++;
    }
    assert.ok(checked>0);console.log(`Native FSDB matches converter reference for ${checked} digital signals (including bus bit order)`);
  }finally{a.dispose();b.dispose();fs.rmSync(dir,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
