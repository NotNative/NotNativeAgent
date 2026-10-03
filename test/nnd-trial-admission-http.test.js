// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { ContractError } from '../src/ids.js';
import { startIntegrationServer } from '../src/integration-server.js';
import { createNndLocalIntegrationActivation } from '../src/nno-integration-activation.js';

const token = 'native-trial-token-with-at-least-32-characters';
test('authenticated trial admission runs before broader principal or ordinary write routes', async () => {
  let created = 0, checks = 0, principals = 0;
  const service = await startIntegrationServer({ activation: createNndLocalIntegrationActivation(), token,
    instanceId: 'nna_test', port: 0,
    assertAdmission: request => {
      checks++;
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        throw new ContractError('nnd_trial_mutation_denied', 'Trial writes are closed');
      }
    },
    resolvePrincipal: () => { principals++; return { subjectId: 'operator', workspaceIds: ['primary'],
      permissions: ['*'], groupIds: [], platformRole: 'operator', issuedAt: new Date() }; },
    nndEngineHost: { create: async () => { created++; return { sessionId: 's' }; } },
  });
  const base = `http://127.0.0.1:${service.address.port}`;
  try {
    const denied = await fetch(`${base}/session`, { method: 'POST', headers: { authorization: 'Bearer invalid',
      'content-type': 'application/json' }, body: '{}' });
    assert.equal(denied.status, 401);
    assert.equal(checks, 0);
    const health = await fetch(`${base}/v1/health`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(health.status, 200);
    const blocked = await fetch(`${base}/session`, { method: 'POST', headers: { authorization: `Bearer ${token}`,
      'content-type': 'application/json' }, body: '{}' });
    assert.equal(blocked.status, 403);
    assert.equal((await blocked.json()).error.code, 'nnd_trial_mutation_denied');
    assert.equal(created, 0);
    assert.equal(principals, 1); // Only the prior read reached principal resolution.
    assert.equal(checks, 2);
  } finally { await service.close(); }
});
