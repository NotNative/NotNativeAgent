// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { ReliabilityEngine } from '../src/index.js';

test('Reliability Engine is the single owner facade for reliability components', async () => {
  const calls = [];
  const modelDialects = {
    async initialize() { calls.push('initialize'); },
    async close() { calls.push('close'); },
    instructions: () => 'dialect guidance',
    observe: (_route, outcome) => calls.push(outcome.status),
    snapshot: () => ({ family: 'qwen' }),
  };
  const continuationCompactor = {
    refine: async (fact) => ({ ...fact, refined: true }),
    handoff: async (fact) => ({ ...fact, handoff: true }),
  };
  const reliability = new ReliabilityEngine({ modelDialects, continuationCompactor });

  await reliability.initialize();
  const supervisor = reliability.createTurnSupervisor({ localLimit: 2, ladder: ['nudge'] });
  assert.equal(supervisor.localLimit, 2);
  assert.equal(reliability.instructions({ model: 'qwen' }), 'dialect guidance');
  reliability.observe({}, { status: 'succeeded' });
  assert.deepEqual(reliability.modelSnapshot({}), { family: 'qwen' });
  assert.deepEqual(await reliability.refineContinuation({ value: 1 }), { value: 1, refined: true });
  assert.deepEqual(await reliability.createHandoff({ value: 1 }), { value: 1, handoff: true });
  assert.equal(reliability.hostEnvironment('win32').nativeShell, 'powershell');
  assert.match(reliability.hostEnvironmentInstruction('darwin'), /macOS \(darwin\).*POSIX sh/u);
  assert.match(reliability.shellToolGuidance('linux'), /auto resolves to POSIX sh/u);
  assert.match(reliability.unavailableShellMessage('sh', 'win32'), /Use shell auto with PowerShell syntax/u);
  assert.deepEqual(reliability.shellReliabilitySignals('a; for f in x; do echo "$(wc -l < "$f")"; done'), [
    'many_operations', 'loop_with_substitution',
  ]);
  assert.equal(reliability.normalizeShellExecutionError({ code: 'ENOENT' }, 'sh', 'win32').code, 'shell_interpreter_unavailable');
  assert.equal(reliability.inlineInterpreterInvocation('node', ['-e', 'process.exit(1)']), true);
  assert.match(reliability.inlineInterpreterGuidance(), /ref\.store.*stdin_ref/u);
  assert.equal(reliability.health().status, 'ready');
  assert.equal(reliability.health().host_command_shaping, true);
  assert.equal(reliability.health().command_shaping, true);
  await reliability.close();

  assert.deepEqual(calls, ['initialize', 'succeeded', 'close']);
});

test('Reliability Engine returns bounded provider recovery decisions without executing lifecycle work', () => {
  const reliability = new ReliabilityEngine({
    modelDialects: { initialize() {}, close() {}, instructions() {}, observe() {}, snapshot() {} },
    continuationCompactor: { refine() {}, handoff() {} },
  });
  const supervisor = reliability.createTurnSupervisor({ localLimit: 3, ladder: ['nudge'] });
  const active = {
    stepText: '', stepReasoningBytes: 12, reasoningFallbackUsed: false,
    toolAssembler: { size: 0 }, runtimeModel: { parallelCapacity: 4 }, recovery: supervisor,
  };

  const context = reliability.providerContextLimit(active);
  assert.equal(context.continue, true);
  assert.equal(context.scale, 0.25);
  const reasoning = reliability.reasoningOnly(active);
  assert.equal(reasoning.reasoningMode, 'preserve');
  assert.equal(reasoning.action.action, 'retry_reasoning_to_action');
  active.reasoningHeadroomRetryUsed = true;
  assert.equal(reliability.reasoningOnly(active), null);
  active.reasoningHeadroomRetryUsed = false;
  active.finishReason = 'length';
  const truncated = reliability.reasoningOnly(active);
  assert.equal(truncated.reasoningMode, 'preserve');
  assert.equal(truncated.action.action, 'retry_reasoning_to_action');
  const retry = reliability.providerRetry(active, 'provider_transient', 0, false, 12_000);
  assert.equal(retry.delayMs, 12_000);
});

test('Reliability Engine records cache evidence only for the observed provider and model route', () => {
  const reliability = new ReliabilityEngine({
    modelDialects: { initialize() {}, close() {}, instructions() {}, observe() {}, snapshot() {} },
    continuationCompactor: { refine() {}, handoff() {} },
  });
  const route = { profile: { id: 'local' }, model: 'qwen' };

  assert.equal(reliability.observeProviderUsage(route, { prompt_cache_hit_tokens: 0 }), false);
  assert.equal(reliability.cacheUsage(route), null);
  assert.equal(reliability.observeProviderUsage(route, { prompt_cache_hit_tokens: 2048 }), true);
  assert.deepEqual(reliability.cacheUsage(route), { cache_read_tokens: 2048 });
  assert.equal(reliability.cacheUsage({ profile: { id: 'local' }, model: 'other' }), null);
  assert.equal(reliability.cacheUsage({ profile: { id: 'other' }, model: 'qwen' }), null);
});

test('Reliability Engine tightens future context budgets from provider-reported prompt usage', () => {
  const reliability = new ReliabilityEngine({
    modelDialects: { initialize() {}, close() {}, instructions() {}, observe() {}, snapshot() {} },
    continuationCompactor: { refine() {}, handoff() {} },
  });
  const route = { profile: { id: 'local' }, model: 'multilingual' };
  assert.equal(reliability.observeProviderUsage(route, { prompt_tokens: 2_000 }, {
    envelope: { estimated_input_tokens: 1_000 },
  }), true);
  assert.equal(reliability.contextEstimateScale(route), 2);
  const budget = reliability.planContextBudget({ limits: {
    maxContextBytes: 2_097_152, contextCompactionThreshold: 0.75,
  } }, [route], { contextWindowTokens: 10_000, outputLimitTokens: 1_000 });
  assert.equal(budget.estimateScale, 2);
  assert.equal(budget.scaledTokens, Math.floor(budget.thresholdTokens / 2));

  reliability.observeProviderUsage(route, { prompt_tokens: 500 }, {
    envelope: { estimated_input_tokens: 1_000 },
  });
  assert.equal(reliability.contextEstimateScale(route), 2);
});

test('provider context recovery permits one evidence-gated smaller retry and remains bounded', () => {
  const reliability = new ReliabilityEngine({
    modelDialects: { initialize() {}, close() {}, instructions() {}, observe() {}, snapshot() {} },
    continuationCompactor: { refine() {}, handoff() {} },
  });
  const active = {
    stepText: '', toolAssembler: { size: 0 }, runtimeModel: { parallelCapacity: 1 },
    recovery: reliability.createTurnSupervisor(),
    attemptRequestManifest: { envelope: { estimated_input_tokens: 1_000 } },
  };
  assert.equal(reliability.providerContextLimit(active).scale, 0.75);
  active.attemptRequestManifest = { envelope: { estimated_input_tokens: 800 } };
  assert.equal(reliability.providerContextLimit(active).scale, 0.375);
  active.attemptRequestManifest = { envelope: { estimated_input_tokens: 700 } };
  assert.equal(reliability.providerContextLimit(active).continue, false);

  const unchanged = { ...active, recovery: reliability.createTurnSupervisor() };
  unchanged.attemptRequestManifest = { envelope: { estimated_input_tokens: 1_000 } };
  assert.equal(reliability.providerContextLimit(unchanged).continue, true);
  assert.equal(reliability.providerContextLimit(unchanged).continue, false);
});

test('Reliability Engine accepts normalized cache counters and rejects incomplete route identity', () => {
  const reliability = new ReliabilityEngine({
    modelDialects: { initialize() {}, close() {}, instructions() {}, observe() {}, snapshot() {} },
    continuationCompactor: { refine() {}, handoff() {} },
  });

  assert.equal(reliability.observeProviderUsage({ providerProfile: 'local', model: 'qwen' }, {
    cache_read_tokens: 128, cached_tokens: 64,
  }), true);
  assert.deepEqual(reliability.cacheUsage({ providerProfile: 'local', model: 'qwen' }), {
    cache_read_tokens: 128,
  });
  assert.equal(reliability.observeProviderUsage({ providerProfile: 'local' }, { cache_read_tokens: 128 }), false);
  assert.equal(reliability.observeProviderUsage({ model: 'qwen' }, { cache_read_tokens: 128 }), false);
});
