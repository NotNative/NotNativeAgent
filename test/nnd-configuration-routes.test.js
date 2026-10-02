// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { dispatchNndConfigurationRequest } from '../src/nnd-configuration-routes.js';
import { createNndConfigurationService } from '../src/nnd-configuration-service.js';
import { ContractError } from '../src/ids.js';
import { CONFIGURATION_CATALOG } from '../src/configuration-catalog.js';
import { NND_CONFIGURATION_EDITABLE_FIELDS } from '../src/nnd-configuration-intents.js';

const base = '/v1/nnd/configuration';
const snapshot = { installationId: 'nna_test', dataId: 'data_test', sourceState: 'missing', sourceRevision: 'absent', rawBytes: 'PRIVATE' };
const input = { installation_id: 'nna_test', data_id: 'data_test', scope: 'user', expected_revision: 'absent',
  expected_resolution_revision: 'a'.repeat(64), operations: [{ op: 'set', field: 'memory.enabled', value: false }] };
const receipt = { installation_id: 'nna_test', data_id: 'data_test', scope: 'user', operation_id: 'operation_1', persistence: 'saved',
  persisted_revision: 'b'.repeat(64), before_revision: 'absent', application: 'not_applied', rawBytes: 'PRIVATE' };
async function dispatch(path, method, permissions, service, body) {
  const request = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
  request.method = method;
  const response = { setHeader() {}, end(text) { this.body = JSON.parse(text); } };
  const matched = await dispatchNndConfigurationRequest(request, response, { url: new URL(path, 'http://localhost'),
    principal: { subjectId: 'operator-test', permissions }, nndConfigurationService: service });
  return { matched, status: response.statusCode, body: response.body };
}

test('configuration routes enforce exact permissions before body reads and service calls', async () => {
  let calls = 0;
  const service = { read() { calls++; return snapshot; }, save() { calls++; return receipt; }, repair() { calls++; return receipt; } };
  for (const [path, method, permission] of [[base, 'GET', 'provider.read'], [base + '/save', 'POST', 'nnd.configuration.read'],
    [base + '/repair', 'POST', 'nnd.configuration.manage']]) {
    await assert.rejects(dispatch(path, method, [permission], service, 'invalid JSON'), { code: 'integration_permission_denied' });
  }
  assert.equal(calls, 0);
  const result = await dispatch(base, 'GET', ['nnd.configuration.read'], service);
  assert.equal(result.status, 200); assert.ok(!JSON.stringify(result.body).includes('PRIVATE'));
});

test('native catalog describes its finite user-scope save capability without granting it', async () => {
  const service = { save: () => receipt };
  const catalog = (await dispatch(base + '/catalog', 'GET', ['nnd.configuration.read'], service)).body;
  const nativeFields = new Set(NND_CONFIGURATION_EDITABLE_FIELDS);
  assert.ok(nativeFields.size > 0);
  for (const field of catalog.fields) {
    assert.equal(field.editability.available, nativeFields.has(field.path), field.path);
    if (nativeFields.has(field.path)) {
      assert.equal(field.editability.scope, 'user');
      assert.equal(field.editability.required_permission, 'nnd.configuration.manage');
    }
  }
  assert.equal(CONFIGURATION_CATALOG.fields.every(field => field.editability.available === false), true);
  await assert.rejects(dispatch(base + '/save', 'POST', ['nnd.configuration.read'], service,
    { ...input, operation_id: 'operation_1' }), { code: 'integration_permission_denied' });
  const withoutSave = (await dispatch(base + '/catalog', 'GET', ['nnd.configuration.read'], {})).body;
  assert.equal(withoutSave.fields.every(field => field.editability.available === false), true);
});

test('routes validate method, scope, query, input keys and bounded bodies', async () => {
  const service = { save: () => receipt };
  assert.equal((await dispatch(base + '/save', 'GET', ['nnd.configuration.manage'], service)).status, 405);
  for (const body of [{ ...input, operation_id: 'operation_1', scope: 'project' },
    { ...input, operation_id: 'operation_1', hostOptions: {} }]) {
    await assert.rejects(dispatch(base + '/save', 'POST', ['nnd.configuration.manage'], service, body), { code: 'nnd_configuration_request_invalid' });
  }
  await assert.rejects(dispatch(base + '?path=secret', 'GET', ['nnd.configuration.read'], {}), { code: 'nnd_configuration_request_invalid' });
  await assert.rejects(dispatch(base + '/save', 'POST', ['nnd.configuration.manage'], service, 'x'.repeat(65537)), { code: 'request_too_large' });
  assert.equal((await dispatch('/unrelated', 'GET', [], {})).matched, false);
});

test('preview and mutation responses explicitly project safe fields', async () => {
  const service = { preview: () => ({ valid: true, expected_revision: 'absent', resolution_revision: 'a'.repeat(64), snapshot, raw: 'PRIVATE' }),
    save: () => receipt, operation: () => receipt };
  const preview = await dispatch(base + '/preview', 'POST', ['nnd.configuration.manage'], service, input);
  assert.equal(preview.body.application, 'not_applied'); assert.ok(preview.body.view);
  const saved = await dispatch(base + '/save', 'POST', ['nnd.configuration.manage'], service, { ...input, operation_id: 'operation_1' });
  assert.equal(saved.body.persistence, 'saved'); assert.equal(saved.body.application, 'not_applied');
  const operation = await dispatch(base + '/operations/operation_1', 'GET', ['nnd.configuration.read'], service);
  for (const result of [preview, saved, operation]) assert.ok(!JSON.stringify(result.body).includes('PRIVATE'));
});

test('configuration boundary preserves typed failures without private diagnostics or filesystem codes', async () => {
  for (const code of ['manifest_revision_conflict', 'nnd_configuration_resolution_conflict', 'unknown_security_key']) {
    await assert.rejects(dispatch(base, 'GET', ['nnd.configuration.read'], {
      read() { throw new ContractError(code, 'PRIVATE raw source key'); },
    }), error => error.code === code && !error.message.includes('PRIVATE') && error.cause === undefined);
  }
  await assert.rejects(dispatch(base, 'GET', ['nnd.configuration.read'], {
    read() { throw Object.assign(new Error('PRIVATE native filesystem path'), { code: 'EACCES' }); },
  }), error => error.code === 'nnd_configuration_unavailable' && !error.message.includes('PRIVATE'));
});

test('real native service read preview save and operation use the same safe HTTP contract', async t => {
  const root = await mkdtemp(join(homedir(), '.nnd-route-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = { config: join(root, 'config') }; await mkdir(paths.config);
  await writeFile(join(paths.config, 'manifest.json'), JSON.stringify({ workspace_root: root,
    provider: { id: 'local', endpoint: 'http://127.0.0.1:9/v1', model: 'base', trust_zone: 'loopback' } }));
  const service = createNndConfigurationService({ paths, installationId: 'nna_test', dataId: 'data_test' });
  const permissions = ['nnd.configuration.read', 'nnd.configuration.manage'];
  const before = await dispatch(base, 'GET', permissions, service);
  const request = { ...input, expected_revision: before.body.source_revision, expected_resolution_revision: before.body.resolution_revision };
  const preview = await dispatch(base + '/preview', 'POST', permissions, service, request);
  assert.equal(preview.body.view.fields.find(field => field.path === 'memory.enabled').explicit.value, false);
  const saved = await dispatch(base + '/save', 'POST', permissions, service, { ...request, operation_id: 'operation_1' });
  assert.equal(saved.body.persistence, 'saved'); assert.equal(saved.body.application, 'not_applied');
  assert.equal(JSON.parse(await readFile(join(paths.config, 'manifest.json'), 'utf8')).memory.enabled, false);
  const replay = await dispatch(base + '/operations/operation_1', 'GET', permissions, service);
  assert.equal(replay.body.persisted_revision, saved.body.persisted_revision);
});
