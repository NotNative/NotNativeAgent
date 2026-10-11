// SPDX-License-Identifier: Apache-2.0
/** Structural pins for both installers: the dumb-copy order, the lifecycle
 *  ownership boundary (the installer never starts the service), and the
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
  // The install path owns no native guard and never starts the service; the
  // desktop shortcut and `nna desktop start` own the lifecycle.
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
  assert.ok(source.includes('install-transaction.json'));
  assert.ok(source.includes('the previous package registration is intact'));
  // The shortcut launcher starts the service AND launches the attached GUI.
  const launcher = await readFile(resolve('scripts/launch-selected-desktop.ps1'), 'utf8');
  assert.ok(launcher.includes('desktop start'));
  assert.ok(!launcher.match(/& \$descriptor\.node \$cliPath nnd start/u));
  assert.ok(launcher.includes('launch-selected-desktop.mjs'));
  const startAt = launcher.indexOf('desktop start');
  const guiAt = launcher.indexOf('launch-selected-desktop.mjs');
  assert.ok(startAt > 0 && startAt < guiAt);
  // The tray is permanently linked to the service: the supervised service
  // child spawns the desktop app after readiness, and the tray Quit requests
  // a service stop instead of only closing the GUI.
  const serve = await readFile(resolve('scripts/serve-installed.mjs'), 'utf8');
  const ready = serve.indexOf("'ready'");
  const childGui = serve.indexOf('launchSelectedDesktop(configured.root)');
  assert.ok(ready > 0 && ready < childGui);
  const supervised = await readFile(resolve('scripts/serve-supervised.mjs'), 'utf8');
  const supervisedReady = supervised.indexOf("type: 'ready'");
  const supervisedGui = supervised.indexOf('launchSelectedDesktop(root)');
  assert.ok(supervisedReady > 0 && supervisedReady < supervisedGui);
  const main = await readFile(resolve('packages/electron/main.mjs'), 'utf8');
  const quit = main.indexOf('function quitFromTray');
  const stopCall = main.indexOf('requestNativeServiceStop(nativeSelection)');
  assert.ok(quit > 0 && quit < stopCall);
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
