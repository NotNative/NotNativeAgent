// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SecretBroker } from '../src/secret-broker.js';
import { LOCAL_SECRET_REALM } from '../src/secret-contracts.js';
import { nativeNndPrincipal } from '../src/nnd-service-native.js';
import { startIntegrationServer } from '../src/integration-server.js';
import { createNndLocalIntegrationActivation } from '../src/nno-integration-activation.js';

async function fixture(t, ready) {
  const root = await mkdtemp(join(tmpdir(), 'nna-native-secret-routes-'));
  const broker = new SecretBroker({ realm: LOCAL_SECRET_REALM, vaultPath: join(root, 'vault.json'),
    keyPath: join(root, 'key.json'), auditPath: join(root, 'audit.ndjson') });
  const token = 'native-test-credential-'.repeat(3);
  const principal = nativeNndPrincipal(ready ? root : undefined);
  const service = await startIntegrationServer({ activation: createNndLocalIntegrationActivation(), token, broker,
    resolvePrincipal: () => principal, nndRuntime: { getHost: () => null,
      snapshot: () => ({ execution_state: ready ? 'ready' : 'unavailable' }) } });
  t.after(async () => {
    service.server.closeAllConnections(); await service.close();
    assert.ok(root.startsWith(join(tmpdir(), 'nna-native-secret-routes-')));
    await rm(root, { recursive: true, force: true });
  });
  return { broker, principal, async request(path, method = 'GET', body) {
    const response = await fetch(`http://127.0.0.1:${service.address.port}/v1/secrets${path}`, {
      method, headers: { authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
        // Security: caller authority is ignored by the native-owned listener.
        'x-nna-principal': Buffer.from(JSON.stringify({ permissions: ['*'] })).toString('base64url') },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    assert.doesNotMatch(text, /original-private-value|rotated-private-value|foreign-private-value/u);
    return { status: response.status, body: JSON.parse(text) };
  } };
}

for (const ready of [false, true]) test(`native secret management is scoped and write-only while ready=${ready}`, async (t) => {
  const { request, broker, principal } = await fixture(t, ready);
  assert.ok(!principal.permissions.includes('secret.use'));
  assert.ok(!principal.permissions.includes('secret.scope.all'));
  const created = await request('', 'POST', { label: 'Provider key', kind: 'api_key',
    scope: { kind: 'user', id: principal.subjectId }, fields: { api_key: 'original-private-value' } });
  assert.equal(created.status, 201);
  const id = created.body.secret.id;
  assert.deepEqual(created.body.secret.fields, ['api_key']);
  assert.equal((await request(`/${id}/values`, 'PUT', { fields: { api_key: 'rotated-private-value' } })).status, 200);
  assert.equal((await request(`/${id}`)).status, 200);
  const foreign = await broker.create({ label: 'Other user', kind: 'api_key',
    scope: { kind: 'user', id: 'another-operator' }, fields: { api_key: 'foreign-private-value' } });
  const listed = await request('');
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.secrets.map((item) => item.id), [id]);
  assert.equal((await request(`/${foreign.id}`)).status, 404);
  assert.equal((await request(`/${foreign.id}/values`, 'PUT', { fields: { api_key: 'rotated-private-value' } })).status, 404);
  assert.equal((await request('', 'POST', { label: 'Forbidden', kind: 'api_key',
    scope: { kind: 'deployment' }, fields: { api_key: 'original-private-value' } })).status, 403);
  assert.equal((await request(`/${id}`, 'PATCH', { scope: { kind: 'user', id: 'another-operator' } })).status, 403);
  assert.equal((await request(`/${id}/values`)).status, 405);
  assert.equal((await request(`/${id}/use`, 'POST', {})).status, ready ? 403 : 503);
  const audit = await request('/audit');
  assert.equal(audit.status, 200);
  assert.ok(audit.body.events.length > 0);
  assert.ok(audit.body.events.every((event) => event.scope?.id === principal.subjectId));
});
