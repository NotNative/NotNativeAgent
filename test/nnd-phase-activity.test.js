// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { observeNndPhaseActivity } from '../src/nnd-phase-activity.js';

test('NND phase activity is bounded, deduplicated and contains no raw output', () => {
  const turn = {};
  const waiting = observeNndPhaseActivity(turn, { type: 'state_status', semantic_state: 'waiting_provider',
    provider_payload: 'private' }, 's1', 'prompt_a');
  assert.deepEqual(waiting, { id: waiting.id, sessionID: 's1', kind: 'state', status: 'started',
    summary: 'Waiting for model', time: waiting.time, evidenceMessageID: 'prompt_a' });
  assert.match(waiting.id, /^s1:state:[a-f0-9-]{36}:1$/u);
  assert.equal(observeNndPhaseActivity(turn, { type: 'state_status', semantic_state: 'waiting_provider' }, 's1'), null);
  const tool = observeNndPhaseActivity(turn, { type: 'tool_status', status: 'running',
    tool: 'shell_run', arguments: 'private' }, 's1', 'prompt_a');
  assert.equal(tool.summary, 'Running tool');
  assert.equal(tool.evidenceMessageID, 'prompt_a');
  const resumed = observeNndPhaseActivity(turn, { type: 'state_status', semantic_state: 'waiting_provider' }, 's1');
  assert.equal(resumed.id, waiting.id.replace(/:1$/u, ':3'));
  assert.equal(observeNndPhaseActivity(turn, { type: 'state_status', semantic_state: 'invented_private' }, 's1'), null);
  assert.equal(JSON.stringify([waiting, tool, resumed]).includes('private'), false);
  const nextTurn = observeNndPhaseActivity({}, { type: 'state_status', semantic_state: 'waiting_provider' }, 's1', 'prompt_b');
  assert.notEqual(nextTurn.id, waiting.id);
  const retriedRequest = observeNndPhaseActivity({}, { type: 'state_status', semantic_state: 'waiting_provider' }, 's1', 'prompt_a');
  assert.notEqual(retriedRequest.id, waiting.id);
});
