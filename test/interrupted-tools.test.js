// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { interruptedToolRepairs } from '../src/reliability/interrupted-tools.js';

test('interrupted tool repair distinguishes undispatched and unknown effects', () => {
  const records = [
    record('turn_accepted', { turnId: 'turn-1', requestId: 'operator-1' }),
    record('tool_request', request('request-safe', 'call-safe')),
    record('tool_request', request('request-unknown', 'call-unknown')),
    record('lifecycle_event', {
      event_name: 'tool_execution.started', turn_id: 'turn-1',
      tool_request_id: 'request-unknown',
    }),
  ];

  const repairs = interruptedToolRepairs(records, ['turn-1']);
  assert.equal(repairs.length, 2);
  const safe = repairs.find((item) => item.requestId === 'request-safe');
  const unknown = repairs.find((item) => item.requestId === 'request-unknown');
  assert.equal(safe.status, 'cancelled');
  assert.equal(safe.effectCertainty, 'none');
  assert.equal(safe.reasonCode, 'process_interrupted_before_dispatch');
  assert.equal(unknown.status, 'unknown_effect');
  assert.equal(unknown.effectCertainty, 'unknown');
  assert.equal(unknown.reasonCode, 'process_interrupted_outcome_unknown');
});

test('interrupted tool repair is idempotent and repairs previously marked turns', () => {
  const requestPayload = request('request-1', 'call-1');
  const first = interruptedToolRepairs([
    record('tool_request', requestPayload),
    record('turn_interrupted', { turnId: 'turn-1' }),
  ]);
  assert.equal(first.length, 1);

  const second = interruptedToolRepairs([
    record('tool_request', requestPayload),
    record('turn_interrupted', { turnId: 'turn-1' }),
    record('tool_result', first[0]),
  ]);
  assert.deepEqual(second, []);
});

test('settled and non-interrupted tool calls are left unchanged', () => {
  const requestPayload = request('request-1', 'call-1');
  assert.deepEqual(interruptedToolRepairs([
    record('tool_request', requestPayload),
    record('tool_result', { ...requestPayload, type: 'tool_result', status: 'succeeded' }),
  ], ['turn-1']), []);
  assert.deepEqual(interruptedToolRepairs([record('tool_request', requestPayload)]), []);
});

function request(requestId, providerCallId) {
  return {
    type: 'tool_request', turnId: 'turn-1', stepId: 'step-1', requestId,
    providerCallId, toolName: 'fs.write_text', args: { path: 'result.txt', content: 'x' },
  };
}

function record(type, payload) { return { type, payload }; }
