// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { LifecycleRegistry, StateAuthority } from '../src/lifecycle.js';
import { ProviderRunner } from '../src/provider/runner.js';
import { RecoverySupervisor } from '../src/reliability/recovery-supervisor.js';
import { ToolCallAssembler } from '../src/reliability/tool-call-assembler.js';

for (const fail of [false, true]) {
  test(`request telemetry reports attempt usage separately from turn totals (${fail ? 'failed' : 'succeeded'})`, async () => {
    const state = new StateAuthority();
    state.transition('preparing_turn', { trigger: 'test', turnId: 'usage-turn' });
    const lifecycles = new LifecycleRegistry();
    const turn = lifecycles.start('turn');
    const step = lifecycles.start('model_step', turn.id);
    const active = { turnId: 'usage-turn', stepId: step.id, controller: new AbortController(),
      cancelled: false, stepText: '', toolAssembler: new ToolCallAssembler(), providerTerminal: false,
      recovery: new RecoverySupervisor(), reasoningBytes: 0, stepReasoningBytes: 0,
      usage: { prompt_tokens: 100000, completion_tokens: 5000, total_tokens: 105000 } };
    const events = [];
    const runner = new ProviderRunner({ state, lifecycles, publish: async () => undefined,
      acceptText: async () => undefined, settleAttempt: async () => undefined,
      recordRecovery: async () => undefined,
      telemetry: { record: (name, status, detail) => events.push({ name, status, detail }) } });
    const usage = { prompt_tokens: 2000, completion_tokens: 30, total_tokens: 2030 };
    const provider = { async *stream() {
      yield { type: 'usage', usage };
      if (fail) throw Object.assign(new Error('rejected'), { code: 'provider_rejected' });
      yield { type: 'text', text: 'Done.' };
      yield { type: 'terminal', finishReason: 'stop' };
    } };
    if (fail) await assert.rejects(runner.run(provider, {}, { overallMs: 1000 }, active));
    else await runner.run(provider, {}, { overallMs: 1000 }, active);
    const event = events.find((item) => item.name === 'provider.request' && item.status === (fail ? 'failed' : 'succeeded'));
    assert.deepEqual(event.detail.usage, usage);
    assert.equal(active.usage.total_tokens, 107030);
    // Why pinned: queue wait and admission concurrency are the capacity facts
    // the scheduler-capacity and dream-candidate slices learn from; both
    // outcome records must carry them.
    assert.equal(typeof event.detail.queue_wait_ms, 'number');
    assert.ok(event.detail.queue_wait_ms >= 0);
    assert.equal(event.detail.admitted_concurrency, 1);
  });
}

test('a queued provider attempt records its queue wait and admission concurrency', async () => {
  const state = new StateAuthority();
  state.transition('preparing_turn', { trigger: 'test', turnId: 'queue-turn' });
  const lifecycles = new LifecycleRegistry();
  const turn = lifecycles.start('turn');
  const step = lifecycles.start('model_step', turn.id);
  const active = { sessionId: 'session_a', turnId: 'queue-turn', stepId: step.id, controller: new AbortController(),
    cancelled: false, stepText: '', toolAssembler: new ToolCallAssembler(), providerTerminal: false,
    recovery: new RecoverySupervisor(), reasoningBytes: 0, stepReasoningBytes: 0,
    providerResource: 'profile_a', usage: {} };
  const events = [];
  const runner = new ProviderRunner({ state, lifecycles, publish: async () => undefined,
    acceptText: async () => undefined, settleAttempt: async () => undefined,
    recordRecovery: async () => undefined,
    scheduler: { acquire: async (resource, owner, signal, onQueued) => {
      onQueued(1);
      await new Promise((resolve) => setTimeout(resolve, 15));
      return () => undefined;
    }, snapshot: () => [{ resource: 'profile_a', running: 1, limit: 1, discoveredLimit: null, queued: [] }] },
    telemetry: { record: (name, status, detail) => events.push({ name, status, detail }) } });
  const provider = { async *stream() {
    yield { type: 'usage', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
    yield { type: 'text', text: 'After queueing.' };
    yield { type: 'terminal', finishReason: 'stop' };
  } };
  await runner.run(provider, {}, { overallMs: 1000 }, active);
  const event = events.find((item) => item.name === 'provider.request' && item.status === 'succeeded');
  assert.ok(event.detail.queue_wait_ms >= 10, `queue_wait_ms: ${event.detail.queue_wait_ms}`);
  assert.equal(event.detail.admitted_concurrency, 1);
});
