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
  assert.equal(reliability.health().status, 'ready');
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
  assert.equal(reasoning.reasoningMode, 'off');
  assert.equal(reasoning.action.action, 'retry_without_reasoning');
});
