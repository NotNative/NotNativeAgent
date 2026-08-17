// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

test('session listing marks health and bulk repair changes only deterministic cases', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-session-list-repair-'));
  const sessions = join(root, 'sessions');
  const reviewer = join(root, 'reviewer');
  try {
    await mkdir(reviewer, { recursive: true });
    for (const id of ['healthy', 'repairable', 'blocked', 'active']) {
      const store = new JournalStore(sessions, id); await store.open();
      await store.append('message', { content: id }); await store.close();
    }
    const repairablePath = join(sessions, 'repairable.journal.ndjson');
    await copyFile(repairablePath, `${repairablePath}.verified-prefix.1`);
    await writeFile(repairablePath, `${await readFile(repairablePath, 'utf8')}{broken`, 'utf8');
    const blockedPath = join(sessions, 'blocked.journal.ndjson');
    await writeFile(blockedPath, `${await readFile(blockedPath, 'utf8')}{broken`, 'utf8');
    for (const [id, startId] of [['repairable', 'stale'], ['blocked', 'stale'], ['active', 'current']]) {
      await writeFile(join(sessions, `${id}.lock`), JSON.stringify({
        version: 2, pid: 42, token: id, created_at: new Date().toISOString(),
        process_identity: { version: 1, pid: 42, platform: 'fixture', start_id: startId },
      }));
    }
    const manager = new SessionDataManager({
      sessionRoot: sessions, reviewerRoot: reviewer,
      processIdentity: { compare: async (identity) => identity.start_id === 'current' ? 'same' : 'different' },
    });
    const listing = await manager.list();
    assert.deepEqual(listing.counts, { total: 4, repairable: 1, active: 1, inspection_required: 1, healthy: 1 });
    assert.equal(listing.sessions[0].display_id, 'repairable [REPAIR REQUIRED]');
    assert.match(listing.sessions[0].repair_command, /repairable repair:repairable$/u);
    assert.equal(listing.sessions.find((item) => item.session_id === 'blocked').display_id,
      'blocked [INSPECTION REQUIRED]');
    assert.equal(listing.sessions.find((item) => item.session_id === 'active').display_id, 'active [ACTIVE]');

    const result = await manager.repairAll();
    assert.deepEqual(result.repaired.map((item) => item.session_id), ['repairable']);
    assert.deepEqual(result.skipped.map((item) => item.session_id).sort(), ['active', 'blocked']);
    assert.equal((await manager.list()).sessions.find((item) => item.session_id === 'repairable').status, 'healthy');
    assert.equal((await recoverJournal(repairablePath)).corruptTail, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
