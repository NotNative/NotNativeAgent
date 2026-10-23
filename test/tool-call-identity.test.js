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
      function: { name: 'fs_read', arguments: JSON.stringify(args) } })));
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

test('empty arguments are executable objects and scalar JSON is malformed', () => {
  const empty = new ToolCallAssembler();
  empty.add([{ index: 0, id: 'empty-0', function: { name: 'system_time', arguments: '' } },
    { index: 1, id: 'empty-1', function: { name: 'system_time', arguments: '  ' } }]);
  assert.equal(empty.hasEquivalentCompleteCalls, false,
    'blank argument streams remain incomplete until the provider ends the message');
  assert.deepEqual(empty.complete('tool_calls').map((call) => call.args), [{}, {}]);
  empty.add([{ index: 0, function: { arguments: '{"zone":"UTC"}' } }]);
  assert.deepEqual(empty.complete('tool_calls').map((call) => call.args), [{ zone: 'UTC' }, {}]);
  for (const literal of ['null', '42', '[1,2]', '"text"']) {
    const invalid = new ToolCallAssembler();
    invalid.add([{ index: 0, id: 'scalar', function: { name: 'system_time', arguments: literal } }]);
    assert.equal(invalid.complete('tool_calls')[0].invalid.code, 'tool_arguments_malformed');
    assert.equal(invalid.hasEquivalentCompleteCalls, false);
  }
});

test('tool names accept deltas, repeated names, and cumulative names under a byte bound', () => {
  for (const pieces of [['fs_', 'read'], ['fs_read', 'fs_read'], ['fs_', 'fs_read']]) {
    const assembler = new ToolCallAssembler();
    assembler.add([{ index: 0, id: 'name', function: { name: pieces[0], arguments: '{}' } }]);
    assembler.add([{ index: 0, function: { name: pieces[1] } }]);
    assert.equal(assembler.complete('tool_calls')[0].name, 'fs_read');
  }
  const nameBound = new ToolCallAssembler();
  assert.throws(() => nameBound.add([{ index: 0, id: 'name', function: { name: 'x'.repeat(513) } }]),
    { code: 'tool_name_too_large' });
  assert.equal(nameBound.size, 0);
  const idBound = new ToolCallAssembler();
  assert.throws(() => idBound.add([{ index: 0, id: 'x'.repeat(513), function: { name: 'fs_read' } }]),
    { code: 'tool_provider_call_id_too_large' });
  assert.equal(idBound.size, 0);
});

test('rejected fragments leave earlier calls and the duplicate cache unchanged', () => {
  const assembler = new ToolCallAssembler();
  assembler.add([{ index: 0, id: 'prior', function: { name: 'fs_read', arguments: '{}' } }]);
  assert.equal(assembler.hasEquivalentCompleteCalls, false);
  assert.throws(() => assembler.add([
    { index: 1, id: 'staged', function: { name: 'fs_read', arguments: '{}' } },
    { index: 0, function: { name: 'fs_read', arguments: 'x'.repeat(262_145) } },
  ]), { code: 'tool_arguments_too_large' });
  assert.equal(assembler.size, 1);
  assert.equal(assembler.complete('tool_calls')[0].name, 'fs_read');
  assert.equal(assembler.hasEquivalentCompleteCalls, false);
  assembler.add([{ index: 1, id: 'healthy', function: { name: 'fs_read', arguments: '{}' } }]);
  assert.equal(assembler.hasEquivalentCompleteCalls, true);
});

test('equivalent parsed objects tolerate formatted JSON but reject a partial stream', () => {
  const formatted = new ToolCallAssembler();
  formatted.add([{ index: 0, id: 'format', function: { name: 'fs_read', arguments: '{\n  "path": "x"\n}' } }]);
  formatted.add([{ index: 0, function: { arguments: { path: 'x' } } }]);
  assert.deepEqual(formatted.complete('tool_calls')[0].args, { path: 'x' });
  formatted.add([{ index: 0, function: { arguments: '  {"path":"x"}\n' } }]);
  assert.deepEqual(formatted.complete('tool_calls')[0].args, { path: 'x' });
  const partial = new ToolCallAssembler();
  partial.add([{ index: 0, id: 'partial', function: { name: 'fs_read', arguments: '{"path":' } }]);
  assert.throws(() => partial.add([{ index: 0, function: { arguments: { path: 'x' } } }]),
    { code: 'tool_arguments_transport_drift' });
});

test('capability phase does not infer monitoring policy from any prose', () => {
  for (const content of ['watchtower', 'monitor the logs', 'wait for me', 'read a file']) {
    const active = {};
    setInitialCapabilityPhase(active, content);
    assert.equal(active.capabilityPhase, 'orientation');
  }
});
