// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { JournalStore, readJournalPage, readJournalPrefix, recoverControlRecords, recoverJournal } from '../src/store.js';
import { TuiProjection } from '../src/experience/projection.js';
import { TuiRenderer } from '../src/tui/renderer.js';
import { loadEarlierTranscriptPage } from '../src/experience/history.js';

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

test('journal replacement preserves a durable chain and leaves no temporary artifact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-journal-replace-'));
  const store = new JournalStore(root, 'replace');
  try {
    await store.open();
    await store.append('message', { role: 'user', content: 'expired' });
    await store.replace([{ type: 'message', payload: { role: 'user', content: 'retained' } }]);
    await store.append('message', { role: 'assistant', content: 'continued' });
    await store.close();
    const recovered = await recoverJournal(store.path);
    assert.equal(recovered.corruptTail, false);
    assert.deepEqual(recovered.records.map((record) => record.sequence), [1, 2]);
    assert.deepEqual(recovered.records.map((record) => record.payload.content), ['retained', 'continued']);
    assert.equal((await readdir(root)).some((name) => name.includes('.replace-')), false);
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

test('authority control records resume intact from outside the bounded tail', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-journal-control-'));
  const store = new JournalStore(root, 'control-scan', { resumeRecordLimit: 8 });
  try {
    await store.open();
    await store.append('authority_intent', intentRecord('earlier grant', 1));
    for (let index = 1; index <= 40; index += 1) {
      await store.append('tool_result', {
        type: 'tool_result', turnId: 'turn-old', providerCallId: `call-${index}`,
        toolName: 'fs_read_text', status: 'succeeded', content: `result ${index}`,
      });
    }
    await store.append('authority_intent', intentRecord('newer grant', 2));
    await store.close();

    const resumed = new JournalStore(root, 'control-scan', { resumeRecordLimit: 8 });
    const recovered = await resumed.open();
    assert.equal(recovered.truncated, true);
    assert.equal(recovered.controlComplete, true);
    assert.equal(recovered.records.length, 8);
    assert.deepEqual(recovered.controlRecords.map((item) => item.payload.content), ['earlier grant', 'newer grant']);
    await resumed.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the control scan fails closed above its byte bound and at an unverifiable lineage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-journal-control-fail-'));
  try {
    const store = new JournalStore(root, 'control-fail');
    await store.open();
    await store.append('authority_intent', intentRecord('original grant', 1));
    for (let index = 1; index <= 40; index += 1) {
      await store.append('tool_result', {
        type: 'tool_result', turnId: 'turn-old', providerCallId: `call-${index}`,
        toolName: 'fs_read_text', status: 'succeeded', content: 'x'.repeat(2_000),
      });
    }
    await store.close();
    const oversized = await recoverControlRecords(store.path, { maxBytes: 256 });
    assert.equal(oversized.controlComplete, false);

    const lines = (await readFile(store.path, 'utf8')).split('\n');
    const target = JSON.parse(lines[1]);
    target.payload.content = 'x'.repeat(2_001);
    lines[1] = JSON.stringify(target);
    await writeFile(store.path, `${lines.join('\n')}\n`, 'utf8');

    const scan = await recoverControlRecords(store.path);
    assert.equal(scan.controlComplete, false);
    assert.deepEqual(scan.controlRecords.map((item) => item.payload.content), ['original grant']);

    const resumed = new JournalStore(root, 'control-fail', { resumeRecordLimit: 8 });
    const recovered = await resumed.open();
    assert.equal(recovered.truncated, true);
    assert.equal(recovered.controlComplete, false);
    await resumed.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the control scan refuses to attest a genesis prefix as the whole journal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-journal-control-tip-'));
  try {
    const store = new JournalStore(root, 'control-tip');
    await store.open();
    await store.append('authority_intent', intentRecord('first grant', 1));
    await store.append('conversation_cleared', {});
    await store.append('authority_intent', intentRecord('restated grant', 2));
    await store.close();
    const full = await recoverControlRecords(store.path);
    assert.equal(full.controlComplete, true);
    const tip = (await readFile(store.path, 'utf8')).split('\n').at(-2);
    const expectedTip = JSON.parse(tip).hash;

    // A sync or backup restore swaps in the pre-clear prefix; its chain verifies from
    // genesis, so only the tail-verified tip keeps the scan from attesting completeness.
    const lines = (await readFile(store.path, 'utf8')).split('\n');
    await writeFile(store.path, `${lines[0]}\n`, 'utf8');
    const rolledBack = await recoverControlRecords(store.path, { expectedTip });
    assert.equal(rolledBack.controlComplete, false);
    const missing = await recoverControlRecords(join(root, 'removed.journal.ndjson'), { expectedTip });
    assert.equal(missing.controlComplete, false);
    assert.equal((await recoverControlRecords(join(root, 'removed.journal.ndjson'))).controlComplete, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

function intentRecord(content, sequence) {
  return { content, origin: 'operator', sequence, kind: 'statement', lineageId: 'auth-control', restrictionVersion: 0 };
}

test('journal prefix verification consumes short file reads without zero-filled corruption', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-journal-short-read-'));
  const path = join(root, 'short-read.journal.ndjson');
  try {
    await writeJournalFixture(path, 3);
    const records = await readJournalPrefix(path, 2, { openFile: async (...args) => {
      const handle = await open(...args);
      return {
        stat: () => handle.stat(), close: () => handle.close(),
        read: (buffer, offset, length, position) => handle.read(buffer, offset, Math.min(length, 7), position),
      };
    } });
    assert.deepEqual(records.map((record) => record.sequence), [1, 2]);
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
