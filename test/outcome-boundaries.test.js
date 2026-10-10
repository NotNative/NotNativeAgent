// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventHub } from '../src/events.js';
import { ToolGovernor, toolSettlementTerminal } from '../src/tools/governor.js';
import { evaluateCompletion } from '../src/reliability/completion-supervisor.js';
import { finalizeEngineTurn } from '../src/engine/finalization.js';
import { persistSupervisedResponse } from '../src/engine/terminal-declaration.js';
import { updateToolFailures } from '../src/engine/tool-failures.js';
import { ReviewerLedger } from '../src/persistence/reviewer-ledger.js';

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

test('reviewed read-only diagnostic exits settle without another model answer', async () => {
  const request = { id: 'docker-query', toolName: 'shell_run',
    args: { script: 'docker ps; docker logs --tail 250 qwen38flashnext 2>&1' },
    resolved: { readOnly: false } };
  const governor = new ToolGovernor({ events: new EventHub(), reviewer: {}, registry: {
    definition: () => ({ timeoutMs: 1000, maxOutputBytes: 4096, sideEffect: 'unknown',
      executor: async () => ({ status: 'completed_nonzero', reasonCode: 'process_exit_nonzero',
        content: 'observed logs with diagnostic stderr', metadata: { exitCode: 1 } }) }),
  } });
  const result = await governor.executePrepared(request,
    { outcome: 'approve', effectAssessment: 'read_only' }, new AbortController().signal);
  assert.equal(result.status, 'completed_nonzero');
  assert.equal(result.effect_certainty, 'none');
  const ledger = new ReviewerLedger({ durable: false, sessionId: 'docker-query' });
  await ledger.propose(request, { risk: 'review_required', scope: 'workspace' }, { turnId: 'turn-1' });
  await ledger.commitDecision(request.id, { id: 'decision-1', outcome: 'approve' });
  await ledger.executionStarted(request.id, 'decision-1');
  await ledger.settle(request.id, toolSettlementTerminal(result));
  const active = { toolFailureLedger: new Map(), unresolvedToolFailures: [], correctableToolFailures: [],
    reviewerCompletion: ledger.completionState({ turnIds: ['turn-1'] }) };
  updateToolFailures(active, [{ request, result }]);
  assert.equal(active.reviewerCompletion.unresolved_count, 0);
  assert.deepEqual(active.correctableToolFailures, []);
  assert.equal(evaluateCompletion(active, 'Qualified answer from observed logs.').disposition, 'completed');
});

test('known state-changing process remains unresolved after a diagnostic exit', async () => {
  const governor = new ToolGovernor({ events: new EventHub(), reviewer: {}, registry: {
    definition: () => ({ timeoutMs: 1000, maxOutputBytes: 4096, sideEffect: 'unknown',
      executor: async () => ({ status: 'completed_nonzero', reasonCode: 'process_exit_nonzero', content: 'partial' }) }),
  } });
  const result = await governor.executePrepared({ id: 'write', toolName: 'shell_run', args: { script: 'write' } },
    { outcome: 'approve', effectAssessment: 'state_changing' }, new AbortController().signal);
  assert.equal(result.effect_certainty, 'unknown');
  const administrator = await governor.executePrepared({ id: 'admin', toolName: 'shell_run',
    args: { script: 'Get-Process', privilege: 'administrator' }, resolved: { readOnly: true } },
  { outcome: 'approve', effectAssessment: 'read_only' }, new AbortController().signal);
  assert.equal(administrator.effect_certainty, 'unknown');
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

test('pending plan completion accepts its final deliverable while other evidence gates remain active', () => {
  const work = { pendingCompletion: { goal: { status: 'completed' } }, goal: { status: 'active' }, tasks: [] };
  const completed = { terminalDeclaration: { outcome: 'completed' } };
  assert.equal(evaluateCompletion({}, 'report', work).disposition, 'completed');
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
    state: { state: 'finalizing_turn', transition(to) { records.push(`state:${to}`); this.state = to; } }, lifecycles: { finish() {} },
    output: async (record) => records.push(record), tools: { close() {} } };
  const operations = { publish: async () => {}, persist: async (type) => records.push(type),
    rejectDuplicate() { throw new Error('duplicate'); } };
  const first = finalizeEngineTurn(engine, 'completed', 'report', null, {}, operations);
  const second = finalizeEngineTurn(engine, 'failed', 'other', null, {}, operations);
  assert.deepEqual(await first, await second);
  assert.equal(records.filter((value) => value === 'turn_outcome').length, 1);
  assert.equal(records.filter((value) => value?.type === 'turn_result').length, 1);
  assert.ok(records.indexOf('turn_outcome') < records.indexOf('state:idle'));
  await assert.rejects(finalizeEngineTurn(engine, 'completed', '', null, {}, operations), /duplicate/);
});

test('terminal persistence failure leaves the turn non-idle and emits no completion', async () => {
  const output = [];
  const transitions = [];
  const engine = {
    active: { turnId: 'turn', finalized: false }, config: {},
    state: { state: 'finalizing_turn', transition(to) { transitions.push(to); this.state = to; } },
    lifecycles: { finish() {} }, output: async (record) => output.push(record), tools: { close() {} },
  };
  let terminalAttempts = 0;
  const failure = Object.assign(new Error('injected terminal flush failure'), { code: 'persistence_failed' });
  const operations = {
    publish: async () => {},
    persist: async (type) => {
      if (type === 'turn_outcome') { terminalAttempts += 1; throw failure; }
    },
    rejectDuplicate() { throw new Error('duplicate'); },
  };

  const first = finalizeEngineTurn(engine, 'completed', 'report', null, {}, operations);
  const joined = finalizeEngineTurn(engine, 'failed', 'different', null, {}, operations);
  await assert.rejects(first, failure);
  await assert.rejects(joined, failure);
  assert.equal(terminalAttempts, 1);
  assert.equal(engine.state.state, 'finalizing_turn');
  assert.equal(engine.active.turnId, 'turn');
  assert.deepEqual(transitions, []);
  assert.equal(output.length, 0);
});

test('an obligation-gated response candidate is not admitted before its journal append', async () => {
  const active = {
    turnId: 'turn', stepId: 'step', stepText: 'Durable answer.', provisionalFinal: null,
  };
  const failure = Object.assign(new Error('injected candidate flush failure'), { code: 'persistence_failed' });
  await assert.rejects(persistSupervisedResponse(
    active, { category: 'fixture_gate', preserveCandidate: true }, async () => { throw failure; },
  ), failure);
  assert.equal(active.provisionalFinal, null);
});
