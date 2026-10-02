// SPDX-License-Identifier: Apache-2.0
import { opendir, lstat, unlink, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { exactRecord } from './nnd-service-contract.js';
import { loadInstallTransaction,exists } from './nnd-install-transaction.js';
import { installError,installCapacity,readInstallBytes as read,parseInstallBytes as parse,hash,json,writeInstallNew as write,operationValid,removeInstallOwned } from './nnd-install-storage.js';
const FILES=new Set(['prepared.json','payload.json','registration.before','stage-owner.json','ready.json','aborted.json']);
export async function reserveInstallReceipt(identity,store) {
 const entries=[];for await(const entry of await opendir(store.transactions)) entries.push(entry.name);
 if(entries.length<16)return;if(entries.length>16)throw installCapacity();
 const terminal=[];
 for(const id of entries) {
  const directory=join(store.transactions,id);
  if(await exists(join(directory,'staging')))continue;
  const ready=await read(join(directory,'ready.json'),1024,true),aborted=await read(join(directory,'aborted.json'),1024,true);
  if(!ready&&!aborted)continue;if(ready&&aborted)throw installError();
  const transaction=await loadInstallTransaction(identity,store,id),record=parse(ready??aborted);
  if(!exactRecord(record,['protocol','operation_id','prepared_sha256','state'])||record.protocol!=='2.0'||record.operation_id!==id
   ||record.prepared_sha256!==hash(transaction.bytes)||record.state!==(ready?'slot_ready':'unpublished'))throw installError();
  const before=await read(join(directory,'registration.before'),16384,true);
  if((before?hash(before):null)!==transaction.record.registration_sha256)throw installError();
  const files=[];
  for await(const entry of await opendir(directory)) {
   if(!entry.isFile()||!FILES.has(entry.name))throw installError();
   files.push(join(directory,entry.name));
  }
  terminal.push({directory,files,time:(await lstat(join(directory,'prepared.json'))).mtimeMs});
 }
 if(!terminal.length)throw installCapacity();terminal.sort((a,b)=>a.time-b.time);
 const selected=terminal[0],info=await lstat(selected.directory),files=[];
 for(const path of selected.files)files.push({name:path.slice(selected.directory.length+1),sha256:hash(await read(path,33554432))});
 const plan={protocol:'2.0',operation_id:selected.directory.slice(store.transactions.length+1),ino:String(info.ino),dev:String(info.dev),files};
 await write(join(store.root,'retirement.json'),json(plan));
 await resumeInstallRetirement(store);
}

export async function resumeInstallRetirement(store) {
 const marker=join(store.root,'retirement.json'),bytes=await read(marker,4096,true);if(!bytes)return;
 const plan=parse(bytes);
 if(!exactRecord(plan,['protocol','operation_id','ino','dev','files'])||plan.protocol!=='2.0'||!operationValid(plan.operation_id)
  ||!Array.isArray(plan.files)||plan.files.length>6||new Set(plan.files.map(file=>file?.name)).size!==plan.files.length)throw installError();
 for(const file of plan.files)if(!exactRecord(file,['name','sha256'])||!FILES.has(file.name)||typeof file.sha256!=='string'||!/^[a-f0-9]{64}$/u.test(file.sha256))throw installError();
 const directory=join(store.transactions,plan.operation_id);
 if(await exists(directory)) {
  const info=await lstat(directory);
  if(!info.isDirectory()||info.isSymbolicLink()||String(info.ino)!==plan.ino||String(info.dev)!==plan.dev)throw installError();
  const allowed=new Map(plan.files.map(file=>[file.name,file.sha256])),remaining=[];
  for await(const entry of await opendir(directory)) {
   if(!entry.isFile()||!allowed.has(entry.name))throw installError();
   const path=join(directory,entry.name);if(hash(await read(path,33554432))!==allowed.get(entry.name))throw installError();remaining.push(path);
  }
  for(const path of remaining)await unlink(path);
  await rmdir(directory);
 }
 await removeInstallOwned(marker,bytes);
}
