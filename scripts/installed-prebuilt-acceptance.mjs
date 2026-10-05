// SPDX-License-Identifier: Apache-2.0
/** Real exported NND payload consumed by disposable installed NNA. */
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  checkedFixturePath, cli, prepare, privateDirectory, run, selectedPackage,
  shell, waitStopped, acceptanceEvidence,
} from './installed-source-acceptance.mjs';
import { exportPrebuiltPayload } from './export-prebuilt-payload.mjs';

const source = join(dirname(fileURLToPath(import.meta.url)), '..');
// The immutable slot name includes the payload digest, so use a trusted home
// ancestor while keeping the disposable slot below the 259-character limit.
const fixtureBase = process.env.NND_ACCEPTANCE_FIXTURE_ROOT ?? join(homedir(), '.n');

// Stage, then activate one prepared immutable slot; return its live roots.
async function stageAndActivate(fixture, root, exported) {
  const manifest = await readFile(join(exported.root, 'NND_PAYLOAD.json'));
  const manifestSha256 = createHash('sha256').update(manifest).digest('hex').toLowerCase();
  const installer = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    join(source, 'install.ps1')];
  const common = ['-PrebuiltPayloadRoot', `${exported.root}`, '-PrebuiltManifestSha256', manifestSha256,
    '-InstallDir', fixture.nnd, '-NnaInstallRoot', fixture.nna, '-ShortcutRoot', fixture.shortcuts];
  const staged = await run('powershell.exe', [...installer, '-StagePrebuiltPayload', ...common], {
    cwd: root, env: fixture.env, timeout: 900000,
    outputFiles: { stdout: join(root, 'staging-stdout.log'), stderr: join(root, 'staging-stderr.log') },
  });
  const stageMatch = staged.match(/^\s*operation    : ([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/m);
  assert.match(staged, /Prebuilt NND payload staged; activation remains pending/u);
  assert.equal(Boolean(stageMatch), true, 'Installer did not expose the immutable stage operation');
  const activation = await run('powershell.exe', [...installer, '-ActivatePrebuiltSlot',
    '-PrebuiltStageOperation', stageMatch[1], ...common], {
    cwd: root, env: fixture.env, timeout: 900000,
    outputFiles: { stdout: join(root, 'activation-stdout.log'), stderr: join(root, 'activation-stderr.log') },
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

async function uninstall(fixture, root) {
  const uninstalled = await run('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(source, 'install.ps1'),
    '-Uninstall', '-NnaInstallRoot', fixture.nna, '-InstallDir', fixture.nnd, '-ShortcutRoot', fixture.shortcuts], {
    cwd: root, env: fixture.env, timeout: 120000,
    outputFiles: { stdout: join(root, 'uninstall-stdout.log'), stderr: join(root, 'uninstall-stderr.log') },
  });
  assert.match(uninstalled, /Uninstall complete/u);
  assert.equal('ENOENT', (await lstat(fixture.nnd).then(() => 'present', error => error.code)),
    'Default uninstall must remove only the launcher anchor');
  assert.equal((await selectedPackage(fixture)).registered, false, 'Default uninstall must deactivate NND');
  assert.doesNotThrow(async () => await lstat(join(fixture.data, 'runtime', 'nnd', 'install-slots')),
    'Default uninstall must preserve immutable slots and provenance');
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
  try {
    const exported = await exportPrebuiltPayload(join(root, 'NND payload'));
    const { installer, common, packageRoot } = await stageAndActivate(fixture, root, exported);
    // Uninstall preserves the native data root; place the operator file there
    // so the post-uninstall survival check is a real assertion.
    const disposableData = join(fixture.data, 'user-data');
    await mkdir(disposableData, { recursive: true });
    const operatorWorkFile = join(disposableData, 'operator-work.txt');
    const operatorWork = 'preserved by default uninstall\n';
    await writeFile(operatorWorkFile, operatorWork);
    fixture.nnd = packageRoot;
    const status = await assertSelected(fixture, packageRoot, exported.version);
    await exerciseShells(fixture, root, status);
    await readFile(operatorWorkFile, 'utf8').then(value => assert.equal(value, operatorWork));
    await cli(fixture, 'stop');
    await waitStopped(fixture);
    serviceStopped = true;
    await uninstall(fixture, root);
    process.stdout.write(`Real exported prebuilt payload, activation, Chromium shells and uninstall passed (${exported.version}).\n`);
  } finally {
    if (!serviceStopped) {
      try { await cli(fixture, 'stop'); await waitStopped(fixture); serviceStopped = true; }
      catch { process.stderr.write(`Native state uncertain; preserved fixture at ${root}\n`); }
    }
    if (serviceStopped && acceptanceEvidence().uncertain === false) {
      await rm(await checkedFixturePath(root, fixtureBase), { recursive: true, force: true, maxRetries: 5 });
    } else process.stderr.write(`Acceptance evidence preserved at ${root}\n`);
  }
}
if (process.argv[1] && process.argv[1].endsWith('installed-prebuilt-acceptance.mjs')) {
  if (process.argv.length !== 3) throw new Error('usage: node scripts/installed-prebuilt-acceptance.mjs ABSOLUTE_NNA_SOURCE');
  await main(process.argv[2]);
}
