// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createScratchSync } from './scratch.js';
import { startIntegrationServer } from '../src/integration-server.js';
import { ProviderProfileStore } from '../src/provider/profile-store.js';
import { validateNnoIntegrationActivation } from '../src/nno-integration-activation.js';

const TOKEN = 'token_connection_contract_0000000000000001';

function principal(permissions) {
  return {
    subject_id: 'u_test', platform_role: 'user', permissions,
    workspace_ids: ['w_test'], group_ids: ['g_test'], trace_id: 'trace_test',
    issued_at: new Date().toISOString(), request_id: 'request_test',
  };
}

async function request(base, path, who, options = {}) {
  const response = await fetch(`${base}${path}`, {
    method: options.method ?? 'GET',
    redirect: 'error',
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'x-nna-principal': Buffer.from(JSON.stringify(who)).toString('base64url'),
      ...(options.body ? { 'content-type': 'application/json' } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, value: text ? JSON.parse(text) : null };
}

async function fixture() {
  const root = createScratchSync('.nna-connection-contract-');
  const configRoot = join(root, 'config');
  await mkdir(configRoot, { recursive: true });
  const document = {
    format_version: 2, manifest_connection_version: 1, persistence: 'durable',
    connections: [{ id: 'lan', display_name: 'LAN box', endpoint: 'http://127.0.0.1:1234/v1', trust_zone: 'loopback' }],
    model_selections: [
      { id: 'big', connection_id: 'lan', model: 'glm' },
      { id: 'fast', connection_id: 'lan', model: 'qwen', context_limit_bytes: 300_000 },
    ],
    routes: { primary: { selection_id: 'big', model: 'glm' } },
  };
  const bytes = `${JSON.stringify(document, null, 2)}\n`;
  await writeFile(join(configRoot, 'manifest.json'), bytes);
  return { root, configRoot, document, revision: createHash('sha256').update(bytes).digest('hex') };
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

test('the connection contract serves stored records and never a credential value', async () => {
  const f = await fixture();
  const providerStore = new ProviderProfileStore({ configRoot: f.configRoot, environment: {} });
  const service = await startIntegrationServer({ activation: await activation(f.root), token: TOKEN, instanceId: 'nna_test', providerStore, port: 0 });
  const base = `http://127.0.0.1:${service.address.port}`;
  try {
    const reader = principal(['provider.read']);
    const listed = await request(base, '/v1/connections', reader);
    assert.equal(listed.status, 200, JSON.stringify(listed.value));
    assert.deepEqual(listed.value.connections.map((item) => item.connection_id), ['lan']);
    assert.equal(listed.value.connections[0].display_name, 'LAN box');
    assert.equal(listed.value.connections[0].credential, null);
    // Why: two models on one endpoint are two selections on one connection.
    assert.deepEqual(listed.value.selections.map((item) => [item.selection_id, item.model]),
      [['big', 'glm'], ['fast', 'qwen']]);
    assert.equal(listed.value.selections.find((item) => item.selection_id === 'fast').context_limit_bytes, 300_000);
    assert.equal(listed.value.selections.find((item) => item.selection_id === 'big').active, true);

    const one = await request(base, '/v1/connections/lan', reader);
    assert.equal(one.value.connection.connection_id, 'lan');
    assert.equal(one.value.selections.length, 2);
    assert.equal((await request(base, '/v1/connections/missing', reader)).status, 404);

    const models = await request(base, '/v1/models', reader);
    assert.deepEqual(models.value.models.map((item) => `${item.connection_name}/${item.model}`),
      ['LAN box/glm', 'LAN box/qwen']);
    assert.deepEqual(models.value.configured_primary_route, { connection_id: 'big', model: 'glm' });

    const routes = await request(base, '/v1/routes', reader);
    assert.equal(routes.value.roles.primary.connection_id, 'big');
    assert.equal(routes.value.roles.reviewer.connection_id, 'big');
    assert.equal(routes.value.roles.reviewer.assigned, false);
  } finally {
    await service.close();
  }
});

test('the connection contract requires provider.read and refuses a write it does not define', async () => {
  const f = await fixture();
  const providerStore = new ProviderProfileStore({ configRoot: f.configRoot, environment: {} });
  const service = await startIntegrationServer({ activation: await activation(f.root), token: TOKEN, instanceId: 'nna_test', providerStore, port: 0 });
  const base = `http://127.0.0.1:${service.address.port}`;
  try {
    const unprivileged = principal(['integration.health']);
    assert.equal((await request(base, '/v1/connections', unprivileged)).status, 403);
    assert.equal((await request(base, '/v1/models', unprivileged)).status, 403);
    assert.equal((await request(base, '/v1/routes', unprivileged)).status, 403);
    const reader = principal(['provider.read']);
    // Why: the connection contract is read-only in this release, so a write is a method error, not a
    // silently accepted mutation.
    assert.equal((await request(base, '/v1/connections', reader, { method: 'POST', body: { id: 'x' } })).status, 405);
    assert.equal((await request(base, '/v1/models', reader, { method: 'POST', body: {} })).status, 405);
  } finally {
    await service.close();
  }
});
