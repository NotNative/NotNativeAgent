// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { terminalRecord } from '../src/engine/records.js';
import { nndGoalTurnReceipt } from '../src/nnd-goal-evidence.js';
import { nndProviderProfileFingerprint } from '../src/nnd-provider-affinity.js';
import { ProviderRunner } from '../src/provider/runner.js';

test('durable terminal and NND receipt retain the actual fallback provider affinity', () => {
  const engine = { sessionId: 'ses_affinity', reliability: {
    combineTokenAccounting: () => ({ accounted_total_tokens: 12, measurement: 'provider' }),
  } };
  const active = { turnId: 'turn-1', requestId: 'request-1', providerResource: 'fallback-local',
    modelName: 'fallback-model', tokenAccounting: null, delegatedTokenAccounting: null,
    recovery: { actions: [] } };
  const terminal = terminalRecord(engine, active, 'completed', 'Verified work', null);
  assert.equal(terminal.provider_profile, 'fallback-local');
  assert.equal(terminal.model, 'fallback-model');
  assert.deepEqual(nndGoalTurnReceipt({ ...terminal, type: 'turn_outcome' }), {
    request_id: 'request-1', outcome: 'completed', tokens: 12,
    measurement: 'provider', provider_profile: 'fallback-local', model: 'fallback-model',
  });
});

test('provider attempt stamps a durable destination fingerprint without exposing it in NND evidence', async () => {
  const profile = { id: 'fallback-local', endpoint: 'http://127.0.0.1:1234/v1', model: 'fallback-model',
    trustZone: 'loopback', credential: null };
  const active = { requestId: 'request-1', turnId: 'turn-1', recovery: { actions: [] },
    stepText: 'Done', stepReasoningBytes: 0, toolAssembler: { size: 0 } };
  const runner = new ProviderRunner({});
  runner.run = async () => undefined;
  await runner.runRoutes({ provider: () => ({}) }, [{ profile, model: 'fallback-model' }],
    () => ({}), {}, active);
  const terminal = terminalRecord({ sessionId: 'session-1' }, active, 'completed', 'Done', null);
  assert.equal(terminal.provider_route_fingerprint, nndProviderProfileFingerprint(profile));
  assert.equal(Object.hasOwn(nndGoalTurnReceipt(terminal), 'provider_route_fingerprint'), false);
});
