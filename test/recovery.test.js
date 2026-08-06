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
import { ProviderRunner } from '../src/provider-runner.js';
import { RecoverySupervisor } from '../src/recovery.js';
import { ToolCallAssembler } from '../src/tool-calls.js';
import { contextPressureScale } from '../src/engine-provider-recovery.js';

function config(root, persistence = 'ephemeral', extra = {}) {
  return resolveManifest({
    persistence, workspace_root: root, ...extra,
    provider: {
      id: 'fixture', endpoint: 'http://127.0.0.1:9999/v1',
      model: 'fixture-model', trust_zone: 'loopback',
    },
  });
}

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

function toolCall(id, path) {
  return [
    { type: 'tool_fragment', fragments: [{
      index: 0, id, function: { name: 'fs.read_text', arguments: JSON.stringify({ path }) },
    }] },
    { type: 'terminal', finishReason: 'tool_calls' },
  ];
}

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
  });
  await engine.initialize();
  const result = await engine.submit({ request_id: 'reasoning-private', content: 'Answer' }, 'operator');
  assert.equal(result.outcome, 'completed');
  assert.equal(result.reasoning_bytes, Buffer.byteLength(secretReasoning));
  assert.equal(JSON.stringify(engine.transcript).includes(secretReasoning), false);
  assert.equal(JSON.stringify(output).includes(secretReasoning), false);
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
  assert.match(result.text, /stopped making verifiable progress/u);
  assert.equal(result.failure.resume_condition, 'new authenticated input or changed external evidence');
  assert.deepEqual(result.failure.completed_progress, { unique_evidence_count: 0, fingerprints: [], evidence: [] });
  assert.equal(result.failure.last_checkpoint, 'turn_start');
  assert.equal(result.failure.last_verified_checkpoint, 'turn_start');
  assert.match(result.failure.remaining_work, /continuation/u);
  assert.equal(result.failure.side_effect_certainty, 'none');
  assert.deepEqual(result.failure.recovery_actions.map((item) => [item.action, item.count]), [['nudge', 1], ['compact', 2]]);
  assert.equal(result.recovery.length, 2);
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
    config: config(root, 'ephemeral', { recovery: { max_model_steps: 16 } }), providerFactory: () => provider,
  });
  await engine.initialize();
  const result = await engine.submit({ request_id: 'horizon-turn', content: 'Read all item files' }, 'operator');
  assert.equal(result.outcome, 'completed');
  assert.equal(count, 21);
  assert.equal(engine.lifecycles.snapshot().filter((item) => item.kind === 'model_step').length, 21);
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
