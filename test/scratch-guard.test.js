// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { SCRATCH_ROOT, armScratchRestore, assertScratchPath, createScratchSync, disarmScratchRestore } from './scratch.js';

const windows = { skip: process.platform !== 'win32' };

test('ACL helpers refuse any path outside the scratch root', () => {
  // Why the hard line: ACL residue outlives the test process, and a
  // mis-resolved target once stranded a foreign ACE on the workspace root.
  assert.throws(() => assertScratchPath(join(homedir(), 'not-scratch'), 'probe'), TypeError);
  assert.throws(() => assertScratchPath(SCRATCH_ROOT, 'probe'), TypeError, 'the root itself is not a fixture path');
  assert.throws(() => armScratchPathProbe(), TypeError);
  function armScratchPathProbe() {
    armScratchRestore(join(SCRATCH_ROOT, '..', 'escape'), () => undefined);
  }
});

test('arm and disarm manage the restore registration inside the scratch root', windows, async (t) => {
  const parent = createScratchSync('nna-scratch-guard');
  t.after(async () => { await import('node:fs/promises').then((fs) => fs.rm(parent, { recursive: true, force: true })); });
  const target = join(parent, 'guarded');
  await mkdir(target);
  assert.equal(typeof armScratchRestore(target, () => undefined), 'undefined', 'arming succeeds inside the root');
  disarmScratchRestore(target);
  // Disarm validates the path, not the armed state: a never-armed in-root path
  // disarms as a no-op, while any outside path is refused before the lookup.
  disarmScratchRestore(join(parent, 'never-armed'));
  assert.throws(() => disarmScratchPathOutside(), TypeError);
  function disarmScratchPathOutside() {
    disarmScratchRestore(join(homedir(), 'outside-scratch'));
  }
});

test('an armed restore re-applies its SDDL when the process exits mid-mutation', windows, async (t) => {
  // Why through a child: the restore is armed to a process exit handler, so the
  // only honest proof is a process that exits while a mutation is still open.
  const parent = createScratchSync('nna-scratch-guard-exit');
  t.after(async () => { await import('node:fs/promises').then((fs) => fs.rm(parent, { recursive: true, force: true })); });
  const target = join(parent, 'mutated');
  await mkdir(target);
  const probe = join(SCRATCH_ROOT, 'nna-scratch-guard-probe.mjs');
  // The child replaces the DACL with an open one, arms the restore of the
  // original descriptor, and exits WITHOUT disarming — the handler must fire.
  // Descriptor text rides inside the script; the target path is interpolated.
  await writeFile(probe, `
    import { armScratchRestore } from ${JSON.stringify(new URL('./scratch.js', import.meta.url).href)};
    import { spawnSync } from 'node:child_process';
    import { join } from 'node:path';
    const target = ${JSON.stringify(target)};
    // The stdin/JSON pattern the suite's own helper uses: the script is fixed,
    // the variable parts ride as JSON, so no path or SDDL text can break the
    // PowerShell command line.
    const runPs = (script, request) => {
      const result = spawnSync(join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
          "$ErrorActionPreference='Stop'; [Console]::InputEncoding=[Text.UTF8Encoding]::new($false); " +
          "$request=[Console]::In.ReadToEnd() | ConvertFrom-Json; " + script],
        { input: JSON.stringify(request), encoding: 'utf8', windowsHide: true, timeout: 15_000 });
      if (result.status !== 0) throw new Error(result.stderr);
      return result.stdout.trim();
    };
    const setSddl = (descriptor) => runPs(
      "$info=[IO.DirectoryInfo]::new($request.path); " +
      "$acl=$info.GetAccessControl(); " +
      "$acl.SetSecurityDescriptorSddlForm($request.descriptor, [Security.AccessControl.AccessControlSections]::Access); " +
      "$info.SetAccessControl($acl)", { path: target, descriptor });
    const readSddl = () => runPs(
      "([IO.DirectoryInfo]::new($request.path)).GetAccessControl()" +
      ".GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)",
      { path: target }).trim();
    const saved = readSddl();
    setSddl('D:P(A;OICI;FA;;;WD)');
    armScratchRestore(target, () => setSddl(saved));
    console.log('armed ' + saved);
  `, 'utf8');
  const child = spawnSync(process.execPath, [probe], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const saved = child.stdout.trim().replace(/^armed /u, '');
  assert.ok(saved.length >= 8 && saved.startsWith('D:'), 'the child captured the original descriptor');
  // The child exited without disarming; its exit handler must have restored
  // the saved descriptor. Verify through a fresh read of the live descriptor,
  // using the stdin/JSON pattern because extra argv after -Command is
  // concatenated into the script text by Windows PowerShell, not bound to
  // `$args`.
  const verify = spawnSync(join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      "[Console]::InputEncoding=[Text.UTF8Encoding]::new($false); " +
      "$request=[Console]::In.ReadToEnd() | ConvertFrom-Json; " +
      "([IO.DirectoryInfo]::new($request.path)).GetAccessControl()" +
      ".GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)"],
    { input: JSON.stringify({ path: target }), encoding: 'utf8', windowsHide: true });
  assert.equal(verify.status, 0, verify.stderr);
  // Why not a strict string compare: re-applying a saved SDDL round-trips the
  // auto-inherit flag into the canonical form (`AI(`), so the comparison is on
  // the ACE bodies, which is what "restored" means here.
  const normalize = (sddl) => sddl.replaceAll('AI(', '(');
  assert.equal(normalize(verify.stdout.trim()), normalize(saved),
    'the armed restore re-applied the saved descriptor at exit');
  await rm(probe, { force: true });
});

async function rm(path, options) {
  await import('node:fs/promises').then((fs) => fs.rm(path, options));
}
