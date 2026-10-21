// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { completedAssistantHasText, readUntil } from './smoke-observations.js';

test('smoke reply observation ignores the user prompt and incomplete assistant output', () => {
  const user = { info: { role: 'user' }, parts: [{ type: 'text', text: 'smoke probe' }] };
  const pending = { info: { role: 'assistant', time: {} }, parts: [{ type: 'text', text: 'smoke probe' }] };
  const completed = { info: { role: 'assistant', time: { completed: 1 } },
    parts: [{ type: 'text', text: 'reply to smoke probe' }] };
  assert.equal(completedAssistantHasText([user], 'smoke probe'), false);
  assert.equal(completedAssistantHasText([user, pending], 'smoke probe'), false);
  assert.equal(completedAssistantHasText([user, pending, completed], 'smoke probe'), true);
});

test('stream probe decodes split UTF-8 and enforces one deadline across reads', async () => {
  const bytes = new TextEncoder().encode('notnative: “ready”');
  const reader = { index: 0, async read() {
    this.index += 1;
    return this.index === 1 ? { value: bytes.subarray(0, 14), done: false }
      : { value: bytes.subarray(14), done: false };
  } };
  assert.equal(await readUntil(reader, 100, '“ready”', 'stream'), 'notnative: “ready”');
  await assert.rejects(readUntil({ read: () => new Promise(() => {}) }, 10, 'frame', 'stream'), /timed out/);
});
