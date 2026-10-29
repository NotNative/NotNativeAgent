// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { checkVersionPairing } from '../desktop/scripts/bump-version.js';

async function fixture(packageJson) {
  const root = await mkdtemp(join(tmpdir(), 'nna-desktop-version-'));
  const desktop = join(root, 'desktop');
  await mkdir(join(desktop, 'scripts'), { recursive: true });
  await writeFile(join(root, 'VERSION'), '20261022-29\n');
  await writeFile(join(desktop, 'VERSION'), '20261022-29\n');
  await writeFile(join(desktop, 'package.json'), `${JSON.stringify(packageJson)}\n`);
  return { root, desktop };
}

test('desktop version check reports missing or non-string package stamps', async () => {
  for (const packageJson of [{ version: '20261022.0.29' },
    { version: 20261022, desktop_version: '20261022-29' },
    { version: '20261022.0.29', desktop_version: 20261022 }]) {
    const { root, desktop } = await fixture(packageJson);
    try {
      await assert.rejects(checkVersionPairing(desktop), /must contain string version and desktop_version fields/u);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test('desktop version check uses its real checkout when its CLI entrypoint is a symlink', async (context) => {
  const { root, desktop } = await fixture({ version: '20991231.0.1', desktop_version: '20991231-1' });
  try {
    await writeFile(join(root, 'VERSION'), '20991231-1\n');
    await writeFile(join(desktop, 'VERSION'), '20991231-1\n');
    const repoVersion = (await readFile(join(import.meta.dirname, '..', 'VERSION'), 'utf8')).trim();
    assert.notEqual(repoVersion, '20991231-1');
    const source = join(import.meta.dirname, '..', 'desktop', 'scripts');
    const link = join(desktop, 'check-scripts');
    try { await symlink(source, link, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) {
      if (['EPERM', 'EACCES'].includes(error.code)) { context.skip('directory links unavailable'); return; }
      throw error;
    }
    for (const flags of [[], ['--preserve-symlinks-main']]) {
      const run = spawnSync(process.execPath, [...flags, join(link, 'bump-version.js'), '--check'], { encoding: 'utf8' });
      assert.equal(run.status, 0, run.stderr);
      assert.equal(run.stdout.trim(), `version pairing is coherent: ${repoVersion}`);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
