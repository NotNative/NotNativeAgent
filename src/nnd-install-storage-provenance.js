// SPDX-License-Identifier: Apache-2.0
import { lstat, opendir } from 'node:fs/promises';
import { join } from 'node:path';
import { exactRecord } from './nnd-service-contract.js';
import { noLinks } from './nnd-payload-contract-files.js';
import { verifyNndPayload } from './nnd-payload-contract.js';
import { installHost, exists } from './nnd-install-transaction.js';
import { installError,installCapacity,readInstallBytes as read,parseInstallBytes as parse,writeInstallNew as write,json,hash,operationValid } from './nnd-install-storage.js';
const KEYS=['protocol','installation_id','data_id','version','payload_sha256','publication_id','ino','dev','bytes'];
export async function readSlotProvenance(identity,store,sha) {
 const bytes=await read(join(store.provenance,sha+'.json'),4096,true);if(!bytes)return null;
 const value=parse(bytes);
 if(!exactRecord(value,KEYS)||value.protocol!=='2.0'||value.installation_id!==identity.installation_id||value.data_id!==identity.data_id
  ||value.payload_sha256!==sha||typeof value.version!=='string'||!/^\d{8}-[1-9]\d{0,5}$/u.test(value.version)
  ||!operationValid(value.publication_id)||typeof value.ino!=='string'||!/^\d+$/u.test(value.ino)||typeof value.dev!=='string'||!/^\d+$/u.test(value.dev)
  ||!Number.isSafeInteger(value.bytes)||value.bytes<1||value.bytes>2147483648+33554432) throw installError();
 return {bytes,value};
}
export async function slotOwner(path) {
 await noLinks(path);const info=await lstat(path);
 if(!info.isDirectory()||info.isSymbolicLink())throw installError();return {ino:String(info.ino),dev:String(info.dev)};
}
export async function planInstallSlot(identity,store,verified,signal) {
 const slot=join(store.versions,`${verified.manifest.version}-${verified.sha256}`);
 const proof=await readSlotProvenance(identity,store,verified.sha256);
 if(await exists(slot)) {
  if(!proof||proof.value.version!==verified.manifest.version||proof.value.bytes!==payloadBytes(verified))throw installError();
  const owner=await slotOwner(slot);
  if(owner.ino!==proof.value.ino||owner.dev!==proof.value.dev)throw installError();
  if((await verifyNndPayload(slot,{signal,host:installHost(identity)})).sha256!==verified.sha256)throw installError();
  return hash(proof.bytes);
 }
 if(proof)throw installError();
 let total=verified.bytes.length+verified.manifest.files.reduce((sum,file)=>sum+file.bytes,0),count=0;
 for await(const entry of await opendir(store.versions)) {
  if(++count>=16||!entry.isDirectory()||!/^\d{8}-[1-9]\d{0,5}-[a-f0-9]{64}$/u.test(entry.name))throw installCapacity();
  const prior=await readSlotProvenance(identity,store,entry.name.slice(-64));if(!prior)throw installError();
  total+=prior.value.bytes;if(total>8*1024*1024*1024)throw installCapacity();
 }
 if(total>8*1024*1024*1024)throw installCapacity();return null;
}
export async function publishSlotProvenance(identity,store,transaction,verified) {
 const owner=await slotOwner(transaction.slot),prior=await readSlotProvenance(identity,store,verified.sha256);
 if(prior) {
  if(prior.value.ino!==owner.ino||prior.value.dev!==owner.dev||prior.value.version!==verified.manifest.version||prior.value.bytes!==payloadBytes(verified)
   ||transaction.record.reused_provenance!==null&&hash(prior.bytes)!==transaction.record.reused_provenance)throw installError();
  return;
 }
 if(transaction.record.reused_provenance!==null)throw installError();
 const record={protocol:'2.0',installation_id:identity.installation_id,data_id:identity.data_id,version:verified.manifest.version,
  payload_sha256:verified.sha256,publication_id:transaction.record.operation_id,...owner,
  bytes:verified.bytes.length+verified.manifest.files.reduce((sum,file)=>sum+file.bytes,0)};
 await write(join(store.provenance,verified.sha256+'.json'),json(record));
}

function payloadBytes(verified) {return verified.bytes.length+verified.manifest.files.reduce((sum,file)=>sum+file.bytes,0);}
