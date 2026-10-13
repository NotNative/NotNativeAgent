// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { releaseEligible, releaseFiles } from './release-content.mjs';

test('release identifies installers, Electron lifecycle sources and assets', () => {
  for (const name of ['install.ps1', 'install.sh', 'packages/electron/main.mjs',
    'packages/electron/native-service-client.mjs', 'packages/electron/package.json',
    'packages/electron/assets/tray-stopped.png', 'packages/electron/resources/icon.ico']) {
    assert.equal(releaseEligible(name), true, name);
  }
  for (const name of ['node_modules/pkg/a.js', 'packages/electron/dist-server/server.mjs',
    'packages/electron/node_modules/electron/cli.js', 'packages/electron/resources/web-dist/index.html',
    'packages/electron/build-stamp.json', 'packages/electron/install-mode.txt',
    'dist-electron/setup.exe', '.tmp-nnd-log.txt']) assert.equal(releaseEligible(name), false, name);
});

test('installer and shell edits change sealed content; generated output does not', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nnd-release-content-'));
  try {
    await mkdir(join(root, 'packages/electron/dist-server'), { recursive: true });
    await writeFile(join(root, 'install.ps1'), 'installer v1');
    await writeFile(join(root, 'packages/electron/main.mjs'), 'shell v1');
    await writeFile(join(root, 'packages/electron/dist-server/server.mjs'), 'bundle v1');
    await writeFile(join(root, 'packages/electron/build-stamp.json'), 'generated stamp v1');
    const digest = async () => {
      const hash = createHash('sha256');
      for (const path of await releaseFiles(root)) hash.update(relative(root, path)).update(await readFile(path));
      return hash.digest('hex');
    };
    const first = await digest();
    await writeFile(join(root, 'packages/electron/dist-server/server.mjs'), 'bundle v2');
    await writeFile(join(root, 'packages/electron/build-stamp.json'), 'generated stamp v2');
    await writeFile(join(root, 'packages/electron/install-mode.txt'), 'script');
    assert.equal(await digest(), first);
    await writeFile(join(root, 'install.ps1'), 'installer v2');
    const second = await digest(); assert.notEqual(second, first);
    await writeFile(join(root, 'packages/electron/main.mjs'), 'shell v2');
    assert.notEqual(await digest(), second);
    assert.equal((await releaseFiles(root)).length, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('release rejects selected source junctions and skips excluded vendor junctions', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'nnd-release-links-'));
  const root = join(fixture, 'root'), external = join(fixture, 'external');
  try {
    await mkdir(join(root, 'packages'), { recursive: true });
    await mkdir(external);
    await writeFile(join(external, 'main.mjs'), 'unrelated content');
    await symlink(external, join(root, 'node_modules'), 'junction');
    assert.deepEqual(await releaseFiles(root), []);
    await symlink(external, join(root, 'packages/electron'), 'junction');
    await assert.rejects(releaseFiles(root), /Release source link is unsupported: packages\/electron/u);
  } finally { await rm(fixture, { recursive: true, force: true }); }
});
