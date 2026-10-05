// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, stat, rm, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { installPrebuiltAnchor } from './installer-prebuilt-anchor.mjs';

const source = resolve('..', 'NotNativeDesktop');

async function fixture(t, { withAnchor = false } = {}) {
  const base = await mkdtemp(join(tmpdir(), 'nnd-prebuilt-anchor-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const sourceRoot = await mkdtemp(join(base, 'source-'));
  const data = join(base, 'data');
  await mkdir(data, { recursive: true });
  const descriptor = { product: 'NotNativeAgent', version: '20261004-1', node: process.execPath,
    install_root: sourceRoot, data_root: data, node_major: Number(process.versions.node.split('.')[0]) };
  await writeFile(join(sourceRoot, 'install.json'), JSON.stringify(descriptor));
  await mkdir(join(sourceRoot, 'installed', 'src'), { recursive: true });
  await writeFile(join(sourceRoot, 'installed', 'src', 'cli.js'), '');
  await writeFile(join(sourceRoot, 'installed', 'package.json'), JSON.stringify({ name: 'not-native-agent', nna_version: '20261004-1' }));
  await writeFile(join(sourceRoot, 'installed', 'VERSION'), '20261004-1\n');
  const anchor = join(base, 'anchor');
  if (withAnchor) {
    await mkdir(anchor, { recursive: true });
    await writeFile(join(anchor, 'keep.txt'), 'prior');
  }
  const installationId = 'nna_' + createHash('sha256').update(realpathSync(sourceRoot).toLowerCase()).digest('hex');
  const dataId = 'data_' + createHash('sha256').update(realpathSync(data).toLowerCase()).digest('hex');
  const input = {
    anchor, sourceRoot: resolve('.'), nnaRoot: sourceRoot, installationId, dataId, packageRoot: join(base, 'package'),
    version: '20261004-1', payloadSha256: 'a'.repeat(64), stageOperationId: '11111111-2222-4333-8444-555555555555',
    activationOperationId: '66666666-7777-4888-9999-aaaaaaaaaaaa', candidateSha256: 'b'.repeat(64),
  };
  return { base, sourceRoot, data, anchor, input };
}

test('fresh prebuilt anchor writes stable selection, launcher, and binding', async t => {
  const f = await fixture(t);
  const result = await installPrebuiltAnchor(f.input);
  assert.equal(result.anchor, f.anchor);
  const staging = (await readdir(f.base)).filter(entry => entry.includes('.staging'));
  assert.equal(staging.length, 0);
  const selection = JSON.parse(await readFile(join(f.anchor, 'nna-service-selection.json'), 'utf8'));
  assert.equal(selection.data_id, f.input.dataId);
  const binding = JSON.parse(await readFile(join(f.anchor, 'nnd-anchor.json'), 'utf8'));
  assert.equal(binding.payload_sha256, f.input.payloadSha256);
  assert.ok((await stat(join(f.anchor, 'scripts', 'launch-selected-desktop.ps1'))).isFile());
  assert.ok((await stat(join(f.anchor, 'packages', 'electron', 'native-service-client.mjs'))).isFile());
});

test('prebuilt anchor installation refuses and preserves an existing target', async t => {
  const f = await fixture(t, { withAnchor: true });
  await assert.rejects(() => installPrebuiltAnchor(f.input), /prebuilt_anchor_present/u);
  assert.equal(await readFile(join(f.anchor, 'keep.txt'), 'utf8'), 'prior');
  const entries = await readdir(f.base);
  assert.equal(entries.filter(entry => entry.includes('.staging')).length, 0);
});

test('failed staging cleanup leaves no partial anchor', async t => {
  const f = await fixture(t);
  await assert.rejects(() => installPrebuiltAnchor({ ...f.input, packageRoot: f.anchor }), /prebuilt_anchor_path_overlap/u);
  const entries = await readdir(f.base);
  assert.equal(entries.filter(entry => entry.includes('.staging')).length, 0);
});

test('upgrade rebinds only a marked anchor of the same installation identity', async t => {
  const f = await fixture(t);
  await installPrebuiltAnchor(f.input);
  // A foreign-identity anchor keeps the bar and stays byte-untouched.
  const bindingPath = join(f.anchor, 'nnd-anchor.json');
  const binding = JSON.parse(await readFile(bindingPath, 'utf8'));
  const foreign = { ...binding, installation_id: 'nna_' + '0'.repeat(64) };
  await writeFile(join(f.base, 'keep.exe'), 'user');
  await assert.rejects(() => installPrebuiltAnchor({ ...f.input,
    installationId: foreign.installation_id }), /prebuilt_anchor_present/u);
  assert.equal(JSON.parse(await readFile(bindingPath, 'utf8')).installation_id, f.input.installationId);
  // The same installation may replace its own anchor with the new package.
  await installPrebuiltAnchor({ ...f.input, version: '20261004-2', payloadSha256: 'c'.repeat(64) });
  const rebound = JSON.parse(await readFile(bindingPath, 'utf8'));
  assert.equal(rebound.version, '20261004-2');
  assert.ok((await stat(join(f.anchor, 'packages', 'electron', 'native-service-client.mjs'))).isFile());
  const leftovers = (await readdir(f.base)).filter(entry => entry.includes('.previous') || entry.includes('.staging'));
  assert.deepEqual(leftovers, []);
});
