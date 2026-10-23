// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { searchHistory, sessionHistoryDefinitions } from '../src/session-history-tools.js';
import { registerSecretValue, releaseSecretValue } from '../src/redaction.js';

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
    compressionState: () => ({ tier: 'checkpoint', compactionAttempts: 1 }),
  });
  const search = definitions.find((item) => item.name === 'session_search_history');
  const read = definitions.find((item) => item.name === 'session_read_history');
  const searchResult = await search.executor({ args: { query: 'message', limit: 8 } }, new AbortController().signal);
  assert.doesNotMatch(searchResult.content, /very-secret-value/u);
  assert.match(searchResult.content, /redacted/u);
  assert.equal(searchResult.metadata.scan_truncated, false);
  assert.equal(searchResult.metadata.output_truncated, false);
  const readResult = await read.executor({ args: { record_index: 1, surrounding: 1 } }, new AbortController().signal);
  const parsed = JSON.parse(readResult.content);
  assert.equal(parsed.records.length, 2);
  assert.equal(parsed.records[1].record_index, 1);
  assert.doesNotMatch(readResult.content, /very-secret-value/u);
  assert.equal(readResult.metadata.output_truncated, false);
  assert.deepEqual(telemetry.map(([event]) => event), ['session.history_search', 'session.history_read']);
  for (const [, , detail] of telemetry) {
    assert.equal(detail.compression_induced, true);
    assert.equal(detail.compression_tier, 'checkpoint');
    assert.equal(detail.compaction_attempts, 1);
    assert.ok(detail.rediscovery_bytes > 0);
    assert.ok(detail.rediscovery_estimated_tokens > 0);
  }
});

test('history search bounds scanning to the newest fifty thousand records', () => {
  const records = Array.from({ length: 50_002 }, (_, index) => ({
    type: 'message', role: 'user', content: index === 0 ? 'ancient needle' : `record ${index}`,
  }));
  const result = searchHistory(records, { query: 'ancient needle' });
  assert.equal(result.scan_truncated, true);
  assert.equal(result.scanned, 50_000);
  assert.equal(result.matches.length, 0);
});

test('history search honors one-character queries and rejects an empty type filter', async () => {
  const records = [{ type: 'message', content: 'version 5' }];
  assert.equal(searchHistory(records, { query: '5' }).matches.length, 1);
  assert.throws(() => searchHistory(records, { query: '5', types: [] }), { code: 'session_history_types_invalid' });
  const search = sessionHistoryDefinitions({ transcript: () => records }).find((item) => item.name === 'session_search_history');
  await assert.rejects(search.validate({ query: '5', types: [] }), { code: 'tool_schema_invalid' });
});

test('history tool executor accepts an omitted signal and rejects cancellation', async () => {
  const definitions = sessionHistoryDefinitions({ transcript: () => [{ type: 'message', content: 'cobalt' }] });
  const search = definitions.find((item) => item.name === 'session_search_history');
  const read = definitions.find((item) => item.name === 'session_read_history');
  assert.equal((await search.executor({ args: { query: 'cobalt' } })).metadata.matches, 1);
  assert.equal(JSON.parse((await read.executor({ args: { record_index: 0 } })).content).records[0].record.content, 'cobalt');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(search.executor({ args: { query: 'cobalt' } }, controller.signal), { code: 'tool_cancelled' });
  await assert.rejects(read.executor({ args: { record_index: 0 } }, controller.signal), { code: 'tool_cancelled' });
});

test('history search scores redacted text so secrets are not queryable by existence', () => {
  const secret = 'test-only-history-secret-1246';
  registerSecretValue(secret, 'history-test');
  try {
    const result = searchHistory([{ type: 'message', content: secret }], { query: secret });
    assert.equal(result.matches.length, 0);
  } finally { releaseSecretValue(secret); }
});

test('history search can find redaction markers even when raw text has no matching term', () => {
  const secret = 'test-only-history-secret-9876';
  registerSecretValue(secret, 'history-marker');
  try {
    const records = [{ type: 'message', content: secret }];
    const result = searchHistory(records, { query: 'history-marker' });
    assert.equal(result.matches.length, 1);
    assert.match(result.matches[0].snippet, /nna-redacted:history-marker/u);
  } finally { releaseSecretValue(secret); }
});

test('history search can find redaction-generated omitted-key metadata', () => {
  const metadata = Object.fromEntries(Array.from({ length: 513 }, (_, index) => [`f${index}`, 'x']));
  const result = searchHistory([{ type: 'message', metadata }], { query: 'omitted_keys' });
  assert.equal(result.matches.length, 1);
});

test('history snippets do not spend the record-read budget on discarded content', async () => {
  const records = [
    { type: 'message', content: `${'query '.repeat(20)}${'x'.repeat(600_000)}` },
    { type: 'message', content: 'query small result' },
  ];
  const search = sessionHistoryDefinitions({ transcript: () => records }).find((item) => item.name === 'session_search_history');
  const result = JSON.parse((await search.executor({ args: { query: 'query' } }, new AbortController().signal)).content);
  assert.equal(result.matches.length, 2);
  assert.match(result.matches[1].snippet, /query small result/u);
});

test('history read reserves its budget for the requested record before neighbors', async () => {
  const records = [
    { type: 'message', content: 'x'.repeat(550_000) },
    { type: 'message', content: 'neighbor' },
    { type: 'message', content: 'requested target' },
  ];
  const read = sessionHistoryDefinitions({ transcript: () => records }).find((item) => item.name === 'session_read_history');
  const result = await read.executor({ args: { record_index: 2, surrounding: 2 } }, new AbortController().signal);
  const parsed = JSON.parse(result.content);
  assert.equal(parsed.records[2].record.content, 'requested target');
  assert.ok(Buffer.byteLength(result.content) <= 524_288);
});

test('history read retains the requested record when nested scalars exhaust the byte budget', async () => {
  const requested = { type: 'message', content: 'requested target',
    data: Array.from({ length: 128 }, () => Array.from({ length: 128 }, () => Array(16).fill(123456789))) };
  const read = sessionHistoryDefinitions({ transcript: () => [requested] })
    .find((item) => item.name === 'session_read_history');
  const result = await read.executor({ args: { record_index: 0 } }, new AbortController().signal);
  const parsed = JSON.parse(result.content);
  assert.equal(parsed.records[0].record.content, 'requested target');
  assert.equal(result.metadata.record_projection_truncated, true);
  assert.equal(result.metadata.output_truncated, false);
  assert.ok(Buffer.byteLength(result.content) <= 524_288);
});

test('history read charges long keys to its byte budget without losing the selected record', async () => {
  const data = Object.fromEntries(Array.from({ length: 128 }, (_, index) =>
    [`field-${index}-${'k'.repeat(4_500)}`, index]));
  const requested = { type: 'message', content: 'requested target', data };
  const read = sessionHistoryDefinitions({ transcript: () => [requested] })
    .find((item) => item.name === 'session_read_history');
  const result = await read.executor({ args: { record_index: 0 } }, new AbortController().signal);
  const parsed = JSON.parse(result.content);
  assert.equal(parsed.records[0].record.content, 'requested target');
  assert.equal(result.metadata.record_projection_truncated, true);
  assert.ok(Buffer.byteLength(result.content) <= 524_288);
});
