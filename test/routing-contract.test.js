// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveManifest } from '../src/config.js';
import { ModelRouter } from '../src/router.js';
import { manifestFromConfig } from '../src/route-configuration.js';
import { SessionEngine } from '../src/engine.js';
import { EventHub } from '../src/events.js';
import { CapabilityCache } from '../src/capability-cache.js';
import { declaredSubscription } from './event-fixture.js';

const providers = [
  {
    id: 'lan', endpoint: 'http://192.168.1.10:1234/v1', model: 'general', trust_zone: 'private_network',
    capabilities: { tools: true, images: false, structured_output: true },
  },
  {
    id: 'local-vision', endpoint: 'http://127.0.0.1:1234/v1', model: 'vision', trust_zone: 'loopback',
    capabilities: { tools: false, images: true },
  },
  {
    id: 'public', endpoint: 'https://models.example.test/v1', model: 'remote', trust_zone: 'public_network',
    capabilities: { tools: true, images: true },
  },
];

test('AC-ROUTE-01 validates role settings and returns bounded capability-eligible candidates', () => {
  const config = resolveManifest({ providers, routes: {
    primary: { provider_id: 'lan', required_capabilities: ['tools'], temperature: 0.3, budget: 4 },
    vision: { provider_id: 'lan', required_capabilities: ['images'], fallbacks: ['subagent'] },
    subagent: { provider_id: 'local-vision' },
  } });
  const candidates = new ModelRouter(config).candidates('vision', { logicalRequestId: 'logical-1' });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].profile.id, 'local-vision');
  assert.equal(candidates[0].fallback, true);
  assert.equal(candidates[0].logicalRequestId, 'logical-1');
  assert.equal(config.routes.primary.temperature, 0.3);
  assert.equal(config.routes.primary.budget, 4);
  assert.deepEqual(manifestFromConfig(config).routes.vision.required_capabilities, ['images']);
});

test('AC-TURN-07 route and provider context limits survive configuration round trips', () => {
  const config = resolveManifest({
    context_limit_bytes: 1_000_000,
    context_compression_threshold: 0.35,
    context_compression_level_2_threshold: 0.50,
    context_compression_level_3_threshold: 0.68,
    context_compaction_threshold: 0.8,
    providers: [{ ...providers[0], context_limit_bytes: 400_000, output_limit_tokens: 4096 }],
    routes: { primary: { provider_id: 'lan', context_limit_bytes: 250_000 } },
  });
  const candidate = new ModelRouter(config).resolve('primary');
  assert.equal(candidate.contextLimitBytes, 250_000);
  const manifest = manifestFromConfig(config);
  assert.equal(manifest.context_compression_threshold, 0.35);
  assert.equal(manifest.context_compression_level_2_threshold, 0.50);
  assert.equal(manifest.context_compression_level_3_threshold, 0.68);
  assert.equal(manifest.context_compaction_threshold, 0.8);
  assert.equal(manifest.providers[0].context_limit_bytes, 400_000);
  assert.equal(manifest.providers[0].output_limit_tokens, 4096);
  assert.equal(manifest.routes.primary.context_limit_bytes, 250_000);
  assert.equal(candidate.maxOutputTokens, 4096);
});

test('legacy two-boundary context settings derive ordered compression levels', () => {
  const config = resolveManifest({
    context_compression_threshold: 0.30,
    context_compaction_threshold: 0.79,
    providers,
  });
  assert.equal(config.limits.contextCompressionLevel2Threshold, 0.51);
  assert.equal(config.limits.contextCompressionLevel3Threshold, 0.72);
  assert.throws(() => resolveManifest({
    context_compression_threshold: 0.40,
    context_compression_level_2_threshold: 0.69,
    context_compression_level_3_threshold: 0.60,
    context_compaction_threshold: 0.75,
    providers,
  }), { code: 'context_thresholds_invalid' });
});

test('AC-FAIL-02/AC-PERF-05 runtime deadlines and concurrency are independently bounded and durable', () => {
  const config = resolveManifest({
    providers, provider_connect_timeout_ms: 2500, semantic_review_timeout_ms: 3000,
    approval_timeout_ms: 90_000, provider_concurrency: 2, provider_queue_limit: 64,
    tool_concurrency: 3,
  });
  assert.deepEqual({
    connect: config.limits.connectMs, reviewer: config.limits.semanticReviewMs,
    approval: config.limits.approvalMs, providers: config.limits.providerConcurrency,
    queue: config.limits.providerQueueLimit, tools: config.limits.toolConcurrency,
  }, { connect: 2500, reviewer: 3000, approval: 90_000, providers: 2, queue: 64, tools: 3 });
  const manifest = manifestFromConfig(config);
  assert.equal(manifest.provider_connect_timeout_ms, 2500);
  assert.equal(manifest.tool_concurrency, 3);
  let adapterLimits;
  const router = new ModelRouter(config, (_profile, limits) => { adapterLimits = limits; return {}; });
  router.provider(router.resolve('primary'));
  assert.equal(adapterLimits.connectMs, 2500);
  assert.throws(() => resolveManifest({ providers, tool_concurrency: 17 }), { code: 'invalid_limit' });
});

test('provider and route deadlines preserve explicit values without legacy inference', () => {
  const config = resolveManifest({
    providers, provider_timeout_ms: 120_000, first_token_timeout_ms: 30_000, idle_timeout_ms: 45_000,
    routes: { primary: { deadline_ms: 120_000 } },
  });
  assert.equal(config.limits.providerMs, 120_000);
  assert.equal(config.limits.providerOverrideMs, 120_000);
  assert.equal(manifestFromConfig(config).provider_timeout_ms, 120_000);
  assert.equal(config.limits.firstTokenMs, 600_000);
  assert.equal(config.limits.idleMs, 300_000);
  assert.equal(config.routes.primary.deadlineMs, 120_000);
  assert.equal(config.routes.primary.deadlineOverrideMs, 120_000);
  assert.equal(manifestFromConfig(config).routes.primary.deadline_ms, 120_000);
  const custom = resolveManifest({
    providers, provider_timeout_ms: 121_000, first_token_timeout_ms: 30_000, idle_timeout_ms: 45_000,
  });
  assert.equal(custom.limits.providerMs, 121_000);
  assert.equal(custom.limits.firstTokenMs, 600_000);
  assert.equal(custom.limits.idleMs, 300_000);
  const customRoute = resolveManifest({
    providers, provider_timeout_ms: 1_800_000, routes: { primary: { deadline_ms: 121_000 } },
  });
  assert.equal(customRoute.routes.primary.deadlineMs, 121_000);
  assert.equal(customRoute.routes.primary.deadlineOverrideMs, 121_000);
  assert.equal(manifestFromConfig(customRoute).routes.primary.deadline_ms, 121_000);
  const fullyCustom = resolveManifest({
    providers, provider_timeout_ms: 121_000, first_token_timeout_ms: 31_000, idle_timeout_ms: 46_000,
  });
  assert.equal(fullyCustom.limits.providerMs, 121_000);
  assert.equal(fullyCustom.limits.firstTokenMs, 31_000);
  assert.equal(fullyCustom.limits.idleMs, 46_000);
});

test('semantic review inherits the provider deadline and migrates the legacy fifteen-second default', () => {
  const defaults = resolveManifest({ providers });
  assert.equal(defaults.limits.providerOverrideMs, null);
  assert.equal(manifestFromConfig(defaults).provider_timeout_ms, undefined);
  assert.equal(defaults.limits.semanticReviewMs, defaults.limits.providerMs);
  assert.equal(defaults.limits.semanticReviewMs, 1_800_000);

  const migrated = resolveManifest({ providers, semantic_review_timeout_ms: 15_000 });
  assert.equal(migrated.limits.semanticReviewMs, 1_800_000);

  const explicit = resolveManifest({ providers, semantic_review_timeout_ms: 15_001 });
  assert.equal(explicit.limits.semanticReviewMs, 15_001);
});

test('AC-ROUTE-06 capability cache invalidates on endpoint, model, override, and configuration version', () => {
  const cache = new CapabilityCache();
  const base = { profile: { id: 'primary', endpoint: 'http://127.0.0.1:1/v1' }, model: 'model-a' };
  cache.record(base, 'image_input', 1, false);
  assert.equal(cache.get(base, 'image_input', 1), false);
  assert.equal(cache.get({ ...base, model: 'model-b' }, 'image_input', 1), 'unknown');
  assert.equal(cache.get({ ...base, profile: { ...base.profile, endpoint: 'http://127.0.0.1:2/v1' } }, 'image_input', 1), 'unknown');
  assert.equal(cache.get(base, 'image_input', 2), 'unknown');
  cache.invalidate();
  assert.equal(cache.get(base, 'image_input', 1), 'unknown');
});

test('AC-ROUTE-02 fallback never silently crosses to a less trusted endpoint', () => {
  const config = resolveManifest({ providers, routes: {
    primary: { provider_id: 'local-vision', required_capabilities: ['tools'], fallbacks: ['reviewer'] },
    reviewer: { provider_id: 'public' },
  } });
  assert.throws(() => new ModelRouter(config).resolve('primary'), { code: 'route_capability_unavailable' });
});

test('AC-ROUTE-01 rejects recursive route graphs and malformed capability requirements', () => {
  assert.throws(() => resolveManifest({ providers, routes: {
    primary: { provider_id: 'lan', fallbacks: ['reviewer'] },
    reviewer: { provider_id: 'lan', fallbacks: ['vision'] },
    vision: { provider_id: 'local-vision', fallbacks: ['primary'] },
  } }), { code: 'route_cycle' });
  assert.throws(() => resolveManifest({ providers, routes: {
    primary: { provider_id: 'lan', required_capabilities: ['telepathy'] },
  } }), { code: 'invalid_route_capability' });
});

test('AC-ROUTE-05 classified failure falls back without partial output and preserves logical identity', async () => {
  const fallbackProvider = { ...providers[1], capabilities: { tools: true, images: true } };
  const config = resolveManifest({ persistence: 'ephemeral', providers: [providers[0], fallbackProvider], routes: {
    primary: { provider_id: 'lan', required_capabilities: ['tools'], fallbacks: ['subagent'], budget: 2 },
    subagent: { provider_id: 'local-vision' },
  } });
  const calls = [];
  const events = [];
  const hub = new EventHub();
  hub.register(declaredSubscription({
    id: 'attempt-observer', category: 'provider_attempt', phase: 'active', blocking: true,
    priority: 100, timeoutMs: 1000, failurePolicy: 'continue',
  }), async (event) => { events.push(event); return { decision: 'continue' }; });
  const engine = new SessionEngine({ config, events: hub, providerFactory: (profile) => ({
    async *stream() {
      calls.push(profile.id);
      if (profile.id === 'lan') throw Object.assign(new Error('temporary'), { code: 'provider_transient', retryable: true });
      yield { type: 'text', text: 'fallback complete' };
      yield { type: 'terminal' };
    },
  }) });
  await engine.initialize();
  const result = await engine.submit({ request_id: 'route-fallback', content: 'Complete the task.' }, 'operator');
  assert.equal(result.outcome, 'completed');
  assert.equal(result.text, 'fallback complete');
  assert.deepEqual(calls, ['lan', 'lan', 'lan', 'local-vision']);
  const attempts = events.filter((event) => event.event_name === 'provider_attempt.started');
  assert.equal(new Set(attempts.map((event) => event.logical_request_id)).size, 1);
  assert.equal(attempts.length, 4);
  await engine.shutdown({ request_id: 'shutdown' });
});
