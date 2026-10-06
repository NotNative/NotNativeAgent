// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { SecretBroker } from '../src/secret-broker.js';
import { createNndSecretsSettingsService, projectSecretsList } from '../src/nnd-secrets-routes.js';
import { startIntegrationServer } from '../src/integration-server.js';
import { createNndLocalIntegrationActivation } from '../src/nno-integration-activation.js';
import { LOCAL_SECRET_REALM } from '../src/secret-contracts.js';

const identity = { installation_id: 'install_secrets', data_id: 'data_secrets' };
const token = 'secrets-http-test-token-36-chars';
const principal = { subjectId: 'operator@example.com', permissions: ['nnd.configuration.read'] };

const fixture = async () => {
  const root = await mkdtemp(join(homedir(), '.nna-secrets-settings-'));
  const paths = { secretVault: join(root, 'secrets', 'vault.json'),
    secretKey: join(root, 'secrets', 'master-key.json'),
    secretAudit: join(root, 'secrets', 'audit.jsonl') };
  const broker = new SecretBroker({ realm: LOCAL_SECRET_REALM, vaultPath: paths.secretVault,
    keyPath: paths.secretKey, auditPath: paths.secretAudit });
  const service = createNndSecretsSettingsService({ broker, vaultPath: paths.secretVault,
    installationId: identity.installation_id, dataId: identity.data_id });
  return { root, paths, broker, service };
};

test('absent vault reads as absent and a created secret projects redaction-safe', async () => {
  const f = await fixture();
  try {
  const absent = projectSecretsList(await f.service.list());
  assert.equal(absent.source_state, 'absent');
  assert.equal(absent.count, 0);
  assert.deepEqual(absent.secrets, []);
  assert.equal(absent.application, 'next_secret_use');
  assert.equal(absent.scope, 'user');
  const created = await f.broker.create({ label: 'Registry credential', kind: 'api_key',
    fields: { apikey: 'SEALWORTH-API-VALUE-58-CHARS-~'.padEnd(58, 'x') },
    scope: null, metadata: { team: ['fringe', 'core'], region: 'eu-1' } });
  const list = projectSecretsList(await f.service.list());
  assert.equal(list.source_state, 'present');
  assert.equal(list.count, 1);
  const projected = list.secrets[0];
  assert.equal(projected.id, created.id);
  assert.equal(projected.label, 'Registry credential');
  assert.equal(projected.kind, 'api_key');
  assert.equal(projected.scope, null);
  assert.deepEqual(projected.metadata, { team: ['core', 'fringe'], region: 'eu-1' });
  assert.deepEqual(projected.fields, ['apikey']);
  assert.equal(projected.enabled, true);
  assert.match(projected.created_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(projected.rotated_at, null);
  assert.equal(projected.last_used_at, null);
  assert.equal(projected.use_count, 0);
  const serialized = JSON.stringify(projected);
  assert.ok(!serialized.includes('SEALWORTH-API-VALUE-58-CHARS'));
  assert.ok(!serialized.includes('nonce') && !serialized.includes('ciphertext') && !serialized.includes('authTag'));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('vault damage fails closed with the vault codes and the projector refuses drift', async () => {
  const f = await fixture();
  try {
  await f.broker.create({ label: 'Gate secret', kind: 'token', fields: { token: 'x'.repeat(8) } });
  await writeFile(f.paths.secretVault, '{"format":1,"keyVersion":1,"records":[{"bogus":true}]}');
  await assert.rejects(() => f.service.list(), { code: 'secret_vault_corrupt' });
  // Envelope and record drift refuse with the projection code, never a request error.
  assert.throws(() => projectSecretsList({ installationId: 'install_secrets', dataId: 'data_secrets',
    sourceState: 'present', records: [], count: 1 }),
    { code: 'nnd_secrets_projection_invalid' });
  const record = { id: 'sec_00000000-0000-4000-8000-000000000000', realm: LOCAL_SECRET_REALM,
    label: 'L', kind: 'api_key', scope: null, metadata: {}, fields: ['apikey'], enabled: true,
    createdAt: '2026-10-06T00:00:00.000Z', updatedAt: '2026-10-06T00:00:00.000Z',
    rotatedAt: null, lastUsedAt: null, useCount: 0 };
  const envelope = (records) => ({ installationId: 'install_secrets', dataId: 'data_secrets',
    sourceState: 'present', count: records.length, records });
  const driftRefusal = { code: 'nnd_secrets_projection_invalid' };
  assert.throws(() => projectSecretsList(envelope([{ ...record, extra: 1 }])), driftRefusal);
  assert.throws(() => projectSecretsList(envelope([{ ...record, kind: 'other' }])), driftRefusal);
  assert.throws(() => projectSecretsList(envelope([{ ...record, metadata: { team: ['zulu', 'alpha'] } }])),
    driftRefusal);
  assert.throws(() => projectSecretsList(envelope([{ ...record, fields: ['bkey', 'apikey'] }])), driftRefusal);
  assert.throws(() => projectSecretsList(envelope([{ ...record, enabled: 'yes' }])), driftRefusal);
  assert.throws(() => projectSecretsList(envelope([{ ...record, rotatedAt: 'yesterday' }])), driftRefusal);
  // A foreign realm never projects even from a well-formed store.
  assert.throws(() => projectSecretsList(envelope([{ ...record, realm: 'opencode.local' }])),
    driftRefusal);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('http serves catalog pin, refuses wrong methods and unauthorized callers', async () => {
  const f = await fixture();
  const server = await startIntegrationServer({ activation: createNndLocalIntegrationActivation(), token,
    host: '127.0.0.1', port: 0, nndRuntime: { getHost: () => null,
      snapshot: () => ({ service_state: 'setup_required', execution_state: 'unavailable' }) },
    resolvePrincipal: () => principal,
    nndSecretsSettingsService: Object.freeze({ list: async () => ({ installationId: identity.installation_id,
      dataId: identity.data_id, sourceState: 'absent', records: [], count: 0 }) }) });
  try {
    const base = `http://127.0.0.1:${server.address.port}/v1/nnd/configuration/secrets`;
    const call = async (suffix = '', { method = 'GET', bearer = token } = {}) => {
      const response = await fetch(base + suffix, { method,
        headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) } });
      return { status: response.status, body: await response.json().catch(() => null) };
    };
    const catalog = await call('/catalog');
    assert.equal(catalog.status, 200);
    assert.deepEqual(catalog.body.fields.map(field => field.path), ['label', 'kind', 'scope',
      'metadata.{name}', 'fields.{field}', 'enabled']);
    assert.equal((await call('')).status, 200);
    assert.equal((await call('', { method: 'POST' })).status, 405);
    assert.equal((await call('/credentials/save')).status, 404);
    assert.equal((await call('?refresh=1')).status, 400);
    assert.equal((await call('', { bearer: '' })).status, 401);
    // A principal that lacks nnd.configuration.read fails closed with 403.
    const deniedServer = await startIntegrationServer({ activation: createNndLocalIntegrationActivation(), token,
      host: '127.0.0.1', port: 0, nndRuntime: { getHost: () => null,
        snapshot: () => ({ service_state: 'setup_required', execution_state: 'unavailable' }) },
      resolvePrincipal: () => ({ subjectId: 'limited@example.com', permissions: ['nnd.read'] }),
      nndSecretsSettingsService: Object.freeze({ list: async () => ({ installationId: identity.installation_id,
        dataId: identity.data_id, sourceState: 'absent', records: [], count: 0 }) }) });
    try {
      const denied = await fetch(`http://127.0.0.1:${deniedServer.address.port}/v1/nnd/configuration/secrets`,
        { headers: { authorization: `Bearer ${token}` } });
      assert.equal(denied.status, 403);
    } finally { await deniedServer.close(); }
  } finally { await server.close(); await rm(f.root, { recursive: true, force: true }); }
});
