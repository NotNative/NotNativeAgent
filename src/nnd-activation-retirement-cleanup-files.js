// SPDX-License-Identifier: Apache-2.0
import { lstat, opendir, unlink, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ContractError } from './ids.js';
import { readInstallBytes, hash } from './nnd-install-storage.js';
import { noLinks } from './nnd-payload-contract-files.js';
import { runPrivateWindowsProgram, PRIVATE_ACL_PROGRAM } from './nnd-service-private-windows.js';

const invalid = () => new ContractError('nnd_activation_retirement_cleanup_invalid',
  'NND retirement cleanup is unresolved; preserve the pending barrier and remaining evidence.');
const ACL = PRIVATE_ACL_PROGRAM + String.raw`
try {
 $r=[Console]::In.ReadToEnd()|ConvertFrom-Json
 foreach($p in $r.directories) { Assert-Ancestors $p; Assert-Directory $p $true }
 foreach($p in $r.files) {
  Assert-Ancestors ([IO.Path]::GetDirectoryName($p))
  $f=[IO.FileInfo]::new($p)
  if(-not $f.Exists -or ($f.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'file' }
  $acl=$f.GetAccessControl(); Assert-Acl $acl $false
  if($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $operatorSid) { throw 'owner' }
  foreach($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
   if($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or $trusted -notcontains $rule.IdentityReference.Value) { throw 'acl' }
  }
 }
 [Console]::Out.WriteLine('{"ok":true}')
} catch { [Console]::Out.WriteLine('{"error_code":"nnd_private_storage_unavailable"}'); exit 1 }
`;
export async function assertRetirementBarrierAcl(place, files, signal) {
  await runPrivateWindowsProgram(ACL, { directories: [place.activations], files }, signal);
}
export function retirementCleanupPaths(identity, operationId) {
  const root = join(identity.data_root, 'runtime', 'nnd', 'install-slots');
  const activations = join(root, 'activations');
  return { activations, directory: join(activations, operationId),
    plan: join(root, 'activation-retirement.json'), decision: join(root, 'activation-retirement-decision.json'),
    terminal: join(root, 'activation-retirement-commit.json'),
    cleared: join(root, 'activation-retirement-cleared.json'),
    marker: join(identity.data_root, 'runtime', 'nnd', 'installation-pending.json') };
}
export function retirementArtifactPath(place, operationId, name) {
  return name.startsWith('activation-') ? join(place.directory, name)
    : join(place.activations, `${operationId}.${name}`);
}
async function directoryPresent(place, plan) {
  let info;
  try { info = await lstat(place.directory); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  if (!info.isDirectory() || info.isSymbolicLink() || String(info.ino) !== plan.directory_ino
    || String(info.dev) !== plan.directory_dev) throw invalid();
  await noLinks(place.directory);
  return true;
}
async function inspectRoot(place, operationId) {
  await noLinks(place.activations);
  const allowed = new Set([operationId, `${operationId}.candidate.json`,
    `${operationId}.registration.before`, `${operationId}.child.json`]);
  let count = 0;
  for await (const entry of await opendir(place.activations)) {
    // Security: an unexpected activation entry cannot be classified as this cleanup's property.
    if (++count > 4 || !allowed.has(entry.name) || entry.isSymbolicLink()
      || (entry.name === operationId ? !entry.isDirectory() : !entry.isFile())) throw invalid();
  }
}
/** Inspect the whole remaining set before any deletion, including evidence not selected next. */
export async function inspectRetirementArtifacts(place, operationId, plan, signal) {
  await inspectRoot(place, operationId);
  const hasDirectory = await directoryPresent(place, plan);
  if (hasDirectory) {
    let count = 0;
    for await (const entry of await opendir(place.directory)) {
      if (++count > 9 || !entry.isFile() || !/^activation-0[0-8]\.json$/u.test(entry.name)) throw invalid();
    }
  }
  const present = [];
  for (const file of plan.files) {
    signal.throwIfAborted();
    const path = retirementArtifactPath(place, operationId, file.name);
    const content = await readInstallBytes(path, 16384, true);
    if (content && (!file.present || hash(content) !== file.sha256)) throw invalid();
    if (content) present.push({ ...file, path });
  }
  await runPrivateWindowsProgram(ACL, { directories: [place.activations,
    ...(hasDirectory ? [place.directory] : [])],
    files: [place.plan, place.decision, place.marker, ...present.map(file => file.path)] }, signal);
  return { present, hasDirectory };
}
/** No recursive removal: only one exact recorded file or the verified empty original directory. */
export async function removeRetirementArtifact(place, operationId, plan, file) {
  if (file) {
    const expectedPath = retirementArtifactPath(place, operationId, file.name);
    if (file.path !== expectedPath || !plan.files.some(row => row.name === file.name
      && row.present && row.sha256 === file.sha256)) throw invalid();
    const content = await readInstallBytes(expectedPath, 16384);
    if (hash(content) !== file.sha256) throw invalid();
    await unlink(expectedPath);
  } else if (await directoryPresent(place, plan)) {
    await rmdir(place.directory);
  }
}
