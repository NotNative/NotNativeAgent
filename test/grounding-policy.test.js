// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { GovernanceEngine } from '../src/governance-engine.js';
import { GroundingPolicy } from '../src/grounding-policy.js';

test('memory grounding admits current evidence, qualifies stale evidence, and quarantines conflicts', async () => {
  const governance = new GovernanceEngine({ durable: false, sessionId: 'grounding-session' });
  const policy = new GroundingPolicy({ governance });
  const result = await policy.admitMemory([
    memory('current', { updatedAt: 100 }),
    memory('historical', { stale: true, updatedAt: 50 }),
    memory('conflict', { conflict: true, updatedAt: 75 }),
    memory('unknown'),
  ], { requestId: 'memory-request', authorityRef: 'authenticated_submission' });

  assert.deepEqual(result.admitted.map((item) => item.id), ['current', 'historical', 'unknown']);
  assert.equal(result.admitted[0].grounding.assertionMode, 'assertable_with_attribution');
  assert.equal(result.admitted[1].grounding.assertionMode, 'historical_only');
  assert.equal(result.admitted[2].grounding.assertionMode, 'qualified');
  assert.deepEqual(result.rejected.map((item) => item.id), ['conflict']);
  assert.equal(governance.health().evidence_states.conflicting, 1);
  assert.equal(governance.audit().filter((item) => item.domain === 'memory_eligibility').length, 4);
});

function memory(id, overrides = {}) {
  return Object.freeze({
    id, scope: 'user', content: `content-${id}`, relevance: 0.5, pinned: false,
    createdAt: 0, updatedAt: 0, source: 'test-adapter', stale: false, conflict: false,
    labels: Object.freeze([]), ...overrides,
  });
}
