// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startIntegrationServer } from '../src/integration-server.js';
import { createNndLocalIntegrationActivation } from '../src/nno-integration-activation.js';
import { createNndSetupRuntime } from '../src/nnd-setup-runtime.js';

const token = 's'.repeat(48);
async function request(service, path, permissions, method = 'GET') {
  const actor = { subject_id: 'operator', platform_role: 'user', permissions,
    workspace_ids: ['workspace'], group_ids: [], trace_id: 'trace', request_id: 'request', issued_at: new Date().toISOString() };
  const response = await fetch(`http://127.0.0.1:${service.address.port}${path}`, { method,
    headers: permissions ? { authorization: `Bearer ${token}`, 'x-nna-principal': Buffer.from(JSON.stringify(actor)).toString('base64url') } : {} });
  return { status: response.status, body: await response.json() };
}

test('setup status is authenticated and execution, secret use and probes remain guarded', async (t) => {
  let configured = false; let creates = 0; let secretReads = 0;
  const runtime = createNndSetupRuntime({ loadConfiguration: async () => { if (!configured) throw new Error('not configured'); return {}; },
    createHost: async () => { creates++; return { shutdown: async () => {}, workspaceRoot: 'C:\\workspace',
      statuses: () => ({}) }; } });
  await runtime.activate();
  const service = await startIntegrationServer({ activation: createNndLocalIntegrationActivation(), token,
    instanceId: 'test', nndRuntime: runtime, broker: { list: async () => { secretReads++; return []; } } });
  t.after(async () => { await service.close(); await runtime.close(); });
  assert.equal((await request(service, '/v1/nnd/setup/status', null)).status, 401);
  assert.equal((await request(service, '/v1/nnd/setup/status', ['nnd.read'])).status, 403);
  assert.equal((await request(service, '/v1/nnd/setup/status', ['nnd.setup.read'])).body.service_state, 'setup_required');
  assert.equal((await request(service, '/v1/health', ['integration.health'])).body.provider_state, 'unknown');
  for (const path of ['/session', '/event', '/global/health', '/project', '/config', '/v1/nnd/pending',
    '/v1/nnd/sessions/example/goal-evidence', '/v1/secrets/example/use', '/v1/provider-profiles/example/test',
    '/v1/provider-profiles/example/discover', '/v1/provider-route/activate']) {
    const result = await request(service, path, ['*'], path.endsWith('/use') || path.endsWith('/test') ? 'POST' : 'GET');
    assert.equal(result.status, 503, path); assert.equal(result.body.error.code, 'nnd_setup_required');
  }
  assert.equal((await request(service, '/v1/secrets', ['secret.read'])).status, 200);
  assert.equal(secretReads, 1);
  assert.equal((await request(service, '/v1/secrets', ['nnd.setup.read'])).status, 403);
  assert.equal((await request(service, '/v1/nnd/setup/activate', ['provider.route.activate'], 'POST')).status, 403);
  assert.equal((await request(service, '/v1/nnd/setup/activate', ['nnd.setup.activate'], 'POST')).status, 503);
  assert.equal(creates, 0);
  configured = true;
  assert.equal((await request(service, '/v1/nnd/setup/activate', ['nnd.setup.activate'], 'POST')).status, 200);
  assert.equal(creates, 1);
  assert.equal((await request(service, '/session/status', ['nnd.read'])).status, 200);
});
