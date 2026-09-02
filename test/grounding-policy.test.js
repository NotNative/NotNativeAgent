// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GovernanceEngine } from '../src/governance-engine.js';
import { GroundingPolicy } from '../src/governance/grounding-policy.js';

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
  assert.equal(hook.admitted[0].grounding.observedAt, 0);
  assert.equal(hook.admitted[0].grounding.freshness, 'unknown');
  assert.equal(governance.evidence(first.admitted[0].grounding.evidenceId).state, 'superseded');
  assert.equal(governance.evidence(second.admitted[0].grounding.evidenceId).state, 'active');
  assert.equal(governance.evidence(hook.admitted[0].grounding.evidenceId).trust, 'untrusted');
});

test('repeated memory recall does not manufacture governance drift from request metadata', async () => {
  const governance = new GovernanceEngine({ durable: false, sessionId: 'stable-memory-grounding' });
  const policy = new GroundingPolicy({ governance });
  const first = await policy.admitMemory([
    memory('stable', { relevance: 0.9 }),
  ], { requestId: 'memory-request-one', authorityRef: 'authenticated_submission' });
  const second = await policy.admitMemory([
    memory('stable', { relevance: 0.2 }),
  ], { requestId: 'memory-request-two', authorityRef: 'authenticated_submission' });

  assert.equal(first.admitted[0].grounding.evidenceId, second.admitted[0].grounding.evidenceId);
  assert.equal(governance.health().evidence, 1);
  assert.equal(governance.health().evidence_states.active, 1);
  assert.equal(governance.evidence(first.admitted[0].grounding.evidenceId).observedAt, 0);
  assert.equal(governance.evidence(first.admitted[0].grounding.evidenceId).conflict, 'none');
  assert.deepEqual(
    governance.audit().map((decision) => decision.attributes.request_id),
    ['memory-request-one', 'memory-request-two'],
  );
  assert.deepEqual(
    governance.audit().map((decision) => decision.attributes.relevance),
    [0.9, 0.2],
  );
});

test('a real memory version change creates one new evidence record and supersedes the prior version', async () => {
  const governance = new GovernanceEngine({ durable: false, sessionId: 'versioned-memory-grounding' });
  const policy = new GroundingPolicy({ governance });
  const first = await policy.admitMemory([
    memory('versioned', { content: 'first content', updatedAt: 100 }),
  ], { requestId: 'memory-version-one' });
  const second = await policy.admitMemory([
    memory('versioned', { content: 'replacement content', updatedAt: 200 }),
  ], { requestId: 'memory-version-two' });

  assert.notEqual(first.admitted[0].grounding.evidenceId, second.admitted[0].grounding.evidenceId);
  assert.equal(governance.health().evidence, 2);
  assert.equal(governance.evidence(first.admitted[0].grounding.evidenceId).state, 'superseded');
  assert.equal(governance.evidence(second.admitted[0].grounding.evidenceId).state, 'active');
  assert.equal(governance.evidence(second.admitted[0].grounding.evidenceId).conflict, 'none');
});

test('unchanged memory evidence remains stable across durable governance resume', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'nna-grounding-resume-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const firstGovernance = new GovernanceEngine({
    durable: true, root, sessionId: 'durable-memory-grounding',
  });
  await firstGovernance.initialize();
  const firstPolicy = new GroundingPolicy({ governance: firstGovernance });
  const first = await firstPolicy.admitMemory([
    memory('durable', { relevance: 0.8 }),
  ], { requestId: 'before-resume' });
  await firstGovernance.close();

  const resumedGovernance = new GovernanceEngine({
    durable: true, root, sessionId: 'durable-memory-grounding',
  });
  await resumedGovernance.initialize();
  const resumedPolicy = new GroundingPolicy({ governance: resumedGovernance });
  const resumed = await resumedPolicy.admitMemory([
    memory('durable', { relevance: 0.1 }),
  ], { requestId: 'after-resume' });

  assert.equal(first.admitted[0].grounding.evidenceId, resumed.admitted[0].grounding.evidenceId);
  assert.equal(resumedGovernance.health().evidence, 1);
  assert.equal(resumedGovernance.health().evidence_states.active, 1);
  assert.equal(resumedGovernance.health().evidence_states.conflicting ?? 0, 0);
  await resumedGovernance.close();
});

function memory(id, overrides = {}) {
  return Object.freeze({
    id, scope: 'user', content: `content-${id}`, relevance: 0.5, pinned: false,
    createdAt: 0, updatedAt: 0, source: 'test-adapter', stale: false, conflict: false,
    labels: Object.freeze([]), ...overrides,
  });
}
