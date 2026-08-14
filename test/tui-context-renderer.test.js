// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { contextCompactionText } from '../src/tui/context-renderer.js';

test('context compaction status is concise and visible', () => {
  assert.match(contextCompactionText({ status: 'started', before_estimated_tokens: 220000, target_tokens: 209000 }), /CONTEXT \| compacting/u);
  assert.match(contextCompactionText({
    status: 'completed', before_estimated_tokens: 220000, after_estimated_tokens: 48000,
    retained_records: 17, protected_turns: 6, payload_compacted_records: 2,
  }), /Context compacted.*retained 17.*protected 6 recent turns.*reduced 2 payloads/u);
  assert.match(contextCompactionText({ status: 'failed', reason_code: 'compaction_insufficient' }), /compaction failed.*compaction_insufficient/u);
});
