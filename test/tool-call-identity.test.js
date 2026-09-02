// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolCallAssembler } from '../src/reliability/tool-call-assembler.js';
import { deduplicateToolCallBatch } from '../src/reliability/tool-call-deduplication.js';
import { toolCallIdentity } from '../src/reliability/tool-call-identity.js';
import { setInitialCapabilityPhase } from '../src/engine/runtime-helpers.js';

test('streaming and execution layers agree on exact call equivalence', () => {
  for (const [a, b, equivalent] of [
    [{ b: [1, { x: true }], a: null }, { a: null, b: [1, { x: true }] }, true],
    [{ a: [1, 2] }, { a: [2, 1] }, false],
    [{ x: '1' }, { x: 1 }, false],
    [{ x: null }, {}, false],
  ]) {
    const assembler = new ToolCallAssembler();
    assembler.add([a, b].map((args, index) => ({ index, id: `call-${index}`,
      function: { name: 'fs.read', arguments: JSON.stringify(args) } })));
    assert.equal(assembler.hasEquivalentCompleteCalls, equivalent);
    assert.equal(deduplicateToolCallBatch(assembler.complete()).suppressed.length, equivalent ? 1 : 0);
  }
});

test('identity rejects cycles and excessive depth without stack overflow', () => {
  const cycle = {}; cycle.self = cycle;
  assert.equal(toolCallIdentity({ name: 'test', args: cycle }), null);
  assert.equal(toolCallIdentity({ name: 'test', args: { value: undefined } }), null);
  const assembler = new ToolCallAssembler();
  assembler.add([{ index: 0, id: 'deep', function: { name: 'test',
    arguments: '{"a":'.repeat(2000) + '0' + '}'.repeat(2000) } }]);
  assert.equal(assembler.hasEquivalentCompleteCalls, false);
  assert.equal(assembler.complete().length, 1);
});

test('capability phase does not infer monitoring policy from any prose', () => {
  for (const content of ['watchtower', 'monitor the logs', 'wait for me', 'read a file']) {
    const active = {};
    setInitialCapabilityPhase(active, content);
    assert.equal(active.capabilityPhase, 'orientation');
  }
});
