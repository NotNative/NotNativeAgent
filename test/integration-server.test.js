// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SecretBroker } from '../src/secret-broker.js';
import { startIntegrationServer } from '../src/integration-server.js';
import { validateNnoIntegrationActivation } from '../src/nno-integration-activation.js';
import { ProviderProfileStore } from '../src/provider/profile-store.js';
import { NndEngineHost } from '../src/nnd-engine-host.js';
import { resolveManifest } from '../src/config.js';
import { nndMcpInventory } from '../src/nnd-mcp-inventory.js';
import { nndAgentInventory } from '../src/nnd-agent-inventory.js';
import { ContractError } from '../src/ids.js';

const TOKEN = 'ephemeral-integration-token-with-at-least-32-characters';

test('integration service authenticates exact principals and manages provider profiles', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-integration-'));
  const configRoot = join(root, 'config');
  await mkdir(configRoot, { recursive: true });
  await writeFile(join(configRoot, 'manifest.json'), JSON.stringify(manifest(root)));
  const seen = [];
  const broker = new SecretBroker({ vaultPath: join(root, 'vault.json'), keyPath: join(root, 'key.json') });
  const providerStore = new ProviderProfileStore({
    configRoot, environment: { TEST_PROVIDER_KEY: 'secret-value' }, secretBroker: broker,
    fetch: async (url, options) => {
      seen.push({ url: String(url), redirect: options.redirect, authorization: options.headers.authorization });
      return new Response(JSON.stringify({ data: [{ id: 'model-a' }, { id: 'model-b' }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    },
  });
  const service = await startIntegrationServer({
    activation: await activation(root), token: TOKEN, instanceId: 'nna_test', providerStore, broker, port: 0,
  });
  const base = `http://127.0.0.1:${service.address.port}`;
  try {
    assert.equal((await fetch(`${base}/v1/health`)).status, 401);
    const readOnly = principal(['integration.health', 'provider.read']);
    const health = await request(base, '/v1/health', readOnly);
    assert.deepEqual(health.value, { status: 'ready', protocol: '1.0', instance_id: 'nna_test' });
    const listed = await request(base, '/v1/provider-profiles', readOnly);
    assert.equal(listed.value.profiles.length, 2);
    assert.deepEqual(listed.value.configured_primary_route, { providerID: 'one', modelID: 'one' });
    assert.equal(listed.value.runtime_route, null);
    assert.equal((await request(base, '/v1/provider-profiles', readOnly, {
      method: 'POST', body: { profile_id: 'blocked', endpoint: 'http://127.0.0.1:4/v1', model: 'x' },
    })).status, 403);
    assert.equal((await request(base, '/v1/provider-route', readOnly, {
      method: 'PATCH', body: { provider_id: 'two', model: 'two' },
    })).status, 403);

    const routeManager = principal(['provider.read', 'provider.route.manage']);
    assert.equal((await request(base, '/v1/provider-profiles', routeManager, {
      method: 'POST', body: { profile_id: 'blocked', endpoint: 'http://127.0.0.1:4/v1', model: 'x' },
    })).status, 403);
    const profileWriter = principal(['provider.read', 'provider.profile.write']);
    const narrowCreate = await request(base, '/v1/provider-profiles', profileWriter, {
      method: 'POST', body: { profile_id: 'narrow', endpoint: 'http://127.0.0.1:4/v1', model: 'narrow-model' },
    });
    assert.equal(narrowCreate.status, 201);
    assert.equal((await request(base, '/v1/provider-profiles/narrow', profileWriter, {
      method: 'PATCH', body: { display_name: 'Narrow writer' },
    })).value.profile.display_name, 'Narrow writer');
    assert.equal((await request(base, '/v1/provider-profiles/narrow', profileWriter, { method: 'DELETE' })).status, 403);
    assert.equal((await request(base, '/v1/provider-route', routeManager, {
      method: 'PATCH', body: { provider_id: 'missing', model: 'x' },
    })).status, 404);
    assert.equal((await request(base, '/v1/provider-route', routeManager, {
      method: 'PATCH', body: { provider_id: 'two', model: 'two', credential: 'secret' },
    })).status, 400);
    const selected = await request(base, '/v1/provider-route', routeManager, {
      method: 'PATCH', body: { provider_id: 'two', model: 'two' },
    });
    assert.deepEqual(selected.value.configured_primary_route, { providerID: 'two', modelID: 'two' });
    assert.equal(selected.value.runtime_route, null);
    assert.deepEqual((await request(base, '/v1/provider-profiles', readOnly)).value.configured_primary_route,
      { providerID: 'two', modelID: 'two' });

    const manager = principal(['provider.read', 'provider.manage', 'provider.discover', 'provider.test']);
    const created = await request(base, '/v1/provider-profiles', manager, {
      method: 'POST', body: {
        profile_id: 'lab', display_name: 'Lab', endpoint: 'http://127.0.0.1:3/v1', model: 'model-a',
        credential_env: 'TEST_PROVIDER_KEY', context_limit_bytes: 262144, output_limit_tokens: 4096,
      },
    });
    assert.equal(created.status, 201);
    assert.equal(created.value.profile.profile_id, 'lab');
    assert.equal(created.value.profile.context_limit_bytes, 262144);
    assert.equal(JSON.stringify(created.value).includes('secret-value'), false);

    const discovered = await request(base, '/v1/provider-profiles/lab/discover', manager, { method: 'POST' });
    assert.deepEqual(discovered.value, { profile_id: 'lab', models: ['model-a', 'model-b'] });
    assert.equal(seen[0].redirect, 'error');
    assert.equal(seen[0].authorization, 'Bearer secret-value');
    const tested = await request(base, '/v1/provider-profiles/lab/test', manager, { method: 'POST' });
    assert.equal(tested.value.status, 'ready');

    const secret = await broker.create({ label: 'NNO provider key', kind: 'api_key', fields: { api_key: 'broker-secret-value' } });
    const secretProfile = await request(base, '/v1/provider-profiles', manager, {
      method: 'POST', body: {
        profile_id: 'lab-secret', endpoint: 'http://127.0.0.1:5/v1', model: 'model-a',
        credential: { source: 'secret', secret_id: secret.id, field: 'api_key' },
      },
    });
    assert.equal(secretProfile.status, 201);
    assert.deepEqual(secretProfile.value.profile.credential, { source: 'secret', secret_id: secret.id, field: 'api_key' });
    await request(base, '/v1/provider-profiles/lab-secret/discover', manager, { method: 'POST' });
    assert.equal(seen.at(-1).authorization, 'Bearer broker-secret-value');
    const renamedSecret = await request(base, '/v1/provider-profiles/lab-secret', profileWriter, {
      method: 'PATCH', body: { display_name: 'Broker backed' },
    });
    assert.deepEqual(renamedSecret.value.profile.credential, { source: 'secret', secret_id: secret.id, field: 'api_key' });
    await request(base, '/v1/provider-profiles/lab-secret/discover', manager, { method: 'POST' });
    assert.equal(seen.at(-1).authorization, 'Bearer broker-secret-value');

    const edited = await request(base, '/v1/provider-profiles/lab', manager, {
      method: 'PATCH', body: { display_name: 'Renamed Lab', model: 'model-b' },
    });
    assert.equal(edited.value.profile.display_name, 'Renamed Lab');
    assert.equal(edited.value.profile.profile_id, 'lab');
    assert.equal((await request(base, '/v1/provider-profiles/lab', manager, { method: 'DELETE' })).value.removed, 'lab');
  } finally { await service.close(); }
});

test('provider reads remain available through a store without route mutation support', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-provider-legacy-store-'));
  const providerStore = {
    inventory: async () => ({ profiles: [], configured_primary_route: { providerID: 'one', modelID: 'one' } }),
    get: async () => null, create: async () => null, update: async () => null,
    remove: async () => null, withCredential: async () => '',
  };
  const service = await startIntegrationServer({
    activation: await activation(root), token: TOKEN, instanceId: 'nna_legacy', providerStore, port: 0,
  });
  const base = `http://127.0.0.1:${service.address.port}`;
  try {
    assert.equal((await request(base, '/v1/provider-profiles', principal(['provider.read']))).status, 200);
    const mutation = await request(base, '/v1/provider-route', principal(['provider.route.manage']), {
      method: 'PATCH', body: { provider_id: 'one', model: 'one' },
    });
    assert.equal(mutation.status, 400);
    assert.equal(mutation.value.error.code, 'provider_store_unavailable');
  } finally { await service.close(); }
});

test('route activation is separately authorized and old sessions keep their model selection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-provider-activate-'));
  const configRoot = join(root, 'config');
  await mkdir(configRoot, { recursive: true });
  await writeFile(join(configRoot, 'manifest.json'), JSON.stringify(manifest(root)));
  const submitted = [];
  const host = {
    nndModel: { providerID: 'one', modelID: 'one' },
    async activateProviderRoute() { this.nndModel = { providerID: 'two', modelID: 'two' }; return this.nndModel; },
    get() { return { metadata: { nnd: { configuredModel: { providerID: 'one', modelID: 'one' } } } }; },
    submitAsync(_id, command) { submitted.push(command); return { accepted: true }; },
  };
  const service = await startIntegrationServer({
    activation: await activation(root), token: TOKEN, instanceId: 'nna_activate', nndEngineHost: host,
    providerStore: new ProviderProfileStore({ configRoot }), port: 0,
  });
  const base = `http://127.0.0.1:${service.address.port}`;
  try {
    assert.equal((await request(base, '/v1/provider-route/activate', principal(['provider.route.manage']), { method: 'POST' })).status, 403);
    const activated = await request(base, '/v1/provider-route/activate', principal(['provider.route.activate']), { method: 'POST' });
    assert.deepEqual(activated.value, { runtime_route: { providerID: 'two', modelID: 'two' }, existing_sessions_unchanged: true });
    assert.equal((await request(base, '/session/old/prompt_async', principal(['nnd.session.submit']), {
      method: 'POST', body: { messageID: 'prompt_old', model: { providerID: 'one', modelID: 'one' }, parts: [{ type: 'text', text: 'hello' }] },
    })).status, 204);
    assert.equal(submitted.length, 1);
    assert.equal((await request(base, '/session/old/prompt_async', principal(['nnd.session.submit']), {
      method: 'POST', body: { messageID: 'prompt_wrong', model: { providerID: 'two', modelID: 'two' }, parts: [{ type: 'text', text: 'hello' }] },
    })).status, 400);
  } finally { await service.close(); }
});

test('integration principal rejects stale and role-only authority', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-integration-'));
  const configRoot = join(root, 'config');
  await mkdir(configRoot, { recursive: true });
  await writeFile(join(configRoot, 'manifest.json'), JSON.stringify(manifest(root)));
  const service = await startIntegrationServer({
    activation: await activation(root), token: TOKEN, instanceId: 'nna_test',
    providerStore: new ProviderProfileStore({ configRoot }),
    broker: new SecretBroker({ vaultPath: join(root, 'vault.json'), keyPath: join(root, 'key.json') }), port: 0,
  });
  const base = `http://127.0.0.1:${service.address.port}`;
  try {
    const roleOnly = principal([], { platform_role: 'root' });
    assert.equal((await request(base, '/v1/provider-profiles', roleOnly)).status, 403);
    const stale = principal(['provider.read'], { issued_at: new Date(Date.now() - 600_000).toISOString() });
    assert.equal((await request(base, '/v1/provider-profiles', stale)).status, 401);
  } finally { await service.close(); }
});

test('provider inventory separates configured primary from the running NND route', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-provider-route-drift-'));
  const configRoot = join(root, 'config');
  await mkdir(configRoot, { recursive: true });
  const document = manifest(root);
  document.routes.primary.model = 'route-override';
  await writeFile(join(configRoot, 'manifest.json'), JSON.stringify(document));
  const service = await startIntegrationServer({
    activation: await activation(root), token: TOKEN, instanceId: 'nna_test',
    nndEngineHost: { nndModel: { providerID: 'one', modelID: 'one' } },
    providerStore: new ProviderProfileStore({ configRoot }),
    broker: new SecretBroker({ vaultPath: join(root, 'vault.json'), keyPath: join(root, 'key.json') }), port: 0,
  });
  const base = `http://127.0.0.1:${service.address.port}`;
  try {
    const actor = principal(['provider.read']);
    const first = (await request(base, '/v1/provider-profiles', actor)).value;
    assert.deepEqual(first.runtime_route, { providerID: 'one', modelID: 'one' });
    assert.deepEqual(first.configured_primary_route, { providerID: 'one', modelID: 'route-override' });
    assert.equal(first.profiles.find((profile) => profile.active).model, 'one');
    assert.equal(first.profiles.find((profile) => profile.active).profile_id, 'one');
    document.routes.primary = { provider_id: 'two', model: 'two' };
    await writeFile(join(configRoot, 'manifest.json'), JSON.stringify(document));
    const changed = (await request(base, '/v1/provider-profiles', actor)).value;
    assert.equal(changed.profiles.find((profile) => profile.active).profile_id, 'two');
    assert.deepEqual(changed.configured_primary_route, { providerID: 'two', modelID: 'two' });
    assert.deepEqual(changed.runtime_route, { providerID: 'one', modelID: 'one' });
  } finally { await service.close(); }
});

test('NND capability projection fails closed without a steering grant', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-nnd-integration-'));
  const configRoot = join(root, 'config');
  await mkdir(configRoot, { recursive: true });
  await writeFile(join(configRoot, 'manifest.json'), JSON.stringify(manifest(root)));
  const service = await startIntegrationServer({
    activation: await activation(root), token: TOKEN, instanceId: 'nna_test',
    providerStore: new ProviderProfileStore({ configRoot }),
    broker: new SecretBroker({ vaultPath: join(root, 'vault.json'), keyPath: join(root, 'key.json') }),
    nndEngineHost: { resolveChildSession: async (sessionId) => {
      if (sessionId === 'ses_live') return { sessionId, revision: 1, availability: 'ungranted', steerSubagent: false };
      if (sessionId === 'ses_granted') return {
        sessionId, revision: 2, availability: 'granted', steerSubagent: true,
        steer: async (command, actor) => ({ accepted: true, request_id: command.request_id, subject_id: actor.subjectId }),
      };
      return null;
    } }, port: 0,
  });
  const base = `http://127.0.0.1:${service.address.port}`;
  try {
    const reader = principal(['nnd.read']);
    const projection = await request(base, '/v1/nnd/sessions/ses_live/capabilities', reader);
    assert.equal(projection.status, 200);
    assert.equal(projection.value.capabilities.steer_subagent, false);
    assert.equal((await request(base, '/v1/nnd/sessions/ses_live/steer', principal(['nnd.steer']), {
      method: 'POST', body: { request_id: 'steer_test', content: 'stop' },
    })).status, 409);
    const accepted = await request(base, '/v1/nnd/sessions/ses_granted/steer', principal(['nnd.steer']), {
      method: 'POST', body: { request_id: 'steer_granted', content: 'pause' },
    });
    assert.equal(accepted.status, 202);
    assert.deepEqual(accepted.value, { accepted: true, request_id: 'steer_granted', subject_id: 'u_test' });
    assert.equal((await request(base, '/v1/nnd/sessions/ses_granted/capabilities', principal([]))).status, 403);
  } finally { await service.close(); }
});

test('NND MCP inventory projects configured state without destinations or credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-nnd-mcp-'));
  const configRoot = join(root, 'config');
  await mkdir(configRoot, { recursive: true });
  const input = { ...manifest(root), mcp_servers: [{
    id: 'memory', transport: 'streamable_http', enabled: true, trusted: false,
    endpoint: 'https://mcp.example/private?api_key=SECRET_QUERY', credential_env: 'SECRET_ENV',
  }] };
  await writeFile(join(configRoot, 'manifest.json'), JSON.stringify(input));
  const inventory = nndMcpInventory(resolveManifest(input));
  const service = await startIntegrationServer({
    activation: await activation(root), token: TOKEN, instanceId: 'nna_test',
    nndEngineHost: { nndMcpInventory: inventory },
    providerStore: new ProviderProfileStore({ configRoot }),
    broker: new SecretBroker({ vaultPath: join(root, 'vault.json'), keyPath: join(root, 'key.json') }), port: 0,
  });
  const base = `http://127.0.0.1:${service.address.port}`;
  try {
    const result = await request(base, '/v1/nnd/mcp', principal(['nnd.read']));
    assert.deepEqual(result.value, { version: 1, state: 'configured', servers: [{
      id: 'memory', transport: 'streamable_http', enabled: true, trusted: false,
    }] });
    assert.equal(JSON.stringify(result.value).includes('SECRET_'), false);
    assert.equal(JSON.stringify(result.value).includes('mcp.example'), false);
    assert.equal((await request(base, '/v1/nnd/mcp', principal([]))).status, 403);
    assert.equal((await request(base, '/v1/nnd/mcp', principal(['nnd.read']), { method: 'POST' })).status, 405);
  } finally { await service.close(); }
});

test('NND skills inventory is read-only and omits source paths and bodies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-nnd-skills-'));
  const configRoot = join(root, 'config');
  await mkdir(configRoot, { recursive: true });
  await writeFile(join(configRoot, 'manifest.json'), JSON.stringify(manifest(root)));
  const service = await startIntegrationServer({
    activation: await activation(root), token: TOKEN, instanceId: 'nna_test',
    nndEngineHost: { readNndSkillsInventory: async () => ({ version: 1, state: 'discovered', skills: [
      { id: 'review', version: '1', description: 'Review code', invocation: 'both' },
    ] }) },
    providerStore: new ProviderProfileStore({ configRoot }),
    broker: new SecretBroker({ vaultPath: join(root, 'vault.json'), keyPath: join(root, 'key.json') }), port: 0,
  });
  const base = `http://127.0.0.1:${service.address.port}`;
  try {
    const result = await request(base, '/v1/nnd/skills', principal(['nnd.read']));
    assert.deepEqual(result.value.skills, [{ id: 'review', version: '1', description: 'Review code', invocation: 'both' }]);
    assert.equal((await request(base, '/v1/nnd/skills', principal([]))).status, 403);
    assert.equal((await request(base, '/v1/nnd/skills', principal(['nnd.read']), { method: 'POST' })).status, 405);
  } finally { await service.close(); }
});

test('NND agent inventory exposes built-in roles and the running delegation route without grants', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-nnd-agents-'));
  const configRoot = join(root, 'config');
  await mkdir(configRoot, { recursive: true });
  await writeFile(join(configRoot, 'manifest.json'), JSON.stringify(manifest(root)));
  const inventory = nndAgentInventory(resolveManifest(manifest(root)));
  const service = await startIntegrationServer({
    activation: await activation(root), token: TOKEN, instanceId: 'nna_test',
    nndEngineHost: { nndAgentInventory: inventory },
    providerStore: new ProviderProfileStore({ configRoot }), port: 0,
  });
  const base = `http://127.0.0.1:${service.address.port}`;
  try {
    const result = await request(base, '/v1/nnd/agents', principal(['nnd.read']));
    assert.equal(result.value.state, 'configured');
    assert.deepEqual(result.value.route, { providerID: 'one', modelID: 'one' });
    assert.deepEqual(result.value.roles.map((item) => item.id), ['general', 'planner', 'coder', 'tester', 'reviewer']);
    assert.equal(JSON.stringify(result.value).includes('endpoint'), false);
    assert.equal(JSON.stringify(result.value).includes('permissions'), false);
    assert.equal((await request(base, '/v1/nnd/agents', principal([]))).status, 403);
    assert.equal((await request(base, '/v1/nnd/agents', principal(['nnd.read']), { method: 'POST' })).status, 405);
  } finally { await service.close(); }
});

test('subagent route edits are authorized, durable, and separate from running delegation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-subagent-route-'));
  const configRoot = join(root, 'config');
  await mkdir(configRoot, { recursive: true });
  await writeFile(join(configRoot, 'manifest.json'), JSON.stringify(manifest(root)));
  const store = new ProviderProfileStore({ configRoot });
  const host = { nndAgentInventory: { route: { providerID: 'one', modelID: 'one' } } };
  const service = await startIntegrationServer({
    activation: await activation(root), token: TOKEN, instanceId: 'nna_test',
    nndEngineHost: host, providerStore: store, port: 0,
  });
  const base = `http://127.0.0.1:${service.address.port}`;
  try {
    const reader = principal(['provider.read']);
    const manager = principal(['provider.read', 'provider.route.manage']);
    assert.deepEqual((await request(base, '/v1/provider-route/subagent', reader)).value, {
      configured_route: { providerID: 'one', modelID: 'one' }, runtime_route: { providerID: 'one', modelID: 'one' },
    });
    assert.equal((await request(base, '/v1/provider-route/subagent', reader, {
      method: 'PATCH', body: { provider_id: 'two', model: 'other' },
    })).status, 403);
    assert.equal((await request(base, '/v1/provider-route/subagent', manager, {
      method: 'PATCH', body: { provider_id: 'missing', model: 'other' },
    })).status, 404);
    assert.equal((await request(base, '/v1/provider-route/subagent', manager, {
      method: 'PATCH', body: { provider_id: 'two', model: 'other', credential: 'bad' },
    })).status, 400);
    const saved = await request(base, '/v1/provider-route/subagent', manager, {
      method: 'PATCH', body: { provider_id: 'two', model: 'other' },
    });
    assert.deepEqual(saved.value, {
      configured_route: { providerID: 'two', modelID: 'other' }, runtime_route: { providerID: 'one', modelID: 'one' },
    });
    assert.deepEqual((await request(base, '/v1/provider-route/subagent', reader)).value.configured_route,
      { providerID: 'two', modelID: 'other' });
    assert.deepEqual((await store.config()).routes.subagent.model, 'other');
    assert.deepEqual((await store.config()).routes.primary.model, 'one');
  } finally { await service.close(); }
});

test('NND goals persist with id-guarded writes and never grant arbitrary metadata updates', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-nnd-goal-'));
  const catalogPath = join(root, 'catalog.json');
  const makeHost = () => new NndEngineHost({ catalogPath, createEngine: async () => ({
    config: { workspaceRoot: root, routes: { primary: { providerId: 'one', model: 'one' } } },
    transcript: [], async initialize() {}, async shutdown() {},
  }) });
  const host = makeHost();
  const service = await startIntegrationServer({
    activation: await activation(root), token: TOKEN, instanceId: 'nna_test', nndEngineHost: host,
    nndWorkspaceRoot: root, port: 0,
  });
  const base = `http://127.0.0.1:${service.address.port}`;
  const owner = principal(['nnd.read', 'nnd.session.create', 'nnd.goal.manage']);
  const now = Date.now();
  const goal = { id: 'goal_test', objective: 'Ship MVP', objectiveFile: false, status: 'active',
    tokenBudget: null, tokensUsed: 0, tokensBaseline: 0, tokensCommitted: 0, turnsUsed: 0,
    blockedStreak: 0, auditFailStreak: 0, note: '', statusReason: '', evaluationProviderID: '',
    evaluationModelID: '', lastAccountedMessageID: '', createdAt: now, updatedAt: now };
  let sessionId;
  try {
    sessionId = (await request(base, '/session', owner, { method: 'POST', body: { title: 'Goal session' } })).value.id;
    const path = `/v1/nnd/sessions/${sessionId}/goal`;
    const evidencePath = `/v1/nnd/sessions/${sessionId}/goal-evidence`;
    assert.deepEqual((await request(base, evidencePath, owner)).value, {
      session_id: sessionId, turns: [], latest_request_id: null, window_truncated: false,
    });
    assert.equal((await request(base, evidencePath, principal(['nnd.goal.manage']))).status, 403);
    assert.deepEqual((await request(base, path, owner)).value, { goal: null, revision: 0 });
    const outsider = principal(['nnd.read', 'nnd.goal.manage'], { subject_id: 'other_user' });
    assert.equal((await request(base, path, outsider)).status, 404);
    assert.equal((await request(base, evidencePath, outsider)).status, 404);
    assert.equal((await request(base, path, outsider, {
      method: 'PUT', body: { goal, expected_id: null, expected_revision: 0 },
    })).status, 404);
    assert.equal((await request(base, path, principal(['nnd.read']), {
      method: 'PUT', body: { goal, expected_id: null, expected_revision: 0 },
    })).status, 403);
    assert.equal((await request(base, path, owner, {
      method: 'PUT', body: { goal: { ...goal, objective: 'x'.repeat(5001) }, expected_id: null, expected_revision: 0 },
    })).status, 400);
    assert.equal((await request(base, path, owner, {
      method: 'PUT', body: { goal: { ...goal, objectiveFileKey: '../escape' }, expected_id: null, expected_revision: 0 },
    })).status, 400);
    assert.equal((await request(base, path, owner, {
      method: 'PUT', body: { goal, expected_id: null, expected_revision: 0, metadata: { admin: true } },
    })).status, 400);
    assert.deepEqual((await request(base, path, owner, {
      method: 'PUT', body: { goal, expected_id: null, expected_revision: 0 },
    })).value, { goal, revision: 1 });
    assert.deepEqual((await request(base, `/session/${sessionId}`, owner)).value.metadata.nnd.goal, goal);
    assert.equal((await request(base, path, owner, {
      method: 'PUT', body: { goal: { ...goal, status: 'complete' }, expected_id: null, expected_revision: 1 },
    })).status, 409);
    assert.equal((await request(base, path, owner, {
      method: 'PUT', body: { goal: { ...goal, status: 'paused' }, expected_id: goal.id, expected_revision: 0 },
    })).status, 409, 'same-id concurrent writer must not overwrite a newer transition');
    assert.deepEqual((await request(base, path, owner, {
      method: 'PUT', body: { goal: { ...goal, status: 'complete' }, expected_id: goal.id, expected_revision: 1 },
    })).value, { goal: { ...goal, status: 'complete' }, revision: 2 });
    const keyed = { ...goal, status: 'complete', objectiveFile: true, objectiveFileKey: 'a'.repeat(64) };
    assert.deepEqual((await request(base, path, owner, {
      method: 'PUT', body: { goal: keyed, expected_id: goal.id, expected_revision: 2 },
    })).value, { goal: keyed, revision: 3 });
    assert.equal((await request(base, path, owner, { method: 'DELETE', body: { expected_id: 'wrong_id', expected_revision: 2 } })).status, 409);
  } finally { await service.close(); await host.shutdown(); }
  const restored = makeHost();
  await restored.initialize();
  try {
    assert.equal(restored.get(sessionId, { subjectId: 'u_test', workspaceIds: ['w_test'] }).metadata.nnd.goal.status, 'complete');
    assert.equal(restored.goal(sessionId, { subjectId: 'u_test', workspaceIds: ['w_test'] }).revision, 3);
    assert.equal(restored.goal(sessionId, { subjectId: 'u_test', workspaceIds: ['w_test'] }).goal.objectiveFileKey, 'a'.repeat(64));
    await restored.clearGoal(sessionId, { subjectId: 'u_test', workspaceIds: ['w_test'] }, goal.id, 3);
    assert.equal(restored.get(sessionId, { subjectId: 'u_test', workspaceIds: ['w_test'] }).metadata.nnd.goal, undefined);
  } finally { await restored.shutdown(); }
});

test('NND goal revision remains unchanged when catalog persistence fails', async () => {
  let rejectWrites = false;
  const host = new NndEngineHost({ catalogPath: 'test-goal-catalog', createEngine: async () => ({
    config: { routes: { primary: { providerId: 'one', model: 'one' } } }, transcript: [],
    async initialize() {}, async shutdown() {},
  }), persistCatalog: async () => { if (rejectWrites) throw new Error('catalog write failed'); } });
  const owner = { subjectId: 'u_test', workspaceIds: ['w_test'] };
  const now = Date.now();
  const goal = { id: 'goal_test', objective: 'Keep the previous state', objectiveFile: false, status: 'active',
    tokenBudget: null, tokensUsed: 0, tokensBaseline: 0, tokensCommitted: 0, turnsUsed: 0,
    blockedStreak: 0, auditFailStreak: 0, note: '', statusReason: '', evaluationProviderID: '',
    evaluationModelID: '', lastAccountedMessageID: '', createdAt: now, updatedAt: now };
  await host.create('session_a', owner);
  rejectWrites = true;
  await assert.rejects(host.setGoal('session_a', owner, goal, null, 0), /catalog write failed/u);
  assert.deepEqual(host.goal('session_a', owner), { goal: null, revision: 0 });
  rejectWrites = false;
  assert.deepEqual(await host.setGoal('session_a', owner, goal, null, 0), { goal, revision: 1 });
  rejectWrites = true;
  await assert.rejects(host.clearGoal('session_a', owner, goal.id, 1), /catalog write failed/u);
  assert.deepEqual(host.goal('session_a', owner), { goal, revision: 1 });
  await host.shutdown();
});

test('NND harness session routes bind creation to the complete principal workspace grant', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-nnd-harness-'));
  const configRoot = join(root, 'config');
  await mkdir(configRoot, { recursive: true });
  await writeFile(join(configRoot, 'manifest.json'), JSON.stringify(manifest(root)));
  const factoryOptions = [];
  const engines = [];
  const nndEngineHost = new NndEngineHost({ createEngine: async (options) => {
    factoryOptions.push(options);
    const engine = { config: { executionManifest: null }, active: null, transcript: [], async initialize() {}, async submit() {}, async cancel() { return { accepted: true }; }, async shutdown() {} };
    engines.push(engine);
    return engine;
  } });
  nndEngineHost.nndModel = { providerID: 'primary', modelID: 'test' };
  const service = await startIntegrationServer({
    activation: await activation(root), token: TOKEN, instanceId: 'nna_test', nndEngineHost, nndWorkspaceRoot: root,
    providerStore: new ProviderProfileStore({ configRoot }),
    broker: new SecretBroker({ vaultPath: join(root, 'vault.json'), keyPath: join(root, 'key.json') }), port: 0,
  });
  const base = `http://127.0.0.1:${service.address.port}`;
  try {
    const owner = principal(['nnd.read', 'nnd.session.create'], { workspace_ids: ['w_one', 'w_two'] });
    const health = await request(base, '/global/health', owner);
    assert.deepEqual(health.value, { healthy: true, version: '1.18.31' });
    assert.equal((await request(base, '/path', owner)).value.directory, root);
    const config = await request(base, '/config', owner);
    assert.deepEqual(config.value, {
      model: 'primary/test', default_agent: 'nna',
      nnd: { engine: 'nna', modelSelection: 'configured', primaryModel: { providerID: 'primary', modelID: 'test' } },
    });
    assert.equal(JSON.stringify(config.value).includes('endpoint'), false);
    assert.equal((await request(base, '/config', principal([]))).status, 403);
    assert.deepEqual((await request(base, '/session/status', owner)).value, {});
    assert.equal((await request(base, '/global/health', principal([]))).status, 403);
    const streamAbort = new AbortController();
    const stream = await fetch(`${base}/global/event`, {
      signal: streamAbort.signal,
      headers: { authorization: `Bearer ${TOKEN}`, 'x-nna-principal': Buffer.from(JSON.stringify(owner)).toString('base64url'), accept: 'text/event-stream' },
    });
    assert.equal(stream.status, 200);
    assert.match(stream.headers.get('content-type') ?? '', /text\/event-stream/u);
    streamAbort.abort();
    const created = await request(base, '/session', owner, {
      method: 'POST', body: { title: 'Safe session', dataPaths: 'untrusted', directory: 'C:\\untrusted' },
    });
    assert.equal(created.status, 201);
    assert.equal(created.value.title, 'Safe session');
    assert.equal(created.value.directory, root);
    assert.equal(factoryOptions[0].dataPaths, undefined);
    assert.equal(factoryOptions[0].directory, root);
    assert.equal((await request(base, `/session/${created.value.id}`, principal(['nnd.read'], { workspace_ids: ['w_two'] }))).status, 404);
    assert.deepEqual((await request(base, `/session/${created.value.id}/activity`, owner)).value, []);
    assert.equal((await request(base, `/session/${created.value.id}/activity`, principal([], { workspace_ids: ['w_one', 'w_two'] }))).status, 403);
    assert.equal((await request(base, `/session/${created.value.id}/activity`, principal(['nnd.read'], { workspace_ids: ['w_two'] }))).status, 404);
    const childEngine = { config: { workspaceRoot: root }, active: { finalized: false }, transcript: [
      { type: 'message', role: 'user', content: 'Inspect this' },
      { type: 'message', role: 'assistant', content: 'Private finding' },
    ], steer: async () => ({ accepted: true }) };
    const stopChild = nndEngineHost.childSessions.register('agent_coder_http', created.value.id,
      { subjectId: 'u_test', workspaceIds: ['w_one', 'w_two'] }, childEngine, { type: 'coder' });
    assert.deepEqual((await request(base, '/session', owner)).value.map((session) => session.id), [created.value.id, 'agent_coder_http']);
    assert.deepEqual((await request(base, '/session?roots=true', owner)).value.map((session) => session.id), [created.value.id]);
    assert.deepEqual((await request(base, '/session?roots=false', owner)).value.map((session) => session.id), ['agent_coder_http']);
    assert.deepEqual((await request(base, '/session?limit=1', owner)).value.map((session) => session.id), [created.value.id]);
    assert.equal((await request(base, '/session?limit=0', owner)).status, 400);
    assert.equal((await request(base, '/session?limit=not-a-number', owner)).status, 400);
    assert.deepEqual((await request(base, `/session/${created.value.id}/children`, owner)).value.map((session) => session.id), ['agent_coder_http']);
    const child = await request(base, '/session/agent_coder_http', owner);
    assert.equal(child.value.parentID, created.value.id);
    const childMessages = await request(base, '/session/agent_coder_http/message', owner);
    assert.deepEqual((await request(base, '/session/agent_coder_http/activity', owner)).value, []);
    assert.deepEqual(childMessages.value.map((message) => [message.info.id, message.parts[0].text]), [
      ['agent_coder_http:message:0', 'Inspect this'], ['agent_coder_http:message:1', 'Private finding'],
    ]);
    const newestPage = await request(base, '/session/agent_coder_http/message?limit=1', owner);
    assert.deepEqual(newestPage.value.map((message) => message.parts[0].text), ['Private finding']);
    assert.equal(newestPage.nextCursor, 'agent_coder_http:message:1');
    const olderPage = await request(base, `/session/agent_coder_http/message?limit=1&before=${encodeURIComponent(newestPage.nextCursor)}`, owner);
    assert.deepEqual(olderPage.value.map((message) => message.parts[0].text), ['Inspect this']);
    assert.equal(olderPage.nextCursor, null);
    assert.equal((await request(base, '/session/agent_coder_http/message?limit=1&before=not-a-message', owner)).status, 400);
    assert.equal((await request(base, '/session/agent_coder_http/message?limit=1&before=nnd-live-boundary%3Abm90LWEtbWVzc2FnZQ', owner)).status, 400);
    assert.equal((await request(base, '/session/agent_coder_http/message?limit=1&before=a&before=b', owner)).status, 400);
    assert.equal((await request(base, '/session/agent_coder_http/message?before=agent_coder_http%3Amessage%3A1', owner)).status, 400);
    for (const limit of ['0', '201', 'NaN', '1.5', '1&limit=2']) {
      assert.equal((await request(base, `/session/agent_coder_http/message?limit=${limit}`, owner)).status, 400);
    }
    const partialReader = principal(['nnd.read'], { workspace_ids: ['w_one'] });
    assert.deepEqual((await request(base, '/session', partialReader)).value, []);
    assert.equal((await request(base, '/session/agent_coder_http', partialReader)).status, 404);
    assert.equal((await request(base, '/session/agent_coder_http/message', partialReader)).status, 404);
    assert.equal((await request(base, '/session/agent_coder_http/activity', partialReader)).status, 404);
    assert.equal((await request(base, `/session/${created.value.id}/children`, partialReader)).status, 404);
    nndEngineHost.childSessions.observeOutput('agent_coder_http', {
      type: 'stream_delta', session_id: 'agent_coder_http', turn_id: 'turn_live', text: 'Finalizing',
    });
    const livePage = await request(base, '/session/agent_coder_http/message?limit=1', owner);
    assert.equal(livePage.value[0].info.id, 'agent_coder_http:live');
    assert.match(livePage.nextCursor, /^nnd-live-boundary:/u);
    childEngine.transcript.push({ type: 'message', role: 'assistant', content: 'Finalized' });
    stopChild();
    const afterLivePage = await request(base, `/session/agent_coder_http/message?limit=1&before=${encodeURIComponent(livePage.nextCursor)}`, owner);
    assert.equal(afterLivePage.value[0].parts[0].text, 'Private finding');
    assert.equal(afterLivePage.nextCursor, 'agent_coder_http:message:1');
    assert.equal((await request(base, '/session/agent_coder_http/message', owner)).value[1].parts[0].text, 'Private finding');
    const prompt = await request(base, `/session/${created.value.id}/prompt_async`, principal(['nnd.session.submit'], { workspace_ids: ['w_one', 'w_two'] }), {
      method: 'POST', body: { messageID: 'msg_prompt', model: { providerID: 'primary', modelID: 'test' }, agent: 'nna', parts: [{ type: 'text', text: 'hello NNA' }] },
    });
    assert.equal(prompt.status, 204);
    const wrongModel = await request(base, `/session/${created.value.id}/prompt_async`, principal(['nnd.session.submit'], { workspace_ids: ['w_one', 'w_two'] }), {
      method: 'POST', body: { model: { providerID: 'mock', modelID: 'mock-smart' }, parts: [{ type: 'text', text: 'wrong route' }] },
    });
    assert.equal(wrongModel.status, 400);
    assert.equal(wrongModel.value.error.code, 'nnd_model_override_unsupported');
    const wrongAgent = await request(base, `/session/${created.value.id}/prompt_async`, principal(['nnd.session.submit'], { workspace_ids: ['w_one', 'w_two'] }), {
      method: 'POST', body: { agent: 'build', parts: [{ type: 'text', text: 'wrong agent' }] },
    });
    assert.equal(wrongAgent.status, 400);
    assert.equal(wrongAgent.value.error.code, 'nnd_agent_override_unsupported');
    assert.equal((await request(base, `/session/${created.value.id}/prompt_async`, principal([], { workspace_ids: ['w_one', 'w_two'] }), {
      method: 'POST', body: { parts: [{ type: 'text', text: 'denied' }] },
    })).status, 403);
    assert.equal((await request(base, `/session/${created.value.id}/prompt_async`, principal(['nnd.session.submit'], { workspace_ids: ['w_one', 'w_two'] }), {
      method: 'POST', body: { parts: [] },
    })).status, 400);
    assert.equal((await request(base, `/session/${created.value.id}/prompt_async`, principal(['nnd.read'], { workspace_ids: ['w_one', 'w_two'] }))).status, 405);
    assert.equal((await request(base, '/session/%', owner)).status, 400);
    assert.equal((await request(base, `/session/${created.value.id}`, owner, {
      method: 'PATCH', body: { title: 'Denied rename' },
    })).status, 403);
    const archived = await request(base, `/session/${created.value.id}`, principal(['nnd.session.update'], { workspace_ids: ['w_one', 'w_two'] }), {
      method: 'PATCH', body: { time: { archived: Date.now() } },
    });
    assert.equal(archived.status, 200);
    assert.ok(archived.value.time.archived > 0);
    assert.deepEqual((await request(base, '/session', owner)).value, []);
    assert.equal((await request(base, '/session?archived=true', owner)).value[0].id, created.value.id);
    assert.equal((await request(base, `/session/${created.value.id}`, principal(['nnd.session.update'], { workspace_ids: ['w_one', 'w_two'] }), {
      method: 'PATCH', body: { time: { archived: -1 } },
    })).status, 400);
    const restored = await request(base, `/session/${created.value.id}`, principal(['nnd.session.update'], { workspace_ids: ['w_one', 'w_two'] }), {
      method: 'PATCH', body: { time: { archived: 0 } },
    });
    assert.equal(restored.status, 200);
    assert.equal(restored.value.time.archived, undefined);
    const renamed = await request(base, `/session/${created.value.id}`, principal(['nnd.session.update'], { workspace_ids: ['w_one', 'w_two'] }), {
      method: 'PATCH', body: { title: 'Renamed session' },
    });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.value.title, 'Renamed session');
    engines[0].transcript.push(...Array.from({ length: 251 }, (_, index) => ({ type: 'message', role: 'assistant', content: `history ${index}` })));
    const legacyWindow = await request(base, `/session/${created.value.id}/message`, owner);
    assert.equal(legacyWindow.value.length, 200);
    assert.equal(legacyWindow.value[0].parts[0].text, 'history 51');
    const rootNewest = await request(base, `/session/${created.value.id}/message?limit=200`, owner);
    assert.equal(rootNewest.nextCursor, `${created.value.id}:message:51`);
    const rootOlder = await request(base, `/session/${created.value.id}/message?limit=200&before=${encodeURIComponent(rootNewest.nextCursor)}`, owner);
    assert.equal(rootOlder.value.length, 51);
    assert.equal(rootOlder.value[0].parts[0].text, 'history 0');
    assert.equal(rootOlder.nextCursor, null);
    assert.equal((await request(base, `/session/${created.value.id}/message?limit=1&before=${encodeURIComponent(rootNewest.nextCursor)}`, partialReader)).status, 404);
    assert.equal((await request(base, `/session/${created.value.id}/abort`, owner, { method: 'POST' })).status, 403);
    assert.equal((await request(base, `/session/${created.value.id}/abort`, principal(['nnd.session.abort'], { workspace_ids: ['w_one', 'w_two'] }), { method: 'POST' })).status, 200);
    assert.equal((await request(base, `/session/${created.value.id}`, owner, { method: 'DELETE' })).status, 403);
    const removed = await request(base, `/session/${created.value.id}`, principal(['nnd.session.delete'], { workspace_ids: ['w_one', 'w_two'] }), { method: 'DELETE' });
    assert.equal(removed.status, 200);
    assert.equal(removed.value, true);
    assert.equal((await request(base, `/session/${created.value.id}`, owner)).status, 404);
  } finally { await service.close(); }
});

test('NND goal audit endpoint requires goal-management permission and forwards a scoped request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-nnd-audit-route-'));
  const calls = [];
  const host = { async auditGoal(sessionId, actor, body) {
    calls.push({ sessionId, actor, body });
    return { text: '{"verdict":"continue","note":"More work"}', providerID: 'local', modelID: 'model-x' };
  } };
  const service = await startIntegrationServer({
    activation: await activation(root), token: TOKEN, instanceId: 'nna_test', nndEngineHost: host, port: 0,
  });
  const base = `http://127.0.0.1:${service.address.port}`;
  const path = '/v1/nnd/sessions/session_test/goal-audit';
  const body = { expected_id: 'goal_test', expected_revision: 2, request_id: 'request-1', objective: 'Ship MVP' };
  try {
    assert.equal((await request(base, path, principal(['nnd.read']), { method: 'POST', body })).status, 403);
    assert.equal((await request(base, path, principal(['nnd.goal.manage']))).status, 405);
    assert.equal(calls.length, 0);
    const result = await request(base, path, principal(['nnd.goal.manage']), { method: 'POST', body });
    assert.equal(result.status, 200);
    assert.equal(result.value.modelID, 'model-x');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].sessionId, 'session_test');
    assert.equal(calls[0].actor.subjectId, 'u_test');
    assert.deepEqual(calls[0].body, body);
    host.auditGoal = async () => { throw new ContractError('nnd_goal_audit_conflict', 'goal changed'); };
    assert.equal((await request(base, path, principal(['nnd.goal.manage']), { method: 'POST', body })).status, 409);
    host.auditGoal = async () => { throw new ContractError('nnd_goal_audit_unavailable', 'route changed'); };
    assert.equal((await request(base, path, principal(['nnd.goal.manage']), { method: 'POST', body })).status, 503);
  } finally { await service.close(); }
});

test('NND walkthrough endpoint requires its own generation permission and forwards a scoped digest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-nnd-walkthrough-route-'));
  const calls = [];
  const host = { async generateWalkthrough(sessionId, actor, body) {
    calls.push({ sessionId, actor, body });
    return { text: '{"chapters":[]}', providerID: 'local', modelID: 'small', revision: body.revision };
  } };
  const service = await startIntegrationServer({
    activation: await activation(root), token: TOKEN, instanceId: 'nna_test', nndEngineHost: host, port: 0,
  });
  const base = `http://127.0.0.1:${service.address.port}`;
  const path = '/v1/nnd/sessions/session_test/walkthrough';
  const body = { revision: 'a'.repeat(64), digest: [{ alias: 'h1', scope: 'working',
    path: 'main.js', header: '@@ -1 +1 @@', patch: '-old\n+new' }] };
  try {
    assert.equal((await request(base, path, principal(['nnd.read']), { method: 'POST', body })).status, 403);
    assert.equal((await request(base, path, principal(['nnd.walkthrough.generate']))).status, 405);
    assert.equal(calls.length, 0);
    const result = await request(base, path, principal(['nnd.walkthrough.generate']), { method: 'POST', body });
    assert.equal(result.status, 200);
    assert.equal(result.value.revision, body.revision);
    assert.equal(calls[0].sessionId, 'session_test');
    assert.equal(calls[0].actor.subjectId, 'u_test');
    assert.deepEqual(calls[0].body, body);
    host.generateWalkthrough = async () => { throw new ContractError('nnd_walkthrough_busy', 'busy'); };
    assert.equal((await request(base, path, principal(['nnd.walkthrough.generate']), { method: 'POST', body })).status, 409);
  } finally { await service.close(); }
});

async function request(base, path, actor, options = {}) {
  const response = await fetch(`${base}${path}`, {
    method: options.method ?? 'GET',
    redirect: 'error',
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'x-nna-principal': Buffer.from(JSON.stringify(actor)).toString('base64url'),
      ...(options.body ? { 'content-type': 'application/json' } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, value: text ? JSON.parse(text) : undefined, nextCursor: response.headers.get('x-next-cursor') };
}

function principal(permissions, overrides = {}) {
  return {
    subject_id: 'u_test', platform_role: 'user', permissions,
    workspace_ids: ['w_test'], group_ids: ['g_test'], trace_id: 'trace_test',
    issued_at: new Date().toISOString(), request_id: 'request_test', ...overrides,
  };
}

function manifest(root) {
  return {
    format_version: 1, persistence: 'durable', workspace_root: root,
    providers: [
      { id: 'one', display_name: 'One', endpoint: 'http://127.0.0.1:1/v1', model: 'one', trust_zone: 'loopback' },
      { id: 'two', display_name: 'Two', endpoint: 'http://127.0.0.1:2/v1', model: 'two', trust_zone: 'loopback' },
    ],
    routes: { primary: { provider_id: 'one', model: 'one' } },
  };
}

async function activation(root) {
  const installRoot = join(root, 'nno');
  const integration = join(installRoot, 'nna-integration', 'nno-hosted');
  await mkdir(integration, { recursive: true });
  await writeFile(join(integration, 'integration.json'), JSON.stringify({
    id: 'nno-hosted', ownership: 'nno', scope: 'nno-child-only', nna_integration_protocol: '1.0',
  }));
  return validateNnoIntegrationActivation(installRoot);
}
