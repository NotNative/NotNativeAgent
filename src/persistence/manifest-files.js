// SPDX-License-Identifier: Apache-2.0
import { createHash, randomUUID } from 'node:crypto';
import { lstat, realpath, statfs, open, mkdir, opendir, rename, link, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { ContractError } from '../ids.js';
import { PRIVATE_ACL_PROGRAM, runPrivateWindowsProgram } from '../nnd-service-private-windows.js';

export const MANIFEST_LIMIT = 1024 * 1024;
export const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
export function manifestFailure(code, persistence = 'unpublished') {
  const error = new ContractError(code, 'Native manifest transaction could not be completed');
  error.persistence = persistence;
  return error;
}
const WINDOWS_DIRECTORY = PRIVATE_ACL_PROGRAM + String.raw`
try {
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $parent = [IO.Path]::GetFullPath([string]$request.parent)
  $drive = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($parent))
  if ($drive.DriveType -ne [IO.DriveType]::Fixed) { throw 'nnd_private_path_invalid' }
  Assert-Ancestors $parent
  if ([IO.File]::Exists([string]$request.target)) {
    $targetAcl = [IO.File]::GetAccessControl([string]$request.target)
    Assert-Acl $targetAcl $false
    foreach ($rule in $targetAcl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
      if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
        $trusted -notcontains $rule.IdentityReference.Value -and ([int]$rule.FileSystemRights -band 0x40000116)) {
        throw 'nnd_private_acl_unsafe'
      }
    }
  }
  if (-not $request.prepareStorage) { [Console]::Out.WriteLine('{"ok":true}'); exit 0 }
  Create-PrivateDirectory ([string]$request.storage)
  Assert-Directory ([string]$request.storage) $true
  $count = 0
  foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries([string]$request.storage)) {
    $count++
    if ($count -gt 260) { throw 'nnd_private_path_invalid' }
    $info = [IO.FileInfo]::new($entry)
    if (-not $info.Exists) { continue }
    if (($info.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'nnd_private_path_invalid' }
    try { $acl = $info.GetAccessControl() }
    catch [IO.FileNotFoundException] { continue }
    catch [IO.DirectoryNotFoundException] { continue }
    Assert-Acl $acl $false
    if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $operatorSid) { throw 'nnd_private_acl_unsafe' }
    $rules = $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])
    foreach ($rule in $rules) {
      if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or $trusted -notcontains $rule.IdentityReference.Value) { throw 'nnd_private_acl_unsafe' }
    }
  }
  [Console]::Out.WriteLine('{"ok":true}')
} catch { [Console]::Out.WriteLine('{"error_code":"nnd_private_path_invalid"}'); exit 1 }
`;

export async function manifestTarget(path, { signal, prepareStorage = true } = {}) {
  if (typeof path !== 'string' || path.length > 4096 || !isAbsolute(path)
    || /[\u0000-\u001f]/u.test(path) || path.startsWith('\\\\')) throw manifestFailure('manifest_target_invalid');
  signal?.throwIfAborted();
  const parent = await realpath(dirname(path));
  const name = basename(path);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(name)) throw manifestFailure('manifest_target_invalid');
  if (process.platform === 'win32' && (/\.$/u.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(name))) throw manifestFailure('manifest_target_invalid');
  await rejectLinks(dirname(resolve(path)));
  let canonical = join(parent, name);
  if (await regularOrMissing(canonical, true)) canonical = await realpath(canonical);
  const key = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
  const storage = join(parent, `.nna-manifest-${digest(key)}`);
  if (process.platform === 'win32') {
    try { await runPrivateWindowsProgram(WINDOWS_DIRECTORY, { parent, storage, target: canonical, prepareStorage }, signal); }
    catch { throw manifestFailure('manifest_target_unsafe'); }
  } else {
    const info = await statfs(parent);
    // Security: admit known local filesystem families; unknown/network mounts fail closed.
    if (![0xef53, 0x58465342, 0x9123683e, 0x01021994, 0x794c7630, 0x425358, 0x1a, 0x11, 0x2fc12fc1].includes(Number(info.type))) {
      throw manifestFailure('manifest_filesystem_unsupported');
    }
    if (!prepareStorage) return Object.freeze({path:canonical,key,storage});
    await mkdir(storage, { mode: 0o700 }).catch((error) => { if (error.code !== 'EEXIST') throw error; });
    const secure = await lstat(storage);
    if (!secure.isDirectory() || secure.isSymbolicLink() || secure.uid !== process.getuid() || secure.mode & 0o077) {
      throw manifestFailure('manifest_target_unsafe');
    }
  }
  if (!prepareStorage) return Object.freeze({path:canonical,key,storage});
  const listing = await opendir(storage); let count = 0;
  for await (const entry of listing) {
    if (++count > 260) throw manifestFailure('manifest_storage_capacity');
    const file = await regularOrMissing(join(storage, entry.name), true);
    if (process.platform !== 'win32' && file && (file.uid !== process.getuid() || file.mode & 0o077)) {
      throw manifestFailure('manifest_target_unsafe');
    }
  }
  await regularOrMissing(canonical, true);
  return Object.freeze({ path: canonical, key, storage });
}
async function rejectLinks(path) {
  for (let count = 0; count < 128; count++) {
    if ((await lstat(path)).isSymbolicLink()) throw manifestFailure('manifest_target_unsafe');
    if (process.platform !== 'win32') {
      const info = await lstat(path);
      if (![0, process.getuid()].includes(info.uid) || (info.mode & 0o022) && !(info.mode & 0o1000)) {
        throw manifestFailure('manifest_target_unsafe');
      }
    }
    const next = dirname(path); if (next === path) return; path = next;
  }
  throw manifestFailure('manifest_target_invalid');
}
export async function regularOrMissing(path, allowPreparedLink = false) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || (info.nlink !== 1 && !(allowPreparedLink && info.nlink === 2))) throw manifestFailure('manifest_target_unsafe');
    if (process.platform !== 'win32' && (info.uid !== process.getuid() || info.mode & 0o022)) {
      throw manifestFailure('manifest_target_unsafe');
    }
    return info;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export async function readTargetSnapshot(target, allowPreparedLink = false) {
  const before = await regularOrMissing(target.path, allowPreparedLink);
  if (!before) return Object.freeze({ path: target.path, state: 'missing', rawManifest: null, rawBytes: null, revision: 'absent' });
  const handle = await open(target.path, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile() || (info.nlink !== 1 && !(allowPreparedLink && info.nlink === 2)) || info.size > MANIFEST_LIMIT
      || info.dev !== before.dev || info.ino !== before.ino) throw manifestFailure('manifest_target_unsafe');
    const bytes = Buffer.alloc(MANIFEST_LIMIT + 1); let size = 0;
    while (size < bytes.length) {
      const read = await handle.read(bytes, size, bytes.length - size, null); if (!read.bytesRead) break; size += read.bytesRead;
    }
    if (size > MANIFEST_LIMIT) throw manifestFailure('manifest_size_invalid');
    const rawBytes = bytes.subarray(0, size); let rawManifest = null;
    try { rawManifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(rawBytes)); } catch { /* Invariant: malformed bytes remain available for explicit repair. */ }
    return Object.freeze({ path: target.path, state: 'present', rawManifest, rawBytes, revision: digest(rawBytes) });
  } finally { await handle.close(); }
}
export async function writePrivateFile(path, bytes) {
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}
export async function stageManifest(target, bytes) {
  const staged = join(target.storage, `stage-${randomUUID()}.json`);
  await writePrivateFile(staged, bytes); return staged;
}
export async function publishManifest(target, staged, absent) {
  let published = false;
  try {
  if (absent) { await link(staged, target.path); published = true; await unlink(staged); }
  else {
    for (let attempt = 0; ; attempt++) {
      try { await rename(staged, target.path); published = true; break; }
      catch (error) {
        if (process.platform !== 'win32' || !['EPERM','EBUSY','EACCES'].includes(error.code) || attempt >= 40) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  }
  if (process.platform !== 'win32') {
    const directory = await open(dirname(target.path), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }
  } catch (error) { error.manifestPublished = published; throw error; }
}
