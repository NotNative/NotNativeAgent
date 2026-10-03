// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createNndLocalIntegrationActivation } from '../src/nno-integration-activation.js';
import { createNndConfigurationService } from '../src/nnd-configuration-service.js';
import { startIntegrationServer } from '../src/integration-server.js';

test('native configuration remains authenticated and reachable while setup is required', async (t) => {
  const root = await mkdtemp(join(homedir(), '.nna-config-http-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = { config: join(root, 'config') };
  await mkdir(paths.config);
  let permissions = ['nnd.configuration.read'];
  const token = 'test-config-token-with-at-least-32-characters';
  const service = await startIntegrationServer({
    activation: createNndLocalIntegrationActivation(), token, host: '127.0.0.1', port: 0,
    nndRuntime: { getHost: () => null, snapshot: () => ({ service_state: 'setup_required', execution_state: 'unavailable' }) },
    nndConfigurationService: createNndConfigurationService({ paths, installationId: 'install_test', dataId: 'data_test' }),
    resolvePrincipal: () => ({ subjectId: 'local-operator', permissions }),
  });
  t.after(() => service.close());
  const endpoint = `http://127.0.0.1:${service.address.port}`;
  const denied = await fetch(endpoint + '/v1/nnd/configuration');
  assert.equal(denied.status, 401);
  const headers = { authorization: `Bearer ${token}` };
  const read = await fetch(endpoint + '/v1/nnd/configuration', { headers });
  assert.equal(read.status, 200);
  assert.equal((await read.json()).source_state, 'missing');
  const catalog = await fetch(endpoint + '/v1/nnd/configuration/catalog', { headers });
  assert.equal(catalog.status, 200);
  const fields = (await catalog.json()).fields;
  const binding = fields.find((item) => item.path === 'routes.reviewer.provider_id');
  assert.equal(binding.editability.available, true);
  assert.equal(binding.editability.required_permission, 'nnd.configuration.manage');
  assert.equal(binding.editability.operation, 'bind_route');
  assert.deepEqual(binding.editability.paired_fields,
    ['routes.reviewer.provider_id', 'routes.reviewer.model']);
  assert.equal(fields.find((item) => item.path === 'routes.primary.provider_id').editability.available, false);
  const blocked = await fetch(endpoint + '/v1/nnd/configuration/save', {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(blocked.status, 403);
  permissions = ['nnd.configuration.read', 'nnd.configuration.repair'];
  const repair = await fetch(endpoint + '/v1/nnd/configuration/repair', {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(repair.status, 400);
  assert.equal((await repair.json()).error.code, 'nnd_configuration_request_invalid');
  const execution = await fetch(endpoint + '/v1/nnd/unknown-execution', { headers });
  assert.equal(execution.status, 503);
  assert.equal((await execution.json()).error.code, 'nnd_setup_required');
});

test('configuration preview errors never expose private raw keys over HTTP', async t => {
  const root = await mkdtemp(join(homedir(), '.nna-config-error-http-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = { config: join(root, 'config') }; await mkdir(paths.config);
  await writeFile(join(paths.config, 'manifest.json'), JSON.stringify({ workspace_root: root,
    provider: { endpoint: 'http://127.0.0.1:9', model: 'base', trust_zone: 'loopback' },
    security_PRIVATE_SOURCE_MARKER: true }));
  const token = 'test-config-token-with-at-least-32-characters';
  const service = await startIntegrationServer({ activation: createNndLocalIntegrationActivation(),
    token, host: '127.0.0.1', port: 0, resolvePrincipal: () => ({ subjectId: 'local-operator',
      permissions: ['nnd.configuration.read', 'nnd.configuration.manage'] }),
    nndConfigurationService: createNndConfigurationService({ paths, installationId: 'install_test', dataId: 'data_test' }),
  });
  t.after(() => service.close());
  const response = await fetch(`http://127.0.0.1:${service.address.port}/v1/nnd/configuration/preview`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ installation_id: 'install_test', data_id: 'data_test', scope: 'user',
      expected_revision: '0'.repeat(64), expected_resolution_revision: '0'.repeat(64),
      operations: [{ op: 'set', field: 'provider_timeout_ms', value: 30000 }] }),
  });
  assert.equal(response.status, 400); const body = await response.json();
  assert.equal(body.error.code, 'unknown_security_key');
  assert.equal(JSON.stringify(body).includes('PRIVATE_SOURCE_MARKER'), false);
  assert.equal(JSON.stringify(body).includes(root), false);
});
