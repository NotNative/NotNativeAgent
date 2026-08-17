// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SessionDataManager } from '../src/persistence/session-data.js';
import { JournalStore, recoverJournal } from '../src/store.js';

test('guarded session repair preserves a stale lock and restores only a verified genesis prefix', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-session-repair-'));
  const sessions = join(root, 'sessions');
  const reviewer = join(root, 'reviewer');
  const logs = join(root, 'logs');
  const id = 'repairable';
  const journalPath = join(sessions, `${id}.journal.ndjson`);
  const lockPath = join(sessions, `${id}.lock`);
  try {
    const store = new JournalStore(sessions, id);
    await store.open();
    await store.append('message', { role: 'user', content: 'preserved' });
    await store.close();
    const prefixPath = `${journalPath}.verified-prefix.100`;
    await copyFile(journalPath, prefixPath);
    await writeFile(journalPath, `${await readFile(journalPath, 'utf8')}{broken`, 'utf8');
    await writeFile(lockPath, JSON.stringify({
      version: 2, pid: 91, token: 'old', created_at: new Date().toISOString(),
      process_identity: { version: 1, pid: 91, platform: 'fixture', start_id: 'old-start' },
    }));
    const manager = new SessionDataManager({
      sessionRoot: sessions, reviewerRoot: reviewer, diagnosticsRoot: logs,
      processIdentity: { compare: async () => 'different' },
    });
    await assert.rejects(manager.repair(id, 'yes'), { code: 'repair_confirmation_required' });
    const result = await manager.repair(id, `repair:${id}`);
    assert.equal(result.repaired, true);
    assert.deepEqual(result.actions.map((item) => item.type), ['stale_lock_preserved', 'journal_prefix_restored']);
    const recovered = await recoverJournal(journalPath);
    assert.equal(recovered.corruptTail, false);
    assert.equal(recovered.records.length, 1);
    assert.equal(await readFile(prefixPath, 'utf8'), await readFile(journalPath, 'utf8'));
    assert.match(await readFile(join(logs, 'repair.ndjson'), 'utf8'), /session_repair/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('session repair refuses corrupt journals without preserved verified-prefix evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-session-repair-missing-'));
  const sessions = join(root, 'sessions');
  const id = 'missing-prefix';
  try {
    const store = new JournalStore(sessions, id); await store.open();
    await store.append('message', { content: 'one' }); await store.close();
    const path = join(sessions, `${id}.journal.ndjson`);
    await writeFile(path, `${await readFile(path, 'utf8')}{broken`, 'utf8');
    const lockPath = join(sessions, `${id}.lock`);
    await writeFile(lockPath, JSON.stringify({
      version: 2, pid: 12, token: 'stale', created_at: new Date().toISOString(),
      process_identity: { version: 1, pid: 12, platform: 'fixture', start_id: 'old' },
    }));
    const manager = new SessionDataManager({
      sessionRoot: sessions, reviewerRoot: join(root, 'reviewer'),
      processIdentity: { compare: async () => 'dead' },
    });
    await assert.rejects(manager.repair(id, `repair:${id}`), { code: 'journal_repair_evidence_missing' });
    assert.equal(JSON.parse(await readFile(lockPath, 'utf8')).token, 'stale');
  } finally { await rm(root, { recursive: true, force: true }); }
});
