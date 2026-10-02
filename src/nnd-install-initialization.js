// SPDX-License-Identifier: Apache-2.0
import { opendir, lstat, unlink, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { exactRecord } from './nnd-service-contract.js';
import { noLinks } from './nnd-payload-contract-files.js';
import { withInstallInitialization } from './nnd-install-initialization-db.js';
import { installError, operationValid, readInstallBytes as read, writeInstallNew as write,
 json, hash, newInstallTransaction } from './nnd-install-storage.js';

const LIMITS={'registration.before':16384,'payload.json':33554432,'prepared.json':16384};
const PREPARED_KEYS=['protocol','operation_id','installation_id','data_id','version','payload_sha256','registration_sha256','source_root','reused_provenance'];
async function checkpoint(options,phase,signal) {signal.throwIfAborted();await options.checkpoint?.(phase);signal.throwIfAborted();}
export async function initializeInstallTransaction(identity,store,id,files,pending,options,signal) {
 const directory=join(store.transactions,id);
 // The atomic row exists before any UUID directory or metadata file can be allocated.
 await read(directory,1,true).then(value=>{if(value!==null)throw installError();});
 const plan={protocol:'2.0',operation_id:id,installation_id:identity.installation_id,data_id:identity.data_id,
  files:files.map(([name,bytes])=>({name,bytes:bytes.toString('base64')})),pending:pending.toString('base64')};
 const bytes=JSON.stringify(plan);
 await withInstallInitialization(store.root,async database=>{
  await checkpoint(options,'initialization_before_commit',signal);
  database.write(bytes);await checkpoint(options,'initialization_committed',signal);
  await newInstallTransaction(store,id,signal);await checkpoint(options,'initialization_directory',signal);
  for(const [name,contents]of files){await write(join(directory,name),contents);await checkpoint(options,`initialization_${name}`,signal);}
  await write(store.pending,pending);await checkpoint(options,'initialization_pending',signal);
  database.clear(bytes);await checkpoint(options,'initialization_cleared',signal);
 });
 return directory;
}
function decode(value,limit) {
 if(typeof value!=='string'||value.length>Math.ceil(limit/3)*4)throw installError();
 const bytes=Buffer.from(value,'base64');if(bytes.length>limit||bytes.toString('base64')!==value)throw installError();return bytes;
}
function validate(bytes,identity) {
 let plan;try{plan=JSON.parse(bytes);}catch{throw installError();}
 if(!exactRecord(plan,['protocol','operation_id','installation_id','data_id','files','pending'])||plan.protocol!=='2.0'
  ||!operationValid(plan.operation_id)||plan.installation_id!==identity.installation_id||plan.data_id!==identity.data_id
  ||!Array.isArray(plan.files)||plan.files.length<2||plan.files.length>3)throw installError();
 const files=new Map();
 for(const file of plan.files){if(!exactRecord(file,['name','bytes'])||!Object.hasOwn(LIMITS,file.name)||files.has(file.name))throw installError();files.set(file.name,decode(file.bytes,LIMITS[file.name]));}
 if(!files.has('payload.json')||!files.has('prepared.json'))throw installError();
 const pending=decode(plan.pending,1024),expected=json({protocol:'2.0',operation_id:plan.operation_id,installation_id:identity.installation_id,data_id:identity.data_id});
 if(!pending.equals(expected))throw installError();
 let prepared;try{prepared=JSON.parse(files.get('prepared.json'));}catch{throw installError();}
 const before=files.get('registration.before');
 if(!exactRecord(prepared,PREPARED_KEYS)||prepared.protocol!=='2.0'||prepared.operation_id!==plan.operation_id
  ||prepared.installation_id!==identity.installation_id||prepared.data_id!==identity.data_id
  ||typeof prepared.version!=='string'||!/^\d{8}-[1-9]\d{0,5}$/u.test(prepared.version)||typeof prepared.source_root!=='string'
  ||!(prepared.reused_provenance===null||typeof prepared.reused_provenance==='string'&&/^[a-f0-9]{64}$/u.test(prepared.reused_provenance))
  ||prepared.registration_sha256!==(before?hash(before):null)||prepared.payload_sha256!==hash(files.get('payload.json')))throw installError();
 return {plan,files,pending,before};
}
export async function resumeInstallInitialization(identity,store,signal) {
 return withInstallInitialization(store.root,async database=>{
  const bytes=database.read();if(bytes===null)return null;
  const intent=validate(bytes,identity),directory=join(store.transactions,intent.plan.operation_id);
  const current=await read(join(identity.data_root,'config/nnd-package.json'),16384,true);
  if((current?hash(current):null)!==(intent.before?hash(intent.before):null))throw installError();
  const marker=await read(store.pending,1024,true);
  if(marker&&!intent.pending.subarray(0,marker.length).equals(marker))throw installError();
  const entries=[];let complete=false;
  try {
   await noLinks(directory);const info=await lstat(directory);if(!info.isDirectory()||info.isSymbolicLink())throw installError();
   for await(const entry of await opendir(directory)){
    signal.throwIfAborted();if(!entry.isFile()||!intent.files.has(entry.name)||entries.length>=3)throw installError();
    const expected=intent.files.get(entry.name),path=join(directory,entry.name),observed=await read(path,expected.length);
    if(!expected.subarray(0,observed.length).equals(observed))throw installError();entries.push({path,complete:observed.equals(expected)});
   }
   complete=entries.length===intent.files.size&&entries.every(entry=>entry.complete)&&marker?.equals(intent.pending)===true;
  }catch(error){if(error.code!=='ENOENT')throw error;}
  if(!complete){
   if(marker)await unlink(store.pending);
   for(const entry of entries){signal.throwIfAborted();await unlink(entry.path);}
   try{await rmdir(directory);}catch(error){if(error.code!=='ENOENT')throw installError();}
  }
  database.clear(bytes);
  return {state:complete?'prepared':'unpublished',operation_id:intent.plan.operation_id};
 });
}
