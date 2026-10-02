// SPDX-License-Identifier: Apache-2.0
import { assertNndInstallRuntimePaths } from './nnd-install-storage-paths.js';
import { initializeInstallTransaction } from './nnd-install-initialization.js';
import { assertSlotOwnership } from './nnd-install-transaction-recovery.js';
import { reserveInstallReceipt } from './nnd-install-storage-retention.js';
import { publishSlotProvenance } from './nnd-install-storage-provenance.js';
import { join } from 'node:path';
import { lstat, mkdir, rename } from 'node:fs/promises';
import { exactRecord } from './nnd-service-contract.js';
import { verifyNndPayload, copyNndPayload } from './nnd-payload-contract.js';
import { readInstallBytes as read, writeInstallNew as write, parseInstallBytes as parse,
 installError, json, hash, operationValid, removeInstallOwned } from './nnd-install-storage.js';
const KEYS=['protocol','operation_id','installation_id','data_id','version','payload_sha256','registration_sha256','source_root','reused_provenance'];
export function installHost(identity) {
 return {platform:identity.platform,architecture:identity.architecture,node_major:identity.node_major,
  capabilities:['service_supervision','setup_control_plane'],data_schemas:{nnd_catalog:1,nnd_state:1}};
}
const registrationPath=identity=>join(identity.data_root,'config','nnd-package.json');
export async function assertInstallRegistration(identity,transaction) {
 const current=await read(registrationPath(identity),16384,true);
 const before=await read(join(transaction.directory,'registration.before'),16384,true);
 const expected=transaction.record.registration_sha256;
 if((before===null?null:hash(before))!==expected || (current===null?null:hash(current))!==expected) throw installError();
}
export async function prepareInstallTransaction(identity,store,verified,id,signal,reusedProvenance=null,options={}) {
 if(!operationValid(id)) throw installError();
 await reserveInstallReceipt(identity,store);
 const before=await read(registrationPath(identity),16384,true);
 const record={protocol:'2.0',operation_id:id,installation_id:identity.installation_id,data_id:identity.data_id,
  version:verified.manifest.version,payload_sha256:verified.sha256,registration_sha256:before?hash(before):null,source_root:verified.root,reused_provenance:reusedProvenance};
 const bytes=json(record);
 const pending=json({protocol:'2.0',operation_id:id,installation_id:identity.installation_id,data_id:identity.data_id});
 const files=[...(before?[['registration.before',before]]:[]),['payload.json',verified.bytes],['prepared.json',bytes]];
 const directory=await initializeInstallTransaction(identity,store,id,files,pending,options,signal);
 return {record,bytes,directory,pending,stage:join(directory,'staging'),slot:join(store.versions,`${record.version}-${record.payload_sha256}`)};
}
export async function loadInstallTransaction(identity,store,id) {
 if(!operationValid(id)) throw installError();
 const directory=join(store.transactions,id),bytes=await read(join(directory,'prepared.json'),16384),record=parse(bytes);
 if(!exactRecord(record,KEYS) || record.protocol!=='2.0' || record.operation_id!==id
  || record.installation_id!==identity.installation_id || record.data_id!==identity.data_id
  || typeof record.version!=='string' || !/^\d{8}-[1-9]\d{0,5}$/u.test(record.version) || typeof record.payload_sha256!=='string' || !/^[a-f0-9]{64}$/u.test(record.payload_sha256)
  || !(record.registration_sha256===null || typeof record.registration_sha256==='string' && /^[a-f0-9]{64}$/u.test(record.registration_sha256)) || typeof record.source_root!=='string') throw installError();
 if(!(record.reused_provenance===null||typeof record.reused_provenance==='string'&&/^[a-f0-9]{64}$/u.test(record.reused_provenance)))throw installError();
 const payload=await read(join(directory,'payload.json'),33554432);
 if(hash(payload)!==record.payload_sha256) throw installError();
 const pending=json({protocol:'2.0',operation_id:id,installation_id:identity.installation_id,data_id:identity.data_id});
 return {record,bytes,directory,pending,stage:join(directory,'staging'),slot:join(store.versions,`${record.version}-${record.payload_sha256}`)};
}
export async function installCheckpoint(options,phase,signal) {
 signal.throwIfAborted();await options.checkpoint?.(phase);signal.throwIfAborted();
}
export async function completeInstallSlot(identity,store,transaction,options,signal) {
 await assertInstallRegistration(identity,transaction);
 const stage=await verifyNndPayload(transaction.stage,{signal,host:installHost(identity)});
 assertNndInstallRuntimePaths(transaction.slot,stage.manifest);
 if(stage.sha256!==transaction.record.payload_sha256) throw installError();
 if(await exists(transaction.slot)) throw installError();
 await installCheckpoint(options,'before_rename',signal);
 await assertSlotOwnership(transaction,transaction.stage);
 await rename(transaction.stage,transaction.slot);
 await installCheckpoint(options,'renamed',signal);
 return finishInstallSlot(identity,store,transaction,options,signal);
}
export async function finishInstallSlot(identity,store,transaction,options,signal) {
 if(transaction.record.reused_provenance===null)await assertSlotOwnership(transaction,transaction.slot);
 const verified=await verifyNndPayload(transaction.slot,{signal,host:installHost(identity)});
 assertNndInstallRuntimePaths(transaction.slot,verified.manifest);
 if(verified.sha256!==transaction.record.payload_sha256) throw installError();
 await assertInstallRegistration(identity,transaction);
 await publishSlotProvenance(identity,store,transaction,verified);
 const ready=json({protocol:'2.0',operation_id:transaction.record.operation_id,prepared_sha256:hash(transaction.bytes),state:'slot_ready'});
 const previous=await read(join(transaction.directory,'ready.json'),1024,true);
 if(previous && !previous.equals(ready)) throw installError();
 if(!previous) await write(join(transaction.directory,'ready.json'),ready);
 await installCheckpoint(options,'slot_ready',signal);
 await assertInstallRegistration(identity,transaction);
 const pending=await read(store.pending,1024,true);
 if(pending) await removeInstallOwned(store.pending,transaction.pending);
 await installCheckpoint(options,'barrier_cleared',signal);
 return Object.freeze({state:'slot_ready',operation_id:transaction.record.operation_id,version:verified.manifest.version,
  payload_sha256:verified.sha256,slot:transaction.slot,replay_window:'last_16_terminal_operations'});
}
export async function copyInstallSlot(identity,transaction,verified,options,signal) {
 await mkdir(transaction.stage);
 const info=await lstat(transaction.stage);
 await write(join(transaction.directory,'stage-owner.json'),json({ino:String(info.ino),dev:String(info.dev)}));
 await installCheckpoint(options,'staging_created',signal);
 await copyNndPayload(verified,transaction.stage,{signal,host:installHost(identity)});
 await installCheckpoint(options,'copied',signal);
}
export async function exists(path) {
 try { await lstat(path);return true; } catch(error) {if(error.code==='ENOENT') return false;throw installError();}
}
