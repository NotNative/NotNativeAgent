// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { terminalRecord } from '../src/engine/records.js';
import { nndGoalTurnReceipt } from '../src/nnd-goal-evidence.js';

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
