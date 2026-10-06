// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createNndLocalIntegrationActivation } from '../src/nno-integration-activation.js';
import { createNndMcpCredentialsService } from '../src/nnd-mcp-credentials-transaction.js';
import { managedMcpCredentialReference } from '../src/mcp-credentials.js';
import { startIntegrationServer } from '../src/integration-server.js';

const principal = { subjectId: 'operator@example.com', permissions: ['nnd.configuration.read', 'nnd.configuration.manage'] };
const readOnly = { subjectId: 'operator@example.com', permissions: ['nnd.configuration.read'] };
const identity = { installation_id: 'install_test', data_id: 'data_test', scope: 'user' };
const token = 'mcp-credentials-http-test-token-38-chars';
const SECRET = 's'.repeat(21);

async function fixture(t, init) {
  const root = await mkdtemp(join(homedir(), '.nna-mcp-tx-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = { mcpCredentials: join(root, 'config', 'mcp-credentials.json') };
  if (init) await writeFile(paths.mcpCredentials, JSON.stringify(init));
  const environment = {};
  const service = createNndMcpCredentialsService({ paths, installationId: identity.installation_id,
    dataId: identity.data_id, environment });
  const saveInput = (serverId, tokenValue, operationId) => ({ ...identity, server_id: serverId,
    token: tokenValue, operation_id: operationId });
  const deleteInput = (reference, operationId) => ({ ...identity, reference, operation_id: operationId });
  return { paths, service, environment, saveInput, deleteInput };
}

const assertNoSecret = (value, label) => assert.equal(JSON.stringify(value).includes(SECRET), false,
  `${label} must never carry a token value`);

test('an absent store lists honestly and a save bootstraps the store with the derived reference', async t => {
  const f = await fixture(t);
  const before = await f.service.read(principal);
  assert.equal(before.source_state, 'absent');
  assert.equal(before.count, 0);
  assert.deepEqual(before.credentials, []);
  assert.equal(before.application, 'next_server_spawn');
  assert.equal(await readFile(f.paths.mcpCredentials).then(() => 'exists', (error) => error.code), 'ENOENT');
  const receipt = await f.service.save(principal, f.saveInput('prod-db', SECRET, 'mcp_save_1'));
  const expectedReference = managedMcpCredentialReference('prod-db');
  assert.match(expectedReference, /^NNA_MCP_MANAGED_[A-Z0-9_]+_[0-9A-F]{12}_TOKEN$/u);
  assert.equal(receipt.persistence, 'saved');
  assert.equal(receipt.reference, expectedReference);
  assert.equal(receipt.application, 'next_server_spawn');
  assertNoSecret(receipt, 'receipt');
  const reference = managedMcpCredentialReference('prod-db');
  const stored = JSON.parse(await readFile(f.paths.mcpCredentials, 'utf8'));
  assert.deepEqual(stored, { format_version: 1, credentials: { [reference]: SECRET } });
  assert.equal(f.environment[reference], SECRET, 'the save applies the token to the environment');
  const after = await f.service.read(principal);
  assert.equal(after.source_state, 'present');
  assert.deepEqual(after.credentials, [{ reference, applied: true }]);
  assert.equal(after.count, 1);
  assertNoSecret(after, 'list');
  await assert.rejects(() => f.service.save(readOnly, f.saveInput('other', SECRET, 'nope')),
    { code: 'integration_permission_denied' }, 'save needs the manage right');
  void token;
});

test('request grammar and the domain validator stay native: ids, tokens, and the store refuse honestly', async t => {
  const f = await fixture(t);
  await assert.rejects(() => f.service.save(principal, f.saveInput('with control\u0000char', SECRET, 'bad_server')),
    { code: 'nnd_mcp_credentials_request_invalid' }, 'the server id must be printable and bounded');
  await assert.rejects(() => f.service.save(principal, f.saveInput('prod-db', '', 'empty_token')),
    { code: 'mcp_token_invalid' }, 'an empty token is the domain refusal');
  await assert.rejects(() => f.service.save(principal, f.saveInput('prod-db', 'a\nb', 'newline_token')),
    { code: 'mcp_token_invalid' });
  await assert.rejects(() => f.service.save(principal, f.saveInput('prod-db', 'x'.repeat(16_385), 'large_token')),
    { code: 'mcp_token_invalid' }, 'the token bound stays the domain bound');
  await assert.rejects(() => f.service.remove(principal, f.deleteInput('NNA_MCP_UNMANAGED_FOREIGN', 'bad_ref')),
    { code: 'nnd_mcp_credentials_request_invalid' }, 'only managed references are accepted');
  // The domain functions own the store: a corrupt store reads and saves fail closed.
  await f.service.save(principal, f.saveInput('seed', SECRET, 'seed_save'));
  await writeFile(f.paths.mcpCredentials, '{"format_version":1,"credentials":{"BROKEN":1}}');
  await assert.rejects(() => f.service.read(principal), { code: 'mcp_credentials_invalid' });
  await assert.rejects(() => f.service.save(principal, f.saveInput('next', SECRET, 'broken_save')),
    { code: 'mcp_credentials_invalid' });
});

test('upsert idempotence and honest deletes: same server id keeps one reference, foreign deletes are no-ops', async t => {
  const f = await fixture(t);
  const first = await f.service.save(principal, f.saveInput('prod-db', SECRET, 'save_a'));
  const sameAgain = await f.service.save(principal, f.saveInput('prod-db', SECRET, 'save_b'));
  assert.equal(sameAgain.reference, first.reference, 'the derived reference is deterministic');
  assert.equal(sameAgain.persistence, 'saved');
  const store = JSON.parse(await readFile(f.paths.mcpCredentials, 'utf8'));
  assert.equal(Object.keys(store.credentials).length, 1, 'an upsert adds no second entry');
  const foreign = await f.service.remove(principal, f.deleteInput('NNA_MCP_MANAGED_ALT_SERVER_TOKEN', 'foreign_delete'));
  assert.equal(foreign.persistence, 'absent', 'a missing managed reference is an honest no-op');
  const gone = await f.service.remove(principal, f.deleteInput(first.reference, 'real_delete'));
  assert.equal(gone.persistence, 'deleted');
  assert.equal(JSON.stringify(gone).includes(SECRET), false);
  const shrunk = JSON.parse(await readFile(f.paths.mcpCredentials, 'utf8'));
  assert.deepEqual(shrunk.credentials, {}, 'the store kept the grammar after the delete');
  assert.equal(f.environment[first.reference], undefined, 'the token leaves the environment with the delete');
});

function body(value) { return JSON.stringify(value); }

async function httpFixture(t) {
  const root = await mkdtemp(join(homedir(), '.nna-mcp-http-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = { mcpCredentials: join(root, 'config', 'mcp-credentials.json') };
  const principalBox = { value: principal };
  const service = createNndMcpCredentialsService({ paths, installationId: identity.installation_id,
    dataId: identity.data_id, environment: {} });
  const server = await startIntegrationServer({ activation: createNndLocalIntegrationActivation(), token,
    host: '127.0.0.1', port: 0, nndRuntime: { getHost: () => null,
      snapshot: () => ({ service_state: 'setup_required', execution_state: 'unavailable' }) },
    resolvePrincipal: () => principalBox.value, nndMcpCredentialsService: service });
  t.after(() => server.close());
  const endpoint = `http://127.0.0.1:${server.address.port}`;
  const base = '/v1/nnd/configuration/mcp-credentials';
  const call = async (suffix = '', { method = 'GET', bearer = token, search = '', principalOverride,
    value } = {}) => {
    if (principalOverride) principalBox.value = principalOverride;
    try {
      const response = await fetch(endpoint + base + suffix + search, { method,
        headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
          ...(value !== undefined ? { 'content-type': 'application/json' } : {}) },
        ...(value !== undefined ? { body: body(value) } : {}) });
      return { status: response.status, body: await response.json().catch(() => null) };
    } finally { if (principalOverride) principalBox.value = principal; }
  };
  return { call, paths };
}

test('MCP credential HTTP serves the one-field catalog, gates by permission, and never projects tokens', async t => {
  const { call, paths } = await httpFixture(t);
  assert.equal((await call('', { bearer: null })).status, 401);
  const list = await call();
  assert.equal(list.status, 200);
  assert.equal(list.body.source_state, 'absent');
  const catalog = await call('/catalog');
  assert.equal(catalog.status, 200);
  assert.deepEqual(catalog.body.fields.map((field) => field.path),
    ['credentials.{NNA_MCP_MANAGED_reference}']);
  assert.equal(catalog.body.fields[0].type, 'secret');
  assert.equal(catalog.body.fields[0].application, 'next_server_spawn');
  assert.equal(catalog.body.fields[0].editability.required_permission, 'nnd.configuration.manage');
  assert.equal((await call('', { method: 'POST' })).status, 405);
  assert.equal((await call('/unknown')).status, 404);
  assert.equal((await call('', { search: '?refresh=1' })).status, 400);
  assert.equal((await call('/credentials/save', { method: 'POST', principalOverride: readOnly,
    value: {} })).status, 403);
  const saved = await call('/credentials/save', { method: 'POST', value: { ...identity,
    server_id: 'prod-db', token: SECRET, operation_id: 'http_mcp_save' } });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.persistence, 'saved');
  assert.match(saved.body.reference, /^NNA_MCP_MANAGED_[A-Z0-9_]+_[0-9A-F]{12}_TOKEN$/u);
  assertNoSecret(saved, 'receipt');
  const reference = managedMcpCredentialReference('prod-db');
  const listed = await call();
  assert.equal(listed.body.credentials[0].reference, reference);
  assert.equal(listed.body.credentials[0].applied, true, 'the HTTP environment got the token key');
  assertNoSecret(listed, 'list');
  const stored = JSON.parse(await readFile(paths.mcpCredentials, 'utf8'));
  assert.equal(stored.credentials[reference], SECRET);
  const deleted = await call('/credentials/delete', { method: 'POST', value: { ...identity,
    reference: saved.body.reference, operation_id: 'http_mcp_delete' } });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.persistence, 'deleted');
  const after = await call();
  assert.equal(after.body.source_state, 'present');
  assert.equal(after.body.count, 0);
  assert.equal(JSON.stringify(after.body).includes(SECRET), false);
});
