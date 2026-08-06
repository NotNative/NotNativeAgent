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

test('workspace guidance and hook context retain distinct trust and supersession histories', async () => {
  const governance = new GovernanceEngine({ durable: false, sessionId: 'context-grounding' });
  const policy = new GroundingPolicy({ governance });
  const first = await policy.admitProjectGuidance([
    { path: 'NNA.md', content: 'first policy', depth: 0, updatedAt: 100 },
  ], { turnId: 'turn-1', authorityRef: 'operator', scope: 'project:workspace' });
  const second = await policy.admitProjectGuidance([
    { path: 'NNA.md', content: 'replacement policy', depth: 0, updatedAt: 200 },
  ], { turnId: 'turn-2', authorityRef: 'operator', scope: 'project:workspace' });
  const hook = await policy.admitHook([
    { source: 'memory-hook', content: 'possibly relevant context' },
  ], { turnId: 'turn-2', scope: 'session:context-grounding' });

  assert.equal(first.admitted[0].grounding.assertionMode, 'behavioral_guidance');
  assert.equal(hook.admitted[0].grounding.assertionMode, 'qualified');
  assert.equal(governance.evidence(first.admitted[0].grounding.evidenceId).state, 'superseded');
  assert.equal(governance.evidence(second.admitted[0].grounding.evidenceId).state, 'active');
  assert.equal(governance.evidence(hook.admitted[0].grounding.evidenceId).trust, 'untrusted');
});

function memory(id, overrides = {}) {
  return Object.freeze({
    id, scope: 'user', content: `content-${id}`, relevance: 0.5, pinned: false,
    createdAt: 0, updatedAt: 0, source: 'test-adapter', stale: false, conflict: false,
    labels: Object.freeze([]), ...overrides,
  });
}
