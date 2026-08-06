// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { NnmGovernanceReceipts } from '../src/nnm-governance-receipts.js';

test('NNM governance receipts are bounded, correlated, and content-free', async () => {
  const workspace = 'D:\\work';
  const receipt = {
    contract: 'nnm.turn-analysis-receipt/1.0', receipt_id: 'a'.repeat(64),
    session_id: 'session-1', turn_id: 'turn-1', status: 'completed', stored: 2,
    facts_stored: 1, relationships_stored: 0, summary_stored: true, candidates: 4,
    project_fingerprint: createHash('sha256').update(workspace).digest('hex'),
    completed_at: new Date().toISOString(),
  };
  const reader = new NnmGovernanceReceipts({ read: async () => `${JSON.stringify(receipt)}\nnot-json\n` });
  const found = await reader.matching({ workspaceRoot: workspace, sessionIds: ['session-1'], turnIds: ['turn-1'] });
  assert.equal(found.length, 1);
  assert.equal(found[0].stored, 2);
  assert.equal(JSON.stringify(found).includes('content'), false);
});

test('NNM governance receipts reject oversized journals', async () => {
  const reader = new NnmGovernanceReceipts({ read: async () => 'x'.repeat(4_194_305) });
  await assert.rejects(() => reader.matching({ workspaceRoot: 'x', turnIds: [] }), { code: 'nnm_receipts_too_large' });
});
