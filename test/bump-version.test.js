// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { argumentsFrom, bumpVersion, writeSynchronized } from '../scripts/bump-version.js';

async function fixture(sbom = {
  name: 'old', packages: [{ name: 'NotNativeAgent', SPDXID: 'SPDXRef-Package-NotNativeAgent', versionInfo: '20260101-1' }],
}) {
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
  assert.throws(() => argumentsFrom(['--iteration', 'abc']), /safe integer/u);
  assert.throws(() => argumentsFrom(['--date', '20261231', '--date', '20270101']), /duplicate option/u);
});

test('version bump rejects malformed metadata with its filename before any write', async () => {
  const root = await fixture();
  try {
    for (const name of ['package.json', 'SBOM.spdx.json']) {
      const path = join(root, name); const original = await readFile(path, 'utf8');
      for (const contents of ['null', '[]', '42', '{broken']) {
        await writeFile(path, contents); let writes = 0;
        await assert.rejects(bumpVersion(root, { date: '20261231' }, {
          writeFile: async () => { writes += 1; },
        }), (error) => error.message.includes(name));
        assert.equal(writes, 0);
      }
      await writeFile(path, original);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('version rollback report names only artifacts whose restoration failed', async () => {
  const entries = ['one', 'two', 'three'].map((path) => ({ path, before: 'old', after: 'new' }));
  await assert.rejects(writeSynchronized(entries, async (path, content) => {
    if (path === 'three' || (path === 'one' && content === 'old')) throw new Error(path);
  }), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.match(error.message, /one/u);
    assert.doesNotMatch(error.message, /two/u);
    return true;
  });
});
