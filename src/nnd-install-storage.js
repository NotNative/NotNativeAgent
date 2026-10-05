// SPDX-License-Identifier: Apache-2.0
import { lstat, open, opendir, unlink, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ContractError } from './ids.js';
import { ensurePrivateNndRuntimeDirectory } from './nnd-service-private-storage.js';
import { PRIVATE_ACL_PROGRAM, runPrivateWindowsProgram } from './nnd-service-private-windows.js';
import { readPayloadBytes } from './nnd-payload-contract.js';
import { noLinks } from './nnd-payload-contract-files.js';
import { hasInstallInitialization } from './nnd-install-initialization-db.js';
import { hasActivationInitialization, hasActivationEvidence } from './nnd-activation-initialization-db.js';
export const installCapacity = () => new ContractError('nnd_install_store_full','NND slot storage is full. Preserve existing slots and use native maintenance before staging another version.');
export const installError = () => new ContractError('nnd_install_transaction_invalid','NND slot transaction evidence could not be verified; existing state was preserved.');
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const json = value => Buffer.from(JSON.stringify(value)+'\n');
export const operationValid = value => typeof value==='string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value);
const PROGRAM=PRIVATE_ACL_PROGRAM+String.raw`
try {
 $r=[Console]::In.ReadToEnd()|ConvertFrom-Json
 foreach($p in $r.directories) { if ($r.create) { Create-PrivateDirectory $p }; Assert-Directory $p $true }
 $count=0
 foreach($directory in $r.evidence) {
  if(-not [IO.Directory]::Exists($directory)) { continue }
  Assert-Ancestors $directory
  foreach($p in [IO.Directory]::EnumerateFiles($directory,'*',[IO.SearchOption]::TopDirectoryOnly)) {
   $count++; if($count -gt 128) { throw 'bound' }
   $file=[IO.FileInfo]::new($p)
   if($file.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'link' }
   $acl=$file.GetAccessControl(); Assert-Acl $acl $false
   if($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $operatorSid) { throw 'owner' }
   foreach($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
    if($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or $trusted -notcontains $rule.IdentityReference.Value) { throw 'acl' }
   }
  }
 }
 [Console]::Out.WriteLine('{"ok":true}')
} catch { [Console]::Out.WriteLine('{"error_code":"nnd_private_storage_unavailable"}'); exit 1 }
`;
export async function readInstallBytes(path,limit=65536,optional=false) {
 try { await lstat(path); } catch(error) { if(optional&&error.code==='ENOENT') return null; throw installError(); }
 try { return await readPayloadBytes(path,limit); } catch { throw installError(); }
}
export function parseInstallBytes(bytes) {
 try { return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)); } catch { throw installError(); }
}
export async function writeInstallNew(path,bytes) {
 const file=await open(path,'wx',0o600);
 try { await file.writeFile(bytes);await file.sync(); } finally { await file.close(); }
}
export async function removeInstallOwned(path,bytes) {
 if(hash(await readInstallBytes(path,Math.max(65536,bytes.length)))!==hash(bytes)) throw installError();
 await unlink(path);
}
export async function assertNoNndInstallTransaction(identity) {
 const path=join(identity.data_root,'runtime','nnd','installation-pending.json');
 try { await lstat(path); } catch(error) { if(error.code==='ENOENT'&&!await hasInstallInitialization(identity.data_root)
  &&!await hasActivationInitialization(identity.data_root)
  &&!await hasActivationEvidence(identity.data_root, identity)) return; if(error.code!=='ENOENT')throw installError(); }
 throw new ContractError('nnd_install_transaction_pending','NND installation or activation has pending evidence; native recovery is required.');
}
export async function openInstallStore(identity,signal,{readOnly=false}={}) {
 const runtime=await ensurePrivateNndRuntimeDirectory(identity.data_root,{signal,create:!readOnly});
 const root=join(runtime.path,'install-slots'),versions=join(root,'versions'),transactions=join(root,'transactions'),provenance=join(root,'provenance');
 await runPrivateWindowsProgram(PROGRAM,{directories:[root,versions,transactions,provenance],evidence:[runtime.path,root,provenance],create:!readOnly},signal);
 const binding={protocol:'2.0',installation_id:identity.installation_id,data_id:identity.data_id,
  install_root:(await realpath(identity.install_root)).toLowerCase(),data_root:(await realpath(identity.data_root)).toLowerCase()};
 if(identity.installation_id!==`nna_${hash(binding.install_root)}` || identity.data_id!==`data_${hash(binding.data_root)}`) throw installError();
 const bytes=json(binding),path=join(root,'binding.json'),existing=await readInstallBytes(path,16384,true);
 if(existing && !existing.equals(bytes)) throw installError();
 if(!existing) { if(readOnly) throw installError(); await writeInstallNew(path,bytes); }
 const store={root,versions,transactions,provenance,pending:join(runtime.path,'installation-pending.json'),binding};
 const directories=[];
 for await(const entry of await opendir(transactions)) {
  if(directories.length>=16 || !entry.isDirectory() || !operationValid(entry.name)) throw installError();
  const directory=join(transactions,entry.name);await noLinks(directory);directories.push(directory);
 }
 await runPrivateWindowsProgram(PROGRAM,{directories:[],evidence:directories},signal);
 return store;
}
export async function newInstallTransaction(store,id,signal) {
 let count=0;for await(const _entry of await opendir(store.transactions)) if(++count>=16) throw installCapacity();
 const directory=join(store.transactions,id);
 try {await lstat(directory);throw installError();} catch(error) {if(error.code!=='ENOENT') throw error;}
 await runPrivateWindowsProgram(PROGRAM,{directories:[directory],evidence:[],create:true},signal);return directory;
}
