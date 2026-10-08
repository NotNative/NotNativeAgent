// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNndWorkspaceAdmissionService } from '../src/nnd-workspace-admission.js';
import { readNndSetupConfiguration } from '../src/nnd-setup-config.js';

const identity = { installation_id: 'nna_admission_test', data_id: 'data_admission_test' };
const principal = { subjectId: 'operator', permissions: ['nnd.workspace.read', 'nnd.workspace.manage'] };
const provider = { id: 'local', endpoint: 'http://127.0.0.1:9/v1', model: 'base', trust_zone: 'loopback' };

async function fixture(t) {
  const root = await mkdtemp(join(process.platform === 'win32' ? homedir() : tmpdir(), '.nna-admissions-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = join(root, 'config'), primary = join(root, 'primary');
  const alpha = join(root, 'alpha'), beta = join(root, 'beta');
  await Promise.all([mkdir(config), mkdir(primary), mkdir(alpha), mkdir(beta)]);
  await writeFile(join(config, 'manifest.json'), JSON.stringify({ workspace_root: primary, provider, persistence: 'ephemeral' }));
  const paths = { config };
  const create = () => createNndWorkspaceAdmissionService({ paths, installationId: identity.installation_id, dataId: identity.data_id });
  return { root, primary, alpha, beta, config, create, service: create() };
}

const input = (revision, root, operationId = 'admission_1') => ({ ...identity, expected_revision: revision,
  operation_id: operationId, root });

test('a redundant grant over an admitted root reads, but its revoke names the grant surface', async t => {
  const f = await fixture(t);
  await f.service.admit(principal, input('absent', f.alpha));
  const revision = (await f.service.inventory(principal)).revision;
  const physical = await lstat(f.alpha, { bigint: true });
  const physicalPrimary = await lstat(f.primary, { bigint: true });
  const primaryRow = { root: f.primary, id: sha24Verbatim(f.primary),
    device: String(physicalPrimary.dev), inode: String(physicalPrimary.ino) };
  await writeFile(join(f.config, 'nnd-workspace-grants.json'), JSON.stringify({
    protocol: '1.0', installation_id: identity.installation_id, data_id: identity.data_id,
    primary: primaryRow,
    secondary: { root: f.alpha, id: sha24(f.alpha), device: String(physical.dev), inode: String(physical.ino) } }));
  // Redundancy, not corruption: the inventory presents BOTH projections…
  const inventory = await f.service.inventory(principal);
  assert.equal(inventory.secondary_grant.id, sha24(f.alpha));
  assert.equal(inventory.admitted.length, 1);
  // A root the GRANT anchors (and admission does not) is refused with the same
  // single-root conflict, naming the grant surface as the anchoring authority.
  const physicalBeta = await lstat(f.beta, { bigint: true });
  await writeFile(join(f.config, 'nnd-workspace-grants.json'), JSON.stringify({
    protocol: '1.0', installation_id: identity.installation_id, data_id: identity.data_id,
    primary: primaryRow,
    secondary: { root: f.beta, id: sha24(f.beta), device: String(physicalBeta.dev), inode: String(physicalBeta.ino) } }));
  await assert.rejects(f.service.admit(principal, { ...input(inventory.revision, f.beta, 'admit_beta') }),
    { code: 'nnd_workspace_admission_root_conflict' });
  await writeFile(join(f.config, 'nnd-workspace-grants.json'), JSON.stringify({
    protocol: '1.0', installation_id: identity.installation_id, data_id: identity.data_id,
    primary: primaryRow,
    secondary: { root: f.alpha, id: sha24(f.alpha), device: String(physical.dev), inode: String(physical.ino) } }));
  // …but the admission row's revoke refuses and redirects the operator.
  await assert.rejects(f.service.revoke(principal, { ...input(revision, f.alpha, 'revoke_1') }),
    { code: 'nnd_workspace_admission_secondary_clear' });
  await rm(join(f.config, 'nnd-workspace-grants.json'), { force: true });
  const cleared = await f.service.revoke(principal, { ...input(revision, f.alpha, 'revoke_1') });
  assert.equal(cleared.persistence, 'saved');
  const replay = await f.create().revoke(principal, { ...input(revision, f.alpha, 'revoke_1') });
  assert.equal(replay.replayed, true);
  assert.equal(replay.revoked_root, f.alpha);
});

function sha24(value) {
  return `ws_${createHash('sha256').update(process.platform === 'win32' ? value.toLowerCase() : value).digest('hex').slice(0, 24)}`;
}

function sha24Verbatim(value) {
  return `ws_${createHash('sha256').update(value).digest('hex').slice(0, 24)}`;
}

test('the attached root is never proxied; inventory shape and permissions', async t => {
  const f = await fixture(t);
  const inventory = await f.service.inventory(principal);
  assert.equal(inventory.selection_enabled, true);
  assert.equal(inventory.attached.root, await realpath(f.primary));
  assert.equal(inventory.attached.id, sha24Verbatim((await readNndSetupConfiguration({ config: f.config })).workspaceRoot));
  assert.deepEqual(inventory.admitted, []);
  assert.ok(!('secondary_grant' in inventory));
  assert.equal(inventory.revision, 'absent');
  await assert.rejects(f.service.admit(principal, input('absent', f.primary, 'admit_attached')),
    { code: 'nnd_workspace_admission_root_conflict' });
  const after = await f.service.inventory(principal);
  assert.deepEqual(after.admitted, []);
  await assert.rejects(f.service.inventory({ ...principal, permissions: [] }),
    { code: 'integration_permission_denied' });
  await assert.rejects(f.service.admit({ ...principal, permissions: ['nnd.workspace.read'] },
    input('absent', f.alpha, 'readonly')), { code: 'integration_permission_denied' });
});

test('admit is durable, replayable, id-unique and projectable from a fresh instance', async t => {
  const f = await fixture(t);
  const first = await f.service.admit(principal, input('absent', f.alpha));
  assert.equal(first.persistence, 'saved');
  assert.equal(first.application, 'not_applied');
  const inventory = await f.create().inventory(principal);
  assert.equal(inventory.admitted.length, 1);
  const row = inventory.admitted[0];
  assert.equal(row.root, f.alpha);
  assert.equal(row.id, sha24(f.alpha));
  assert.match(row.admitted_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(row.operation_id, 'admission_1');
  const replay = await f.create().admit(principal, input('absent', f.alpha));
  assert.equal(replay.replayed, true);
  assert.equal((await f.service.inventory(principal)).admitted.length, 1);
  assert.equal((await f.create().operation(principal, 'admission_1')).persisted_revision, first.persisted_revision);
  assert.equal(await f.create().operation({ ...principal, subjectId: 'other' }, 'admission_1'), null);
});

test('admit refuses repeats, stale revisions, malformed and relative paths', async t => {
  const f = await fixture(t);
  await f.service.admit(principal, input('absent', f.alpha));
  const revision = (await f.service.inventory(principal)).revision;
  await assert.rejects(f.service.admit(principal, input(revision, f.alpha, 'repeat')),
    { code: 'nnd_workspace_admission_root_conflict' });
  await assert.rejects(f.service.admit(principal, input('absent', f.beta, 'stale')),
    { code: 'manifest_revision_conflict' });
  await assert.rejects(f.service.admit(principal, { ...identity, expected_revision: revision, operation_id: 'missing_root' }),
    { code: 'nnd_workspace_admission_invalid' });
  await assert.rejects(f.service.admit(principal, input(revision, 'alpha-relative', 'relative')),
    { code: 'nnd_workspace_admission_invalid' });
  await assert.rejects(f.service.admit(principal, { ...input(revision, f.beta, 'extra'), extra: 1 }),
    { code: 'nnd_workspace_admission_invalid' });
});

test('a drifted stored root or a poisoned grant document fails closed on read', async t => {
  const f = await fixture(t);
  await f.service.admit(principal, input('absent', f.alpha));
  const admissionsPath = join(f.config, 'nnd-workspace-admissions.json');
  const original = await readFile(admissionsPath, 'utf8');
  const store = JSON.parse(original);
  store.admitted[0].root = store.admitted[0].root.replace(/alpha$/u, 'alpha-x');
  await writeFile(admissionsPath, JSON.stringify(store));
  await assert.rejects(f.service.inventory(principal), { code: 'nnd_workspace_admission_identity_mismatch' });
  await writeFile(admissionsPath, original);
  const revision = (await f.service.inventory(principal)).revision;
  await f.service.admit(principal, input(revision, f.beta, 'admission_2'));
  const grantsPath = join(f.config, 'nnd-workspace-grants.json');
  const physicalPrimary = await lstat(f.primary, { bigint: true });
  const grant = {
    protocol: '1.0', installation_id: identity.installation_id, data_id: identity.data_id,
    primary: { root: f.primary, id: sha24Verbatim(f.primary),
      device: String(physicalPrimary.dev), inode: String(physicalPrimary.ino) },
    secondary: { root: join(f.root, 'gone'), id: 'ws_' + 'a'.repeat(24), device: '1', inode: '2' } };
  await writeFile(grantsPath, JSON.stringify(grant));
  // The grant file now fails its own canonical verification through the shared
  // kernel; the admission surface must surface THAT failure, never an empty or
  // partial inventory.
  await assert.rejects(f.service.inventory(principal), { code: 'nnd_workspace_grant_invalid' });
  await writeFile(grantsPath, JSON.stringify({ ...grant, protocol: '2.0', secondary: null }));
  await assert.rejects(f.service.inventory(principal), { code: 'nnd_workspace_grant_invalid' });
  await writeFile(grantsPath, JSON.stringify({ ...grant, secondary: null,
    primary: { ...grant.primary, inode: '0' } }));
  await assert.rejects(f.service.inventory(principal), { code: 'nnd_workspace_grant_identity_mismatch' });
  await rm(grantsPath, { force: true });
  const inventory = await f.service.inventory(principal);
  assert.equal(inventory.admitted.length, 2);
});
