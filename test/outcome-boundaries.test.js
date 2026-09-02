// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventHub } from '../src/events.js';
import { ToolGovernor, toolSettlementTerminal } from '../src/tools/governor.js';
import { evaluateCompletion } from '../src/reliability/completion-supervisor.js';
import { finalizeEngineTurn } from '../src/engine/finalization.js';

async function execute(raw) {
  const governor = new ToolGovernor({ events: new EventHub(), reviewer: {}, registry: {
    definition: () => ({ timeoutMs: 1000, maxOutputBytes: 4096, sideEffect: 'unknown', executor: async () => raw }),
  } });
  return governor.executePrepared({ id: 'request', toolName: 'test' }, { id: 'decision' }, new AbortController().signal);
}

test('returned lifecycle states never silently become success', async () => {
  for (const status of ['cancelled', 'timed_out', 'unknown_effect', 'invalid_request', 'denied', 'failed', 'completed_nonzero']) {
    assert.equal((await execute({ status, content: 'evidence', effectCertainty: 'unknown' })).status, status);
  }
  for (const raw of [null, [], { status: 'unexpected' }, { status: null }, { effectCertainty: 'maybe' }]) {
    const result = await execute(raw);
    assert.equal(result.status, 'failed');
    assert.equal(result.reason_code, 'tool_result_invalid');
  }
  assert.equal((await execute({ content: 'ok' })).status, 'succeeded');
  assert.equal((await execute({ content: 'uncertain', effectCertainty: 'unknown' })).status, 'unknown_effect');
});

test('settlement fingerprints distinguish equal-length content and ignore elapsed time', async () => {
  const a = await execute({ content: 'one' });
  const b = await execute({ content: 'two' });
  assert.notEqual(toolSettlementTerminal(a).result_fingerprint, toolSettlementTerminal(b).result_fingerprint);
  assert.equal(toolSettlementTerminal(a).result_fingerprint,
    toolSettlementTerminal({ ...a, elapsed_ms: 999 }).result_fingerprint);
});

test('executor output bounding preserves the original byte count and projection reason', async () => {
  const result = await execute({ content: 'x'.repeat(5000) });
  assert.equal(result.truncated, true);
  assert.equal(result.content.length, 4096);
  assert.equal(result.metadata.originalBytes, 5000);
  assert.equal(result.metadata.projectionReason, 'tool_output_bound');
});

test('pending plan completion passes through every terminal evidence gate', () => {
  const work = { pendingCompletion: { goal: { status: 'completed' } }, goal: { status: 'active' }, tasks: [] };
  const completed = { terminalDeclaration: { outcome: 'completed' } };
  assert.equal(evaluateCompletion({}, 'report', work).disposition, 'incomplete');
  for (const outcome of ['blocked', 'needs_input', 'failed', 'incomplete', 'completed']) {
    assert.equal(evaluateCompletion({ terminalDeclaration: { outcome } }, 'report', work).disposition, outcome);
  }
  assert.equal(evaluateCompletion({ ...completed, unresolvedToolFailures: [{}] }, 'report', work).disposition, 'continue');
  assert.equal(evaluateCompletion({ ...completed, correctableToolFailures: [{}] }, 'report', work).disposition, 'continue');
  assert.equal(evaluateCompletion({ ...completed, visualEvidence: { verdict: 'fail' } }, 'report', work).disposition, 'continue');
});

test('concurrent finalization joins one terminal persistence and output', async () => {
  const records = [];
  const engine = { active: { turnId: 'turn', finalized: false }, config: {},
    state: { state: 'finalizing_turn', transition() {} }, lifecycles: { finish() {} },
    output: async (record) => records.push(record), tools: { close() {} } };
  const operations = { publish: async () => {}, persist: async (type) => records.push(type),
    rejectDuplicate() { throw new Error('duplicate'); } };
  const first = finalizeEngineTurn(engine, 'completed', 'report', null, {}, operations);
  const second = finalizeEngineTurn(engine, 'failed', 'other', null, {}, operations);
  assert.deepEqual(await first, await second);
  assert.equal(records.filter((value) => value === 'turn_outcome').length, 1);
  assert.equal(records.filter((value) => value?.type === 'turn_result').length, 1);
  await assert.rejects(finalizeEngineTurn(engine, 'completed', '', null, {}, operations), /duplicate/);
});
