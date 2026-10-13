// SPDX-License-Identifier: Apache-2.0
/**
 * Installed timeline journey (deferred-verification installed legs): fork a
 * session from the NND timeline against the disposable installed pair and
 * confirm the child renders the inherited history and continues
 * independently, then revert/unrevert across the installed shell (NNA
 * `POST /session/:id/fork`, `/revert`, `/unrevert`). Reuses the installed
 * acceptance scaffold: real source install, native code Chromium UI, real
 * settings-UI provider configuration with a first turn, then the in-page
 * timeline probe. Fixture lands in the acceptance base and self-cleans.
 */
import assert from 'node:assert/strict';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSelectedNativeRuntime } from '../packages/electron/native-service-client.mjs';
import { startAttachmentProvider } from './installed-attachment-probe.mjs';
import { setupBrowserProbe } from './installed-setup-probe.mjs';
import { acceptanceEvidence, checkedFixturePath, cli, prepare, privateDirectory,
  run, selectedPackage, shell, waitStopped } from './installed-source-acceptance.mjs';
import { multirunProfileProbe, timelineForkRevertProbe, timelineMultirunProbe } from './installed-probe-library.mjs';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const powershell = join(process.env.SystemRoot ?? '', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

async function installFixture(fixture, label) {
  return run(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    join(source, 'install.ps1'), '-InstallDir', fixture.nnd, '-NnaInstallRoot', fixture.nna,
    '-ShortcutRoot', fixture.shortcuts], { cwd: fixture.root, env: fixture.env, timeout: 900000,
    outputFiles: { stdout: join(fixture.root, label + '-stdout.log'),
      stderr: join(fixture.root, label + '-stderr.log') } });
}

async function runJourney(fixture, packageVersion, provider) {
  const selected = readSelectedNativeRuntime(fixture.nna);
  assert.equal(selected.root.toLowerCase(), (await realpathSafe(fixture.nna)).toLowerCase());
  assert.equal(selected.dataRoot.toLowerCase(), (await realpathSafe(fixture.data)).toLowerCase());
  const registered = await selectedPackage(fixture);
  assert.equal(registered.registered, true, 'The installed NND package must be selected in NNA');
  assert.equal(registered.valid, true, 'The selected NND package must validate');
  assert.equal(registered.version, packageVersion, 'NNA selected a different NND package version');
  await cli(fixture, 'start');
  const status = await cli(fixture, 'status');
  assert.equal(status.service_state, 'setup_required', 'fresh install must require setup');
  const setupTicket = (await cli(fixture, 'ui-ticket')).ticket;
  const setupResult = await shell(fixture, 'browser', status.endpoint, setupTicket, [],
    setupBrowserProbe(fixture.root, provider.port));
  assert.equal(setupResult.setup_after, 'ready', 'native setup did not reach ready');
  assert.equal(setupResult.same_tab_turn?.status, 'completed', 'first GUI turn did not complete');
  const timelineTicket = (await cli(fixture, 'ui-ticket')).ticket;
  const result = await shell(fixture, 'browser', status.endpoint, timelineTicket, [],
    timelineForkRevertProbe());
  assert.equal(typeof result.parent, 'string', 'timeline journey lacked the parent session id');
  assert.equal(result.inherited, 4, 'child did not render the inherited history');
  assert.ok(result.restored >= 6, 'unrevert did not restore the hidden history');
  assert.ok(result.rows >= 2, 'forked child did not render as a session row');
  const profile = await shell(fixture, 'browser', status.endpoint, (await cli(fixture, 'ui-ticket')).ticket, [],
    multirunProfileProbe('http://127.0.0.1:' + provider.port + '/v1'));
  assert.equal(profile.created, 'secondary', 'provider profile did not persist through the installed surface');
  await cli(fixture, 'stop');
  await waitStopped(fixture);
  await cli(fixture, 'start');
  const restarted = await cli(fixture, 'status');
  assert.equal(restarted.service_state, 'ready', 'restart after profile create did not reach ready');
  const multirun = await shell(fixture, 'browser', restarted.endpoint, (await cli(fixture, 'ui-ticket')).ticket, [],
    timelineMultirunProbe());
  assert.equal(typeof multirun.sessionA, 'string', 'multi-run journey lacked session A');
  assert.deepEqual(multirun.configuredB, { providerID: 'secondary', modelID: 'test-alt' },
    'installed session B did not hold its per-session route');
  const wiredModels = provider.requests.map((request) => request.model);
  assert.deepEqual(wiredModels.slice(-2), ['test', 'test-alt'],
    'the two installed same-prompt runs did not ride their per-session routes on the wire');
}

async function main(nnaSource) {
  assert.equal(process.platform, 'win32', 'Windows acceptance only');
  assert.ok(isAbsolute(nnaSource), 'Provide an absolute NNA source root');
  const base = join(homedir(), 'nnd-installed-acceptance-fixtures');
  await mkdir(base, { recursive: true });
  const root = join(base, 'installed-accept-' + cryptoId());
  await privateDirectory(root, base);
  const fixture = await prepare(nnaSource, root);
  const provider = await startAttachmentProvider();
  let serviceStopped = false;
  let accepted = false;
  try {
    await installFixture(fixture, 'installer');
    const packageRoot = await realpathSafe(fixture.nnd);
    const packageVersion = (await readFile(join(packageRoot, 'VERSION'), 'utf8')).trim();
    await runJourney(fixture, packageVersion, provider);
    await cli(fixture, 'stop');
    await waitStopped(fixture);
    serviceStopped = true;
    accepted = true;
    process.stdout.write('Installed timeline journey passed: real source install, settings-UI setup with first turn, '
      + 'fork renders inherited history and continues independently, revert hides and unrevert restores '
      + 'across the installed shell, parent immovable, child rendered as its own session row, and the F9 '
      + 'same-prompt runs rode their per-session routes (primary/test vs secondary/test-alt) on the wire '
      + 'with the mismatched per-prompt override refused.\n');
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

function cryptoId() {
  return globalThis.crypto.randomUUID().replaceAll('-', '').slice(0, 16);
}

async function realpathSafe(path) {
  const { realpath } = await import('node:fs/promises');
  return realpath(path);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error('usage: installed-timeline-journey.mjs ABSOLUTE_NNA_SOURCE');
  await main(resolve(process.argv[2]));
}
