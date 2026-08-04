// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ReviewerLedger, requestDigest } from '../src/reviewer-ledger.js';

function request(id = 'tool-request-1') {
  return Object.freeze({
    id, providerCallId: 'provider-1', toolName: 'fs.write_text',
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
