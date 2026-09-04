// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { contextBudget, estimateContextTokens } from '../src/reliability/context-budget.js';
import { ModelRuntimeRegistry } from '../src/provider/model-runtime.js';
import { OpenAICompatibleProvider } from '../src/provider.js';
import { FairScheduler } from '../src/provider/fair-scheduler.js';

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

test('LM Studio runtime discovery accepts a model maximum without a loaded instance', async () => {
  const provider = new OpenAICompatibleProvider({
    id: 'local', endpoint: 'http://127.0.0.1:1234/v1', model: 'qwen', trustZone: 'loopback', capabilities: {},
  }, {}, { fetch: async () => jsonResponse({
    models: [{ key: 'qwen', max_context_length: 262144, loaded_instances: [] }],
  }) });
  const snapshot = await provider.runtimeSnapshot(new AbortController().signal);
  assert.equal(snapshot.contextWindowTokens, 262144);
  assert.equal(snapshot.source, 'lmstudio_v1');
});

test('OpenAI-compatible model cards normalize common context and output limit fields', async () => {
  const cases = [
    [{ max_model_len: 262144 }, 262144, null],
    [{ context_window: 131072, max_completion_tokens: 16384 }, 131072, 16384],
    [{ max_context_length: 65536, output_token_limit: 8192 }, 65536, 8192],
    [{ max_total_tokens: 32768, max_new_tokens: 4096 }, 32768, 4096],
    [{ meta: { n_ctx_train: 16384 } }, 16384, null],
    [{ top_provider: { context_length: 1000000, max_completion_tokens: 32768 }, context_length: 2000000 },
      1000000, 32768],
  ];
  for (const [fields, expectedContext, expectedOutput] of cases) {
    const provider = new OpenAICompatibleProvider({
      id: 'remote', endpoint: 'https://provider.example/v1', model: 'qwen',
      trustZone: 'public_network', capabilities: {},
    }, {}, { fetch: async () => jsonResponse({ data: [{ id: 'qwen', ...fields }] }) });
    const snapshot = await provider.runtimeSnapshot(new AbortController().signal);
    assert.equal(snapshot.contextWindowTokens, expectedContext);
    assert.equal(snapshot.outputLimitTokens, expectedOutput);
    assert.equal(snapshot.source, 'openai_models');
  }
});

test('model-card input-only limits and malformed aliases do not become total context', async () => {
  const provider = new OpenAICompatibleProvider({
    id: 'remote', endpoint: 'https://provider.example/v1', model: 'qwen',
    trustZone: 'public_network', capabilities: {},
  }, {}, { fetch: async () => jsonResponse({ data: [{
    id: 'qwen', max_input_tokens: 120000, max_model_len: '262144', max_output_tokens: -1,
  }] }) });
  const snapshot = await provider.runtimeSnapshot(new AbortController().signal);
  assert.equal(snapshot.contextWindowTokens, null);
  assert.equal(snapshot.outputLimitTokens, null);
});

test('generic model discovery matches provider-qualified model identifiers', async () => {
  const provider = new OpenAICompatibleProvider({
    id: 'remote', endpoint: 'https://provider.example/v1', model: 'qwen',
    trustZone: 'public_network', capabilities: {},
  }, {}, { fetch: async () => jsonResponse({ data: [{
    id: 'publisher/qwen', max_model_len: 262144,
  }] }) });
  const snapshot = await provider.runtimeSnapshot(new AbortController().signal);
  assert.equal(snapshot.contextWindowTokens, 262144);
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

test('recognized OpenAI-compatible model-card limits are authoritative provider facts', async () => {
  const registry = new ModelRuntimeRegistry();
  const found = await registry.resolve({
    provider: () => ({ runtimeSnapshot: async () => ({
      contextWindowTokens: 262144, outputLimitTokens: 32768, source: 'openai_models',
    }) }),
  }, route, new AbortController().signal);
  assert.equal(found.authoritative, true);
});

test('context planning honors configured thresholds and never divides by parallelism', () => {
  const config = { limits: {
    maxContextBytes: 2_097_152, contextCompressionThreshold: 0.40, contextCompactionThreshold: 0.85,
  } };
  const budget = contextBudget(config, [route], {
    contextWindowTokens: 131072, outputLimitTokens: 8192,
    parallelCapacity: 4, source: 'lmstudio_v1',
  });
  assert.equal(budget.effectiveInputTokens, 122880);
  assert.equal(budget.thresholdTokens, 104448);
  assert.equal(budget.parallelCapacity, 4);
  assert.equal(budget.thresholdBytes, 313344);
  assert.equal(budget.compactionThreshold, 0.85);
  assert.equal(budget.compressionThreshold, 0.40);
  assert.ok(estimateContextTokens([{ role: 'user', content: 'hello' }]) > 0);
});

test('fallback token estimation does not undercount non-ASCII UTF-16 units', () => {
  const cjk = estimateContextTokens([{ role: 'user', content: '界'.repeat(300) }]);
  const combining = estimateContextTokens([{ role: 'user', content: '\u0301'.repeat(300) }]);
  const emoji = estimateContextTokens([{ role: 'user', content: '😀'.repeat(300) }]);
  assert.ok(cjk >= 308);
  assert.ok(combining >= 308);
  assert.ok(emoji >= 608);
  assert.ok(estimateContextTokens([{ role: 'user', content: 'a'.repeat(300) }]) < 200);
});

test('context planning applies a bounded conservative provider usage calibration', () => {
  const config = { limits: { maxContextBytes: 2_097_152, contextCompactionThreshold: 0.8 } };
  const baseline = contextBudget(config, [route], {
    contextWindowTokens: 10_000, outputLimitTokens: 1_000, source: 'declared',
  });
  const calibrated = contextBudget(config, [route], {
    contextWindowTokens: 10_000, outputLimitTokens: 1_000, source: 'declared',
  }, 1, 2);
  assert.equal(calibrated.estimateScale, 2);
  assert.equal(calibrated.scaledTokens, Math.floor(baseline.scaledTokens / 2));
  assert.equal(contextBudget(config, [route], { contextWindowTokens: 10_000 }, 1, 0.25).estimateScale, 1);
  assert.equal(contextBudget(config, [route], { contextWindowTokens: 10_000 }, 1, 100).estimateScale, 8);
});

test('unknown provider windows use a conservative planning window instead of disabling pressure', () => {
  const config = { limits: { maxContextBytes: 2_097_152, contextCompactionThreshold: 0.75 } };
  const budget = contextBudget(config, [route], { contextWindowTokens: null, source: 'declared' });
  assert.equal(budget.windowTokens, 65_536);
  assert.equal(budget.effectiveInputTokens, 57_344);
  assert.equal(budget.thresholdTokens, 43_008);
  assert.equal(budget.source, 'conservative_unknown');
});

test('small local-model windows retain useful proportional input budgets', () => {
  const config = { limits: { maxContextBytes: 2_097_152, contextCompactionThreshold: 0.85 } };
  const small = contextBudget(config, [route], { contextWindowTokens: 8192, source: 'declared' });
  assert.equal(small.outputReserveTokens, 2048);
  assert.equal(small.effectiveInputTokens, 6144);
  assert.equal(small.thresholdTokens, 5222);

  const medium = contextBudget(config, [route], { contextWindowTokens: 32768, source: 'declared' });
  assert.equal(medium.outputReserveTokens, 8192);
  assert.equal(medium.effectiveInputTokens, 24576);
  assert.equal(medium.thresholdTokens, 20889);
});

test('large reasoning-capable windows reserve the full default completion headroom', () => {
  const config = { limits: { maxContextBytes: 2_097_152, contextCompactionThreshold: 0.85 } };
  const unrestricted = { ...route, maxOutputTokens: 32_000 };
  const budget = contextBudget(config, [unrestricted], {
    contextWindowTokens: 131072, outputLimitTokens: 32_000, source: 'lmstudio_v1',
  });
  assert.equal(budget.outputReserveTokens, 32_000);
  assert.equal(budget.effectiveInputTokens, 99_072);
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

test('discovered provider capacity is bounded and can be cleared', () => {
  const scheduler = new FairScheduler({ limit: 3 });
  assert.throws(() => scheduler.setDiscoveredLimit('worker', 17), { code: 'scheduler_resource_limit_invalid' });
  scheduler.setDiscoveredLimit('worker', 2);
  scheduler.setDiscoveredLimit('worker', null);
  assert.deepEqual(scheduler.snapshot().map((item) => [item.limit, item.discoveredLimit]), [[3, null]]);
});

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status, headers: { 'content-type': 'application/json' },
  });
}
