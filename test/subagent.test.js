// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { subagentDefinition } from '../src/subagent-tool.js';
import { runEngineSubagent, subagentConfig, subagentOutputStatus, subagentParallelLimit } from '../src/subagent-runtime.js';
import { createSubagentProgressRelay } from '../src/subagent-progress.js';
import { resolveManifest } from '../src/config.js';
import { TypedSessionEngine as SessionEngine } from './typed-provider-fixture.js';
import { recoverJournal } from '../src/store.js';
import { subagentStatus } from '../src/tui/runtime-inspection.js';

test('sub-agent progress emits compact lifecycle milestones without child tool chatter', async () => {
  const output = [];
  const relay = createSubagentProgressRelay({
    sessionId: 'parent', output: async (record) => output.push(record),
  }, { turnId: 'turn-1', stepId: 'step-1', agentId: 'agent-1', agentType: 'general' });
  await relay.accept({ type: 'tool_status', status: 'running', tool: 'fs_read_text', target: 'README.md' });
  await relay.accept({ type: 'tool_status', status: 'succeeded', tool: 'fs_read_text', target: 'README.md' });
  assert.equal(output.length, 0);
  await relay.started('Review src/subagent-progress.js and src/tui/activity-renderer.js.');
  await relay.returned({ text: 'A deliberately verbose report remains available to the parent model.' });
  assert.deepEqual(output.map((record) => [record.phase, record.text]), [
    ['started', 'working on src/subagent-progress.js and 1 more file'],
    ['returned', 'working on src/subagent-progress.js and 1 more file'],
  ]);
});

test('agent_run validates a bounded specialist request and returns its terminal result', async () => {
  let received;
  const definition = subagentDefinition({
    workspaceRoot: 'D:\\workspace',
    run: async (input) => {
      received = input;
      return { session_id: 'agent_planner_12345678', outcome: 'completed', text: 'planned', usage: { input_tokens: 10 } };
    },
  });
  const normalized = await definition.validate({ type: 'planner', task: 'Inspect and plan.' });
  const result = await definition.executor(normalized, new AbortController().signal);
  assert.deepEqual(received, { type: 'planner', task: 'Inspect and plan.' });
  assert.match(result.content, /"outcome": "completed"/u);
  await assert.rejects(() => definition.validate({ type: 'manager', task: 'Work' }), { code: 'subagent_request_invalid' });
});

test('agent_run rejects unknown outcomes and strips unrecognized terminal metadata', async () => {
  const invalid = subagentDefinition({ workspaceRoot: 'D:\\workspace', run: async () => ({
    session_id: 'agent_test_12345678', outcome: 'SUCCEEDED', text: 'done',
  }) });
  const request = await invalid.validate({ type: 'general', task: 'Test.' });
  await assert.rejects(invalid.executor(request, new AbortController().signal), { code: 'subagent_result_invalid' });
  const safe = subagentDefinition({ workspaceRoot: 'D:\\workspace', run: async () => ({
    session_id: 'agent_test_12345678', outcome: 'failed', text: '',
    usage: { input_tokens: 2, prompt: 'private' }, failure: { code: 'provider_timeout', prompt: 'private' },
  }) });
  const result = await safe.executor(await safe.validate({ type: 'general', task: 'Test.' }), new AbortController().signal);
  assert.doesNotMatch(result.content, /private|prompt/u);
  assert.match(result.content, /provider_timeout/u);
});

test('subagent configuration promotes only the configured subagent route to primary', () => {
  const primary = { role: 'primary', providerId: 'slow', model: 'large' };
  const subagent = { role: 'subagent', providerId: 'fast', model: 'small' };
  const config = { routes: { primary, subagent }, applicationPolicy: 'Base policy.' };
  const derived = subagentConfig(config, 'coder');
  assert.equal(derived.routes.primary.providerId, 'fast');
  assert.equal(derived.routes.primary.model, 'small');
  assert.equal(derived.routes.subagent, subagent);
  assert.match(derived.applicationPolicy, /implementation stage/u);
  assert.match(derived.applicationPolicy, /not reserved for the final reviewer/u);
  assert.match(derived.applicationPolicy, /entirety of every touched file/u);
  assert.equal(config.routes.primary, primary);
});

test('each devteam specialist receives role-specific engineering standards directly', () => {
  const route = { role: 'primary', providerId: 'worker', model: 'small' };
  const config = { routes: { primary: route, subagent: route }, applicationPolicy: 'Base policy.' };
  const expected = {
    planner: /observable acceptance criterion/u,
    coder: /pre-existing violations/u,
    tester: /partial failure, recovery/u,
    reviewer: /concrete evidence/u,
  };
  for (const [type, pattern] of Object.entries(expected)) {
    const policy = subagentConfig(config, type).applicationPolicy;
    assert.match(policy, /Power of Ten/u);
    assert.match(policy, /interface work/u);
    assert.match(policy, pattern);
  }
  assert.doesNotMatch(subagentConfig(config, 'general').applicationPolicy, /Power of Ten/u);
  assert.throws(() => subagentConfig(config, 'manager'), { code: 'subagent_type_invalid' });
});

test('sub-agent output status treats malformed output as failed', () => {
  assert.equal(subagentOutputStatus(null), 'failed');
  assert.equal(subagentOutputStatus('unexpected output'), 'failed');
  assert.equal(subagentOutputStatus({ outcome: 'completed' }), 'succeeded');
});

test('sub-agent runtime forwards child lifecycle and output to the NND registry', async () => {
  const observed = [];
  let childOptions;
  const parent = {
    config: { executionManifest: null, routes: { subagent: { providerId: 'worker', model: 'small' } } },
    subagentDepth: 0, sessionId: 'parent', active: { turnId: 'turn_parent', stepId: 'step_parent',
      principal: { subjectId: 'operator', workspaceIds: ['workspace'] } },
    output: async () => undefined,
    nndSessionRegistry: {
      register(id, parentId, principal, child) {
        observed.push(['registered', id, parentId, principal.subjectId]);
        assert.equal(child.config.routes.primary.providerId, 'worker');
        return (outcome) => observed.push(['completed', id, outcome]);
      },
      observeStarted(id) { observed.push(['started', id]); },
      observeOutput(id, record) { observed.push(['output', id, record.type]); },
    },
  };
  const createEngine = (options) => {
    childOptions = options;
    return {
      config: options.config, transcript: [], initialize: async () => undefined,
      async submit() {
        await childOptions.output({ type: 'stream_delta', session_id: childOptions.sessionId,
          turn_id: 'child_turn', text: 'Live' });
        await childOptions.output({ type: 'turn_result', session_id: childOptions.sessionId,
          turn_id: 'child_turn', outcome: 'completed' });
        return { outcome: 'completed', text: 'Live' };
      },
      shutdown: async () => undefined,
    };
  };
  const result = await runEngineSubagent(parent, { type: 'general', task: 'Inspect.' },
    new AbortController().signal, createEngine);
  assert.equal(result.outcome, 'completed');
  const id = childOptions.sessionId;
  assert.deepEqual(observed, [
    ['registered', id, 'parent', 'operator'], ['started', id],
    ['output', id, 'stream_delta'], ['output', id, 'turn_result'],
    ['completed', id, 'completed'],
  ]);
});

test('optional NND observation failures cannot fail or skip cleanup of delegated work', async () => {
  const diagnostics = [];
  let shutdown = false;
  const parent = {
    config: { executionManifest: null, routes: { subagent: { providerId: 'worker', model: 'small' } } },
    subagentDepth: 0, sessionId: 'parent', active: { turnId: 'turn_parent', stepId: 'step_parent',
      principal: { subjectId: 'operator', workspaceIds: ['workspace'] } },
    output: async () => undefined,
    telemetry: { record: (kind, status, detail) => diagnostics.push([kind, status, detail.operation]) },
    nndSessionRegistry: {
      register() { return () => { throw new Error('display registry unregister failed'); }; },
      observeStarted() { throw new Error('display registry start failed'); },
      observeOutput() { throw new Error('display registry output failed'); },
    },
  };
  const result = await runEngineSubagent(parent, { type: 'general', task: 'Inspect.' },
    new AbortController().signal, (options) => ({
      config: options.config, initialize: async () => undefined,
      async submit() {
        await options.output({ type: 'stream_delta', session_id: options.sessionId,
          turn_id: 'child_turn', text: 'Done' });
        return { outcome: 'completed', text: 'Done' };
      },
      shutdown: async () => { shutdown = true; },
    }));
  assert.equal(result.outcome, 'completed');
  assert.equal(shutdown, true);
  assert.deepEqual(diagnostics.filter(([kind]) => kind === 'nnd.session_observation').map(([, , operation]) => operation),
    ['started', 'output', 'completed']);
});

test('subagent concurrency follows the loaded worker model parallel capacity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-subagents-'));
  const output = [];
  let workers = 0; let peakWorkers = 0; let parentCalls = 0;
  let releaseParallelWorkers;
  const parallelWorkersStarted = new Promise((resolve) => { releaseParallelWorkers = resolve; });
  const parent = { async *stream(request) {
    parentCalls += 1;
    if (parentCalls === 1) {
      yield { type: 'tool_fragment', fragments: [
        toolFragment(0, 'explore-a', { type: 'general', task: 'Explore area A.' }),
        toolFragment(1, 'explore-b', { type: 'general', task: 'Explore area B.' }),
      ] };
      yield { type: 'terminal', finishReason: 'tool_calls', usage: null };
      return;
    }
    assert.equal(request.messages.filter((item) => item.role === 'tool').length, 2);
    yield { type: 'text', text: 'Exploration complete.' };
    yield { type: 'terminal', finishReason: 'stop', usage: null };
  } };
  const worker = {
    async runtimeSnapshot() { return { parallelCapacity: 2, source: 'lmstudio_v1' }; },
    async *stream() {
      workers += 1; peakWorkers = Math.max(peakWorkers, workers);
      try {
        if (workers === 2) releaseParallelWorkers();
        let timer;
        await Promise.race([
          parallelWorkersStarted,
          new Promise((resolve) => { timer = setTimeout(resolve, 1_000); }),
        ]);
        clearTimeout(timer);
        yield { type: 'text', text: 'Explored.' };
        yield { type: 'terminal', finishReason: 'stop', usage: null };
      } finally { workers -= 1; }
    },
  };
  const config = resolveManifest({
    persistence: 'ephemeral', workspace_root: root, provider_concurrency: 1,
    providers: [
      { id: 'parent', endpoint: 'http://127.0.0.1:1234/v1', model: 'parent', trust_zone: 'loopback' },
      { id: 'worker', endpoint: 'http://127.0.0.1:1235/v1', model: 'worker', trust_zone: 'loopback' },
    ],
    routes: { primary: { provider_id: 'parent' }, subagent: { provider_id: 'worker' } },
  });
  const engine = new SessionEngine({
    config, providerFactory: (profile) => profile.id === 'worker' ? worker : parent,
    output: async (record) => output.push(record),
    semanticReviewer: { async review() { return { outcome: 'approve', confidence: 0.99, reason_code: 'delegation_matches_intent', authority_anchors: [1] }; } },
  });
  await engine.initialize();
  const result = await engine.submit({ request_id: 'parallel-exploration', content: 'Delegate two independent exploration agents.' }, 'operator');
  assert.equal(result.outcome, 'completed');
  assert.equal(peakWorkers, 2);
  const progress = output.filter((record) => record.type === 'subagent_progress');
  assert.equal(progress.filter((record) => record.phase === 'started').length, 2);
  assert.equal(progress.filter((record) => record.phase === 'returned').length, 2);
  assert.deepEqual(progress.filter((record) => record.phase === 'returned').map((record) => record.text).sort(), [
    'Explore area A.', 'Explore area B.',
  ]);
  assert.equal(engine.scheduler.snapshot().find((item) => item.resource === 'worker').discoveredLimit, 2);
  await engine.shutdown({ request_id: 'shutdown', type: 'shutdown' });
});

test('parallel sub-agent cancellation drains children and commits terminal tool lifecycles', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-subagent-cancel-'));
  const reviewerRoot = join(root, 'reviewer');
  const output = [];
  const parent = { async *stream() {
    yield { type: 'text', text: 'I am delegating both reviews.' };
    yield { type: 'tool_fragment', fragments: [
      toolFragment(0, 'cancel-a', { type: 'reviewer', task: 'Review area A.' }),
      toolFragment(1, 'cancel-b', { type: 'reviewer', task: 'Review area B.' }),
    ] };
    yield { type: 'terminal', finishReason: 'tool_calls', usage: null };
  } };
  const config = resolveManifest({
    persistence: 'durable', workspace_root: root, tool_concurrency: 2,
    provider: { id: 'parent', endpoint: 'http://127.0.0.1:1234/v1', model: 'parent', trust_zone: 'loopback' },
  });
  const engine = new SessionEngine({
    config, providerFactory: () => parent, output: async (record) => output.push(record),
    storeRoot: join(root, 'sessions'), reviewerRoot,
    semanticReviewer: { async review() { return { outcome: 'approve', confidence: 0.99, reason_code: 'delegation_matches_intent', authority_anchors: [1] }; } },
  });
  await engine.initialize();
  engine.subagentParallelLimit = async () => 2;
  let started = 0; let settled = 0; let releaseStarted;
  const bothStarted = new Promise((resolve) => { releaseStarted = resolve; });
  engine.runSubagent = async (input, signal) => new Promise((resolve) => {
    started += 1;
    if (started === 2) releaseStarted();
    const cancel = () => setTimeout(() => {
      settled += 1;
      resolve({ session_id: `agent_${input.type}_${settled}`, outcome: 'cancelled', text: '' });
    }, 20);
    if (signal.aborted) cancel();
    else signal.addEventListener('abort', cancel, { once: true });
  });
  const turn = engine.submit({ request_id: 'parallel-cancel', content: 'Delegate both reviews.' }, 'operator');
  await bothStarted;
  await engine.cancel({ request_id: 'cancel-once' });
  await engine.cancel({ request_id: 'cancel-twice' });
  const result = await turn;
  assert.equal(result.outcome, 'cancelled');
  assert.equal(result.failure.code, 'turn_cancelled');
  assert.deepEqual(result.secondary_failures, []);
  assert.equal(settled, 2);
  assert.equal(engine.transcript.filter((item) => item.role === 'assistant'
    && item.content === 'I am delegating both reviews.').length, 1);
  assert.deepEqual(engine.transcript.filter((item) => item.type === 'tool_result')
    .map((item) => item.toolLifecycleStatus), ['cancelled', 'cancelled']);
  assert.equal(engine.state.transitions.some((item) => item.from === 'cancelling' && item.to === 'processing_tool_results'), false);
  assert.equal(engine.lifecycles.snapshot().some((item) => item.outcome === null), false);
  assert.equal(output.filter((item) => item.type === 'turn_result').length, 1);
  await engine.shutdown({ request_id: 'shutdown-cancelled', type: 'shutdown' });
  const ledger = await recoverJournal(join(reviewerRoot, `${engine.sessionId}.review.journal.ndjson`));
  assert.equal(ledger.corruptTail, false);
  assert.equal(ledger.records.filter((record) => record.type === 'execution_started').length, 2);
  assert.equal(ledger.records.filter((record) => record.type === 'execution_terminal').length, 2);
});

test('missing advertised parallel capacity preserves sequential subagent execution', async () => {
  const engine = {
    router: { resolve: () => ({ profile: { id: 'worker' }, model: 'worker' }) },
    modelRuntime: { resolve: async () => ({ parallelCapacity: null }) },
    scheduler: { setDiscoveredLimit(_resource, limit) { this.limit = limit; } },
  };
  assert.equal(await subagentParallelLimit(engine, 'subagent', new AbortController().signal), 1);
});

test('sub-agent capacity discovery rejects missing routes and runtimes explicitly', async () => {
  const signal = new AbortController().signal;
  await assert.rejects(() => subagentParallelLimit({
    router: { resolve: () => null },
  }, 'subagent', signal), { code: 'subagent_route_missing' });
  await assert.rejects(() => subagentParallelLimit({
    router: { resolve: () => ({ profile: { id: 'worker' }, model: 'worker' }) },
    modelRuntime: { resolve: async () => null },
  }, 'subagent', signal), { code: 'subagent_runtime_missing' });
});

test('sub-agent status exposes routing and capacity without leaking profile labels', () => {
  const engine = {
    config: { executionManifest: null, limits: { providerConcurrency: 3 } },
    router: { resolve: () => ({ profile: { id: 'private-profile-label', endpoint: 'http://worker:1234/v1' }, model: 'worker-model' }) },
    tools: { definition: (name) => name === 'agent_run' ? {} : undefined },
    scheduler: { snapshot: () => [{ resource: 'private-profile-label', running: 1, limit: 2, discoveredLimit: 2, queued: [{}] }] },
  };
  const status = subagentStatus(engine);
  assert.equal(status.available, true);
  assert.equal(status.endpoint, 'http://worker:1234/v1');
  assert.equal(status.model, 'worker-model');
  assert.deepEqual(status.scheduler, {
    running: 1, queued: 1, active_limit: 2, discovered_capacity: 2,
    capacity_note: 'Capacity reported by the loaded worker-model runtime.',
  });
  assert.doesNotMatch(JSON.stringify(status), /private-profile-label/u);
});

test('sub-agent status reports hosted authority as unavailable', () => {
  const engine = {
    config: { executionManifest: { id: 'hosted' }, limits: { providerConcurrency: 4 } },
    router: { resolve: () => ({ profile: { id: 'worker', endpoint: 'http://worker/v1' }, model: 'worker' }) },
    tools: { definition: () => undefined }, scheduler: { snapshot: () => [] },
  };
  const status = subagentStatus(engine);
  assert.equal(status.available, false);
  assert.equal(status.scheduler.discovered_capacity, null);
  assert.match(status.scheduler.capacity_note, /first use/u);
});

function toolFragment(index, id, args) {
  return { index, id, function: { name: 'agent_run', arguments: JSON.stringify(args) } };
}
