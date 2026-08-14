// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { mkdtemp, open, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { atomicWrite } from '../src/diagnostic-bundle.js';

test('published diagnostic bundles survive temporary-file cleanup failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-diagnostic-publish-'));
  const path = join(root, 'support.zip');
  let cleanupAttempts = 0;
  await atomicWrite(path, Buffer.from('bundle'), {
    open,
    unlink: async () => {
      cleanupAttempts += 1;
      throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    },
  });
  assert.equal(cleanupAttempts, 1);
  assert.deepEqual(await readFile(path), Buffer.from('bundle'));
});
