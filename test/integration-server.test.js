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
    assert.equal((await request(base, '/v1/provider-profiles', readOnly)).value.profiles.length, 2);
    assert.equal((await request(base, '/v1/provider-profiles', readOnly, {
      method: 'POST', body: { profile_id: 'blocked', endpoint: 'http://127.0.0.1:4/v1', model: 'x' },
    })).status, 403);

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

    const edited = await request(base, '/v1/provider-profiles/lab', manager, {
      method: 'PATCH', body: { display_name: 'Renamed Lab', model: 'model-b' },
    });
    assert.equal(edited.value.profile.display_name, 'Renamed Lab');
    assert.equal(edited.value.profile.profile_id, 'lab');
    assert.equal((await request(base, '/v1/provider-profiles/lab', manager, { method: 'DELETE' })).value.removed, 'lab');
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
  return { status: response.status, value: await response.json() };
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
