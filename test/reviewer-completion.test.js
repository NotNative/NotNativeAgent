// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { resolveManifest } from '../src/config.js';
import { SessionEngine } from '../src/engine.js';
import { persistEngineRecord } from '../src/engine/persistence.js';
import { ReviewerLedger } from '../src/persistence/reviewer-ledger.js';
import { evaluateCompletion } from '../src/reliability/completion-supervisor.js';
import { carriedReviewerOverflow, carriedReviewerRequestIds, carriedReviewerTurnIds,
  initializeReviewerCarry, refreshReviewerCompletion, reviewerCompletionHint } from '../src/engine/reviewer-completion.js';

const unresolved = Object.freeze({
  schema: 'nna.reviewer-completion.v1', unresolved_count: 1,
  unresolved: Object.freeze([Object.freeze({
    request_id: 'tool-unknown-effect', tool: 'fs_write_text', state: 'failed',
    reason_code: 'executor_failure', effect_certainty: 'unknown',
  })]),
});

test('only a non-completed latest turn carries unresolved reviewed tool outcomes', () => {
  const blocked = [{ type: 'turn_outcome', outcome: 'blocked', reviewer_completion: unresolved }];
  assert.deepEqual(carriedReviewerRequestIds(blocked), ['tool-unknown-effect']);
  assert.deepEqual(carriedReviewerRequestIds([
    ...blocked, { type: 'turn_outcome', outcome: 'completed', reviewer_completion: unresolved },
  ]), []);
});

test('final classifications that can never settle are not carried into later turns', () => {
  const denied = {
    schema: 'nna.reviewer-completion.v1', unresolved_count: 2,
    unresolved: [
      { request_id: 'tool-denied', state: 'not_approved', effect_certainty: 'none' },
      { request_id: 'tool-pending', state: 'review_pending', effect_certainty: 'none' },
    ],
  };
  assert.deepEqual(carriedReviewerRequestIds([
    { type: 'turn_outcome', outcome: 'blocked', reviewer_completion: denied },
  ]), []);
  assert.deepEqual(carriedReviewerRequestIds([{
    type: 'turn_outcome', outcome: 'blocked', reviewer_completion: {
      ...unresolved,
      unresolved: [...unresolved.unresolved, denied.unresolved[0]],
    },
  }]), ['tool-unknown-effect']);
});

test('a pending review in one origin does not rearm the next turn through origin carry', async () => {
  const ledger = new ReviewerLedger({ durable: false, sessionId: 'pending-origin-carry' });
  await ledger.propose({ id: 'pending-review', toolName: 'fs_write_text',
    args: { path: 'pending.txt', content: 'x' }, resolved: { path: 'pending.txt' } },
  { risk: 'review_required', scope: 'workspace' }, { turnId: 'prior-turn' });
  const prior = ledger.completionState({ turnIds: ['prior-turn'] });
  assert.equal(prior.unresolved[0].state, 'review_pending');
  assert.deepEqual(prior.unresolved_turn_ids, []);
  const terminal = { type: 'turn_outcome', outcome: 'blocked', reviewer_completion: prior };
  const active = { turnId: 'next-turn' };
  initializeReviewerCarry(active, terminal);
  assert.deepEqual(active.carriedReviewerRequestIds, []);
  assert.deepEqual(active.carriedReviewerTurnIds, []);
  assert.equal(refreshReviewerCompletion({ ledger }, active).unresolved_count, 0);
});

test('a carried uncertain effect does not pull an unrelated pending review from its origin', async () => {
  const ledger = new ReviewerLedger({ durable: false, sessionId: 'mixed-origin-carry' });
  const reviewed = { id: 'unknown-write', toolName: 'fs_write_text',
    args: { path: 'unknown.txt', content: 'x' }, resolved: { path: 'unknown.txt' } };
  await ledger.propose(reviewed, { risk: 'review_required', scope: 'workspace' }, { turnId: 'prior-turn' });
  await ledger.commitDecision(reviewed.id, { id: 'approved-write', outcome: 'approve' });
  await ledger.executionStarted(reviewed.id, 'approved-write');
  await ledger.settle(reviewed.id, { status: 'failed', effect_certainty: 'unknown' });
  await ledger.propose({ id: 'pending-review', toolName: 'fs_write_text',
    args: { path: 'pending.txt', content: 'x' }, resolved: { path: 'pending.txt' } },
  { risk: 'review_required', scope: 'workspace' }, { turnId: 'prior-turn' });
  const terminal = { type: 'turn_outcome', outcome: 'blocked',
    reviewer_completion: ledger.completionState({ turnIds: ['prior-turn'] }) };
  const active = { turnId: 'next-turn' };
  initializeReviewerCarry(active, terminal);
  const next = refreshReviewerCompletion({ ledger }, active);
  assert.equal(next.unresolved_count, 1);
  assert.deepEqual(next.unresolved.map((item) => item.request_id), ['unknown-write']);
});

test('reviewer completion guidance is bounded structured state, not inferred prose', () => {
  const hint = reviewerCompletionHint(unresolved);
  assert.match(hint, /tool-unknown-effect/u);
  assert.match(hint, /turn_finish/u);
  assert.match(hint, /Inspect each target before retrying/u);
  assert.equal(reviewerCompletionHint({ ...unresolved, unresolved_count: 0, unresolved: [] }), null);
});

test('carry retains all uncertain effects when one turn exceeds the displayed request limit', async () => {
  const ledger = new ReviewerLedger({ durable: false, sessionId: 'carry-overflow' });
  for (let index = 0; index < 65; index += 1) {
    const id = `write-${index}`;
    const request = { id, toolName: 'fs_write_text', args: { path: `file-${index}`, content: 'x' },
      resolved: { path: `file-${index}` } };
    await ledger.propose(request, { risk: 'review_required', scope: 'workspace' }, { turnId: 'first-turn' });
    await ledger.commitDecision(id, { id: `decision-${index}`, outcome: 'approve' });
    await ledger.executionStarted(id, `decision-${index}`);
    await ledger.settle(id, { status: 'failed', effect_certainty: 'unknown' });
  }
  const first = ledger.completionState({ turnIds: ['first-turn'] });
  assert.equal(first.unresolved_count, 65);
  assert.equal(first.unresolved.length, 64);
  assert.deepEqual(first.unresolved_turn_ids, ['first-turn']);
  const terminal = { type: 'turn_outcome', outcome: 'blocked', reviewer_completion: first };
  const active = { turnId: 'second-turn', carriedReviewerRequestIds: carriedReviewerRequestIds(terminal),
    carriedReviewerTurnIds: carriedReviewerTurnIds(terminal), carriedReviewerOverflow: carriedReviewerOverflow(terminal) };
  const next = refreshReviewerCompletion({ ledger }, active);
  assert.equal(next.unresolved_count, 65);
  assert.equal(next.unresolved_truncated, true);
});

test('more than 64 distinct unresolved origins preserve a durable overflow gate', async () => {
  const ledger = new ReviewerLedger({ durable: false, sessionId: 'origin-overflow' });
  for (let index = 0; index < 65; index += 1) {
    const id = `write-${index}`;
    await ledger.propose({ id, toolName: 'fs_write_text', args: { path: id, content: 'x' },
      resolved: { path: id } }, { risk: 'review_required', scope: 'workspace' }, { turnId: `origin-${index}` });
    await ledger.commitDecision(id, { id: `decision-${index}`, outcome: 'approve' });
    await ledger.executionStarted(id, `decision-${index}`);
    await ledger.settle(id, { status: 'failed', effect_certainty: 'unknown' });
  }
  const first = ledger.completionState({ turnIds: Array.from({ length: 65 }, (_, index) => `origin-${index}`) });
  assert.equal(first.unresolved_turn_ids_truncated, true);
  const terminal = { type: 'turn_outcome', outcome: 'blocked', reviewer_completion: first };
  assert.equal(carriedReviewerOverflow(terminal), true);
  const active = { turnId: 'later', carriedReviewerRequestIds: carriedReviewerRequestIds(terminal),
    carriedReviewerTurnIds: carriedReviewerTurnIds(terminal), carriedReviewerOverflow: carriedReviewerOverflow(terminal) };
  const next = refreshReviewerCompletion({ ledger }, active);
  assert.equal(next.carry_overflow, true);
  assert.ok(next.unresolved_count > 0);
  assert.match(reviewerCompletionHint(next), /operator reconciliation/u);
  assert.equal(carriedReviewerOverflow({ type: 'turn_outcome', outcome: 'blocked',
    reviewer_completion: { ...first, unresolved_turn_ids: undefined,
      unresolved_turn_ids_truncated: undefined } }), true);
});

test('carry overflow survives an unrelated cancelled outcome and session restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-carry-restart-'));
  const config = resolveManifest({ persistence: 'durable', workspace_root: root,
    provider: { id: 'test', endpoint: 'http://127.0.0.1:9999/v1', model: 'fixture', trust_zone: 'loopback' } });
  const options = { config, sessionId: 'carry-restart', storeRoot: join(root, 'sessions'),
    reviewerRoot: join(root, 'reviewer'), providerFactory: () => ({ async *stream() {} }) };
  const first = new SessionEngine(options);
  await first.initialize();
  for (let index = 0; index < 65; index += 1) {
    const id = `write-${index}`;
    await first.ledger.propose({ id, toolName: 'fs_write_text', args: { path: id, content: 'x' },
      resolved: { path: id } }, { risk: 'review_required', scope: 'workspace' }, { turnId: `origin-${index}` });
    await first.ledger.commitDecision(id, { id: `decision-${index}`, outcome: 'approve' });
    await first.ledger.executionStarted(id, `decision-${index}`);
    await first.ledger.settle(id, { status: 'failed', effect_certainty: 'unknown' });
  }
  const origins = Array.from({ length: 65 }, (_, index) => `origin-${index}`);
  const blocked = first.ledger.completionState({ turnIds: origins });
  await persistEngineRecord(first, 'turn_outcome', { type: 'turn_result', turn_id: 'blocked-turn',
    outcome: 'blocked', reviewer_completion: blocked });
  const cancelled = { turnId: 'cancelled-turn' };
  initializeReviewerCarry(cancelled, first.latestTurnOutcome);
  const cancelledState = refreshReviewerCompletion(first, cancelled);
  await persistEngineRecord(first, 'turn_outcome', { type: 'turn_result', turn_id: cancelled.turnId,
    outcome: 'cancelled', reviewer_completion: cancelledState });
  await first.shutdown({ request_id: 'stop-first', type: 'shutdown' });

  const resumed = new SessionEngine(options);
  await resumed.initialize();
  const active = { turnId: 'resumed-turn' };
  initializeReviewerCarry(active, resumed.latestTurnOutcome);
  const state = refreshReviewerCompletion(resumed, active);
  assert.equal(active.carriedReviewerOverflow, true);
  assert.equal(state.carry_overflow, true);
  assert.ok(state.unresolved_count > 0);
  assert.match(reviewerCompletionHint(state), /operator reconciliation/u);
  assert.match(evaluateCompletion({ reviewerCompletion: state, terminalDeclaration: { outcome: 'completed' } },
    'All done.').hint, /Operator reconciliation/u);
  await resumed.shutdown({ request_id: 'stop-resumed', type: 'shutdown' });
});

test('a possible-effect reviewed failure survives into the next turn and defeats a false completion', async () => {
  const hookRoot = await mkdtemp(join(tmpdir(), 'nna-review-completion-hooks-'));
  const requests = [];
  const provider = { async *stream(request) {
    requests.push(request);
    if (requests.length === 1) {
      yield { type: 'text', text: 'All done. The write landed and the task is finished.' };
      yield { type: 'tool_fragment', fragments: [{
        index: 0, id: 'finish-completed', function: {
          name: 'turn_finish', arguments: '{"outcome":"completed"}',
        },
      }] };
      yield { type: 'terminal', finishReason: 'tool_calls' };
      return;
    }
    yield { type: 'text', text: 'The earlier write effect remains unverified.' };
    yield { type: 'tool_fragment', fragments: [{
      index: 0, id: 'finish-blocked', function: {
        name: 'turn_finish', arguments: '{"outcome":"blocked","reason_code":"effect_unverified"}',
      },
    }] };
    yield { type: 'terminal', finishReason: 'tool_calls' };
  } };
  const config = resolveManifest({
    persistence: 'ephemeral', workspace_root: process.cwd(),
    provider: { id: 'test', endpoint: 'http://127.0.0.1:9999/v1', model: 'fixture', trust_zone: 'loopback' },
  });
  const engine = new SessionEngine({ config, providerFactory: () => provider, hookRoot });
  await engine.initialize();
  const prior = {
    id: 'unknown-effect-write', providerCallId: 'prior-provider-call', toolName: 'fs_write_text',
    args: { path: 'pending.txt', content: 'pending' }, resolved: { path: join(process.cwd(), 'pending.txt') },
    authorityId: 'prior-authority', authorityVersion: 1, policyVersion: 1, definitionVersion: 1,
  };
  await engine.ledger.propose(prior, { risk: 'review_required', scope: 'workspace' }, {
    turnId: 'prior-blocked-turn', operatorRequestId: 'prior-request',
  });
  await engine.ledger.commitDecision(prior.id, {
    id: 'prior-decision', outcome: 'approve', reasonCode: 'intent_match',
  });
  await engine.ledger.executionStarted(prior.id, 'prior-decision');
  await engine.ledger.settle(prior.id, { status: 'failed', effect_certainty: 'unknown', reason_code: 'executor_failure' });
  const priorState = engine.ledger.completionState({ turnIds: ['prior-blocked-turn'] });
  await persistEngineRecord(engine, 'turn_outcome', {
    type: 'turn_result', turn_id: 'prior-blocked-turn', outcome: 'blocked', reviewer_completion: priorState,
  });
  assert.equal(engine.latestTurnOutcome.type, 'turn_outcome');
  assert.equal(engine.transcript.some((item) => item.type === 'turn_outcome'), false);

  const result = await engine.submit({ request_id: 'retry-request', content: 'Retry the write.' }, 'operator');
  assert.equal(result.outcome, 'blocked');
  // The completed declaration was rejected by the reviewer gate, so a second step was required.
  assert.equal(requests.length, 2);
  assert.ok(requests[0].messages.some((item) => item.role === 'system'
    && item.content.includes('Unresolved reviewed tool outcomes remain')));
  assert.ok(requests[1].messages.some((item) => item.role === 'system'
    && item.content.includes('The reviewer ledger contains unresolved tool outcomes')));
  assert.equal(result.reviewer_completion.unresolved_count, 1);
  await engine.shutdown({ version: '1.0', type: 'shutdown', request_id: 'shutdown-review-completion' });
});

test('a denial does not survive into the next turn as a false obligation', async () => {
  const hookRoot = await mkdtemp(join(tmpdir(), 'nna-review-completion-denial-'));
  const requests = [];
  const provider = { async *stream(request) {
    requests.push(request);
    yield { type: 'text', text: 'The denied write is not required; the answer stands.' };
    yield { type: 'tool_fragment', fragments: [{
      index: 0, id: 'finish-completed', function: {
        name: 'turn_finish', arguments: '{"outcome":"completed"}',
      },
    }] };
    yield { type: 'terminal', finishReason: 'tool_calls' };
  } };
  const config = resolveManifest({
    persistence: 'ephemeral', workspace_root: process.cwd(),
    provider: { id: 'test', endpoint: 'http://127.0.0.1:9999/v1', model: 'fixture', trust_zone: 'loopback' },
  });
  const engine = new SessionEngine({ config, providerFactory: () => provider, hookRoot });
  await engine.initialize();
  const denied = {
    id: 'denied-write', providerCallId: 'prior-provider-call', toolName: 'fs_write_text',
    args: { path: 'pending.txt', content: 'pending' }, resolved: { path: join(process.cwd(), 'pending.txt') },
    authorityId: 'prior-authority', authorityVersion: 1, policyVersion: 1, definitionVersion: 1,
  };
  await engine.ledger.propose(denied, { risk: 'review_required', scope: 'workspace' }, {
    turnId: 'prior-blocked-turn', operatorRequestId: 'prior-request',
  });
  await engine.ledger.commitDecision(denied.id, {
    id: 'prior-denial', outcome: 'deny_with_guidance', reasonCode: 'semantic_denial',
  });
  await persistEngineRecord(engine, 'turn_outcome', {
    type: 'turn_result', turn_id: 'prior-blocked-turn', outcome: 'blocked',
    reviewer_completion: { schema: 'nna.reviewer-completion.v1', unresolved_count: 1, unresolved: [{
      request_id: 'denied-write', tool: 'fs_write_text', state: 'not_approved',
      reason_code: 'semantic_denial', effect_certainty: 'none',
    }] },
  });

  const result = await engine.submit({ request_id: 'weather-request', content: 'What is the weather?' }, 'operator');
  assert.equal(result.outcome, 'completed');
  assert.equal(requests.length, 1);
  assert.equal(result.reviewer_completion.unresolved_count, 0);
  await engine.shutdown({ version: '1.0', type: 'shutdown', request_id: 'shutdown-review-denial' });
});
