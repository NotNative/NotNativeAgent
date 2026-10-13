// SPDX-License-Identifier: Apache-2.0
/**
 * V2 lifetime journey (guide 05:39-59): browser-first turn before Electron
 * ever opens, hidden desktop attach observes the same session, explicit
 * service stop leaves the browser tab alive but offline (interface detach is
 * distinct from service stop), and restart restores the same session without
 * duplicate work. Reuses the installed acceptance scaffold end to end.
 */
import assert from 'node:assert/strict';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startAttachmentProvider } from './installed-attachment-probe.mjs';
import { setupBrowserProbe } from './installed-setup-probe.mjs';
import { acceptanceEvidence, checkedFixturePath, cli, prepare, privateDirectory,
  run, selectedPackage, shell, waitStopped } from './installed-source-acceptance.mjs';
import { afterRestartProbe, browserFirstProbe, desktopObserveProbe, serviceStopProbe } from './installed-probe-library.mjs';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const powershell = join(process.env.SystemRoot ?? '', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

async function installFixture(fixture, label) {
  return run(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    join(source, 'install.ps1'), '-InstallDir', fixture.nnd, '-NnaInstallRoot', fixture.nna,
    '-ShortcutRoot', fixture.shortcuts], { cwd: fixture.root, env: fixture.env, timeout: 900000,
    outputFiles: { stdout: join(fixture.root, label + '-stdout.log'),
      stderr: join(fixture.root, label + '-stderr.log') } });
}

function quote(path) {
  return '"' + path + '"';
}

async function runJourney(fixture, provider) {
  await cli(fixture, 'start');
  const status = await cli(fixture, 'status');
  assert.equal(status.service_state, 'setup_required', 'fresh install must require setup');
  const setupTicket = (await cli(fixture, 'ui-ticket')).ticket;
  const setupResult = await shell(fixture, 'browser', status.endpoint, setupTicket, [],
    setupBrowserProbe(fixture.root, provider.port));
  assert.equal(setupResult.setup_after, 'ready', 'native setup did not reach ready');
  // Leg 1: a real governed turn from the browser alone; Electron never opened.
  const first = await shell(fixture, 'browser', status.endpoint, (await cli(fixture, 'ui-ticket')).ticket, [],
    browserFirstProbe());
  assert.ok(first.messages >= 2, 'browser-first turn did not complete');
  // Leg 2: hidden desktop attach observes the same browser-created session.
  const desktop = await shell(fixture, 'desktop', status.endpoint, null, [], desktopObserveProbe());
  assert.equal(desktop.sawSession, true, 'desktop did not observe the browser session');
  // Leg 3: explicit service stop under a loaded tab. The tab loads first;
  // a delayed detached CLI stop fires while the probe waits, so the shell
  // never needs a live origin at load time to observe the offline state.
  const stoppedTicket = (await cli(fixture, 'ui-ticket')).ticket;
  const stopCommand = 'Start-Sleep -Seconds 25; & ' + quote(process.execPath) + ' '
    + quote(fixture.cli) + ' nnd service stop ' + quote(fixture.nna);
  const delayedStop = run(powershell, ['-NoProfile', '-NonInteractive', '-Command', stopCommand],
    { cwd: fixture.root, env: fixture.env, timeout: 180000 });
  const stopped = await shell(fixture, 'browser', status.endpoint, stoppedTicket, [],
    serviceStopProbe());
  await delayedStop;
  await waitStopped(fixture);
  assert.notEqual(stopped.outcome.status, 200, 'stopped service served the browser');
  assert.equal(stopped.stillRendered, true, 'browser tab did not survive the service stop');
  // Leg 4: restart; same session, same bounded history, no duplicate work.
  await cli(fixture, 'start');
  const restarted = await cli(fixture, 'status');
  assert.equal(restarted.service_state, 'ready', 'restart did not reach ready');
  assert.notEqual(restarted.instance_id, status.instance_id, 'restart reused the instance id');
  const after = await shell(fixture, 'browser', restarted.endpoint, (await cli(fixture, 'ui-ticket')).ticket, [],
    afterRestartProbe(first.session));
  assert.equal(after.messages, 2, 'restart changed the browser session history');
  return { session: first.session, desktopPill: desktop.pill };
}

async function main(nnaSource) {
  assert.equal(process.platform, 'win32', 'Windows acceptance only');
  assert.ok(isAbsolute(nnaSource), 'Provide an absolute NNA source root');
  const base = join(homedir(), 'nnd-installed-acceptance-fixtures');
  await mkdir(base, { recursive: true });
  const root = join(base, 'installed-accept-' + globalThis.crypto.randomUUID().replaceAll('-', '').slice(0, 16));
  await privateDirectory(root, base);
  const fixture = await prepare(nnaSource, root);
  const provider = await startAttachmentProvider();
  let serviceStopped = false;
  let accepted = false;
  try {
    await installFixture(fixture, 'installer');
    const packageRoot = await (await import('node:fs/promises')).realpath(fixture.nnd);
    const packageVersion = (await readFile(join(packageRoot, 'VERSION'), 'utf8')).trim();
    const registered = await selectedPackage(fixture);
    assert.equal(registered.registered, true, 'The installed NND package must be selected in NNA');
    assert.equal(registered.valid, true, 'The selected NND package must validate');
    assert.equal(registered.version, packageVersion, 'NNA selected a different NND package version');
    await runJourney(fixture, provider);
    await cli(fixture, 'stop');
    await waitStopped(fixture);
    serviceStopped = true;
    accepted = true;
    process.stdout.write('V2 lifetime journey passed: real governed turn from the browser alone, hidden desktop '
      + 'attach observed the same session, explicit service stop left the browser tab rendered but offline, '
      + 'restart restored the same session with unchanged history under a fresh instance id.\n');
  } finally {
    if (!serviceStopped) {
      try { await cli(fixture, 'stop'); await waitStopped(fixture); serviceStopped = true; }
      catch { process.stderr.write('Native state uncertain; preserved fixture at ' + root + '\n'); }
    }
    const closed = new Promise((resolve) => provider.server.close(resolve));
    provider.server.closeAllConnections();
    await closed;
    if (accepted && serviceStopped && !acceptanceEvidence().uncertain) {
      try { await rm(await checkedFixturePath(root, base), { recursive: true, force: true, maxRetries: 5 }); }
      catch (cleanupError) {
        process.stderr.write('Journey passed; fixture cleanup deferred ('
          + (cleanupError?.code ?? cleanupError) + '): ' + root + '\n');
      }
    } else process.stderr.write('Journey evidence preserved at ' + root + '\n');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error('usage: installed-v2-lifetime-journey.mjs ABSOLUTE_NNA_SOURCE');
  await main(resolve(process.argv[2]));
}
