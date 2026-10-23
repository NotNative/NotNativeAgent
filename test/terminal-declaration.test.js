// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateCompletion } from '../src/reliability/completion-supervisor.js';
import { continueAfterTerminalDeclaration } from '../src/engine/terminal-declaration.js';
import { updateToolFailures } from '../src/engine/tool-failures.js';

const gateState = Object.freeze({
  schema: 'nna.reviewer-completion.v1', unresolved_count: 1,
  unresolved: Object.freeze([Object.freeze({
    request_id: 'risky-write', tool: 'fs_write_text', state: 'failed',
    reason_code: 'executor_failure', effect_certainty: 'unknown',
  })]),
});
const settledState = Object.freeze({
  schema: 'nna.reviewer-completion.v1', unresolved_count: 0, unresolved: Object.freeze([]),
});

function harness(state, plans) {
  const active = {
    turnId: 'turn-1', stepId: 'step-1', stepText: 'All done.', finishReason: 'stop',
    toolAssembler: { size: 0 }, attemptUsage: {}, attemptOutputLimitTokens: null,
    terminalDeclaration: Object.freeze({ outcome: 'completed' }),
    unresolvedToolFailures: [], correctableToolFailures: [], recovery: { actions: [] },
    reviewerCompletion: null, visualEvidence: null, contextPressureTier: 'none',
    provisionalFinal: null, carriedReviewerRequestIds: [], completionObligation: null,
  };
  const calls = [];
  const engine = {
    transcript: [], work: { snapshot: () => null }, state: { transition() {} },
    ledger: { completionState: () => state },
    reliability: {
      evaluateCompletion, hint: () => null,
      continuation: (_active, category, evidence, _detail, options) => {
        calls.push({ category, evidence, options });
        return plans.shift();
      },
    },
  };
  const items = [Object.freeze({
    request: Object.freeze({ toolName: 'turn_finish' }),
    result: Object.freeze({ tool_name: 'turn_finish', status: 'succeeded' }),
  })];
  return { active, calls, engine, items };
}

test('a rejected completed declaration consumes a bounded recovery episode instead of looping freely', async () => {
  const { active, calls, engine, items } = harness(gateState, [
    { continue: true, progress: false, count: 1, action: Object.freeze({ action: 'nudge' }) },
  ]);
  const settled = []; const recovered = [];
  const result = await continueAfterTerminalDeclaration(engine, active, items, null,
    (outcome) => { settled.push(outcome); }, (action) => { recovered.push(action); });
  assert.equal(result.continue, true);
  assert.equal(result.countModelStep, false);
  assert.match(result.hint, /The reviewer ledger contains unresolved tool outcomes/u);
  assert.deepEqual(calls, [{
    category: 'unresolved_reviewed_tool_outcome',
    evidence: 'fs_write_text:failed:unknown',
    options: { allowCompaction: false },
  }]);
  assert.deepEqual(recovered, [{ action: 'nudge' }]);
  assert.deepEqual(settled, ['continued']);
});

test('a rejected declaration releases the old answer before a later declaration settles', async () => {
  const { active, engine, items } = harness(gateState, [
    { continue: true, progress: false, count: 1, action: null },
  ]);
  active.provisionalFinal = Object.freeze({ text: 'Old answer.', stepId: 'old-step' });
  const first = await continueAfterTerminalDeclaration(engine, active, items, null,
    () => {}, async () => {});
  assert.equal(first.continue, true);
  assert.equal(active.provisionalFinal, null);
  assert.equal(active.terminalDeclaration, null);

  engine.ledger.completionState = () => settledState;
  active.stepId = 'new-step';
  active.stepText = 'New answer with settled evidence.';
  active.terminalDeclaration = Object.freeze({ outcome: 'completed' });
  const second = await continueAfterTerminalDeclaration(engine, active, items, null,
    () => {}, async () => {});
  assert.equal(second.text, 'New answer with settled evidence.');
  assert.equal(second.deliverableStepId, 'new-step');
});

test('a rejected truncated declaration cannot determine a later plain-text outcome', async () => {
  const { active, engine, items } = harness(settledState, [
    { continue: true, progress: false, count: 1, action: null },
  ]);
  active.terminalDeclaration = Object.freeze({ outcome: 'blocked', reason_code: 'old_blocker' });
  active.finishReason = 'tool_calls';
  active.attemptOutputLimitTokens = 8;
  active.attemptUsage = { completion_tokens: 8 };
  const result = await continueAfterTerminalDeclaration(engine, active, items, null,
    () => {}, async () => {});
  assert.equal(result.continue, true);
  assert.equal(active.terminalDeclaration, null);

  active.finishReason = 'stop';
  active.attemptUsage = {};
  active.stepText = 'The issue has been resolved.';
  assert.equal(evaluateCompletion(active, active.stepText).disposition, 'completed');
});

test('an exhausted rejected terminal declaration parks for operator attention', async () => {
  const { active, engine, items } = harness(gateState, [
    { continue: false, exhausted: true, count: 3 },
  ]);
  const settled = []; const recovered = [];
  const result = await continueAfterTerminalDeclaration(engine, active, items, null,
    (outcome) => { settled.push(outcome); }, (action) => { recovered.push(action); });
  assert.deepEqual(result, {
    exhausted: true, category: 'unresolved_reviewed_tool_outcome', count: 3,
  });
  assert.deepEqual(settled, ['incomplete']);
  assert.deepEqual(recovered, []);
});

test('an accepted terminal declaration is bookkeeping and consumes no recovery episode', async () => {
  const { active, calls, engine, items } = harness(settledState, []);
  const settled = [];
  const result = await continueAfterTerminalDeclaration(engine, active, items, null,
    (outcome) => { settled.push(outcome); }, async () => {});
  assert.deepEqual(result, {
    continue: false, text: 'All done.', outcome: 'completed',
    deliverableStepId: 'step-1', terminalDeclarationSettled: true,
  });
  assert.deepEqual(calls, []);
  assert.deepEqual(settled, ['completed']);
});

test('a failed terminal declaration discards the preserved answer candidate', async () => {
  const { active, engine, items } = harness(settledState, []);
  active.provisionalFinal = Object.freeze({ text: 'Old answer.', stepId: 'old-step' });
  const failed = [{ ...items[0], result: { tool_name: 'turn_finish', status: 'failed' } }];
  assert.equal(await continueAfterTerminalDeclaration(engine, active, failed, null,
    () => { throw new Error('failed declaration must not settle'); }, () => {}), null);
  assert.equal(active.provisionalFinal, null);
  assert.equal(active.terminalDeclaration, null);
});

test('a declaration mixed with other tools cannot govern a later answer', async () => {
  const { active, engine, items } = harness(settledState, []);
  active.terminalDeclaration = Object.freeze({ outcome: 'blocked', reason_code: 'stale_blocker' });
  const mixed = [...items, { request: { toolName: 'fs_read_text' },
    result: { tool_name: 'fs_read_text', status: 'succeeded' } }];
  assert.equal(await continueAfterTerminalDeclaration(engine, active, mixed, null,
    () => { throw new Error('mixed declaration must not settle'); }, () => {}), null);
  assert.equal(active.terminalDeclaration, null);
  active.stepText = 'Work completed after the read.';
  assert.equal(evaluateCompletion(active, active.stepText).disposition, 'completed');
});

test('no-effect tool outcomes create no completion obligation while possible effects remain recorded', () => {
  const active = { toolFailureLedger: new Map(), unresolvedToolFailures: [], correctableToolFailures: [] };
  updateToolFailures(active, [
    { request: { toolName: 'fs_read_text', args: { path: 'missing.txt' } },
      result: { status: 'failed', effect_certainty: 'none', reason_code: 'not_found' } },
    { request: { toolName: 'fs_write_text', args: { path: 'a.txt' } },
      result: { status: 'denied', effect_certainty: 'none', reason_code: 'semantic_denial' } },
    { request: { toolName: 'shell_run', args: { command: 'apply' } },
      result: { status: 'timed_out', effect_certainty: 'unknown', reason_code: 'tool_timeout' } },
  ]);
  assert.deepEqual(active.unresolvedToolFailures, ['tool_timeout']);
});

test('uncertain nonzero process results remain completion obligations and partial results do not crash tracking', () => {
  const active = { toolFailureLedger: new Map(), unresolvedToolFailures: [], correctableToolFailures: [] };
  updateToolFailures(active, [{ request: { toolName: 'shell_run', args: { script: 'change then fail' } },
    result: { status: 'completed_nonzero', reason_code: 'process_exit_nonzero', effect_certainty: 'unknown' } }]);
  assert.deepEqual(active.unresolvedToolFailures, ['process_exit_nonzero']);
  assert.doesNotThrow(() => updateToolFailures(active, [null,
    { request: { toolName: 'fs_read_text', args: { path: 'a.txt' } } }]));
  assert.ok(active.unresolvedToolFailures.includes('tool_failed'));
});
