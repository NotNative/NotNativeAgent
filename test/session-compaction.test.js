// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SessionDataManager } from '../src/persistence/session-data.js';
import { restoreSessionRecords } from '../src/persistence/session-history.js';
import { JournalStore, recoverJournal } from '../src/store.js';

test('explicit journal compaction retains non-transcript state and the latest durable transcript snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-session-compact-'));
  const sessions = join(root, 'sessions');
  const id = 'compactable';
  try {
    const store = new JournalStore(sessions, id); await store.open();
    await store.append('session_header', { sessionId: id });
    await store.append('message', { type: 'message', role: 'user', content: 'old'.repeat(10_000) });
    await store.append('tool_result', { type: 'tool_result', content: 'large'.repeat(10_000) });
    await store.append('work_state', { revision: 1, goal: null, tasks: [] });
    const snapshotRecords = [{ type: 'message', role: 'user', content: 'compacted summary' }];
    const fact = { type: 'compaction', version: 2, omitted: 2, summary: 'summary', retainedRecords: [] };
    await store.append('compaction_snapshot', { records: snapshotRecords, fact });
    await store.append('message', { type: 'message', role: 'assistant', content: 'after boundary' });
    await store.close();
    const manager = new SessionDataManager({ sessionRoot: sessions, reviewerRoot: join(root, 'reviewer'), diagnosticsRoot: join(root, 'logs') });
    const preview = await manager.preview(id);
    const beforePreview = preview.categories.find((item) => item.category === 'transcript').bytes;
    await assert.rejects(manager.compact(id, 'yes'), { code: 'compaction_confirmation_required' });
    const result = await manager.compact(id, `compact:${id}`);
    assert.equal(result.before_bytes, beforePreview);
    assert.ok(result.after_bytes < result.before_bytes);
    assert.equal(result.removed_records, 2);
    const recovered = await recoverJournal(join(sessions, `${id}.journal.ndjson`));
    assert.deepEqual(recovered.records.map((item) => item.type), [
      'session_header', 'work_state', 'compaction_snapshot', 'message',
    ]);
    assert.deepEqual(restoreSessionRecords(recovered.records).transcript, [
      ...snapshotRecords, fact, { type: 'message', role: 'assistant', content: 'after boundary' },
    ]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('journal compaction refuses active sessions and journals without a snapshot boundary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-session-compact-refuse-'));
  const sessions = join(root, 'sessions');
  const id = 'no-boundary';
  try {
    const store = new JournalStore(sessions, id); await store.open();
    await store.append('message', { type: 'message', content: 'one' }); await store.close();
    const manager = new SessionDataManager({ sessionRoot: sessions, reviewerRoot: join(root, 'reviewer') });
    await assert.rejects(manager.compact(id, `compact:${id}`), { code: 'journal_compaction_snapshot_missing' });
    await writeFile(join(sessions, `${id}.lock`), 'occupied');
    await assert.rejects(manager.compact(id, `compact:${id}`), { code: 'session_locked' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('full journal recovery refuses an oversized repair scan before reading content', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-journal-scan-bound-'));
  const path = join(root, 'oversized.journal.ndjson');
  try {
    await writeFile(path, '0123456789');
    await assert.rejects(recoverJournal(path, { maxBytes: 5 }), { code: 'journal_too_large_to_repair_in_process' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
