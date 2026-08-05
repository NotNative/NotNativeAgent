// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { sessionStats } from '../src/tui-session-stats.js';

test('conversation statistics summarize terminal outcomes without counting running tools', () => {
  const stats = sessionStats({
    state: 'idle', historyRecords: [], usage: { prompt_tokens: 20, completion_tokens: 7, total_tokens: 27 },
    contextTokens: 4096, contextLimitTokens: 32768, contextMeasurement: 'provider', contextSource: 'catalog',
    records: [
      { type: 'turn_result', outcome: 'completed', elapsed_ms: 1200 },
      { type: 'turn_result', outcome: 'needs_input', elapsed_ms: 300 },
      { type: 'tool_status', status: 'running' },
      { type: 'tool_status', status: 'succeeded' },
      { type: 'tool_status', status: 'failed' },
      { type: 'review_status', outcome: 'approve' },
      { type: 'review_status', outcome: 'deny_with_guidance' },
    ],
  });
  assert.deepEqual(stats.turns, { total: 2, completed: 1, needs_input: 1, failed: 0, elapsed_ms: 1500 });
  assert.deepEqual(stats.tools, { total: 2, succeeded: 1, failed: 1 });
  assert.deepEqual(stats.reviews, { total: 2, denied: 1 });
  assert.deepEqual(stats.tokens, { input: 20, output: 7, total: 27 });
  assert.equal(stats.context.percent, '12.5%');
});
