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
