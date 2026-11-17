// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {moduleAt,commonScope,SourceFiles}=require('../dist/source-sync');
test('RTL declaration under cursor ignores comments and strings and handles multiple modules',()=>{
 const text='// module fake;\n/* interface bogus; */\nmodule automatic first;\n string s="module fake;";\nendmodule\nmodule second;\nendmodule';
 assert.equal(moduleAt(text,0),'first');assert.equal(moduleAt(text,5),'second');assert.equal(moduleAt('interface link_if; endinterface'),'link_if');assert.equal(commonScope('tb.a.core','tb.a.alu'),2);
});
test('source matching accepts identical build copies but rejects different content and invalidates cached hashes',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wave-source-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const a=path.join(dir,'a.sv'),b=path.join(dir,'b.sv'),files=new SourceFiles();fs.writeFileSync(a,'module a; endmodule');fs.copyFileSync(a,b);assert.equal(files.same(a,b),true);fs.writeFileSync(b,'module other; endmodule');assert.equal(files.same(a,b),false);assert.equal(files.same(a,path.join(dir,'missing')),false);
});
