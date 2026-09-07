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
    request_id: 'tool-denied', tool: 'fs_write_text', state: 'not_approved',
    reason_code: 'semantic_review_unavailable', effect_certainty: 'none',
  })]),
});

test('only a non-completed latest turn carries unresolved reviewed tool outcomes', () => {
  const blocked = [{ type: 'turn_outcome', outcome: 'blocked', reviewer_completion: unresolved }];
  assert.deepEqual(carriedReviewerRequestIds(blocked), ['tool-denied']);
  assert.deepEqual(carriedReviewerRequestIds([
    ...blocked, { type: 'turn_outcome', outcome: 'completed', reviewer_completion: unresolved },
  ]), []);
});

test('reviewer completion guidance is bounded structured state, not inferred prose', () => {
  const hint = reviewerCompletionHint(unresolved);
  assert.match(hint, /tool-denied/u);
  assert.match(hint, /turn_finish/u);
  assert.equal(reviewerCompletionHint({ ...unresolved, unresolved_count: 0, unresolved: [] }), null);
});

test('a blocked reviewed operation survives into the next turn and defeats a false clean stop', async () => {
  const hookRoot = await mkdtemp(join(tmpdir(), 'nna-review-completion-hooks-'));
  const requests = [];
  const provider = { async *stream(request) {
    requests.push(request);
    if (requests.length === 1) {
      yield { type: 'text', text: 'Retrying now. I will write the file next.' };
      yield { type: 'terminal', finishReason: 'stop' };
      return;
    }
    if (requests.length === 2) {
      yield { type: 'tool_fragment', fragments: [{
        index: 0, id: 'finish-blocked', function: {
          name: 'turn_finish', arguments: '{"outcome":"blocked","reason_code":"review_unavailable"}',
        },
      }] };
      yield { type: 'terminal', finishReason: 'tool_calls' };
      return;
    }
    yield { type: 'text', text: 'The reviewed write remains blocked.' };
    yield { type: 'terminal', finishReason: 'stop' };
  } };
  const config = resolveManifest({
    persistence: 'ephemeral', workspace_root: process.cwd(),
    provider: { id: 'test', endpoint: 'http://127.0.0.1:9999/v1', model: 'fixture', trust_zone: 'loopback' },
  });
  const engine = new SessionEngine({ config, providerFactory: () => provider, hookRoot });
  await engine.initialize();
  const prior = {
    id: 'denied-write', providerCallId: 'prior-provider-call', toolName: 'fs_write_text',
    args: { path: 'pending.txt', content: 'pending' }, resolved: { path: join(process.cwd(), 'pending.txt') },
    authorityId: 'prior-authority', authorityVersion: 1, policyVersion: 1, definitionVersion: 1,
  };
  await engine.ledger.propose(prior, { risk: 'review_required', scope: 'workspace' }, {
    turnId: 'prior-blocked-turn', operatorRequestId: 'prior-request',
  });
  await engine.ledger.commitDecision(prior.id, {
    id: 'prior-denial', outcome: 'deny_with_guidance', reasonCode: 'semantic_review_unavailable',
  });
  const priorState = engine.ledger.completionState({ turnIds: ['prior-blocked-turn'] });
  engine.transcript.push({
    type: 'turn_outcome', turn_id: 'prior-blocked-turn', outcome: 'blocked', reviewer_completion: priorState,
  });

  const result = await engine.submit({ request_id: 'retry-request', content: 'Retry the write.' }, 'operator');
  assert.equal(result.outcome, 'blocked');
  assert.equal(requests.length, 3);
  assert.ok(requests[0].messages.some((item) => item.role === 'system'
    && item.content.includes('Unresolved reviewed tool outcomes remain')));
  assert.equal(result.reviewer_completion.unresolved_count, 1);
  await engine.shutdown({ version: '1.0', type: 'shutdown', request_id: 'shutdown-review-completion' });
});
