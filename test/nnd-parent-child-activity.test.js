// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { parentChildActivity } from '../src/nnd-parent-child-activity.js';

test('parent delegated activity is bounded lifecycle evidence without child payloads', () => {
  const child = { id: 'agent_a', title: 'secret title' };
  const created = parentChildActivity('registered', child, 'session_a', null);
  const started = parentChildActivity('started', child, 'session_a', null, 'prompt_a');
  const completed = parentChildActivity('completed', child, 'session_a', { outcome: 'needs_input', secret: 'private' });
  assert.deepEqual([created.summary, started.summary, completed.summary],
    ['Subagent created', 'Subagent working', 'Subagent needs input']);
  assert.deepEqual([created.status, started.status, completed.status], ['started', 'started', 'attention']);
  assert.equal(new Set([created.id, started.id, completed.id]).size, 3);
  assert.equal(started.evidenceMessageID, 'prompt_a');
  assert.ok([created, started, completed].every((record) => record.childSessionID === 'agent_a'
    && record.sessionID === 'session_a' && record.kind === 'subagent'));
  assert.equal(JSON.stringify([created, started, completed]).includes('private'), false);
  assert.equal(JSON.stringify([created, started, completed]).includes('secret title'), false);
  assert.equal(parentChildActivity('output', child, 'session_a', { text: 'private' }), null);
  assert.equal(parentChildActivity('completed', child, 'session_a', {}).summary, 'Subagent stopped');
});
