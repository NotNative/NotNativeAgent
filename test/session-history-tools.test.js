// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { searchHistory, sessionHistoryDefinitions } from '../src/session-history-tools.js';

test('history search returns bounded addressable records from context-cold history', () => {
  const records = [
    { type: 'message', role: 'user', turn_id: 'turn-1', content: 'Configure the cobalt provider for the remote lab.' },
    { type: 'tool_result', turn_id: 'turn-1', tool: 'provider.test', status: 'succeeded', content: 'connected' },
    { type: 'compaction', omitted: 2, retainedRecords: [] },
    { type: 'message', role: 'user', turn_id: 'turn-2', content: 'What did we call that provider?' },
  ];
  const result = searchHistory(records, { query: 'cobalt provider', limit: 4 });
  assert.ok(result.matches.length >= 1);
  assert.equal(result.matches[0].record_index, 0);
  assert.equal(result.matches[0].turn_id, 'turn-1');
  assert.match(result.matches[0].snippet, /cobalt provider/u);
});

test('history tools redact secrets and read exact neighboring records', async () => {
  const records = [
    { type: 'message', role: 'user', content: 'token=very-secret-value' },
    { type: 'message', role: 'assistant', content: 'Configuration complete.' },
  ];
  const telemetry = [];
  const definitions = sessionHistoryDefinitions({
    transcript: () => records,
    telemetry: { record: (...args) => telemetry.push(args) },
  });
  const search = definitions.find((item) => item.name === 'session.search_history');
  const read = definitions.find((item) => item.name === 'session.read_history');
  const searchResult = await search.executor({ args: { query: 'secret', limit: 8 } }, new AbortController().signal);
  assert.doesNotMatch(searchResult.content, /very-secret-value/u);
  assert.match(searchResult.content, /redacted/u);
  const readResult = await read.executor({ args: { record_index: 1, surrounding: 1 } }, new AbortController().signal);
  const parsed = JSON.parse(readResult.content);
  assert.equal(parsed.records.length, 2);
  assert.equal(parsed.records[1].record_index, 1);
  assert.doesNotMatch(readResult.content, /very-secret-value/u);
  assert.deepEqual(telemetry.map(([event]) => event), ['session.history_search', 'session.history_read']);
});

test('history search bounds scanning to the newest fifty thousand records', () => {
  const records = Array.from({ length: 50_002 }, (_, index) => ({
    type: 'message', role: 'user', content: index === 0 ? 'ancient needle' : `record ${index}`,
  }));
  const result = searchHistory(records, { query: 'ancient needle' });
  assert.equal(result.truncated, true);
  assert.equal(result.scanned, 50_000);
  assert.equal(result.matches.length, 0);
});
