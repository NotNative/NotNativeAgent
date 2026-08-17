// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { inspectSessionLock, preserveStaleSessionLock, SessionLock } from '../src/persistence/session-lock.js';

test('session lock preserves malformed stale evidence before atomic acquisition', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-lock-shape-'));
  try {
    await writeFile(join(root, 'session.lock'), 'null', 'utf8');
    const lock = new SessionLock(root, 'session');
    await lock.acquire();
    assert.equal((await lock.health()).preservedStaleEvidence, 1);
    await lock.release();
    await assert.rejects(readFile(join(root, 'session.lock'), 'utf8'), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('session lock does not expire a live owner by timestamp', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-lock-age-'));
  try {
    await writeFile(join(root, 'session.lock'), JSON.stringify({
      version: 1, pid: process.pid, token: 'other-owner', created_at: '1970-01-01T00:00:00.000Z',
    }), 'utf8');
    await assert.rejects(new SessionLock(root, 'session').acquire(), { code: 'session_locked' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('session lock reports ownership replacement instead of deleting another owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-lock-owner-'));
  try {
    const path = join(root, 'session.lock');
    const lock = new SessionLock(root, 'session');
    await lock.acquire();
    await writeFile(path, JSON.stringify({
      version: 1, pid: process.pid, token: 'replacement-owner', created_at: new Date().toISOString(),
    }), 'utf8');
    await assert.rejects(lock.release(), { code: 'session_lock_ownership_lost' });
    assert.equal(JSON.parse(await readFile(path, 'utf8')).token, 'replacement-owner');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('session lock preserves a recycled-PID owner as stale evidence before acquisition', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-lock-recycled-'));
  const path = join(root, 'session.lock');
  const processIdentity = {
    capture: async (pid) => ({ version: 1, pid, platform: 'fixture', start_id: 'new-start' }),
    compare: async () => 'different', live: () => true,
  };
  try {
    await writeFile(path, JSON.stringify({
      version: 2, pid: process.pid, token: 'old-owner', created_at: new Date().toISOString(),
      process_identity: { version: 1, pid: process.pid, platform: 'fixture', start_id: 'old-start' },
    }));
    assert.equal((await inspectSessionLock(path, { processIdentity })).status, 'different');
    const lock = new SessionLock(root, 'session', { processIdentity });
    await lock.acquire();
    assert.equal((await lock.health()).preservedStaleEvidence, 1);
    await lock.release();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('guarded stale-lock preservation refuses live or unverifiable owners', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-lock-repair-'));
  const path = join(root, 'session.lock');
  try {
    await writeFile(path, JSON.stringify({
      version: 2, pid: 9, token: 'owner', created_at: new Date().toISOString(),
      process_identity: { version: 1, pid: 9, platform: 'fixture', start_id: 'start' },
    }));
    await assert.rejects(preserveStaleSessionLock(path, { processIdentity: { compare: async () => 'same' } }), { code: 'session_locked' });
    const repaired = await preserveStaleSessionLock(path, { processIdentity: { compare: async () => 'dead' } });
    assert.equal(repaired.repaired, true);
    assert.equal(repaired.status, 'dead');
    assert.match(repaired.evidence_path, /\.stale\.\d+\.repair\./u);
  } finally { await rm(root, { recursive: true, force: true }); }
});
