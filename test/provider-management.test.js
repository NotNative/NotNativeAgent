// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateManifestDocument, resolveManifest } from '../src/config.js';
import {
  manifestFromConfig, persistManifest, withGlobalSpecialistRoutes, withRoleRoute, withRouteDeadline, withUpdatedProvider,
  withoutProvider, withoutRoleRoute,
} from '../src/provider/route-configuration.js';
import { ExperienceEngine as InteractiveWorkspace } from '../src/experience-engine.js';
import { prepareEngineConfiguration } from '../src/runtime-config.js';

function configuration(root) {
  return resolveManifest({
    persistence: 'ephemeral', workspace_root: root, memory: { enabled: false },
    providers: [
      { id: 'one', endpoint: 'http://127.0.0.1:1/v1', model: 'old', trust_zone: 'loopback', context_limit_bytes: 200_000, output_limit_tokens: 4096 },
      { id: 'two', endpoint: 'http://127.0.0.1:2/v1', model: 'other', trust_zone: 'loopback' },
    ],
    routes: {
      primary: { provider_id: 'one', model: 'old' },
      reviewer: { provider_id: 'two', model: 'reviewer-override' },
    },
  });
}

test('provider edit updates matching default routes but preserves explicit model overrides', () => {
  const current = configuration(process.cwd());
  const next = withUpdatedProvider(current, 'one', {
    endpoint: 'http://192.168.1.20:1234/v1', model: 'new', credentialEnv: 'NNA_KEY',
  });
  assert.equal(next.config.providerProfiles.one.model, 'new');
  assert.equal(next.config.providerProfiles.one.trustZone, 'private_network');
  assert.equal(next.config.routes.primary.model, 'new');
  assert.equal(next.config.routes.reviewer.model, 'reviewer-override');
  assert.equal(next.config.providerProfiles.one.contextLimitBytes, null);
  assert.equal(next.config.providerProfiles.one.outputLimitTokens, null);
  const limited = withUpdatedProvider(next.config, 'one', { contextLimitBytes: 300_000, outputLimitTokens: 8192 });
  assert.equal(limited.config.providerProfiles.one.contextLimitBytes, 300_000);
  assert.equal(limited.config.providerProfiles.one.outputLimitTokens, 8192);
});

test('provider credential edits switch cleanly between Secret Broker and environment bindings', () => {
  const current = resolveManifest({ provider: {
    id: 'one', endpoint: 'http://127.0.0.1:1/v1', model: 'old', trust_zone: 'loopback',
    credential: { source: 'secret', secret_id: 'sec_123', field: 'api_key' },
  } });
  const preserved = withUpdatedProvider(current, 'one', { model: 'new' }).config.providerProfiles.one;
  assert.equal(preserved.credential.source, 'secret');
  const switched = withUpdatedProvider(current, 'one', { credentialEnv: 'NNA_KEY' }).config.providerProfiles.one;
  assert.equal(switched.credential.source, 'environment');
  assert.equal(switched.credentialEnv, 'NNA_KEY');
});

test('provider deletion refuses assigned and final profiles', () => {
  const current = configuration(process.cwd());
  assert.throws(() => withoutProvider(current, 'one'), { code: 'provider_in_use' });
  const only = resolveManifest({ provider: {
    id: 'one', endpoint: 'http://127.0.0.1:1/v1', model: 'old', trust_zone: 'loopback',
  } });
  assert.throws(() => withoutProvider(only, 'one'), { code: 'provider_last_profile' });
});

test('cleared specialist assignment remains unassigned and follows Primary', () => {
  const current = configuration(process.cwd());
  const cleared = withoutRoleRoute(current, 'reviewer');
  assert.equal(cleared.config.routes.reviewer.assigned, false);
  assert.equal(cleared.config.routes.reviewer.providerId, 'one');
  assert.equal(manifestFromConfig(cleared.config).routes.reviewer.provider_id, undefined);
  const changed = withRoleRoute(cleared.config, 'primary', 'two', 'other');
  assert.equal(changed.config.routes.reviewer.assigned, false);
  assert.equal(changed.config.routes.reviewer.providerId, 'two');
  assert.equal(changed.config.routes.reviewer.model, 'other');
  assert.throws(() => withoutRoleRoute(changed.config, 'primary'), { code: 'primary_route_required' });
});

test('global specialist synchronization preserves a conversation primary route', () => {
  const global = configuration(process.cwd());
  const conversation = withRoleRoute(withRoleRoute(global, 'primary', 'two', 'tab-model').config, 'reviewer', 'one', 'stale-reviewer').config;
  const synchronized = withGlobalSpecialistRoutes(conversation, global).config;
  assert.equal(synchronized.routes.primary.providerId, 'two');
  assert.equal(synchronized.routes.primary.model, 'tab-model');
  assert.equal(synchronized.routes.reviewer.providerId, 'two');
  assert.equal(synchronized.routes.reviewer.model, 'reviewer-override');
});

test('Primary owns the provider deadline while specialist overrides return to Primary', () => {
  const current = configuration(process.cwd());
  assert.equal(current.routes.primary.deadlineOverrideMs, null);
  assert.equal(current.routes.primary.deadlineMs, current.limits.providerMs);
  const overridden = withRouteDeadline(current, 'primary', 600_000);
  assert.equal(overridden.config.limits.providerOverrideMs, 600_000);
  assert.equal(overridden.config.routes.primary.deadlineOverrideMs, null);
  assert.equal(overridden.manifest.provider_timeout_ms, 600_000);
  assert.equal(overridden.manifest.routes.primary.deadline_ms, undefined);
  const inherited = withRouteDeadline(overridden.config, 'primary', null);
  assert.equal(inherited.config.limits.providerOverrideMs, null);
  assert.equal(inherited.config.routes.primary.deadlineOverrideMs, null);
  assert.equal(inherited.config.routes.primary.deadlineMs, current.limits.providerMs);
  assert.equal(inherited.manifest.routes.primary.deadline_ms, undefined);
  const specialist = withRouteDeadline(current, 'reviewer', 600_000);
  assert.equal(specialist.config.routes.reviewer.deadlineOverrideMs, 600_000);
  assert.equal(specialist.manifest.routes.reviewer.deadline_ms, 600_000);
  const primary = withRouteDeadline(specialist.config, 'reviewer', null);
  assert.equal(primary.config.routes.reviewer.deadlineOverrideMs, null);
  assert.equal(primary.config.routes.reviewer.deadlineMs, current.routes.primary.deadlineMs);
});

test('restored conversation configuration discards stale specialist assignments', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-provider-role-migration-'));
  const global = withoutRoleRoute(configuration(root), 'reviewer').config;
  const stale = withRoleRoute(global, 'reviewer', 'two', 'stale-reviewer').config;
  const workspace = new InteractiveWorkspace({
    config: global, configPath: join(root, 'settings.json'),
    providerFactory: () => ({ async *stream() { yield { type: 'terminal' }; } }),
  });
  await workspace.create('Main', 'main');
  const restored = await workspace.create('Restored', 'restored', { role: 'standard', config: stale });
  assert.equal(workspace.sessions.get(restored).engine.config.routes.reviewer.assigned, false);
  workspace.projection.activate('main');
  await workspace.deleteProvider('two');
  assert.equal(workspace.config.providerProfiles.two, undefined);
  await workspace.shutdown();
});

test('legacy auto-discovered specialist defaults migrate back to Primary inheritance', () => {
  const legacy = {
    format_version: 1,
    providers: [{
      id: 'auto-discovered-local', endpoint: 'http://127.0.0.1:1234/v1', model: 'stale-default', trust_zone: 'loopback',
    }],
    routes: {
      primary: { provider_id: 'auto-discovered-local', model: 'active-primary' },
      reviewer: { provider_id: 'auto-discovered-local', model: 'stale-default', temperature: 0 },
      subagent: { provider_id: 'auto-discovered-local', model: 'stale-default' },
      vision: { provider_id: 'auto-discovered-local', model: 'explicit-vision' },
    },
  };
  const migrated = migrateManifestDocument(legacy);
  assert.equal(migrated.migrated, true);
  assert.equal(migrated.manifest.routing_inheritance_version, 1);
  assert.equal(migrated.manifest.routes.reviewer.provider_id, undefined);
  assert.equal(migrated.manifest.routes.reviewer.model, undefined);
  assert.equal(migrated.manifest.routes.reviewer.temperature, 0);
  assert.equal(migrated.manifest.routes.subagent.provider_id, undefined);
  assert.equal(migrated.manifest.routes.vision.model, 'explicit-vision');
  const config = resolveManifest(migrated.manifest);
  assert.equal(config.routes.reviewer.assigned, false);
  assert.equal(config.routes.reviewer.model, 'active-primary');
  assert.equal(config.routes.subagent.model, 'active-primary');
  assert.equal(config.routes.vision.model, 'explicit-vision');
});

test('legacy local profile defaults migrate to reasoning-safe output headroom once', () => {
  const legacy = {
    format_version: 1, routing_inheritance_version: 1,
    provider: {
      id: 'local', endpoint: 'http://127.0.0.1:1234/v1', model: 'qwen', trust_zone: 'loopback',
      output_limit_tokens: 16_384,
    },
  };
  const migrated = migrateManifestDocument(legacy);
  assert.equal(migrated.migrated, true);
  assert.equal(migrated.manifest.output_headroom_version, 1);
  assert.equal(migrated.manifest.provider.output_limit_tokens, 32_000);
  assert.equal(migrateManifestDocument(migrated.manifest).migrated, false);

  const publicLegacy = {
    ...legacy,
    provider: { ...legacy.provider, endpoint: 'https://example.test/v1', trust_zone: 'public_network' },
  };
  assert.equal(migrateManifestDocument(publicLegacy).manifest.provider.output_limit_tokens, 16_384);
});

test('manifest persistence retains a last-known-good backup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-manifest-backup-'));
  const path = join(root, 'settings.json');
  await persistManifest(path, { marker: 'before' });
  await persistManifest(path, { marker: 'after' });
  assert.equal(JSON.parse(await readFile(path, 'utf8')).marker, 'after');
  assert.equal(JSON.parse(await readFile(`${path}.bak`, 'utf8')).marker, 'before');
});

test('Main provider manager edits, tests, and deletes unused profiles durably', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-provider-manager-'));
  const configPath = join(root, 'settings.json');
  const providerFactory = (profile) => ({
    async capabilities() { return { models: [profile.model, 'catalog-model'], tools: true }; },
    async *stream() { yield { type: 'terminal' }; },
  });
  const workspace = new InteractiveWorkspace({ config: configuration(root), configPath, providerFactory });
  await workspace.create('Main', 'main');
  await workspace.editProvider('two', { endpoint: 'http://127.0.0.1:9/v1', model: 'edited' });
  assert.equal(workspace.config.providerProfiles.two.model, 'edited');
  const checked = await workspace.testProvider('two');
  assert.equal(checked.ready, true);
  assert.deepEqual(checked.models, ['edited', 'catalog-model']);
  await workspace.clearProviderForRole('reviewer');
  assert.equal(workspace.config.routes.reviewer.assigned, false);
  await workspace.deleteProvider('two');
  assert.equal(workspace.config.providerProfiles.two, undefined);
  assert.equal(JSON.parse(await readFile(configPath, 'utf8')).providers.length, 1);
  await workspace.shutdown();
});

test('first saved profile replaces the auto-discovered bootstrap and becomes active in Main', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-provider-bootstrap-'));
  const initial = resolveManifest({
    persistence: 'ephemeral', workspace_root: root,
    provider: {
      id: 'auto-discovered-local', display_name: 'Default provider',
      endpoint: 'http://127.0.0.1:1234/v1', model: 'bootstrap-model', trust_zone: 'loopback',
    },
  });
  const workspace = new InteractiveWorkspace({
    config: initial, configPath: join(root, 'settings.json'),
    providerFactory: () => ({ async *stream() { yield { type: 'terminal' }; } }),
  });
  const main = await workspace.create('Main', 'main');
  const previous = await workspace.create('Previous Main', 'previous');
  workspace.projection.activate(main);
  await workspace.addProvider({
    id: 'lm-studio', displayName: 'LM Studio', endpoint: 'http://127.0.0.1:1234/v1', model: 'qwen',
  });
  assert.equal(workspace.config.routes.primary.providerId, 'lm-studio');
  assert.equal(workspace.config.providerProfiles['auto-discovered-local'], undefined);
  assert.equal(workspace.sessions.get(main).engine.config.routes.primary.providerId, 'lm-studio');
  assert.equal(workspace.sessions.get(main).engine.config.providerProfiles['auto-discovered-local'], undefined);
  assert.equal(workspace.sessions.get(previous).engine.config.routes.primary.providerId, 'auto-discovered-local');
  assert.ok(workspace.sessions.get(previous).engine.config.providerProfiles['lm-studio']);
  await workspace.shutdown();
});

test('provider catalog publication preserves each open conversation immutable scope', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-provider-catalog-main-'));
  const otherRoot = await mkdtemp(join(tmpdir(), 'nna-provider-catalog-other-'));
  const workspace = new InteractiveWorkspace({
    config: configuration(root), configPath: join(root, 'settings.json'),
    providerFactory: () => ({ async *stream() { yield { type: 'terminal' }; } }),
  });
  const main = await workspace.create('Main', 'main');
  const other = await workspace.create('Other workspace', 'other', { config: configuration(otherRoot) });
  workspace.projection.activate(main);

  await workspace.addProvider({
    id: 'three', displayName: 'Third provider', endpoint: 'http://127.0.0.1:3/v1', model: 'third-model',
  });

  assert.equal(workspace.sessions.get(main).engine.config.workspaceRoot, root);
  assert.equal(workspace.sessions.get(other).engine.config.workspaceRoot, otherRoot);
  assert.ok(workspace.sessions.get(main).engine.config.providerProfiles.three);
  assert.ok(workspace.sessions.get(other).engine.config.providerProfiles.three);
  await workspace.shutdown();
});

test('provider discovery requests v1/models with optional authentication', async () => {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ url: request.url, authorization: request.headers.authorization });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ data: [{ id: 'qwen-discovered' }, { id: 'vision-discovered' }] }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const previous = process.env.NNA_DISCOVERY_TEST_KEY;
  process.env.NNA_DISCOVERY_TEST_KEY = 'redacted-test-secret';
  const root = await mkdtemp(join(tmpdir(), 'nna-provider-discovery-'));
  const workspace = new InteractiveWorkspace({ config: configuration(root) });
  try {
    await workspace.create('Main', 'main');
    const result = await workspace.discoverProviderModels({
      displayName: 'Local Lab', endpoint: `http://127.0.0.1:${address.port}/v1`,
      credentialEnv: 'NNA_DISCOVERY_TEST_KEY',
    });
    assert.deepEqual(result.models, ['qwen-discovered', 'vision-discovered']);
    const localResult = await workspace.discoverProviderModels({
      displayName: 'Unauthenticated LM Studio', endpoint: `http://127.0.0.1:${address.port}/v1`, credentialEnv: '',
    });
    assert.deepEqual(localResult.models, ['qwen-discovered', 'vision-discovered']);
    assert.deepEqual(requests, [
      { url: '/v1/models', authorization: 'Bearer redacted-test-secret' },
      { url: '/v1/models', authorization: undefined },
    ]);
  } finally {
    await workspace.shutdown();
    await new Promise((resolve) => server.close(resolve));
    if (previous === undefined) delete process.env.NNA_DISCOVERY_TEST_KEY;
    else process.env.NNA_DISCOVERY_TEST_KEY = previous;
  }
});

test('AC-CONF-02/AC-CONF-07 persistence failure publishes no global runtime change', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-config-atomic-write-'));
  let failWrite = false;
  const workspace = new InteractiveWorkspace({
    config: configuration(root), configPath: join(root, 'settings.json'),
    manifestWriter: async () => {
      if (failWrite) throw Object.assign(new Error('simulated manifest storage failure'), { code: 'manifest_write_failed' });
    },
    providerFactory: () => ({ async *stream() { yield { type: 'terminal' }; } }),
  });
  const main = await workspace.create('Main', 'main');
  const other = await workspace.create('Other', 'other');
  failWrite = true;

  await assert.rejects(workspace.toggleConfigSetting('memory.enabled'), { code: 'manifest_write_failed' });
  assert.equal(workspace.config.memory.enabled, false);
  assert.equal(workspace.sessions.get(main).engine.config.memory.enabled, false);
  assert.equal(workspace.sessions.get(other).engine.config.memory.enabled, false);
  failWrite = false;
  await workspace.shutdown();
});

test('AC-CONF-07 validates every session before persisting or publishing a global change', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-config-atomic-validation-'));
  let writes = 0;
  const workspace = new InteractiveWorkspace({
    config: configuration(root), configPath: join(root, 'settings.json'),
    manifestWriter: async () => { writes += 1; },
    configurationPreparer: (engine, manifest) => {
      if (engine.sessionId === 'other') {
        throw Object.assign(new Error('simulated incompatible session'), { code: 'configuration_incompatible' });
      }
      return prepareEngineConfiguration(engine, manifest);
    },
    providerFactory: () => ({ async *stream() { yield { type: 'terminal' }; } }),
  });
  const main = await workspace.create('Main', 'main');
  const other = await workspace.create('Other', 'other');

  await assert.rejects(workspace.toggleConfigSetting('memory.enabled'), { code: 'configuration_incompatible' });
  assert.equal(writes, 0);
  assert.equal(workspace.config.memory.enabled, false);
  assert.equal(workspace.sessions.get(main).engine.config.memory.enabled, false);
  assert.equal(workspace.sessions.get(other).engine.config.memory.enabled, false);
  await Promise.all([...workspace.sessions.values()].map((session) => session.engine.shutdown({ request_id: `cleanup-${session.id}` })));
});

test('AC-CONF-07 workspace configuration versions advance and seed new conversations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-config-version-'));
  const workspace = new InteractiveWorkspace({
    config: configuration(root), configPath: join(root, 'settings.json'),
    manifestWriter: async () => undefined,
    providerFactory: () => ({ async *stream() { yield { type: 'terminal' }; } }),
  });
  const main = await workspace.create('Main', 'main');
  assert.equal(workspace.config.version, 1);
  await workspace.toggleConfigSetting('memory.enabled');
  await workspace.toggleConfigSetting('memory.enabled');
  assert.equal(workspace.config.version, 3);
  assert.equal(workspace.sessions.get(main).engine.config.version, 3);

  const later = await workspace.create('Later', 'later');
  assert.equal(workspace.sessions.get(later).engine.config.version, 3);
  await workspace.shutdown();
});

test('provider profiles publish with the production default provider factory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-provider-default-factory-'));
  const workspace = new InteractiveWorkspace({
    config: configuration(root), configPath: join(root, 'settings.json'),
    manifestWriter: async () => undefined,
  });
  const main = await workspace.create('Main', 'main');

  await workspace.addProvider({
    id: 'three', displayName: 'Third', endpoint: 'http://127.0.0.1:3/v1', model: 'new-model',
    credentialEnv: '', trustZone: 'loopback',
  });

  assert.equal(workspace.config.providerProfiles.three.model, 'new-model');
  assert.equal(typeof workspace.sessions.get(main).engine.router.providerFactory, 'function');
  await workspace.shutdown();
});

test('provider menus hard-timeout uncooperative capability discovery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-provider-capability-timeout-'));
  const workspace = new InteractiveWorkspace({
    config: configuration(root), providerCapabilityDeadlineMs: 20,
    providerFactory: () => ({
      capabilities: async () => new Promise(() => undefined),
      async *stream() { yield { type: 'terminal' }; },
    }),
  });
  await workspace.create('Main', 'main');
  const started = Date.now();
  await assert.rejects(workspace.availableModels(), { code: 'provider_capabilities_timeout' });
  await assert.rejects(workspace.testProvider('one'), { code: 'provider_capabilities_timeout' });
  assert.ok(Date.now() - started < 250);
  await workspace.shutdown();
});

test('provider menus bound and validate third-party capability records', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-provider-capability-shape-'));
  const workspace = new InteractiveWorkspace({
    config: configuration(root),
    providerFactory: () => ({
      async capabilities() { return { models: Array.from({ length: 5000 }, (_, index) => `model-${index}`), tools: true }; },
      async *stream() { yield { type: 'terminal' }; },
    }),
  });
  await workspace.create('Main', 'main');
  assert.equal((await workspace.availableModels()).length, 4096);
  await workspace.shutdown();
});
