// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runNndPackageCommand, validateNndPackage } from '../src/nnd-package.js';

const VERSION = '20260926-56';
async function fixture(root, version = VERSION) {
  for (const path of ['nna-integration/nnd-local/integration.json', 'package.json',
    'packages/electron/dist-server/server.mjs', 'packages/web/dist/index.html']) {
    await mkdir(dirname(join(root, path)), { recursive: true });
  }
  await writeFile(join(root, 'nna-integration/nnd-local/integration.json'), JSON.stringify({
    id: 'nnd-local', ownership: 'nnd', scope: 'local-gui', nna_integration_protocol: '1.0', version,
  }));
  await writeFile(join(root, 'package.json'), JSON.stringify({ nnd_version: version }));
  await writeFile(join(root, 'packages/electron/dist-server/server.mjs'), '');
  await writeFile(join(root, 'packages/web/dist/index.html'), '');
}

test('registers only a complete version-matched NND package and reports drift', async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'nna-nnd-package-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = join(temp, 'nnd');
  const config = join(temp, 'config');
  await mkdir(config); await fixture(root);
  const paths = { config };
  assert.deepEqual(await runNndPackageCommand(['status'], paths), { registered: false });
  assert.match((await runNndPackageCommand(['activate', root], paths)).version, /^20260926-56$/u);
  assert.equal((await runNndPackageCommand(['activate', root], paths)).registered, true);
  assert.deepEqual(await runNndPackageCommand(['status'], paths), { registered: true, valid: true, root, version: VERSION });
  await assert.rejects(runNndPackageCommand(['deactivate', join(temp, 'other')], paths), { code: 'nnd_package_root_mismatch' });
  await writeFile(join(root, 'package.json'), JSON.stringify({ nnd_version: '20260926-57' }));
  assert.deepEqual(await runNndPackageCommand(['status'], paths), {
    registered: true, valid: false, root, version: VERSION, reason: 'nnd_package_manifest_invalid',
  });
  const uninstallPath = process.platform === 'win32' ? root.toUpperCase() : root;
  assert.deepEqual(await runNndPackageCommand(['deactivate', uninstallPath], paths), { registered: false });
  assert.deepEqual(await runNndPackageCommand(['status'], paths), { registered: false });
});

test('rejects incompatible metadata, missing assets, and escaping symlink', async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'nna-nnd-package-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = join(temp, 'nnd'); await fixture(root);
  await assert.rejects(validateNndPackage('relative'), { code: 'nnd_package_root_invalid' });
  const manifest = join(root, 'nna-integration/nnd-local/integration.json');
  const original = await readFile(manifest, 'utf8');
  await writeFile(manifest, JSON.stringify({ ...JSON.parse(original), nna_integration_protocol: '2.0' }));
  await assert.rejects(validateNndPackage(root), { code: 'nnd_package_manifest_invalid' });
  await writeFile(manifest, original);
  await rm(join(root, 'packages/web/dist/index.html'));
  await assert.rejects(validateNndPackage(root), { code: 'nnd_package_incomplete' });
  try { await symlink(manifest, join(root, 'packages/web/dist/index.html')); }
  catch (error) { if (error.code === 'EPERM') return; throw error; }
  assert.equal((await validateNndPackage(root)).version, VERSION);
  await rm(join(root, 'packages/web/dist/index.html'));
  const outside = join(temp, 'outside.html'); await writeFile(outside, '');
  await symlink(outside, join(root, 'packages/web/dist/index.html'));
  await assert.rejects(validateNndPackage(root), { code: 'nnd_package_incomplete' });
});
