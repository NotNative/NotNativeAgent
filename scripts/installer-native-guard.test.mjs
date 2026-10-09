// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSupervisedFixture, removeSupervisedFixture } from './supervised-smoke-fixture.mjs';
import { withTimeout } from './smoke-http.mjs';
import { waitForSelectedNndStop } from './installer-wait-stopped.mjs';

test('uninstall stop wait verifies the selected NNA identity and free service lock',
  { skip: process.platform !== 'win32' || !process.env.NND_TEST_NNA_SOURCE }, async t => {
    const fixture = await createSupervisedFixture(resolve(process.env.NND_TEST_NNA_SOURCE), resolve('.'));
    t.after(() => removeSupervisedFixture(fixture.root));
    const stopped = await waitForSelectedNndStop(fixture.install, fixture.data);
    assert.equal(stopped.stopped, true);
    await assert.rejects(waitForSelectedNndStop(fixture.install, fixture.root),
      /selected_service_identity_changed/u);
  });

test('PowerShell installer holds native ownership through mutation and explicitly releases it',
  { skip: process.platform !== 'win32' || !process.env.NND_TEST_NNA_SOURCE }, async (t) => {
    const native = resolve(process.env.NND_TEST_NNA_SOURCE);
    const fixture = await createSupervisedFixture(native, resolve('.'));
    let child, exit, confirmed = false;
    t.after(async () => {
      if (child && child.exitCode === null) {
        child.stdin.end('release\n');
        assert.equal((await withTimeout(exit, 25000, 'Installer guard cleanup timeout'))[0], 0);
        confirmed = true;
      }
      if (confirmed || !child) await removeSupervisedFixture(fixture.root);
    });
    const helper = resolve('scripts/installer-native-guard.ps1').replaceAll("'", "''");
    const script = `$ErrorActionPreference='Stop'; . '${helper}';
$selected=$env:NND_TEST_SELECTED|ConvertFrom-Json
$guard=Start-NndInstallationGuard $selected
try { [Console]::Out.WriteLine('READY'); if([Console]::In.ReadLine() -ne 'release'){throw 'Missing release'}; Assert-NndInstallationGuard $guard }
finally { Stop-NndInstallationGuard $guard }`;
    child = spawn(join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, NND_TEST_SELECTED: JSON.stringify({ Node: process.execPath, Cli: fixture.cli,
          InstallRoot: fixture.install, DataRoot: fixture.data }) } });
    exit = once(child, 'exit');
    let output = '', diagnostic = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { if (diagnostic.length < 4096) diagnostic += chunk; });
    const deadline = Date.now() + 25000;
    while (!output.includes('READY') && Date.now() < deadline && child.exitCode === null) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.ok(output.includes('READY'), `Guard readiness failed: ${diagnostic}`);
    const { acquireNndServiceLock } = await import(pathToFileURL(join(native, 'src/nnd-service-lock.js')).href);
    await assert.rejects(acquireNndServiceLock({ dataRoot: fixture.data }), { code: 'nnd_service_already_running' });
    child.stdin.end('release\n');
    assert.equal((await withTimeout(exit, 25000, 'Installer did not release native guard'))[0], 0, diagnostic);
    confirmed = true;
    const lease = await acquireNndServiceLock({ dataRoot: fixture.data }); await lease.close();
  });
