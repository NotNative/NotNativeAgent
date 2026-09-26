// SPDX-License-Identifier: Apache-2.0
/** NND proxy to NNA's durable, id-guarded goal metadata seam + auditor route. */
import assert from 'node:assert/strict';

function goalBody(next, expectedId, expectedRevision) {
  return { method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ goal: next, expected_id: expectedId, expected_revision: expectedRevision }) };
}

/** A bounded, active goal payload that NNA's goal route accepts verbatim. */
function smokeGoal(objective) {
  const now = Date.now();
  return { id: 'goal_audit_smoke', objective, objectiveFile: false, status: 'active',
    tokenBudget: null, tokensUsed: 0, tokensBaseline: 0, tokensCommitted: 0, turnsUsed: 0,
    blockedStreak: 0, auditFailStreak: 0, note: '', statusReason: '', evaluationProviderID: '',
    evaluationModelID: '', lastAccountedMessageID: '', createdAt: now, updatedAt: now };
}

export async function probeGoal(call, json) {
  const created = await json(call, '/api/session', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Goal bridge smoke' }),
  }, 201);
  const path = `/api/v1/nnd/sessions/${created.id}/goal`;
  assert.deepEqual(await json(call, `/api/v1/nnd/sessions/${created.id}/goal-evidence`, 200), {
    session_id: created.id, turns: [], latest_request_id: null, window_truncated: false,
  });
  const goal = smokeGoal('Verify the NNA goal audit route');
  assert.deepEqual(await json(call, path, 200), { goal: null, revision: 0 });
  assert.deepEqual(await json(call, path, goalBody(goal, null, 0), 200), { goal, revision: 1 });
  assert.deepEqual((await json(call, `/api/session/${created.id}`, 200)).metadata.nnd.goal, goal);
  assert.equal((await call(path, goalBody({ ...goal, status: 'complete' }, null, 1))).status, 409);
  assert.equal((await call(path, goalBody({ ...goal, status: 'paused' }, goal.id, 0))).status, 409);
  assert.deepEqual(await json(call, path, goalBody({ ...goal, status: 'complete' }, goal.id, 1), 200),
    { goal: { ...goal, status: 'complete' }, revision: 2 });
  assert.deepEqual(await json(call, path, { method: 'DELETE', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expected_id: goal.id, expected_revision: 2 }) }, 200), { goal: null, revision: 3 });
  assert.equal((await json(call, `/api/session/${created.id}`, 200)).metadata.nnd.goal, undefined);
  await json(call, `/api/session/${created.id}`, { method: 'DELETE' }, 200);
}

async function waitUntil(operation, predicate, message) {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const value = await operation();
    if (predicate(value) !== undefined) return value;
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function settleCompleteTurn(call, json, id, requestId = 'smoke_audit_prompt') {
  await waitUntil(async () => json(call, `/api/session/${id}/activity`, 200),
    (rows) => (rows.some((row) => row.id === `${id}:turn:${requestId}`
      && row.status === 'completed') ? rows : undefined),
    'NNA goal-audit turn never reached a completed activity snapshot');
}

/** Live NND tick → NNA audit → CAS → continuation → final audit proof. */
export async function probeGoalAutonomousLoop(call, json, directory, providerRequests) {
  const [{ createNnaGoalAuditPorts }, { runNnaGoalSafetyTick }, { runGoalAuditExchange }] = await Promise.all([
    import('../packages/web/src/server/goals/nna-goal-safety-ports.ts'),
    import('../packages/web/src/server/goals/nna-goal-safety-tick.ts'),
    import('../packages/web/src/server/goals/nna-goal-auditor.ts'),
  ]);
  const created = await json(call, '/api/session', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Goal loop smoke' }) }, 201);
  const id = created.id;
  const path = `/api/v1/nnd/sessions/${id}/goal`;
  const goal = smokeGoal('Verify the live goal loop finishes after a continuation.');
  const auditRequests = () => providerRequests().filter((request) =>
    request.messages?.[0]?.content?.startsWith('You audit progress of a coding agent'));
  const auditsBefore = auditRequests().length;
  let probeFailed = false;
  try {
    await json(call, path, goalBody(goal, null, 0), 200);
    assert.equal((await call(`/api/session/${id}/prompt_async`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messageID: 'smoke_goal_start',
        parts: [{ type: 'text', text: 'Start the goal smoke task.' }] }) })).status, 204);
    await settleCompleteTurn(call, json, id, 'smoke_goal_start');
    const ports = createNnaGoalAuditPorts();
    const first = await runNnaGoalSafetyTick(ports, id, directory);
    assert.equal(first.kind, 'ready', 'the first completed turn did not become audit-ready');
    assert.equal(first.skipAudit, false, 'a completed first turn must enter the independent audit');
    const continued = await runGoalAuditExchange(ports, first, id, directory);
    assert.equal(continued.kind, 'dispatched', `goal did not dispatch its continuation: ${JSON.stringify(continued)}`);
    assert.equal(continued.source, 'audit', 'continuation bypassed the independent audit');
    assert.equal(auditRequests().length, auditsBefore + 1, 'the first turn did not reach the provider auditor');
    const evidence = await waitUntil(() => json(call, `/api/v1/nnd/sessions/${id}/goal-evidence`, 200),
      (window) => (window.turns.length === 2 ? window : undefined),
      'the continuation did not complete a second NNA turn');
    assert.equal(evidence.window_truncated, false);
    assert.equal(evidence.turns[1].outcome, 'completed');
    assert.notEqual(evidence.turns[1].request_id, evidence.turns[0].request_id);
    assert.ok(providerRequests().some((request) => request.messages?.some((message) =>
      message.role === 'user' && typeof message.content === 'string'
      && message.content.startsWith('Continue working toward the active session goal.')
      && message.content.includes(goal.objective))),
    'the second turn did not receive the NND continuation prompt');
    const second = await runNnaGoalSafetyTick(ports, id, directory);
    assert.equal(second.kind, 'ready', 'the second completed turn did not become audit-ready');
    assert.equal(second.skipAudit, false, 'the completed continuation must enter the independent audit');
    const completed = await runGoalAuditExchange(ports, second, id, directory);
    assert.equal(completed.kind, 'settled', `goal did not settle complete: ${JSON.stringify(completed)}`);
    assert.equal(completed.outcome, 'complete');
    assert.equal(auditRequests().length, auditsBefore + 2, 'both completed turns must reach the provider auditor');
    const stored = await json(call, path, 200);
    assert.equal(stored.goal.status, 'complete');
    assert.equal(stored.goal.turnsUsed, 1);
    assert.equal(stored.goal.evaluationProviderID, 'primary');
    assert.equal(stored.goal.evaluationModelID, 'test');
  } catch (error) {
    probeFailed = true;
    throw error;
  } finally {
    await cleanupGoalLoop(call, json, path, id, goal.id, probeFailed);
  }
}

async function cleanupGoalLoop(call, json, path, id, goalId, probeFailed) {
  let cleanupError = null;
  try {
    const stored = await json(call, path, 200);
    if (stored.goal) await json(call, path, { method: 'DELETE', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expected_id: goalId, expected_revision: stored.revision }) }, 200);
  } catch (error) { cleanupError = error; }
  try { await json(call, `/api/session/${id}`, { method: 'DELETE' }, 200); }
  catch (error) { cleanupError ??= error; }
  if (cleanupError && !probeFailed) throw cleanupError;
}

/**
 * Live wrapper proof for the independent auditor: one attributed provider turn
 * under an armed goal, then NNA's evidence-bound audit route via NND's proxy.
 */
export async function probeGoalAudit(call, json) {
  const created = await json(call, '/api/session', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Goal audit smoke' }),
  }, 201);
  const id = created.id;
  const goalPath = `/api/v1/nnd/sessions/${id}/goal`;
  const goal = smokeGoal('Verify the NNA goal audit route');
  try {
    assert.deepEqual(await json(call, goalPath, goalBody(goal, null, 0), 200), { goal, revision: 1 });
    const submitted = await call(`/api/session/${id}/prompt_async`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messageID: 'smoke_audit_prompt',
        parts: [{ type: 'text', text: 'Reply with the smoke marker.' }] }),
    });
    assert.equal(submitted.status, 204);
    await settleCompleteTurn(call, json, id);
    const evidence = await waitUntil(
      () => json(call, `/api/v1/nnd/sessions/${id}/goal-evidence`, 200),
      (window) => (window.turns.length === 1 ? window : undefined),
      'NNA goal evidence never exposed the settled turn receipt');
    assert.equal(evidence.window_truncated, false);
    const receipt = evidence.turns[0];
    assert.equal(receipt.outcome, 'completed');
    assert.equal(receipt.provider_profile, 'primary');
    assert.equal(receipt.model, 'test');
    assert.ok(receipt.request_id.length > 0, 'NNA goal receipt lost its request id');
    const store = await json(call, goalPath, 200);
    assert.equal(store.revision, 1);
    await assertAuditRoundTrip(call, id, receipt.request_id, goal.objective, store.revision);
  } finally {
    const store = await json(call, goalPath, 200);
    if (store.goal) await json(call, goalPath, { method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expected_id: goal.id, expected_revision: store.revision }) }, 200);
    await json(call, `/api/session/${id}`, { method: 'DELETE' }, 200);
  }
}

function auditQuery(revision, requestId, objective) {
  return { expected_id: 'goal_audit_smoke', expected_revision: revision,
    request_id: requestId, objective };
}

async function assertAuditRoundTrip(call, id, requestId, objective, revision) {
  const audited = await call(`/api/v1/nnd/sessions/${id}/goal-audit`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(auditQuery(revision, requestId, objective)),
  });
  assert.equal(audited.status, 200, 'NNA goal audit route refused its live smoke call');
  const verdict = await audited.json();
  assert.equal(verdict.providerID, 'primary', 'audit must reuse the turn provider profile');
  assert.equal(verdict.modelID, 'test', 'audit must reuse the turn model');
  assert.ok(typeof verdict.text === 'string' && verdict.text.includes('"verdict":'),
    'audit text did not carry a verdict');
  const refused = await call(`/api/v1/nnd/sessions/${id}/goal-audit`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(auditQuery(99, requestId, objective)),
  });
  assert.equal(refused.status, 409, 'stale audit revision must not answer');
  assert.equal((await refused.json()).error?.code, 'nnd_goal_audit_conflict');
}
