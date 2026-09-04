// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeGatewayConfig } from '../src/gateway/config.js';
import { MemoryBoundary } from '../src/memory.js';
import { shellReliabilitySignals } from '../src/reliability/host-environment.js';
import { appendReasoningChunk } from '../src/reliability/reasoning-continuity.js';
import { ModelDialectRegistry } from '../src/reliability/model-dialects.js';

test('gateway identity list rejects scalar containers with a typed error', () => {
  for (const ids of [42, '42', {}]) assert.throws(() => normalizeGatewayConfig({ authorized_user_ids: ids }),
    { code: 'gateway_config_invalid' });
  assert.deepEqual(normalizeGatewayConfig({ authorized_user_ids: [42, 7, 42] }).authorized_user_ids, ['42', '7']);
});

test('partial memory configuration uses bounded defaults and boolean enablement', async () => {
  const memory = new MemoryBoundary({ enabled: true }, { query: async ({ signal }) => {
    await new Promise((resolve) => setTimeout(resolve, 15)); assert.equal(signal.aborted, false);
    return [{ id: 'm1', scope: 'user', content: 'remember' }];
  } });
  assert.equal((await memory.recall('query', '.')).items.length, 1);
  assert.equal(new MemoryBoundary({}, {}).enabled, false);
  assert.equal(new MemoryBoundary({ enabled: 'yes' }, {}).enabled, false);
});

test('memory admission completion cannot return cancelled or superseded recall', async () => {
  let release; let entered;
  const ready = new Promise((resolve) => { entered = resolve; });
  const memory = new MemoryBoundary({ enabled: true, timeoutMs: 1000, maxItems: 8, maxBytes: 16384 },
    { query: async () => [] }, { grounding: { admitMemory: async () => {
      entered(); await new Promise((resolve) => { release = resolve; }); return { admitted: [], rejected: [] };
    } } });
  const controller = new AbortController();
  const recall = memory.recall('query', '.', controller.signal);
  await ready; controller.abort(); release();
  assert.equal((await recall).status, 'late_discarded');
});

test('shell advisory tolerates absent and nontext input', () => {
  for (const script of [undefined, null, 42, {}]) assert.deepEqual(shellReliabilitySignals(script), []);
});

test('reasoning overflow sentinel cannot restart capture', () => {
  assert.equal(appendReasoningChunk('', 'x'.repeat(262145)), null);
  assert.equal(appendReasoningChunk(null, 'suffix'), null);
  assert.equal(appendReasoningChunk(null, ''), null);
  assert.equal(appendReasoningChunk(undefined, 'start'), 'start');
});

test('malformed dialect observations are ignored without profile mutation', () => {
  const registry = new ModelDialectRegistry();
  for (const outcome of [undefined, null, {}, { status: 'typo' }]) {
    assert.equal(registry.observe({}, outcome), false);
    assert.equal(registry.profiles.size, 0); assert.equal(registry.dirty, false);
  }
});

test('corrupted tool-learning candidates are discarded before updating counts', () => {
  for (const malformed of [null, 3, 'bad', {}, { failures: '2', validated_repairs: 0 }]) {
    const registry = new ModelDialectRegistry(); const route = { providerId: 'p', model: 'm' };
    registry.observe(route, { status: 'succeeded' });
    const profile = registry.profiles.get('p/m');
    profile.tool_contract_learning.candidates['fs.read@1/tool_schema_invalid'] = malformed;
    assert.equal(registry.observeToolContract(route, { status: 'failed', tool: 'fs.read', version: 1 }), true);
    assert.equal(registry.snapshot(route).tool_contract_learning.candidates['fs.read@1/tool_schema_invalid'].failures, 1);
  }
});
