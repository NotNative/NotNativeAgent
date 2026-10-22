// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { argumentsFrom, bumpVersion, writeSynchronized } from '../scripts/bump-version.js';

async function fixture(sbom = {
  SPDXID: 'SPDXRef-DOCUMENT', name: 'old',
  packages: [{ name: 'not-native-agent', SPDXID: 'SPDXRef-Package-NNA', versionInfo: '20260101-1' }],
  relationships: [{ spdxElementId: 'SPDXRef-DOCUMENT', relationshipType: 'DESCRIBES', relatedSpdxElement: 'SPDXRef-Package-NNA' }],
}) {
  const root = await mkdtemp(join(tmpdir(), 'nna-bump-rollback-'));
  await mkdir(join(root, 'src'));
  await mkdir(join(root, 'desktop'));
  await writeFile(join(root, 'VERSION'), '20260101-1\n', 'utf8');
  await writeFile(join(root, 'package.json'), '{"version":"20260101.0.1","nna_version":"20260101-1"}\n', 'utf8');
  await writeFile(join(root, 'src', 'product.js'), "export const VERSION = '20260101-1';\n", 'utf8');
  await writeFile(join(root, 'SBOM.spdx.json'), `${JSON.stringify(sbom)}\n`, 'utf8');
  // desktop mirrors the root stamp; the bump rewrites these as part of one synchronized publication
  await writeFile(join(root, 'desktop', 'VERSION'), '20260101-1\n', 'utf8');
  await writeFile(join(root, 'desktop', 'package.json'), '{"version":"20260101.0.1","nnd_version":"20260101-1"}\n', 'utf8');
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
    }), /SBOM must describe exactly one NotNativeAgent package/u);
    assert.equal(writes, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('version bump validates Gregorian dates without local-time or two-digit-year coercion', async () => {
  const root = await fixture();
  const previousTimezone = process.env.TZ;
  try {
    // Pacific/Apia skipped 2011-12-30; it remains a valid Gregorian date for a version stamp.
    process.env.TZ = 'Pacific/Apia';
    for (const date of ['00960229', '20000229', '20111230']) {
      const result = await bumpVersion(root, { date, iteration: 1 });
      assert.equal(result.version, `${date}-1`);
    }
    for (const date of ['00000101', '01000229', '19000229', '20230229', '20230431', '20231301']) {
      await assert.rejects(bumpVersion(root, { date, iteration: 1 }),
        /--date must be a real YYYYMMDD date/u, date);
    }
  } finally {
    if (previousTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimezone;
    await rm(root, { recursive: true, force: true });
  }
});

test('version bump stamps the described product even when dependencies precede it', async () => {
  const root = await fixture({
    SPDXID: 'SPDXRef-DOCUMENT', name: 'old',
    packages: [
      { name: 'dependency', SPDXID: 'SPDXRef-Package-Dependency', versionInfo: '4.2.0' },
      { name: 'not-native-agent', SPDXID: 'SPDXRef-Package-NNA', versionInfo: '20260101-1' },
    ],
    relationships: [{ spdxElementId: 'SPDXRef-DOCUMENT', relationshipType: 'DESCRIBES', relatedSpdxElement: 'SPDXRef-Package-NNA' }],
  });
  try {
    await bumpVersion(root, { date: '20261231', iteration: 2 });
    const sbom = JSON.parse(await readFile(join(root, 'SBOM.spdx.json'), 'utf8'));
    assert.equal(sbom.packages[0].versionInfo, '4.2.0');
    assert.equal(sbom.packages[1].versionInfo, '20261231-2');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('version bump rejects ambiguous or mismatched SBOM descriptions before any write', async () => {
  const product = { name: 'not-native-agent', SPDXID: 'SPDXRef-Package-NNA', versionInfo: '20260101-1' };
  const dependency = { name: 'dependency', SPDXID: 'SPDXRef-Package-Dependency', versionInfo: '4.2.0' };
  const describesProduct = { spdxElementId: 'SPDXRef-DOCUMENT', relationshipType: 'DESCRIBES', relatedSpdxElement: product.SPDXID };
  const base = { SPDXID: 'SPDXRef-DOCUMENT', packages: [product], relationships: [describesProduct] };
  const malformed = [
    { ...base, SPDXID: undefined, relationships: [{ ...describesProduct, spdxElementId: undefined }] },
    { ...base, relationships: [describesProduct, { ...describesProduct }] },
    { ...base, packages: [product, { ...dependency, SPDXID: product.SPDXID }] },
    { ...base, packages: [{ ...product, SPDXID: base.SPDXID }], relationships: [{ ...describesProduct, relatedSpdxElement: base.SPDXID }] },
    { ...base, packages: [product, dependency], relationships: [{ ...describesProduct, relatedSpdxElement: dependency.SPDXID }] },
    { ...base, packages: [{ ...product, name: 'wrong-product' }] },
  ];
  for (const sbom of malformed) {
    const root = await fixture(sbom);
    let writes = 0;
    try {
      await assert.rejects(bumpVersion(root, { date: '20261231', iteration: 2 }, {
        writeFile: async () => { writes += 1; },
      }), /SBOM must describe exactly one NotNativeAgent package/u);
      assert.equal(writes, 0);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test('version bump restores a destination whose write truncates before failing', async () => {
  const root = await fixture();
  const paths = ['VERSION', 'package.json', join('src', 'product.js'), 'SBOM.spdx.json'];
  const before = await Promise.all(paths.map((path) => readFile(join(root, path), 'utf8')));
  let failed = false;
  try {
    await assert.rejects(bumpVersion(root, { date: '20261231', iteration: 2 }, {
      writeFile: async (path, content, encoding) => {
        if (!failed && path === join(root, 'src', 'product.js')) {
          failed = true;
          await writeFile(path, 'partial', encoding);
          throw new Error('simulated partial write');
        }
        return writeFile(path, content, encoding);
      },
    }), /simulated partial write/u);
    assert.deepEqual(await Promise.all(paths.map((path) => readFile(join(root, path), 'utf8'))), before);
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
    if ((path === 'three' && content === 'new') || (path === 'one' && content === 'old')) throw new Error(path);
  }), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.match(error.message, /one/u);
    assert.doesNotMatch(error.message, /two/u);
    return true;
  });
});
