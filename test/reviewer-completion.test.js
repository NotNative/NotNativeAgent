// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { resolveManifest } from '../src/config.js';
import { SessionEngine } from '../src/engine.js';
import { carriedReviewerRequestIds, reviewerCompletionHint } from '../src/engine/reviewer-completion.js';

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

test('reviewer completion guidance is bounded structured state, not inferred prose', () => {
  const hint = reviewerCompletionHint(unresolved);
  assert.match(hint, /tool-unknown-effect/u);
  assert.match(hint, /turn_finish/u);
  assert.equal(reviewerCompletionHint({ ...unresolved, unresolved_count: 0, unresolved: [] }), null);
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
  engine.transcript.push({
    type: 'turn_outcome', turn_id: 'prior-blocked-turn', outcome: 'blocked', reviewer_completion: priorState,
  });

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
  engine.transcript.push({
    type: 'turn_outcome', turn_id: 'prior-blocked-turn', outcome: 'blocked',
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
