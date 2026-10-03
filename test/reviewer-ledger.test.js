// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ReviewerLedger, requestDigest } from '../src/persistence/reviewer-ledger.js';
import { JournalStore } from '../src/store.js';

function request(id = 'tool-request-1') {
  return Object.freeze({
    id, providerCallId: 'provider-1', toolName: 'fs_write_text',
    args: { path: 'private-name.txt', content: 'seeded-secret-content', expected_sha256: null },
    resolved: { path: 'D:/workspace/private-name.txt', exists: false },
    authorityId: 'authority-1', authorityVersion: 1,
    policyVersion: 1, definitionVersion: 1,
  });
}

test('AC-REV-03/AC-REV-07/AC-OBS-03 durable governance audit is complete, redacted, and exactly once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-ledger-'));
  const ledger = new ReviewerLedger({ durable: true, root, sessionId: 'session-ledger' });
  await ledger.initialize();
  const toolRequest = request();
  const classification = { risk: 'review_required', scope: 'workspace' };
  await ledger.propose(toolRequest, classification);
  const decision = {
    id: 'decision-1', outcome: 'approve', reasonCode: 'intent_match',
    requestId: toolRequest.id, requestDigest: requestDigest(toolRequest),
  };
  assert.equal(await ledger.commitDecision(toolRequest.id, decision), decision);
  assert.equal(await ledger.commitDecision(toolRequest.id, { outcome: 'hard_deny' }), decision);
  await ledger.executionStarted(toolRequest.id, decision.id);
  const terminal = { status: 'succeeded', effect_certainty: 'completed', result_fingerprint: 'safe' };
  assert.equal(await ledger.settle(toolRequest.id, terminal), terminal);
  assert.equal(await ledger.settle(toolRequest.id, { status: 'failed' }), terminal);
  await ledger.close();
  const journal = await readFile(join(root, 'session-ledger.review.journal.ndjson'), 'utf8');
  assert.doesNotMatch(journal, /seeded-secret-content/u);
  assert.doesNotMatch(journal, /private-name\.txt/u);
  const restored = new ReviewerLedger({ durable: true, root, sessionId: 'session-ledger' });
  await restored.initialize();
  const audit = restored.audit();
  assert.equal(audit.length, 1);
  assert.equal(audit[0].decision, 'approve');
  assert.equal(audit[0].result, 'succeeded');
  assert.deepEqual(Object.keys(audit[0]).sort(), [
    'boundary_revalidation', 'complexity', 'decision', 'decision_provenance',
    'effect', 'effect_certainty', 'elapsed_ms', 'reason', 'repetition',
    'request_id', 'result', 'risk', 'scope', 'target_fingerprint', 'tool',
  ]);
  assert.equal(audit[0].boundary_revalidation, 'passed');
  assert.equal(audit[0].decision_provenance, 'mandatory_reviewer');
  assert.doesNotMatch(JSON.stringify(audit), /seeded-secret-content|private-name\.txt/u);
  await restored.close();
});

test('reviewer retention atomically removes expired durable entries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-ledger-retention-'));
  const options = { durable: true, root, sessionId: 'retained', retentionEntries: 2 };
  const ledger = new ReviewerLedger(options);
  await ledger.initialize();
  for (let index = 1; index <= 3; index += 1) {
    const item = request(`retention-request-${index}`);
    await ledger.propose(item, { risk: 'review_required', scope: 'workspace' });
    await ledger.commitDecision(item.id, { id: `decision-${index}`, outcome: 'approve', reasonCode: 'test' });
    await ledger.executionStarted(item.id, `decision-${index}`);
    await ledger.settle(item.id, { status: 'succeeded', effect_certainty: 'completed' });
  }
  assert.deepEqual(ledger.audit().map((item) => item.request_id), ['retention-request-2', 'retention-request-3']);
  await ledger.close();
  const path = join(root, 'retained.review.journal.ndjson');
  assert.doesNotMatch(await readFile(path, 'utf8'), /retention-request-1/u);
  const restored = new ReviewerLedger(options);
  await restored.initialize();
  assert.equal(restored.health().retention_entries, 2);
  assert.deepEqual(restored.audit().map((item) => item.request_id), ['retention-request-2', 'retention-request-3']);
  await restored.close();
});

test('retention preserves an older pending review while newer reviews settle and survives replay', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-ledger-overlap-'));
  const options = { durable: true, root, sessionId: 'overlap', retentionEntries: 1 };
  const ledger = new ReviewerLedger(options);
  await ledger.initialize();
  const pending = request('pending-review');
  await ledger.propose(pending, { risk: 'review_required', scope: 'workspace' });
  const completed = request('completed-review');
  await ledger.propose(completed, { risk: 'review_required', scope: 'workspace' });
  await ledger.commitDecision(completed.id, { id: 'completed-decision', outcome: 'approve' });
  await ledger.executionStarted(completed.id, 'completed-decision');
  await ledger.settle(completed.id, { status: 'succeeded', effect_certainty: 'completed' });
  const denied = request('denied-review');
  await ledger.propose(denied, { risk: 'review_required', scope: 'workspace' });
  await ledger.commitDecision(denied.id, { id: 'denied-decision', outcome: 'hard_deny' });
  assert.deepEqual(ledger.audit().map(item => item.request_id), [pending.id, denied.id]);
  await ledger.close();
  const journalPath = join(root, 'overlap.review.journal.ndjson');
  assert.doesNotMatch(await readFile(journalPath, 'utf8'), /completed-review/u);
  const restored = new ReviewerLedger(options);
  await restored.initialize();
  assert.deepEqual(restored.audit().map(item => item.request_id), [pending.id, denied.id]);
  const next = await restored.propose(request('next-review'), { risk: 'review_required', scope: 'workspace' });
  assert.equal(next.repetition, 2);
  await restored.commitDecision(pending.id, { id: 'pending-decision', outcome: 'approve' });
  await restored.executionStarted(pending.id, 'pending-decision');
  await restored.settle(pending.id, { status: 'succeeded', effect_certainty: 'completed' });
  assert.deepEqual(restored.audit().map(item => item.request_id), [next.requestId, pending.id]);
  await restored.close();
  const again = new ReviewerLedger(options);
  await again.initialize();
  assert.deepEqual(again.audit().map(item => item.request_id), [next.requestId, pending.id]);
  assert.equal(again.execution(pending.id)?.terminal?.status, 'succeeded');
  await again.close();
});

test('a proposal arriving during durable compaction remains available in memory and after restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-ledger-compaction-race-'));
  const options = { durable: true, root, sessionId: 'compaction-race', retentionEntries: 1 };
  const ledger = new ReviewerLedger(options);
  await ledger.initialize();
  await ledger.propose(request('older-pending'), { risk: 'review_required', scope: 'workspace' });
  for (const id of ['first-settled', 'second-settled']) {
    await ledger.propose(request(id), { risk: 'review_required', scope: 'workspace' });
    await ledger.commitDecision(id, { id: `${id}-decision`, outcome: 'approve' });
    await ledger.executionStarted(id, `${id}-decision`);
    if (id === 'first-settled') await ledger.settle(id, { status: 'succeeded', effect_certainty: 'completed' });
  }
  let enterReplace, releaseReplace;
  const entered = new Promise(resolve => { enterReplace = resolve; });
  const release = new Promise(resolve => { releaseReplace = resolve; });
  const original = JournalStore.prototype.replace;
  JournalStore.prototype.replace = async function (records) {
    enterReplace();
    await release;
    return original.call(this, records);
  };
  try {
    const settling = ledger.settle('second-settled', { status: 'succeeded', effect_certainty: 'completed' });
    await entered;
    const proposing = ledger.propose(request('new-pending'), { risk: 'review_required', scope: 'workspace' });
    releaseReplace();
    await Promise.all([settling, proposing]);
    assert.deepEqual(ledger.audit().map(item => item.request_id),
      ['older-pending', 'second-settled', 'new-pending']);
  } finally {
    releaseReplace();
    JournalStore.prototype.replace = original;
    await ledger.close();
  }
  const restored = new ReviewerLedger(options);
  await restored.initialize();
  assert.deepEqual(restored.audit().map(item => item.request_id),
    ['older-pending', 'second-settled', 'new-pending']);
  await restored.close();
});

test('pending operator escalation survives denial compaction until the operator decides', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-ledger-escalation-retention-'));
  const options = { durable: true, root, sessionId: 'escalation', retentionEntries: 1 };
  const ledger = new ReviewerLedger(options);
  await ledger.initialize();
  await ledger.propose(request('operator-pending'), { risk: 'review_required', scope: 'workspace' });
  await ledger.commitDecision('operator-pending', { id: 'escalation', outcome: 'escalate_to_operator' });
  for (const id of ['older-denial', 'newer-denial']) {
    await ledger.propose(request(id), { risk: 'review_required', scope: 'workspace' });
    await ledger.commitDecision(id, { id: `${id}-decision`, outcome: 'hard_deny' });
  }
  assert.deepEqual(ledger.audit().map(item => item.request_id), ['operator-pending', 'newer-denial']);
  await ledger.close();
  const restored = new ReviewerLedger(options);
  await restored.initialize();
  await restored.commitOperatorDecision('operator-pending', { id: 'operator-denial', outcome: 'deny_with_guidance' });
  assert.deepEqual(restored.audit().map(item => item.request_id), ['operator-pending']);
  await restored.close();
});

test('a failed tool with an uncertain external effect survives compaction and restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-ledger-uncertain-retention-'));
  const options = { durable: true, root, sessionId: 'uncertain', retentionEntries: 1 };
  const ledger = new ReviewerLedger(options);
  await ledger.initialize();
  const uncertain = request('uncertain-write');
  await ledger.propose(uncertain, { risk: 'review_required', scope: 'workspace' }, { turnId: 'uncertain-turn' });
  await ledger.commitDecision(uncertain.id, { id: 'uncertain-decision', outcome: 'approve' });
  await ledger.executionStarted(uncertain.id, 'uncertain-decision');
  await ledger.settle(uncertain.id, { status: 'failed', effect_certainty: 'unknown', reason_code: 'executor_failure' });
  for (const id of ['older-denial', 'newer-denial']) {
    await ledger.propose(request(id), { risk: 'review_required', scope: 'workspace' });
    await ledger.commitDecision(id, { id: `${id}-decision`, outcome: 'hard_deny' });
  }
  assert.deepEqual(ledger.audit().map(item => item.request_id), [uncertain.id, 'newer-denial']);
  assert.equal(ledger.completionState({ turnIds: ['uncertain-turn'] }).unresolved_count, 1);
  await ledger.close();
  const restored = new ReviewerLedger(options);
  await restored.initialize();
  assert.deepEqual(restored.audit().map(item => item.request_id), [uncertain.id, 'newer-denial']);
  assert.equal(restored.completionState({ turnIds: ['uncertain-turn'] }).unresolved_count, 1);
  await restored.close();
});

test('large reviewer retention compacts with headroom instead of rewriting every settle', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-ledger-headroom-'));
  const ledger = new ReviewerLedger({
    durable: true, root, sessionId: 'headroom', retentionEntries: 100,
  });
  await ledger.initialize();
  for (let index = 1; index <= 101; index += 1) {
    const item = request(`headroom-request-${index}`);
    await ledger.propose(item, { risk: 'review_required', scope: 'workspace' });
    await ledger.commitDecision(item.id, { id: `headroom-decision-${index}`, outcome: 'approve', reasonCode: 'test' });
    await ledger.executionStarted(item.id, `headroom-decision-${index}`);
    await ledger.settle(item.id, { status: 'succeeded', effect_certainty: 'completed' });
  }
  assert.equal(ledger.health().entries, 90);
  for (let index = 102; index <= 106; index += 1) {
    const item = request(`headroom-request-${index}`);
    await ledger.propose(item, { risk: 'review_required', scope: 'workspace' });
    await ledger.commitDecision(item.id, { id: `headroom-decision-${index}`, outcome: 'approve', reasonCode: 'test' });
    await ledger.executionStarted(item.id, `headroom-decision-${index}`);
    await ledger.settle(item.id, { status: 'succeeded', effect_certainty: 'completed' });
  }
  assert.equal(ledger.health().entries, 95);
  await ledger.close();
});

test('reviewer completion projection holds only possible-effect outcomes open and closes exact successful retries', async () => {
  const ledger = new ReviewerLedger({ durable: false, sessionId: 'completion-projection' });
  const denied = request('denied-write');
  await ledger.propose(denied, { risk: 'review_required', scope: 'workspace' }, {
    turnId: 'turn-blocked', operatorRequestId: 'operator-blocked',
  });
  await ledger.commitDecision(denied.id, {
    id: 'denied-decision', outcome: 'deny_with_guidance', reasonCode: 'semantic_review_unavailable',
  });
  // A rejection is a final classification: audited in the ledger, but it may not hold
  // completion open because no lawful settlement exists for it.
  assert.equal(ledger.completionState({ turnIds: ['turn-blocked'] }).unresolved_count, 0);

  const risky = request('risky-write');
  await ledger.propose(risky, { risk: 'review_required', scope: 'workspace' }, {
    turnId: 'turn-risky', operatorRequestId: 'operator-risky',
  });
  await ledger.commitDecision(risky.id, { id: 'risky-decision', outcome: 'approve', reasonCode: 'intent_match' });
  await ledger.executionStarted(risky.id, 'risky-decision');
  await ledger.settle(risky.id, {
    status: 'failed', effect_certainty: 'unknown', reason_code: 'executor_failure',
  });
  const unresolved = ledger.completionState({ turnIds: ['turn-risky'] });
  assert.equal(unresolved.unresolved_count, 1);
  assert.deepEqual(unresolved.unresolved[0], {
    request_id: 'risky-write', origin_turn_id: 'turn-risky', tool: 'fs_write_text',
    operation_fingerprint: unresolved.unresolved[0].operation_fingerprint,
    state: 'failed', reason_code: 'executor_failure', effect_certainty: 'unknown',
  });

  const invalid = Object.freeze({
    ...request('invalid-plan'), providerCallId: 'invalid-provider', toolName: 'work_plan',
    args: { revision: 1, objective: 'Track work', tasks: [] }, resolved: {},
  });
  await ledger.propose(invalid, { risk: 'safe', scope: 'conversation_work' }, {
    turnId: 'turn-invalid', operatorRequestId: 'operator-invalid',
  });
  await ledger.commitDecision(invalid.id, { id: 'invalid-decision', outcome: 'approve', reasonCode: 'deterministic_safe' });
  await ledger.executionStarted(invalid.id, 'invalid-decision');
  await ledger.settle(invalid.id, {
    status: 'invalid_request', effect_certainty: 'none', reason_code: 'work_revision_conflict',
  });
  assert.equal(ledger.completionState({ turnIds: ['turn-invalid'] }).unresolved_count, 0);

  const cancelled = Object.freeze({
    ...request('cancelled-read'), providerCallId: 'cancelled-provider', toolName: 'fs_read_text',
  });
  await ledger.propose(cancelled, { risk: 'safe', scope: 'workspace' }, {
    turnId: 'turn-cancelled', operatorRequestId: 'operator-cancelled',
  });
  await ledger.commitDecision(cancelled.id, { id: 'cancelled-decision', outcome: 'approve', reasonCode: 'deterministic_safe' });
  await ledger.executionStarted(cancelled.id, 'cancelled-decision');
  await ledger.settle(cancelled.id, { status: 'cancelled', effect_certainty: 'none', reason_code: 'tool_cancelled' });
  assert.equal(ledger.completionState({ turnIds: ['turn-cancelled'] }).unresolved_count, 0);

  const retry = request('successful-retry');
  await ledger.propose(retry, { risk: 'review_required', scope: 'workspace' }, {
    turnId: 'turn-retry', operatorRequestId: 'operator-retry',
  });
  await ledger.commitDecision(retry.id, { id: 'retry-decision', outcome: 'approve', reasonCode: 'intent_match' });
  await ledger.executionStarted(retry.id, 'retry-decision');
  await ledger.settle(retry.id, { status: 'succeeded', effect_certainty: 'completed', result_fingerprint: 'written' });
  assert.equal(ledger.completionState({ requestIds: ['risky-write'], turnIds: ['turn-retry'] }).unresolved_count, 0);
});

test('durable reviewer completion causality survives restart without retaining tool arguments', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-ledger-completion-'));
  const options = { durable: true, root, sessionId: 'completion-durable' };
  const ledger = new ReviewerLedger(options);
  await ledger.initialize();
  const risky = request('durable-unknown-effect');
  await ledger.propose(risky, { risk: 'review_required', scope: 'workspace' }, {
    turnId: 'durable-turn', operatorRequestId: 'durable-operator-request',
  });
  await ledger.commitDecision(risky.id, { id: 'durable-decision', outcome: 'approve', reasonCode: 'intent_match' });
  await ledger.executionStarted(risky.id, 'durable-decision');
  await ledger.settle(risky.id, { status: 'failed', effect_certainty: 'unknown', reason_code: 'executor_failure' });
  await ledger.close();
  const restored = new ReviewerLedger(options);
  await restored.initialize();
  const state = restored.completionState({ turnIds: ['durable-turn'] });
  assert.equal(state.unresolved_count, 1);
  assert.equal(state.unresolved[0].request_id, 'durable-unknown-effect');
  assert.equal(state.unresolved[0].effect_certainty, 'unknown');
  assert.doesNotMatch(await readFile(join(root, 'completion-durable.review.journal.ndjson'), 'utf8'),
    /seeded-secret-content|private-name\.txt/u);
  await restored.close();
});
