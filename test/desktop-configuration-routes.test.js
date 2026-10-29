// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import { createScratchSync } from './scratch.js';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createServer, get } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { dispatchDesktopConfigurationRequest } from '../src/desktop-configuration-routes.js';
import { createDesktopConfigurationService } from '../src/desktop-configuration-service.js';
import { ContractError } from '../src/ids.js';
import { registeredFailureDomain } from '../src/error-code-registry.js';
import { sendFailure } from '../src/secret-broker-server.js';
import { CONFIGURATION_CATALOG } from '../src/configuration-catalog.js';
import { DESKTOP_CONFIGURATION_EDITABLE_FIELDS, DESKTOP_ROUTE_BINDING_FIELDS } from '../src/desktop-configuration-intents.js';

const base = '/v1/desktop/configuration';
const snapshot = { installationId: 'nna_test', dataId: 'data_test', sourceState: 'missing', sourceRevision: 'absent', rawBytes: 'PRIVATE' };
const input = { installation_id: 'nna_test', data_id: 'data_test', scope: 'user', expected_revision: 'absent',
  expected_resolution_revision: 'a'.repeat(64), operations: [{ op: 'set', field: 'memory.enabled', value: false }] };
const receipt = { installation_id: 'nna_test', data_id: 'data_test', scope: 'user', operation_id: 'operation_1', persistence: 'saved',
  persisted_revision: 'b'.repeat(64), before_revision: 'absent', application: 'not_applied', rawBytes: 'PRIVATE' };
async function dispatch(path, method, permissions, service, body) {
  const request = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
  request.method = method;
  const response = { setHeader() {}, end(text) { this.body = JSON.parse(text); } };
  const matched = await dispatchDesktopConfigurationRequest(request, response, { url: new URL(path, 'http://localhost'),
    principal: { subjectId: 'operator-test', permissions }, desktopConfigurationService: service });
  return { matched, status: response.statusCode, body: response.body };
}

test('configuration routes enforce exact permissions before body reads and service calls', async () => {
  let calls = 0;
  const service = { read() { calls++; return snapshot; }, save() { calls++; return receipt; }, repair() { calls++; return receipt; } };
  for (const [path, method, permission] of [[base, 'GET', 'provider.read'], [base + '/save', 'POST', 'desktop.configuration.read'],
    [base + '/repair', 'POST', 'desktop.configuration.manage']]) {
    await assert.rejects(dispatch(path, method, [permission], service, 'invalid JSON'), { code: 'integration_permission_denied' });
  }
  assert.equal(calls, 0);
  const result = await dispatch(base, 'GET', ['desktop.configuration.read'], service);
  assert.equal(result.status, 200); assert.ok(!JSON.stringify(result.body).includes('PRIVATE'));
});

test('native catalog describes its finite user-scope save capability without granting it', async () => {
  const service = { save: () => receipt };
  const catalog = (await dispatch(base + '/catalog', 'GET', ['desktop.configuration.read'], service)).body;
  const nativeFields = new Set(DESKTOP_CONFIGURATION_EDITABLE_FIELDS);
  const routeFields = new Set(DESKTOP_ROUTE_BINDING_FIELDS);
  assert.ok(nativeFields.size > 0);
  for (const field of catalog.fields) {
    assert.equal(field.editability.available, nativeFields.has(field.path) || routeFields.has(field.path), field.path);
    if (nativeFields.has(field.path) || routeFields.has(field.path)) {
      assert.equal(field.editability.scope, 'user');
      assert.equal(field.editability.required_permission, 'desktop.configuration.manage');
    }
  }
  assert.equal(CONFIGURATION_CATALOG.fields.every(field => field.editability.available === false), true);
  await assert.rejects(dispatch(base + '/save', 'POST', ['desktop.configuration.read'], service,
    { ...input, operation_id: 'operation_1' }), { code: 'integration_permission_denied' });
  const withoutSave = (await dispatch(base + '/catalog', 'GET', ['desktop.configuration.read'], {})).body;
  assert.equal(withoutSave.fields.every(field => field.editability.available === false), true);
});

test('routes validate method, scope, query, input keys and bounded bodies', async () => {
  const service = { save: () => receipt };
  assert.equal((await dispatch(base + '/save', 'GET', ['desktop.configuration.manage'], service)).status, 405);
  for (const body of [{ ...input, operation_id: 'operation_1', scope: 'project' },
    { ...input, operation_id: 'operation_1', hostOptions: {} }]) {
    await assert.rejects(dispatch(base + '/save', 'POST', ['desktop.configuration.manage'], service, body), { code: 'desktop_configuration_request_invalid' });
  }
  await assert.rejects(dispatch(base + '?path=secret', 'GET', ['desktop.configuration.read'], {}), { code: 'desktop_configuration_request_invalid' });
  await assert.rejects(dispatch(base + '/save', 'POST', ['desktop.configuration.manage'], service, 'x'.repeat(65537)), { code: 'request_too_large' });
  assert.equal((await dispatch('/unrelated', 'GET', [], {})).matched, false);
});

test('preview and mutation responses explicitly project safe fields', async () => {
  const service = { preview: () => ({ valid: true, expected_revision: 'absent', resolution_revision: 'a'.repeat(64), snapshot, raw: 'PRIVATE' }),
    save: () => receipt, operation: () => receipt };
  const preview = await dispatch(base + '/preview', 'POST', ['desktop.configuration.manage'], service, input);
  assert.equal(preview.body.application, 'not_applied'); assert.ok(preview.body.view);
  const saved = await dispatch(base + '/save', 'POST', ['desktop.configuration.manage'], service, { ...input, operation_id: 'operation_1' });
  assert.equal(saved.body.persistence, 'saved'); assert.equal(saved.body.application, 'not_applied');
  const operation = await dispatch(base + '/operations/operation_1', 'GET', ['desktop.configuration.read'], service);
  for (const result of [preview, saved, operation]) assert.ok(!JSON.stringify(result.body).includes('PRIVATE'));
});

test('configuration boundary preserves typed failures without private diagnostics or filesystem codes', async () => {
  for (const code of ['manifest_revision_conflict', 'desktop_configuration_resolution_conflict', 'unknown_security_key']) {
    await assert.rejects(dispatch(base, 'GET', ['desktop.configuration.read'], {
      read() { throw new ContractError(code, 'PRIVATE raw source key'); },
    }), error => error.code === code && !error.message.includes('PRIVATE') && error.cause?.code === code);
  }
  await assert.rejects(dispatch(base, 'GET', ['desktop.configuration.read'], {
    read() { throw Object.assign(new Error('PRIVATE native filesystem path'), { code: 'EACCES' }); },
  }), error => {
    assert.equal(error.code, 'desktop_configuration_unavailable');
    assert.equal(error.cause?.code, 'EACCES');
    const response = { setHeader() {}, end(text) { this.body = JSON.parse(text); } };
    sendFailure(response, error);
    assert.equal(response.statusCode, 503);
    assert.equal(JSON.stringify(response.body).includes('PRIVATE'), false);
    return true;
  });
  await assert.rejects(dispatch(base, 'GET', ['desktop.configuration.read'], {
    read() { throw new TypeError('PRIVATE programmer fault'); },
  }), error => {
    assert.equal(error.code, 'desktop_configuration_internal_failure');
    assert.equal(error.cause?.message, 'PRIVATE programmer fault');
    const response = { setHeader() {}, end(text) { this.body = JSON.parse(text); } };
    sendFailure(response, error);
    assert.equal(response.statusCode, 500);
    assert.equal(JSON.stringify(response.body).includes('PRIVATE'), false);
    return true;
  });
});

test('service output defects return 500 even after a save has persisted, while request defects remain 400', async () => {
  assert.equal(registeredFailureDomain('desktop_configuration_internal_failure')?.category, 'internal');
  let saved = false;
  const malformedReceipt = { ...receipt, operation_id: 'PRIVATE invalid id' };
  for (const [path, method, service, body] of [
    [base, 'GET', { read: () => ({ ...snapshot, installationId: 'PRIVATE invalid id' }) }],
    [base + '/preview', 'POST', { preview: () => ({ valid: false }) }, input],
    [base + '/save', 'POST', { save: () => { saved = true; return malformedReceipt; } },
      { ...input, operation_id: 'operation_1' }],
  ]) {
    await assert.rejects(dispatch(path, method, ['desktop.configuration.read', 'desktop.configuration.manage'], service, body), error => {
      assert.equal(error.code, 'desktop_configuration_internal_failure');
      const response = { setHeader() {}, end(text) { this.body = JSON.parse(text); } };
      sendFailure(response, error);
      assert.equal(response.statusCode, 500);
      assert.equal(JSON.stringify(response.body).includes('PRIVATE'), false);
      return true;
    });
  }
  assert.equal(saved, true);
  await assert.rejects(dispatch(base + '/save', 'POST', ['desktop.configuration.manage'], {
    save() { throw new Error('invalid request reached service'); },
  }, { ...input, operation_id: 'operation_1', scope: 'project' }), { code: 'desktop_configuration_request_invalid' });
});

test('configuration dispatcher closes a partially written response without writing a second body', async () => {
  let destroyed = 0;
  const response = { headersSent: false, writableEnded: false, setHeader() {},
    end() { throw new Error('second write'); }, destroy(error) { destroyed += 1; this.failure = error; } };
  const matched = await dispatchDesktopConfigurationRequest({ method: 'GET' }, response, {
    url: new URL(base, 'http://localhost'), principal: { permissions: ['desktop.configuration.read'] },
    desktopConfigurationService: { read() { response.headersSent = true; throw new Error('PRIVATE after headers'); } },
  });
  assert.equal(matched, true);
  assert.equal(destroyed, 1);
  assert.equal(response.failure, undefined);
});

test('configuration dispatcher does not serialize a failure after the socket was destroyed before headers', async () => {
  const response = { headersSent: false, writableEnded: false, destroyed: true,
    setHeader() { throw new Error('late header'); }, end() { throw new Error('late body'); } };
  const matched = await dispatchDesktopConfigurationRequest({ method: 'GET' }, response, {
    url: new URL(base, 'http://localhost'), principal: { permissions: ['desktop.configuration.read'] },
    desktopConfigurationService: { read() { throw new Error('PRIVATE after disconnect'); } },
  });
  assert.equal(matched, true);
});

test('real HTTP partial configuration response closes without a second JSON error', async t => {
  let dispatchFailure;
  const server = createServer((request, response) => {
    void dispatchDesktopConfigurationRequest(request, response, {
      url: new URL(base, 'http://localhost'), principal: { permissions: ['desktop.configuration.read'] },
      desktopConfigurationService: { async read() {
        response.flushHeaders();
        await new Promise(resolve => setTimeout(resolve, 10));
        throw new Error('PRIVATE after flush');
      } },
    }).catch(error => { dispatchFailure = error; sendFailure(response, error); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const observed = await new Promise((resolve, reject) => {
    get({ host: '127.0.0.1', port: server.address().port, path: base }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', error => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString(), error }));
      response.on('end', () => reject(new Error('partial response unexpectedly completed')));
    }).on('error', reject);
  });
  assert.equal(dispatchFailure, undefined);
  assert.equal(observed.status, 200);
  assert.equal(observed.body, '');
  assert.equal(observed.error.code, 'ECONNRESET');
});

test('real native service read preview save and operation use the same safe HTTP contract', async t => {
  const root = createScratchSync('.desktop-route-config-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = { config: join(root, 'config') }; await mkdir(paths.config);
  await writeFile(join(paths.config, 'manifest.json'), JSON.stringify({ workspace_root: root,
    provider: { id: 'local', endpoint: 'http://127.0.0.1:9/v1', model: 'base', trust_zone: 'loopback' } }));
  const service = createDesktopConfigurationService({ paths, installationId: 'nna_test', dataId: 'data_test' });
  const permissions = ['desktop.configuration.read', 'desktop.configuration.manage'];
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
