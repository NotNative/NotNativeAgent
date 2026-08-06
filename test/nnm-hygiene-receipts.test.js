// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { NnmHygieneReceipts } from '../src/nnm-hygiene-receipts.js';

test('NNM hygiene receipts are project-bound, content-free, and time-bounded', async () => {
  const workspace = 'D:\\project';
  const receipt = {
    contract: 'nnm.hygiene-receipt/1.0', receipt_id: 'a'.repeat(64),
    session_id: 'session-1', status: 'completed', candidates: 2,
    categories: { conflict: 1, stale: 1 }, project_fingerprint: digest(workspace),
    completed_at: '2026-08-06T01:02:03.000Z',
  };
  const reader = new NnmHygieneReceipts({ read: async () => `${JSON.stringify(receipt)}\n` });
  assert.equal((await reader.latest({ workspaceRoot: workspace, since: Date.parse('2026-08-06T01:00:00Z') })).candidates, 2);
  assert.equal(await reader.latest({ workspaceRoot: workspace, since: Date.parse('2026-08-06T02:00:00Z') }), null);
  assert.doesNotMatch(JSON.stringify(receipt), /memory text|prompt|secret/iu);
});

test('NNM hygiene receipt reader ignores malformed and unrelated contracts', async () => {
  const reader = new NnmHygieneReceipts({ read: async () => '{bad}\n{"contract":"other"}\n' });
  assert.equal(await reader.latest({ workspaceRoot: 'x', since: 0 }), null);
});

function digest(value) { return createHash('sha256').update(value).digest('hex'); }
