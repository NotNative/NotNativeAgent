// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { NnmHygieneReceipts } from '../src/nnm-hygiene-receipts.js';

test('NNM hygiene receipts are project-bound, content-free, and time-bounded', async () => {
  const workspace = 'D:\\project';
  const receipt = {
    contract: 'nnm.hygiene-receipt/1.0', receipt_id: 'a'.repeat(64),
    session_id: 'session-1', status: 'completed', candidates: 2,
    categories: { unresolved_conflict: 1, hot_unclassified: 1 }, project_fingerprint: digest(workspace),
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

test('known turn-analysis receipts in the shared journal are not malformed hygiene receipts', async () => {
  const workspace = 'D:\\project';
  const diagnostics = [];
  const hygiene = {
    contract: 'nnm.hygiene-receipt/1.0', receipt_id: 'a'.repeat(64),
    session_id: 'session-1', status: 'completed', candidates: 0, categories: {},
    project_fingerprint: digest(workspace), completed_at: '2026-08-06T01:02:03.000Z',
  };
  const reader = new NnmHygieneReceipts({
    read: async () => `${JSON.stringify({ contract: 'nnm.turn-analysis-receipt/1.0' })}\n${JSON.stringify(hygiene)}\n`,
    onDiagnostic: (event) => diagnostics.push(event),
  });
  assert.equal((await reader.latest({ workspaceRoot: workspace })).receipt_id, hygiene.receipt_id);
  assert.deepEqual(diagnostics, []);
});

test('default hygiene reader bounds the shared journal before materializing it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-hygiene-bound-'));
  const path = join(root, 'receipts.jsonl');
  await writeFile(path, 'x'.repeat(4_194_305));
  await assert.rejects(new NnmHygieneReceipts({ path }).latest({ workspaceRoot: root }), {
    code: 'nnm_receipts_too_large',
  });
});

test('hygiene receipt selection orders UTC instants and prefers the last append on a tie', async () => {
  const root = 'D:\\project';
  const base = {
    contract: 'nnm.hygiene-receipt/1.0', session_id: 'session', status: 'completed',
    candidates: 0, categories: {}, project_fingerprint: digest(root),
  };
  const earlier = { ...base, receipt_id: 'a'.repeat(64), completed_at: '2026-10-20T22:00:00Z' };
  const later = { ...base, receipt_id: 'b'.repeat(64), completed_at: '2026-10-20T22:00:00.000001+00:00' };
  const tie = { ...base, receipt_id: 'c'.repeat(64), completed_at: '2026-10-20T22:00:00.000001Z' };
  const reader = new NnmHygieneReceipts({ read: async () => [earlier, later, tie].map(JSON.stringify).join('\n') });
  assert.equal((await reader.latest({ workspaceRoot: root })).receipt_id, tie.receipt_id);
});

test('a later malformed same-project hygiene receipt cannot make an older receipt current', async () => {
  const root = 'D:\\project';
  const valid = {
    contract: 'nnm.hygiene-receipt/1.0', receipt_id: 'a'.repeat(64),
    session_id: 'session', status: 'completed', candidates: 0, categories: {},
    project_fingerprint: digest(root), completed_at: '2026-10-20T22:00:00.000001+00:00',
  };
  const invalid = { ...valid, receipt_id: 'b'.repeat(64), candidates: -1 };
  const reader = new NnmHygieneReceipts({
    read: async () => `${JSON.stringify(valid)}\n${JSON.stringify(invalid)}\n`,
    onDiagnostic: () => { throw new Error('observer unavailable'); },
  });
  assert.equal(await reader.latest({ workspaceRoot: root }), null);
});

test('hygiene receipt accepts the writer maximum of 16 reasons across 100 candidates', async () => {
  const root = 'D:\\project';
  const receipt = {
    contract: 'nnm.hygiene-receipt/1.0', receipt_id: 'a'.repeat(64),
    session_id: 'maintenance', status: 'completed', candidates: 100,
    categories: { lint_warning: 1_600 }, project_fingerprint: digest(root),
    completed_at: '2026-10-20T22:00:00.000001+00:00',
  };
  const reader = new NnmHygieneReceipts({ read: async () => JSON.stringify(receipt) });
  assert.equal((await reader.latest({ workspaceRoot: root }))?.categories.lint_warning, 1_600);
  const impossible = { ...receipt, categories: { lint_warning: 1_600, other: 1 } };
  const rejected = new NnmHygieneReceipts({ read: async () => JSON.stringify(impossible) });
  assert.equal(await rejected.latest({ workspaceRoot: root }), null);
  const inconsistent = { ...receipt, candidates: 1, categories: { lint_warning: 17 } };
  const inconsistentReader = new NnmHygieneReceipts({ read: async () => JSON.stringify(inconsistent) });
  assert.equal(await inconsistentReader.latest({ workspaceRoot: root }), null);
});

test('hygiene receipt rejects a category outside the NNM writer vocabulary', async () => {
  const root = 'D:\\project';
  const receipt = {
    contract: 'nnm.hygiene-receipt/1.0', receipt_id: 'a'.repeat(64),
    session_id: 'maintenance', status: 'completed', candidates: 1,
    categories: { 'untrusted reason text': 1 }, project_fingerprint: digest(root),
    completed_at: '2026-10-20T22:00:00.000001+00:00',
  };
  const reader = new NnmHygieneReceipts({ read: async () => JSON.stringify(receipt) });
  assert.equal(await reader.latest({ workspaceRoot: root }), null);
});

function digest(value) { return createHash('sha256').update(value).digest('hex'); }
