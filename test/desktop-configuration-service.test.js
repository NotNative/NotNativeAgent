// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import { createScratchSync } from './scratch.js';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDesktopConfigurationService } from '../src/desktop-configuration-service.js';
import { normalizeDesktopConfigurationOperations, applyDesktopConfigurationOperations,
  desktopConfigurationOperationPaths } from '../src/desktop-configuration-intents.js';
import { projectDesktopConfigurationView } from '../src/desktop-configuration-view.js';
import { manifestFromConfig, withRouteDeadline } from '../src/provider/route-configuration.js';
import { resolveManifest } from '../src/config.js';
import { providerTimeouts } from '../src/config-bounds.js';

const identity = { installation_id: 'installation_test', data_id: 'data_test', scope: 'user' };
const principal = { subjectId: 'native-local-operator', permissions: ['desktop.configuration.read', 'desktop.configuration.manage', 'desktop.configuration.repair'] };
const provider = { id: 'local', endpoint: 'http://127.0.0.1:9/v1', model: 'base', trust_zone: 'loopback' };
async function fixture(t, present = true) {
  const root = createScratchSync('.nna-config-service-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = { config: join(root, 'config'), trustedWorkspaces: join(root, 'trust.json') };
  await mkdir(paths.config); await mkdir(join(root, '.nna'));
  const path = join(paths.config, 'manifest.json'), manifest = { provider, workspace_root: root, persistence: 'ephemeral',
    extension_private: { token: 'DO_NOT_DISCLOSE_UNKNOWN_SECRET' } };
  if (present) await writeFile(path, JSON.stringify(manifest) + '\n');
  const create = () => createDesktopConfigurationService({ paths, installationId: identity.installation_id, dataId: identity.data_id });
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
    assert.throws(() => normalizeDesktopConfigurationOperations([{ op: 'set', field, value: 'bad' }]), { code: 'desktop_configuration_request_invalid' });
  }
  for (const operations of [[{ op: 'reset', field: 'memory.enabled', value: false }],
    [{ op: 'set', field: 'memory.enabled', value: 'false' }], [{ op: 'set', field: 'provider_timeout_ms', value: '3000' }],
    [{ op: 'reset', field: 'memory.enabled' }, { op: 'reset', field: 'memory.enabled' }],
    [{ op: 'set', field: 'memory.enabled', value: false }, { op: 'set', field: 'memory.required', value: true }],
    Array.from({ length: 33 }, () => ({ op: 'reset', field: 'memory.enabled' }))]) {
    assert.throws(() => normalizeDesktopConfigurationOperations(operations), { code: 'desktop_configuration_request_invalid' });
  }
});

test('paired reviewer binding previews and saves with native CAS without losing private source fields', async t => {
  const f = await fixture(t);
  const second = { id: 'second', endpoint: 'http://127.0.0.1:10/v1', model: 'other', trust_zone: 'loopback' };
  await writeFile(f.path, JSON.stringify({ ...f.manifest, provider: undefined,
    providers: [provider, second], routes: { reviewer: { temperature: 0.4 } } }));
  const op = { op: 'bind_route', role: 'reviewer', provider_id: 'second', model: 'review-model' };
  const input = await f.request([op], 'bind_reviewer');
  const original = await readFile(f.path);
  const { operation_id: unused, ...previewInput } = input;
  const preview = await f.service.preview(principal, previewInput);
  assert.equal(preview.snapshot.config.routes.reviewer.providerId, 'second');
  assert.equal(preview.snapshot.config.routes.reviewer.model, 'review-model');
  assert.deepEqual(await readFile(f.path), original);
  const saved = await f.service.save(principal, input);
  assert.equal(saved.persistence, 'saved'); assert.equal(saved.application, 'not_applied');
  const document = JSON.parse(await readFile(f.path, 'utf8'));
  assert.deepEqual(document.routes.reviewer, { temperature: 0.4, provider_id: 'second', model: 'review-model' });
  assert.equal(document.extension_private.token, 'DO_NOT_DISCLOSE_UNKNOWN_SECRET');
  assert.equal((await f.create().save(principal, input)).replayed, true);
  await assert.rejects(f.service.save(principal, { ...input, operation_id: 'stale_bind' }), { code: 'manifest_revision_conflict' });
});

test('route binding rejects unowned providers, project shadow, malformed pair and missing manage permission', async t => {
  const f = await fixture(t), original = await readFile(f.path);
  const valid = { op: 'bind_route', role: 'vision', provider_id: 'local', model: 'vision-model' };
  for (const operation of [{ ...valid, role: 'primary' }, { ...valid, model: '' },
    { ...valid, provider_id: '__proto__' }, { ...valid, extra: true }]) {
    assert.throws(() => normalizeDesktopConfigurationOperations([operation]), { code: 'desktop_configuration_request_invalid' });
  }
  const missing = await f.request([{ ...valid, provider_id: 'absent' }], 'missing_provider');
  const { operation_id: unused, ...missingPreview } = missing;
  await assert.rejects(f.service.preview(principal, missingPreview), { code: 'route_profile_missing' });
  await assert.rejects(f.service.save(principal, missing), { code: 'route_profile_missing' });
  const request = await f.request([valid], 'vision_bind');
  await assert.rejects(f.service.save({ ...principal, permissions: ['desktop.configuration.read'] }, request),
    { code: 'integration_permission_denied' });
  await writeFile(f.paths.trustedWorkspaces, JSON.stringify({ version: 1,
    workspaces: [{ root: await realpath(f.root), trustedAt: '2026-10-03T00:00:00.000Z' }] }));
  await writeFile(join(f.root, '.nna', 'settings.json'), JSON.stringify({ routes: { vision: { model: 'project-model' } } }));
  const shadowed = await f.request([valid], 'shadowed_bind');
  await assert.rejects(f.service.save(principal, shadowed), { code: 'configuration_source_shadowed' });
  assert.deepEqual(await readFile(f.path), original);
});

test('native memory edits preserve TUI coupling and reject project shadow of the companion field', async t => {
  const f = await fixture(t);
  await writeFile(f.path, JSON.stringify({ ...f.manifest, memory: { enabled: true, required: true, max_items: 7 } }));
  const off = await f.request([{ op: 'set', field: 'memory.enabled', value: false }], 'memory_off');
  const { operation_id: unused, ...offPreview } = off;
  const preview = await f.service.preview(principal, offPreview);
  assert.deepEqual(preview.snapshot.config.memory.enabled, false);
  assert.deepEqual(preview.snapshot.config.memory.required, false);
  await f.service.save(principal, off);
  assert.deepEqual(JSON.parse(await readFile(f.path, 'utf8')).memory,
    { enabled: false, required: false, max_items: 7 });
  const required = await f.request([{ op: 'set', field: 'memory.required', value: true }], 'memory_required');
  await f.service.save(principal, required);
  assert.deepEqual(JSON.parse(await readFile(f.path, 'utf8')).memory,
    { enabled: true, required: true, max_items: 7 });
  await writeFile(f.paths.trustedWorkspaces, JSON.stringify({ version: 1,
    workspaces: [{ root: await realpath(f.root), trustedAt: '2026-10-03T00:00:00.000Z' }] }));
  await writeFile(join(f.root, '.nna', 'settings.json'), JSON.stringify({ memory: { required: true } }));
  const shadowed = await f.request([{ op: 'set', field: 'memory.enabled', value: false }], 'memory_shadow');
  await assert.rejects(f.service.save(principal, shadowed), { code: 'configuration_source_shadowed' });
  await writeFile(join(f.root, '.nna', 'settings.json'), JSON.stringify({ memory: { enabled: false } }));
  const reverseShadow = await f.request([{ op: 'set', field: 'memory.required', value: true }], 'memory_reverse_shadow');
  await assert.rejects(f.service.save(principal, reverseShadow), { code: 'configuration_source_shadowed' });
  assert.deepEqual(JSON.parse(await readFile(f.path, 'utf8')).memory,
    { enabled: true, required: true, max_items: 7 });
});

test('read projection omits unknown values and preview writes nothing', async (t) => {
  const f = await fixture(t), before = await readFile(f.path), snapshot = await f.service.read(principal);
  assert.ok(!JSON.stringify(projectDesktopConfigurationView(snapshot)).includes('DO_NOT_DISCLOSE_UNKNOWN_SECRET'));
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
  await assert.rejects(f.service.save(principal, overlay), { code: 'desktop_configuration_resolution_conflict' });
  const shadowed = await f.request([{ op: 'set', field: 'provider_timeout_ms', value: 6000 }], 'shadow');
  await assert.rejects(f.service.save(principal, shadowed), { code: 'configuration_source_shadowed' });
  assert.equal(JSON.parse(await readFile(f.path, 'utf8')).provider_timeout_ms, 4000);
});

test('validation and permission failures preserve selected bytes', async (t) => {
  const f = await fixture(t), bytes = await readFile(f.path);
  const bad = await f.request([{ op: 'set', field: 'provider_concurrency', value: 17 }]);
  await assert.rejects(f.service.save(principal, bad), { code: 'invalid_limit' });
  await assert.rejects(f.service.read({ ...principal, permissions: [] }), { code: 'integration_permission_denied' });
  await assert.rejects(f.service.save({ ...principal, permissions: ['desktop.configuration.read'] }, bad), { code: 'integration_permission_denied' });
  await assert.rejects(f.service.save(principal, { ...bad, installation_id: 'other' }), { code: 'desktop_configuration_request_invalid' });
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
  await assert.rejects(f.service.repair(principal, { ...input, expected_revision: (await f.service.read(principal)).sourceRevision, operation_id: 'replace_valid' }), { code: 'desktop_configuration_repair_unnecessary' });
  const malformed = '{bad source secret stays private'; await writeFile(f.path, malformed);
  const invalid = await f.service.read(principal);
  assert.equal(invalid.sourceState, 'invalid');
  assert.ok(!JSON.stringify(invalid).includes('secret stays private'));
  await f.service.repair(principal, { ...input, expected_revision: invalid.sourceRevision, operation_id: 'repair_invalid' });
  const storage = (await readdir(f.paths.config)).find((name) => name.startsWith('.nna-manifest-'));
  const backups = (await readdir(join(f.paths.config, storage))).filter((name) => name.startsWith('backup-'));
  assert.ok((await Promise.all(backups.map((name) => readFile(join(f.paths.config, storage, name), 'utf8')))).includes(malformed));
});

test('repair accepts structured provider collections and route tables', async (t) => {
  const f = await fixture(t, false);
  const document = { workspace_root: f.root, provider,
    providers: [{ id: provider.id, endpoint: provider.endpoint, model: provider.model, trust_zone: provider.trust_zone }],
    routes: { primary: { provider_id: provider.id, model: provider.model },
      reviewer: { provider_id: provider.id, model: provider.model } } };
  const input = { ...identity, expected_revision: 'absent', operation_id: 'repair_routes', document };
  assert.equal((await f.service.repair(principal, input)).persistence, 'saved');
  const saved = JSON.parse(await readFile(f.path, 'utf8'));
  assert.deepEqual(Object.keys(saved.routes).sort(), ['primary', 'reviewer']);
  assert.equal(saved.providers[0].id, provider.id);
});
test('repair rejects unknown/credential/authority documents and trusted project authority before publication', async (t) => {
  const f = await fixture(t, false);
  const input = { ...identity, expected_revision: 'absent', operation_id: 'repair', document: { workspace_root: f.root, provider } };
  for (const document of [{ ...input.document, unknown: {} }, { ...input.document, allowed_capabilities: ['tools'] },
    { ...input.document, provider: { ...provider, credential: { source: 'secret', secret_id: 'sec_x', field: 'api_key' } } }]) {
    await assert.rejects(f.service.repair(principal, { ...input, document }), { code: 'desktop_configuration_request_invalid' });
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

test('primary deadline generic writes normalize to the canonical pair contract', () => {
  const set = normalizeDesktopConfigurationOperations([{ op: 'set', field: 'routes.primary.deadline_ms', value: 600000 }]);
  assert.deepEqual(set, [{ op: 'set', field: 'provider_timeout_ms', value: 600000 }]);
  const reset = normalizeDesktopConfigurationOperations([{ op: 'reset', field: 'routes.primary.deadline_ms' }]);
  assert.deepEqual(reset, [{ op: 'reset', field: 'provider_timeout_ms' }]);
  assert.deepEqual(normalizeDesktopConfigurationOperations([{ op: 'set', field: 'provider_timeout_ms', value: 600000 }]), set);
  // One request may name the pair once, whichever advertised path it uses, and the
  // typed bound runs on the canonical pair descriptor.
  for (const operations of [
    [{ op: 'set', field: 'routes.primary.deadline_ms', value: 1000 }, { op: 'set', field: 'provider_timeout_ms', value: 2000 }],
    [{ op: 'set', field: 'provider_timeout_ms', value: 1000 }, { op: 'set', field: 'routes.primary.deadline_ms', value: 2000 }],
    [{ op: 'set', field: 'provider_timeout_ms', value: 1000 }, { op: 'reset', field: 'routes.primary.deadline_ms' }],
    [{ op: 'set', field: 'routes.primary.deadline_ms', value: 1.5 }],
    [{ op: 'set', field: 'routes.primary.deadline_ms', value: '600000' }],
    [{ op: 'reset', field: 'routes.primary.deadline_ms', value: 1000 }],
  ]) {
    assert.throws(() => normalizeDesktopConfigurationOperations(operations), { code: 'desktop_configuration_request_invalid' });
  }
});

test('generic and canonical deadline writes end in identical persisted state that survives a rebuild', () => {
  const raw = { provider, workspace_root: process.cwd(), routes: { primary: { temperature: 0.2 }, reviewer: { temperature: 0.4 } } };
  const [operation] = normalizeDesktopConfigurationOperations([{ op: 'set', field: 'routes.primary.deadline_ms', value: 600000 }]);
  const generic = applyDesktopConfigurationOperations(raw, [operation]);
  const canonical = withRouteDeadline(resolveManifest(raw), 'primary', 600000).manifest;
  assert.equal(generic.provider_timeout_ms, 600000);
  assert.equal(Object.hasOwn(generic.routes.primary, 'deadline_ms'), false);
  assert.equal(generic.routes.primary.temperature, 0.2);
  assert.equal(generic.provider_timeout_ms, canonical.provider_timeout_ms);
  assert.equal(Object.hasOwn(canonical.routes.primary, 'deadline_ms'), false);
  assert.deepEqual(providerTimeouts(generic), providerTimeouts(canonical));
  // A later canonical transaction keeps the saved value: the serializer carries the
  // pair through provider_timeout_ms and never writes the alias key.
  const rebuilt = manifestFromConfig(resolveManifest(generic));
  assert.equal(rebuilt.provider_timeout_ms, 600000);
  assert.equal(Object.hasOwn(rebuilt.routes.primary, 'deadline_ms'), false);
  assert.equal(providerTimeouts(rebuilt).providerMs, 600000);
});

test('a stray raw primary deadline folds through both entry points', () => {
  const raw = { provider, workspace_root: process.cwd(), routes: { primary: { deadline_ms: 300000 } } };
  const [set] = normalizeDesktopConfigurationOperations([{ op: 'set', field: 'routes.primary.deadline_ms', value: 600000 }]);
  const afterSet = applyDesktopConfigurationOperations(raw, [set]);
  assert.equal(afterSet.provider_timeout_ms, 600000);
  assert.equal(Object.hasOwn(afterSet.routes.primary, 'deadline_ms'), false);
  const [reset] = normalizeDesktopConfigurationOperations([{ op: 'reset', field: 'routes.primary.deadline_ms' }]);
  const afterReset = applyDesktopConfigurationOperations(raw, [reset]);
  assert.equal(Object.hasOwn(afterReset, 'provider_timeout_ms'), false);
  assert.equal(Object.hasOwn(afterReset.routes.primary, 'deadline_ms'), false);
  // Both entry points converge on one meaning for the owning boundary.
  assert.deepEqual(providerTimeouts(afterSet), providerTimeouts(withRouteDeadline(resolveManifest(raw), 'primary', 600000).manifest));
  // The pair is reported once for shadow checks, whichever entry shape arrives.
  assert.deepEqual(desktopConfigurationOperationPaths(set), ['provider_timeout_ms', 'routes.primary.deadline_ms']);
  assert.deepEqual(desktopConfigurationOperationPaths({ op: 'reset', field: 'routes.primary.deadline_ms' }),
    ['provider_timeout_ms', 'routes.primary.deadline_ms']);
  assert.deepEqual(desktopConfigurationOperationPaths({ op: 'set', field: 'provider_timeout_ms', value: 1 }),
    ['provider_timeout_ms', 'routes.primary.deadline_ms']);
});

test('project shadow of the deadline alias blocks a write to the canonical pair member', async t => {
  const f = await fixture(t);
  await writeFile(f.paths.trustedWorkspaces, JSON.stringify({ version: 1,
    workspaces: [{ root: await realpath(f.root), trustedAt: '2026-10-03T00:00:00.000Z' }] }));
  await writeFile(join(f.root, '.nna', 'settings.json'), JSON.stringify({ routes: { primary: { deadline_ms: 5000 } } }));
  const viaAlias = await f.request([{ op: 'set', field: 'routes.primary.deadline_ms', value: 600000 }], 'shadow_alias');
  await assert.rejects(f.service.save(principal, viaAlias), { code: 'configuration_source_shadowed' });
  const viaCanonical = await f.request([{ op: 'set', field: 'provider_timeout_ms', value: 600000 }], 'shadow_canonical');
  await assert.rejects(f.service.save(principal, viaCanonical), { code: 'configuration_source_shadowed' });
  assert.equal(Object.hasOwn(JSON.parse(await readFile(f.path, 'utf8')), 'provider_timeout_ms'), false);
});
