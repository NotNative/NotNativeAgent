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

test('governance rejects invalid lifecycle reversal and raw payload fields', async () => {
  const governance = new GovernanceEngine({ durable: false, sessionId: 'ephemeral' });
  await governance.initialize();
  const base = {
    id: 'evidence:one', kind: 'runtime_observation', origin: 'runtime', trust: 'observed',
    sourceRef: 'event:one', sourceFingerprint: 'event-one', contentFingerprint: 'result-one',
    scope: { kind: 'session', fingerprint: 'session-one' }, observedAt: 100,
  };
  await governance.registerEvidence(base);
  await governance.transitionEvidence(base.id, 'invalidated', { reasonCode: 'superseded_by_observation' });
  await assert.rejects(() => governance.transitionEvidence(base.id, 'active', { reasonCode: 'unsafe_revival' }),
    { code: 'governance_evidence_transition_invalid' });
  assert.throws(() => normalizeGovernanceEvidence({ ...base, content: 'must not enter the governance journal' }),
    { code: 'governance_fields_invalid' });
});

test('governance recovers evidence identity drift onto a replacement id without failing the turn', async () => {
  const telemetry = [];
  const governance = new GovernanceEngine({
    durable: false, sessionId: 'ephemeral',
    telemetry: { record: (...args) => telemetry.push(args) },
  });
  await governance.initialize();
  const base = {
    id: 'evidence:one', kind: 'runtime_observation', origin: 'runtime', trust: 'observed',
    sourceRef: 'event:one', sourceFingerprint: 'event-one', contentFingerprint: 'result-one',
    scope: { kind: 'session', fingerprint: 'session-one' }, observedAt: 100,
  };
  const original = await governance.registerEvidence(base);
  const drifted = await governance.registerEvidence({ ...base, contentFingerprint: 'result-two' });
  assert.notEqual(drifted.id, original.id);
  assert.deepEqual([...drifted.supersedes], [original.id]);
  assert.equal(drifted.conflict, 'suspected');
  assert.equal(governance.evidence(original.id).contentFingerprint, original.contentFingerprint);
  const replayed = await governance.registerEvidence({ ...base, contentFingerprint: 'result-two' });
  assert.equal(replayed.id, drifted.id);
  const third = await governance.registerEvidence({ ...base, contentFingerprint: 'result-three' });
  assert.notEqual(third.id, drifted.id);
  assert.notEqual(third.id, original.id);
  assert.ok(telemetry.some(([name, status, , correlation]) => name === 'governance.evidence'
    && status === 'recovered' && correlation.reason_code === 'governance_evidence_drift'));
});

test('governance recovers decision identity drift and the replacement decision stays settleable', async () => {
  const governance = new GovernanceEngine({ durable: false, sessionId: 'ephemeral' });
  await governance.initialize();
  const evidence = await governance.registerEvidence(evidenceRecord('evidence-decision-drift', 'content-a'));
  const base = {
    id: 'decision:fixed', domain: 'memory_eligibility', subjectRef: 'memory:alpha',
    subjectFingerprint: 'memory-alpha-v1', outcome: 'admit', reasonCode: 'eligible',
    policyVersion: 'test/1', evidenceRefs: [evidence.id], authorityRefs: [], decidedAt: 10,
  };
  const original = await governance.decide(base);
  const drifted = await governance.decide({ ...base, outcome: 'quarantine', reasonCode: 'source_stale' });
  assert.notEqual(drifted.id, original.id);
  assert.equal(drifted.attributes.drift_of, original.id);
  assert.equal(drifted.outcome, 'quarantine');
  assert.equal(governance.decision(original.id).outcome, 'admit');
  const terminal = await governance.settleDecision(drifted.id, {
    status: 'not_applied', effectCertainty: 'none', resultFingerprint: 'not-injected',
    settledAt: 20, reasonCode: 'source_stale',
  });
  assert.equal(terminal.status, 'not_applied');
  const replayed = await governance.decide({ ...base, outcome: 'quarantine', reasonCode: 'source_stale' });
  assert.equal(replayed.id, drifted.id);
});

test('drifted evidence registered after a durable resume no longer poisons the session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-governance-drift-'));
  try {
    const first = new GovernanceEngine({ durable: true, root, sessionId: 'session-drift' });
    await first.initialize();
    await first.registerEvidence(evidenceRecord('evidence:request:tool-1', 'digest-one'));
    await first.close();

    const resumed = new GovernanceEngine({ durable: true, root, sessionId: 'session-drift' });
    await resumed.initialize();
    const drifted = await resumed.registerEvidence(evidenceRecord('evidence:request:tool-1', 'digest-two'));
    assert.notEqual(drifted.id, 'evidence:request:tool-1');
    await resumed.close();

    const verified = new GovernanceEngine({ durable: true, root, sessionId: 'session-drift' });
    await verified.initialize();
    assert.ok(verified.evidence('evidence:request:tool-1'));
    assert.ok(verified.evidence(drifted.id));
    await verified.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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

test('governance health aggregates attention and incomplete effect trails without payload content', async () => {
  const governance = new GovernanceEngine({ durable: false, sessionId: 'health-summary' });
  const evidence = await governance.registerEvidence({
    ...evidenceRecord('evidence-attention', 'private-content-fingerprint'),
    state: 'quarantined', kind: 'claim_observation',
  });
  await governance.decide({
    id: 'decision-unsettled', domain: 'claim_support', subjectRef: 'claim:one',
    subjectFingerprint: 'claim-one', outcome: 'quarantine', reasonCode: 'support_missing',
    policyVersion: 'test/1', evidenceRefs: [evidence.id], authorityRefs: [], decidedAt: 10,
  });
  await governance.decide({
    id: 'decision-effectful', domain: 'action_authorization', subjectRef: 'tool:one',
    subjectFingerprint: 'tool-one', outcome: 'approve', reasonCode: 'authorized',
    policyVersion: 'test/1', evidenceRefs: [evidence.id], authorityRefs: [], decidedAt: 11,
  });
  const health = governance.health();
  assert.equal(health.status, 'attention');
  assert.equal(health.attention_evidence, 1);
  assert.equal(health.pending_evidence, 0);
  assert.equal(health.unsettled_decisions, 1);
  assert.equal(health.decisions_by_domain.claim_support, 1);
  assert.equal(health.decision_outcomes.quarantine, 1);
  assert.doesNotMatch(JSON.stringify(health), /private-content-fingerprint/u);
});

function evidenceRecord(id, content) {
  return {
    id, kind: 'test', origin: 'runtime', trust: 'observed', state: 'active',
    freshness: 'current', conflict: 'none', sourceRef: `source:${id}`,
    contentFingerprint: content, scope: { kind: 'session', fingerprint: 'retention' },
    observedAt: 1,
  };
}
