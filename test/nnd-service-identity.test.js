// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readNndServiceIdentity } from '../src/nnd-service-identity.js';

async function fixture(t) {
  const temp = await mkdtemp(join(tmpdir(), 'nna-identity-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = join(temp, 'Custom install ü');
  const data = join(temp, 'Custom data ü');
  await mkdir(join(root, 'installed', 'src'), { recursive: true });
  await mkdir(data);
  const descriptor = { product: 'NotNativeAgent', version: '20261001-7', install_root: root,
    data_root: data, node: process.execPath, node_major: Number(process.versions.node.split('.')[0]) };
  await writeFile(join(root, 'installed', 'src', 'cli.js'), '// fixture');
  await writeFile(join(root, 'installed', 'package.json'), JSON.stringify({ name: 'not-native-agent', nna_version: descriptor.version }));
  await writeFile(join(root, 'installed', 'VERSION'), descriptor.version);
  const save = (value = descriptor) => writeFile(join(root, 'install.json'), JSON.stringify(value));
  await save();
  return { temp, root, data, descriptor, save };
}
test('selected custom install yields canonical immutable launch identity without writes or PATH fallback', async (t) => {
  const f = await fixture(t);
  const original = await readFile(join(f.root, 'install.json'), 'utf8');
  const value = await readNndServiceIdentity(f.root, { expectedDataRoot: f.data });
  assert.equal(value.node, await realpath(process.execPath));
  assert.equal(value.cli_path, await realpath(join(f.root, 'installed', 'src', 'cli.js')));
  assert.equal(value.runtime_version, process.versions.node);
  assert.equal(value.architecture, process.arch);
  assert.equal(Object.isFrozen(value), true);
  assert.match(value.installation_id, /^nna_[a-f0-9]{64}$/u);
  assert.match(value.data_id, /^data_[a-f0-9]{64}$/u);
  assert.equal(await readFile(join(f.root, 'install.json'), 'utf8'), original);
  if (process.platform === 'win32') assert.deepEqual(await readNndServiceIdentity(f.root.toUpperCase()), value);
});
test('missing and malformed selected descriptors fail closed', async (t) => {
  const f = await fixture(t);
  await assert.rejects(readNndServiceIdentity('relative'), { code: 'nnd_install_root_invalid' });
  await assert.rejects(readNndServiceIdentity(join(f.temp, 'missing')), { code: 'nnd_install_root_invalid' });
  await rm(join(f.root, 'install.json'));
  await assert.rejects(readNndServiceIdentity(f.root), { code: 'nnd_install_descriptor_unavailable' });
  for (const text of ['{', 'null', '[]', ' '.repeat(16 * 1024 + 1)]) {
    await writeFile(join(f.root, 'install.json'), text);
    await assert.rejects(readNndServiceIdentity(f.root), { code: 'nnd_install_descriptor_invalid' });
  }
});
test('invalid metadata, caller data mismatch and unsafe data location fail before executable probing', async (t) => {
  const f = await fixture(t);
  for (const patch of [{ product: 'Other' }, { version: '1.0.0' }, { node_major: 22 }, { node_major: '24' },
    { data_root: 'relative' }, { node: 'node.exe' }, { install_root: null }]) {
    await f.save({ ...f.descriptor, ...patch });
    await assert.rejects(readNndServiceIdentity(f.root), { code: 'nnd_install_descriptor_invalid' });
  }
  const missingNode = join(f.temp, 'missing-node.exe');
  await f.save({ ...f.descriptor, node: missingNode });
  await assert.rejects(readNndServiceIdentity(f.root, { expectedDataRoot: f.temp }), { code: 'nnd_install_data_mismatch' });
  await f.save({ ...f.descriptor, node: missingNode, data_root: f.root });
  await assert.rejects(readNndServiceIdentity(f.root), { code: 'nnd_install_data_invalid' });
  await f.save({ ...f.descriptor, node: missingNode, install_root: f.temp });
  await assert.rejects(readNndServiceIdentity(f.root), { code: 'nnd_install_root_mismatch' });
});
test('package versions and missing CLI are rejected before selected runtime is probed', async (t) => {
  const f = await fixture(t);
  await f.save({ ...f.descriptor, node: join(f.temp, 'missing-node.exe') });
  await writeFile(join(f.root, 'installed', 'VERSION'), '20261001-8');
  await assert.rejects(readNndServiceIdentity(f.root), { code: 'nnd_install_version_mismatch' });
  await writeFile(join(f.root, 'installed', 'VERSION'), f.descriptor.version);
  await writeFile(join(f.root, 'installed', 'package.json'), '{}');
  await assert.rejects(readNndServiceIdentity(f.root), { code: 'nnd_install_version_mismatch' });
  await rm(join(f.root, 'installed', 'src', 'cli.js'));
  await assert.rejects(readNndServiceIdentity(f.root), { code: 'nnd_install_payload_invalid' });
});
test('selected external Node is checked against actual runtime major and cannot run environment startup hooks', async (t) => {
  const f = await fixture(t);
  const original = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = '--require=nonexistent-nnd-identity-hook';
  try { assert.equal((await readNndServiceIdentity(f.root)).runtime_version, process.versions.node); }
  finally { if (original === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = original; }
  await f.save({ ...f.descriptor, node_major: f.descriptor.node_major + 1 });
  await assert.rejects(readNndServiceIdentity(f.root), { code: 'nnd_install_runtime_invalid' });
  await f.save({ ...f.descriptor, node: join(f.root, 'installed', 'src', 'cli.js') });
  await assert.rejects(readNndServiceIdentity(f.root), { code: 'nnd_install_runtime_invalid' });
  await f.save({ ...f.descriptor, node: join(f.temp, 'node.exe') });
  await assert.rejects(readNndServiceIdentity(f.root), { code: 'nnd_install_runtime_unavailable' });
  if (process.platform === 'win32') {
    await writeFile(join(f.temp, 'node.exe'), 'invalid executable');
    await assert.rejects(readNndServiceIdentity(f.root), { code: 'nnd_install_runtime_unavailable' });
  }
});
test('junction aliases share identity; relocated installs retain data identity and escaping payloads fail', async (t) => {
  const f = await fixture(t);
  const baseline = await readNndServiceIdentity(f.root);
  const alias = join(f.temp, 'alias');
  await symlink(f.root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.deepEqual(await readNndServiceIdentity(alias), baseline);
  const next = join(f.temp, 'relocated');
  await rename(f.root, next);
  await writeFile(join(next, 'install.json'), JSON.stringify({ ...f.descriptor, install_root: next }));
  const relocated = await readNndServiceIdentity(next);
  assert.notEqual(relocated.installation_id, baseline.installation_id);
  assert.equal(relocated.data_id, baseline.data_id);
  const escaped = join(f.temp, 'outside');
  await rename(join(next, 'installed'), escaped);
  await symlink(escaped, join(next, 'installed'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(readNndServiceIdentity(next), { code: 'nnd_install_payload_invalid' });
});
