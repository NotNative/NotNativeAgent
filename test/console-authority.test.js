// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConsoleAuthority } from '../src/experience/console-authority.js';

test('console authority clears ownership after release', async () => {
  let releases = 0;
  const authority = new ConsoleAuthority(null, {
    async acquire() {}, async release() { releases += 1; },
  });
  assert.equal(await authority.acquire(), true);
  await authority.release();
  assert.equal(authority.owned, false);
  assert.equal(releases, 1);
});

test('console authority clears ownership when lock release fails', async () => {
  const authority = new ConsoleAuthority(null, {
    async acquire() {}, async release() { throw new Error('release failed'); },
  });
  assert.equal(await authority.acquire(), true);
  await assert.rejects(authority.release(), /release failed/u);
  assert.equal(authority.owned, false);
});

test('console authority serializes concurrent acquire and release calls', async () => {
  let acquisitions = 0;
  let releases = 0;
  const authority = new ConsoleAuthority(null, {
    async acquire() { acquisitions += 1; await new Promise((resolve) => setTimeout(resolve, 5)); },
    async release() { releases += 1; },
  });
  assert.deepEqual(await Promise.all([authority.acquire(), authority.acquire()]), [true, true]);
  await Promise.all([authority.release(), authority.release()]);
  assert.equal(acquisitions, 1);
  assert.equal(releases, 1);
  assert.equal(authority.owned, false);
});

test('callers cannot forge console lock ownership or replace the lock', async () => {
  let acquisitions = 0;
  const authority = new ConsoleAuthority(null, {
    async acquire() { acquisitions += 1; }, async release() {},
  });
  assert.throws(() => { authority.owned = true; }, TypeError);
  assert.throws(() => Object.defineProperty(authority, 'owned', { value: true }), TypeError);
  authority.lock = { async acquire() { throw new Error('untrusted lock used'); } };
  assert.equal(authority.owned, false);
  assert.equal(await authority.acquire(), true);
  assert.equal(acquisitions, 1);
  await authority.release();
  assert.equal(authority.owned, false);
});

test('separate console authorities respect the same durable lock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-console-authority-'));
  const path = join(root, 'tabs.json');
  const first = new ConsoleAuthority(path);
  const second = new ConsoleAuthority(path);
  try {
    assert.equal(await first.acquire(), true);
    assert.equal(await second.acquire(), false);
    assert.equal(second.owned, false);
    await first.release();
    assert.equal(await second.acquire(), true);
    assert.equal(second.owned, true);
  } finally {
    await Promise.allSettled([first.release(), second.release()]);
    await rm(root, { recursive: true, force: true });
  }
});
