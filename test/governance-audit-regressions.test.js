// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GovernanceEngine } from '../src/governance-engine.js';
import { normalizeGovernanceEvidence } from '../src/governance/contracts.js';
import { JournalStore, recoverJournal } from '../src/store.js';

const evidence = normalizeGovernanceEvidence({ id: 'evidence:stable', kind: 'runtime_observation',
  origin: 'runtime', trust: 'observed', sourceRef: 'event:stable', sourceFingerprint: 'stable',
  contentFingerprint: 'stable', scope: { kind: 'session', fingerprint: 'session-stable' }, observedAt: 100 });

test('unchanged registration preserves stale and invalidated lifecycle across checkpoint and restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-governance-identity-'));
  const first = new GovernanceEngine({ durable: true, root, sessionId: 'identity', retentionEntries: 4 });
  try {
    await first.initialize(); await first.registerEvidence(evidence);
    await first.transitionEvidence(evidence.id, 'stale');
    assert.equal((await first.registerEvidence(evidence)).state, 'stale');
    await first.decide({ id: 'decision:retained', domain: 'evidence_admission', subjectRef: 'stable',
      subjectFingerprint: 'stable', outcome: 'quarantine', reasonCode: 'stale', policyVersion: 'test/1',
      evidenceRefs: [evidence.id], authorityRefs: [evidence.id], decidedAt: 101 });
    for (let index = 0; index < 6; index += 1) await first.registerEvidence({ ...evidence, id: `extra-${index}` });
    await first.transitionEvidence(evidence.id, 'invalidated');
    await first.close();
    const resumed = new GovernanceEngine({ durable: true, root, sessionId: 'identity', retentionEntries: 4 });
    try {
      await resumed.initialize();
      const repeated = await resumed.registerEvidence(evidence);
      assert.equal(repeated.id, evidence.id); assert.equal(repeated.state, 'invalidated');
      await assert.rejects(resumed.transitionEvidence(evidence.id, 'active'), { code: 'governance_evidence_transition_invalid' });
      const changed = await resumed.registerEvidence({ ...evidence, contentFingerprint: 'changed' });
      assert.notEqual(changed.id, evidence.id); assert.equal(changed.conflict, 'suspected');
      assert.equal(resumed.evidence(evidence.id).state, 'invalidated');
    } finally { await resumed.close(); }
  } finally { await first.close(); await rm(root, { recursive: true, force: true }); }
});

test('default governance recovery migrates a valid transition journal beyond its tail without losing state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-governance-tail-'));
  const records = [{ type: 'evidence_registered', payload: { evidence } }];
  for (let index = 0; index < 80001; index += 1) records.push({ type: 'evidence_transitioned', payload: {
    transition: { id: evidence.id, from: index % 2 ? 'stale' : 'active', to: index % 2 ? 'active' : 'stale',
      at: 101 + index, reasonCode: 'freshness_changed', evidenceRefs: [] } } });
  const journal = new JournalStore(root, 'legacy.governance');
  const governance = new GovernanceEngine({ durable: true, root, sessionId: 'legacy' });
  try {
    await journal.open(); await journal.replace(records); await journal.close();
    await governance.initialize();
    assert.equal(governance.evidence(evidence.id).state, 'stale');
    assert.equal((await governance.registerEvidence(evidence)).id, evidence.id);
    await governance.close();
    const recovered = await recoverJournal(journal.path);
    assert.equal(recovered.records.length, 1);
    const checkpoint = recovered.records[0];
    assert.equal(checkpoint.type, 'evidence_checkpoint');
    assert.equal(checkpoint.payload.evidence.state, 'active');
    assert.equal(checkpoint.payload.lifecycle.state, 'stale');
    assert.equal(checkpoint.payload.lifecycle.transitionCount, 80001);
    const resumed = new GovernanceEngine({ durable: true, root, sessionId: 'legacy' });
    try {
      await resumed.initialize(); await resumed.transitionEvidence(evidence.id, 'active');
      assert.equal(resumed.evidence(evidence.id).state, 'active');
    } finally { await resumed.close(); }
  } finally { await governance.close(); await journal.close(); await rm(root, { recursive: true, force: true }); }
});

test('governance replay rejects invalid checkpoint and transition source rather than reviving evidence', async () => {
  for (const record of [
    { type: 'evidence_checkpoint', payload: { evidence } },
    { type: 'evidence_transitioned', payload: { transition: { id: evidence.id, from: 'stale', to: 'active' } } },
  ]) {
    const root = await mkdtemp(join(tmpdir(), 'nna-governance-invalid-'));
    const journal = new JournalStore(root, 'invalid.governance');
    const governance = new GovernanceEngine({ durable: true, root, sessionId: 'invalid' });
    try {
      await journal.open(); await journal.replace([{ type: 'evidence_registered', payload: { evidence } }, record]); await journal.close();
      await assert.rejects(governance.initialize(), { code: record.type === 'evidence_checkpoint'
        ? 'governance_checkpoint_invalid' : 'governance_evidence_transition_invalid' });
    } finally { await governance.close(); await journal.close(); await rm(root, { recursive: true, force: true }); }
  }
});
