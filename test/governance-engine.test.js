// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { GovernanceEngine } from '../src/governance-engine.js';
import { normalizeGovernanceEvidence } from '../src/governance-contracts.js';

test('governance persists evidence lifecycle, decisions, and terminal effects', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-governance-'));
  try {
    const telemetry = [];
    const governance = new GovernanceEngine({
      durable: true, root, sessionId: 'session-governance',
      telemetry: { record: (...args) => telemetry.push(args) },
    });
    await governance.initialize();
    const evidence = await governance.registerEvidence({
      id: 'evidence:tool:1', kind: 'tool_observation', origin: 'tool_result',
      trust: 'observed', sourceRef: 'telemetry:42', sourceFingerprint: 'telemetry:42',
      contentFingerprint: 'sha-material', scope: { kind: 'workspace', fingerprint: 'workspace-a' },
      freshness: 'current', conflict: 'none', observedAt: 1_786_000_000_000,
      attributes: { terminal_status: 'succeeded' },
    });
    await governance.transitionEvidence(evidence.id, 'stale', {
      reasonCode: 'freshness_window_elapsed', evidenceRefs: [],
    });
    const decision = await governance.decide({
      id: 'decision:memory:1', domain: 'memory_eligibility', subjectRef: 'memory:alpha',
      subjectFingerprint: 'memory-alpha-v1', outcome: 'quarantine',
      reasonCode: 'source_stale', policyVersion: 'governance/1', evidenceRefs: [evidence.id],
      authorityRefs: [], decidedAt: 1_786_000_000_100,
      attributes: { scope_match: true },
    });
    await governance.settleDecision(decision.id, {
      status: 'not_applied', effectCertainty: 'none', resultFingerprint: 'not-injected',
      settledAt: 1_786_000_000_200, reasonCode: 'source_stale',
    });
    await governance.close();

    const restored = new GovernanceEngine({ durable: true, root, sessionId: 'session-governance' });
    await restored.initialize();
    assert.equal(restored.evidence(evidence.id).state, 'stale');
    assert.equal(restored.decision(decision.id).outcome, 'quarantine');
    assert.equal(restored.audit(1)[0].terminal.status, 'not_applied');
    assert.equal(restored.health().evidence_states.stale, 1);
    assert.ok(telemetry.some(([name]) => name === 'governance.evidence'));
    assert.ok(telemetry.some(([name]) => name === 'governance.decision'));
    await restored.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('governance rejects identity drift, invalid lifecycle reversal, and raw payload fields', async () => {
  const governance = new GovernanceEngine({ durable: false, sessionId: 'ephemeral' });
  await governance.initialize();
  const base = {
    id: 'evidence:one', kind: 'runtime_observation', origin: 'runtime', trust: 'observed',
    sourceRef: 'event:one', sourceFingerprint: 'event-one', contentFingerprint: 'result-one',
    scope: { kind: 'session', fingerprint: 'session-one' }, observedAt: 100,
  };
  await governance.registerEvidence(base);
  await assert.rejects(() => governance.registerEvidence({ ...base, contentFingerprint: 'result-two' }),
    { code: 'governance_evidence_drift' });
  await governance.transitionEvidence(base.id, 'invalidated', { reasonCode: 'superseded_by_observation' });
  await assert.rejects(() => governance.transitionEvidence(base.id, 'active', { reasonCode: 'unsafe_revival' }),
    { code: 'governance_evidence_transition_invalid' });
  assert.throws(() => normalizeGovernanceEvidence({ ...base, content: 'must not enter the governance journal' }),
    { code: 'governance_fields_invalid' });
});

test('governance retention never leaves a retained decision with dangling evidence', async () => {
  const governance = new GovernanceEngine({ durable: false, sessionId: 'retention', retentionEntries: 4 });
  for (let index = 0; index < 4; index += 1) {
    const evidence = await governance.registerEvidence(evidenceRecord(`evidence-${index}`, `content-${index}`));
    await governance.decide({
      domain: 'evidence_admission', subjectRef: `subject-${index}`,
      subjectFingerprint: `subject-${index}`, outcome: 'admit', reasonCode: 'eligible',
      policyVersion: 'test/1', evidenceRefs: [evidence.id],
    });
  }
  const decisions = governance.audit();
  assert.ok(decisions.length > 0);
  for (const decision of decisions) {
    for (const evidenceId of decision.evidenceRefs) assert.ok(governance.evidence(evidenceId));
  }
  assert.ok(governance.health().evidence + governance.health().decisions <= 4);
});

test('authorization governance binds decisions to fingerprinted request and intent evidence without raw intent', async () => {
  const governance = new GovernanceEngine({ durable: false, sessionId: 'authorization' });
  const request = {
    id: 'tool-request-1', toolName: 'process.run', workspaceRoot: 'D:/workspace', createdAt: 100,
  };
  const decision = {
    id: 'decision-1', outcome: 'approve', reasonCode: 'semantic_intent_match',
    requestDigest: 'request-digest', authorityId: 'authority-1', authorityVersion: 2,
    authorityRestrictionVersion: 0, policyVersion: 1, committedAt: 110, expiresAt: 1_000,
  };
  const record = await governance.recordAuthorization(request, decision, {
    authority: { id: 'authority-1', version: 2, complete: true, intent: [{ content: 'private operator request' }] },
    definition: { sideEffect: 'external_effect' },
  });
  assert.equal(record.domain, 'action_authorization');
  assert.equal(record.evidenceRefs.length, 2);
  assert.ok(record.evidenceRefs.every((id) => governance.evidence(id)));
  assert.doesNotMatch(JSON.stringify(governance.audit()), /private operator request/u);
});

function evidenceRecord(id, content) {
  return {
    id, kind: 'test', origin: 'runtime', trust: 'observed', state: 'active',
    freshness: 'current', conflict: 'none', sourceRef: `source:${id}`,
    contentFingerprint: content, scope: { kind: 'session', fingerprint: 'retention' },
    observedAt: 1,
  };
}
