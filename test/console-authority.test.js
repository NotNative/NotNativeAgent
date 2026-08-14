// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
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
