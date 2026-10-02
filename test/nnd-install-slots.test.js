// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir,writeFile,readFile,rm,rmdir,realpath,readdir,link,symlink } from 'node:fs/promises';
import { join,dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID,createHash } from 'node:crypto';
import { ensurePrivateNndRuntimeDirectory } from '../src/nnd-service-private-storage.js';
import { stageNndInstallSlot,recoverNndInstallSlot } from '../src/nnd-install-slots.js';
import { assertNoNndInstallTransaction } from '../src/nnd-install-storage.js';
import { verifyNndPayload } from '../src/nnd-payload-contract.js';
import { requiredNndPayloadFiles } from '../src/nnd-payload-contract-runtime.js';
import { inventory,transferFile,validateEntries } from '../src/nnd-payload-contract-files.js';
const windows={skip:process.platform!=='win32',timeout:90000};
const hash=value=>createHash('sha256').update(value).digest('hex');
const host={platform:'win32',architecture:'x64',node_major:24,capabilities:['service_supervision','setup_control_plane'],data_schemas:{nnd_catalog:1,nnd_state:1}};
async function put(root,path,value) {await mkdir(dirname(join(root,path)),{recursive:true});await writeFile(join(root,path),value);}
async function fixture(t) {
 const root=join(homedir(),'.ns-'+randomUUID().replaceAll('-','').slice(0,24));await mkdir(root);t.after(()=>rm(root,{recursive:true,force:true}));
 const data=join(root,'data'),install=join(root,'native'),source=join(root,'payload');
 await mkdir(join(data,'config'),{recursive:true});await mkdir(install);await mkdir(source);
 const identity={install_root:await realpath(install),data_root:await realpath(data),node:process.execPath,
  platform:'win32',architecture:'x64',node_major:24};
 identity.installation_id='nna_'+hash(identity.install_root.toLowerCase());identity.data_id='data_'+hash(identity.data_root.toLowerCase());
 const version='20261002-7';
 for(const path of requiredNndPayloadFiles()) await put(source,path,'// fixture; never execute\n');
 const pe=Buffer.alloc(128);pe.writeUInt16LE(0x5a4d,0);pe.writeUInt32LE(64,60);pe.writeUInt32LE(0x4550,64);pe.writeUInt16LE(0x8664,68);
 await put(source,'packages/electron/node_modules/electron/dist/electron.exe',pe);
 await put(source,'VERSION',version+'\n');
 await put(source,'package.json',JSON.stringify({name:'notnative-desktop',type:'module',nnd_version:version,version:version.replace('-','.0.')}));
 const manifest={id:'nnd-local',ownership:'nnd',scope:'local-gui',version,nna_integration_protocol:'1.0',service_activation:{
  schema_version:'1.0',required_capabilities:host.capabilities,data_schemas:host.data_schemas,platform:'win32',architecture:'x64',runtime:{name:'node',minimum_major:24},
  entrypoint:'scripts/serve-installed.mjs',bundle_identity:{path:'packages/electron/dist-server/server.mjs',sha256:hash(await readFile(join(source,'packages/electron/dist-server/server.mjs')))},
  authenticated_callbacks:{token_exchange:'protected_stdin',protocol:'1.0'}}};
 await put(source,'nna-integration/nnd-local/integration.json',JSON.stringify(manifest));
 await seal(source,version);
 const registration=Buffer.from('{"root":"prior immutable registration"}\n');await put(data,'config/nnd-package.json',registration);
 return {root,identity,source,registration,version};
}
async function seal(source,version) {
 await rm(join(source,'NND_PAYLOAD.json'),{force:true});const files=[];
 for(const entry of validateEntries(await inventory(source))) files.push({path:entry.path,...await transferFile(entry.source)});
 await put(source,'NND_PAYLOAD.json',JSON.stringify({schema_version:'1.0',version,platform:'win32',architecture:'x64',files}));
}
test('native staging verifies payload without executing it and never changes active registration',windows,async t=>{
 const f=await fixture(t),operationId=randomUUID();
 const result=await stageNndInstallSlot(f.identity,{source:f.source,operationId});assert.equal(result.state,'slot_ready');
 assert.equal((await verifyNndPayload(result.slot,{host})).sha256,result.payload_sha256);
 assert.deepEqual(await readFile(join(f.identity.data_root,'config/nnd-package.json')),f.registration);
 await assertNoNndInstallTransaction(f.identity);
 assert.deepEqual(await stageNndInstallSlot(f.identity,{source:f.source,operationId}),result);
});
for(const phase of ['prepared','staging_created','copied','renamed','slot_ready','barrier_cleared']) test(`interruption at ${phase} preserves registration and recovers only owned evidence`,windows,async t=>{
 const f=await fixture(t),operationId=randomUUID();
 await assert.rejects(stageNndInstallSlot(f.identity,{source:f.source,operationId,checkpoint:point=>{if(point===phase) throw new Error('interrupted');}}));
 const recovered=await recoverNndInstallSlot(f.identity,{operationId});
 assert.equal(recovered.state,['prepared','staging_created'].includes(phase)?'unpublished':'slot_ready');
 assert.deepEqual(await readFile(join(f.identity.data_root,'config/nnd-package.json')),f.registration);await assertNoNndInstallTransaction(f.identity);
});
test('source mutation, extra directories, hardlinks and traversal paths fail closed',windows,async t=>{
 const f=await fixture(t);await mkdir(join(f.source,'unexpected'));
 await assert.rejects(verifyNndPayload(f.source,{host}),{code:'nnd_payload_invalid'});await rmdir(join(f.source,'unexpected'));
 await link(join(f.source,'VERSION'),join(f.root,'linked-version'));
 await assert.rejects(verifyNndPayload(f.source,{host}),{code:'nnd_payload_invalid'});await rm(join(f.root,'linked-version'));
 const operationId=randomUUID();
 await assert.rejects(stageNndInstallSlot(f.identity,{source:f.source,operationId,checkpoint:async phase=>{
  if(phase==='prepared') await writeFile(join(f.source,'scripts/serve-installed.mjs'),'changed');
 }}));
 assert.equal((await recoverNndInstallSlot(f.identity,{operationId})).state,'unpublished');
});
test('changed registration and foreign installation binding preserve pending evidence',windows,async t=>{
 const f=await fixture(t),operationId=randomUUID();
 await assert.rejects(stageNndInstallSlot(f.identity,{source:f.source,operationId,checkpoint:phase=>{if(phase==='prepared')throw new Error('interrupt');}}));
 await writeFile(join(f.identity.data_root,'config/nnd-package.json'),'foreign');
 await assert.rejects(recoverNndInstallSlot(f.identity,{operationId}),{code:'nnd_install_transaction_invalid'});
 await assert.rejects(assertNoNndInstallTransaction(f.identity),{code:'nnd_install_transaction_pending'});
 const other=join(f.root,'other-native');await mkdir(other);
 await assert.rejects(recoverNndInstallSlot({...f.identity,install_root:other,installation_id:'nna_'+hash(other.toLowerCase())},{operationId}),{code:'nnd_install_transaction_invalid'});
});

for(const phase of ['prepared','staging_created','copied','renamed','slot_ready','barrier_cleared']) test(`actual writer death at ${phase} releases native ownership and reconciles evidence`,windows,async t=>{
 const f=await fixture(t),operationId=randomUUID(),module=new URL('../src/nnd-install-slots.js',import.meta.url).href;
 const source=`import {stageNndInstallSlot} from ${JSON.stringify(module)};
 await stageNndInstallSlot(${JSON.stringify(f.identity)},{source:${JSON.stringify(f.source)},operationId:${JSON.stringify(operationId)},checkpoint:async phase=>{
  if(phase===${JSON.stringify(phase)}) {process.stdout.write('held');setInterval(()=>{},1000);await new Promise(()=>{});}
 }});`;
 const child=spawn(process.execPath,['--input-type=module','-e',source],{windowsHide:true,stdio:['ignore','pipe','pipe']});
 t.after(()=>child.kill());await once(child.stdout,'data',{signal:AbortSignal.timeout(15000)});
 const exited=once(child,'exit');child.kill();await exited;
 const recovered=await recoverNndInstallSlot(f.identity,{operationId});
 assert.equal(recovered.state,['prepared','staging_created'].includes(phase)?'unpublished':'slot_ready');
 assert.deepEqual(await readFile(join(f.identity.data_root,'config/nnd-package.json')),f.registration);
});
test('cancelled work retains ownership until pending copy-phase callback settles',windows,async t=>{
 const f=await fixture(t),operationId=randomUUID(),controller=new AbortController();let release,entered;
 const started=new Promise(resolve=>{entered=resolve;}),blocked=new Promise(resolve=>{release=resolve;});
 const first=stageNndInstallSlot(f.identity,{source:f.source,operationId,signal:controller.signal,checkpoint:async phase=>{
  if(phase==='staging_created'){entered();await blocked;}
 }});
 await started;controller.abort();
 await assert.rejects(stageNndInstallSlot(f.identity,{source:f.source,operationId:randomUUID()}));
 release();await assert.rejects(first);
 assert.equal((await recoverNndInstallSlot(f.identity,{operationId})).state,'unpublished');
});
test('payload source junction is refused before installation mutation',windows,async t=>{
 const f=await fixture(t),junction=join(f.root,'linked-payload');await symlink(f.source,junction,'junction');
 await assert.rejects(stageNndInstallSlot(f.identity,{source:junction,operationId:randomUUID()}),{code:'nnd_payload_invalid'});
 await assertNoNndInstallTransaction(f.identity);
});

test('older installation guards, pending migration and incompatible admission are preserved',windows,async t=>{
 const f=await fixture(t);await ensurePrivateNndRuntimeDirectory(f.identity.data_root);
 for(const [name,value,code] of [['installation-guard.json',{protocol:'1.0'},'nnd_install_guard_orphaned'],
 ['migration-pending.json',{version:'1.0'},'nnd_migration_invalid'],['admission.json',{version:'99.0'},'nnd_owner_unverified']]) {
  const path=join(f.identity.data_root,'runtime/nnd',name);await put(f.identity.data_root,`runtime/nnd/${name}`,JSON.stringify(value));
  await assert.rejects(stageNndInstallSlot(f.identity,{source:f.source,operationId:randomUUID()}),{code});
  assert.equal(await readFile(path,'utf8'),JSON.stringify(value));await rm(path);
 }
});
test('unsupported payload schemas cannot create a staging transaction',windows,async t=>{
 const f=await fixture(t),path=join(f.source,'nna-integration/nnd-local/integration.json');
 const manifest=JSON.parse(await readFile(path,'utf8'));manifest.service_activation.data_schemas.nnd_state=2;
 await writeFile(path,JSON.stringify(manifest));await seal(f.source,f.version);
 await assert.rejects(stageNndInstallSlot(f.identity,{source:f.source,operationId:randomUUID()}),{code:'nnd_package_manifest_invalid'});
 await assertNoNndInstallTransaction(f.identity);
});

test('same payload with fresh operation IDs reuses immutable slot beyond receipt retention limit', { ...windows, timeout:150000 },async t=>{
 const f=await fixture(t);let slot;const ids=[];
 for(let i=0;i<18;i++) {
  const operationId=randomUUID();ids.push(operationId);
  const result=await stageNndInstallSlot(f.identity,{source:f.source,operationId});
  assert.equal(result.operation_id,operationId);assert.equal(result.replay_window,'last_16_terminal_operations');
  slot??=result.slot;assert.equal(result.slot,slot);
 }
 const root=join(f.identity.data_root,'runtime/nnd/install-slots');
 assert.equal((await readdir(join(root,'transactions'))).length,16);
 assert.equal((await readdir(join(root,'versions'))).length,1);
 assert.equal((await readdir(join(root,'provenance'))).length,1);
 await assertNoNndInstallTransaction(f.identity);
});
test('same-length staged corruption is preserved with its pending barrier',windows,async t=>{
 const f=await fixture(t),operationId=randomUUID();
 await assert.rejects(stageNndInstallSlot(f.identity,{source:f.source,operationId,checkpoint:phase=>{if(phase==='copied')throw new Error('interrupt');}}));
 const target=join(f.identity.data_root,'runtime/nnd/install-slots/transactions',operationId,'staging/scripts/serve-installed.mjs');
 const bytes=await readFile(target);bytes[0]^=1;await writeFile(target,bytes);
 await assert.rejects(recoverNndInstallSlot(f.identity,{operationId}));
 assert.deepEqual(await readFile(target),bytes);
 await assert.rejects(assertNoNndInstallTransaction(f.identity),{code:'nnd_install_transaction_pending'});
});
test('a sealed payload missing native Electron attachment module is incomplete',windows,async t=>{
 const f=await fixture(t);await rm(join(f.source,'packages/electron/native-service-client.mjs'));await seal(f.source,f.version);
 await assert.rejects(verifyNndPayload(f.source,{host}),{code:'nnd_payload_invalid'});
});

test('changed staging ownership evidence cannot publish or authorize a slot',windows,async t=>{
 const f=await fixture(t),operationId=randomUUID();
 await assert.rejects(stageNndInstallSlot(f.identity,{source:f.source,operationId,checkpoint:async phase=>{
  if(phase==='before_rename') await writeFile(join(f.identity.data_root,'runtime/nnd/install-slots/transactions',operationId,'stage-owner.json'),'{"ino":"0","dev":"0"}');
 }}),{code:'nnd_install_transaction_invalid'});
 await assert.rejects(assertNoNndInstallTransaction(f.identity),{code:'nnd_install_transaction_pending'});
 assert.deepEqual(await readFile(join(f.identity.data_root,'config/nnd-package.json')),f.registration);
});

test('long canonical data roots fail before prepared evidence or slot mutation',windows,async t=>{
 const f=await fixture(t),data=join(f.root,'d'.repeat(75));await mkdir(join(data,'config'),{recursive:true});
 const identity={...f.identity,data_root:await realpath(data)};identity.data_id='data_'+hash(identity.data_root.toLowerCase());
 await writeFile(join(data,'config/nnd-package.json'),f.registration);
 let prepared=false;
 await assert.rejects(stageNndInstallSlot(identity,{source:f.source,operationId:randomUUID(),checkpoint:()=>{prepared=true;}}),{code:'nnd_install_path_too_long'});
 assert.equal(prepared,false);await assertNoNndInstallTransaction(identity);
 const store=join(data,'runtime/nnd/install-slots');
 assert.deepEqual(await readdir(join(store,'transactions')),[]);assert.deepEqual(await readdir(join(store,'versions')),[]);
 assert.deepEqual(await readFile(join(data,'config/nnd-package.json')),f.registration);
});
