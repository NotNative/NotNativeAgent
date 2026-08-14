// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { JournalStore, readJournalPage, recoverJournal } from '../src/store.js';
import { TuiProjection } from '../src/tui-model.js';
import { TuiRenderer } from '../src/tui-renderer.js';
import { loadEarlierTranscriptPage } from '../src/workspace-history.js';

test('AC-FAIL-02 persistence flush has an independent typed deadline and latches failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-journal-timeout-'));
  const handle = {
    write: () => new Promise(() => undefined), sync: async () => undefined, close: async () => undefined,
  };
  const store = new JournalStore(root, 'deadline', {
    persistenceDeadlineMs: 20, openFile: async () => handle,
  });
  try {
    await store.open();
    await assert.rejects(store.append('message', { role: 'user' }), { code: 'persistence_flush_timeout' });
    await assert.rejects(store.append('message', { role: 'user' }), { code: 'persistence_unavailable' });
    await store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('concurrent journal appends serialize sequence and hash-chain ownership', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-journal-concurrent-'));
  const store = new JournalStore(root, 'concurrent');
  try {
    await store.open();
    await Promise.all(Array.from({ length: 32 }, (_, index) => (
      store.append('message', { type: 'message', role: 'user', content: `record-${index + 1}` })
    )));
    await store.close();
    const recovered = await recoverJournal(store.path);
    assert.equal(recovered.corruptTail, false);
    assert.deepEqual(recovered.records.map((record) => record.sequence),
      Array.from({ length: 32 }, (_, index) => index + 1));
    assert.deepEqual(recovered.records.map((record) => record.payload.content),
      Array.from({ length: 32 }, (_, index) => `record-${index + 1}`));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('AC-SESS-06 journal preserves a corrupt original tail and writes a separate verified prefix', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-journal-'));
  const store = new JournalStore(root, 'session-test');
  await store.open();
  await store.append('message', { role: 'user', content: 'hello' });
  await store.append('turn_outcome', { outcome: 'completed' });
  await store.close();
  const valid = await recoverJournal(store.path);
  assert.equal(valid.records.length, 2);
  assert.equal(valid.corruptTail, false);
  await appendFile(store.path, '{"truncated":', 'utf8');
  const recovered = await recoverJournal(store.path);
  assert.equal(recovered.records.length, 2);
  assert.equal(recovered.corruptTail, true);
  assert.match(await readFile(store.path, 'utf8'), /truncated/u);
  const reopened = new JournalStore(root, 'session-test');
  const artifact = await reopened.open();
  assert.equal(artifact.corruptTail, true);
  assert.doesNotMatch(await readFile(artifact.recoveryPath, 'utf8'), /truncated/u);
  assert.match(await readFile(store.path, 'utf8'), /truncated/u);
});

test('AC-PERF-04 large journals resume from a bounded tail and page older records', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-journal-page-'));
  const store = new JournalStore(root, 'large-session', { resumeRecordLimit: 32 });
  try {
    await writeJournalFixture(store.path, 100_000);
    const resumed = new JournalStore(root, 'large-session', { resumeRecordLimit: 32 });
    const recovered = await resumed.open();
    assert.equal(recovered.truncated, true);
    assert.equal(recovered.records.length, 32);
    assert.equal(recovered.lastSequence, 100_000);
    await resumed.append('message', { type: 'message', role: 'user', content: 'record-100000' });
    await resumed.close();

    const latest = await readJournalPage(store.path, { limit: 10 });
    assert.deepEqual(latest.records.map((record) => record.sequence), [99_992, 99_993, 99_994, 99_995, 99_996, 99_997, 99_998, 99_999, 100_000, 100_001]);
    const older = await readJournalPage(store.path, { beforeSequence: 99_992, limit: 5 });
    assert.deepEqual(older.records.map((record) => record.sequence), [99_987, 99_988, 99_989, 99_990, 99_991]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('AC-SESS-08 legacy journals migrate once with backup and future formats fail safely', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-journal-migrate-'));
  const store = new JournalStore(root, 'legacy');
  try {
    await writeJournalFixture(store.path, 3, 0);
    const recovered = await store.open();
    assert.equal(recovered.legacyFormat, false);
    assert.equal(recovered.records.every((record) => record.format === 1), true);
    await store.close();
    assert.equal((await readFile(`${store.path}.format-0.bak`, 'utf8')).includes('"format":0'), true);
    const backup = await readFile(`${store.path}.format-0.bak`, 'utf8');
    const reopened = new JournalStore(root, 'legacy');
    await reopened.open();
    await reopened.close();
    assert.equal(await readFile(`${store.path}.format-0.bak`, 'utf8'), backup);
    await writeJournalFixture(join(root, 'future.journal.ndjson'), 1, 2);
    await assert.rejects(new JournalStore(root, 'future').open(), { code: 'journal_version_future' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Console PageUp loads a bounded older journal page and preserves its visual anchor', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-history-page-'));
  const path = join(root, 'history.journal.ndjson');
  try {
    await writeJournalFixture(path, 100);
    const projection = new TuiProjection();
    projection.addSession('history', 'History', { provider: 'p', model: 'm', workspace: root });
    const view = projection.active();
    Object.assign(view, { beforeSequence: 91, hasMore: true, viewportLineCount: 20, viewportEnd: 0 });
    const workspace = { projection, sessions: new Map([['history', { engine: { store: { path } } }]]) };
    assert.equal(await loadEarlierTranscriptPage(workspace, 10), true);
    assert.equal(view.historyRecords.length, 10);
    assert.equal(view.historyRecords[0].text, 'r81');
    new TuiRenderer().frame(projection, { width: 80, height: 24, color: false });
    assert.ok(view.viewportEnd > 0);
    assert.equal(view.beforeSequence, 81);
  } finally { await rm(root, { recursive: true, force: true }); }
});

async function writeJournalFixture(path, count, format = 1) {
  await mkdir(join(path, '..'), { recursive: true });
  const lines = [];
  let previous = '0'.repeat(64);
  for (let sequence = 1; sequence <= count; sequence += 1) {
    const base = { format, sequence, type: 'message', payload: { type: 'message', role: 'user', content: `r${sequence}` }, previous };
    const hash = createHash('sha256').update(JSON.stringify(base)).digest('hex');
    lines.push(JSON.stringify({ ...base, hash }));
    previous = hash;
  }
  await writeFile(path, `${lines.join('\n')}\n`, 'utf8');
}
