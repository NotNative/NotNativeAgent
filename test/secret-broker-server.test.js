// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SecretBroker } from '../src/secret-broker.js';
import { startSecretBrokerServer } from '../src/secret-broker-server.js';
import { validateNnoIntegrationActivation } from '../src/nno-integration-activation.js';

const TOKEN = 'test-broker-token-with-at-least-thirty-two-characters';
const USER = principal({ subjectId: 'u1', permissions: ['secret.read', 'secret.manage', 'secret.use'] });
const OTHER = principal({ subjectId: 'u2', permissions: ['secret.read', 'secret.manage', 'secret.use'] });
const ADMIN = principal({ subjectId: 'admin', platformRole: 'admin', permissions: ['secret.read', 'secret.audit', 'secret.scope.all'] });

test('authenticated broker management is metadata-only and scope filtered', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-secret-api-'));
  const broker = new SecretBroker({
    realm: 'nno:test', vaultPath: join(root, 'vault.json'), keyPath: join(root, 'key.json'), auditPath: join(root, 'audit.ndjson'),
  });
  const service = await startSecretBrokerServer({ broker, token: TOKEN, port: 0, activation: await activation(root) });
  const base = `http://127.0.0.1:${service.address.port}`;
  try {
    const denied = await fetch(`${base}/v1/secrets`, { headers: headers(USER, 'bad-token') });
    assert.equal(denied.status, 401);
    const created = await json(base, '/v1/secrets', USER, {
      method: 'POST', body: {
        label: 'Vendor login', kind: 'username_password', scope: { kind: 'user', id: 'u1' },
        metadata: { ownerUserId: 'u1', allowedCapabilities: ['vendor.price.read'] },
        fields: { username: 'person', password: 'do-not-return' },
      },
    });
    assert.equal(created.status, 201);
    assert.deepEqual(created.value.secret.fields, ['password', 'username']);
    assert.deepEqual(created.value.secret.metadata.allowedCapabilities, ['vendor.price.read']);
    assert.doesNotMatch(JSON.stringify(created.value), /do-not-return|person/u);
    const own = await json(base, '/v1/secrets', USER);
    const other = await json(base, '/v1/secrets', OTHER);
    assert.equal(own.value.secrets.length, 1);
    assert.equal(other.value.secrets.length, 0);
    const hidden = await json(base, `/v1/secrets/${created.value.secret.id}`, OTHER);
    assert.equal(hidden.status, 404);
    const admin = await json(base, '/v1/secrets', ADMIN);
    assert.equal(admin.value.secrets.length, 1);
    const updated = await json(base, `/v1/secrets/${created.value.secret.id}`, USER, {
      method: 'PATCH', body: { label: 'Vendor account', metadata: { ownerUserId: 'u1', description: 'Retail login' } },
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.value.secret.label, 'Vendor account');
    const used = await json(base, `/v1/secrets/${created.value.secret.id}/use`, USER, {
      method: 'POST', body: {
        consumer: 'nno.module', destination: 'vendor.price.read', purpose: 'mission test',
        reviewerDecisionId: 'nno-policy-test', sessionId: 'mission-1',
      },
    });
    assert.equal(used.status, 200);
    assert.deepEqual(used.value.fields, { username: 'person', password: 'do-not-return' });
    const audit = await json(base, '/v1/secrets/audit?limit=20', ADMIN);
    assert.equal(audit.status, 200);
    assert.equal(audit.value.events.some((event) => event.event === 'secret.used'), true);
  } finally { await service.close(); }
});

test('broker endpoint enforces principal permissions and immutable ownership', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-secret-api-'));
  const broker = new SecretBroker({ realm: 'nno:test', vaultPath: join(root, 'vault.json'), keyPath: join(root, 'key.json') });
  const service = await startSecretBrokerServer({ broker, token: TOKEN, port: 0, activation: await activation(root) });
  const base = `http://127.0.0.1:${service.address.port}`;
  try {
    const reader = principal({ subjectId: 'u1', permissions: ['secret.read'] });
    const forbidden = await json(base, '/v1/secrets', reader, {
      method: 'POST', body: { label: 'x', kind: 'token', scope: { kind: 'user', id: 'u1' }, fields: { token: 'value' } },
    });
    assert.equal(forbidden.status, 403);
    const wrongScope = await json(base, '/v1/secrets', USER, {
      method: 'POST', body: { label: 'x', kind: 'token', scope: { kind: 'user', id: 'u2' }, fields: { token: 'value' } },
    });
    assert.equal(wrongScope.status, 403);
  } finally { await service.close(); }
});

test('secret broker service refuses non-loopback binding', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-secret-api-'));
  const validActivation = await activation(root);
  await assert.rejects(() => startSecretBrokerServer({
    broker: {}, token: TOKEN, host: '0.0.0.0', port: 0, activation: validActivation,
  }), { code: 'secret_broker_bind_invalid' });
});

test('secret broker service remains dormant without an installed NNO activation', async () => {
  await assert.rejects(() => startSecretBrokerServer({ broker: {}, token: TOKEN, port: 0 }), {
    code: 'nno_integration_activation_required',
  });
  const root = await mkdtemp(join(tmpdir(), 'nna-secret-api-'));
  await assert.rejects(() => validateNnoIntegrationActivation(root), { code: 'nno_integration_activation_missing' });
});

async function json(base, path, actor, options = {}) {
  const response = await fetch(`${base}${path}`, {
    method: options.method ?? 'GET', headers: { ...headers(actor), ...(options.body ? { 'content-type': 'application/json' } : {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  return { status: response.status, value: await response.json() };
}

function principal(input) {
  return {
    subject_id: input.subjectId, platform_role: input.platformRole ?? 'user', permissions: input.permissions ?? [],
    workspace_ids: input.workspaceIds ?? [], group_ids: input.groupIds ?? [],
    trace_id: 'trace_test', issued_at: new Date().toISOString(), request_id: 'request_test',
  };
}

function headers(actor, token = TOKEN) {
  return { authorization: `Bearer ${token}`, 'x-nna-principal': Buffer.from(JSON.stringify(actor)).toString('base64url') };
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
