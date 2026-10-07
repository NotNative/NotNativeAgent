// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createNndConfigurationService } from '../src/nnd-configuration-service.js';
import { createNndMcpAdvancedConfigurationService, projectMcpAdvanced,
  dispatchNndMcpAdvancedRequest } from '../src/nnd-mcp-advanced-routes.js';
import { startIntegrationServer } from '../src/integration-server.js';
import { createNndLocalIntegrationActivation } from '../src/nno-integration-activation.js';

const identity = { installation_id: 'install_mcp', data_id: 'data_mcp', scope: 'user' };
const owner = { subjectId: 'operator', permissions: ['nnd.configuration.read', 'nnd.configuration.manage'] };
const server = { id: 'existing', transport: 'stdio', command: 'hidden-command', args: ['private-arg'],
  cwd: 'C:\\mcp', credential: { source: 'environment', name: 'PRIVATE_TOKEN_REF' },
  credential_target: 'MCP_TARGET_ENV', header_env: { 'x-mcp': 'MCP_HEADER_ENV' },
  header_credentials: { 'x-signed': { source: 'secret', secret_id: 'sec_demo-1', field: 'token' } },
  tool_effects: { write_file: true, shell: false, guess: 'unknown' },
  protocol_version: '2026-07-28', enabled: false, trusted: false };
async function fixture(t) {
  const root = await mkdtemp(join(homedir(), '.nna-native-mcp-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = { config: join(root, 'config'), trustedWorkspaces: join(root, 'trust.json') };
  await mkdir(paths.config); await mkdir(join(root, '.nna'));
  const path = join(paths.config, 'manifest.json');
  const document = { workspace_root: root, provider: { id: 'local', endpoint: 'http://127.0.0.1:9/v1', model: 'base', trust_zone: 'loopback' },
    mcp_servers: [server] };
  await writeFile(path, JSON.stringify(document));
  const service = createNndConfigurationService({ paths, installationId: identity.installation_id, dataId: identity.data_id });
  return { root, paths, path, document, service };
}

test('advanced presence serves counts without values and inner adds references behind manage', async t => {
  const f = await fixture(t);
  const advanced = f.service.nndMcpAdvancedConfigurationService;
  const presence = projectMcpAdvanced(await advanced.presence(owner));
  assert.equal(presence.servers.length, 1);
  const row = presence.servers[0];
  assert.deepEqual(Object.keys(row).sort(), ['has_args', 'has_command', 'has_credential',
    'has_credential_target', 'has_cwd', 'has_endpoint', 'has_header_env',
    'has_protocol_version', 'header_credential_count', 'id', 'tool_effect_count']);
  assert.equal(row.has_credential, true);
  assert.equal(row.header_credential_count, 1);
  assert.equal(row.tool_effect_count, 3);
  assert.equal(JSON.stringify(presence).includes('PRIVATE_TOKEN_REF'), false);
  assert.equal(JSON.stringify(presence).includes('hidden-command'), false);
  const inner = projectMcpAdvanced(await advanced.inner(owner), 'inner');
  const view = inner.servers[0];
  assert.equal(view.credential, 'PRIVATE_TOKEN_REF');
  assert.equal(view.credential_target, 'MCP_TARGET_ENV');
  assert.deepEqual(view.header_credentials, [{ header: 'x-signed', reference: 'secret:sec_demo-1#token', field: 'token' }]);
  assert.deepEqual(view.header_env, [{ header: 'x-mcp', name: 'MCP_HEADER_ENV' }]);
  assert.deepEqual(view.tool_effects, [{ tool: 'guess', effect: 'unknown' },
    { tool: 'shell', effect: 'denied' }, { tool: 'write_file', effect: 'allowed' }]);
  assert.equal(view.protocol_version, '2026-07-28');
  assert.deepEqual(view.surface, { command: 'hidden-command', args: ['private-arg'],
    cwd: 'C:\\mcp', endpoint: null });
  assert.equal(view.presence.has_credential, true);
  assert.equal(JSON.stringify(inner).includes('sec_demo-1'), true,
    'references ride the inner projection; values never do');
  assert.equal(JSON.stringify(inner).includes('token value'), false);
  for (const drift of [{ ...presence, servers: 'x' },
    { ...presence, servers: [{ ...presence.servers[0], has_credential: 'yes' }] },
    { ...presence, application: 'applied' }, { ...presence, extra: true }, null]) {
    assert.throws(() => projectMcpAdvanced(drift),
      (error) => error.code === 'nnd_mcp_advanced_projection_invalid');
  }
  for (const drift of [{ ...inner, servers: [{ ...inner.servers[0], extra: 1 }] },
    { ...inner, application: 'applied' },
    { ...inner, servers: [{ ...inner.servers[0], surface: {} }] },
    { ...inner, servers: [{ ...inner.servers[0], tool_effects: [{ tool: 'x', effect: 'maybe' }] }] },
    { ...inner, servers: [{ ...inner.servers[0], protocol_version: 7 }] },
    { ...inner, servers: [{ ...inner.servers[0], presence: null }] }]) {
    assert.throws(() => projectMcpAdvanced(drift, 'inner'),
      (error) => error.code === 'nnd_mcp_advanced_projection_invalid');
  }
});

test('advanced permissions and http matrix', async t => {
  const f = await fixture(t);
  const advanced = f.service.nndMcpAdvancedConfigurationService;
  await assert.rejects(advanced.presence({ ...owner, permissions: [] }), { code: 'integration_permission_denied' });
  await assert.rejects(advanced.inner({ ...owner, permissions: ['nnd.configuration.read'] }),
    { code: 'integration_permission_denied' });
  assert.throws(() => createNndMcpAdvancedConfigurationService({ paths: {}, identity }),
    { code: 'nnd_mcp_advanced_request_invalid' });
  const token = 'advanced-mcp-http-token-32-characters-longest-ok';
  const instance = await startIntegrationServer({ activation: createNndLocalIntegrationActivation(), token,
    host: '127.0.0.1', port: 0,
    nndRuntime: { getHost: () => ({ workspaceRoot: f.root }),
      snapshot: () => ({ service_state: 'ready', execution_state: 'unavailable' }) },
    resolvePrincipal: () => owner,
    nndConfigurationService: f.service });
  t.after(() => instance.close());
  const call = async (inner, bearer = token, method = 'GET') => {
    const response = await fetch(`http://127.0.0.1:${instance.address.port}/v1/nnd/configuration/mcp/advanced`,
      { method, headers: { authorization: `Bearer ${bearer}`,
        ...(inner ? { 'x-nnd-inner': 'inner' } : {}) } });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  assert.equal((await call(false, null)).status, 401);
  assert.equal((await call(false, token, 'POST')).status, 405);
  assert.equal((await call(false)).status, 200);
  assert.equal((await call(false)).body.servers[0].has_credential, true);
  const inner = await call(true);
  assert.equal(inner.status, 200);
  assert.equal(inner.body.servers[0].credential, 'PRIVATE_TOKEN_REF');
  assert.equal(await dispatchNndMcpAdvancedRequest({}, {}, { url: new URL('http://x/other'),
    principal: owner }), false, 'unrelated paths return false for the router chain');
  await assert.rejects(advanced.inner(
    { ...owner, permissions: ['nnd.configuration.read'] }), { code: 'integration_permission_denied' });
  assert.equal((await call(true, `${token.slice(0, -2)}xx`)).status, 401);
});
