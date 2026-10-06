// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createNndLocalIntegrationActivation } from '../src/nno-integration-activation.js';
import { createNativeNndTrustServices, projectTrustList } from '../src/nnd-trust-routes.js';
import { SessionLock } from '../src/persistence/session-lock.js';
import { startIntegrationServer } from '../src/integration-server.js';

const base = '/v1/nnd/configuration/trust';
const token = 'trust-route-http-test-token-35-characters-long';
const READER = { subjectId: 'reader@example.com', permissions: ['nnd.configuration.read'] };
const OPERATOR = { subjectId: 'operator@example.com',
  permissions: ['nnd.configuration.read', 'nnd.configuration.manage', 'nnd.workspace.manage'] };
const CENSUS_FIELDS = ['version', 'workspaces[*].root', 'workspaces[*].trustedAt'];

test('trust service grants, lists, and revokes through the native trust functions', async t => {
  const root = await mkdtemp(join(homedir(), '.nna-trust-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'config', 'trusted-workspaces.json');
  await mkdir(dirname(path), { recursive: true });
  const service = createNativeNndTrustServices({ path, installationId: 'install_test', dataId: 'data_test' });
  const empty = projectTrustList(await service.list());
  assert.deepEqual([empty.version, empty.workspaces, empty.source, empty.application, empty.fields],
    [1, [], 'trust', 'project_configuration', CENSUS_FIELDS]);
  await assert.rejects(() => service.grant(join(root, 'gone')), { code: 'workspace_trust_target_missing' },
    'grant requires an existing workspace root, exactly like the native admission check');
  const granted = await service.grant(root);
  assert.deepEqual([granted.operation, granted.trusted, granted.root, granted.scope, granted.application],
    ['grant', true, root, 'user', 'project_configuration']);
  const nested = join(root, 'nested');
  await mkdir(nested);
  assert.equal((await service.grant(nested)).trusted, true);
  const listed = projectTrustList(await service.list());
  assert.deepEqual(listed.workspaces.map((item) => item.root), [root, nested].sort());
  assert.match(listed.workspaces[0].trusted_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  const revoked = await service.revoke(nested);
  assert.deepEqual([revoked.operation, revoked.trusted], ['revoke', false]);
  const revokedGone = await service.revoke(join(root, 'retired'));
  assert.deepEqual([revokedGone.operation, revokedGone.trusted, revokedGone.root],
    ['revoke', false, join(root, 'retired')], 'revoking a gone root is an honest no-op receipt');
  assert.equal(projectTrustList(await service.list()).workspaces.length, 1);
  await writeFile(path, '{"version":1,"workspaces":"banana"}');
  await assert.rejects(() => service.list(), { code: 'workspace_trust_invalid' },
    'a corrupt store never degrades to an empty list — absence would admit unsafe flows');
});

test('trust projection refuses factory drift and identity lies', () => {
  const basis = { version: 1, workspaces: [{ root: join('x', 'y'), trustedAt: '2026-10-06T01:02:03.004Z' }],
    installationId: 'install_test', dataId: 'data_test' };
  assert.throws(() => projectTrustList({ ...basis, workspaces: [{ root: '', trustedAt: 'x' }] }));
  assert.throws(() => projectTrustList({ ...basis, workspaces: [{ root: 'ok', trustedAt: 5 }] }));
  assert.throws(() => projectTrustList({ ...basis, workspaces: [{ root: 'ok', trustedAt: 'x', extra: 1 }] }));
  assert.throws(() => projectTrustList({ ...basis, installationId: 'invalid identity string' }));
  assert.throws(() => projectTrustList({ ...basis, version: 2 }));
  assert.throws(() => projectTrustList(null));
});

async function httpFixture(t) {
  const root = await mkdtemp(join(homedir(), '.nna-trust-http-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'trusted-workspaces.json');
  const principalBox = { value: OPERATOR };
  const server = await startIntegrationServer({ activation: createNndLocalIntegrationActivation(), token,
    host: '127.0.0.1', port: 0, nndRuntime: { getHost: () => null,
      snapshot: () => ({ service_state: 'setup_required', execution_state: 'unavailable' }) },
    resolvePrincipal: () => principalBox.value, nndTrustService: createNativeNndTrustServices(
      { path, installationId: 'install_test', dataId: 'data_test' }) });
  t.after(() => server.close());
  const endpoint = `http://127.0.0.1:${server.address.port}`;
  const call = async (suffix = '', { method = 'GET', bearer = token, search = '', identity,
    body } = {}) => {
    if (identity) principalBox.value = identity;
    try {
      const response = await fetch(endpoint + base + suffix + search, { method,
        headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      return { status: response.status, body: await response.json().catch(() => null) };
    } finally { if (identity) principalBox.value = OPERATOR; }
  };
  return { call, root };
}

test('trust HTTP offers the catalog, honest refusals, and an operator-only mutation gate', async t => {
  const { call, root } = await httpFixture(t);
  assert.equal((await call('', { bearer: null })).status, 401);
  const read = await call();
  assert.equal(read.status, 200);
  assert.deepEqual([read.body.version, read.body.workspaces.length, read.body.fields], [1, 0, CENSUS_FIELDS]);
  const catalog = await call('/catalog');
  assert.equal(catalog.status, 200);
  assert.deepEqual(catalog.body.fields.map((field) => field.path), CENSUS_FIELDS);
  assert.equal(catalog.body.fields[1].operations.join(','), 'grant,revoke');
  assert.equal(catalog.body.fields[1].editability.available, true);
  assert.equal(catalog.body.fields[0].editability.reason, 'generated_state');
  const gone = await call('/grant', { method: 'POST', body: { root: join(root, 'gone') } });
  assert.equal(gone.status, 404);
  assert.equal(gone.body.error.code, 'workspace_trust_target_missing');
  assert.equal((await call('/grant', { method: 'POST', body: { nope: true } })).status, 400);
  assert.equal((await call('/grant', { method: 'POST', body: { root: 'x'.repeat(33_000) } })).status, 400);
  assert.equal((await call('', { search: '?refresh=1' })).status, 400);
  assert.equal((await call('/grant', { method: 'POST', search: '?x=1', body: { root: root } })).status, 400);
  assert.equal((await call('/unknown', { method: 'POST' })).status, 404);
  assert.equal((await call('', { method: 'PUT' })).status, 405);
  const readerGrant = await call('/grant', { method: 'POST', identity: READER, body: { root } });
  assert.equal(readerGrant.status, 403, 'read-only principal cannot grant on the settings surface');
  const readerCatalog = await call('/catalog', { identity: READER });
  assert.equal(readerCatalog.status, 200, 'catalog reading is within the read permission');
});

test('trust HTTP grants an existing root, reflects the list, and maps lock contention to 409', async t => {
  const { call, root } = await httpFixture(t);
  const grant = await call('/grant', { method: 'POST', body: { root } });
  assert.equal(grant.status, 200);
  assert.deepEqual([grant.body.operation, grant.body.trusted, grant.body.root], ['grant', true, root]);
  const listed = await call();
  assert.deepEqual(listed.body.workspaces.map((item) => item.root), [root]);
  const lock = new SessionLock(root, 'workspace-trust');
  await lock.acquire();
  try {
    const busy = await call('/grant', { method: 'POST', body: { root } });
    assert.equal(busy.status, 409);
    assert.equal(busy.body.error.code, 'workspace_trust_busy');
  } finally { await lock.release(); }
  const revoke = await call('/revoke', { method: 'POST', body: { root } });
  assert.deepEqual([revoke.status, revoke.body.operation, revoke.body.trusted], [200, 'revoke', false]);
  const emptyAgain = await call();
  assert.equal(emptyAgain.body.workspaces.length, 0);
});
