// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { removeFileWithRetry, replaceFileWithRetry, WINDOWS_FILE_REPLACE_DELAYS_MS } from './windows-file-replace.mjs';

test('Windows rename retries only transient sharing errors with the documented backoff', async () => {
  const delays = [];
  let calls = 0;
  const result = await replaceFileWithRetry('temp', 'target', {
    platform: 'win32',
    rename: async () => {
      calls += 1;
      if (calls < 3) { const error = new Error('locked'); error.code = 'EBUSY'; throw error; }
      return 'done';
    },
    sleep: async (milliseconds) => delays.push(milliseconds),
  });
  assert.equal(result, 'done');
  assert.equal(calls, 3);
  assert.deepEqual(delays, WINDOWS_FILE_REPLACE_DELAYS_MS.slice(0, 2));
});

test('Windows rename exhausts the bounded schedule and immediately propagates permanent errors', async () => {
  const delays = [];
  let calls = 0;
  await assert.rejects(replaceFileWithRetry('temp', 'target', {
    platform: 'win32',
    rename: async () => { calls += 1; const error = new Error('locked'); error.code = 'EPERM'; throw error; },
    sleep: async (milliseconds) => delays.push(milliseconds),
  }), /locked/u);
  assert.equal(calls, WINDOWS_FILE_REPLACE_DELAYS_MS.length + 1);
  assert.deepEqual(delays, WINDOWS_FILE_REPLACE_DELAYS_MS);

  calls = 0;
  await assert.rejects(replaceFileWithRetry('temp', 'target', {
    platform: 'win32',
    rename: async () => { calls += 1; const error = new Error('missing'); error.code = 'ENOENT'; throw error; },
    sleep: async () => assert.fail('permanent failures must not retry'),
  }), /missing/u);
  assert.equal(calls, 1);
});

test('non-Windows rename never retries transient-looking failures', async () => {
  let calls = 0;
  await assert.rejects(replaceFileWithRetry('temp', 'target', {
    platform: 'linux',
    rename: async () => { calls += 1; const error = new Error('busy'); error.code = 'EBUSY'; throw error; },
    sleep: async () => assert.fail('non-Windows must not retry'),
  }), /busy/u);
  assert.equal(calls, 1);
});

test('temporary file cleanup retries Windows sharing violations and propagates permanent errors', async () => {
  const delays = [];
  let calls = 0;
  await removeFileWithRetry('temp', {
    platform: 'win32',
    remove: async () => {
      calls += 1;
      if (calls < 3) { const error = new Error('locked'); error.code = 'EBUSY'; throw error; }
    },
    sleep: async (milliseconds) => delays.push(milliseconds),
  });
  assert.equal(calls, 3);
  assert.deepEqual(delays, WINDOWS_FILE_REPLACE_DELAYS_MS.slice(0, 2));
  await assert.rejects(removeFileWithRetry('temp', {
    platform: 'win32',
    remove: async () => { const error = new Error('permission denied'); error.code = 'EACCES'; throw error; },
    sleep: async () => {},
  }), /permission denied/u);
});
