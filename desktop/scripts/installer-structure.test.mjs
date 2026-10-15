// SPDX-License-Identifier: Apache-2.0
/** Structural pins for both installers: the dumb-copy order, the lifecycle
 *  ownership boundary (only a previously running service restarts), and the
 *  NNA-branded shortcuts. Content assertions only; no process spawning. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

test('installer.ps1 follows the dumb-copy shape: plan, copy, build, register, shortcuts', async () => {
  const source = await readFile(resolve('install.ps1'), 'utf8');
  const initial = source.indexOf('function Resolve-NndInstallPlan');
  const resolved = source.indexOf('$installPlan = Resolve-NndInstallPlan $nna $targetPath');
  const copy = source.indexOf('Write-Heading "Copying source"');
  const register = source.indexOf("Write-Heading 'Registering NND package with NNA'");
  const shortcuts = source.indexOf('Write-Heading "Creating shortcuts"');
  const success = source.indexOf('Write-Heading "NotNativeDesktop installed"');
  assert.ok(initial > 0 && initial < resolved && resolved < copy && copy < register
    && register < shortcuts && shortcuts < success);
  // The install path owns no native guard. Fresh installs and upgrades of a
  // stopped service leave it stopped; only a running upgrade restores it.
  assert.ok(!source.includes('$installationGuard = Start-NndInstallationGuard $nna'));
  assert.ok(!source.includes('Invoke-NndInstallVerification'));
  assert.ok(!source.includes('Invoke-NndFreshVerification'));
  assert.ok(source.indexOf('Request-NndServiceStopForUninstall $SelectedNna (Join-Path $Source') > 0);
  // Transactional upgrade: the previous package stays registered through
  // copy/build; deactivation happens immediately before activation so a
  // copy/build failure leaves the prior registration intact (guide 02 L5).
  const copyAt = source.indexOf('Write-Heading "Copying source"');
  const deactivateAt = source.indexOf("Invoke-NndRegistration 'deactivate' $installPlan.PreviousRoot $nna");
  const registerAt = source.indexOf('Write-Heading \'Registering NND package with NNA\'');
  assert.ok(copyAt > 0 && deactivateAt > copyAt && deactivateAt > registerAt
    && deactivateAt < source.indexOf('Invoke-NndRegistration \'activate\''));
  assert.ok(source.includes('function Write-NndTransactionRecord'));
  assert.ok(source.includes('WasRunning = $wasRunning'));
  assert.ok(source.indexOf('Restore-NndRunningService $installPlan $nna') > shortcuts);
  assert.ok(source.indexOf('Restore-NndRunningService $installPlan $nna') < success);
  assert.ok(source.includes('install-transaction.json'));
  assert.ok(source.includes('"/IS", "/IT"'));
  assert.ok(source.includes('"build-stamp.json"'));
  assert.ok(source.includes('staleWorkspaceLink'));
  assert.ok(source.includes('The registered NND package root differs from this install target'));
  for (const file of ['serve-installed.mjs', 'serve-supervised.mjs', 'nnd-tray-host.ps1']) {
    assert.ok(source.includes(file), 'installed lifecycle copy must verify ' + file);
  }
  assert.ok(source.indexOf('Desktop source copy is incomplete') > copyAt);
  assert.ok(source.indexOf('Desktop source copy is incomplete') < registerAt);
  assert.ok(source.includes('the previous package registration is intact'));
  // Legacy takeover: a live Electron-owned backend from the install tree is
  // refused with recovery instructions before any mutation; nothing is killed.
  const takeover = source.indexOf('A legacy Electron-owned NotNativeDesktop backend is still running');
  assert.ok(takeover > 0 && takeover < copyAt);
  assert.ok(source.includes('It owns the session/queue/schedule catalogs the new service must take over'));
  assert.ok(source.includes('The installer killed nothing and changed no files'));
  // The shortcut launcher starts the service AND launches the attached GUI.
  const launcher = await readFile(resolve('scripts/launch-selected-desktop.ps1'), 'utf8');
  assert.ok(launcher.includes('desktop start'));
  assert.ok(!launcher.match(/& \$descriptor\.node \$cliPath nnd start/u));
  assert.ok(launcher.includes('launch-selected-desktop.mjs'));
  const startAt = launcher.indexOf('desktop start');
  const guiAt = launcher.indexOf('launch-selected-desktop.mjs');
  assert.ok(startAt > 0 && startAt < guiAt);
  // Lifecycle ownership: the tray is coupled to the SERVICE (the supervised
  // child spawns the lightweight tray host after readiness; its Quit stops the
  // service), and the service NEVER launches the desktop client. The client is
  // a plain window whose close only quits the client.
  const serve = await readFile(resolve('scripts/serve-installed.mjs'), 'utf8');
  assert.ok(serve.includes("args[0] !== '--supervised'"));
  assert.ok(!serve.includes('--port'));
  const supervised = await readFile(resolve('scripts/serve-supervised.mjs'), 'utf8');
  const supervisedReady = supervised.indexOf("type: 'ready'");
  const supervisedTray = supervised.indexOf('nnd-tray-host.ps1');
  assert.ok(supervisedReady > 0 && supervisedReady < supervisedTray);
  assert.ok(!supervised.includes('detached: true'), 'Windows PowerShell tray must execute in the service process group');
  assert.ok(!supervised.includes('launchSelectedDesktop'));
  const main = await readFile(resolve('packages/electron/main.mjs'), 'utf8');
  assert.ok(!main.includes('createTrayController'));
  assert.ok(!main.includes('requestNativeServiceStop'));
  // Shortcuts carry NNA branding.
  assert.ok(source.includes('"NotNativeAgent.lnk"'));
  assert.ok(!source.includes('"NotNativeDesktop.lnk"'));
  assert.ok(source.includes('notnative-agent.ico'));
  // Upgrades remove the pre-rename shortcut.
  assert.ok(source.includes('Remove-Item -LiteralPath $staleShortcut -Force'));
});

test('install.sh mirrors the dumb-copy shape with NNA branding and the lifecycle surface', async () => {
  const source = await readFile(resolve('install.sh'), 'utf8');
  const copy = source.indexOf('== copying source ==');
  const build = source.indexOf('== building shell artifacts ==');
  const register = source.indexOf('== registering NND package with NNA ==');
  const entry = source.indexOf('== desktop entry ==');
  const done = source.indexOf('== done ==');
  assert.ok(copy > 0 && copy < build && build < register && register < entry && entry < done);
  // No installer-side service start or verification ceremony on POSIX either.
  assert.ok(!source.includes('service start'));
  assert.ok(!source.includes('verify'));
  // An upgrade stops a running service before replacing files (parity with
  // the Windows plan resolver); the stop is best-effort.
  const stop = source.indexOf('nnd service stop "$NNA_ROOT"');
  assert.ok(stop > 0 && stop < copy);
  // Transaction-record parity: stage evidence is written for a registered
  // upgrade and removed after activation.
  assert.ok(source.includes('install-transaction.json'));
  assert.ok(source.indexOf('txn_stage prepared') > 0 && source.indexOf('txn_stage prepared') < copy);
  assert.ok(source.indexOf('txn_stage deactivated') > copy
    && source.indexOf('txn_stage deactivated') < source.indexOf('nnd package activate'));
  // The desktop entry is NNA-branded and resolves the lifecycle at launch.
  assert.ok(source.includes('notnativeagent.desktop'));
  assert.ok(!source.includes('notnativedesktop.desktop'));
  assert.ok(source.includes('Name=NotNativeAgent'));
  assert.ok(source.includes('notnative-agent-32.png'));
  assert.ok(source.includes('nna desktop start'));
});
