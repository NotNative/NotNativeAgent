// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SecretBroker } from '../src/secret-broker.js';
import { startSecretBrokerServer } from '../src/secret-broker-server.js';

const TOKEN = 'test-broker-token-with-at-least-thirty-two-characters';
const USER = principal({ userId: 'u1', permissions: ['secret.read', 'secret.manage'] });
const OTHER = principal({ userId: 'u2', permissions: ['secret.read', 'secret.manage'] });
const ADMIN = principal({ userId: 'admin', platformRole: 'admin' });

test('authenticated broker endpoints are write-only and scope filtered', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-secret-api-'));
  const broker = new SecretBroker({
    realm: 'nno:test', vaultPath: join(root, 'vault.json'), keyPath: join(root, 'key.json'), auditPath: join(root, 'audit.ndjson'),
  });
  const service = await startSecretBrokerServer({ broker, token: TOKEN, port: 0 });
  const base = `http://127.0.0.1:${service.address.port}`;
  try {
    const denied = await fetch(`${base}/v1/secrets`, { headers: headers(USER, 'bad-token') });
    assert.equal(denied.status, 401);
    const created = await json(base, '/v1/secrets', USER, {
      method: 'POST', body: { label: 'Vendor login', kind: 'username_password', scope: { kind: 'user', id: 'u1' }, fields: { username: 'person', password: 'do-not-return' } },
    });
    assert.equal(created.status, 201);
    assert.deepEqual(created.value.secret.fields, ['password', 'username']);
    assert.doesNotMatch(JSON.stringify(created.value), /do-not-return|person/u);
    const own = await json(base, '/v1/secrets', USER);
    const other = await json(base, '/v1/secrets', OTHER);
    assert.equal(own.value.secrets.length, 1);
    assert.equal(other.value.secrets.length, 0);
    const hidden = await json(base, `/v1/secrets/${created.value.secret.id}`, OTHER);
    assert.equal(hidden.status, 404);
    const admin = await json(base, '/v1/secrets', ADMIN);
    assert.equal(admin.value.secrets.length, 1);
  } finally { await service.close(); }
});

test('broker endpoint enforces principal permissions and immutable ownership', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-secret-api-'));
  const broker = new SecretBroker({ realm: 'nno:test', vaultPath: join(root, 'vault.json'), keyPath: join(root, 'key.json') });
  const service = await startSecretBrokerServer({ broker, token: TOKEN, port: 0 });
  const base = `http://127.0.0.1:${service.address.port}`;
  try {
    const reader = principal({ userId: 'u1', permissions: ['secret.read'] });
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
  await assert.rejects(() => startSecretBrokerServer({
    broker: {}, token: TOKEN, host: '0.0.0.0', port: 0,
  }), { code: 'secret_broker_bind_invalid' });
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
    userId: input.userId, platformRole: input.platformRole ?? 'user', permissions: input.permissions ?? [],
    workspaceIds: input.workspaceIds ?? [], groupIds: input.groupIds ?? [], roleIds: input.roleIds ?? [],
  };
}

function headers(actor, token = TOKEN) {
  return { authorization: `Bearer ${token}`, 'x-nna-principal': Buffer.from(JSON.stringify(actor)).toString('base64url') };
}
