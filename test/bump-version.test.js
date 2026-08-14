// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { argumentsFrom, bumpVersion } from '../scripts/bump-version.js';

async function fixture(sbom = { name: 'old', packages: [{ versionInfo: '20260101-1' }] }) {
  const root = await mkdtemp(join(tmpdir(), 'nna-bump-rollback-'));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'VERSION'), '20260101-1\n', 'utf8');
  await writeFile(join(root, 'package.json'), '{"version":"20260101.0.1","nna_version":"20260101-1"}\n', 'utf8');
  await writeFile(join(root, 'src', 'product.js'), "export const VERSION = '20260101-1';\n", 'utf8');
  await writeFile(join(root, 'SBOM.spdx.json'), `${JSON.stringify(sbom)}\n`, 'utf8');
  return root;
}

test('version bump rolls back every completed write when publication fails', async () => {
  const root = await fixture();
  const paths = ['VERSION', 'package.json', join('src', 'product.js'), 'SBOM.spdx.json'];
  const before = await Promise.all(paths.map((path) => readFile(join(root, path), 'utf8')));
  let failed = false;
  try {
    await assert.rejects(bumpVersion(root, { date: '20261231', iteration: 2 }, {
      writeFile: async (path, content, encoding) => {
        if (!failed && path === join(root, 'src', 'product.js')) {
          failed = true; throw new Error('simulated write failure');
        }
        return writeFile(path, content, encoding);
      },
    }), /simulated write failure/u);
    assert.deepEqual(await Promise.all(paths.map((path) => readFile(join(root, path), 'utf8'))), before);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('version bump validates the primary SBOM package before writing', async () => {
  const root = await fixture({ name: 'old', packages: [] });
  let writes = 0;
  try {
    await assert.rejects(bumpVersion(root, { date: '20261231', iteration: 2 }, {
      writeFile: async () => { writes += 1; },
    }), /SBOM must contain a primary package/u);
    assert.equal(writes, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('version bump CLI parser rejects options without values', () => {
  assert.throws(() => argumentsFrom(['--date']), /missing value for --date/u);
  assert.throws(() => argumentsFrom(['--iteration', '--date', '20261231']), /missing value for --iteration/u);
});
