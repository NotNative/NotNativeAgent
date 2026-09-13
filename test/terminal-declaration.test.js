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
