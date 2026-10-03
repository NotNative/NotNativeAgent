// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNndWorkspaceGrantService, grantFileIdentity } from '../src/nnd-workspace-grants.js';
import { nativeNndPrincipal } from '../src/nnd-service-native.js';
import { readNndSetupConfiguration } from '../src/nnd-setup-config.js';

const identity = { installation_id: 'nna_grant_test', data_id: 'data_grant_test' };
const principal = { subjectId: 'operator', permissions: ['nnd.workspace.read', 'nnd.workspace.manage'] };
const provider = { id: 'local', endpoint: 'http://127.0.0.1:9/v1', model: 'base', trust_zone: 'loopback' };
async function fixture(t) {
  const root = await mkdtemp(join(process.platform === 'win32' ? homedir() : tmpdir(), '.nna-workspaces-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = join(root, 'config'), primary = join(root, 'primary'), secondary = join(root, 'secondary');
  await Promise.all([mkdir(config), mkdir(primary), mkdir(secondary)]);
  await writeFile(join(config, 'manifest.json'), JSON.stringify({ workspace_root: primary, provider, persistence: 'ephemeral' }));
  const paths = { config };
  const create = () => createNndWorkspaceGrantService({ paths, installationId: identity.installation_id, dataId: identity.data_id });
  return { root, primary, secondary, config, create, service: create() };
}
const change = (revision, secondary, operationId = 'grant_1') => ({ ...identity,
  expected_revision: revision, operation_id: operationId, secondary_root: secondary });

test('grant file identity retains high device and inode bits exactly', async t => {
  const high = 9_007_199_254_740_993n;
  assert.deepEqual(grantFileIdentity({ dev: high + 2n, ino: high }),
    { device: '9007199254740995', inode: '9007199254740993' });
  assert.throws(() => grantFileIdentity({ dev: Number(high + 2n), ino: Number(high) }),
    { code: 'nnd_workspace_grant_invalid' });
  const f = await fixture(t);
  const primary = (await f.service.read(principal)).primary;
  const physical = await lstat(primary.root, { bigint: true });
  assert.deepEqual({ device: primary.device, inode: primary.inode }, grantFileIdentity(physical));
});

test('primary is synthesized; secondary save is durable, bounded, replayable and not applied', async t => {
  const f = await fixture(t), before = await f.service.read(principal);
  assert.equal(before.revision, 'absent'); assert.equal(before.secondary, null);
  assert.equal(before.selection_enabled, false);
  assert.equal(before.primary.id, nativeNndPrincipal((await readNndSetupConfiguration({ config: f.config })).workspaceRoot).workspaceIds[0]);
  const input = change(before.revision, f.secondary), saved = await f.service.save(principal, input);
  assert.equal(saved.persistence, 'saved'); assert.equal(saved.application, 'not_applied');
  const read = await f.create().read(principal);
  assert.equal(read.secondary.root, f.secondary); assert.match(read.secondary.id, /^ws_[a-f0-9]{24}$/u);
  assert.notEqual(read.primary.id, read.secondary.id);
  assert.equal((await f.create().save(principal, input)).replayed, true);
  assert.equal((await f.create().operation(principal, 'grant_1')).persisted_revision, saved.persisted_revision);
  assert.equal(await f.create().operation({ ...principal, subjectId: 'other' }, 'grant_1'), null);
  await assert.rejects(f.service.save(principal, change('absent', null, 'stale')), { code: 'manifest_revision_conflict' });
  const removed = await f.service.save(principal, change(read.revision, null, 'remove'));
  assert.equal(removed.persistence, 'saved'); assert.equal((await f.service.read(principal)).secondary, null);
});

test('read and mutation require their distinct native permissions', async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.read({ ...principal, permissions: [] }), { code: 'integration_permission_denied' });
  await assert.rejects(f.service.save({ ...principal, permissions: ['nnd.workspace.read'] }, change('absent', f.secondary)),
    { code: 'integration_permission_denied' });
  assert.equal((await f.service.read({ ...principal, permissions: ['nnd.workspace.read'] })).revision, 'absent');
});

test('maximum-length operation IDs retain a durable scoped receipt', async t => {
  const f = await fixture(t), id = 'x'.repeat(128);
  const saved = await f.service.save(principal, change('absent', f.secondary, id));
  assert.equal(saved.operation_id, id);
  assert.equal(saved.persistence, 'saved');
  assert.equal((await f.create().operation(principal, id)).persisted_revision, saved.persisted_revision);
  assert.equal((await f.create().save(principal, change('absent', f.secondary, id))).replayed, true);
});

test('junction aliases, duplicate roots and replaced grant directories fail closed', async t => {
  const f = await fixture(t), alias = join(f.root, 'alias');
  await symlink(f.secondary, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.service.save(principal, change('absent', alias)), { code: 'nnd_workspace_grant_invalid' });
  await assert.rejects(f.service.save(principal, change('absent', f.primary)), { code: 'nnd_workspace_grant_invalid' });
  await f.service.save(principal, change('absent', f.secondary));
  await rename(f.secondary, join(f.root, 'moved'));
  await assert.rejects(f.service.read(principal), { code: 'nnd_workspace_grant_invalid' });
  await mkdir(f.secondary);
  await assert.rejects(f.service.read(principal), { code: 'nnd_workspace_grant_identity_mismatch' });
});

test('poisoned document or changed primary manifest cannot authorize a grant', async t => {
  const f = await fixture(t);
  await f.service.save(principal, change('absent', f.secondary));
  const path = join(f.config, 'nnd-workspace-grants.json');
  const document = JSON.parse(await readFile(path, 'utf8'));
  await writeFile(path, JSON.stringify({ ...document, secondary: { ...document.secondary, id: document.primary.id } }));
  await assert.rejects(f.service.read(principal), { code: 'nnd_workspace_grant_identity_mismatch' });
  await writeFile(path, JSON.stringify(document));
  await writeFile(join(f.config, 'manifest.json'), JSON.stringify({ workspace_root: f.secondary, provider, persistence: 'ephemeral' }));
  await assert.rejects(f.service.read(principal), { code: 'nnd_workspace_grant_identity_mismatch' });
});

test('Windows mixed-case primary ID matches the existing native principal and old canonical ID fails closed',
  { skip: process.platform !== 'win32' }, async t => {
    const f = await fixture(t);
    const mixedCase = f.primary.replace(/primary$/u, 'PrImArY');
    assert.notEqual(mixedCase, f.primary);
    await writeFile(join(f.config, 'manifest.json'), JSON.stringify({ workspace_root: mixedCase, provider, persistence: 'ephemeral' }));
    const configured = (await readNndSetupConfiguration({ config: f.config })).workspaceRoot;
    const expectedId = nativeNndPrincipal(configured).workspaceIds[0];
    const primary = (await f.service.read(principal)).primary;
    assert.equal(primary.root, await realpath(f.primary));
    assert.equal(primary.id, expectedId);
    const oldCanonicalId = `ws_${createHash('sha256').update(primary.root.toLowerCase()).digest('hex').slice(0, 24)}`;
    assert.notEqual(primary.id, oldCanonicalId);
    await f.service.save(principal, change('absent', f.secondary));
    const path = join(f.config, 'nnd-workspace-grants.json');
    const document = JSON.parse(await readFile(path, 'utf8'));
    await writeFile(path, JSON.stringify({ ...document, primary: { ...document.primary, id: oldCanonicalId } }));
    await assert.rejects(f.service.read(principal), { code: 'nnd_workspace_grant_identity_mismatch' });
  });
