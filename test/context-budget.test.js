// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { contextBudget, estimateContextTokens } from '../src/context-budget.js';
import { ModelRuntimeRegistry } from '../src/model-runtime.js';
import { OpenAICompatibleProvider } from '../src/provider.js';
import { FairScheduler } from '../src/fair-scheduler.js';

const route = Object.freeze({
  profile: { id: 'local' }, model: 'qwen', contextLimitBytes: null,
  maxOutputTokens: 8192, budget: 1,
});

test('LM Studio runtime discovery uses the loaded per-request window and parallel capacity', async () => {
  const seen = [];
  const provider = new OpenAICompatibleProvider({
    id: 'local', endpoint: 'http://127.0.0.1:1234/v1', model: 'qwen', trustZone: 'loopback', capabilities: {},
  }, {}, { fetch: async (url) => {
    seen.push(url);
    return jsonResponse({ models: [{ key: 'qwen', loaded_instances: [{
      id: 'qwen', config: { context_length: 131072, parallel: 4, max_output_tokens: 8192 },
    }] }] });
  } });
  const snapshot = await provider.runtimeSnapshot(new AbortController().signal);
  assert.equal(snapshot.contextWindowTokens, 131072);
  assert.equal(snapshot.parallelCapacity, 4);
  assert.equal(snapshot.source, 'lmstudio_v1');
  assert.deepEqual(seen, ['http://127.0.0.1:1234/api/v1/models']);
});

test('model runtime registry caches normalized discovery and degrades safely', async () => {
  let calls = 0;
  const registry = new ModelRuntimeRegistry({ ttlMs: 60_000, timeoutMs: 50 });
  const router = { provider: () => ({ runtimeSnapshot: async () => {
    calls += 1;
    return { contextWindowTokens: 65536, parallelCapacity: 2, source: 'lmstudio_v1' };
  } }) };
  const first = await registry.resolve(router, route, new AbortController().signal);
  const second = await registry.resolve(router, route, new AbortController().signal);
  assert.equal(first.contextWindowTokens, 65536);
  assert.equal(first.authoritative, true);
  assert.equal(second, first);
  assert.equal(calls, 1);

  const fallback = await new ModelRuntimeRegistry({ timeoutMs: 10 }).resolve({
    provider: () => ({ runtimeSnapshot: async () => new Promise(() => {}) }),
  }, route, new AbortController().signal);
  assert.equal(fallback.contextWindowTokens, null);
  assert.equal(fallback.source, 'declared');
});

test('context planning reserves output proportionally and never divides by parallelism', () => {
  const config = { limits: { maxContextBytes: 2_097_152, contextCompactionThreshold: 0.85 } };
  const budget = contextBudget(config, [route], {
    contextWindowTokens: 131072, outputLimitTokens: 8192,
    parallelCapacity: 4, source: 'lmstudio_v1',
  });
  assert.equal(budget.effectiveInputTokens, 122880);
  assert.equal(budget.thresholdTokens, 104448);
  assert.equal(budget.parallelCapacity, 4);
  assert.equal(budget.thresholdBytes, 313344);
  assert.ok(estimateContextTokens([{ role: 'user', content: 'hello' }]) > 0);
});

test('small local-model windows retain useful proportional input budgets', () => {
  const config = { limits: { maxContextBytes: 2_097_152, contextCompactionThreshold: 0.85 } };
  const small = contextBudget(config, [route], { contextWindowTokens: 8192, source: 'declared' });
  assert.equal(small.outputReserveTokens, 1024);
  assert.equal(small.effectiveInputTokens, 7168);
  assert.equal(small.thresholdTokens, 6092);

  const medium = contextBudget(config, [route], { contextWindowTokens: 32768, source: 'declared' });
  assert.equal(medium.outputReserveTokens, 4096);
  assert.equal(medium.effectiveInputTokens, 28672);
  assert.equal(medium.thresholdTokens, 24371);
});

test('loaded parallel capacity caps a provider resource without increasing the configured ceiling', async () => {
  const scheduler = new FairScheduler({ limit: 4 });
  const signal = new AbortController().signal;
  const first = await scheduler.acquire('local', 'one', signal, () => undefined, 1);
  let granted = false;
  const waiting = scheduler.acquire('local', 'two', signal, () => undefined, 1).then((release) => {
    granted = true; release();
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(granted, false);
  first();
  await waiting;
  assert.equal(granted, true);
});

test('authoritative discovered capacity can expand one shared provider resource', async () => {
  const scheduler = new FairScheduler({ limit: 1 });
  scheduler.setDiscoveredLimit('worker', 2);
  const signal = new AbortController().signal;
  const first = await scheduler.acquire('worker', 'one', signal, () => undefined, 2);
  const second = await scheduler.acquire('worker', 'two', signal, () => undefined, 2);
  assert.equal(scheduler.snapshot()[0].running, 2);
  first(); second();
});

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status, headers: { 'content-type': 'application/json' },
  });
}
