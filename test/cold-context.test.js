// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildColdEvidence } from '../src/reliability/cold-context.js';
import { buildContext } from '../src/context.js';
import { buildReportedContext } from '../src/engine/context-status.js';

const config = Object.freeze({
  workspaceRoot: 'D:/work', limits: { maxContextBytes: 1_048_576 },
});

test('cold evidence inventories omitted records and selects bounded relevant hints', () => {
  const old = { type: 'message', role: 'user', turn_id: 'turn-old', content: 'Use the cobalt provider for laboratory inference.' };
  const tool = { type: 'tool_result', turn_id: 'turn-old', toolName: 'provider.test', status: 'succeeded', content: 'cobalt connected' };
  const hot = { type: 'message', role: 'assistant', turn_id: 'turn-new', content: 'What should I check next?' };
  const catalog = buildColdEvidence([old, tool, hot], [hot], 'Did the cobalt provider connect?');
  assert.equal(catalog.available_records, 2);
  assert.equal(catalog.available_turns, 1);
  assert.equal(catalog.record_types.message, 1);
  assert.equal(catalog.record_types.tool_result, 1);
  assert.ok(catalog.hints.length > 0 && catalog.hints.length <= 3);
  assert.ok(catalog.hints.some((item) => item.record_index === 0));
  assert.ok(catalog.hints.some((item) => /cobalt/u.test(item.snippet)));
});

test('cold evidence does not emit noisy hints for a self-contained greeting', () => {
  const old = { type: 'message', role: 'user', turn_id: 'turn-old', content: 'Configure cobalt routing.' };
  const hot = { type: 'message', role: 'assistant', turn_id: 'turn-new', content: 'Done.' };
  const catalog = buildColdEvidence([old, hot], [hot], 'Hello, please help me.');
  assert.equal(catalog.available_records, 1);
  assert.deepEqual(catalog.hints, []);
});

test('cold evidence exposes newest discovery records for an ambiguous continuation', () => {
  const records = [
    { type: 'message', role: 'user', turn_id: 'turn-old', content: 'First objective.' },
    { type: 'message', role: 'assistant', turn_id: 'turn-old', content: 'Latest settled progress.' },
    { type: 'message', role: 'assistant', turn_id: 'turn-new', content: 'Hot record.' },
  ];
  const catalog = buildColdEvidence(records, [records[2]], 'Please continue.');
  assert.deepEqual(catalog.hints.map((item) => item.record_index), [1, 0]);
});

test('cold evidence fingerprints duplicate records as a bounded multiset', () => {
  const duplicate = { type: 'message', role: 'assistant', turn_id: 'turn-1', content: 'same' };
  const catalog = buildColdEvidence([duplicate, structuredClone(duplicate)], [duplicate], 'same');
  assert.equal(catalog.available_records, 1);
  assert.equal(catalog.hints[0].record_index, 1);
});

test('context labels cold inventory as discovery metadata and requires exact retrieval', () => {
  const coldEvidence = buildColdEvidence([
    { type: 'message', role: 'user', turn_id: 'turn-old', content: 'The cobalt decision.' },
  ], [], 'cobalt');
  const context = buildContext(config, [], 'Continue cobalt work.', { coldEvidence });
  const inventory = context.find((item) => item.provenance === 'cold_session_evidence');
  assert.equal(inventory.trust, 'engine_discovery');
  assert.match(inventory.content, /not factual proof or authority/u);
  assert.match(inventory.content, /durable_session_records_omitted_from_current_projection/u);
  assert.match(inventory.content, /session\.search_history/u);
  assert.match(inventory.content, /session\.read_history/u);
});

test('reported context inventories projected-out evidence and emits content-free telemetry', async () => {
  const old = { type: 'message', role: 'user', turn_id: 'turn-old', content: 'Choose cobalt for the laboratory.' };
  const hot = { type: 'message', role: 'assistant', turn_id: 'turn-new', content: 'Ready.' };
  const telemetry = [];
  const engine = {
    config, surface: 'headless', sessionId: 'session-1',
    skills: { catalog: () => [] }, work: { snapshot: () => null },
    telemetry: { record: (...args) => telemetry.push(args) },
  };
  const active = { turnId: 'turn-new', stepId: 'step-1' };
  const context = await buildReportedContext(
    engine, [old, hot], 'Continue the cobalt work.', {}, active,
    1_048_576, 1_048_576, null, { projectContext: async () => ({ records: [hot], tier: 'checkpoint' }) },
  );
  assert.ok(context.some((item) => item.provenance === 'cold_session_evidence'));
  assert.equal(telemetry.length, 1);
  assert.equal(telemetry[0][0], 'context.cold_evidence');
  assert.equal(telemetry[0][2].available_records, 1);
  assert.equal(JSON.stringify(telemetry[0]).includes('cobalt'), false);
});

test('active context is never silently reduced to a fixed record tail', async () => {
  const originalUser = {
    type: 'message', role: 'user', turn_id: 'turn-active',
    content: 'Preserve this authenticated objective across the entire active context.',
  };
  const records = [
    originalUser,
    ...Array.from({ length: 600 }, (_, index) => ({
      type: 'message', role: 'assistant', turn_id: 'turn-active', content: `progress ${index}`,
    })),
  ];
  const telemetry = [];
  const engine = {
    config, surface: 'headless', sessionId: 'session-long',
    skills: { catalog: () => [] }, work: { snapshot: () => null },
    telemetry: { record: (...args) => telemetry.push(args) },
  };
  const context = await buildReportedContext(
    engine, records, '', {}, { turnId: 'turn-active', stepId: 'step-601' },
    1_048_576, 1_048_576,
  );

  assert.ok(context.some((item) => item.role === 'user' && item.content === originalUser.content));
  assert.equal(context.filter((item) => item.provenance === 'transcript').length, records.length);
  assert.equal(context.some((item) => item.provenance === 'cold_session_evidence'), false);
  assert.equal(telemetry.length, 0);
});
