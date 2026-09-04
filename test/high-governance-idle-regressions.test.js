// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { GovernanceEngine } from '../src/governance-engine.js';
import { ReviewerLedger } from '../src/persistence/reviewer-ledger.js';
import { retentionCompactionTarget } from '../src/persistence/retention.js';
import { governanceFingerprint, normalizeGovernanceEvidence } from '../src/governance/contracts.js';
import { IdleArbiter } from '../src/idle-arbiter.js';

test('invalid retention cannot reach compaction or a journal owner', () => {
  for (const limit of [0, -1, 0.5, NaN, Infinity, '10']) {
    assert.throws(() => retentionCompactionTarget(limit), { code: 'retention_limit_invalid' });
    assert.throws(() => new GovernanceEngine({ retentionEntries: limit }), { code: 'retention_limit_invalid' });
    assert.throws(() => new ReviewerLedger({ retentionEntries: limit }), { code: 'retention_limit_invalid' });
  }
  assert.throws(() => new GovernanceEngine({ retentionEntries: 25001 }), { code: 'retention_limit_invalid' });
  assert.equal(new GovernanceEngine({ retentionEntries: 25000 }).health().retention_entries, 25000);
  assert.equal(retentionCompactionTarget(100), 90);
});

test('governance rejects nonfinite scalar attributes and fingerprints', () => {
  const evidence = { id: 'e', kind: 'fixture', origin: 'runtime', trust: 'observed', sourceRef: 'source',
    contentFingerprint: 'content', scope: { kind: 'workspace', fingerprint: 'workspace' } };
  for (const value of [NaN, Infinity, -Infinity]) {
    assert.throws(() => normalizeGovernanceEvidence({ ...evidence, attributes: { value } }), { code: 'governance_attributes_invalid' });
    assert.throws(() => governanceFingerprint({ value }), { code: 'governance_fingerprint_invalid' });
  }
  assert.equal(governanceFingerprint({ value: -0 }), governanceFingerprint({ value: 0 }));
});

function arbiter(eligible, runStage = async () => ({})) {
  const events = []; let timers = 0;
  const value = new IdleArbiter({ idleMs: 10, interStageMs: 10, eligible, runStage,
    setTimer: () => ++timers, clearTimer() {}, onState: (event) => events.push(event) });
  return { value, events, timers: () => timers };
}

test('stale eligibility results cannot overwrite close, pause, or fresh activity timer', async () => {
  for (const action of ['close', 'pause', 'activity']) {
    let release;
    const fixture = arbiter(() => new Promise((resolve) => { release = resolve; }));
    fixture.value.start(); const operation = fixture.value.runNow(); fixture.value[action]();
    const count = fixture.events.length, timers = fixture.timers(); release(false);
    await operation; assert.equal(fixture.events.length, count); assert.equal(fixture.timers(), timers); fixture.value.close();
  }
});

test('real stage failure after activity is not mislabeled as cancellation or rescheduled', async () => {
  let fail, entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const fixture = arbiter(async () => true, async () => { entered(); await new Promise((_, reject) => { fail = reject; }); });
  fixture.value.start(); const operation = fixture.value.runNow(); await started;
  fixture.value.activity(); const timers = fixture.timers();
  fail(Object.assign(new Error('disk failed'), { code: 'EIO' }));
  assert.equal((await operation).state, 'failed'); assert.equal(fixture.timers(), timers);
  assert.equal(fixture.events.at(-1).code, 'EIO'); fixture.value.close();
});
