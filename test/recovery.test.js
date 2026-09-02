// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { resolveManifest } from '../src/config.js';
import { SessionEngine } from '../src/engine.js';
import { ContractError } from '../src/ids.js';
import { JournalStore } from '../src/store.js';
import { LifecycleRegistry, StateAuthority } from '../src/lifecycle.js';
import { ProviderRunner } from '../src/provider/runner.js';
import { RecoverySupervisor, recoveryHint } from '../src/recovery.js';
import { ToolCallAssembler } from '../src/tools/calls.js';
import { contextPressureScale } from '../src/engine/provider-recovery.js';
import { toolProgressEvidence } from '../src/reliability/tool-progress.js';
import { awaitEngineAttention } from '../src/engine/attention.js';
import { updateToolFailures } from '../src/engine/tool-failures.js';

test('a host without steering receives resumable incomplete recovery instead of an attention wait', async () => {
  const records = [];
  const result = await awaitEngineAttention({
    config: { executionManifest: { allowedCapabilities: ['tools'] } }, transcript: [],
    reliability: {
      exhaustionDetail: () => ({ resume_condition: 'new authenticated request' }),
      exhaustionText: () => 'Recovery stopped without a steering channel.',
    },
  }, {
    recovery: {}, unresolvedToolFailures: [], turnId: 'turn-1', stepId: 'step-1',
    controller: new AbortController(),
  }, { category: 'tool_no_progress' }, {
    persist: async (type, payload) => records.push({ type, payload }),
    consumeSteering: async () => [],
  });
  assert.equal(result.terminal, true);
  assert.equal(result.explanation, 'Recovery stopped without a steering channel.');
  assert.equal(records[0].type, 'attention_unavailable');
});

test('turn-scoped failures clear only after a successful superseding operation', () => {
  const active = { toolFailureLedger: new Map() };
  const item = (path, status, effect = 'none') => ({
    call: { name: 'fs.write_text', args: { path } },
    result: { status, reason_code: status === 'failed' ? 'write_failed' : null, effect_certainty: effect },
  });
  updateToolFailures(active, [item('a.txt', 'failed')]);
  updateToolFailures(active, [item('b.txt', 'succeeded')]);
  assert.deepEqual(active.unresolvedToolFailures, ['write_failed']);
  updateToolFailures(active, [item('a.txt', 'succeeded')]);
  assert.deepEqual(active.unresolvedToolFailures, []);

  updateToolFailures(active, [item('a.txt', 'failed', 'unknown')]);
  updateToolFailures(active, [item('a.txt', 'succeeded')]);
  assert.deepEqual(active.unresolvedToolFailures, ['write_failed']);
});

function config(root, persistence = 'ephemeral', extra = {}) {
  return resolveManifest({
    persistence, workspace_root: root, ...extra,
    provider: {
      id: 'fixture', endpoint: 'http://127.0.0.1:9999/v1',
      model: 'fixture-model', trust_zone: 'loopback',
    },
  });
}

async function waitForEngineState(engine, expected, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (engine.state.state !== expected) {
    if (Date.now() >= deadline) {
      assert.fail(`engine did not reach ${expected}; current state is ${engine.state.state}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

test('provider runner accepts only declared constructor dependencies', () => {
  const runner = new ProviderRunner({ run: null, unexpected: true });
  assert.equal(typeof runner.run, 'function');
  assert.equal(Object.hasOwn(runner, 'unexpected'), false);
});

test('AC-FAIL-12 exhaustion record identifies bounded completed evidence and actual effect uncertainty', () => {
  const recovery = new RecoverySupervisor();
  recovery.observeProgress('first completed observation', {
    kind: 'tool_results', checkpoint: 'tool_results_committed', summary: { successful_tool_calls: 1 },
  });
  recovery.observeProgress('second completed observation', {
    kind: 'partial_model_output', checkpoint: 'partial_assistant_message_committed', summary: { output_bytes: 20 },
  });
  recovery.noProgress('stall');
  const record = recovery.exhaustion([{ type: 'tool_result', effectCertainty: 'unknown' }]);
  assert.equal(record.completed_progress.unique_evidence_count, 2);
  assert.equal(record.completed_progress.fingerprints.length, 2);
  assert.equal(record.completed_progress.fingerprints.every((item) => /^[a-f0-9]{64}$/u.test(item)), true);
  assert.deepEqual(record.completed_progress.evidence.map((item) => item.kind), ['tool_results', 'partial_model_output']);
  assert.equal(record.last_verified_checkpoint, 'partial_assistant_message_committed');
  assert.equal(record.last_checkpoint, record.last_verified_checkpoint);
  assert.equal(record.side_effect_certainty, 'unknown');
  assert.equal(record.recovery_actions.length, 1);
});

test('configured recovery ladder escalates without treating uncertain progress as terminal', () => {
  const manifest = config(process.cwd(), 'ephemeral', {
    recovery: { max_model_steps: 4096, local_retry_limit: 5, ladder: ['nudge', 'nudge', 'compact', 'compact'] },
  });
  assert.deepEqual(manifest.recovery, { maxModelSteps: 4096, localLimit: 5, ladder: ['nudge', 'nudge', 'compact', 'compact'] });
  assert.equal(manifest.limits.maxModelSteps, 4096);
  assert.throws(() => config(process.cwd(), 'ephemeral', {
    recovery: { local_retry_limit: 5, ladder: ['nudge', 'compact'] },
  }), { code: 'recovery_config_invalid' });
  const recovery = new RecoverySupervisor({ localLimit: 5, ladder: ['nudge', 'nudge', 'compact', 'compact'] });
  const actions = [];
  for (let count = 0; count < 4; count += 1) actions.push(recovery.noProgress('configured').action.action);
  assert.deepEqual(actions, ['nudge', 'nudge', 'compact', 'compact']);
  assert.deepEqual(recovery.noProgress('configured'), {
    continue: true, progress: false, count: 5,
    action: recovery.actions.at(-1),
  });
  assert.equal(recovery.actions.at(-1).action, 'reassess');
  for (let count = 0; count < 5; count += 1) recovery.noProgress('configured');
  assert.equal(recovery.actions.at(-1).action, 'change_strategy');
  recovery.noProgress('configured');
  assert.equal(recovery.actions.at(-1).action, 'recover_objective');
});

test('low-pressure no-progress recovery does not substitute compaction for correction', () => {
  const recovery = new RecoverySupervisor({ localLimit: 3, ladder: ['nudge', 'compact'] });
  assert.equal(recovery.noProgress('schema', null, {}, { allowCompaction: false }).action.action, 'nudge');
  assert.equal(recovery.noProgress('schema', null, {}, { allowCompaction: false }).action.action, 'nudge');
});

test('content-free provider completions remain non-terminal with bounded distinct recovery', () => {
  const recovery = new RecoverySupervisor({ localLimit: 3, ladder: ['nudge', 'nudge'] });
  const plans = Array.from({ length: 12 }, () => recovery.providerUnusableCompletion(
    { event_shape: { terminal_events: 1 } }, { routeIdentity: 'fixture\0model' },
  ));
  assert.equal(plans.every((plan) => plan.continue && !plan.exhausted), true);
  assert.deepEqual(plans.slice(0, 4).map((plan) => plan.delayMs), [250, 500, 1000, 2000]);
  assert.equal(plans.at(-1).delayMs, 30_000);
  assert.equal(new Set(plans.map((plan) => recoveryHint(plan.action))).size, plans.length);
  recovery.providerOutputObserved();
  assert.equal(recovery.providerUnusableCompletion({}, { routeIdentity: 'fixture\0model' }).count, 1);
});

test('tool recovery budgets are isolated by stable failure fingerprint', () => {
  const recovery = new RecoverySupervisor({ localLimit: 3, ladder: ['nudge', 'nudge'] });
  assert.equal(recovery.noProgress('tool_no_progress', null, {}, { failureFingerprint: 'search-glob' }).count, 1);
  assert.equal(recovery.noProgress('tool_no_progress', null, {}, { failureFingerprint: 'search-glob' }).count, 2);
  const different = recovery.noProgress('tool_no_progress', null, {}, { failureFingerprint: 'task-detail' });
  assert.equal(different.count, 1);
  assert.equal(different.action.failure_fingerprint, 'task-detail');
  let repeated;
  for (let count = 3; count <= 12; count += 1) {
    repeated = recovery.noProgress('tool_no_progress', null, {}, { failureFingerprint: 'search-glob' });
  }
  assert.deepEqual(repeated, { continue: false, exhausted: true, count: 12 });
});

test('distinct repeated successful requests do not consume one shared no-progress budget', () => {
  const recovery = new RecoverySupervisor({ localLimit: 3, ladder: ['nudge', 'nudge'] });
  const evidence = (value, requestFingerprint) => ({
    value,
    detail: {
      kind: 'tool_results', checkpoint: 'tool_results_committed',
      summary: { successful_tool_calls: 1, request_fingerprints: [requestFingerprint] },
    },
  });
  const directory = evidence('unchanged-directory-result', 'list-directory-request');
  const file = evidence('unchanged-file-result', 'read-file-request');

  assert.equal(recovery.noProgress('tool_no_progress', directory).progress, true);
  assert.equal(recovery.noProgress('tool_no_progress', file).progress, true);
  assert.equal(recovery.noProgress('tool_no_progress', directory).count, 1);
  assert.equal(recovery.noProgress('tool_no_progress', file).count, 1);
  assert.equal(recovery.noProgress('tool_no_progress', directory).count, 2);
  let repeated;
  for (let count = 3; count <= 12; count += 1) repeated = recovery.noProgress('tool_no_progress', directory);
  assert.deepEqual(repeated, { continue: false, exhausted: true, count: 12 });
});

test('the same observation is fresh progress after an observable workspace revision', () => {
  const recovery = new RecoverySupervisor({ localLimit: 3, ladder: ['nudge', 'nudge'] });
  const items = [{
    request: { toolName: 'web.browse', args: { action: 'navigate', url: 'http://127.0.0.1:4173' } },
    result: { tool_name: 'web.browse', status: 'succeeded', content: 'same rendered page' },
  }];
  const before = toolProgressEvidence(items, [], { stateRevision: 0 });
  const after = toolProgressEvidence(items, [], { stateRevision: 1 });
  assert.equal(recovery.noProgress('tool_no_progress', before).progress, true);
  assert.equal(recovery.noProgress('tool_no_progress', before).count, 1);
  assert.equal(recovery.noProgress('tool_no_progress', after).progress, true);
});

test('a new turn supervisor starts with fresh progress evidence and recovery episodes', () => {
  const evidence = {
    value: 'same-observation',
    detail: {
      kind: 'tool_results', checkpoint: 'tool_results_committed',
      summary: { successful_tool_calls: 1, request_fingerprints: ['same-request'] },
    },
  };
  const firstTurn = new RecoverySupervisor({ localLimit: 3, ladder: ['nudge', 'nudge'] });
  assert.equal(firstTurn.noProgress('tool_no_progress', evidence).progress, true);
  assert.equal(firstTurn.noProgress('tool_no_progress', evidence).count, 1);

  const nextTurn = new RecoverySupervisor({ localLimit: 3, ladder: ['nudge', 'nudge'] });
  assert.equal(nextTurn.noProgress('tool_no_progress', evidence).progress, true);
  assert.equal(nextTurn.actions.length, 0);
});

test('new verified progress settles stale no-progress budgets across categories', () => {
  const recovery = new RecoverySupervisor({ localLimit: 3, ladder: ['nudge', 'nudge'] });
  const unchangedWork = '2 unfinished task(s); goal active; work revision 10';
  assert.equal(recovery.continuation('unfinished_conversation_work', unchangedWork).progress, true);
  assert.equal(recovery.continuation('unfinished_conversation_work', unchangedWork).count, 1);

  const toolProgress = recovery.noProgress('tool_no_progress', {
    value: 'unique committed tool result',
    detail: {
      kind: 'tool_results', checkpoint: 'tool_results_committed',
      summary: { successful_tool_calls: 1 },
    },
  });
  assert.equal(toolProgress.progress, true);

  const resumedWork = recovery.continuation('unfinished_conversation_work', unchangedWork);
  assert.equal(resumedWork.count, 1);
  assert.equal(resumedWork.action.action, 'nudge');
});

test('unchanged durable work parks before the global model-step ceiling', () => {
  const recovery = new RecoverySupervisor({ localLimit: 3, ladder: ['nudge', 'nudge'] });
  const unchangedWork = '2 unfinished task(s); goal active; work revision 10';
  assert.equal(recovery.continuation('unfinished_conversation_work', unchangedWork).progress, true);
  for (let count = 1; count < 6; count += 1) {
    const result = recovery.continuation('unfinished_conversation_work', unchangedWork);
    assert.equal(result.continue, true);
    assert.equal(result.count, count);
  }
  const terminal = recovery.continuation('unfinished_conversation_work', unchangedWork);
  assert.equal(terminal.continue, false);
  assert.equal(terminal.exhausted, true);
  assert.equal(terminal.count, 6);
});

test('successful tool work prevents nonconsecutive narration checkpoints from exhausting the turn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-cross-category-progress-'));
  for (let index = 0; index < 3; index += 1) {
    await writeFile(join(root, `evidence-${index}.txt`), `verified-${index}`, 'utf8');
  }
  let calls = 0;
  let engine;
  const provider = { async *stream() {
    calls += 1;
    if ([1, 2, 4, 6].includes(calls)) {
      yield { type: 'text', text: `Progress checkpoint ${calls}; more verified work remains.` };
      yield { type: 'terminal', finishReason: 'stop' };
      return;
    }
    if ([3, 5, 7].includes(calls)) {
      yield* toolCall(`progress-${calls}`, `evidence-${Math.floor(calls / 2) - 1}.txt`);
      return;
    }
    await engine.updateTask('T1', 'completed', 'three distinct files verified');
    await engine.completeGoal('all evidence verified');
    yield { type: 'text', text: 'The verified audit is complete.' };
    yield { type: 'terminal', finishReason: 'stop' };
  } };
  engine = new SessionEngine({
    config: config(root, 'ephemeral', { recovery: { max_model_steps: 16 } }),
    providerFactory: () => provider,
  });
  await engine.initialize();
  await engine.setGoal('Verify all evidence files');
  await engine.addTask('Read each evidence file');

  const result = await engine.submit({ request_id: 'cross-category-progress', content: 'Run the audit.' }, 'operator');

  assert.equal(result.outcome, 'completed');
  assert.equal(calls, 8);
  const workRecovery = result.recovery.filter((item) => item.category === 'unfinished_conversation_work');
  assert.deepEqual(workRecovery.map((item) => item.action), ['retry_continuation', 'nudge', 'nudge', 'nudge']);
  assert.deepEqual(workRecovery.map((item) => item.count), [1, 1, 1, 1]);
});

test('unchanged unfinished work receives escalating guidance instead of premature termination', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-patient-supervision-'));
  let calls = 0;
  let engine;
  const provider = { async *stream() {
    calls += 1;
    if (calls <= 5) {
      yield { type: 'text', text: 'The implementation still needs verification, so I will continue now.' };
    } else {
      await engine.updateTask('T1', 'completed', 'verification completed');
      await engine.completeGoal('implementation verified');
      yield { type: 'text', text: 'The implementation and verification are complete.' };
    }
    yield { type: 'terminal', finishReason: 'stop' };
  } };
  engine = new SessionEngine({
    config: config(root, 'ephemeral', { recovery: { max_model_steps: 16 } }),
    providerFactory: () => provider,
  });
  await engine.initialize();
  await engine.setGoal('Implement and verify the change');
  await engine.addTask('Complete verification');

  const result = await engine.submit({ request_id: 'patient-supervision', content: 'Please proceed.' }, 'operator');

  assert.equal(result.outcome, 'completed');
  assert.equal(calls, 6);
  assert.deepEqual(result.recovery.map((item) => item.action), [
    'retry_continuation', 'nudge', 'nudge', 'reassess', 'change_strategy',
  ]);
});

function toolCall(id, path) {
  return [
    { type: 'tool_fragment', fragments: [{
      index: 0, id, function: { name: 'fs.read_text', arguments: JSON.stringify({ path }) },
    }] },
    { type: 'terminal', finishReason: 'tool_calls' },
  ];
}

test('interactive context usage refreshes after every settled model step', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-context-usage-'));
  await writeFile(join(root, 'target.txt'), 'verified evidence', 'utf8');
  let count = 0;
  const provider = { async *stream() {
    count += 1;
    if (count === 1) {
      yield* toolCall('context-read', 'target.txt');
      return;
    }
    yield { type: 'text', text: 'The target was verified.' };
    yield { type: 'terminal', finishReason: 'stop' };
  } };
  const output = [];
  const engine = new SessionEngine({
    config: config(root), surface: 'interactive_tui', providerFactory: () => provider,
    modelRuntime: { resolve: async () => ({
      contextWindowTokens: 65_536, outputLimitTokens: 4_096, source: 'fixture',
    }) },
    output: async (record) => output.push(record),
  });
  await engine.initialize();
  const result = await engine.submit({ request_id: 'context-usage', content: 'Read target.txt.' }, 'operator');
  assert.equal(result.outcome, 'completed');
  const usage = output.filter((record) => record.type === 'context_usage');
  assert.equal(usage.length, 2);
  assert.equal(usage.every((record) => Number.isFinite(record.current_bytes)), true);
  assert.equal(usage.every((record) => Number.isFinite(record.current_estimated_tokens)), true);
  assert.equal(usage.every((record) => record.limit_tokens > 0), true);
  assert.ok(usage[1].current_estimated_tokens >= usage[0].current_estimated_tokens);
});

test('AC-FAIL-04/AC-TOOL-05 accepted cancellation wins over late provider success', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-cancel-'));
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  const provider = { async *stream(_request, signal) {
    started();
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    yield { type: 'text', text: 'late success' };
    yield { type: 'terminal' };
  } };
  const output = [];
  const engine = new SessionEngine({
    config: config(root), providerFactory: () => provider,
    output: async (record) => output.push(record),
  });
  await engine.initialize();
  const turn = engine.submit({ request_id: 'cancel-turn', content: 'Wait' }, 'operator');
  await ready;
  const first = await engine.cancel({ request_id: 'cancel-1' });
  const second = await engine.cancel({ request_id: 'cancel-2' });
  const result = await turn;
  assert.equal(first.accepted, true);
  assert.equal(second.accepted, true);
  assert.equal(result.outcome, 'cancelled');
  assert.equal(output.filter((item) => item.type === 'stream_delta').length, 0);
  assert.equal(output.filter((item) => item.type === 'turn_result').length, 1);
});

test('AC-PROV-05 transient failures retry same step with distinct attempts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-retry-'));
  let count = 0;
  const provider = { async *stream() {
    count += 1;
    if (count < 3) throw new ContractError('provider_transient', 'temporary', true);
    yield { type: 'text', text: 'Recovered.' };
    yield { type: 'terminal' };
  } };
  const engine = new SessionEngine({ config: config(root), providerFactory: () => provider });
  await engine.initialize();
  const result = await engine.submit({ request_id: 'retry-turn', content: 'Recover' }, 'operator');
  assert.equal(result.outcome, 'completed');
  assert.equal(count, 3);
  const attempts = engine.lifecycles.snapshot().filter((item) => item.kind === 'provider_attempt');
  assert.deepEqual(attempts.map((item) => item.outcome), ['failed', 'failed', 'completed']);
  assert.equal(result.recovery.length, 2);
});

test('AC-PROV-02 reasoning is typed and counted without entering transcript or output text', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-reasoning-private-'));
  const secretReasoning = 'private model reasoning must not persist';
  const provider = { async *stream() {
    yield { type: 'reasoning', text: secretReasoning };
    yield { type: 'text', text: 'Public answer.' };
    yield { type: 'terminal', finishReason: 'stop' };
  } };
  const output = [];
  const engine = new SessionEngine({
    config: config(root), providerFactory: () => provider, output: async (record) => output.push(record),
    surface: 'interactive_tui',
  });
  await engine.initialize();
  const result = await engine.submit({ request_id: 'reasoning-private', content: 'Answer' }, 'operator');
  assert.equal(result.outcome, 'completed');
  assert.equal(result.reasoning_bytes, Buffer.byteLength(secretReasoning));
  assert.equal(JSON.stringify(engine.transcript).includes(secretReasoning), false);
  assert.equal(JSON.stringify(output).includes(secretReasoning), false);
  assert.equal(output.some((item) => item.type === 'state_status' && item.semantic_state === 'reasoning'), true);
});

test('tool continuations retain native reasoning with a bounded output allowance', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-opening-action-thinking-'));
  await writeFile(join(root, 'target.txt'), 'verified evidence', 'utf8');
  const requests = [];
  const provider = { async *stream(request) {
    requests.push(request);
    if (requests.length === 1) {
      yield* toolCall('opening-action-read', 'target.txt');
      return;
    }
    yield { type: 'text', text: 'The build can now continue from verified evidence.' };
    yield { type: 'terminal', finishReason: 'stop' };
  } };
  const engine = new SessionEngine({ config: config(root), providerFactory: () => provider });
  await engine.initialize();
  const result = await engine.submit({ request_id: 'opening-action-thinking', content: 'Build the project after reading target.txt.' }, 'operator');
  assert.equal(result.outcome, 'completed');
  assert.deepEqual(requests.map((request) => request.reasoningMode), [undefined, undefined]);
  assert.equal(requests[1].maxOutputTokens, 32_000);
});

test('read-only analytical turns retain configured opening-step reasoning', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-opening-analysis-thinking-'));
  const requests = [];
  const provider = { async *stream(request) {
    requests.push(request);
    yield { type: 'text', text: 'Analysis complete.' };
    yield { type: 'terminal', finishReason: 'stop' };
  } };
  const engine = new SessionEngine({ config: config(root), providerFactory: () => provider });
  await engine.initialize();
  const result = await engine.submit({ request_id: 'opening-analysis-thinking', content: 'Inspect and explain the repository structure.' }, 'operator');
  assert.equal(result.outcome, 'completed');
  assert.equal(requests[0].reasoningMode, undefined);
});

test('reasoning-only output receives one reasoning-preserving checkpoint retry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-reasoning-empty-'));
  const requests = [];
  const provider = { async *stream(request) {
    requests.push(request);
    if (requests.length === 1) {
      yield { type: 'reasoning', text: 'hidden reasoning without a final answer' };
      yield { type: 'terminal', finishReason: 'stop' };
      return;
    }
    yield { type: 'text', text: 'Visible answer after the bounded fallback.' };
    yield { type: 'terminal', finishReason: 'stop' };
  } };
  const engine = new SessionEngine({ config: config(root), providerFactory: () => provider });
  await engine.initialize();
  const result = await engine.submit({ request_id: 'reasoning-empty', content: 'Answer visibly.' }, 'operator');
  assert.equal(result.outcome, 'completed');
  assert.equal(requests.length, 2);
  assert.equal(requests[0].reasoningMode, undefined);
  assert.equal(requests[1].reasoningMode, undefined);
  assert.equal(requests[1].messages.find((message) => message.reasoning_content)?.reasoning_content,
    'hidden reasoning without a final answer');
  assert.equal(result.text, 'Visible answer after the bounded fallback.');
  assert.deepEqual(result.recovery.map((item) => item.action), ['retry_reasoning_to_action']);
});

test('reasoning truncated at the output ceiling gets one reasoning-preserving action retry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-reasoning-truncated-'));
  const requests = [];
  const provider = { async *stream(request) {
    requests.push(request);
    if (requests.length === 1) {
      yield { type: 'reasoning', text: 'long but potentially useful reasoning' };
      yield { type: 'terminal', finishReason: 'length' };
      return;
    }
    yield { type: 'text', text: 'Visible action after the bounded reasoning retry.' };
    yield { type: 'terminal', finishReason: 'stop' };
  } };
  const engine = new SessionEngine({ config: config(root), providerFactory: () => provider });
  await engine.initialize();
  const result = await engine.submit({ request_id: 'reasoning-truncated', content: 'Act after reasoning.' }, 'operator');
  assert.equal(result.outcome, 'completed');
  assert.deepEqual(requests.map((request) => request.reasoningMode), [undefined, undefined]);
  assert.equal(requests.every((request) => request.maxOutputTokens === 32_000), true);
  assert.deepEqual(result.recovery.map((item) => item.action), ['retry_reasoning_to_action']);
});

test('reasoning checkpoint retry occurs once before non-terminal empty-completion recovery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-reasoning-empty-bounded-'));
  const modes = [];
  const provider = { async *stream(request) {
    modes.push(request.reasoningMode);
    if (modes.length === 1) yield { type: 'reasoning', text: 'hidden only' };
    if (modes.length > 4) yield { type: 'text', text: 'Visible answer after operator guidance.' };
    yield { type: 'terminal', finishReason: 'stop' };
  } };
  const engine = new SessionEngine({ config: config(root), providerFactory: () => provider });
  await engine.initialize();
  const result = await engine.submit({ request_id: 'reasoning-empty-bounded', content: 'Answer visibly.' }, 'operator');
  assert.equal(result.outcome, 'completed');
  assert.deepEqual(modes, [undefined, undefined, undefined, undefined, undefined]);
  assert.equal(engine.state.transitions.some((item) => item.to === 'awaiting_attention'), false);
  assert.deepEqual(result.recovery.map((item) => item.action), [
    'retry_reasoning_to_action', 'retry_provider_completion',
    'retry_provider_completion', 'retry_provider_completion',
  ]);
});

test('AC-FAIL-06 provider size rejection compacts once and never resends unchanged context', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-provider-overflow-'));
  const sizes = [];
  const provider = { async *stream(request) {
    sizes.push(Buffer.byteLength(JSON.stringify(request.messages)));
    if (sizes.length === 1) throw new ContractError('provider_context_limit', 'too large');
    yield { type: 'text', text: 'Recovered after provider-directed compaction.' };
    yield { type: 'terminal', finishReason: 'stop' };
  } };
  const engine = new SessionEngine({ config: config(root), providerFactory: () => provider });
  await engine.initialize();
  for (let index = 0; index < 200; index += 1) {
    engine.transcript.push({ type: 'message', role: 'assistant', content: `${index}:${'x'.repeat(2000)}`, trust: 'model' });
  }
  const result = await engine.submit({ request_id: 'provider-overflow', content: 'Continue' }, 'operator');
  assert.equal(result.outcome, 'completed');
  assert.equal(sizes.length, 2);
  assert.ok(sizes[1] < sizes[0]);
  const recovery = result.recovery.filter((item) => item.action === 'compact_context_limit');
  assert.equal(recovery.length, 1);
  assert.equal(recovery[0].scale, 0.75);
});

test('provider overflow pressure scaling uses advertised parallel capacity only after rejection', () => {
  assert.equal(contextPressureScale({ parallelCapacity: 1 }), 0.75);
  assert.equal(contextPressureScale({ parallelCapacity: 2 }), 0.5);
  assert.equal(contextPressureScale({ parallelCapacity: 4 }), 0.25);
  assert.equal(contextPressureScale({ parallelCapacity: 16 }), 0.125);
});

test('AC-FAIL-06 repeated provider size rejection stops when no smaller request evidence exists', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-provider-overflow-stop-'));
  let calls = 0;
  const provider = { async *stream() {
    calls += 1;
    throw new ContractError('provider_context_limit', 'still too large');
  } };
  const engine = new SessionEngine({ config: config(root), providerFactory: () => provider });
  await engine.initialize();
  const result = await engine.submit({ request_id: 'provider-overflow-stop', content: 'Continue' }, 'operator');
  assert.equal(result.outcome, 'failed');
  assert.equal(result.failure.code, 'provider_context_limit');
  assert.equal(calls, 2);
});

test('AC-FAIL-06 a second provider size recovery requires and produces a smaller request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-provider-overflow-twice-'));
  const sizes = [];
  const provider = { async *stream(request) {
    sizes.push(Buffer.byteLength(JSON.stringify(request.messages)));
    if (sizes.length < 3) throw new ContractError('provider_context_limit', 'still too large');
    yield { type: 'text', text: 'Recovered after a second evidence-gated compaction.' };
    yield { type: 'terminal', finishReason: 'stop' };
  } };
  const engine = new SessionEngine({ config: config(root), providerFactory: () => provider });
  await engine.initialize();
  for (let index = 0; index < 200; index += 1) {
    engine.transcript.push({
      type: 'message', role: 'assistant', content: `${index}:${'文'.repeat(2_000)}`, trust: 'model',
    });
  }
  const result = await engine.submit({ request_id: 'provider-overflow-twice', content: 'Continue' }, 'operator');
  assert.equal(result.outcome, 'completed');
  assert.equal(sizes.length, 3);
  assert.ok(sizes[1] < sizes[0]);
  assert.ok(sizes[2] < sizes[1]);
  const recovery = result.recovery.filter((item) => item.action === 'compact_context_limit');
  assert.deepEqual(recovery.map((item) => item.scale), [0.75, 0.375]);
  assert.ok(recovery[1].estimated_input_tokens < recovery[1].previous_estimated_input_tokens);
});

test('AC-FAIL-02 idle deadline is distinct and cancels a partial stalled stream', async () => {
  const state = new StateAuthority();
  state.transition('preparing_turn', { trigger: 'test', turnId: 'turn-timeout' });
  const lifecycles = new LifecycleRegistry();
  const turn = lifecycles.start('turn');
  const step = lifecycles.start('model_step', turn.id);
  let observedAbort = false;
  const provider = { async *stream(_request, signal) {
    yield { type: 'text', text: 'partial' };
    await new Promise((resolve) => signal.addEventListener('abort', () => {
      observedAbort = true;
      resolve();
    }, { once: true }));
  } };
  const active = {
    turnId: 'turn-timeout', stepId: step.id, attemptId: null,
    controller: new AbortController(), cancelled: false,
    stepText: '', toolAssembler: new ToolCallAssembler(),
    providerTerminal: false, recovery: new RecoverySupervisor(),
  };
  const runner = new ProviderRunner({
    state, lifecycles, publish: async () => undefined,
    acceptText: async (text) => { active.stepText += text; },
    settleAttempt: async () => undefined, recordRecovery: async () => undefined,
  });
  await assert.rejects(
    runner.run(provider, {}, { overallMs: 1000, firstTokenMs: 50, idleMs: 5 }, active),
    { code: 'provider_idle_timeout' },
  );
  assert.equal(observedAbort, true);
  assert.equal(active.stepText, 'partial');
});

test('reasoning chunks count as provider activity throughout a long productive generation', async () => {
  const state = new StateAuthority();
  state.transition('preparing_turn', { trigger: 'test', turnId: 'turn-reasoning-activity' });
  const lifecycles = new LifecycleRegistry();
  const turn = lifecycles.start('turn');
  const step = lifecycles.start('model_step', turn.id);
  const active = {
    turnId: 'turn-reasoning-activity', stepId: step.id, attemptId: null,
    controller: new AbortController(), cancelled: false, stepText: '',
    toolAssembler: new ToolCallAssembler(), providerTerminal: false,
    recovery: new RecoverySupervisor(), reasoningBytes: 0, stepReasoningBytes: 0,
    usage: null, finishReason: null,
  };
  const runner = new ProviderRunner({
    state, lifecycles, publish: async () => undefined,
    acceptText: async (text) => { active.stepText += text; },
    settleAttempt: async () => undefined, recordRecovery: async () => undefined,
  });
  const provider = { async *stream() {
    for (let index = 0; index < 6; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 4));
      yield { type: 'reasoning', text: `private-${index}` };
    }
    yield { type: 'text', text: 'completed' };
    yield { type: 'terminal', finishReason: 'stop' };
  } };

  await runner.run(provider, {}, { overallMs: 250, firstTokenMs: 20, idleMs: 10 }, active);
  assert.equal(active.stepText, 'completed');
  assert.ok(active.reasoningBytes > 0);
});

test('provider streaming stops after a second complete equivalent tool call', async () => {
  const state = new StateAuthority();
  state.transition('preparing_turn', { trigger: 'test', turnId: 'turn-duplicate-stream' });
  const lifecycles = new LifecycleRegistry();
  const turn = lifecycles.start('turn');
  const step = lifecycles.start('model_step', turn.id);
  const active = {
    turnId: 'turn-duplicate-stream', stepId: step.id, attemptId: null,
    controller: new AbortController(), cancelled: false, stepText: '',
    toolAssembler: new ToolCallAssembler(), providerTerminal: false,
    recovery: new RecoverySupervisor(), reasoningBytes: 0, stepReasoningBytes: 0,
    usage: null, finishReason: null,
  };
  const telemetry = [];
  const runner = new ProviderRunner({
    state, lifecycles, publish: async () => undefined,
    acceptText: async (text) => { active.stepText += text; },
    settleAttempt: async () => undefined, recordRecovery: async () => undefined,
    telemetry: { record: (name, outcome, detail) => telemetry.push({ name, outcome, detail }) },
  });
  const provider = { async *stream() {
    yield { type: 'tool_fragment', fragments: [{
      index: 0, id: 'duplicate-0', function: { name: 'fs.write_text', arguments: '{"path":"capture.mjs","content":"same"}' },
    }] };
    yield { type: 'tool_fragment', fragments: [{
      index: 1, id: 'duplicate-1', function: { name: 'fs.write_text', arguments: '{"content":"same","path":"capture.mjs"}' },
    }] };
    yield { type: 'text', text: 'must not be consumed' };
    yield { type: 'terminal', finishReason: 'stop' };
  } };
  await runner.run(provider, {}, { overallMs: null, firstTokenMs: 50, idleMs: 50 }, active);
  assert.equal(active.stepText, '');
  assert.equal(active.providerTerminal, true);
  assert.equal(active.finishReason, 'tool_calls');
  assert.equal(active.toolAssembler.hasEquivalentCompleteCalls, true);
  assert.ok(telemetry.some((item) => item.name === 'provider.tool_stream'
    && item.detail.reason === 'equivalent_complete_tool_call'));
});

test('provider retries tool identity drift before any assembled call can execute', async () => {
  const state = new StateAuthority();
  state.transition('preparing_turn', { trigger: 'test', turnId: 'turn-identity-drift' });
  const lifecycles = new LifecycleRegistry();
  const turn = lifecycles.start('turn');
  const step = lifecycles.start('model_step', turn.id);
  const active = {
    turnId: 'turn-identity-drift', stepId: step.id, attemptId: null,
    controller: new AbortController(), cancelled: false, stepText: '',
    toolAssembler: new ToolCallAssembler(), providerTerminal: false,
    recovery: new RecoverySupervisor(), reasoningBytes: 0, stepReasoningBytes: 0,
    usage: null, finishReason: null,
  };
  let attempts = 0; let settlements = 0; const recoveries = [];
  const runner = new ProviderRunner({
    state, lifecycles, publish: async () => undefined,
    acceptText: async (text) => { active.stepText += text; },
    settleAttempt: async () => { settlements += 1; },
    recordRecovery: async (action) => recoveries.push(action),
  });
  const provider = { async *stream() {
    attempts += 1;
    if (attempts === 1) {
      yield { type: 'tool_fragment', fragments: [{
        index: 0, id: 'drift-a', function: { name: 'fs.read', arguments: '{"path":' },
      }] };
      yield { type: 'tool_fragment', fragments: [{
        index: 0, id: 'drift-b', function: { name: '', arguments: '"README.md"}' },
      }] };
      return;
    }
    yield { type: 'tool_fragment', fragments: [{
      index: 0, id: 'stable-call', function: { name: 'fs.read', arguments: '{"path":"README.md"}' },
    }] };
    yield { type: 'terminal', finishReason: 'tool_calls' };
  } };

  await runner.run(provider, {}, { overallMs: null, firstTokenMs: 50, idleMs: 50 }, active);

  assert.equal(attempts, 2);
  assert.equal(settlements, 1);
  assert.equal(recoveries[0].category, 'tool_identity_drift');
  assert.equal(active.toolAssembler.size, 1);
  assert.equal(active.toolAssembler.complete()[0].providerCallId, 'stable-call');
});

test('an unset overall route deadline does not create an immediate timeout', async () => {
  const state = new StateAuthority();
  state.transition('preparing_turn', { trigger: 'test', turnId: 'turn-unbounded' });
  const lifecycles = new LifecycleRegistry();
  const turn = lifecycles.start('turn');
  const step = lifecycles.start('model_step', turn.id);
  const active = {
    turnId: 'turn-unbounded', stepId: step.id, attemptId: null,
    controller: new AbortController(), cancelled: false, stepText: '',
    toolAssembler: new ToolCallAssembler(), providerTerminal: false,
    recovery: new RecoverySupervisor(), reasoningBytes: 0, stepReasoningBytes: 0,
    usage: null, finishReason: null,
  };
  const runner = new ProviderRunner({
    state, lifecycles, publish: async () => undefined,
    acceptText: async (text) => { active.stepText += text; },
    settleAttempt: async () => undefined, recordRecovery: async () => undefined,
  });
  const provider = { async *stream() {
    await new Promise((resolve) => setTimeout(resolve, 10));
    yield { type: 'text', text: 'completed' };
    yield { type: 'terminal', finishReason: 'stop' };
  } };
  await runner.run(provider, {}, { overallMs: null, firstTokenMs: 50, idleMs: 50 }, active);
  assert.equal(active.stepText, 'completed');
});

test('successful trusted-local health probes renew the default silent-stream lease', async () => {
  const state = new StateAuthority();
  state.transition('preparing_turn', { trigger: 'test', turnId: 'turn-health-probe' });
  const lifecycles = new LifecycleRegistry();
  const turn = lifecycles.start('turn');
  const step = lifecycles.start('model_step', turn.id);
  const active = {
    turnId: 'turn-health-probe', stepId: step.id, attemptId: null,
    controller: new AbortController(), cancelled: false, stepText: '',
    toolAssembler: new ToolCallAssembler(), providerTerminal: false,
    recovery: new RecoverySupervisor(), reasoningBytes: 0, stepReasoningBytes: 0,
    usage: null, finishReason: null, providerResource: 'local', modelName: 'slow-model',
  };
  const events = [];
  let probes = 0;
  const runner = new ProviderRunner({
    state, lifecycles, publish: async () => undefined,
    acceptText: async (text) => { active.stepText += text; },
    settleAttempt: async () => undefined, recordRecovery: async () => undefined,
    healthProbeIntervalMs: 8, healthProbeTimeoutMs: 5,
    telemetry: { record: (name, outcome) => events.push([name, outcome]) },
  });
  const provider = {
    profile: { trustZone: 'loopback' },
    health: async () => { probes += 1; return true; },
    async *stream() {
      yield { type: 'text', text: 'working' };
      await new Promise((resolve) => setTimeout(resolve, 55));
      yield { type: 'text', text: 'completed' };
      yield { type: 'terminal', finishReason: 'stop' };
    },
  };
  await runner.run(provider, {}, {
    overallMs: 200, firstTokenMs: 20, idleMs: 20,
    renewFirstTokenOnHealth: true, renewIdleOnHealth: true,
  }, active);
  assert.equal(active.stepText, 'workingcompleted');
  assert.ok(probes >= 3);
  assert.ok(events.some(([name, outcome]) => name === 'provider.health' && outcome === 'succeeded'));
});

test('failed trusted-local health probes do not renew a silent-stream lease', async () => {
  const state = new StateAuthority();
  state.transition('preparing_turn', { trigger: 'test', turnId: 'turn-failed-health-probe' });
  const lifecycles = new LifecycleRegistry();
  const turn = lifecycles.start('turn');
  const step = lifecycles.start('model_step', turn.id);
  const active = {
    turnId: 'turn-failed-health-probe', stepId: step.id, attemptId: null,
    controller: new AbortController(), cancelled: false, stepText: '',
    toolAssembler: new ToolCallAssembler(), providerTerminal: false,
    recovery: new RecoverySupervisor(), reasoningBytes: 0, stepReasoningBytes: 0,
    usage: null, finishReason: null, providerResource: 'local', modelName: 'slow-model',
  };
  const runner = new ProviderRunner({
    state, lifecycles, publish: async () => undefined,
    acceptText: async (text) => { active.stepText += text; },
    settleAttempt: async () => undefined, recordRecovery: async () => undefined,
    healthProbeIntervalMs: 8, healthProbeTimeoutMs: 5,
  });
  const provider = {
    profile: { trustZone: 'loopback' },
    health: async () => { throw Object.assign(new Error('offline probe'), { code: 'ECONNREFUSED' }); },
    async *stream() {
      yield { type: 'text', text: 'working' };
      await new Promise((resolve) => setTimeout(resolve, 55));
      yield { type: 'text', text: 'late' };
    },
  };
  await assert.rejects(runner.run(provider, {}, {
    overallMs: 200, firstTokenMs: 20, idleMs: 20,
    renewFirstTokenOnHealth: true, renewIdleOnHealth: true,
  }, active), { code: 'provider_idle_timeout' });
  assert.equal(active.stepText, 'working');
});

test('explicit trusted-local idle deadlines are not renewed by successful health probes', async () => {
  const state = new StateAuthority();
  state.transition('preparing_turn', { trigger: 'test', turnId: 'turn-explicit-idle' });
  const lifecycles = new LifecycleRegistry();
  const turn = lifecycles.start('turn');
  const step = lifecycles.start('model_step', turn.id);
  const active = {
    turnId: 'turn-explicit-idle', stepId: step.id, attemptId: null,
    controller: new AbortController(), cancelled: false, stepText: '',
    toolAssembler: new ToolCallAssembler(), providerTerminal: false,
    recovery: new RecoverySupervisor(), reasoningBytes: 0, stepReasoningBytes: 0,
    usage: null, finishReason: null, providerResource: 'local', modelName: 'slow-model',
  };
  const runner = new ProviderRunner({
    state, lifecycles, publish: async () => undefined,
    acceptText: async (text) => { active.stepText += text; },
    settleAttempt: async () => undefined, recordRecovery: async () => undefined,
    healthProbeIntervalMs: 8, healthProbeTimeoutMs: 5,
  });
  const provider = {
    profile: { trustZone: 'loopback' }, health: async () => true,
    async *stream() {
      yield { type: 'text', text: 'working' };
      await new Promise((resolve) => setTimeout(resolve, 55));
      yield { type: 'text', text: 'late' };
    },
  };
  await assert.rejects(runner.run(provider, {}, {
    overallMs: 200, firstTokenMs: 20, idleMs: 20,
    renewFirstTokenOnHealth: false, renewIdleOnHealth: false,
  }, active), { code: 'provider_idle_timeout' });
  assert.equal(active.stepText, 'working');
});

test('provider cache observation is scoped to the successful transport attempt', async () => {
  const state = new StateAuthority();
  state.transition('preparing_turn', { trigger: 'test', turnId: 'turn-cache-usage' });
  const lifecycles = new LifecycleRegistry();
  const turn = lifecycles.start('turn');
  const step = lifecycles.start('model_step', turn.id);
  const active = {
    turnId: 'turn-cache-usage', stepId: step.id, attemptId: null,
    controller: new AbortController(), cancelled: false, stepText: '',
    toolAssembler: new ToolCallAssembler(), providerTerminal: false,
    recovery: new RecoverySupervisor(), reasoningBytes: 0, stepReasoningBytes: 0,
    usage: { prompt_cache_hit_tokens: 1024 }, finishReason: null,
    providerResource: 'fallback', modelName: 'qwen', sessionId: 'session-cache-usage',
  };
  let observed;
  const runner = new ProviderRunner({
    state, lifecycles, publish: async () => undefined,
    acceptText: async (text) => { active.stepText += text; },
    settleAttempt: async () => undefined, recordRecovery: async () => undefined,
    reliability: {
      localRetryLimit: () => 1,
      observeProviderUsage: (_route, usage) => { observed = usage; },
    },
  });
  const provider = { async *stream() {
    yield { type: 'text', text: 'completed' };
    yield { type: 'terminal', finishReason: 'stop', usage: { prompt_cache_hit_tokens: 0 } };
  } };

  await runner.run(provider, {}, { overallMs: null, firstTokenMs: 50, idleMs: 50 }, active);
  assert.deepEqual(observed, { prompt_cache_hit_tokens: 0 });
  assert.deepEqual(active.usage, { prompt_cache_hit_tokens: 1024 });
});

test('content-free completions wait, change the recovery request, and preserve the turn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-empty-'));
  let count = 0;
  let healthChecks = 0;
  const requests = [];
  const provider = { profile: { trustZone: 'loopback' }, async health() { healthChecks += 1; return true; }, async *stream(request) {
    requests.push(request);
    count += 1;
    if (count > 3) yield { type: 'text', text: 'Completed after provider recovery.' };
    yield { type: 'terminal' };
  } };
  const output = [];
  const engine = new SessionEngine({
    config: config(root), providerFactory: () => provider,
    output: async (record) => output.push(record),
  });
  await engine.initialize();
  const result = await engine.submit({ request_id: 'empty-turn', content: 'Produce output' }, 'operator');
  assert.equal(result.outcome, 'completed');
  assert.equal(count, 4);
  assert.equal(healthChecks, 3);
  assert.equal(result.recovery.length, 3);
  assert.equal(output.some((record) => record.delta_type === 'recovery_attention'), false);
  const systemMessages = requests.slice(1).map((request) => request.messages[0].content);
  assert.equal(new Set(systemMessages).size, systemMessages.length);
  assert.match(systemMessages[0], /Provider recovery attempt 1/u);
});

test('content-free completion uses an eligible fallback route before waiting', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-empty-route-fallback-'));
  const calls = [];
  const providers = {
    primary: { async *stream() { calls.push('primary'); yield { type: 'terminal', finishReason: 'stop' }; } },
    fallback: { async *stream() {
      calls.push('fallback');
      yield { type: 'text', text: 'Completed on the fallback route.' };
      yield { type: 'terminal', finishReason: 'stop' };
    } },
  };
  const manifest = resolveManifest({
    persistence: 'ephemeral', workspace_root: root,
    providers: [
      { id: 'primary', endpoint: 'http://127.0.0.1:9001/v1', model: 'primary-model', trust_zone: 'loopback', capabilities: { tools: true } },
      { id: 'fallback', endpoint: 'http://127.0.0.1:9002/v1', model: 'fallback-model', trust_zone: 'loopback', capabilities: { tools: true } },
    ],
    routes: {
      primary: { provider_id: 'primary', fallbacks: ['subagent'], budget: 2 },
      subagent: { provider_id: 'fallback' },
    },
  });
  const engine = new SessionEngine({ config: manifest, providerFactory: (profile) => providers[profile.id] });
  await engine.initialize();
  const result = await engine.submit({ request_id: 'empty-fallback-turn', content: 'Complete the request.' }, 'operator');
  assert.equal(result.outcome, 'completed');
  assert.deepEqual(calls, ['primary', 'fallback']);
  assert.equal(engine.state.transitions.some((item) => item.trigger === 'empty_route_fallback'), true);
});

test('authenticated steering wakes an empty-completion wait and resets its episode', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-empty-steering-'));
  const requests = [];
  const provider = { async *stream(request) {
    requests.push(request);
    if (requests.length > 1) yield { type: 'text', text: 'Continued with the new direction.' };
    yield { type: 'terminal', finishReason: 'stop' };
  } };
  const engine = new SessionEngine({ config: config(root), providerFactory: () => provider });
  await engine.initialize();
  const operation = engine.submit({ request_id: 'empty-steering-turn', content: 'Start the request.' }, 'operator');
  await waitForEngineState(engine, 'recovering');
  await engine.steer({ request_id: 'empty-steering', content: 'Use this additional constraint.' }, 'operator');
  const result = await operation;
  assert.equal(result.outcome, 'completed');
  assert.equal(requests.length, 2);
  assert.equal(requests[1].messages.some((message) => message.role === 'user'
    && message.content === 'Use this additional constraint.'), true);
  assert.equal(result.recovery.filter((item) => item.action === 'retry_provider_completion').length, 1);
});

test('operator cancellation wakes an empty-completion recovery wait immediately', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-attention-cancel-'));
  const provider = { async *stream() { yield { type: 'terminal' }; } };
  const engine = new SessionEngine({ config: config(root), providerFactory: () => provider });
  await engine.initialize();
  const operation = engine.submit({ request_id: 'attention-cancel-turn', content: 'Produce output' }, 'operator');
  await waitForEngineState(engine, 'recovering');
  await engine.cancel({ request_id: 'attention-cancel' });
  const result = await operation;
  assert.equal(result.outcome, 'cancelled');
  assert.equal(engine.state.state, 'idle');
  assert.equal(engine.active, null);
});

test('empty continuation recovery preserves a useful committed checkpoint', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-empty-partial-'));
  await writeFile(join(root, 'target.txt'), 'verified evidence', 'utf8');
  let count = 0;
  const checkpoint = 'Verified checkpoint: the requested target was read successfully. The remaining step is to explain the result to the operator with the evidence already collected.';
  const provider = { async *stream() {
    count += 1;
    if (count === 1) {
      yield { type: 'text', text: checkpoint };
      yield* toolCall('partial-handoff-read', 'target.txt');
      return;
    }
    if (count > 4) yield { type: 'text', text: 'Explanation completed after operator direction.' };
    yield { type: 'terminal' };
  } };
  const output = [];
  const engine = new SessionEngine({
    config: config(root), providerFactory: () => provider,
    output: async (record) => output.push(record),
  });
  await engine.initialize();
  const result = await engine.submit({ request_id: 'empty-partial-turn', content: 'Read and explain target.txt.' }, 'operator');
  assert.equal(result.outcome, 'completed');
  assert.equal(count, 5);
  assert.equal(output.filter((record) => record.type === 'turn_result').length, 1);
  assert.equal(output.some((record) => record.delta_type === 'recovery_attention'), false);
  assert.ok(engine.transcript.some((record) => record.role === 'assistant' && record.content === checkpoint));
});

test('AC-PROD-03 malformed small-model tool arguments become an in-band repair opportunity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-malformed-repair-'));
  await writeFile(join(root, 'target.txt'), 'verified', 'utf8');
  let count = 0;
  const provider = { async *stream(request) {
    count += 1;
    if (count === 1) {
      yield { type: 'tool_fragment', fragments: [{
        index: 0, id: 'malformed-call', function: { name: 'fs.read_text', arguments: '{"path":' },
      }] };
      yield { type: 'terminal' };
      return;
    }
    if (count === 2) {
      const failure = request.messages.find((item) => item.role === 'tool' && item.tool_call_id === 'malformed-call');
      assert.match(failure.content, /tool_arguments_malformed/u);
      yield* toolCall('corrected-call', 'target.txt');
      return;
    }
    yield { type: 'text', text: 'The corrected read verified the target.' };
    yield { type: 'terminal', finishReason: 'stop' };
  } };
  const engine = new SessionEngine({ config: config(root), providerFactory: () => provider });
  await engine.initialize();
  const result = await engine.submit({ request_id: 'malformed-repair', content: 'Inspect the requested file.' }, 'operator');
  assert.equal(result.outcome, 'completed');
  assert.equal(count, 3);
  const invalid = engine.transcript.find((item) => item.type === 'tool_result');
  assert.equal(invalid.toolLifecycleStatus, 'invalid_request');
  assert.equal(invalid.reasonCode, 'tool_arguments_malformed');
});

test('output-truncated tool arguments enable one bounded reasoning-off action repair', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-truncated-action-repair-'));
  await writeFile(join(root, 'target.txt'), 'verified', 'utf8');
  const requests = [];
  const provider = { async *stream(request) {
    requests.push(request);
    if (requests.length === 1) {
      yield { type: 'tool_fragment', fragments: [{
        index: 0, id: 'truncated-call', function: { name: 'fs.read_text', arguments: '{"path":' },
      }] };
      yield { type: 'usage', usage: { completion_tokens: 32_000, total_tokens: 32_100 } };
      yield { type: 'terminal', finishReason: 'tool_calls' };
      return;
    }
    if (requests.length === 2) {
      assert.equal(request.reasoningMode, 'off');
      assert.equal(request.maxOutputTokens, 16_000);
      yield* toolCall('corrected-call', 'target.txt');
      return;
    }
    assert.equal(request.reasoningMode, undefined);
    yield { type: 'text', text: 'The corrected read verified the target.' };
    yield { type: 'terminal', finishReason: 'stop' };
  } };
  const engine = new SessionEngine({ config: config(root), providerFactory: () => provider });
  await engine.initialize();
  const result = await engine.submit({ request_id: 'truncated-action-repair', content: 'Inspect the requested file.' }, 'operator');
  assert.equal(result.outcome, 'completed');
  assert.equal(requests.length, 3);
  const repair = engine.active?.toolConstraints?.find((item) => item.kind === 'action_repair');
  assert.equal(repair, undefined);
  assert.equal(engine.transcript.some((item) => item.reasonCode === 'tool_arguments_truncated'), true);
});

test('AC-PROD-03/AC-TURN-10 truncated useful output is preserved and continued', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-truncated-output-'));
  let count = 0;
  const provider = { async *stream(request) {
    count += 1;
    if (count === 1) {
      yield { type: 'text', text: 'Useful partial analysis: ' };
      yield { type: 'metadata', finishReason: 'length' };
      yield { type: 'terminal' };
      return;
    }
    assert.ok(request.messages.some((item) => item.role === 'assistant' && item.content === 'Useful partial analysis: '));
    yield { type: 'text', text: 'analysis completed.' };
    yield { type: 'terminal', finishReason: 'stop' };
  } };
  const engine = new SessionEngine({ config: config(root), providerFactory: () => provider });
  await engine.initialize();
  const result = await engine.submit({ request_id: 'truncated-turn', content: 'Analyze this.' }, 'operator');
  assert.equal(result.outcome, 'completed');
  assert.equal(count, 2);
  assert.equal(engine.transcript.some((item) => item.role === 'assistant' && item.partial === true), true);
  assert.equal(result.recovery[0].action, 'retry_continuation');
});

test('a provider-mislabeled output ceiling cannot complete on a future-action pledge', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-mislabeled-ceiling-'));
  const requests = [];
  const provider = { async *stream(request) {
    requests.push(request);
    if (requests.length === 1) {
      yield { type: 'reasoning', text: 'A long internal plan that consumed the completion allowance.' };
      yield { type: 'text', text: 'Before writing the files, let me verify the exact API details.' };
      yield { type: 'usage', usage: { prompt_tokens: 100, completion_tokens: 32_000, total_tokens: 32_100 } };
      yield { type: 'terminal', finishReason: 'stop' };
      return;
    }
    assert.ok(request.messages.some((item) => item.role === 'assistant'
      && item.content === 'Before writing the files, let me verify the exact API details.'));
    yield { type: 'text', text: 'The requested implementation is complete and verified.' };
    yield { type: 'terminal', finishReason: 'stop' };
  } };
  const engine = new SessionEngine({ config: config(root), providerFactory: () => provider });
  await engine.initialize();
  const result = await engine.submit({ request_id: 'mislabeled-ceiling', content: 'Build the requested project.' }, 'operator');
  assert.equal(result.outcome, 'completed');
  assert.equal(requests.length, 2);
  assert.equal(engine.transcript.some((item) => item.partial === true
    && item.content === 'Before writing the files, let me verify the exact API details.'), true);
});

test('AC-PROD-03/AC-TURN-10 a completion claim cannot erase unresolved tool failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-premature-completion-'));
  await writeFile(join(root, 'target.txt'), 'available', 'utf8');
  let count = 0;
  const provider = { async *stream() {
    count += 1;
    if (count === 1) {
      yield { type: 'tool_fragment', fragments: [{
        index: 0, id: 'bad-path', function: { name: 'fs.read_text', arguments: '{"path":"missing.txt"}' },
      }] };
      yield { type: 'terminal', finishReason: 'tool_calls' };
      return;
    }
    if (count === 2) {
      yield { type: 'text', text: 'The task is complete.' };
      yield { type: 'terminal', finishReason: 'stop' };
      return;
    }
    if (count === 3) {
      yield* toolCall('good-path', 'target.txt');
      return;
    }
    yield { type: 'text', text: 'The verified read is complete.' };
    yield { type: 'terminal', finishReason: 'stop' };
  } };
  const engine = new SessionEngine({ config: config(root), providerFactory: () => provider });
  await engine.initialize();
  const result = await engine.submit({ request_id: 'premature-turn', content: 'Read target.txt.' }, 'operator');
  assert.equal(result.outcome, 'completed');
  assert.equal(count, 4);
  assert.equal(engine.transcript.some((item) => item.partial && item.content === 'The task is complete.'), true);
});

test('AC-PROD-03 unchanged malformed calls trigger a call boundary without parking the turn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-malformed-loop-'));
  let count = 0;
  const provider = { async *stream() {
    count += 1;
    if (count > 3) yield { type: 'text', text: 'Stopped the malformed call and completed safely.' };
    else yield { type: 'tool_fragment', fragments: [{
      index: 0, id: 'same-malformed-call', function: { name: 'fs.read_text', arguments: '{' },
    }] };
    yield { type: 'terminal' };
  } };
  const engine = new SessionEngine({ config: config(root), providerFactory: () => provider });
  await engine.initialize();
  const result = await engine.submit({ request_id: 'malformed-loop', content: 'Do not loop.' }, 'operator');
  assert.equal(result.outcome, 'completed');
  assert.equal(count, 4);
  assert.equal(engine.state.transitions.some((item) => item.to === 'awaiting_attention'), false);
  assert.equal(result.recovery.some((item) => item.action === 'block_exact_request'), true);
});

test('AC-FAIL-06 overflow compaction safely truncates an oversized historical message', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-compact-failure-'));
  let invoked = 0;
  const engine = new SessionEngine({
    config: config(root, 'ephemeral', { context_limit_bytes: 65_536 }),
    providerFactory: () => ({ async *stream() {
      invoked += 1; yield { type: 'text', text: 'Continued from the compacted checkpoint.' }; yield { type: 'terminal' };
    } }),
  });
  await engine.initialize();
  engine.transcript.push({
    type: 'message', role: 'user', content: 'x'.repeat(70_000), trust: 'operator', turnId: 'older-turn',
  });
  const result = await engine.submit({ request_id: 'compact-failure', content: 'Continue' }, 'operator');
  assert.equal(result.outcome, 'completed');
  assert.equal(invoked, 1);
  assert.equal(engine.state.transitions.filter((item) => item.to === 'compacting_context').length, 1);
});

test('AC-FAIL-13 distinct progressing tool steps continue beyond the legacy ceiling', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-horizon-'));
  for (let index = 0; index < 20; index += 1) {
    await writeFile(join(root, `item-${index}.txt`), `unique-${index}`, 'utf8');
  }
  let count = 0;
  const provider = { async *stream() {
    if (count < 20) {
      yield* toolCall(`call-${count}`, `item-${count}.txt`);
      count += 1;
      return;
    }
    yield { type: 'text', text: 'Long task completed.' };
    yield { type: 'terminal' };
    count += 1;
  } };
  const engine = new SessionEngine({
    config: config(root, 'ephemeral', { recovery: { max_model_steps: 32 } }), providerFactory: () => provider,
  });
  await engine.initialize();
  const result = await engine.submit({ request_id: 'horizon-turn', content: 'Read all item files' }, 'operator');
  assert.equal(result.outcome, 'completed');
  assert.equal(count, 21);
  assert.equal(engine.lifecycles.snapshot().filter((item) => item.kind === 'model_step').length, 21);
});

test('configured model-step ceiling terminates a still-progressing turn at the declared boundary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-model-step-limit-'));
  for (let index = 0; index < 20; index += 1) {
    await writeFile(join(root, `bounded-${index}.txt`), `unique-${index}`, 'utf8');
  }
  let count = 0;
  const provider = { async *stream() {
    yield* toolCall(`bounded-call-${count}`, `bounded-${count}.txt`);
    count += 1;
  } };
  const engine = new SessionEngine({
    config: config(root, 'ephemeral', { recovery: { max_model_steps: 16 } }), providerFactory: () => provider,
  });
  await engine.initialize();
  const result = await engine.submit({ request_id: 'bounded-turn', content: 'Read all bounded files' }, 'operator');
  assert.equal(result.outcome, 'incomplete');
  assert.equal(count, 16);
  assert.equal(result.failure.exhaustion_category, 'model_step_limit');
  assert.equal(result.failure.exhaustion_count, 16);
  assert.match(result.text, /explicit runtime boundary ended the turn/u);
});

test('AC-REV-09 unchanged successful observations trigger a call boundary without parking the turn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-churn-'));
  await writeFile(join(root, 'same.txt'), 'unchanged', 'utf8');
  let count = 0;
  const provider = { async *stream() {
    count += 1;
    if (count > 5) {
      yield { type: 'text', text: 'The repeated observation is unchanged; reporting it now.' };
      yield { type: 'terminal' };
      return;
    }
    yield* toolCall(`same-call-${count}`, 'same.txt');
  } };
  const engine = new SessionEngine({ config: config(root), providerFactory: () => provider });
  await engine.initialize();
  const result = await engine.submit({ request_id: 'churn-turn', content: 'Read same.txt repeatedly' }, 'operator');
  assert.equal(result.outcome, 'completed');
  assert.equal(count, 6);
  assert.equal(engine.state.transitions.some((item) => item.to === 'awaiting_attention'), false);
  assert.equal(result.recovery.some((item) => item.action === 'block_exact_request'), true);
  assert.equal(engine.transcript.some((item) => item.reasonCode === 'tool_exact_request_blocked'), true);
});

test('explicit monitoring intent permits bounded repeated observations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-monitoring-'));
  await writeFile(join(root, 'same.txt'), 'unchanged', 'utf8');
  const requests = [];
  const provider = { async *stream(request) {
    requests.push(request);
    if (requests.length <= 5) {
      yield* toolCall(`monitor-call-${requests.length}`, 'same.txt');
      return;
    }
    yield { type: 'text', text: 'Five checks completed; the file remained unchanged.' };
    yield { type: 'terminal', finishReason: 'stop' };
  } };
  const engine = new SessionEngine({ config: config(root), providerFactory: () => provider });
  await engine.initialize();
  const result = await engine.submit({
    request_id: 'monitoring-turn', content: 'Monitor same.txt for five checks and report whether it changes.',
  }, 'operator');
  assert.equal(result.outcome, 'completed');
  assert.equal(requests.length, 6);
  assert.deepEqual(requests.slice(1).map((request) => request.reasoningMode),
    [undefined, undefined, undefined, undefined, undefined]);
});

test('AC-TURN-09/AC-TURN-10 steering overrides a bare completion claim at the supervised checkpoint', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-steer-'));
  let release;
  let count = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  const provider = { async *stream(request) {
    count += 1;
    if (count === 1) {
      yield { type: 'text', text: 'The task is complete.' };
      await gate;
      yield { type: 'terminal' };
      return;
    }
    const steering = request.messages.filter((item) => item.role === 'user' && item.content === 'Use the second target');
    assert.equal(steering.length, 1);
    yield { type: 'text', text: 'Steering applied.' };
    yield { type: 'terminal' };
  } };
  const engine = new SessionEngine({ config: config(root), providerFactory: () => provider });
  await engine.initialize();
  const turn = engine.submit({ request_id: 'steer-turn', content: 'Start' }, 'operator');
  while (engine.state.state !== 'streaming_model') await new Promise((resolve) => setTimeout(resolve, 1));
  const accepted = await engine.steer({ request_id: 'steer-1', content: 'Use the second target' }, 'operator');
  release();
  const result = await turn;
  assert.equal(accepted.accepted, true);
  assert.equal(result.outcome, 'completed');
  assert.equal(count, 2);
  assert.equal(engine.transcript.filter((item) => item.steeringId).length, 1);
});

test('AC-TURN-07 compacts before provider I/O and records an auditable fact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-compact-'));
  let invoked = 0;
  const provider = { async *stream(request) {
    invoked += 1;
    assert.ok(Buffer.byteLength(JSON.stringify(request.messages)) < 65_536);
    yield { type: 'text', text: 'Compacted safely.' };
    yield { type: 'terminal' };
  } };
  const engine = new SessionEngine({
    config: config(root, 'ephemeral', { context_limit_bytes: 65_536 }),
    providerFactory: () => provider,
  });
  await engine.initialize();
  for (let index = 0; index < 200; index += 1) {
    engine.transcript.push({ type: 'message', role: 'assistant', content: `${index}:${'x'.repeat(1000)}`, trust: 'model' });
  }
  const result = await engine.submit({ request_id: 'compact-turn', content: 'Continue' }, 'operator');
  assert.equal(result.outcome, 'completed');
  assert.equal(invoked, 1);
  assert.ok(engine.transcript.some((item) => item.type === 'compaction' && item.omitted > 0));
  assert.ok(engine.state.transitions.some((item) => item.to === 'compacting_context'));
});

test('automatic compaction uses a prior cache-hit as evidence for prefix alignment', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-cache-aligned-'));
  let ordinaryCalls = 0;
  let alignedRequest = null;
  const provider = {
    runtimeSnapshot: async () => ({ contextWindowTokens: 32_768, contextLimitBytes: 65_536 }),
    async *stream(request) {
      if (request.responseFormat?.json_schema?.name === 'nna_continuation') {
        alignedRequest = request;
        yield { type: 'text', text: JSON.stringify({
          completed_work: ['Preserved the active objective'], open_questions: [], next_actions: ['Continue'],
        }) };
        yield { type: 'terminal' };
        return;
      }
      ordinaryCalls += 1;
      if (ordinaryCalls === 1) {
        yield { type: 'usage', usage: {
          prompt_tokens: 256, completion_tokens: 8, total_tokens: 264,
          prompt_cache_hit_tokens: 128,
        } };
      }
      yield { type: 'text', text: ordinaryCalls === 1 ? 'Initial turn.' : 'Continued after compaction.' };
      yield { type: 'terminal' };
    },
  };
  const engine = new SessionEngine({
    config: config(root, 'ephemeral', { context_limit_bytes: 65_536 }),
    providerFactory: () => provider,
  });
  await engine.initialize();
  assert.equal((await engine.submit({ request_id: 'cache-seed', content: 'Establish context' }, 'operator')).outcome, 'completed');
  for (let index = 0; index < 100; index += 1) {
    engine.transcript.push({
      type: 'message', role: 'assistant', content: `${index}:${'x'.repeat(2_000)}`,
      trust: 'model', turnId: `historical-${index}`,
    });
  }
  const result = await engine.submit({ request_id: 'cache-compact', content: 'Continue the task' }, 'operator');
  assert.equal(result.outcome, 'completed');
  assert.ok(alignedRequest);
  assert.ok(alignedRequest.messages.length > 2);
  assert.ok(alignedRequest.tools.length > 0);
  assert.match(alignedRequest.messages.at(-1).content, /deterministic continuation record/u);
});

test('AC-TURN-07 preflight honors the selected route model limit below the global ceiling', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-model-limit-'));
  let requestBytes = 0;
  const provider = { async *stream(request) {
    requestBytes = Buffer.byteLength(JSON.stringify(request.messages));
    yield { type: 'text', text: 'Model-aware compaction completed.' };
    yield { type: 'terminal' };
  } };
  const engine = new SessionEngine({
    config: resolveManifest({
      persistence: 'ephemeral', workspace_root: root, context_limit_bytes: 1_000_000,
      context_compaction_threshold: 0.8,
      provider: {
        id: 'fixture', endpoint: 'http://127.0.0.1:9999/v1', model: 'small-model',
        trust_zone: 'loopback', context_limit_bytes: 65_536,
      },
    }),
    providerFactory: () => provider,
  });
  await engine.initialize();
  for (let index = 0; index < 100; index += 1) {
    engine.transcript.push({ type: 'message', role: 'assistant', content: `${index}:${'x'.repeat(1000)}`, trust: 'model' });
  }
  const result = await engine.submit({ request_id: 'model-limit-turn', content: 'Continue' }, 'operator');
  assert.equal(result.outcome, 'completed');
  assert.ok(requestBytes < Math.floor(65_536 * 0.8));
  assert.ok(engine.transcript.some((item) => item.type === 'compaction'));
});

test('AC-SESS-07 one live writer rejects a second session owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-lock-'));
  const stores = join(root, 'sessions');
  const reviewers = join(root, 'reviewers');
  const first = new SessionEngine({
    config: config(root, 'durable'), sessionId: 'shared-session',
    storeRoot: stores, reviewerRoot: reviewers,
  });
  await first.initialize();
  const second = new SessionEngine({
    config: config(root, 'durable'), sessionId: 'shared-session',
    storeRoot: stores, reviewerRoot: reviewers,
  });
  await assert.rejects(second.initialize(), { code: 'session_locked' });
  await first.shutdown({ request_id: 'shutdown-lock' });
});

test('AC-SESS-01/AC-SESS-05/AC-SESS-10 resume preserves identity, marks interruption, and consumes saved steering once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-resume-'));
  const stores = join(root, 'sessions');
  const seed = new JournalStore(stores, 'resume-session');
  await seed.open();
  await seed.append('session_created', { sessionId: 'resume-session' });
  await seed.append('turn_accepted', { turnId: 'interrupted-turn', requestId: 'old-request' });
  await seed.append('steering_accepted', {
    id: 'saved-steering', requestId: 'old-steer', content: 'Saved direction',
    principal: 'operator', turnId: 'interrupted-turn', acceptedAt: new Date().toISOString(),
  });
  await seed.close();
  let providerCalls = 0;
  const provider = { async *stream() {
    providerCalls += 1;
    yield { type: 'text', text: providerCalls === 1 ? 'Checkpoint.' : 'Finished after saved steering.' };
    yield { type: 'terminal' };
  } };
  const engine = new SessionEngine({
    config: config(root, 'durable'), sessionId: 'resume-session',
    storeRoot: stores, reviewerRoot: join(root, 'reviewers'), providerFactory: () => provider,
  });
  await engine.initialize();
  assert.equal(providerCalls, 0);
  assert.equal(engine.recoveryNotices.length, 1);
  const result = await engine.submit({ request_id: 'resume-turn', content: 'Resume safely' }, 'operator');
  assert.equal(result.outcome, 'completed');
  assert.equal(providerCalls, 2);
  assert.equal(engine.transcript.filter((item) => item.steeringId === 'saved-steering').length, 1);
  await engine.shutdown({ request_id: 'shutdown-resume' });
});

test('resume durably balances interrupted tool calls without guessing side effects', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-resume-tools-'));
  const stores = join(root, 'sessions');
  const seed = new JournalStore(stores, 'resume-tool-session');
  await seed.open();
  await seed.append('session_created', { sessionId: 'resume-tool-session' });
  await seed.append('turn_accepted', { turnId: 'interrupted-turn', requestId: 'old-request' });
  await seed.append('tool_request', {
    type: 'tool_request', turnId: 'interrupted-turn', stepId: 'step-1',
    requestId: 'not-started', providerCallId: 'call-not-started',
    toolName: 'fs.write_text', args: { path: 'safe.txt', content: 'safe' },
  });
  await seed.append('tool_request', {
    type: 'tool_request', turnId: 'interrupted-turn', stepId: 'step-1',
    requestId: 'started', providerCallId: 'call-started',
    toolName: 'fs.write_text', args: { path: 'unknown.txt', content: 'unknown' },
  });
  await seed.append('lifecycle_event', {
    event_name: 'tool_execution.started', turn_id: 'interrupted-turn',
    tool_request_id: 'started',
  });
  await seed.close();

  const engine = new SessionEngine({
    config: config(root, 'durable'), sessionId: 'resume-tool-session',
    storeRoot: stores, reviewerRoot: join(root, 'reviewers'),
  });
  await engine.initialize();
  const repairs = engine.transcript.filter((item) => item.type === 'tool_result');
  assert.equal(repairs.length, 2);
  assert.equal(repairs.find((item) => item.requestId === 'not-started').effectCertainty, 'none');
  assert.equal(repairs.find((item) => item.requestId === 'started').effectCertainty, 'unknown');
  await engine.shutdown({ request_id: 'shutdown-resume-tools' });

  const reopened = new JournalStore(stores, 'resume-tool-session');
  const recovered = await reopened.open();
  assert.equal(recovered.records.filter((item) => item.type === 'tool_result').length, 2);
  await reopened.close();
});
test('truncated malformed tool arguments are classified separately from ordinary malformed JSON', () => {
  const truncated = new ToolCallAssembler();
  truncated.add([{ index: 0, id: 'truncated-edit', function: { name: 'fs.edit_text', arguments: '{"path":"a.js"' } }]);
  assert.equal(truncated.complete('length')[0].invalid.code, 'tool_arguments_truncated');

  const malformed = new ToolCallAssembler();
  malformed.add([{ index: 0, id: 'malformed-edit', function: { name: 'fs.edit_text', arguments: '{nope}' } }]);
  assert.equal(malformed.complete('tool_calls')[0].invalid.code, 'tool_arguments_malformed');

  const ceiling = new ToolCallAssembler();
  ceiling.add([{ index: 0, id: 'ceiling-edit', function: { name: 'fs.edit_text', arguments: '{"path":"a.js"' } }]);
  assert.equal(ceiling.complete('tool_calls', {
    usage: { completion_tokens: 4096 }, outputLimitTokens: 4096,
  })[0].invalid.code, 'tool_arguments_truncated');
});

test('provider tool arguments accept one parsed JSON object without losing required fields', () => {
  const assembler = new ToolCallAssembler();
  assembler.add([{
    index: 0, id: 'parsed-shell',
    function: { name: 'shell.run', arguments: { script: 'node --version' } },
  }]);
  assert.deepEqual(assembler.complete('tool_calls')[0].args, { script: 'node --version' });
});

test('provider tool arguments reject unsupported or drifting transport shapes', () => {
  const unsupported = new ToolCallAssembler();
  assert.throws(() => unsupported.add([{
    index: 0, id: 'array-shell', function: { name: 'shell.run', arguments: ['node --version'] },
  }]), { code: 'tool_arguments_transport_invalid' });

  const drift = new ToolCallAssembler();
  drift.add([{
    index: 0, id: 'drift-shell', function: { name: 'shell.run', arguments: '{"script":' },
  }]);
  assert.throws(() => drift.add([{
    index: 0, id: 'drift-shell', function: { arguments: { script: 'node --version' } },
  }]), { code: 'tool_arguments_transport_drift' });
});
