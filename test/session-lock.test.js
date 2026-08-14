// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SessionLock } from '../src/session-lock.js';

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
