// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { ensurePrivateNndRuntimeDirectory } from '../src/nnd-service-private-storage.js';

const windows = { skip: process.platform !== 'win32' };
function powershell(script, value) {
  const result = spawnSync(join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      "$ErrorActionPreference='Stop'; [Console]::InputEncoding=[Text.UTF8Encoding]::new($false); $request=[Console]::In.ReadToEnd() | ConvertFrom-Json; " + script],
    { input: JSON.stringify(value), encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 8192 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout.trim();
}
async function fixture(t) {
  const path = join(homedir(), `.nna-private-test-${randomUUID()}`);
  powershell(`
    $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $acl=[Security.AccessControl.DirectorySecurity]::new()
    $acl.SetSecurityDescriptorSddlForm("O:"+$sid+"D:P(A;OICI;FA;;;"+$sid+")(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)")
    [void][IO.Directory]::CreateDirectory($request.path,$acl)
  `, { path });
  t.after(async () => {
    assert.equal(dirname(path), homedir());
    assert.match(path.slice(homedir().length), /^[\\/]\.nna-private-test-[a-f0-9-]+$/u);
    await rm(path, { recursive: true, force: true });
  });
  return path;
}
function sddl(path) { return powershell('([IO.DirectoryInfo]::new($request.path)).GetAccessControl().Sddl', { path }); }
function allowEveryone(path, rights) {
  powershell(`
    $info=[IO.DirectoryInfo]::new($request.path)
    $acl=$info.GetAccessControl()
    $rule=[Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-1-0'),
      [Security.AccessControl.FileSystemRights]$request.rights,[Security.AccessControl.AccessControlType]::Allow)
    $acl.AddAccessRule($rule); $info.SetAccessControl($acl)
  `, { path, rights });
}
test('creates protected private runtime directory and preserves existing parent ACLs', windows, async (t) => {
  const root = await fixture(t);
  assert.equal(powershell('([IO.DriveInfo]::new([IO.Path]::GetPathRoot($request.path))).DriveType.ToString()',
    { path: root }), 'Fixed', 'native acceptance fixture must use a local fixed drive');
  const runtime = join(root, 'runtime');
  await mkdir(runtime);
  allowEveryone(runtime, 'ReadAndExecute');
  const before = sddl(runtime);
  const first = await ensurePrivateNndRuntimeDirectory(root);
  assert.equal(first.path.toLowerCase(), join(runtime, 'nnd').toLowerCase());
  assert.match(first.owner_sid, /^S-1-5-/u);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(sddl(runtime), before);
  const acl = sddl(first.path);
  assert.match(acl, /D:P/u);
  assert.equal(acl.includes(';;;WD)'), false);
  assert.deepEqual(await ensurePrivateNndRuntimeDirectory(root), first);
});
test('concurrent initialization converges on one protected directory', windows, async (t) => {
  const root = await fixture(t);
  const results = await Promise.all([ensurePrivateNndRuntimeDirectory(root), ensurePrivateNndRuntimeDirectory(root)]);
  assert.deepEqual(results[0], results[1]);
  assert.deepEqual(await readdir(join(root, 'runtime')), ['nnd']);
});
test('unsafe existing private ACL fails without repair or deleting evidence', windows, async (t) => {
  const root = await fixture(t);
  const { path } = await ensurePrivateNndRuntimeDirectory(root);
  await writeFile(join(path, 'evidence.txt'), 'preserve');
  allowEveryone(path, 'Read');
  const before = sddl(path);
  await assert.rejects(ensurePrivateNndRuntimeDirectory(root), { code: 'nnd_private_acl_unsafe' });
  assert.equal(sddl(path), before);
  assert.equal(await readFile(join(path, 'evidence.txt'), 'utf8'), 'preserve');
});
test('ancestor delete and ownership rights fail before private directory creation', windows, async (t) => {
  for (const rights of ['Delete', 'DeleteSubdirectoriesAndFiles', 'ChangePermissions', 'TakeOwnership']) {
    const ancestor = await fixture(t);
    const root = join(ancestor, 'data');
    await mkdir(root);
    allowEveryone(ancestor, rights);
    const before = sddl(ancestor);
    await assert.rejects(ensurePrivateNndRuntimeDirectory(root), { code: 'nnd_private_namespace_unsafe' });
    assert.deepEqual(await readdir(root), []);
    assert.equal(sddl(ancestor), before);
  }
});
test('private directory cannot carry foreign inherit-only grants into future token files', windows, async (t) => {
  const root = await fixture(t);
  const { path } = await ensurePrivateNndRuntimeDirectory(root);
  powershell(`
    $info=[IO.DirectoryInfo]::new($request.path)
    $acl=$info.GetAccessControl()
    $rule=[Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-1-0'),
      [Security.AccessControl.FileSystemRights]::Read,[Security.AccessControl.InheritanceFlags]::ObjectInherit,
      [Security.AccessControl.PropagationFlags]::InheritOnly,[Security.AccessControl.AccessControlType]::Allow)
    $acl.AddAccessRule($rule); $info.SetAccessControl($acl)
  `, { path });
  await assert.rejects(ensurePrivateNndRuntimeDirectory(root), { code: 'nnd_private_acl_unsafe' });
});
test('null DACL and generic-all ancestor grants cannot masquerade as safe ACLs', windows, async (t) => {
  for (const descriptor of ['D:NO_ACCESS_CONTROL', 'D:P(A;;GA;;;WD)']) {
    const parent = await fixture(t);
    const root = join(parent, 'data');
    await mkdir(root);
    const before = sddl(root);
    const replace = (value) => powershell(`
      $info=[IO.DirectoryInfo]::new($request.path)
      $acl=$info.GetAccessControl()
      $acl.SetSecurityDescriptorSddlForm($request.descriptor, [Security.AccessControl.AccessControlSections]::Access)
      $info.SetAccessControl($acl)
    `, { path: root, descriptor: value });
    try {
      replace(descriptor);
      await assert.rejects(ensurePrivateNndRuntimeDirectory(root), { code: 'nnd_private_namespace_unsafe' });
      assert.deepEqual(await readdir(root), []);
    } finally { replace(before); }
  }
});
test('reparse directories and invalid paths fail closed without following them', windows, async (t) => {
  const root = await fixture(t);
  const outside = join(root, 'outside');
  await mkdir(outside);
  const data = join(root, 'data');
  await mkdir(data);
  await symlink(outside, join(data, 'runtime'), 'junction');
  await assert.rejects(ensurePrivateNndRuntimeDirectory(data), { code: 'nnd_private_path_invalid' });
  assert.deepEqual(await readdir(outside), []);
  for (const path of ['relative', '\\\\server\\share', `${root}\u0000`, 'x'.repeat(4097)]) {
    await assert.rejects(ensurePrivateNndRuntimeDirectory(path), { code: 'nnd_private_path_invalid' });
  }
});
test('paths with non-ASCII and shell metacharacters are stdin data', windows, async (t) => {
  const parent = await fixture(t);
  const root = join(parent, "données ' $name & (test)");
  await mkdir(root);
  const result = await ensurePrivateNndRuntimeDirectory(root);
  assert.equal(result.path.toLowerCase(), join(root, 'runtime', 'nnd').toLowerCase());
});
test('unsupported platforms cannot claim private Windows storage', { skip: process.platform === 'win32' }, async () => {
  await assert.rejects(ensurePrivateNndRuntimeDirectory('/tmp'), { code: 'nnd_private_platform_unsupported' });
});
