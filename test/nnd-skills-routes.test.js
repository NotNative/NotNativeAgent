// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createNndSkillsService, dispatchNndSkillsRequest } from '../src/nnd-skills-routes.js';
import { startIntegrationServer } from '../src/integration-server.js';
import { createNndLocalIntegrationActivation } from '../src/nno-integration-activation.js';
import { ContractError } from '../src/ids.js';

const base = '/v1/nnd/configuration/skills';
const token = 'skills-http-token-32-characters-long-tests';
const PERMITTED = { subjectId: 'operator@example.com', permissions: ['nnd.configuration.read'] };

const skill = (id, extra = {}) => ({ id, version: '1', description: `demo ${id}`,
  invocation: 'both', source: 'bundled:demo', requiresTools: [], bodySha256: 'a'.repeat(64), ...extra });

function registryStub(entries, diagnostics = []) {
  const registry = { initialize: async () => entries, catalog: () => structuredClone(entries),
    diagnostics: () => diagnostics };
  return registry;
}

test('skills service initializes the workspace registry and projects one catalog grammar', async () => {
  const paths = { trustedWorkspaces: join(tmpdir(), 'nnd-skills-trust-missing.json'), skills: 'C:\\nna\\skills' };
  const service = createNndSkillsService({ paths, installationId: 'install_skills', dataId: 'data_skills',
    trustedCheck: async () => true, registryFactory: () => registryStub([skill('demo.one')], [
      { status: 'skipped', scope: 'user', path: 'C:\\nna\\skills\\broken.md', code: 'skill_duplicate', message: 'duplicate skill demo.one' },
    ]) });
  const receipt = await service.catalog('C:\\workspace');
  assert.deepEqual(Object.keys(receipt).sort(), ['catalog', 'data_id', 'diagnostics',
    'installation_id', 'schema_version', 'scope', 'scope_root', 'trusted']);
  assert.equal(receipt.trusted, true);
  assert.equal(receipt.scope, 'workspace');
  assert.equal(receipt.catalog.length, 1);
  assert.deepEqual(Object.keys(receipt.catalog[0]).sort(), ['bodySha256', 'description',
    'id', 'invocation', 'requiresTools', 'source', 'version']);
  assert.equal(receipt.diagnostics[0].scope, 'user');
  await assert.rejects(service.catalog(''), { code: 'nnd_skills_request_invalid' },
    'an empty workspace root is a request refusal');
});

test('skills HTTP serves the catalog receipt with honest failure codes', async t => {
  const impl = createNndSkillsService({ paths: { trustedWorkspaces: 'C:\\nna\\config\\trusted-workspaces.json',
    skills: 'C:\\nna\\skills' }, installationId: 'install_skills', dataId: 'data_skills',
    trustedCheck: async () => false,
    registryFactory: () => registryStub([skill('demo.one'), skill('demo.two', { invocation: 'agent' })]) });
  const server = await startIntegrationServer({ activation: createNndLocalIntegrationActivation(), token,
    host: '127.0.0.1', port: 0,
    nndRuntime: { getHost: () => ({ workspaceRoot: 'C:\\workspace' }),
      snapshot: () => ({ service_state: 'setup_required', execution_state: 'unavailable' }) },
    resolvePrincipal: () => PERMITTED, nndSkillsService: impl });
  t.after(() => server.close());
  const endpoint = `http://127.0.0.1:${server.address.port}`;
  const call = async (suffix = '', { method = 'GET', bearer = token } = {}) => {
    const response = await fetch(endpoint + base + suffix, { method,
      headers: { authorization: bearer ? `Bearer ${bearer}` : '' } });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  assert.equal((await call('', { bearer: null })).status, 401);
  assert.equal((await call('', { method: 'POST' })).status, 405, 'bare base stays method-refused');
  assert.equal((await call('/unknown')).status, 404);
  const read = await call('/catalog');
  assert.equal(read.status, 200);
  assert.equal(read.body.trusted, false);
  assert.deepEqual(read.body.catalog.map(item => item.id), ['demo.one', 'demo.two']);
  assert.deepEqual(Object.keys(read.body.catalog[0]), ['id', 'version', 'description', 'invocation',
    'source', 'requires_tools', 'body_sha256']);
  const searchBearing = await call('/catalog?invocation=agent');
  assert.equal(searchBearing.status, 400, 'search-bearing catalog requests fail closed on the registered code');
  assert.equal(searchBearing.body?.error?.code, 'nnd_skills_request_invalid');
  const catalog = await call('/catalog');
  assert.equal(catalog.status, 200, 'the refused variant does not poison the route');
});

test('skills catalog failure wraps to the CLI-equivalent code and missing workspace is a request refusal', async t => {
  const impl = createNndSkillsService({ paths: { trustedWorkspaces: 'C:\\nna\\config\\trusted-workspaces.json',
    skills: 'C:\\nna\\skills' }, installationId: 'install_skills', dataId: 'data_skills',
    trustedCheck: async () => false,
    registryFactory: () => ({ initialize: async () => { throw new Error('disk exploded'); },
      catalog: () => [], diagnostics: () => [] }) });
  const server = await startIntegrationServer({ activation: createNndLocalIntegrationActivation(), token,
    host: '127.0.0.1', port: 0,
    nndRuntime: { getHost: () => ({ workspaceRoot: 'C:\\workspace' }),
      snapshot: () => ({ service_state: 'setup_required', execution_state: 'unavailable' }) },
    resolvePrincipal: () => PERMITTED, nndSkillsService: impl });
  t.after(() => server.close());
  const endpoint = `http://127.0.0.1:${server.address.port}`;
  const call = async (suffix = '') => {
    const response = await fetch(endpoint + base + suffix, { headers: { authorization: `Bearer ${token}` } });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const wrapped = await call('/catalog');
  assert.equal(wrapped.status, 503, 'the wrapped authority failure keeps its registered code');
  assert.equal(wrapped.body?.error?.code, 'nnd_skills_catalog_unavailable');
  const noRoot = createNndSkillsService({ paths: { trustedWorkspaces: 'C:\\x', skills: 'C:\\y' },
    installationId: 'install_skills', dataId: 'data_skills',
    trustedCheck: async () => false, registryFactory: () => registryStub([]) });
  await assert.rejects(noRoot.catalog(''), { code: 'nnd_skills_request_invalid' });
  assert.throws(() => createNndSkillsService({ paths: { trustedWorkspaces: 7, skills: 'C:\\y' },
    installationId: 'install_skills', dataId: 'data_skills' }), { code: 'nnd_skills_request_invalid' });
  assert.equal(await dispatchNndSkillsRequest({}, {}, { url: new URL('http://x/other'),
    principal: PERMITTED }), false, 'unrelated paths return false for the router chain');
});
