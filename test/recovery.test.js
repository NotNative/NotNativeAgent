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
import { RecoverySupervisor } from '../src/recovery.js';
import { ToolCallAssembler } from '../src/tools/calls.js';
import { contextPressureScale } from '../src/engine/provider-recovery.js';

function config(root, persistence = 'ephemeral', extra = {}) {
  return resolveManifest({
    persistence, workspace_root: root, ...extra,
    provider: {
      id: 'fixture', endpoint: 'http://127.0.0.1:9999/v1',
      model: 'fixture-model', trust_zone: 'loopback',
    },
  });
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

test('configured recovery ladder remains finite and consumes its declared actions', () => {
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
  assert.deepEqual(recovery.noProgress('configured'), { continue: false, exhausted: true, count: 5 });
});

test('low-pressure no-progress recovery does not substitute compaction for correction', () => {
  const recovery = new RecoverySupervisor({ localLimit: 3, ladder: ['nudge', 'compact'] });
  assert.equal(recovery.noProgress('schema', null, {}, { allowCompaction: false }).action.action, 'nudge');
  assert.equal(recovery.noProgress('schema', null, {}, { allowCompaction: false }).action.action, 'nudge');
});

test('tool recovery budgets are isolated by stable failure fingerprint', () => {
  const recovery = new RecoverySupervisor({ localLimit: 3, ladder: ['nudge', 'nudge'] });
  assert.equal(recovery.noProgress('tool_no_progress', null, {}, { failureFingerprint: 'search-glob' }).count, 1);
  assert.equal(recovery.noProgress('tool_no_progress', null, {}, { failureFingerprint: 'search-glob' }).count, 2);
  const different = recovery.noProgress('tool_no_progress', null, {}, { failureFingerprint: 'task-detail' });
  assert.equal(different.count, 1);
  assert.equal(different.action.failure_fingerprint, 'task-detail');
  assert.deepEqual(recovery.noProgress('tool_no_progress', null, {}, { failureFingerprint: 'search-glob' }), {
    continue: false, exhausted: true, count: 3,
  });
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
  assert.deepEqual(recovery.noProgress('tool_no_progress', directory), {
    continue: false, exhausted: true, count: 3,
  });
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

test('action-oriented turns preserve configured reasoning behavior across tool continuations', async () => {
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

test('reasoning-only output receives one reasoning-disabled retry before normal empty recovery', async () => {
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
  assert.equal(requests[1].reasoningMode, 'off');
  assert.equal(result.text, 'Visible answer after the bounded fallback.');
  assert.deepEqual(result.recovery.map((item) => item.action), ['retry_without_reasoning']);
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

test('reasoning-disabled fallback occurs once before bounded empty-output exhaustion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-reasoning-empty-bounded-'));
  const modes = [];
  const provider = { async *stream(request) {
    modes.push(request.reasoningMode);
    if (modes.length === 1) yield { type: 'reasoning', text: 'hidden only' };
    yield { type: 'terminal', finishReason: 'stop' };
  } };
  const engine = new SessionEngine({ config: config(root), providerFactory: () => provider });
  await engine.initialize();
  const result = await engine.submit({ request_id: 'reasoning-empty-bounded', content: 'Answer visibly.' }, 'operator');
  assert.equal(result.outcome, 'incomplete');
  assert.deepEqual(modes, [undefined, 'off', undefined, undefined]);
  assert.deepEqual(result.recovery.map((item) => item.action), ['retry_without_reasoning', 'nudge', 'nudge']);
  assert.equal(result.failure.exhaustion_category, 'empty_output');
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

test('AC-FAIL-06 repeated provider size rejection stops after one changed retry', async () => {
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

test('silent trusted-local inference receives non-authoritative out-of-band health probes', async () => {
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
    healthProbeIntervalMs: 10, healthProbeTimeoutMs: 5,
    telemetry: { record: (name, outcome) => events.push([name, outcome]) },
  });
  const provider = {
    profile: { trustZone: 'loopback' },
    health: async () => { probes += 1; throw Object.assign(new Error('offline probe'), { code: 'ECONNREFUSED' }); },
    async *stream() {
      await new Promise((resolve) => setTimeout(resolve, 35));
      yield { type: 'text', text: 'completed' };
      yield { type: 'terminal', finishReason: 'stop' };
    },
  };
  await runner.run(provider, {}, { overallMs: null, firstTokenMs: null, idleMs: null }, active);
  assert.equal(active.stepText, 'completed');
  assert.ok(probes >= 1);
  assert.ok(events.some(([name, outcome]) => name === 'provider.health' && outcome === 'failed'));
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

test('AC-PROD-03/AC-ENGP-02/AC-FAIL-01/AC-FAIL-03/AC-FAIL-11/AC-FAIL-12 stalled output has bounded deterministic recovery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-empty-'));
  let count = 0;
  const provider = { async *stream() {
    count += 1;
    yield { type: 'terminal' };
  } };
  const engine = new SessionEngine({ config: config(root), providerFactory: () => provider });
  await engine.initialize();
  const result = await engine.submit({ request_id: 'empty-turn', content: 'Produce output' }, 'operator');
  assert.equal(result.outcome, 'incomplete');
  assert.equal(count, 3);
  assert.equal(result.failure.code, 'recovery_exhausted');
  assert.match(result.text, /model returned no usable continuation after 3 attempts/u);
  assert.equal(result.failure.resume_condition, 'new authenticated input or changed external evidence');
  assert.deepEqual(result.failure.completed_progress, { unique_evidence_count: 0, fingerprints: [], evidence: [] });
  assert.equal(result.failure.last_checkpoint, 'turn_start');
  assert.equal(result.failure.last_verified_checkpoint, 'turn_start');
  assert.match(result.failure.remaining_work, /continuation/u);
  assert.equal(result.failure.side_effect_certainty, 'none');
  assert.deepEqual(result.failure.recovery_actions.map((item) => [item.action, item.count]), [['nudge', 1], ['nudge', 2]]);
  assert.equal(result.recovery.length, 2);
});

test('empty continuation exhaustion preserves a useful partial handoff', async () => {
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
    yield { type: 'terminal' };
  } };
  const output = [];
  const engine = new SessionEngine({
    config: config(root), providerFactory: () => provider,
    output: async (record) => output.push(record),
  });
  await engine.initialize();
  const result = await engine.submit({ request_id: 'empty-partial-turn', content: 'Read and explain target.txt.' }, 'operator');
  assert.equal(result.outcome, 'incomplete');
  assert.equal(count, 4);
  assert.equal(result.failure.exhaustion_category, 'empty_output');
  assert.equal(result.failure.exhaustion_count, 3);
  assert.match(result.text, /Completed tool effects and diagnostics remain preserved/u);
  assert.match(result.text, /Verified checkpoint: the requested target was read successfully/u);
  assert.doesNotMatch(result.text, /turn stopped making verifiable progress/u);
  const explanation = output.filter((record) => record.type === 'stream_delta').at(-1);
  assert.equal(explanation.delta_type, 'recovery_explanation');
  assert.match(explanation.text, /model returned no usable continuation after 3 attempts/u);
  assert.match(explanation.text, /The remaining step was not completed/u);
  assert.equal(output.at(-1).type, 'turn_result');
  assert.equal(output.filter((record) => record.type === 'turn_result').length, 1);
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
  assert.equal(invalid.status, 'invalid_request');
  assert.equal(invalid.reasonCode, 'tool_arguments_malformed');
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

test('AC-PROD-03 unchanged malformed calls stop at the local recovery budget', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-malformed-loop-'));
  let count = 0;
  const provider = { async *stream() {
    count += 1;
    yield { type: 'tool_fragment', fragments: [{
      index: 0, id: 'same-malformed-call', function: { name: 'fs.read_text', arguments: '{' },
    }] };
    yield { type: 'terminal' };
  } };
  const engine = new SessionEngine({ config: config(root), providerFactory: () => provider });
  await engine.initialize();
  const result = await engine.submit({ request_id: 'malformed-loop', content: 'Do not loop.' }, 'operator');
  assert.equal(result.outcome, 'incomplete');
  assert.equal(result.failure.code, 'recovery_exhausted');
  assert.equal(count, 3);
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
});

test('AC-REV-09 unchanged successful polling is stopped as no progress', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-churn-'));
  await writeFile(join(root, 'same.txt'), 'unchanged', 'utf8');
  let count = 0;
  const provider = { async *stream() {
    yield* toolCall(`same-call-${count}`, 'same.txt');
    count += 1;
  } };
  const engine = new SessionEngine({ config: config(root), providerFactory: () => provider });
  await engine.initialize();
  const result = await engine.submit({ request_id: 'churn-turn', content: 'Read same.txt repeatedly' }, 'operator');
  assert.equal(result.outcome, 'incomplete');
  assert.equal(count, 4);
  assert.equal(result.failure.code, 'recovery_exhausted');
  assert.equal(result.failure.side_effect_certainty, 'completed');
  assert.equal(result.failure.last_verified_checkpoint, 'tool_results_committed');
  assert.deepEqual(result.failure.completed_progress.evidence[0].summary, {
    successful_tool_calls: 1, tool_names: ['fs.read_text'],
    request_fingerprints: [result.failure.completed_progress.evidence[0].summary.request_fingerprints[0]],
  });
  assert.match(result.failure.completed_progress.evidence[0].summary.request_fingerprints[0], /^[a-f0-9]{64}$/u);
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
