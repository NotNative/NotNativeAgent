// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { filesView } from '../src/tui/files-view.js';

test('conversation files deduplicate reads and retain actionable failure details', () => {
  const value = filesView({ historyRecords: [], records: [
    { type: 'tool_status', tool: 'fs.read_text', target: 'README.md', status: 'succeeded' },
    { type: 'tool_status', tool: 'fs.read_text', target: 'README.md', status: 'succeeded' },
    { type: 'tool_status', tool: 'fs.read_text', target: 'missing.md', status: 'failed', reason_code: 'file_missing' },
    { type: 'tool_status', tool: 'web.fetch', target: 'https://example.test', status: 'succeeded' },
  ] }, [{ path: 'src/a.js', operations: ['edit_text'] }]);
  assert.match(value, /Read or discovered: 1 \| Changed: 1 \| Failed: 1/u);
  assert.equal(value.match(/fs\.read_text README\.md/gu)?.length, 1);
  assert.match(value, /fs\.read_text missing\.md - file_missing/u);
  assert.doesNotMatch(value, /example\.test/u);
});
