// SPDX-License-Identifier: Apache-2.0
import { lstat, opendir, unlink, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { validatePayloadManifest } from './nnd-payload-contract.js';
import { noLinks, payloadPath, transferFile } from './nnd-payload-contract-files.js';
import { installError, readInstallBytes as read, parseInstallBytes as parse, writeInstallNew as write,
 json, hash, removeInstallOwned } from './nnd-install-storage.js';
import { assertInstallRegistration, exists } from './nnd-install-transaction.js';
export async function assertSlotOwnership(transaction,path) {
 const owner=parse(await read(join(transaction.directory,'stage-owner.json'),1024));
 await noLinks(path);const info=await lstat(path);
 if(!info.isDirectory()||info.isSymbolicLink()||owner.ino!==String(info.ino)||owner.dev!==String(info.dev)) throw installError();
}
async function removableStage(transaction,signal) {
 const payload=await read(join(transaction.directory,'payload.json'),33554432),manifest=parse(payload);validatePayloadManifest(manifest);
 const allowed=new Map(manifest.files.map(file=>[file.path,file]));allowed.set('NND_PAYLOAD.json',{bytes:payload.length,sha256:hash(payload)});
 const allowedDirectories=new Set();
 for(const path of allowed.keys()) {const parts=path.split('/');parts.pop();while(parts.length){allowedDirectories.add(parts.join('/'));parts.pop();}}
 const directories=[transaction.stage],files=[];let count=0;
 for(let index=0;index<directories.length;index++) {
  for await(const entry of await opendir(directories[index])) {
   signal.throwIfAborted();if(++count>40002) throw installError();
   const path=join(directories[index],entry.name),part=path.slice(transaction.stage.length+1).replaceAll('\\','/');payloadPath(part);
   const info=await lstat(path);
   if(info.isSymbolicLink()) throw installError();
   if(info.isDirectory()&&allowedDirectories.has(part)) directories.push(path);
   else if(info.isFile()&&info.nlink===1&&allowed.has(part)&&info.size<=allowed.get(part).bytes) {
    // Invariant: only an owned short write may be discarded without a complete content hash.
    if(info.size===allowed.get(part).bytes) await transferFile(path,null,allowed.get(part),signal);
    files.push(path);
   }
   else throw installError();
  }
 }
 return {directories,files};
}
export async function recoverIncompleteInstallSlot(identity,store,transaction,signal) {
 if(await exists(transaction.stage)) {
  const owner=await read(join(transaction.directory,'stage-owner.json'),1024,true);
  if(!owner) {
   await noLinks(transaction.stage);await rmdir(transaction.stage);
  } else {
   await assertSlotOwnership(transaction,transaction.stage);
   const entries=await removableStage(transaction,signal);
   for(const path of entries.files) {signal.throwIfAborted();await unlink(path);}
   for(const path of entries.directories.reverse()) {signal.throwIfAborted();await rmdir(path);}
  }
 }
 await assertInstallRegistration(identity,transaction);
 const aborted=json({protocol:'2.0',operation_id:transaction.record.operation_id,prepared_sha256:hash(transaction.bytes),state:'unpublished'});
 const prior=await read(join(transaction.directory,'aborted.json'),1024,true);
 if(prior&&!prior.equals(aborted)) throw installError();
 if(!prior) await write(join(transaction.directory,'aborted.json'),aborted);
 await removeInstallOwned(store.pending,transaction.pending);
 return {state:'unpublished',operation_id:transaction.record.operation_id};
}
