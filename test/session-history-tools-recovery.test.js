// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { sessionHistoryDefinitions } from '../src/session-history-tools.js';

function toolsFor(records) {
  const definitions = sessionHistoryDefinitions({ transcript: () => records });
  return {
    search: definitions.find((item) => item.name === 'session_search_history'),
    read: definitions.find((item) => item.name === 'session_read_history'),
  };
}

const signal = () => new AbortController().signal;

test('a small history match returns its complete content in one call', async () => {
  const records = [
    { type: 'message', role: 'user', content: 'Please inspect the release gate.', turn_id: 'turn-a' },
    { type: 'message', role: 'assistant', content: 'The release gate is blocked on signing.', turn_id: 'turn-a' },
  ];
  const { search } = toolsFor(records);
  const result = JSON.parse((await search.executor({ args: { query: 'release gate' } }, signal())).content);
  assert.ok(result.matches.length > 0);
  const match = result.matches[0];
  assert.equal(match.inline_complete, true);
  assert.match(JSON.stringify(match.record), /release gate/);
  assert.equal(match.ledger_ref, undefined);
});

test('a large history match returns a snippet plus its exact ledger reference', async () => {
  const records = [
    { type: 'tool_request', turnId: 'turn-b', requestId: 'tool_large', providerCallId: 'call_large', toolName: 'fs_read', args: { path: 'PROGRESS.md' } },
    { type: 'tool_result', turnId: 'turn-b', requestId: 'tool_large', providerCallId: 'call_large', toolName: 'fs_read',
      content: `release gate detail ${'x'.repeat(12_000)}` },
  ];
  const { search, read } = toolsFor(records);
  const result = JSON.parse((await search.executor({ args: { query: 'release gate detail' } }, signal())).content);
  const match = result.matches.find((item) => item.type === 'tool_result');
  assert.equal(match.inline_complete, false);
  assert.equal(match.ledger_ref, 'tool_large');
  assert.ok(match.snippet.length > 0);
  // The reference is directly usable: no second fuzzy search is required.
  const readBack = JSON.parse((await read.executor({ args: { ledger_ref: 'tool_large' } }, signal())).content);
  assert.equal(readBack.records.length, 1);
  assert.match(JSON.stringify(readBack.records[0].record), /release gate detail/);
});

test('history search reaches records older than any fixed newest-record window', async () => {
  const records = Array.from({ length: 60_000 }, (_, index) => ({ type: 'message', content: `filler ${index}` }));
  records[3] = { type: 'message', content: 'original objective: migrate the ledger' };
  const { search } = toolsFor(records);
  const result = JSON.parse((await search.executor({ args: { query: 'migrate the ledger' } }, signal())).content);
  assert.equal(result.matches.length, 1);
  assert.ok(result.matches[0].record_index < 60_000 - 50_000, 'a record outside the former window was scanned');
});

test('ledger reference lookup recovers a result older than the former 50000-record window', async () => {
  const records = Array.from({ length: 55_000 }, (_, index) => ({ type: 'message', content: `filler ${index}` }));
  records[1] = { type: 'tool_result', requestId: 'tool_old', providerCallId: 'call_old', toolName: 'git_inspect', content: 'old exact evidence' };
  const { read } = toolsFor(records);
  const result = JSON.parse((await read.executor({ args: { ledger_ref: 'tool_old' } }, signal())).content);
  assert.equal(result.records.length, 1);
  assert.match(JSON.stringify(result.records[0].record), /old exact evidence/);
});

test('an expired scan budget reports truncation instead of claiming a complete scan', async () => {
  const records = Array.from({ length: 20_000 }, (_, index) => ({
    type: 'message', content: `hay ${index} ${'x'.repeat(2_000)}`,
  }));
  const { search } = toolsFor(records);
  const result = JSON.parse((await search.executor({ args: { query: 'hay', budget_ms: 1 } }, signal())).content);
  assert.equal(result.scan_truncated, true);
  assert.ok(result.scanned < records.length);
  assert.equal(typeof result.scan_budget_ms, 'number');
});
