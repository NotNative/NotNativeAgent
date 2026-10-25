// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { TuiProjection } from '../src/experience/projection.js';
import { TuiRenderer } from '../src/tui/renderer.js';
import { contextCompactionText } from '../src/tui/context-renderer.js';

test('context compaction status is concise and visible', () => {
  assert.match(contextCompactionText({ status: 'started', before_estimated_tokens: 220000, target_tokens: 209000 }), /CONTEXT \| compacting/u);
  assert.match(contextCompactionText({
    status: 'completed', before_estimated_tokens: 220000, after_estimated_tokens: 48000,
    retained_records: 17, protected_turns: 6, payload_compacted_records: 2,
  }), /CONTEXT \| compacted[\s\S]*Retained 17.*protected 6 recent turns.*reduced 2 payloads/u);
  assert.match(contextCompactionText({ status: 'failed', reason_code: 'compaction_insufficient' }), /compaction failed.*compaction_insufficient/u);
});

test('compaction display identifies estimated input, trigger, and model window', () => {
  const text = contextCompactionText({ status: 'started', measurement_basis: 'complete_provider_input',
    before_estimated_tokens: 55938, target_tokens: 41953, trigger: 'completed_turn_interval', context_window_tokens: 300000 });
  assert.match(text, /estimated complete input: 55,938 tokens/u);
  assert.match(text, /conversation refresh under context pressure/u);
  assert.match(text, /Window: 300,000 tokens/u);
});

test('compaction shows usable input, output reserve, savings and pressure separately', () => {
  const text = contextCompactionText({ status: 'completed', measurement_basis: 'complete_provider_input',
    before_estimated_tokens: 30408, after_estimated_tokens: 21660, context_window_tokens: 131072,
    effective_input_tokens: 99072, output_reserve_tokens: 32000, admissible_ceiling_tokens: 74304,
    binding_ceiling: 'token_budget', trigger: 'completed_turn_interval', source: 'openai_models' });
  assert.match(text, /saved 8,748 tokens/u);
  assert.match(text, /21.9% of usable input/u);
  assert.match(text, /usable input: 99,072 tokens/u);
  assert.match(text, /output reserve: 32,000 tokens/u);
  assert.match(text, /pressure threshold: 74,304 tokens/u);
});

test('skipped compaction preserves input and unknown budgets never invent percentages', () => {
  assert.match(contextCompactionText({ status: 'skipped' }), /skipped.*input preserved/u);
  assert.doesNotMatch(contextCompactionText({ status: 'started', before_estimated_tokens: 12 }), /%/u);
});

test('legacy payload-trigger records render as retired rather than as a live trigger', () => {
  assert.match(contextCompactionText({ status: 'started', before_estimated_tokens: 1000, trigger: 'tool_payload_budget' }),
    /retired[\s\S]*measured consumption/u);
});

test('compaction block has surrounding blank lines and off-white color including wrapped rows', () => {
  const projection = new TuiProjection();
  projection.addSession('main', 'Main', { model: 'm', provider: 'p' });
  projection.active().records.push(
    { type: 'stream_delta', text: 'Before.' },
    { type: 'context_compaction_status', status: 'completed', trigger: 'tool_payload_budget',
      before_estimated_tokens: 30408, after_estimated_tokens: 21660, context_window_tokens: 131072,
      effective_input_tokens: 99072, output_reserve_tokens: 32000 },
    { type: 'stream_delta', text: 'After.' },
  );
  const renderer = new TuiRenderer();
  const plain = renderer.frame(projection, { width: 80, height: 30, color: false });
  assert.match(plain, /Before\.\n\n  CONTEXT/u);
  assert.match(plain, /output reserve:[\s\S]*?\n\n\* After\./u);
  const colored = renderer.frame(projection, { width: 80, height: 30, color: true });
  assert.ok(colored.includes('\u001b[38;5;253m  CONTEXT'));
  assert.ok(colored.includes('\u001b[38;5;253m  Window:'));
});

test('live compaction uses the status line and leaves one terminal transcript block', () => {
  const projection = new TuiProjection();
  projection.addSession('main', 'Main', { model: 'm', provider: 'p' });
  const renderer = new TuiRenderer();
  const started = { type: 'context_compaction_status', status: 'started',
    before_estimated_tokens: 30408, target_tokens: 22806 };
  projection.apply('main', started);
  const live = renderer.frame(projection, { width: 120, height: 30, color: false });
  assert.match(live, /compacting/u);
  assert.doesNotMatch(live, /CONTEXT \| compacting/u);
  projection.apply('main', { type: 'context_compaction_status', status: 'completed',
    before_estimated_tokens: 30408, after_estimated_tokens: 21660 });
  const done = renderer.frame(projection, { width: 120, height: 30, color: false });
  assert.equal((done.match(/CONTEXT \| compacted/gu) ?? []).length, 1);
  assert.doesNotMatch(done, /CONTEXT \| compacting/u);
});
