// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateInstalledNndService, writeInstalledServiceManifest } from './installed-service-package.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'nnd-installed-artifacts-'));
  t.after(async () => {
    assert.ok(root.startsWith(join(tmpdir(), 'nnd-installed-artifacts-')));
    await rm(root, { recursive: true, force: true });
  });
  for (const path of ['scripts', 'packages/electron/dist-server', 'packages/web/dist']) {
    await mkdir(join(root, path), { recursive: true });
  }
  await writeFile(join(root, 'package.json'), JSON.stringify({ version: '20261002.0.2', nnd_version: '20261002-2' }));
  await writeFile(join(root, 'VERSION'), '20261002-2\n');
  await writeFile(join(root, 'scripts/serve-installed.mjs'), 'export const fixture = true;');
  await writeFile(join(root, 'packages/electron/dist-server/server.mjs'), 'export const fixture = true;');
  await writeFile(join(root, 'packages/web/dist/index.html'), '<!doctype html>');
  return root;
}
const windows = { skip: process.platform !== 'win32' };
test('generated manifest admits exact installed artifact and detects later bundle replacement', windows, async (t) => {
  const root = await fixture(t);
  const manifest = await writeInstalledServiceManifest(root);
  const admitted = await validateInstalledNndService(root);
  assert.equal(admitted.version, '20261002-2');
  assert.equal(admitted.manifest.service_activation.bundle_identity.sha256, manifest.service_activation.bundle_identity.sha256);
  await writeFile(admitted.bundle, 'export const replaced = true;');
  await assert.rejects(validateInstalledNndService(root), /incompatible/u);
});
test('artifact admission rejects mismatched versions and bounded metadata overflow', windows, async (t) => {
  const root = await fixture(t);
  await writeInstalledServiceManifest(root);
  await writeFile(join(root, 'VERSION'), '20261002-3');
  await assert.rejects(validateInstalledNndService(root), /inconsistent/u);
  await writeFile(join(root, 'VERSION'), '20261002-2');
  await writeFile(join(root, 'package.json'), ' '.repeat(65_537));
  await assert.rejects(validateInstalledNndService(root), /size limit/u);
});
test('service metadata rejects altered platform and runtime requirements', windows, async (t) => {
  const root = await fixture(t);
  await writeInstalledServiceManifest(root);
  const path = join(root, 'nna-integration/nnd-local/integration.json');
  const original = JSON.parse(await readFile(path, 'utf8'));
  for (const patch of [{ architecture: process.arch === 'x64' ? 'arm64' : 'x64' },
    { runtime: { name: 'node', minimum_major: 100 } }, { entrypoint: 'scripts/other.mjs' }]) {
    await writeFile(path, JSON.stringify({ ...original, service_activation: { ...original.service_activation, ...patch } }));
    await assert.rejects(validateInstalledNndService(root), /incompatible/u);
  }
});
test('metadata junction escaping the installed root is refused', windows, async (t) => {
  const root = await fixture(t);
  const outside = await fixture(t);
  await symlink(outside, join(root, 'nna-integration'), 'junction');
  await assert.rejects(writeInstalledServiceManifest(root), /escapes/u);
  await assert.rejects(access(join(outside, 'nnd-local')), { code: 'ENOENT' });
});
