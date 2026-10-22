// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { sealVersionLedger, validVersion } from '../desktop/scripts/release-version-ledger.mjs';

const VERSION = '20261022-34';
const DIGEST = 'a'.repeat(64);
const pathFor = (root) => join(root, 'RELEASE_VERSIONS.json');
const seal = (root, errors, recordMissing = true) => sealVersionLedger({
  root, version: VERSION, recordMissing, candidateDigest: async () => DIGEST, errors,
});

test('release versions require real Gregorian dates and positive iterations', () => {
  for (const value of ['20260229-1', '20261301-1', '20261131-1', '20260001-1',
    '20261022-0', '20261022-01', '20261022-9007199254740992']) {
    assert.equal(validVersion(value), false, value);
  }
  for (const value of ['20240229-1', '20000229-2', '20261022-38']) {
    assert.equal(validVersion(value), true, value);
  }
});

test('malformed desktop release ledger is preserved and cannot be sealed over', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-desktop-ledger-bad-'));
  try {
    for (const original of ['{invalid', '{"schema_version":1,"releases":[{"version":"20261022-1"}]}']) {
      await writeFile(pathFor(root), original);
      const errors = [];
      assert.equal(await seal(root, errors), false);
      assert.equal(await readFile(pathFor(root), 'utf8'), original);
      assert.ok(errors.length > 0);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a non-file ledger path cannot be treated as a missing first seal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-desktop-ledger-dir-'));
  try {
    await mkdir(pathFor(root));
    const errors = [];
    assert.equal(await seal(root, errors), false);
    assert.match(errors.join(' '), /not a regular file/u);
    assert.deepEqual(await readdir(pathFor(root)), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a missing desktop ledger admits only an explicit first seal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-desktop-ledger-first-'));
  try {
    const errors = [];
    assert.equal(await seal(root, errors, false), false);
    await assert.rejects(readFile(pathFor(root), 'utf8'), { code: 'ENOENT' });
    assert.equal(await seal(root, errors), false);
    assert.equal(await seal(root, []), true);
    assert.deepEqual(JSON.parse(await readFile(pathFor(root), 'utf8')),
      { schema_version: 1, releases: [{ version: VERSION, content_sha256: DIGEST }] });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a failed earlier gate prevents a first seal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-desktop-ledger-gate-'));
  try {
    const errors = ['production build failed'];
    assert.equal(await seal(root, errors), false);
    assert.deepEqual(errors, ['production build failed']);
    await assert.rejects(readFile(pathFor(root), 'utf8'), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('invalid current version or digest cannot be sealed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-desktop-ledger-values-'));
  try {
    for (const [version, digest] of [['bad-version', DIGEST], ['20261301-1', DIGEST], [VERSION, 'not-a-digest']]) {
      const errors = [];
      assert.equal(await sealVersionLedger({ root, version, recordMissing: true,
        candidateDigest: async () => digest, errors }), false);
      assert.ok(errors.length > 0);
      await assert.rejects(readFile(pathFor(root), 'utf8'), { code: 'ENOENT' });
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('an existing matching seal leaves the entire ledger byte-for-byte unchanged', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-desktop-ledger-existing-'));
  try {
    const original = `{"schema_version":1,"releases":[{"version":"${VERSION}","content_sha256":"${DIGEST}"}],"note":"legacy formatting"}\r\n`;
    await writeFile(pathFor(root), original);
    assert.equal(await seal(root, [], true), true);
    assert.equal(await readFile(pathFor(root), 'utf8'), original);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('appending to an existing ledger preserves every historical seal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-desktop-ledger-append-'));
  try {
    const history = [{ version: '20261022-1', content_sha256: 'b'.repeat(64) },
      { version: '20261022-2', content_sha256: 'c'.repeat(64) }];
    await writeFile(pathFor(root), JSON.stringify({ schema_version: 1, releases: history }));
    assert.equal(await seal(root, []), true);
    assert.deepEqual(JSON.parse(await readFile(pathFor(root), 'utf8')).releases,
      [...history, { version: VERSION, content_sha256: DIGEST }]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('failed ledger replacement preserves history and removes the staged file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-desktop-ledger-write-'));
  try {
    const original = `{"schema_version":1,"releases":[{"version":"20261022-1","content_sha256":"${DIGEST}"}]}\n`;
    await writeFile(pathFor(root), original);
    const errors = [];
    const sealed = await sealVersionLedger({ root, version: VERSION, recordMissing: true, errors,
      candidateDigest: async () => {
        await rename(pathFor(root), join(root, 'history.json'));
        await mkdir(pathFor(root));
        return DIGEST;
      },
    });
    assert.equal(sealed, false);
    assert.match(errors.join(' '), /could not be written/u);
    assert.equal(await readFile(join(root, 'history.json'), 'utf8'), original);
    assert.deepEqual((await readdir(root)).sort(), ['RELEASE_VERSIONS.json', 'history.json']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('conflicting or duplicate historical seals cannot be replaced', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-desktop-ledger-conflict-'));
  try {
    const different = { schema_version: 1, releases: [{ version: VERSION, content_sha256: 'b'.repeat(64) }] };
    await writeFile(pathFor(root), JSON.stringify(different));
    assert.equal(await seal(root, []), false);
    assert.deepEqual(JSON.parse(await readFile(pathFor(root), 'utf8')), different);
    const duplicate = { schema_version: 1, releases: [different.releases[0], different.releases[0]] };
    await writeFile(pathFor(root), JSON.stringify(duplicate));
    assert.equal(await seal(root, []), false);
    assert.deepEqual(JSON.parse(await readFile(pathFor(root), 'utf8')), duplicate);
  } finally { await rm(root, { recursive: true, force: true }); }
});
