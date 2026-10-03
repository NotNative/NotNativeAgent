// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { dispatchNndConfigurationRequest } from '../src/nnd-configuration-routes.js';
import { sendFailure } from '../src/secret-broker-server.js';
import { ContractError } from '../src/ids.js';
import { createNndConfigurationService } from '../src/nnd-configuration-service.js';

const base = '/v1/nnd/configuration/mcp';
const identity = { installation_id: 'install_mcp', data_id: 'data_mcp', scope: 'user' };
const revision = 'a'.repeat(64), resolution = 'b'.repeat(64);
const view = { schema_version: '1.0', ...identity, source_state: 'present', source_revision: revision,
  resolution_revision: resolution, project_shadowed: false, application: 'not_applied',
  servers: [{ id: 'local', transport: 'stdio', enabled: false, trusted: false, command: 'PRIVATE' }] };
const receipt = { ...identity, operation_id: 'operation_1', persistence: 'unknown',
  persisted_revision: null, before_revision: revision, application: 'not_applied', replayed: true, raw: 'PRIVATE' };
function dispatch(path, method, permissions, service, body) {
  const request = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
  request.method = method;
  const response = { setHeader() {}, end(text) { this.body = JSON.parse(text); } };
  return dispatchNndConfigurationRequest(request, response, { url: new URL(path, 'http://localhost'),
    principal: { subjectId: 'operator', permissions }, nndConfigurationService: service })
    .then(matched => ({ matched, status: response.statusCode, body: response.body }));
}

test('native MCP HTTP routes authorize before reading bodies and never project private fields', async () => {
  const service = { mcpRead: () => view, mcpPreview: () => ({ valid: true, expected_revision: revision,
    resolution_revision: resolution, application: 'not_applied', change: { op: 'patch', id: 'local' }, view }),
  mcpSave: () => receipt, mcpOperation: () => receipt };
  const input = { ...identity, expected_revision: revision, expected_resolution_revision: resolution,
    change: { op: 'patch', id: 'local', fields: { enabled: true } } };
  await assert.rejects(dispatch(base + '/save', 'POST', ['nnd.configuration.read'], service, 'not-json'), { code: 'integration_permission_denied' });
  const read = await dispatch(base, 'GET', ['nnd.configuration.read'], service);
  assert.equal(read.status, 200); assert.equal(JSON.stringify(read.body).includes('PRIVATE'), false);
  const preview = await dispatch(base + '/preview', 'POST', ['nnd.configuration.read', 'nnd.configuration.manage'], service, input);
  assert.equal(preview.body.change.id, 'local'); assert.equal(preview.body.application, 'not_applied');
  assert.equal(JSON.stringify(preview.body).includes('PRIVATE'), false);
  const saved = await dispatch(base + '/save', 'POST', ['nnd.configuration.manage'], service, { ...input, operation_id: 'operation_1' });
  assert.equal(saved.body.persistence, 'unknown'); assert.equal(saved.body.next_action, 'inspect_native_operation');
  const unknown = await dispatch(base + '/operations/operation_1', 'GET', ['nnd.configuration.read'], service);
  assert.equal(unknown.body.persistence, 'unknown'); assert.equal(JSON.stringify(unknown.body).includes('PRIVATE'), false);
});

test('native MCP routes reject query, wrong method and unknown operation cleanly', async () => {
  const service = { mcpRead: () => view, mcpOperation: () => null };
  assert.equal((await dispatch(base, 'POST', ['nnd.configuration.read'], service)).status, 405);
  await assert.rejects(dispatch(base + '?private=1', 'GET', ['nnd.configuration.read'], service), { code: 'nnd_mcp_request_invalid' });
  const missing = await dispatch(base + '/operations/operation_1', 'GET', ['nnd.configuration.read'], service);
  assert.equal(missing.status, 404); assert.deepEqual(missing.body, { error: 'operation_not_found' });
  assert.equal((await dispatch(base + '/missing', 'GET', ['nnd.configuration.read'], service)).status, 404);
});

test('uncertain native MCP publication is a service error requiring original operation lookup', async () => {
  const response = { setHeader() {}, end(text) { this.body = JSON.parse(text); } };
  sendFailure(response, new ContractError('manifest_publication_unknown', 'Disk outcome uncertain'));
  assert.equal(response.statusCode, 503);
  assert.equal(response.body.error.code, 'manifest_publication_unknown');
  for (const code of ['manifest_publication_failed', 'manifest_cleanup_failed']) {
    const retry = { setHeader() {}, end(text) { this.body = JSON.parse(text); } };
    sendFailure(retry, new ContractError(code, 'Inspect native operation'));
    assert.equal(retry.statusCode, 503);
  }
});

test('real native MCP HTTP preview/save preserves private fields and reports unapplied receipt', async t => {
  const root = await mkdtemp(join(homedir(), '.nna-mcp-http-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = { config: join(root, 'config') }; await mkdir(paths.config);
  const path = join(paths.config, 'manifest.json');
  await writeFile(path, JSON.stringify({ workspace_root: root,
    provider: { id: 'local', endpoint: 'http://127.0.0.1:9/v1', model: 'base', trust_zone: 'loopback' },
    mcp_servers: [{ id: 'local', transport: 'stdio', command: 'SECRET-COMMAND', args: ['SECRET-ARG'], enabled: false }] }));
  const service = createNndConfigurationService({ paths, installationId: identity.installation_id, dataId: identity.data_id });
  const permissions = ['nnd.configuration.read', 'nnd.configuration.manage'];
  const current = (await dispatch(base, 'GET', permissions, service)).body;
  const input = { ...identity, expected_revision: current.source_revision,
    expected_resolution_revision: current.resolution_revision,
    change: { op: 'patch', id: 'local', fields: { enabled: true } } };
  const preview = await dispatch(base + '/preview', 'POST', permissions, service, input);
  assert.equal(preview.body.view.servers[0].enabled, true);
  assert.equal(JSON.stringify(preview.body).includes('SECRET'), false);
  const saved = await dispatch(base + '/save', 'POST', permissions, service, { ...input, operation_id: 'real_save' });
  assert.equal(saved.body.persistence, 'saved'); assert.equal(saved.body.application, 'not_applied');
  assert.equal(JSON.parse(await readFile(path, 'utf8')).mcp_servers[0].command, 'SECRET-COMMAND');
  const operation = await dispatch(base + '/operations/real_save', 'GET', permissions, service);
  assert.equal(operation.body.persisted_revision, saved.body.persisted_revision);
});
