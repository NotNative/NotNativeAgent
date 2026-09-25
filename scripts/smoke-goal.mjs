// SPDX-License-Identifier: Apache-2.0
/** NND proxy to NNA's durable, id-guarded goal metadata seam. */
import assert from 'node:assert/strict';

export async function probeGoal(call, json) {
  const created = await json(call, '/api/session', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Goal bridge smoke' }),
  }, 201);
  const path = `/api/v1/nnd/sessions/${created.id}/goal`;
  assert.deepEqual(await json(call, `/api/v1/nnd/sessions/${created.id}/goal-evidence`, 200), {
    session_id: created.id, turns: [], latest_request_id: null, window_truncated: false,
  });
  const now = Date.now();
  const goal = { id: 'goal_smoke', objective: 'Verify goal metadata bridge', objectiveFile: false,
    status: 'active', tokenBudget: null, tokensUsed: 0, tokensBaseline: 0, tokensCommitted: 0,
    turnsUsed: 0, blockedStreak: 0, auditFailStreak: 0, note: '', statusReason: '',
    evaluationProviderID: '', evaluationModelID: '', lastAccountedMessageID: '', createdAt: now, updatedAt: now };
  assert.deepEqual(await json(call, path, 200), { goal: null, revision: 0 });
  const put = (next, expectedId, expectedRevision) => ({ method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ goal: next, expected_id: expectedId, expected_revision: expectedRevision }) });
  assert.deepEqual(await json(call, path, put(goal, null, 0), 200), { goal, revision: 1 });
  assert.deepEqual((await json(call, `/api/session/${created.id}`, 200)).metadata.nnd.goal, goal);
  assert.equal((await call(path, put({ ...goal, status: 'complete' }, null, 1))).status, 409);
  assert.equal((await call(path, put({ ...goal, status: 'paused' }, goal.id, 0))).status, 409);
  assert.deepEqual(await json(call, path, put({ ...goal, status: 'complete' }, goal.id, 1), 200),
    { goal: { ...goal, status: 'complete' }, revision: 2 });
  assert.deepEqual(await json(call, path, { method: 'DELETE', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expected_id: goal.id, expected_revision: 2 }) }, 200), { goal: null, revision: 3 });
  assert.equal((await json(call, `/api/session/${created.id}`, 200)).metadata.nnd.goal, undefined);
  await json(call, `/api/session/${created.id}`, { method: 'DELETE' }, 200);
}
