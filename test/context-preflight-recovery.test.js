// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareEngineContext } from '../src/engine/context-preparation.js';
import { ReliabilityEngine } from '../src/reliability-engine.js';
import { measureContext } from '../src/context.js';
import { measureCompactionInput } from '../src/engine/compaction-measurement.js';

function fixture(enrichment = {}, tools = []) {
  const route = { model: 'fixture', profile: { id: 'fixture' }, maxOutputTokens: 1024 };
  const reliability = new ReliabilityEngine({ modelDialects: { instructions: () => '' },
    continuationCompactor: { refine: async (fact) => fact } });
  const budget = { hardLimitBytes: 65536, thresholdBytes: 48000, scaledTokens: 16000,
    effectiveInputTokens: 20000, outputReserveTokens: 1024, windowTokens: 22000 };
  reliability.planContextBudget = () => budget;
  // Exercise the final byte/envelope guard rather than the earlier pressure trigger.
  reliability.pressureTier = () => 'none';
  const transitions = [], facts = [], terminals = [];
  const engine = { config: { workspaceRoot: process.cwd(), executionManifest: null,
    limits: { maxContextBytes: budget.hardLimitBytes } }, reliability,
  router: { candidates: () => [route] }, modelRuntime: { resolve: async () => ({ model: 'fixture', providerId: 'fixture' }) },
  tools: { providerDefinitions: () => tools },
  transcript: [{ type: 'message', role: 'assistant', turnId: 'old', content: 'historical evidence '.repeat(20000) },
    { type: 'message', role: 'user', turnId: 'current', content: 'Inspect only; do not change any files.' }],
  state: { transition: (state) => transitions.push(state) },
  lifecycles: { start: () => ({ id: 'compaction' }), finish: (_id, status) => terminals.push(status) } };
  const active = { turnId: 'current', stepId: 'now', controller: new AbortController(),
    enrichment: { hooks: [], ...enrichment }, contextRetryScale: 1, compactionAttempts: 0,
    compactionNoProgressAttempts: 0, compactionFingerprints: new Set(), contextCheckpointFingerprints: new Set() };
  const operations = { publish: async () => ({ results: [] }), persist: async (_type, fact) => {
    facts.push(fact); engine.transcript.push(fact);
  } };
  return { engine, active, operations, transitions, facts, terminals, budget };
}

test('final context overflow triggers bounded compaction before returning a provider context', async () => {
  const run = fixture();
  const context = await prepareEngineContext(run.engine, [...run.engine.transcript], '', run.active, false, run.operations);
  assert.ok(measureContext(context) <= run.budget.thresholdBytes);
  assert.ok(context.some((message) => message.role === 'user' && message.content === 'Inspect only; do not change any files.'));
  assert.deepEqual(run.transitions, ['compacting_context']);
  assert.equal(run.facts.length, 1);
  assert.equal(run.active.compactionAttempts, 1);
  assert.deepEqual(run.terminals, ['completed']);
  assert.ok(run.engine.transcript[0].content.length > 300000, 'durable evidence was not truncated');
});

test('ineffective optional refresh preserves input and commits no checkpoint', async () => {
  const run = fixture();
  run.engine.transcript = [{ type: 'message', role: 'user', turnId: 'current', content: 'Hello.' }];
  run.active.contextCompressionTrigger = 'tool_payload_budget';
  run.active.contextCompressionTriggerKey = 'same-payload';
  const context = await prepareEngineContext(run.engine, run.engine.transcript, '', run.active, true, run.operations);
  assert.equal(run.facts.length, 0);
  assert.deepEqual(run.terminals, ['skipped']);
  assert.equal(run.active.skippedCompactionTrigger, 'same-payload');
  assert.ok(context.some((item) => item.content === 'Hello.'));
});

test('continuation integrity repair remains available even without input savings', async () => {
  const run = fixture();
  run.engine.transcript = [{ type: 'message', role: 'user', turnId: 'current', content: 'Hello.' }];
  run.active.contextCompressionTrigger = 'stale_continuation_artifact';
  await prepareEngineContext(run.engine, run.engine.transcript, '', run.active, true, run.operations);
  assert.equal(run.facts.length, 1);
  assert.deepEqual(run.terminals, ['completed']);
});

test('irreducible attachments fail closed without silently discarding evidence or committing an unfitted compaction', async () => {
  const run = fixture({ attachments: [{ id: 'attachment', mimeType: 'text/plain', route: 'text', observation: 'untrusted observation '.repeat(10000) }] });
  let candidates = 0;
  run.engine.reliability.continuationCompactor.refine = async (fact) => { candidates += 1; return fact; };
  await assert.rejects(prepareEngineContext(run.engine, [...run.engine.transcript], '', run.active, false, run.operations), { code: 'context_too_large' });
  assert.equal(candidates, 3);
  assert.equal(run.facts.length, 0);
  assert.deepEqual(run.terminals, ['failed']);
  assert.equal(run.active.enrichment.attachments[0].observation.length, 220000);
});

test('tool-schema overflow is included in preflight and cannot be hidden by compacting transcript', async () => {
  const run = fixture({}, [{ type: 'function', function: { name: 'large.schema', description: 'schema '.repeat(30000), parameters: { type: 'object' } } }]);
  await assert.rejects(prepareEngineContext(run.engine, [...run.engine.transcript], '', run.active, false, run.operations), { code: 'context_too_large' });
  assert.equal(run.facts.length, 0);
  assert.deepEqual(run.terminals, ['failed']);
});

test('settled-turn age refreshes a large-window hot context before pressure is reached', async () => {
  const run = fixture();
  run.engine.transcript = [
    ...Array.from({ length: 8 }, (_, index) => ([
      { type: 'message', role: 'user', turnId: `settled-${index}`, content: `request ${index}` },
      { type: 'message', role: 'assistant', turnId: `settled-${index}`, content: `result ${index} ${'x'.repeat(3_000)}` },
    ])).flat(),
    { type: 'message', role: 'user', turnId: 'current', content: 'Continue with the current task.' },
  ];

  const context = await prepareEngineContext(
    run.engine, [...run.engine.transcript], '', run.active, false, run.operations,
  );

  assert.deepEqual(run.transitions, ['compacting_context']);
  assert.equal(run.facts.length, 1);
  assert.ok(run.facts[0].omitted > 0);
  assert.ok(context.some((message) => message.role === 'user'
    && message.content === 'Continue with the current task.'));
  assert.ok(run.engine.transcript.some((record) => record.type === 'compaction'));
});

test('compaction compares complete provider input and keeps journal metadata separate', async () => {
  const measurements = [];
  for (const diagnostic of ['', 'x'.repeat(90000)]) {
    const run = fixture({}, [{ type: 'function', function: { name: 'inspect', description: 'inspect safely', parameters: { type: 'object' } } }]);
    const output = [], telemetry = [];
    run.engine.surface = 'interactive_tui';
    run.engine.output = async (record) => output.push(record);
    run.engine.telemetry = { record: (event, status, detail) => telemetry.push({ event, status, detail }) };
    run.engine.transcript = [{ type: 'message', role: 'user', turnId: 'current', content: 'inspect', metadata: { diagnostic } }];
    run.active.contextCompressionTrigger = 'tool_payload_budget';
    const context = await prepareEngineContext(run.engine, [...run.engine.transcript], '', run.active, true, run.operations);
    const started = output.find((record) => record.type === 'context_compaction_status' && record.status === 'started');
    const completed = output.find((record) => record.type === 'context_compaction_status' && record.status === 'skipped');
    const expected = measureCompactionInput(run.engine, run.engine.router.candidates()[0], context, run.active, run.budget);
    assert.equal(completed.after_estimated_tokens, expected.estimated_input_tokens);
    assert.equal(started.measurement_basis, 'complete_provider_input');
    assert.equal(completed.measurement_basis, started.measurement_basis);
    assert.equal(completed.before_estimated_tokens, started.before_estimated_tokens);
    assert.equal(telemetry.find((row) => row.event === 'context.compaction' && row.status === 'skipped').detail.after_estimated_tokens, completed.after_estimated_tokens);
    assert.equal(run.facts.length, 0);
    measurements.push(started);
  }
  assert.equal(measurements[0].before_estimated_tokens, measurements[1].before_estimated_tokens);
  assert.ok(measurements[1].journal_estimated_tokens > measurements[0].journal_estimated_tokens + 25000);
});

test('long-horizon compaction reports its trigger and diagnostic ceilings', async () => {
  const run = fixture(); const output = [];
  run.engine.surface = 'interactive_tui'; run.engine.output = async (record) => output.push(record);
  run.engine.transcript = Array.from({ length: 9 }, (_, index) => ({
    type: 'message', role: 'user', turnId: index === 8 ? 'current' : `old-${index}`, content: `continue ${'x'.repeat(2500)}`,
  }));
  await prepareEngineContext(run.engine, [...run.engine.transcript], '', run.active, false, run.operations);
  const started = output.find((record) => record.type === 'context_compaction_status' && record.status === 'started');
  assert.equal(started.trigger, 'completed_turn_interval');
  assert.equal(started.context_window_tokens, run.budget.windowTokens);
  assert.equal(started.output_reserve_tokens, run.budget.outputReserveTokens);
  assert.equal(started.threshold_bytes, run.budget.thresholdBytes);
  assert.equal(started.retry_scale, 1);
});
