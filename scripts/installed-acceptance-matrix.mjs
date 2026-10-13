// SPDX-License-Identifier: Apache-2.0
/**
 * Installed acceptance-matrix runner (velocity program 2026-10-12): one
 * disposable install serves multiple independent evidence legs, so each leg
 * no longer pays the install+setup prefix. Legs run in dependency order and
 * each result is recorded individually; a failing leg stops the chain but
 * preserves the fixture for diagnosis. Reuses the installed acceptance
 * scaffold and the shared in-page probe library.
 */
import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startAttachmentProvider, setupBrowserProbe } from './installed-attachment-probe.mjs';
import { acceptanceEvidence, checkedFixturePath, cli, prepare, privateDirectory,
  run, selectedPackage, shell, waitStopped } from './installed-source-acceptance.mjs';
import { afterRestartProbe, browserFirstProbe, desktopObserveProbe, multirunProfileProbe,
  serviceStopProbe, timelineForkRevertProbe, timelineMultirunProbe } from './installed-probe-library.mjs';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const powershell = join(process.env.SystemRoot ?? '', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

function quote(path) {
  return '"' + path + '"';
}

async function installFixture(fixture, label) {
  return run(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    join(source, 'install.ps1'), '-InstallDir', fixture.nnd, '-NnaInstallRoot', fixture.nna,
    '-ShortcutRoot', fixture.shortcuts], { cwd: fixture.root, env: fixture.env, timeout: 900000,
    outputFiles: { stdout: join(fixture.root, label + '-stdout.log'),
      stderr: join(fixture.root, label + '-stderr.log') } });
}

/** Run one leg; record {leg,pass,detail} and rethrow to stop the chain. */
async function leg(records, name, body) {
  try {
    const detail = await body();
    records.push({ leg: name, pass: true, detail: detail ?? null });
    process.stdout.write('[leg ok] ' + name + '\n');
  } catch (error) {
    records.push({ leg: name, pass: false, detail: String(error && error.message ? error.message : error) });
    process.stdout.write('[leg FAIL] ' + name + ': '
      + String(error && error.message ? error.message : error) + '\n');
    throw error;
  }
}

/** Setup through the V2 restart legs (one service-lifetime cycle). */
async function runCoreLegs(fixture, provider, records, status) {
  let first = null;
  await leg(records, 'setup', async () => {
    const setupTicket = (await cli(fixture, 'ui-ticket')).ticket;
    const setupResult = await shell(fixture, 'browser', status.endpoint, setupTicket, [],
      setupBrowserProbe(fixture.root, provider.port));
    assert.equal(setupResult.setup_after, 'ready', 'native setup did not reach ready');
    assert.equal(setupResult.same_tab_turn?.status, 'completed', 'first GUI turn did not complete');
    return { setup_after: setupResult.setup_after };
  });
  await leg(records, 'v2-browser-first', async () => {
    first = await shell(fixture, 'browser', status.endpoint, (await cli(fixture, 'ui-ticket')).ticket, [],
      browserFirstProbe());
    assert.ok(first.messages >= 2, 'browser-first turn did not complete');
    return { session: first.session, messages: first.messages };
  });
  await leg(records, 'v2-desktop-observe', async () => {
    const desktop = await shell(fixture, 'desktop', status.endpoint, null, [], desktopObserveProbe());
    assert.equal(desktop.sawSession, true, 'desktop did not observe the browser session');
    return { pill: desktop.pill };
  });
  await leg(records, 'v2-stop-under-tab', async () => {
    const stoppedTicket = (await cli(fixture, 'ui-ticket')).ticket;
    const stopCommand = 'Start-Sleep -Seconds 25; & ' + quote(process.execPath) + ' '
      + quote(fixture.cli) + ' nnd service stop ' + quote(fixture.nna);
    const delayedStop = run(powershell, ['-NoProfile', '-NonInteractive', '-Command', stopCommand],
      { cwd: fixture.root, env: fixture.env, timeout: 180000 });
    const stopped = await shell(fixture, 'browser', status.endpoint, stoppedTicket, [], serviceStopProbe());
    await delayedStop;
    await waitStopped(fixture);
    assert.notEqual(stopped.outcome.status, 200, 'stopped service served the browser');
    assert.equal(stopped.stillRendered, true, 'browser tab did not survive the service stop');
    return { outcome: stopped.outcome.status };
  });
  await leg(records, 'v2-restart-restore', async () => {
    await cli(fixture, 'start');
    const restarted = await cli(fixture, 'status');
    assert.equal(restarted.service_state, 'ready', 'restart did not reach ready');
    assert.notEqual(restarted.instance_id, status.instance_id, 'restart reused the instance id');
    const after = await shell(fixture, 'browser', restarted.endpoint, (await cli(fixture, 'ui-ticket')).ticket, [],
      afterRestartProbe(first.session));
    assert.equal(after.messages, 2, 'restart changed the browser session history');
    return { instance: restarted.instance_id, messages: after.messages };
  });
  return { session: first.session };
}

/** Timeline fork/revert through the multi-run legs (second restart cycle). */
async function runTimelineLegs(fixture, provider, records) {
  await leg(records, 'timeline-fork-revert', async () => {
    const result = await shell(fixture, 'browser', (await cli(fixture, 'status')).endpoint,
      (await cli(fixture, 'ui-ticket')).ticket, [], timelineForkRevertProbe());
    assert.equal(typeof result.parent, 'string', 'timeline leg lacked the parent session id');
    assert.equal(result.inherited, 4, 'child did not render the inherited history');
    assert.ok(result.restored >= 6, 'unrevert did not restore the hidden history');
    return { parent: result.parent, child: result.child };
  });
  await leg(records, 'multirun-profile', async () => {
    const profile = await shell(fixture, 'browser', (await cli(fixture, 'status')).endpoint,
      (await cli(fixture, 'ui-ticket')).ticket, [],
      multirunProfileProbe('http://127.0.0.1:' + provider.port + '/v1'));
    assert.equal(profile.created, 'secondary', 'provider profile did not persist');
    return { created: profile.created };
  });
  await leg(records, 'service-restart-for-multirun', async () => {
    await cli(fixture, 'stop');
    await waitStopped(fixture);
    await cli(fixture, 'start');
    const restarted = await cli(fixture, 'status');
    assert.equal(restarted.service_state, 'ready', 'restart after profile create did not reach ready');
    return { instance: restarted.instance_id };
  });
  await leg(records, 'multirun-sessions', async () => {
    const restarted = await cli(fixture, 'status');
    const multirun = await shell(fixture, 'browser', restarted.endpoint, (await cli(fixture, 'ui-ticket')).ticket, [],
      timelineMultirunProbe());
    assert.equal(typeof multirun.sessionA, 'string', 'multi-run leg lacked session A');
    assert.deepEqual(multirun.configuredB, { providerID: 'secondary', modelID: 'test-alt' },
      'installed session B did not hold its per-session route');
    return { sessionA: multirun.sessionA, sessionB: multirun.sessionB };
  });
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
  const records = [];
  let serviceStopped = false;
  let passed = false;
  try {
    await installFixture(fixture, 'installer');
    const packageRoot = await realpath(fixture.nnd);
    const packageVersion = (await readFile(join(packageRoot, 'VERSION'), 'utf8')).trim();
    const registered = await selectedPackage(fixture);
    assert.equal(registered.registered, true, 'The installed NND package must be selected in NNA');
    assert.equal(registered.valid, true, 'The selected NND package must validate');
    assert.equal(registered.version, packageVersion, 'NNA selected a different NND package version');
    await cli(fixture, 'start');
    const status = await cli(fixture, 'status');
    assert.equal(status.service_state, 'setup_required', 'fresh install must require setup');
    try {
      await runCoreLegs(fixture, provider, records, status);
      await runTimelineLegs(fixture, provider, records);
      passed = records.every((record) => record.pass);
    } catch { /* chain stopped; records carry the failing leg */ }
    await cli(fixture, 'stop');
    await waitStopped(fixture);
    serviceStopped = true;
    process.stdout.write('acceptance matrix (' + packageVersion + '): '
      + JSON.stringify(records) + '\n');
  } finally {
    if (!serviceStopped) {
      try { await cli(fixture, 'stop'); await waitStopped(fixture); serviceStopped = true; }
      catch { process.stderr.write('Native state uncertain; preserved fixture at ' + root + '\n'); }
    }
    const closed = new Promise((resolveClose) => provider.server.close(resolveClose));
    provider.server.closeAllConnections();
    await closed;
    if (passed && serviceStopped && !acceptanceEvidence().uncertain) {
      try { await rm(await checkedFixturePath(root, base), { recursive: true, force: true, maxRetries: 5 }); }
      catch (cleanupError) {
        process.stderr.write('Matrix passed; fixture cleanup deferred ('
          + (cleanupError?.code ?? cleanupError) + '): ' + root + '\n');
      }
    } else process.stderr.write('Matrix evidence preserved at ' + root + '\n');
  }
  if (!passed) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error('usage: installed-acceptance-matrix.mjs ABSOLUTE_NNA_SOURCE');
  await main(resolve(process.argv[2]));
}
