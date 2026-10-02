// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,writeFile,readFile,lstat,unlink,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { planInstallSlot } from '../src/nnd-install-storage-provenance.js';
import { resumeInstallRetirement } from '../src/nnd-install-storage-retention.js';
import { json,hash } from '../src/nnd-install-storage.js';
async function fixture(t) {
 const root=await mkdtemp(join(homedir(),'.nna-retirement-test-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const transactions=join(root,'transactions'),id=randomUUID(),directory=join(transactions,id);await mkdir(directory,{recursive:true});
 const prepared=Buffer.from('preserved prepared bytes'),payload=Buffer.from('preserved payload bytes');
 await writeFile(join(directory,'prepared.json'),prepared);await writeFile(join(directory,'payload.json'),payload);
 const info=await lstat(directory),plan={protocol:'2.0',operation_id:id,ino:String(info.ino),dev:String(info.dev),files:[
  {name:'prepared.json',sha256:hash(prepared)},{name:'payload.json',sha256:hash(payload)}]};
 await writeFile(join(root,'retirement.json'),json(plan));
 return {root,transactions,directory,plan,payload};
}
test('receipt retirement resumes after an interrupted owned file removal',async t=>{
 const f=await fixture(t);await unlink(join(f.directory,'prepared.json'));await resumeInstallRetirement(f);
 await assert.rejects(lstat(f.directory),{code:'ENOENT'});await assert.rejects(lstat(join(f.root,'retirement.json')),{code:'ENOENT'});
 await resumeInstallRetirement(f);
});
test('receipt retirement preserves unexpected or changed evidence',async t=>{
 const f=await fixture(t);await writeFile(join(f.directory,'payload.json'),'foreign bytes');
 await assert.rejects(resumeInstallRetirement(f),{code:'nnd_install_transaction_invalid'});
 assert.equal(await readFile(join(f.directory,'payload.json'),'utf8'),'foreign bytes');assert.ok(await lstat(join(f.root,'retirement.json')));
 await writeFile(join(f.directory,'payload.json'),f.payload);await writeFile(join(f.directory,'foreign.txt'),'extra');
 await assert.rejects(resumeInstallRetirement(f),{code:'nnd_install_transaction_invalid'});
 assert.ok(await lstat(join(f.directory,'prepared.json')));
});
test('receipt retirement refuses a replacement directory identity',async t=>{
 const f=await fixture(t);f.plan.ino='0';await writeFile(join(f.root,'retirement.json'),json(f.plan));
 await assert.rejects(resumeInstallRetirement(f),{code:'nnd_install_transaction_invalid'});
 assert.ok(await lstat(join(f.directory,'prepared.json')));
});

test('distinct slot and aggregate-byte quotas reject before preparing filesystem mutations',async t=>{
 const f=await fixture(t),versions=join(f.root,'versions'),provenance=join(f.root,'provenance');
 await mkdir(versions);await mkdir(provenance);
 const identity={installation_id:'native',data_id:'data'},store={...f,versions,provenance};
 const verified={bytes:Buffer.from('{}'),sha256:'f'.repeat(64),manifest:{version:'20261002-99',files:[{bytes:1}]}};
 for(let i=0;i<16;i++) {
  const sha=i.toString(16).padStart(64,'0'),version=`20261002-${i+1}`;
  await mkdir(join(versions,`${version}-${sha}`));
  await writeFile(join(provenance,sha+'.json'),json({protocol:'2.0',...identity,version,payload_sha256:sha,
   publication_id:randomUUID(),ino:'1',dev:'1',bytes:1}));
 }
 await assert.rejects(planInstallSlot(identity,store,verified),{code:'nnd_install_store_full'});
 for(let i=0;i<16;i++) {
  const sha=i.toString(16).padStart(64,'0'),path=join(provenance,sha+'.json'),record=JSON.parse(await readFile(path,'utf8'));
  record.bytes=2147483648;await writeFile(path,json(record));
 }
 await assert.rejects(planInstallSlot(identity,store,verified),{code:'nnd_install_store_full'});
 await assert.rejects(lstat(join(versions,`${verified.manifest.version}-${verified.sha256}`)),{code:'ENOENT'});
});
