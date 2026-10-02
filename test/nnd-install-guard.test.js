// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { acquireNndServiceLock } from '../src/nnd-service-lock.js';
import { assertNoNndInstallMarker } from '../src/nnd-install-marker.js';
import { startNndSupervisor } from '../src/nnd-service-supervisor.js';

function fixture(t) {
  const root = join(homedir(), `.nna-install-guard-${randomUUID()}`);
  const result = spawnSync(join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop'; $p=[Console]::In.ReadToEnd();
    $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $acl=[Security.AccessControl.DirectorySecurity]::new();
    $acl.SetSecurityDescriptorSddlForm('O:'+$sid+'D:P(A;OICI;FA;;;'+$sid+')(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)');
    [void][IO.Directory]::CreateDirectory($p,$acl)`], { input: root, encoding: 'utf8', windowsHide: true, timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  t.after(() => rm(root, { recursive: true, force: true })); return root;
}

test('installer child releases only after matching release frame and private stdin EOF', { skip: process.platform !== 'win32', timeout: 10000 }, async (t) => {
  const root = fixture(t);
  const module = new URL('../src/nnd-install-guard.js', import.meta.url).href;
  const script = `import {runNndInstallGuard} from ${JSON.stringify(module)}; await runNndInstallGuard({data_root:process.argv[1],installation_id:'selected',data_id:'data'});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, root], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.resume();
  const exited = once(child, 'exit');
  try {
    const [bytes] = await once(child.stdout, 'data');
    assert.deepEqual(JSON.parse(bytes.toString()), { type: 'install_guard', protocol: '1.0', installation_id: 'selected', data_id: 'data' });
    await assert.rejects(acquireNndServiceLock({ dataRoot: root }), { code: 'nnd_service_already_running' });
    child.stdin.end(`${JSON.stringify({ type: 'release', installation_id: 'selected', data_id: 'data' })}\n`);
    assert.equal((await exited)[0], 0);
    await assertNoNndInstallMarker({ data_root: root });
    const lease = await acquireNndServiceLock({ dataRoot: root }); await lease.close();
  } finally { if (child.exitCode === null) { child.kill(); await exited; } }
});

test('installer parent loss retains singleton until explicit operator recovery', { skip: process.platform !== 'win32', timeout: 10000 }, async (t) => {
  const root = fixture(t);
  const module = new URL('../src/nnd-install-guard.js', import.meta.url).href;
  const script = `import {runNndInstallGuard} from ${JSON.stringify(module)}; await runNndInstallGuard({data_root:process.argv[1],installation_id:'selected',data_id:'data'});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, root], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  try {
    await once(child.stdout, 'data');
    child.stdout.destroy(); child.stderr.destroy();
    child.stdin.end(); await delay(100);
    assert.equal(child.exitCode, null);
    await assert.rejects(acquireNndServiceLock({ dataRoot: root }), { code: 'nnd_service_already_running' });
    child.kill(); await exited;
    await assert.rejects(assertNoNndInstallMarker({ data_root: root }), { code: 'nnd_install_guard_orphaned' });
    const identityLease = await acquireNndServiceLock({ dataRoot: root });
    const dataId = identityLease.dataId; await identityLease.close();
    await assert.rejects(startNndSupervisor({ data_root: root, installation_id: 'selected', data_id: dataId }, {}),
      { code: 'nnd_install_guard_orphaned' });
    const lease = await acquireNndServiceLock({ dataRoot: root }); await lease.close();
  } finally { if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited; } }
});
