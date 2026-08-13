// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { subagentDefinition } from '../src/subagent-tool.js';
import { subagentConfig, subagentParallelLimit } from '../src/subagent-runtime.js';
import { createSubagentProgressRelay } from '../src/subagent-progress.js';
import { resolveManifest } from '../src/config.js';
import { SessionEngine } from '../src/engine.js';
import { subagentStatus } from '../src/tui-runtime-inspection.js';

test('sub-agent progress reports bounded tool starts and outcomes', async () => {
  const output = [];
  const relay = createSubagentProgressRelay({
    sessionId: 'parent', output: async (record) => output.push(record),
  }, { turnId: 'turn-1', stepId: 'step-1', agentId: 'agent-1', agentType: 'general' });
  await relay.accept({ type: 'tool_status', status: 'running', tool: 'fs.read_text', target: 'README.md' });
  await relay.accept({ type: 'tool_status', status: 'succeeded', tool: 'fs.read_text', target: 'README.md' });
  assert.match(output[0].text, /fs\.read_text \(README\.md\)$/u);
  assert.match(output[1].text, /fs\.read_text \(README\.md\) · succeeded$/u);
});

test('agent.run validates a bounded specialist request and returns its terminal result', async () => {
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
});

test('subagent concurrency follows the loaded worker model parallel capacity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-subagents-'));
  const output = [];
  let workers = 0; let peakWorkers = 0; let parentCalls = 0;
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
        await new Promise((resolve) => setTimeout(resolve, 30));
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
    semanticReviewer: { async review() { return { outcome: 'approve', confidence: 0.99, reason_code: 'delegation_matches_intent' }; } },
  });
  await engine.initialize();
  const result = await engine.submit({ request_id: 'parallel-exploration', content: 'Delegate two independent exploration agents.' }, 'operator');
  assert.equal(result.outcome, 'completed');
  assert.equal(peakWorkers, 2);
  const progress = output.filter((record) => record.type === 'subagent_progress');
  assert.equal(progress.filter((record) => record.phase === 'started').length, 2);
  assert.equal(progress.filter((record) => record.phase === 'returned').length, 2);
  assert.equal(progress.filter((record) => record.phase === 'returned').every((record) => record.text === 'Explored.'), true);
  assert.equal(engine.scheduler.snapshot().find((item) => item.resource === 'worker').discoveredLimit, 2);
  await engine.shutdown({ request_id: 'shutdown', type: 'shutdown' });
});

test('missing advertised parallel capacity preserves sequential subagent execution', async () => {
  const engine = {
    router: { resolve: () => ({ profile: { id: 'worker' }, model: 'worker' }) },
    modelRuntime: { resolve: async () => ({ parallelCapacity: null }) },
    scheduler: { setDiscoveredLimit(_resource, limit) { this.limit = limit; } },
  };
  assert.equal(await subagentParallelLimit(engine, 'subagent', new AbortController().signal), 1);
});

test('sub-agent status exposes routing and capacity without leaking profile labels', () => {
  const engine = {
    config: { executionManifest: null, limits: { providerConcurrency: 3 } },
    router: { resolve: () => ({ profile: { id: 'private-profile-label', endpoint: 'http://worker:1234/v1' }, model: 'worker-model' }) },
    tools: { definition: (name) => name === 'agent.run' ? {} : undefined },
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
  return { index, id, function: { name: 'agent.run', arguments: JSON.stringify(args) } };
}
