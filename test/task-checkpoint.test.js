// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { renderTaskCheckpoint, writeTaskCheckpoint } from '../src/task-checkpoint.js';

test('task checkpoint contains bounded operational state without verbatim tool payloads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-checkpoint-'));
  const engine = fixtureEngine(join(root, 'session.journal.ndjson'));
  const fact = fixtureFact();
  try {
    const path = await writeTaskCheckpoint(engine, fact);
    const text = await readFile(path, 'utf8');
    assert.match(text, /Ship reliable hierarchical compaction/u);
    assert.match(text, /\[in_progress\] T1: Add checkpoint/u);
    assert.match(text, /src\/compaction\.js/u);
    assert.doesNotMatch(text, /secret-token-123/u);
    assert.ok(Buffer.byteLength(text, 'utf8') < 32_000);
    await writeTaskCheckpoint(engine, { ...fact, sourceFingerprint: 'b'.repeat(64) });
    assert.match(await readFile(path, 'utf8'), /bbbbbbbb/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('task checkpoint renderer is usable without a store or explicit work state', () => {
  const text = renderTaskCheckpoint({ sessionId: 'standalone' }, fixtureFact());
  assert.match(text, /Derived operational state/u);
  assert.match(text, /Finish the regression suite/u);
});

function fixtureEngine(path) {
  return {
    sessionId: 'session-1', store: { path },
    work: { snapshot: () => ({
      goal: { objective: 'Ship reliable hierarchical compaction' },
      tasks: [{ id: 'T1', title: 'Add checkpoint', status: 'in_progress', evidence: null, blockedReason: null }],
    }) },
  };
}

function fixtureFact() {
  return {
    sourceFingerprint: 'a'.repeat(64), omitted: 42,
    continuation: {
      objective: 'Finish the regression suite', recentDirectives: ['Keep exact evidence in the ledger'],
      completedWork: ['Reduced raw-tool-payload into a receipt'],
      changedFiles: [{ path: 'src/compaction.js', operation: 'fs.edit_text', status: 'succeeded' }],
      verifiedFacts: ['Authorization: Bearer secret-token-123'], unresolvedTools: [],
      openQuestions: [], nextActions: ['Run all tests'],
    },
  };
}
