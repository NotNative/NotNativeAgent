// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNndConfigurationService } from '../src/nnd-configuration-service.js';
import { normalizeNndConfigurationOperations } from '../src/nnd-configuration-intents.js';
import { projectNndConfigurationView } from '../src/nnd-configuration-view.js';

const identity = { installation_id: 'installation_test', data_id: 'data_test', scope: 'user' };
const principal = { subjectId: 'native-local-operator', permissions: ['nnd.configuration.read', 'nnd.configuration.manage', 'nnd.configuration.repair'] };
const provider = { id: 'local', endpoint: 'http://127.0.0.1:9/v1', model: 'base', trust_zone: 'loopback' };
async function fixture(t, present = true) {
  const root = await mkdtemp(join(process.platform === 'win32' ? homedir() : tmpdir(), '.nna-config-service-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = { config: join(root, 'config'), trustedWorkspaces: join(root, 'trust.json') };
  await mkdir(paths.config); await mkdir(join(root, '.nna'));
  const path = join(paths.config, 'manifest.json'), manifest = { provider, workspace_root: root, persistence: 'ephemeral',
    extension_private: { token: 'DO_NOT_DISCLOSE_UNKNOWN_SECRET' } };
  if (present) await writeFile(path, JSON.stringify(manifest) + '\n');
  const create = () => createNndConfigurationService({ paths, installationId: identity.installation_id, dataId: identity.data_id });
  const service = create();
  const request = async (operations, operationId = 'save1') => {
    const snapshot = await service.read(principal);
    return { ...identity, expected_revision: snapshot.sourceRevision, expected_resolution_revision: snapshot.resolutionRevision,
      operation_id: operationId, operations };
  };
  return { root, paths, path, manifest, service, create, request };
}

test('typed intents reject grants, workspace, credentials, collections, duplicate fields and unsupported types', () => {
  for (const field of ['workspace_root', 'allowed_capabilities', 'permission_mode', 'provider.model', 'provider.credential.name', 'providers[0].model', '__proto__.enabled']) {
    assert.throws(() => normalizeNndConfigurationOperations([{ op: 'set', field, value: 'bad' }]), { code: 'nnd_configuration_request_invalid' });
  }
  for (const operations of [[{ op: 'reset', field: 'memory.enabled', value: false }],
    [{ op: 'set', field: 'memory.enabled', value: 'false' }], [{ op: 'set', field: 'provider_timeout_ms', value: '3000' }],
    [{ op: 'reset', field: 'memory.enabled' }, { op: 'reset', field: 'memory.enabled' }],
    Array.from({ length: 33 }, () => ({ op: 'reset', field: 'memory.enabled' }))]) {
    assert.throws(() => normalizeNndConfigurationOperations(operations), { code: 'nnd_configuration_request_invalid' });
  }
});

test('read projection omits unknown values and preview writes nothing', async (t) => {
  const f = await fixture(t), before = await readFile(f.path), snapshot = await f.service.read(principal);
  assert.ok(!JSON.stringify(projectNndConfigurationView(snapshot)).includes('DO_NOT_DISCLOSE_UNKNOWN_SECRET'));
  const input = await f.request([{ op: 'set', field: 'provider_timeout_ms', value: 0 }]); delete input.operation_id;
  const result = await f.service.preview(principal, input);
  assert.equal(result.snapshot.config.limits.providerMs, null);
  assert.equal(result.application, 'not_applied');
  assert.deepEqual(await readFile(f.path), before);
  assert.deepEqual(await readdir(f.paths.config), ['manifest.json']);
});

test('save preserves unknown raw fields privately, reports unapplied and replays across restart', async (t) => {
  const f = await fixture(t), input = await f.request([{ op: 'set', field: 'provider_timeout_ms', value: 0 }]);
  const saved = await f.service.save(principal, input);
  assert.equal(saved.persistence, 'saved'); assert.equal(saved.application, 'not_applied');
  assert.equal(saved.next_action, 'activate_setup_or_restart_native_service');
  assert.ok(!JSON.stringify(saved).includes('DO_NOT_DISCLOSE_UNKNOWN_SECRET'));
  const document = JSON.parse(await readFile(f.path, 'utf8'));
  assert.deepEqual(document, { ...f.manifest, provider_timeout_ms: 0 });
  const replay = await f.create().save(principal, input);
  assert.equal(replay.replayed, true); assert.equal(replay.persisted_revision, saved.persisted_revision);
  await assert.rejects(f.service.save(principal, { ...input, operations: [{ op: 'set', field: 'provider_timeout_ms', value: 3000 }] }), { code: 'manifest_operation_conflict' });
  assert.equal((await f.service.operation(principal, 'save1')).persisted_revision, saved.persisted_revision);
  assert.equal(await f.service.operation({ ...principal, subjectId: 'other-operator' }, 'save1'), null);
});

test('stale source and overlay revisions conflict and reset removes only selected raw override', async (t) => {
  const f = await fixture(t);
  await writeFile(f.path, JSON.stringify({ ...f.manifest, provider_timeout_ms: 3000 }));
  const reset = await f.request([{ op: 'reset', field: 'provider_timeout_ms' }], 'reset');
  await f.service.save(principal, reset);
  assert.deepEqual(JSON.parse(await readFile(f.path, 'utf8')), f.manifest);
  const stale = await f.request([{ op: 'set', field: 'memory.enabled', value: false }], 'stale');
  await writeFile(f.path, JSON.stringify({ ...f.manifest, provider_timeout_ms: 4000 }));
  await assert.rejects(f.service.save(principal, stale), { code: 'manifest_revision_conflict' });
  const overlay = await f.request([{ op: 'set', field: 'memory.enabled', value: false }], 'overlay');
  await writeFile(f.paths.trustedWorkspaces, JSON.stringify({ version: 1, workspaces: [{ root: await realpath(f.root), trustedAt: '2026-10-02T00:00:00.000Z' }] }));
  await writeFile(join(f.root, '.nna', 'settings.json'), JSON.stringify({ provider_timeout_ms: 5000 }));
  await assert.rejects(f.service.save(principal, overlay), { code: 'nnd_configuration_resolution_conflict' });
  const shadowed = await f.request([{ op: 'set', field: 'provider_timeout_ms', value: 6000 }], 'shadow');
  await assert.rejects(f.service.save(principal, shadowed), { code: 'configuration_source_shadowed' });
  assert.equal(JSON.parse(await readFile(f.path, 'utf8')).provider_timeout_ms, 4000);
});

test('validation and permission failures preserve selected bytes', async (t) => {
  const f = await fixture(t), bytes = await readFile(f.path);
  const bad = await f.request([{ op: 'set', field: 'provider_concurrency', value: 17 }]);
  await assert.rejects(f.service.save(principal, bad), { code: 'invalid_limit' });
  await assert.rejects(f.service.read({ ...principal, permissions: [] }), { code: 'integration_permission_denied' });
  await assert.rejects(f.service.save({ ...principal, permissions: ['nnd.configuration.read'] }, bad), { code: 'integration_permission_denied' });
  await assert.rejects(f.service.save(principal, { ...bad, installation_id: 'other' }), { code: 'nnd_configuration_request_invalid' });
  assert.deepEqual(await readFile(f.path), bytes);
});

test('missing and malformed setup is repaired explicitly with exact revision and private original backup', async (t) => {
  const f = await fixture(t, false);
  const missing = await f.service.read(principal);
  assert.equal(missing.sourceState, 'missing'); assert.equal(missing.sourceRevision, 'absent');
  const document = { workspace_root: f.root, provider, memory: { enabled: false } };
  const input = { ...identity, expected_revision: 'absent', operation_id: 'repair_missing', document };
  assert.equal((await f.service.repair(principal, input)).persistence, 'saved');
  assert.equal((await f.create().repair(principal, input)).replayed, true);
  await assert.rejects(f.service.repair(principal, { ...input, expected_revision: (await f.service.read(principal)).sourceRevision, operation_id: 'replace_valid' }), { code: 'nnd_configuration_repair_unnecessary' });
  const malformed = '{bad source secret stays private'; await writeFile(f.path, malformed);
  const invalid = await f.service.read(principal);
  assert.equal(invalid.sourceState, 'invalid');
  assert.ok(!JSON.stringify(invalid).includes('secret stays private'));
  await f.service.repair(principal, { ...input, expected_revision: invalid.sourceRevision, operation_id: 'repair_invalid' });
  const storage = (await readdir(f.paths.config)).find((name) => name.startsWith('.nna-manifest-'));
  const backups = (await readdir(join(f.paths.config, storage))).filter((name) => name.startsWith('backup-'));
  assert.ok((await Promise.all(backups.map((name) => readFile(join(f.paths.config, storage, name), 'utf8')))).includes(malformed));
});

test('repair rejects unknown/credential/authority documents and trusted project authority before publication', async (t) => {
  const f = await fixture(t, false);
  const input = { ...identity, expected_revision: 'absent', operation_id: 'repair', document: { workspace_root: f.root, provider } };
  for (const document of [{ ...input.document, unknown: {} }, { ...input.document, allowed_capabilities: ['tools'] },
    { ...input.document, provider: { ...provider, credential: { source: 'secret', secret_id: 'sec_x', field: 'api_key' } } }]) {
    await assert.rejects(f.service.repair(principal, { ...input, document }), { code: 'nnd_configuration_request_invalid' });
  }
  await writeFile(f.paths.trustedWorkspaces, JSON.stringify({ version: 1, workspaces: [{ root: await realpath(f.root), trustedAt: '2026-10-02T00:00:00.000Z' }] }));
  await writeFile(join(f.root, '.nna', 'settings.json'), JSON.stringify({ allowed_capabilities: ['tools'] }));
  await assert.rejects(f.service.repair(principal, input), { code: 'execution_manifest_forbidden' });
  await assert.rejects(readFile(f.path), { code: 'ENOENT' });
});

test('repair uses the same explicit project workspace scope as subsequent setup reads', async t => {
  const f = await fixture(t, false), previousCwd = process.cwd();
  await writeFile(f.paths.trustedWorkspaces, JSON.stringify({ version: 1,
    workspaces: [{ root: await realpath(f.root), trustedAt: '2026-10-02T00:00:00.000Z' }] }));
  const input = { ...identity, expected_revision: 'absent', operation_id: 'repair_scope', document: { workspace_root: f.root, provider } };
  try {
    process.chdir(f.root);
    for (const workspace_root of [null, '.', '']) {
      await writeFile(join(f.root, '.nna', 'settings.json'), JSON.stringify({ workspace_root }));
      await assert.rejects(f.service.repair(principal, input), { code: 'project_scope_mismatch' });
      await assert.rejects(readFile(f.path), { code: 'ENOENT' });
    }
    const equivalent = process.platform === 'win32' ? f.root.toUpperCase() : f.root;
    await writeFile(join(f.root, '.nna', 'settings.json'), JSON.stringify({ workspace_root: equivalent }));
    assert.equal((await f.service.repair(principal, input)).persistence, 'saved');
    assert.equal((await f.service.read(principal)).sourceState, 'present');
  } finally { process.chdir(previousCwd); }
});

test('repair accepts a source whose absolute workspace fails native explicit scope validation', async t => {
  const f = await fixture(t);
  await writeFile(f.path, JSON.stringify({ ...f.manifest, workspace_root: f.root + '\u0000' }));
  const broken = await f.service.read(principal);
  assert.equal(broken.sourceState, 'invalid');
  const result = await f.service.repair(principal, { ...identity, expected_revision: broken.sourceRevision,
    operation_id: 'repair_invalid_root', document: { workspace_root: f.root, provider } });
  assert.equal(result.persistence, 'saved');
  assert.equal((await f.service.read(principal)).sourceState, 'present');
});
