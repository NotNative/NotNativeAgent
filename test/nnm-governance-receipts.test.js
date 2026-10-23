// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NnmGovernanceReceipts } from '../src/nnm-governance-receipts.js';
import { admitNnmReceipt } from '../src/dream-governance-admission.js';
import { GovernanceEngine } from '../src/governance-engine.js';

function receiptFor(workspace, overrides = {}) {
  return {
    contract: 'nnm.turn-analysis-receipt/1.0', receipt_id: 'a'.repeat(64),
    session_id: 'session-1', turn_id: 'turn-1', status: 'completed', stored: 2,
    facts_stored: 1, relationships_stored: 0, summary_stored: true, candidates: 4,
    project_fingerprint: createHash('sha256').update(workspace).digest('hex'),
    completed_at: new Date().toISOString(), ...overrides,
  };
}

test('NNM governance receipts are bounded, correlated, and content-free', async () => {
  const workspace = 'D:\\work';
  const receipt = receiptFor(workspace);
  const reader = new NnmGovernanceReceipts({ read: async () => `${JSON.stringify(receipt)}\nnot-json\n` });
  const found = await reader.matching({ workspaceRoot: workspace, sessionIds: ['session-1'], turnIds: ['turn-1'] });
  assert.equal(found.length, 1);
  assert.equal(found[0].stored, 2);
  assert.equal(JSON.stringify(found).includes('content'), false);
});

test('session-only receipt queries match their session without admitting an unscoped query', async () => {
  const workspace = 'D:\\work';
  const receipt = receiptFor(workspace);
  const reader = new NnmGovernanceReceipts({ read: async () => `${JSON.stringify(receipt)}\n` });
  assert.deepEqual((await reader.matching({ workspaceRoot: workspace, sessionIds: ['session-1'] }))
    .map((item) => item.receipt_id), [receipt.receipt_id]);
  assert.deepEqual(await reader.matching({ workspaceRoot: workspace }), []);
  assert.deepEqual(await reader.matching({ workspaceRoot: workspace, sessionIds: ['other'] }), []);
});

test('conflicting duplicate receipt IDs are excluded while malformed evidence is reported per call', async () => {
  const workspace = 'D:\\work';
  const original = receiptFor(workspace);
  const conflicting = { ...original, facts_stored: 100 };
  const diagnostics = [];
  let content = [original, conflicting].map((item) => JSON.stringify(item)).join('\n');
  const reader = new NnmGovernanceReceipts({
    read: async () => content,
    onDiagnostic: (event) => diagnostics.push(event),
  });
  assert.deepEqual(await reader.matching({ workspaceRoot: workspace, turnIds: ['turn-1'] }), []);
  assert.deepEqual(diagnostics, [{ code: 'nnm_receipt_lines_malformed', count: 1 }]);
  content = `${JSON.stringify(original)}\n${JSON.stringify(original)}`;
  assert.equal((await reader.matching({ workspaceRoot: workspace, turnIds: ['turn-1'] })).length, 1);
  assert.equal(diagnostics.length, 1);
  content = JSON.stringify({ ...original, completed_at: '2024-13-40T25:70:80.000Z' });
  assert.deepEqual(await reader.matching({ workspaceRoot: workspace, turnIds: ['turn-1'] }), []);
  assert.deepEqual(diagnostics.at(-1), { code: 'nnm_receipt_lines_malformed', count: 1 });
});

test('writer-compatible receipts preserve status but exclude diagnostic reason text', async () => {
  const workspace = 'D:\\work';
  const completed = receiptFor(workspace, {
    completed_at: '2026-10-22T10:11:12.123456+00:00', related_memories_considered: 3,
  });
  const failed = receiptFor(workspace, {
    receipt_id: 'b'.repeat(64), status: 'failed', completed_at: '2026-10-22T10:11:13+00:00',
    reason: 'Secret-bearing provider error text', related_memories_considered: 0,
  });
  const reader = new NnmGovernanceReceipts({ read: async () => `${JSON.stringify(completed)}\n${JSON.stringify(failed)}\n` });
  const result = await reader.matching({ workspaceRoot: workspace, sessionIds: ['session-1'] });
  assert.deepEqual(result.map((item) => item.status), ['completed', 'failed']);
  assert.equal(result[0].related_memories_considered, 3);
  assert.equal(JSON.stringify(result).includes(failed.reason), false);
});

test('a later analyzer retry supersedes its failed attempt without accepting an identity conflict', async () => {
  const workspace = 'D:\\work';
  const failed = receiptFor(workspace, { status: 'failed', stored: 0,
    completed_at: '2026-10-22T10:11:12.123456+00:00' });
  const completed = receiptFor(workspace, { completed_at: '2026-10-22T10:11:13.000001+00:00' });
  const reader = new NnmGovernanceReceipts({ read: async () => `${JSON.stringify(failed)}\n${JSON.stringify(completed)}` });
  assert.deepEqual((await reader.matching({ workspaceRoot: workspace, turnIds: ['turn-1'] }))
    .map((item) => item.status), ['completed']);
  const conflicted = new NnmGovernanceReceipts({ read: async () => `${JSON.stringify(completed)}\n${JSON.stringify({
    ...completed, session_id: 'session-other', completed_at: '2026-10-22T10:11:14.000001+00:00',
  })}` });
  assert.deepEqual(await conflicted.matching({ workspaceRoot: workspace, turnIds: ['turn-1'] }), []);
});

test('writer-style UTC timestamps reject impossible calendar dates', async () => {
  const workspace = 'D:\\work';
  const reader = new NnmGovernanceReceipts({ read: async () => JSON.stringify(receiptFor(workspace, {
    completed_at: '2026-02-30T10:11:12.123456+00:00',
  })) });
  assert.deepEqual(await reader.matching({ workspaceRoot: workspace, turnIds: ['turn-1'] }), []);
});

test('known hygiene receipts in the shared journal are not malformed turn receipts', async () => {
  const workspace = 'D:\\work';
  const diagnostics = [];
  const turn = receiptFor(workspace);
  const reader = new NnmGovernanceReceipts({
    read: async () => `${JSON.stringify({ contract: 'nnm.hygiene-receipt/1.0' })}\n${JSON.stringify(turn)}\n`,
    onDiagnostic: (event) => diagnostics.push(event),
  });
  assert.equal((await reader.matching({ workspaceRoot: workspace, turnIds: ['turn-1'] })).length, 1);
  assert.deepEqual(diagnostics, []);
});

test('observed NNM failures and partial effects are not admitted as completed effects', async () => {
  const workspace = 'D:\\work';
  const governance = new GovernanceEngine({ sessionId: 'session-1' });
  await governance.initialize();
  const engine = { governance };
  for (const [status, outcome, terminalStatus] of [
    ['completed', 'admit', 'applied'], ['partial', 'defer', 'unknown_effect'],
    ['skipped', 'defer', 'not_applied'], ['failed', 'defer', 'unknown_effect'],
  ]) {
    const receipt = receiptFor(workspace, {
      receipt_id: createHash('sha256').update(status).digest('hex'), status,
      completed_at: '2026-10-22T10:11:12.123456+00:00',
    });
    await admitNnmReceipt(engine, receipt, workspace);
    const decision = governance.audit().find((item) => item.id === `governance:nnm-receipt:${receipt.receipt_id}`);
    assert.equal(decision.outcome, outcome);
    assert.equal(decision.terminal.status, terminalStatus);
    assert.equal(governance.evidence(`evidence:nnm-receipt:${receipt.receipt_id}`).attributes.analysis_status, status);
  }
});

test('the default receipt reader admits a small on-disk journal', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'nna-nnm-receipt-read-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = 'D:\\work';
  const path = join(root, 'receipts.ndjson');
  await writeFile(path, `${JSON.stringify(receiptFor(workspace))}\n`);
  const reader = new NnmGovernanceReceipts({ path });
  assert.equal((await reader.matching({ workspaceRoot: workspace, turnIds: ['turn-1'] })).length, 1);
});

test('NNM governance receipts reject oversized journals', async () => {
  const reader = new NnmGovernanceReceipts({ read: async () => 'x'.repeat(4_194_305) });
  await assert.rejects(() => reader.matching({ workspaceRoot: 'x', turnIds: [] }), { code: 'nnm_receipts_too_large' });
});
