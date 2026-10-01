// SPDX-License-Identifier: Apache-2.0
import { expect, it } from 'vitest';
import { NotificationSessions } from '../notifications/session-state.ts';
import { pendingSnapshot } from '../notifications/pending-snapshot.ts';

const empty = () => ({ permissions: [], forms: [], capabilities: { permissions: 'unsupported', forms: 'observe-only' } });
const form = () => ({ id: 'q1', toolRequestID: 'tool_a', questions: [{ question: 'Choose', header: 'Choice', multiple: false,
  custom: false, options: [{ label: 'Yes', description: '' }] }] });
it('recovers pending forms after NND restart and removes stale live requests on authoritative refresh', async () => {
  let now = 1000; let row = { ...empty(), forms: [form()] };
  const sessions = new NotificationSessions(() => now, async (path) => Response.json(path === '/session?archived=true'
    ? [{ id: 's1' }] : path === '/session/status' ? {} : { coverage: 'complete', sessions: { s1: row } }));
  await sessions.refresh();
  expect(sessions.snapshot('owner')).toMatchObject({ pendingCoverage: 'complete', pending: { s1: { forms: [{ id: 'q1', sessionID: 's1' }] } } });
  sessions.receipts.view('owner', 's1', true, {});
  expect(sessions.attention('owner', 's1')?.needsAttention).toBe(true);
  row = { ...empty(), forms: [] }; now += 2000; await sessions.refresh();
  expect(sessions.snapshot('owner').pending).toEqual({});
  expect(sessions.attention('owner', 's1')?.needsAttention).toBe(false);
});

it('rejects incomplete and contradictory pending coverage without changing existing state', async () => {
  let wrong = false;
  const sessions = new NotificationSessions(Date.now, async (path) => Response.json(path === '/session?archived=true'
    ? [{ id: 's1' }] : path === '/session/status' ? {} : { coverage: 'complete', sessions: wrong ? {} : { s1: empty() } }));
  await sessions.refresh(); wrong = true;
  await expect(sessions.refresh(true)).rejects.toThrow('changed during refresh');
  expect(sessions.get('s1')).toBeDefined();
  await expect(pendingSnapshot(Response.json({ coverage: 'complete', sessions: { s1: { ...empty(), permissions: [{ id: 'p1' }] } } }))).rejects.toThrow();
  await expect(pendingSnapshot(Response.json({ coverage: 'complete', sessions: { s1: { ...empty(), forms: [{ id: 'q' }, { id: 'q' }] } } }))).rejects.toThrow();
  await expect(pendingSnapshot(new Response(null, { status: 503 }))).rejects.toThrow('unavailable');
  expect(await pendingSnapshot(new Response(null, { status: 404 }))).toBeNull();
});

it('rejects coerced capabilities and unrenderable question payloads instead of reporting complete recovery', async () => {
  const read = (row: unknown) => pendingSnapshot(Response.json({ coverage: 'complete', sessions: { s1: row } }));
  await expect(read({ ...empty(), capabilities: { permissions: ['unsupported'], forms: 'observe-only' } })).rejects.toThrow();
  for (const questions of [[], [{ question: 'Choose' }], [{ ...form().questions[0], options: [] }], [{ ...form().questions[0], multiple: 'yes' }]]) {
    await expect(read({ ...empty(), forms: [{ ...form(), questions }] })).rejects.toThrow('payload is invalid');
  }
  expect(await read({ ...empty(), forms: [form()] })).toBeInstanceOf(Map);
});
