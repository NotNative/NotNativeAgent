// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installAvailableUpdate, selectedInstallMarkerPath } from '../src/update-service.js';

const oldVersion = '20260101-1', version = '20260101-2', sha = 'c'.repeat(40);
async function fixture(t, failure) {
  const root = await mkdtemp(join(tmpdir(), 'nna-update-install-')); t.after(() => rm(root, { recursive: true, force: true }));
  const install = join(root, 'install'), payload = join(install, 'installed'), source = join(root, 'source', 'candidate');
  await mkdir(payload, { recursive: true }); await mkdir(join(source, 'desktop'), { recursive: true });
  const marker = { product: 'NotNativeAgent', install_root: install, data_root: join(root, 'data'), node: process.execPath, version: oldVersion, incarnation_id: '00000000-0000-4000-8000-000000000001' };
  const markerPath = join(install, 'install.json'); await writeFile(markerPath, JSON.stringify(marker));
  await writeFile(join(payload, 'VERSION'), oldVersion);
  for (const [name, text] of Object.entries({ VERSION: version, 'package.json': JSON.stringify({ name: 'not-native-agent', nna_version: version }),
    'install.ps1': '# fixture', 'install.sh': '# fixture', 'desktop/VERSION': version,
    'desktop/package.json': JSON.stringify({ nnd_version: version }), 'desktop/install.cmd': '@echo off' })) await writeFile(join(source, name), text);
  const archive = join(root, 'release.tar.gz');
  const packed = spawnSync('tar', ['-czf', archive, '-C', join(root, 'source'), 'candidate'], { windowsHide: true }); assert.equal(packed.status, 0);
  const requests = []; let installs = 0;
  const runProcess = async (command, args) => {
    if (command === 'tar') {
      const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true }); return { code: result.status, stdout: result.stdout };
    }
    if (args.includes('desktop')) return { code: 0, stdout: 'null' };
    if (args.includes('--version')) return { code: 0, stdout: failure === 'verification' ? oldVersion : await readFile(join(payload, 'VERSION'), 'utf8') };
    installs++;
    await writeFile(join(payload, 'VERSION'), version); await writeFile(markerPath, JSON.stringify({ ...marker, version: failure === 'descriptor' ? oldVersion : version,
      data_root: failure === 'data-root' ? join(root, 'foreign-data') : marker.data_root,
      incarnation_id: failure === 'incarnation' ? '00000000-0000-4000-8000-000000000002' : marker.incarnation_id }));
    return { code: failure === 'installer' ? 1 : 0, stdout: '' };
  };
  const fetchImpl = async url => {
    requests.push(url);
    if (url.endsWith('/commits/main')) return Response.json({ sha });
    if (url.endsWith(`/contents/VERSION?ref=${sha}`)) return new Response(version);
    assert.equal(url, `https://codeload.github.com/NotNative/NotNativeAgent/tar.gz/${sha}`);
    return new Response(failure === 'archive' ? 'invalid tar' : await readFile(archive));
  };
  return { root, markerPath, payload, requests, installs: () => installs, options: { currentVersion: oldVersion,
    installMarkerPath: markerPath, paths: { updateState: join(root, 'update-state.json'), updateRoot: join(root, 'updates') }, fetchImpl, runProcess } };
}
test('updater downloads the pinned commit, extracts real tar bytes, installs, verifies and cleans staging', async t => {
  const f = await fixture(t);
  const result = await installAvailableUpdate(f.options);
  assert.equal(result.installed, true); assert.equal(f.installs(), 1); assert.equal(f.requests.length, 3);
  assert.equal((JSON.parse(await readFile(f.markerPath))).version, version);
  assert.deepEqual(await readdir(f.options.paths.updateRoot), []);
  assert.ok(JSON.parse(await readFile(f.options.paths.updateState)).installed_at);
});
for (const failure of ['installer', 'verification', 'descriptor', 'data-root', 'incarnation']) test(`failed ${failure} preserves the installer outcome and retains explicit repair evidence`, async t => {
  const f = await fixture(t, failure);
  await assert.rejects(installAvailableUpdate(f.options), asyncError => {
    assert.equal(asyncError.code, failure === 'installer' ? 'update_install_failed' : 'update_verification_failed');
    assert.ok(asyncError.recovery_root); assert.ok(asyncError.repair_source); return true;
  });
  assert.equal(await readFile(join(f.payload, 'VERSION'), 'utf8'), version);
  assert.equal(JSON.parse(await readFile(f.markerPath)).version, failure === 'descriptor' ? oldVersion : version);
  const entries = await readdir(f.options.paths.updateRoot);
  const recovery = entries.find(name => name.startsWith('recovery-'));
  assert.equal(await readFile(join(f.options.paths.updateRoot, recovery, 'VERSION'), 'utf8'), oldVersion);
  assert.equal(entries.some(name => name.startsWith('stage-')), true); assert.equal(entries.includes('update.lock'), false);
  assert.equal(JSON.parse(await readFile(f.options.paths.updateState)).installed_at, undefined);
});
test('invalid downloaded archive never invokes installer or changes existing payload', async t => {
  const f = await fixture(t, 'archive');
  await assert.rejects(installAvailableUpdate(f.options), { code: 'update_archive_invalid' });
  assert.equal(f.installs(), 0); assert.equal(await readFile(join(f.payload, 'VERSION'), 'utf8'), oldVersion);
  assert.deepEqual(await readdir(f.options.paths.updateRoot), []);
});

test('pending recovery copies bound retry storage and prevent another installation', async t => {
  const f = await fixture(t);
  await mkdir(f.options.paths.updateRoot, { recursive: true });
  for (let index = 0; index < 3; index++) await mkdir(join(f.options.paths.updateRoot, `recovery-previous-${index}`));
  await assert.rejects(installAvailableUpdate(f.options), { code: 'update_recovery_pending' });
  assert.equal(f.installs(), 0); assert.equal(await readFile(join(f.payload, 'VERSION'), 'utf8'), oldVersion);
  assert.equal((await readdir(f.options.paths.updateRoot)).length, 3);
});

test('an existing update lock refuses installation without claiming a second owner is live', async t => {
  const f = await fixture(t);
  await mkdir(f.options.paths.updateRoot, { recursive: true });
  await writeFile(join(f.options.paths.updateRoot, 'update.lock'), 'prior operation');
  await assert.rejects(installAvailableUpdate(f.options), error => {
    assert.equal(error.code, 'update_in_progress'); assert.match(error.message, /running or interrupted/u); return true;
  });
  assert.equal(f.installs(), 0); assert.equal(await readFile(join(f.payload, 'VERSION'), 'utf8'), oldVersion);
  assert.equal(await readFile(join(f.options.paths.updateRoot, 'update.lock'), 'utf8'), 'prior operation');
});

test('an installed CLI selects its custom installation instead of LOCALAPPDATA default', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nna-custom-update-')); t.after(() => rm(root, { recursive: true, force: true }));
  const cli = join(root, 'custom location', 'installed', 'src', 'cli.js');
  await mkdir(join(root, 'custom location', 'installed', 'src'), { recursive: true }); await writeFile(cli, '// fixture');
  assert.equal(await selectedInstallMarkerPath(cli), join(root, 'custom location', 'install.json'));
});
test('a descriptor that points to another installation refuses before download or mutation', async t => {
  const f = await fixture(t);
  const marker = JSON.parse(await readFile(f.markerPath)); marker.install_root = join(f.root, 'foreign');
  await writeFile(f.markerPath, JSON.stringify(marker));
  await assert.rejects(installAvailableUpdate(f.options), { code: 'update_installation_invalid' });
  assert.equal(f.installs(), 0); assert.equal(f.requests.length, 2);
});

for (const field of ['install_root', 'data_root', 'node']) test(`malformed descriptor ${field} reports a typed refusal before download`, async t => {
  const f = await fixture(t); const marker = JSON.parse(await readFile(f.markerPath)); marker[field] = 42;
  await writeFile(f.markerPath, JSON.stringify(marker));
  await assert.rejects(installAvailableUpdate(f.options), { code: 'update_installation_invalid' });
  assert.equal(f.installs(), 0); assert.equal(f.requests.length, 2);
});
