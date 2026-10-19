// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compactionRefreshDecision, desiredCompactionTarget, prepareEngineContext } from '../src/engine/context-preparation.js';
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
  output: async () => undefined,
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
  assert.ok(run.active.skippedCompactionTriggers.has('same-payload'));
  assert.ok(context.some((item) => item.content === 'Hello.'));
});

test('continuation integrity repair remains available even without input savings', async () => {
  const run = fixture();
  const output = [];
  run.engine.surface = 'interactive_tui'; run.engine.output = async (record) => output.push(record);
  run.engine.transcript = [{ type: 'message', role: 'user', turnId: 'current', content: 'Hello.' }];
  run.active.contextCompressionTrigger = 'stale_continuation_artifact';
  await prepareEngineContext(run.engine, run.engine.transcript, '', run.active, true, run.operations);
  assert.equal(run.facts.length, 1);
  assert.deepEqual(run.terminals, ['completed']);
  const completed = output.find((record) => record.type === 'context_compaction_status' && record.status === 'completed');
  assert.equal(completed.outcome_reason, 'continuation_integrity_repair');
  assert.equal(completed.input_growth_tokens,
    Math.max(0, completed.after_estimated_tokens - completed.before_estimated_tokens));
});

test('compaction continues after a status subscriber fails at start', async () => {
  const run = fixture();
  const statuses = [], telemetry = [];
  run.engine.output = async (record) => {
    if (record.type !== 'context_compaction_status') return;
    statuses.push(record.status);
    if (record.status === 'started') {
      const error = new Error('status subscriber disconnected');
      error.code = 'subscriber_disconnected';
      throw error;
    }
  };
  run.engine.telemetry = { record: (event, status, detail) => telemetry.push({ event, status, detail }) };
  await prepareEngineContext(run.engine, [...run.engine.transcript], '', run.active, false, run.operations);
  assert.deepEqual(statuses, ['started', 'completed']);
  assert.deepEqual(telemetry.filter((row) => row.event === 'context.compaction_status_output'), [
    { event: 'context.compaction_status_output', status: 'failed',
      detail: { status: 'started', reason_code: 'subscriber_disconnected' } },
  ]);
  assert.deepEqual(run.terminals, ['completed']);
  assert.equal(run.facts.length, 1);
});

test('status output and its failure telemetry cannot interrupt compaction', async () => {
  const run = fixture();
  run.engine.output = async () => {
    const error = new Error('status subscriber disconnected');
    error.code = 'subscriber_disconnected';
    throw error;
  };
  run.engine.telemetry = { record: (event) => {
    if (event === 'context.compaction_status_output') throw new Error('telemetry sink disconnected');
  } };
  await prepareEngineContext(run.engine, [...run.engine.transcript], '', run.active, false, run.operations);
  assert.deepEqual(run.terminals, ['completed']);
  assert.equal(run.facts.length, 1);
});

test('failed status output preserves the underlying compaction error', async () => {
  const run = fixture({ attachments: [{ id: 'large', mimeType: 'text/plain', route: 'text', observation: 'x'.repeat(100000) }] });
  run.engine.output = async () => {
    const error = new Error('status subscriber disconnected');
    error.code = 'subscriber_disconnected';
    throw error;
  };
  run.engine.telemetry = { record: (event) => {
    if (event === 'context.compaction_status_output') throw new Error('telemetry sink disconnected');
  } };
  await assert.rejects(prepareEngineContext(run.engine, [...run.engine.transcript], '', run.active, false, run.operations),
    (error) => error.code === 'context_compaction_irreducible');
  assert.deepEqual(run.terminals, ['failed']);
  assert.equal(run.facts.length, 0);
});

test('failed pre-compaction hook closes the started lifecycle', async () => {
  const run = fixture();
  const statuses = [];
  run.engine.output = async (record) => {
    if (record.type === 'context_compaction_status') statuses.push(record);
  };
  run.operations.publish = async (event) => {
    if (event === 'compaction.pre') {
      const error = new Error('pre hook failed');
      error.code = 'pre_hook_failed';
      throw error;
    }
    return { results: [] };
  };
  await assert.rejects(prepareEngineContext(run.engine, [...run.engine.transcript], '', run.active, false, run.operations),
    (error) => error.code === 'pre_hook_failed');
  assert.deepEqual(statuses.map((record) => record.status), ['started', 'failed']);
  assert.equal(statuses[1].reason_code, 'pre_hook_failed');
  assert.deepEqual(run.terminals, ['failed']);
});

test('rejected task-checkpoint variant does not publish a file for uncommitted state', async () => {
  const run = fixture();
  const root = await mkdtemp(join(tmpdir(), 'nna-compaction-checkpoint-review-'));
  try {
    run.engine.store = { path: join(root, 'session.jsonl') };
    const checkpointFile = `${run.engine.store.path}.task-state.md`;
    await writeFile(checkpointFile, 'previous committed checkpoint');
    const statuses = [];
    run.engine.surface = 'interactive_tui';
    run.engine.output = async (item) => { if (item.type === 'context_status') statuses.push(item); };
    run.engine.reliability.attachTaskCheckpoint = (fact, path) => ({
      ...fact, continuation: { ...fact.continuation, taskStatePath: path },
      summary: `${fact.summary}${' larger checkpoint '.repeat(4000)}`,
    });
    const context = await prepareEngineContext(run.engine, [...run.engine.transcript], '', run.active, false, run.operations);
    assert.equal(run.facts.length, 1);
    assert.equal(run.facts[0].continuation?.taskStatePath, undefined);
    assert.equal(statuses.length, 1);
    const expected = measureCompactionInput(run.engine, run.engine.router.candidates()[0], context, run.active, run.budget);
    assert.equal(run.active.contextTokens, expected.estimated_input_tokens);
    assert.equal(run.engine.lastContextMeasurement.tokens, expected.estimated_input_tokens);
    assert.equal(await readFile(checkpointFile, 'utf8'), 'previous committed checkpoint');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('selected task-checkpoint variant publishes measured context and matching file', async () => {
  const run = fixture();
  const root = await mkdtemp(join(tmpdir(), 'nna-compaction-checkpoint-selected-'));
  try {
    run.engine.store = { path: join(root, 'session.jsonl') };
    run.engine.reliability.attachTaskCheckpoint = (fact, path) => ({
      ...fact, continuation: { ...fact.continuation, taskStatePath: path }, summary: 'brief continuation',
    });
    const context = await prepareEngineContext(run.engine, [...run.engine.transcript], '', run.active, false, run.operations);
    const path = `${run.engine.store.path}.task-state.md`;
    assert.equal(run.facts[0].continuation.taskStatePath, path);
    assert.match(await readFile(path, 'utf8'), /# NNA task checkpoint/u);
    const expected = measureCompactionInput(run.engine, run.engine.router.candidates()[0], context, run.active, run.budget);
    assert.equal(run.active.contextTokens, expected.estimated_input_tokens);
    assert.equal(run.engine.lastContextMeasurement.tokens, expected.estimated_input_tokens);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('irreducible attachments fail closed without silently discarding evidence or committing an unfitted compaction', async () => {
  const run = fixture({ attachments: [{ id: 'attachment', mimeType: 'text/plain', route: 'text', observation: 'untrusted observation '.repeat(10000) }] });
  let candidates = 0;
  run.engine.reliability.continuationCompactor.refine = async (fact) => { candidates += 1; return fact; };
  await assert.rejects(prepareEngineContext(run.engine, [...run.engine.transcript], '', run.active, false, run.operations),
    (error) => error.code === 'context_compaction_irreducible'
      && error.detail.best_candidate_estimated_tokens > run.budget.scaledTokens
      && error.detail.static_envelope_exceeds_ceiling
      && error.detail.floor_status === 'bounded_attempt_diagnostic');
  assert.equal(candidates, 3);
  assert.equal(run.facts.length, 0);
  assert.deepEqual(run.terminals, ['failed']);
  assert.equal(run.active.enrichment.attachments[0].observation.length, 220000);
});

test('tool-schema overflow is included in preflight and cannot be hidden by compacting transcript', async () => {
  const run = fixture({}, [{ type: 'function', function: { name: 'large.schema', description: 'schema '.repeat(30000), parameters: { type: 'object' } } }]);
  await assert.rejects(prepareEngineContext(run.engine, [...run.engine.transcript], '', run.active, false, run.operations),
    (error) => error.code === 'context_compaction_irreducible'
      && error.detail.largest_sections.some((section) => section.id === 'request.tool_schemas'));
  assert.equal(run.facts.length, 0);
  assert.deepEqual(run.terminals, ['failed']);
});

test('skipped refresh memory is bounded to an unchanged source, including A/B/A triggers', () => {
  const active = { skippedCompactionTriggers: new Set(), skippedCompactionSourceFingerprint: null };
  const records = [{ type: 'message', content: 'same evidence' }];
  const a = { reason: 'tool_payload_budget', checkpointIndex: 0, completedTurns: 2, payloadTokens: 900 };
  const b = { ...a, reason: 'completed_turn_interval' };
  const first = compactionRefreshDecision(active, a, records);
  assert.equal(first.refresh, a);
  active.skippedCompactionTriggers.add(first.triggerKey);
  const other = compactionRefreshDecision(active, b, records);
  assert.equal(other.refresh, b);
  assert.equal(compactionRefreshDecision(active, a, records).refresh, null);
  assert.equal(compactionRefreshDecision(active, a, [{ ...records[0], content: 'changed evidence' }]).refresh, a);
  assert.equal(active.skippedCompactionTriggers.size, 0);
});

test('tiny complete inputs have no false strictly-smaller compaction target', () => {
  assert.equal(desiredCompactionTarget({}, 0), null);
  assert.equal(desiredCompactionTarget({}, 1), null);
  assert.equal(desiredCompactionTarget({}, 2), 1);
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

test('non-TUI output receives every compaction lifecycle outcome with matching telemetry', async () => {
  for (const expected of ['completed', 'skipped', 'failed']) {
    const run = expected === 'failed'
      ? fixture({ attachments: [{ id: 'large', mimeType: 'text/plain', route: 'text', observation: 'x'.repeat(100000) }] })
      : fixture();
    const output = [], telemetry = [];
    run.engine.surface = 'headless';
    run.engine.output = async (record) => output.push(record);
    run.engine.telemetry = { record: (event, status, detail) => telemetry.push({ event, status, detail }) };
    if (expected === 'skipped') {
      run.engine.transcript = [{ type: 'message', role: 'user', turnId: 'current', content: 'Hello.' }];
      run.active.contextCompressionTrigger = 'tool_payload_budget';
    }
    const action = prepareEngineContext(run.engine, [...run.engine.transcript], '', run.active,
      expected === 'skipped', run.operations);
    if (expected === 'failed') await assert.rejects(action);
    else await action;
    const statuses = output.filter((record) => record.type === 'context_compaction_status').map((record) => record.status);
    assert.deepEqual(statuses, ['started', expected]);
    if (expected === 'failed') {
      const [started, failed] = output.filter((record) => record.type === 'context_compaction_status');
      assert.equal(failed.before_estimated_tokens, started.before_estimated_tokens);
      assert.equal(failed.target_tokens, started.target_tokens);
    }
    const expectedTelemetry = expected === 'completed' ? 'succeeded' : expected;
    assert.deepEqual(telemetry.filter((record) => record.event === 'context.compaction').map((record) => record.status),
      ['started', expectedTelemetry]);
  }
});
