// SPDX-License-Identifier: Apache-2.0
/** Real SSE feed + NND goal timer over an isolated NNA source child. */
import assert from 'node:assert/strict';
import { goalBody, smokeGoal, waitUntil } from './smoke-goal.mjs';

function assertEventGoalEvidence(settled, exchanges, connections, events, id, requests) {
  assert.equal(settled.goal.turnsUsed, 1);
  assert.equal(settled.goal.evaluationProviderID, 'primary');
  assert.deepEqual(exchanges.map((result) => result.kind), ['dispatched', 'settled']);
  assert.equal(connections, 1, 'goal event feed reconnected; reconciliation could mask a missed event');
  assert.ok(events.some((event) => event.payload?.type === 'session.status'
    && event.payload.properties?.sessionID === id && event.payload.properties.status?.type === 'idle'),
  'the live feed did not deliver the completed session idle event');
  assert.equal(requests.filter((request) => request.messages?.[0]?.content
    ?.startsWith('You audit progress of a coding agent')).length, 2,
  'event-driven runtime did not independently audit both turns');
  assert.ok(requests.some((request) => request.messages?.some((message) =>
    message.role === 'user' && typeof message.content === 'string'
    && message.content.startsWith('Continue working toward the active session goal.'))),
  'event-driven runtime did not send the continuation prompt');
}

async function deleteEventGoalSession(call, json, id) {
  if (!id) return;
  const path = `/api/v1/nnd/sessions/${id}/goal`;
  const current = await json(call, path, 200);
  if (current.goal) await json(call, path, { method: 'DELETE', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expected_id: current.goal.id, expected_revision: current.revision }) }, 200);
  await json(call, `/api/session/${id}`, { method: 'DELETE' }, 200);
}

export async function probeGoalEventRuntime(call, json, directory, providerRequests) {
  const [{ AdapterQueueFeed }, { NnaGoalSafetyRuntime, guardGoalAuditExchangePorts }, { createNnaGoalAuditPorts },
    { runGoalAuditExchange }, { readMergedSettings }] = await Promise.all([
    import('../packages/web/src/server/queue/queue-feed.ts'),
    import('../packages/web/src/server/goals/nna-goal-runtime.ts'),
    import('../packages/web/src/server/goals/nna-goal-safety-ports.ts'),
    import('../packages/web/src/server/goals/nna-goal-auditor.ts'),
    import('../packages/web/src/server/lib/settings-store.ts'),
  ]);
  await json(call, '/api/config/settings', { method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionGoalEnabled: true }) }, 200);
  assert.equal(readMergedSettings('web').sessionGoalEnabled, true);
  const feed = new AdapterQueueFeed();
  const ports = createNnaGoalAuditPorts();
  const exchanges = [];
  const events = [];
  let connections = 0;
  const unsubscribeEvents = feed.onEvent((event) => events.push(event));
  const unsubscribeConnected = feed.onConnected(() => { connections += 1; });
  const requestsBefore = providerRequests().length;
  const runtime = new NnaGoalSafetyRuntime(feed, ports,
    () => readMergedSettings('web').sessionGoalEnabled === true,
    async (ready, id, dir, isCurrent) => {
      exchanges.push(await runGoalAuditExchange(guardGoalAuditExchangePorts(ports, isCurrent), ready, id, dir));
    },
    { idleMs: 20, kickoffMs: 20, resumeMs: 20 });
  runtime.start();
  feed.start();
  let id = null;
  try {
    await waitUntil(() => connections, (count) => count > 0 ? count : undefined,
      'goal event feed did not connect before creating the session');
    const created = await json(call, '/api/session', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Event goal loop smoke' }) }, 201);
    id = created.id;
    assert.equal(created.directory, directory);
    const goal = smokeGoal('Verify the event-driven goal loop finishes after a continuation.');
    await json(call, `/api/v1/nnd/sessions/${id}/goal`, goalBody(goal, null, 0), 200);
    assert.equal((await call(`/api/session/${id}/prompt_async`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messageID: 'smoke_event_start',
        parts: [{ type: 'text', text: 'Start the event goal smoke task.' }] }) })).status, 204);
    const settled = await waitUntil(() => json(call, `/api/v1/nnd/sessions/${id}/goal`, 200),
      (value) => (value.goal?.status === 'complete' ? value : undefined),
      'event-driven NND goal loop did not reach complete');
    assertEventGoalEvidence(settled, exchanges, connections, events, id,
      providerRequests().slice(requestsBefore));
  } finally {
    runtime.dispose();
    feed.stop();
    unsubscribeEvents();
    unsubscribeConnected();
    await deleteEventGoalSession(call, json, id);
  }
}
