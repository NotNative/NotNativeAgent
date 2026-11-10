// SPDX-License-Identifier: Apache-2.0
// The legacy archive contract: read-only opening, archived listing, lazy
// message serving, typed refusals on mutation, and adoption as an explicit
// caller-driven act. Uses a fixture store so the operator's 4.5 GB database
// is never needed to prove the contract.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { LegacyArchive, archiveMutationRefusal, adoptArchivedSession } from '../src/opencode/legacy-archive.js';

async function fixtureStore(t) {
  const root = await mkdtemp(join(tmpdir(), 'nna-legacy-'));
  t.after(() => { rm(root, { recursive: true, force: true }); });
  const db = new DatabaseSync(join(root, 'opencode.db'));
  db.exec(`CREATE TABLE session_v2 (id TEXT PRIMARY KEY, title TEXT, directory TEXT, parent_id TEXT,
    time_created INTEGER, time_updated INTEGER, tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER);
    CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, data TEXT);`);
  db.prepare(`INSERT INTO session_v2 (id, title, directory, parent_id, time_created, time_updated,
    tokens_input, tokens_output, tokens_reasoning) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('ses_legacy1', 'Historical work', 'D:/Projects/Lab', 'ses_parent9', 1000, 2000, 120, 45, 10);
  db.prepare(`INSERT INTO session_v2 (id, title, directory, parent_id, time_created, time_updated,
    tokens_input, tokens_output, tokens_reasoning) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('ses_legacy2', 'Other chat', 'D:/Projects/Lab', null, 1500, 2500, 5, 1, 0);
  const message = db.prepare('INSERT INTO session_message (id, session_id, type, seq, time_created, data) VALUES (?, ?, ?, ?, ?, ?)');
  message.run('msg_1', 'ses_legacy1', 'user', 0, 1000, JSON.stringify({ text: 'start the work' }));
  message.run('msg_2', 'ses_legacy1', 'assistant', 1, 1100, JSON.stringify({ text: 'work done' }));
  message.run('msg_3', 'ses_legacy1', 'user', 2, 1200, JSON.stringify({ text: 'again' }));
  db.close();
  return join(root, 'opencode.db');
}

test('the archive lists sessions as archived with their metadata', async (t) => {
  const path = await fixtureStore(t);
  const archive = new LegacyArchive(path);
  try {
    const list = archive.list();
    assert.equal(list.length, 2);
    const first = list.find((entry) => entry.ocId === 'ses_legacy1');
    assert.equal(first.title, 'Historical work');
    assert.equal(first.archived, true);
    assert.equal(first.parentOcId, 'ses_parent9');
    assert.deepEqual(first.tokens, { input: 120, output: 45, reasoning: 10 });
  } finally { archive.close(); }
});

test('archived messages serve lazily, oldest first, without owning the store', async (t) => {
  const path = await fixtureStore(t);
  const archive = new LegacyArchive(path);
  try {
    const messages = archive.messages('ses_legacy1');
    assert.deepEqual(messages.map((message) => message.text), ['start the work', 'work done', 'again']);
    assert.deepEqual(messages.map((message) => message.seq), [0, 1, 2]);
    assert.equal(archive.get('ses_legacy2').title, 'Other chat');
  } finally { archive.close(); }
});

test('a missing store or conversation is a typed refusal, and every mutation refuses', async (t) => {
  const archive = new LegacyArchive(join(tmpdir(), 'nna-legacy-missing', 'opencode.db'));
  assert.throws(() => archive.list(), { code: 'legacy_store_missing' });
  const path = await fixtureStore(t);
  const real = new LegacyArchive(path);
  try {
    assert.throws(() => real.messages('ses_absent'), { code: 'archive_session_missing' });
    for (const action of ['prompt', 'compact', 'fork', 'revert', 'delete']) {
      const error = archiveMutationRefusal(action);
      assert.equal(error.code, 'archive_read_only');
      assert.match(error.message, /read-only/u);
    }
  } finally { real.close(); }
});

test('adoption hands the archived entry and messages to a caller-owned constructor', async (t) => {
  const path = await fixtureStore(t);
  const archive = new LegacyArchive(path);
  try {
    const adopted = await adoptArchivedSession(archive, 'ses_legacy1', async ({ entry, messages }) => ({
      title: entry.title, turnCount: messages.filter((message) => message.type === 'user').length,
    }));
    assert.equal(adopted.title, 'Historical work');
    assert.equal(adopted.turnCount, 2);
    assert.rejects(() => adoptArchivedSession(archive, 'ses_absent', async () => ({})), { code: 'archive_session_missing' });
  } finally { archive.close(); }
});

test('the v2 surface lists archived conversations, serves their history, and refuses prompts', async (t) => {
  const { startOpencodeServe } = await import('../src/opencode/serve.js');
  const path = await fixtureStore(t);
  const config = (await import('../src/config.js')).resolveManifest({ persistence: 'durable', provider: {
    id: 'test', endpoint: 'http://127.0.0.1:9999/v1', model: 'fixture-model', trust_zone: 'loopback',
  } });
  const root = await mkdtemp(join(tmpdir(), 'nna-legacy-serve-'));
  const archive = new LegacyArchive(path);
  const runtime = await startOpencodeServe({
    config, directory: root, storeRoot: join(root, 's'), reviewerRoot: join(root, 'r'),
    providerFactory: () => ({ async *stream() { yield { type: 'terminal', finishReason: 'stop' }; } }),
    stdout: { write() {} }, archive,
  });
  t.after(async () => { await runtime.stop(); archive.close(); await rm(root, { recursive: true, force: true }); });
  const request = (suffix, init) => fetch(`${runtime.url}${suffix}`, {
    headers: { connection: 'close', 'content-type': 'application/json' }, ...init });
  const live = await (await request('/api/session')).json();
  assert.equal(live.data.filter((entry) => entry.archived === true).length, 2, 'both archived conversations list');
  const historyResponse = await request('/api/session/ses_legacy1/message');
  const history = await historyResponse.json();
  assert.equal(historyResponse.status, 200, JSON.stringify(history));
  assert.ok(history.data.some((message) => message.text === 'start the work'), JSON.stringify(history).slice(0, 200));
  const prompt = await request('/api/session/ses_legacy1/prompt', { method: 'POST', body: JSON.stringify({ text: 'no' }) });
  const promptBody = await prompt.json();
  assert.equal(prompt.status, 409, JSON.stringify(promptBody));
  assert.equal(promptBody._tag, 'ArchiveReadOnlyError');
});
