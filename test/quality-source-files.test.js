// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { collectSourceFiles } from '../scripts/quality-source-files.js';

test('source limit counts checked JavaScript files, not assets or skipped directories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-quality-source-'));
  try {
    await mkdir(join(root, 'nested'));
    await mkdir(join(root, 'node_modules'));
    await writeFile(join(root, 'first.js'), 'export const first = true;\n');
    await writeFile(join(root, 'nested', 'second.js'), 'export const second = true;\n');
    await writeFile(join(root, 'asset.txt'), 'asset\n');
    await writeFile(join(root, 'node_modules', 'ignored.js'), 'broken syntax');
    const files = await collectSourceFiles(root, 2);
    assert.deepEqual(files.sort(), [join(root, 'first.js'), join(root, 'nested', 'second.js')].sort());
    await assert.rejects(collectSourceFiles(root, 1), /source file count exceeds 1/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('source collector rejects symlinks instead of silently omitting linked code', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'nna-quality-link-'));
  try {
    const target = join(root, 'target');
    await mkdir(target);
    await writeFile(join(target, 'source.js'), 'export const value = true;\n');
    try { await symlink(target, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) {
      if (['EPERM', 'EACCES'].includes(error.code)) { context.skip('directory links unavailable'); return; }
      throw error;
    }
    await assert.rejects(collectSourceFiles(root, 2), /source entry is a symlink/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});
