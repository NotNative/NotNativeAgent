// SPDX-License-Identifier: Apache-2.0
import { assertNndInstallRuntimePaths } from './nnd-install-storage-paths.js';
import { resumeInstallInitialization } from './nnd-install-initialization.js';
import { withManifestLock, readLockedManifestSnapshot } from './persistence/manifest-transaction.js';
import { resumeInstallRetirement } from './nnd-install-storage-retention.js';
import { planInstallSlot,readSlotProvenance,slotOwner } from './nnd-install-storage-provenance.js';
import { exactRecord } from './nnd-service-contract.js';
import { validateNndAdmissionReceipt } from './nnd-service-admission.js';
import { join } from 'node:path';
import { acquireNndServiceLock, withNndServiceLease } from './nnd-service-lock.js';
import { scanNndLegacyOwners } from './nnd-legacy-census.js';
import { assertNoNndInstallMarker } from './nnd-install-marker.js';
import { assertNoNndMigration } from './nnd-migration-storage.js';
import { verifyNndPayload } from './nnd-payload-contract.js';
import { within } from './nnd-payload-contract-files.js';
import { openInstallStore, assertNoNndInstallTransaction, readInstallBytes as read,
 parseInstallBytes as parse, installError, operationValid, hash } from './nnd-install-storage.js';
import { prepareInstallTransaction, loadInstallTransaction, copyInstallSlot, completeInstallSlot,
 finishInstallSlot, installHost, installCheckpoint, exists, assertInstallRegistration } from './nnd-install-transaction.js';
import { recoverIncompleteInstallSlot, assertSlotOwnership } from './nnd-install-transaction-recovery.js';
const ACTIVE=new Set();
async function owned(identity,options,operation) {
 if(ACTIVE.size>=8||ACTIVE.has(identity.data_id)) throw installError();
 ACTIVE.add(identity.data_id);let lease;
 try {
  lease=await acquireNndServiceLock({dataRoot:identity.data_root});
  if(lease.dataId!==identity.data_id) throw installError();
  return await withNndServiceLease(lease,identity.data_id,async leaseSignal=>{
   const signal=options.signal?AbortSignal.any([leaseSignal,options.signal]):leaseSignal;
   await assertNoNndInstallMarker(identity);await assertNoNndMigration(identity);
   await scanNndLegacyOwners(identity,signal);
   const store=await openInstallStore(identity,signal);
   await assertInstallAdmission(identity);
   return withManifestLock(join(identity.data_root,'config','nnd-package.json'),{signal},async registryLease=>{
    await readLockedManifestSnapshot(registryLease);
    store.initializationRecovered=await resumeInstallInitialization(identity,store,signal);
    await resumeInstallRetirement(store);
    return operation(store,signal);
   });
  },{timeoutMs:300000});
 } finally { try {await lease?.close();} finally {ACTIVE.delete(identity.data_id);} }
}
export async function stageNndInstallSlot(identity,options={}) {
 if(!operationValid(options.operationId)||typeof options.source!=='string') throw installError();
 return owned(identity,options,async(store,signal)=>{
  const verified=await verifyNndPayload(options.source,{signal,host:installHost(identity)});
  assertNndInstallRuntimePaths(join(store.versions,`${verified.manifest.version}-${verified.sha256}`),verified.manifest);
  if(within(store.root,verified.root)||within(verified.root,store.root)) throw installError();
  const directory=join(store.transactions,options.operationId);
  if(await exists(directory)) {
   const prior=await loadInstallTransaction(identity,store,options.operationId);
   if(prior.record.payload_sha256!==verified.sha256) throw installError();
   return recoverOwned(identity,store,prior,options,signal);
  }
  await assertNoNndInstallTransaction(identity);
  const reuse=await planInstallSlot(identity,store,verified,signal);
  const transaction=await prepareInstallTransaction(identity,store,verified,options.operationId,signal,reuse,options);
  await installCheckpoint(options,'prepared',signal);
  if(reuse!==null)return finishInstallSlot(identity,store,transaction,options,signal);
  await copyInstallSlot(identity,transaction,verified,options,signal);
  return completeInstallSlot(identity,store,transaction,options,signal);
 });
}
export async function recoverNndInstallSlot(identity,options={}) {
 return owned(identity,options,async(store,signal)=>{
  if(store.initializationRecovered?.state==='unpublished') {
   if(options.operationId&&options.operationId!==store.initializationRecovered.operation_id)throw installError();
   return store.initializationRecovered;
  }
  const pending=await read(store.pending,1024,true);
  const id=options.operationId??(pending?parse(pending).operation_id:null);
  if(!operationValid(id)) throw installError();
  const transaction=await loadInstallTransaction(identity,store,id);
  return recoverOwned(identity,store,transaction,options,signal);
 });
}
async function recoverOwned(identity,store,transaction,options,signal) {
 const pending=await read(store.pending,1024,true),ready=await read(join(transaction.directory,'ready.json'),1024,true);
 const aborted=await read(join(transaction.directory,'aborted.json'),1024,true);
 if(aborted&&!pending&&!ready) {
  await assertInstallRegistration(identity,transaction);
  if(await exists(transaction.stage)||await exists(transaction.slot)) throw installError();
  const value=parse(aborted);
  if(!exactRecord(value,['protocol','operation_id','prepared_sha256','state']) || value.prepared_sha256!==hash(transaction.bytes)
   || value.protocol!=='2.0'||value.operation_id!==transaction.record.operation_id||value.state!=='unpublished') throw installError();
  return {state:'unpublished',operation_id:transaction.record.operation_id};
 }
 if(pending&&!pending.equals(transaction.pending)||!pending&&!ready) throw installError();
 await assertInstallRegistration(identity,transaction);
 if(await exists(transaction.slot)) {
  if(await exists(transaction.stage)) throw installError();
  if(transaction.record.reused_provenance===null)await assertSlotOwnership(transaction,transaction.slot);
  else {
   const proof=await readSlotProvenance(identity,store,transaction.record.payload_sha256),owner=await slotOwner(transaction.slot);
   if(!proof||hash(proof.bytes)!==transaction.record.reused_provenance||owner.ino!==proof.value.ino||owner.dev!==proof.value.dev)throw installError();
  }
  return finishInstallSlot(identity,store,transaction,options,signal);
 }
 if(ready) throw installError();
 let complete;
 try { complete=await verifyNndPayload(transaction.stage,{signal,host:installHost(identity)}); }
 catch(error) { if(signal.aborted) throw error; }
 if(complete?.sha256===transaction.record.payload_sha256) {
  await assertSlotOwnership(transaction,transaction.stage);
  return completeInstallSlot(identity,store,transaction,options,signal);
 }
 return recoverIncompleteInstallSlot(identity,store,transaction,signal);
}

async function assertInstallAdmission(identity) {
 for(const [path,legacy] of [[join(identity.data_root,'runtime/nnd/admission.json'),false],[join(identity.data_root,'config/nnd-supervised-owner.json'),true]]) {
  const bytes=await read(path,2048,true);
  if(bytes) validateNndAdmissionReceipt(parse(bytes),identity,legacy);
 }
}
