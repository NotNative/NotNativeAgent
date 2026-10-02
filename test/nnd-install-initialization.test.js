// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, realpath, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { openInstallStore, assertNoNndInstallTransaction, hash, json } from '../src/nnd-install-storage.js';
import { initializeInstallTransaction, resumeInstallInitialization } from '../src/nnd-install-initialization.js';

const windows={skip:process.platform!=='win32',timeout:30000};
async function fixture(t,{registration=true}={}) {
 const root=await mkdtemp(join(homedir(),'.ni-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const data=join(root,'data'),native=join(root,'native');await mkdir(join(data,'config'),{recursive:true});await mkdir(native);
 const identity={data_root:await realpath(data),install_root:await realpath(native)};
 identity.data_id='data_'+hash(identity.data_root.toLowerCase());identity.installation_id='nna_'+hash(identity.install_root.toLowerCase());
 const signal=new AbortController().signal,store=await openInstallStore(identity,signal),id=randomUUID();
 const before=Buffer.from('existing registration\n'),payload=Buffer.from('verified payload fixture\n');
 if(registration)await writeFile(join(data,'config/nnd-package.json'),before);
 const prepared=json({protocol:'2.0',operation_id:id,installation_id:identity.installation_id,data_id:identity.data_id,
  version:'20261002-7',source_root:join(root,'payload'),reused_provenance:null,registration_sha256:registration?hash(before):null,payload_sha256:hash(payload)});
 const pending=json({protocol:'2.0',operation_id:id,installation_id:identity.installation_id,data_id:identity.data_id});
 const files=[...(registration?[['registration.before',before]]:[]),['payload.json',payload],['prepared.json',prepared]];
 return {identity,store,id,files,pending,signal,before};
}
const phases=['initialization_before_commit','initialization_committed','initialization_directory','initialization_registration.before',
 'initialization_payload.json','initialization_prepared.json','initialization_pending','initialization_cleared'];
for(const phase of phases)test(`initializer survives actual process death at ${phase}`,windows,async t=>{
 const f=await fixture(t),module=new URL('../src/nnd-install-initialization.js',import.meta.url).href;
 const source=`import {initializeInstallTransaction} from ${JSON.stringify(module)};
 const files=${JSON.stringify(f.files.map(([name,bytes])=>[name,bytes.toString('base64')]))}.map(([name,bytes])=>[name,Buffer.from(bytes,'base64')]);
 await initializeInstallTransaction(${JSON.stringify(f.identity)},${JSON.stringify(f.store)},${JSON.stringify(f.id)},files,
 Buffer.from(${JSON.stringify(f.pending.toString('base64'))},'base64'),{checkpoint:async point=>{
 if(point===${JSON.stringify(phase)}){process.stdout.write('held');setInterval(()=>{},1000);await new Promise(()=>{});}
 }},new AbortController().signal);`;
 const child=spawn(process.execPath,['--input-type=module','-e',source],{windowsHide:true,stdio:['ignore','pipe','pipe']});
 t.after(()=>child.kill());await once(child.stdout,'data',{signal:AbortSignal.timeout(15000)});
 const exited=once(child,'exit');child.kill();await exited;
 const result=await resumeInstallInitialization(f.identity,f.store,f.signal);
 if(['initialization_before_commit','initialization_cleared'].includes(phase))assert.equal(result,null);
 else assert.deepEqual(result,{state:phase==='initialization_pending'?'prepared':'unpublished',operation_id:f.id});
 const prepared=['initialization_pending','initialization_cleared'].includes(phase);
 assert.deepEqual(await readdir(f.store.transactions),prepared?[f.id]:[]);
 if(prepared)await assert.rejects(assertNoNndInstallTransaction(f.identity),{code:'nnd_install_transaction_pending'});
 else await assertNoNndInstallTransaction(f.identity);
 assert.deepEqual(await readFile(join(f.identity.data_root,'config/nnd-package.json')),f.before);
});
test('initializer recovers verified partial metadata writes without retaining orphan capacity',windows,async t=>{
 const f=await fixture(t);
 await assert.rejects(initializeInstallTransaction(f.identity,f.store,f.id,f.files,f.pending,{checkpoint:phase=>{
  if(phase==='initialization_directory')throw new Error('interrupt');
 }},f.signal));
 await writeFile(join(f.store.transactions,f.id,'payload.json'),f.files[1][1].subarray(0,7));
 assert.deepEqual(await resumeInstallInitialization(f.identity,f.store,f.signal),{state:'unpublished',operation_id:f.id});
 assert.deepEqual(await readdir(f.store.transactions),[]);await assertNoNndInstallTransaction(f.identity);
});
test('initializer preserves unexpected files and changed metadata instead of guessing ownership',windows,async t=>{
 const f=await fixture(t);
 await assert.rejects(initializeInstallTransaction(f.identity,f.store,f.id,f.files,f.pending,{checkpoint:phase=>{
  if(phase==='initialization_directory')throw new Error('interrupt');
 }},f.signal));
 const path=join(f.store.transactions,f.id,'payload.json');await writeFile(path,'foreign bytes');
 await assert.rejects(resumeInstallInitialization(f.identity,f.store,f.signal),{code:'nnd_install_transaction_invalid'});
 assert.equal(await readFile(path,'utf8'),'foreign bytes');
 await assert.rejects(assertNoNndInstallTransaction(f.identity),{code:'nnd_install_transaction_pending'});
});
test('fresh install initialization recovers without inventing a prior registration',windows,async t=>{
 const f=await fixture(t,{registration:false});
 await assert.rejects(initializeInstallTransaction(f.identity,f.store,f.id,f.files,f.pending,{checkpoint:phase=>{
  if(phase==='initialization_directory')throw new Error('interrupt');
 }},f.signal));
 assert.deepEqual(await resumeInstallInitialization(f.identity,f.store,f.signal),{state:'unpublished',operation_id:f.id});
 await assert.rejects(readFile(join(f.identity.data_root,'config/nnd-package.json')),{code:'ENOENT'});
 assert.deepEqual(await readdir(f.store.transactions),[]);await assertNoNndInstallTransaction(f.identity);
});
