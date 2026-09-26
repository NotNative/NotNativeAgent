// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { runNndGoalAudit } from '../src/nnd-goal-audit.js';
import { nndProviderProfileFingerprint } from '../src/nnd-provider-affinity.js';

const BODY = { expected_id: 'goal_test', expected_revision: 3, request_id: 'request-1', objective: 'Ship the feature' };

function fixture(events = [{ type: 'text', text: '{"verdict":"continue","note":"More work"}' }, { type: 'terminal' }]) {
  const calls = [];
  let released = 0;
  const fallback = { id: 'fallback', endpoint: 'http://127.0.0.1:1234/v1',
    model: 'model-x', trustZone: 'loopback', credential: null };
  const outcome = { type: 'turn_outcome', request_id: 'request-1', turn_id: 'turn-1', outcome: 'completed',
    text: 'A terminal summary that is not the displayed reply.', provider_profile: 'fallback', model: 'model-x',
    provider_route_fingerprint: nndProviderProfileFingerprint(fallback) };
  const assistant = { type: 'message', role: 'assistant', turnId: 'turn-1',
    content: 'Unit tests pass, integration remains.' };
  const context = { sessionId: 'session_test', goal: { id: 'goal_test', status: 'active', objectiveFile: false,
    objective: 'Ship the feature' }, goalRevision: 3, goalTurnReceipts: [], goalTurnReceiptsTruncated: false,
    engine: { sessionId: 'session_test', transcript: [assistant, outcome], config: {
      providerProfiles: { fallback, primary: { id: 'primary' } },
    }, router: { providerForProfile(profile) {
      calls.push(['provider', profile.id]);
      return { async *stream(request) { calls.push(['stream', request]); yield* events; } };
    } }, scheduler: { async acquire(id) { calls.push(['acquire', id]); return () => { released += 1; }; } } } };
  return { context, calls, get released() { return released; } };
}

test('goal audit uses the final completed provider route with no tools', async () => {
  const state = fixture();
  assert.deepEqual(await runNndGoalAudit(state.context, BODY), {
    text: '{"verdict":"continue","note":"More work"}', providerID: 'fallback', modelID: 'model-x',
  });
  assert.deepEqual(state.calls.slice(0, 2), [['provider', 'fallback'], ['acquire', 'fallback']]);
  const request = state.calls[2][1];
  assert.equal(request.model, 'model-x');
  assert.deepEqual(request.tools, []);
  assert.match(request.messages[1].content, /Unit tests pass/u);
  assert.doesNotMatch(request.messages[1].content, /terminal summary/u);
  assert.match(request.messages[0].content, /Claims without verification are not completion/u);
  assert.equal(state.released, 1);
});

test('goal audit fails closed on stale revision, missing affinity, or wrong objective', async () => {
  const state = fixture();
  await assert.rejects(runNndGoalAudit(state.context, { ...BODY, expected_revision: 2 }), { code: 'nnd_goal_audit_conflict' });
  await assert.rejects(runNndGoalAudit(state.context, { ...BODY, objective: 'Changed goal' }), { code: 'nnd_goal_audit_conflict' });
  state.context.engine.transcript[1].provider_profile = undefined;
  await assert.rejects(runNndGoalAudit(state.context, BODY), { code: 'nnd_goal_audit_unavailable' });
  assert.deepEqual(state.calls, []);
});

test('goal audit does not reuse an assistant reply from a prior turn', async () => {
  const state = fixture();
  state.context.engine.transcript[0].turnId = 'earlier-turn';
  await assert.rejects(runNndGoalAudit(state.context, BODY), { code: 'nnd_goal_audit_unavailable' });
  assert.deepEqual(state.calls, []);
});

test('goal audit rejects provider tool calls and always releases capacity', async () => {
  const state = fixture([{ type: 'tool_fragment', fragments: [] }, { type: 'terminal' }]);
  await assert.rejects(runNndGoalAudit(state.context, BODY), { code: 'nnd_goal_audit_tool_violation' });
  assert.equal(state.released, 1);
});

test('goal audit accepts keyed objective but never provider-switches when route disappears', async () => {
  const state = fixture();
  state.context.goal.objectiveFile = true;
  state.context.goal.objective = '';
  state.context.goal.objectiveFileKey = 'a'.repeat(64);
  assert.equal((await runNndGoalAudit(state.context, BODY)).modelID, 'model-x');
  delete state.context.engine.config.providerProfiles.fallback;
  await assert.rejects(runNndGoalAudit(state.context, BODY), { code: 'nnd_goal_audit_unavailable' });
});

test('goal audit refuses a same-ID provider remap after hot reload or restart', async () => {
  const state = fixture();
  state.context.engine.config.providerProfiles.fallback = {
    ...state.context.engine.config.providerProfiles.fallback,
    endpoint: 'https://public.example/v1', trustZone: 'public_network',
  };
  await assert.rejects(runNndGoalAudit(state.context, BODY), { code: 'nnd_goal_audit_unavailable' });
  assert.deepEqual(state.calls, []);

  const restored = fixture();
  restored.context.engine.transcript[1].provider_route_fingerprint = undefined;
  await assert.rejects(runNndGoalAudit(restored.context, BODY), { code: 'nnd_goal_audit_unavailable' });
  assert.deepEqual(restored.calls, []);
});

test('goal audit discards a verdict if a new turn starts during inference', async () => {
  const state = fixture();
  state.context.engine.router.providerForProfile = () => ({ async *stream() {
    state.context.liveTurn = { requestId: 'new-turn' };
    yield { type: 'text', text: '{"verdict":"complete","note":"Done"}' };
    yield { type: 'terminal' };
  } });
  await assert.rejects(runNndGoalAudit(state.context, BODY), { code: 'nnd_goal_audit_conflict' });
  assert.equal(state.released, 1);
});
