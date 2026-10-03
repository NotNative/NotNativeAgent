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
  });
}
