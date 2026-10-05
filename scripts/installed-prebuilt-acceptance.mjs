// SPDX-License-Identifier: Apache-2.0
/** Real exported NND payload consumed by disposable installed NNA. */
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { cp, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  checkedFixturePath, cli, prepare, privateDirectory, run, selectedPackage,
  shell, waitStopped, acceptanceEvidence,
} from './installed-source-acceptance.mjs';
import { exportPrebuiltPayload, writePayloadManifest } from './export-prebuilt-payload.mjs';

const source = join(dirname(fileURLToPath(import.meta.url)), '..');
// The immutable slot name includes the payload digest, so use a trusted home
// ancestor while keeping the disposable slot below the 259-character limit.
const fixtureBase = process.env.NND_ACCEPTANCE_FIXTURE_ROOT ?? join(homedir(), '.n');

// Stage, then activate one prepared immutable slot; return its live roots.
async function stageAndActivate(fixture, root, exported, tag = '') {
  const manifest = await readFile(join(exported.root, 'NND_PAYLOAD.json'));
  const manifestSha256 = createHash('sha256').update(manifest).digest('hex').toLowerCase();
  const installer = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    join(source, 'install.ps1')];
  const common = ['-PrebuiltPayloadRoot', `${exported.root}`, '-PrebuiltManifestSha256', manifestSha256,
    '-InstallDir', fixture.nnd, '-NnaInstallRoot', fixture.nna, '-ShortcutRoot', fixture.shortcuts];
  const staged = await run('powershell.exe', [...installer, '-StagePrebuiltPayload', ...common], {
    cwd: root, env: fixture.env, timeout: 900000,
    outputFiles: { stdout: join(root, `${tag}staging-stdout.log`), stderr: join(root, `${tag}staging-stderr.log`) },
  });
  const stageMatch = staged.match(/^\s*operation    : ([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/m);
  assert.match(staged, /Prebuilt NND payload staged; activation remains pending/u);
  assert.equal(Boolean(stageMatch), true, 'Installer did not expose the immutable stage operation');
  const activation = await run('powershell.exe', [...installer, '-ActivatePrebuiltSlot',
    '-PrebuiltStageOperation', stageMatch[1], ...common], {
    cwd: root, env: fixture.env, timeout: 900000,
    outputFiles: { stdout: join(root, `${tag}activation-stdout.log`), stderr: join(root, `${tag}activation-stderr.log`) },
  });
  const slotMatch = activation.match(/^\s*slot         : (.+)$/m);
  assert.match(activation, /Prebuilt NND activated; public controller attached/u);
  assert.equal(Boolean(slotMatch), true, 'Installer did not expose the activated immutable slot');
  const packageRoot = await realpath(slotMatch[1]);
  assert.match(packageRoot, /[\\/]runtime[\\/]nnd[\\/]/iu, 'Activation must use an immutable NNA slot');
  assert.equal((await readFile(join(packageRoot, 'VERSION'), 'utf8')).trim(), exported.version);
  assert.deepEqual(await readFile(join(packageRoot, 'NND_PAYLOAD.json')), manifest);
  return { installer, common, packageRoot };
}

// Build a second export by cloning the first with a bumped version, so the
// upgrade path exercises a genuinely different payload and slot identity.
async function upgradeCopy(root, exported, tag = 'upgrade', bump = 1) {
  const nextVersion = `${exported.version.slice(0, 8)}-${bump + Number(exported.version.slice(9))}`;
  const next = { root: join(root, `NND payload ${tag}`), version: nextVersion };
  await cp(exported.root, next.root, { recursive: true, errorOnEbusy: false });
  await rm(join(next.root, 'NND_PAYLOAD.json'));
  await writeFile(join(next.root, 'VERSION'), `${nextVersion}\n`);
  const info = JSON.parse(await readFile(join(next.root, 'package.json'), 'utf8'));
  info.version = nextVersion.replace('-', '.0.');
  info.nnd_version = nextVersion;
  await writeFile(join(next.root, 'package.json'), `${JSON.stringify(info)}\n`);
  const manifestPath = join(next.root, 'nna-integration', 'nnd-local', 'integration.json');
  const integration = JSON.parse(await readFile(manifestPath, 'utf8'));
  integration.version = nextVersion;
  await writeFile(manifestPath, `${JSON.stringify(integration)}\n`);
  await writePayloadManifest(next.root, nextVersion);
  return next;
}

// Attach both Chromium shells to the live service; the desktop shell must
// discover the selection anchor exactly as the stable launcher does.
async function exerciseShells(fixture, root, status) {
  const ticket = (await cli(fixture, 'ui-ticket')).ticket;
  await shell(fixture, 'browser', status.endpoint, ticket);
  await shell(fixture, 'desktop', status.endpoint, null,
    ['--nna-install-root', fixture.nna, '--nnd-selection-file', join(root, 'NND', 'nna-service-selection.json')]);
  const after = await cli(fixture, 'status');
  assert.equal(after.instance_id, status.instance_id, 'Desktop exit must not stop or replace native service');
}

async function assertSelected(fixture, packageRoot, version) {
  const registered = await selectedPackage(fixture);
  assert.equal(registered.registered, true, 'The activated prebuilt payload must be selected in NNA');
  assert.equal(registered.valid, true, 'The activated prebuilt payload must validate');
  assert.equal(registered.version, version, 'NNA selected a different payload version');
  assert.equal((await realpath(registered.root)).toLowerCase(), packageRoot.toLowerCase(),
    'NNA selected a different NND package root');
  const status = await cli(fixture, 'status');
  assert.ok(['ready', 'setup_required'].includes(status.service_state), status.service_state);
  assert.equal(status.package_state, 'ready', status.package_state);
  assert.equal(status.package_version, version, 'NNA selected a different payload version');
  return status;
}

async function uninstall(fixture, root, anchor) {
  const uninstalled = await run('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(source, 'install.ps1'),
    '-Uninstall', '-NnaInstallRoot', fixture.nna, '-InstallDir', anchor, '-ShortcutRoot', fixture.shortcuts], {
    cwd: root, env: fixture.env, timeout: 120000,
    outputFiles: { stdout: join(root, 'uninstall-stdout.log'), stderr: join(root, 'uninstall-stderr.log') },
  });
  assert.match(uninstalled, /Uninstall complete/u);
  assert.equal('ENOENT', (await lstat(anchor).then(() => 'present', error => error.code)),
    'Default uninstall must remove only the launcher anchor');
  assert.equal((await selectedPackage(fixture)).registered, false, 'Default uninstall must deactivate NND');
  assert.doesNotThrow(async () => await lstat(join(fixture.data, 'runtime', 'nnd', 'install-slots')),
    'Default uninstall must preserve immutable slots and provenance');
}

// Upgrade journey: clone the export at a new version, re-stage/re-activate
// after a clean stop, and prove rotation, anchor rebind, and re-attach.
async function exerciseUpgrade(fixture, root, anchor, exported, operatorWorkFile, operatorWork) {
  const upgraded = await upgradeCopy(root, exported);
  // The installer always addresses the stable launcher anchor, not a slot.
  fixture.nnd = anchor;
  const up = await stageAndActivate(fixture, root, upgraded, 'upgrade-');
  const slotsRoot = join(fixture.data, 'runtime', 'nnd', 'install-slots');
  const consumed = await readdir(join(slotsRoot, 'consumed'));
  assert.equal(consumed.length, 1, 'exactly one consumed receipt pair must be archived');
  assert.match(await readFile(join(slotsRoot, 'activation-retirement-commit.json'), 'utf8'),
    /terminal_committed_barred/u, 'the upgrade must write its own terminal evidence');
  const binding = JSON.parse(await readFile(join(anchor, 'nnd-anchor.json'), 'utf8'));
  assert.equal(binding.version, upgraded.version, 'launcher anchor must rebind to the new slot');
  assert.equal(binding.nnd_package_root.toLowerCase(), up.packageRoot.toLowerCase());
  fixture.nnd = up.packageRoot;
  const upgradeStatus = await assertSelected(fixture, up.packageRoot, upgraded.version);
  await exerciseShells(fixture, root, upgradeStatus);
  await readFile(operatorWorkFile, 'utf8').then(value => assert.equal(value, operatorWork));
  return upgraded.version;
}

// Rollback journey: the retained prior payload re-stages and re-activates,
// returning the anchor, registration, and live service to the earlier slot.
async function exerciseRollback(fixture, root, anchor, exported, operatorWorkFile, operatorWork) {
  fixture.nnd = anchor;
  const back = await stageAndActivate(fixture, root, exported, 'rollback-');
  const slotsRoot = join(fixture.data, 'runtime', 'nnd', 'install-slots');
  const consumed = await readdir(join(slotsRoot, 'consumed'));
  assert.equal(consumed.length, 2, 'the upgrade receipt must rotate before rollback commits');
  assert.match(await readFile(join(slotsRoot, 'activation-retirement-commit.json'), 'utf8'),
    /terminal_committed_barred/u, 'rollback writes its own terminal evidence');
  const binding = JSON.parse(await readFile(join(anchor, 'nnd-anchor.json'), 'utf8'));
  assert.equal(binding.version, exported.version, 'launcher anchor must return to the prior slot');
  assert.equal(binding.nnd_package_root.toLowerCase(), back.packageRoot.toLowerCase());
  fixture.nnd = back.packageRoot;
  const status = await assertSelected(fixture, back.packageRoot, exported.version);
  await exerciseShells(fixture, root, status);
  await readFile(operatorWorkFile, 'utf8').then(value => assert.equal(value, operatorWork));
}

// Cancellation: kill native staging mid-copy (crash observer), recover the
// operation by id, then show the ordinary path still works: the recovered or
// fresh stage activates, and uninstall removes the fresh anchor. Recovery
// must end on exactly one side of the transaction, never half of both.
async function exerciseCancellation(fixture, root, anchor, exported) {
  fixture.nnd = anchor;
  const { spawn } = await import('node:child_process');
  // A never-seen payload guarantees the killed staging does real copying.
  const payload = await upgradeCopy(root, exported, 'cancel', 2);
  const installer = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    join(source, 'install.ps1')];
  const manifest = await readFile(join(payload.root, 'NND_PAYLOAD.json'));
  const manifestSha256 = createHash('sha256').update(manifest).digest('hex').toLowerCase();
  const common = ['-PrebuiltPayloadRoot', `${payload.root}`, '-PrebuiltManifestSha256', manifestSha256,
    '-InstallDir', fixture.nnd, '-NnaInstallRoot', fixture.nna, '-ShortcutRoot', fixture.shortcuts];
  const transactionsRoot = join(fixture.data, 'runtime', 'nnd', 'install-slots', 'transactions');
  const before = new Set(await readdir(transactionsRoot).catch(() => []));
  const child = spawn('powershell.exe', [...installer, '-StagePrebuiltPayload', ...common],
    { cwd: root, env: fixture.env, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] });
  let operation = null;
  for (let elapsed = 0; !operation && elapsed < 120000; elapsed += 50) {
    await new Promise(resolve => setTimeout(resolve, 50));
    const now = await readdir(transactionsRoot).catch(() => []);
    operation = now.find(entry => !before.has(entry)) ?? null;
    if (!child.connected && child.exitCode !== null && !operation) break;
  }
  assert.equal(Boolean(operation), true, 'killed staging left no discoverable transaction');
  // Crash the whole installer tree, native staging child included.
  await run('taskkill.exe', ['/T', '/F', '/PID', `${child.pid}`],
    { cwd: root, env: fixture.env, timeout: 30000 })
    .catch(() => child.kill());
  if (child.exitCode === null) await new Promise(resolve => child.once('exit', () => resolve()));
  const recovery = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    join(source, 'install.ps1'), '-RecoverPrebuiltStageOperation', operation,
    '-NnaInstallRoot', fixture.nna, '-InstallDir', fixture.nnd];
  const recovered = await run('powershell.exe', recovery, {
    cwd: root, env: fixture.env, timeout: 300000,
    outputFiles: { stdout: join(root, 'recover-stdout.log'), stderr: join(root, 'recover-stderr.log') },
  });
  assert.match(recovered, /Prebuilt NND staging recovery/u);
  assert.match(recovered, /state        : (slot_ready|unpublished)/u,
    'recovery must resolve to exactly one transaction side');
  const state = recovered.match(/state        : (\S+)/u)[1];
  assert.equal((await selectedPackage(fixture)).registered, false,
    'a cancelled or recovered-but-never-published stage must not register anything');
  if (state === 'slot_ready') {
    const activation = await run('powershell.exe', [...installer, '-ActivatePrebuiltSlot',
      '-PrebuiltStageOperation', operation, ...common], {
      cwd: root, env: fixture.env, timeout: 900000,
      outputFiles: { stdout: join(root, 'recovered-activation-stdout.log'),
        stderr: join(root, 'recovered-activation-stderr.log') },
    });
    assert.match(activation, /Prebuilt NND activated; public controller attached/u);
    fixture.nnd = await realpath(activation.match(/^\s*slot         : (.+)$/m)[1]);
  } else {
    const { packageRoot } = await stageAndActivate(fixture, root, payload, 'after-cancel-');
    fixture.nnd = packageRoot;
  }
  await cli(fixture, 'stop');
  await waitStopped(fixture);
}

// Reinstall: after uninstall removed the anchor, the same payload re-stages
// and activates against the retained data root with the surviving identity.
async function exerciseReinstall(fixture, root, anchor, exported, operatorWorkFile, operatorWork) {
  fixture.nnd = anchor;
  const again = await stageAndActivate(fixture, root, exported, 'reinstall-');
  fixture.nnd = again.packageRoot;
  await assertSelected(fixture, again.packageRoot, exported.version);
  await readFile(operatorWorkFile, 'utf8').then(value => assert.equal(value, operatorWork));
  await cli(fixture, 'stop');
  await waitStopped(fixture);
  fixture.nnd = anchor;
  await uninstall(fixture, root, anchor);
}

// Migration: a legacy Electron-era catalog (workspaceIds ['local']) carried
// in the data root is rewritten to native workspace identity by the
// installed CLI, journal bytes untouched, originals archived whole.
async function exerciseMigration(fixture, root) {
  const module = name => import(pathToFileURL(join(fixture.nna, 'installed/src', name)).href);
  const workspace = join(root, 'legacy-workspace');
  await mkdir(workspace, { recursive: true });
  const sessions = join(fixture.data, 'sessions');
  await mkdir(sessions, { recursive: true });
  const document = { workspace_root: workspace,
    provider: { id: 'primary', endpoint: 'http://127.0.0.1:1/v1', model: 'test', trust_zone: 'loopback' } };
  await writeFile(join(fixture.data, 'config', 'manifest.json'), JSON.stringify(document));
  const { resolveManifest } = await module('config.js');
  const { NND_CONFIGURATION_OPTIONS } = await module('nnd-setup-config.js');
  const { JournalStore } = await module('store.js');
  const config = resolveManifest(document, NND_CONFIGURATION_OPTIONS);
  const id = 'legacy.session';
  const journal = new JournalStore(sessions, id);
  await journal.open();
  await journal.append('session_created', { sessionId: id, workspaceRoot: workspace,
    executionManifest: config.executionManifest, mission: config.mission });
  await journal.close();
  const journalBytes = await readFile(journal.path);
  const parent = { sessionId: id, subjectId: 'nnd-local-operator', workspaceIds: ['local'],
    title: 'Preserved', directory: workspace, createdAt: 1, updatedAt: 2,
    reviewMode: 'auto-review', reviewRevision: 7 };
  const catalogPath = join(sessions, 'nnd-contexts.json');
  await writeFile(catalogPath, JSON.stringify([parent]));
  const child = { version: 1, sessionId: 'child_one', parentId: id, subjectId: parent.subjectId,
    workspaceIds: ['local'], parentCreatedAt: 1, createdAt: 2, updatedAt: 3,
    directory: workspace, title: 'Child', configuredModel: null, transcript: [], activity: [] };
  await mkdir(`${catalogPath}.children`);
  const childPath = join(`${catalogPath}.children`, `${Buffer.from(child.sessionId).toString('hex')}.json`);
  await writeFile(childPath, JSON.stringify(child));
  const result = JSON.parse(await run(process.execPath,
    [fixture.cli, 'nnd', 'service', 'migrate', fixture.nna],
    { cwd: root, env: fixture.env, timeout: 120000,
      outputFiles: { stdout: join(root, 'migration-stdout.log'), stderr: join(root, 'migration-stderr.log') } }));
  assert.equal(result.migrated, true);
  assert.equal(result.sessions, 1);
  const [rewritten] = JSON.parse(await readFile(catalogPath));
  assert.match(rewritten.workspaceIds[0], /^ws_[a-f0-9]{24}$/u, 'catalog must gain a native workspace id');
  assert.deepEqual({ ...rewritten, workspaceIds: ['local'] }, parent, 'only workspaceIds may change');
  const rewrittenChild = JSON.parse(await readFile(childPath));
  assert.match(rewrittenChild.workspaceIds[0], /^ws_[a-f0-9]{24}$/u);
  assert.deepEqual(await readFile(journal.path), journalBytes, 'journals are never rewritten');
  const backup = join(fixture.data, 'runtime', 'nnd', 'migrations', result.transaction_id, '0.before');
  assert.deepEqual(await readFile(backup), Buffer.from(JSON.stringify([parent])), 'original catalog is archived before rewrite');
  // The legacy provider config pointed at a dead endpoint; the activation
  // trial would keep failing health for that unrelated reason. The migrated
  // catalog itself stays in the data root and is carried across every later
  // leg of the journey.
  await rm(join(fixture.data, 'config', 'manifest.json'), { force: true });
}

// Uninstall preserves the native data root; place the operator file there
// so the post-uninstall survival check is a real assertion.
async function operatorEvidence(fixture) {
  const disposableData = join(fixture.data, 'user-data');
  await mkdir(disposableData, { recursive: true });
  const file = join(disposableData, 'operator-work.txt');
  const content = 'preserved by default uninstall\n';
  await writeFile(file, content);
  return { file, content };
}

async function main(nnaSource) {
  assert.equal(process.platform, 'win32', 'Windows prebuilt acceptance only');
  assert.ok(typeof nnaSource === 'string' && /^[A-Za-z]:[\\/]/u.test(nnaSource), 'Provide an absolute NNA source root');
  nnaSource = await realpath(nnaSource);
  await mkdir(fixtureBase, { recursive: true });
  assert.equal((await lstat(fixtureBase)).isSymbolicLink(), false, 'Fixture base cannot be a link');
  const root = join(fixtureBase, `nnd-accept-${randomUUID().replaceAll('-', '').slice(0, 10)}`);
  await privateDirectory(root, fixtureBase);
  const fixture = await prepare(nnaSource, root);
  let serviceStopped = false;
  let journeyFailed = true;
  try {
    await exerciseMigration(fixture, root);
    const exported = await exportPrebuiltPayload(join(root, 'NND payload'));
    const anchor = fixture.nnd;
    const { packageRoot } = await stageAndActivate(fixture, root, exported);
    const { file: operatorWorkFile, content: operatorWork } = await operatorEvidence(fixture);
    fixture.nnd = packageRoot;
    const status = await assertSelected(fixture, packageRoot, exported.version);
    await exerciseShells(fixture, root, status);
    await readFile(operatorWorkFile, 'utf8').then(value => assert.equal(value, operatorWork));
    await cli(fixture, 'stop');
    await waitStopped(fixture);
    // Upgrade: a second payload version stops cleanly, re-stages, and
    // re-activates; the prior consumed receipt pair rotates into the archive.
    const upgradedVersion = await exerciseUpgrade(fixture, root, anchor, exported, operatorWorkFile, operatorWork);
    await cli(fixture, 'stop');
    await waitStopped(fixture);
    // Rollback: the retained prior payload re-activates onto the same anchor.
    await exerciseRollback(fixture, root, anchor, exported, operatorWorkFile, operatorWork);
    await cli(fixture, 'stop');
    await waitStopped(fixture);
    serviceStopped = true;
    await uninstall(fixture, root, anchor);
    // Cancellation + reinstall: crash staging mid-copy, recover it, activate,
    // uninstall, then reinstall the same payload against the retained data.
    await exerciseCancellation(fixture, root, anchor, exported);
    await uninstall(fixture, root, anchor);
    await exerciseReinstall(fixture, root, anchor, exported, operatorWorkFile, operatorWork);
    journeyFailed = false;
    process.stdout.write(`Real exported prebuilt payload, migration, upgrade, rollback, cancellation, reinstall, Chromium shells and uninstall passed (${exported.version} -> ${upgradedVersion} -> ${exported.version}).\n`);
  } catch (error) {
    // An active install-guard or shell child can lock the fixture; preserve
    // evidence rather than replacing the real failure with EBUSY.
    process.stderr.write(`Acceptance journey failed: ${error instanceof Error ? error.message : error}\n`);
    throw error;
  } finally {
    if (!serviceStopped) {
      try { await cli(fixture, 'stop'); await waitStopped(fixture); serviceStopped = true; }
      catch { process.stderr.write(`Native state uncertain; preserved fixture at ${root}\n`); }
    }
    if (journeyFailed) process.stderr.write(`Acceptance evidence preserved at ${root}\n`);
    else if (serviceStopped && acceptanceEvidence().uncertain === false) {
      await rm(await checkedFixturePath(root, fixtureBase), { recursive: true, force: true, maxRetries: 5 })
        .catch(() => process.stderr.write(`Fixture locked by a surviving child; evidence kept at ${root}\n`));
    } else process.stderr.write(`Acceptance evidence preserved at ${root}\n`);
  }
}
if (process.argv[1] && process.argv[1].endsWith('installed-prebuilt-acceptance.mjs')) {
  if (process.argv.length !== 3) throw new Error('usage: node scripts/installed-prebuilt-acceptance.mjs ABSOLUTE_NNA_SOURCE');
  await main(process.argv[2]);
}
