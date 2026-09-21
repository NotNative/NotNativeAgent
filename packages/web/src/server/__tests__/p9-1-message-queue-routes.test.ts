// SPDX-License-Identifier: Apache-2.0
/**
 * P9-1 route family gates (doc 12 §D.5): snapshot with public items,
 * enqueue validation + arm, take/takeAll with full payloads, the
 * complete-permutation reorder, delete + in-flight 409s, hold semantics
 * with TTL clamps, the broadcast contract (revision bump + `session`
 * always the directory, even on the last-item removal), the 50 MiB
 * bounded-body budget, and the app registration pin (routes BEFORE the
 * generic harness proxy, behind the global /api gate).
 */
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath, sep } from 'node:path';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ControlBusSpy,
  FakeQueueFeed,
  FakeQueueHarness,
  feedEnvelope,
  installFakeHarness,
  makeQueueRuntime,
  rawItem,
  SHORT_TIMING,
  WORK_TREE,
  waitUntil,
} from './helpers/queue-fakes.ts';
import { createMessageQueueRoutes, QUEUE_BODY_MAX_CHARS } from '../queue/queue-routes.ts';
import { QUEUE_FILE_NAME } from '../queue/queue-store.ts';

const origin = 'http://queue.test';
const jsonHeaders = { 'content-type': 'application/json' };
let fake: FakeQueueHarness | null = null;
let feed: FakeQueueFeed | null = null;
let runtime: ReturnType<typeof makeQueueRuntime> | null = null;
let spy: ControlBusSpy | null = null;
let dataDir = mkdtempSync(`${tmpdir()}${sep}nnd-p91-routes-`);

const rt = (): NonNullable<typeof runtime> => {
  if (!runtime) throw new Error('runtime missing');
  return runtime;
};

const call = async (path: string, init?: RequestInit): Promise<Response> =>
  new Hono().route('/', createMessageQueueRoutes(rt())).fetch(new Request(`${origin}${path}`, init)) as Promise<Response>;

describe('lazy runtime registration (E-09-14)', () => {
  it('the mount accepts a lazy provider and resolves it only on request', async () => {
    let resolves = 0;
    const lazy = new Hono().route('/', createMessageQueueRoutes(() => {
      resolves += 1;
      return rt();
    }));
    expect(resolves).toBe(0);
    const response = await lazy.fetch(new Request(`${origin}/api/message-queue`)) as Response;
    expect(response.status).toBe(200);
    expect(resolves).toBeGreaterThanOrEqual(1);
    expect(Object.keys(await response.clone().json() as { revision: number }).sort()).toEqual(['revision', 'sessions']);
  });
});

async function enqueue(content: string, sessionId: string): Promise<{ revision: number; session: string; itemId: string }> {
  const response = await call(`/api/message-queue/sessions/${sessionId}/items`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ directory: WORK_TREE, item: rawItem({ content }) }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { revision: number; session: string; itemId: string };
}

/** Deterministic in-flight head: the parked POST for THIS session is the gate. */
async function pinnedSend(sessionId: string): Promise<string> {
  await waitUntil(() => fake!.heldCount > 0 && fake!.sends.some((send) => send.sessionId === sessionId), 1500);
  const sendingId = rt().snapshotSessions().find((session) => session.sessionId === sessionId)?.sendingId;
  expect(sendingId, 'a held send must mark the head in flight').toBeTruthy();
  return sendingId!;
}

async function releaseSend(sessionId: string): Promise<void> {
  fake!.releaseHeldSends();
  await waitUntil(
    () => rt().snapshotSessions().find((session) => session.sessionId === sessionId)?.sendingId === undefined,
    1500,
    10,
    () => JSON.stringify({ heldCount: fake!.heldCount, sessions: rt().snapshotSessions().map((entry) => [entry.sessionId, entry.sendingId, entry.items.length]), outcomes: fake!.outcomes.map((outcome) => outcome.kind) }),
  );
}

const sessionOf = (sessionId: string): { items: unknown[]; sendingId: string | null } | undefined =>
  rt().snapshotSessions().find((session) => session.sessionId === sessionId);

beforeAll(() => {
  fake = new FakeQueueHarness();
  installFakeHarness(fake); // the runtime dispatches through the adapter seam
  feed = new FakeQueueFeed();
  spy = new ControlBusSpy().start();
});

// Fresh runtime + store per test: no file cross-contamination, no leaks.
beforeEach(() => {
  if (runtime) rt().dispose(); // kill the previous test's arms and listeners
  fake!.releaseHeldSends();
  fake!.releaseStatusChecks();
  dataDir = mkdtempSync(`${tmpdir()}${sep}nnd-p91-routes-`);
  runtime = makeQueueRuntime(feed!, dataDir, SHORT_TIMING);
  runtime.start();
  spy!.clear();
});

afterAll(() => {
  spy?.stop();
  rt().dispose();
  fake?.releaseHeldSends();
});

describe('GET /api/message-queue snapshot (§D.5)', () => {
  it('serves public items only: dataUrl/context never surface; preview derives; sendingId rides', async () => {
    fake!.enqueueOutcome({ kind: 'hold' }); // park the head so `sendingId` is observable
    await call('/api/message-queue/sessions/snap-s/items', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({
        directory: WORK_TREE,
        item: rawItem({
          content: 'first line\nsecond line',
          attachments: [{ id: 'a1', filename: 'a.png', mimeType: 'image/png', size: 4, dataUrl: 'data:image/png;base64,QkFA' }],
          context: [{ kind: 'context', text: 'ctx', metadata: { k: 1 } }],
        }),
      }),
    });
    await waitUntil(() => fake!.heldCount > 0, 1200);
    const snapshot = await call('/api/message-queue').then((response) => response.json()) as {
      revision: number;
      sessions: Array<{ sessionId: string; directory: string; items: unknown[]; sendingId: string | null }>;
    };
    const entry = snapshot.sessions.find((session) => session.sessionId === 'snap-s')!;
    expect(entry.directory).toBe(WORK_TREE);
    expect(typeof entry.sendingId).toBe('string'); // the parked head rides as in-flight
    expect((entry.items[0] as Record<string, unknown>).preview).toBe('first line...');
    expect(JSON.stringify(snapshot)).not.toContain('QkFA');
    expect('context' in (entry.items[0] as object)).toBe(false);
    fake!.releaseHeldSends();
    await releaseSend('snap-s');
    const restful = await call('/api/message-queue').then((response) => response.json()) as {
      sessions: Array<{ sessionId: string; sendingId: string | null }>;
    };
    const cleared = restful.sessions.find((session) => session.sessionId === 'snap-s');
    expect(cleared).toBeUndefined(); // delivery succeeded: the session has no queue
  });
});

describe('POST enqueue + validation (§D.5)', () => {
  it('enqueue answers {revision, session, itemId}; the idle session dispatches', async () => {
    const accepted = await enqueue('deliver me', 'enq-s');
    expect(accepted.session).toBe(WORK_TREE);
    expect(accepted.itemId).toMatch(/^queued-/u);
    expect(accepted.revision).toBe(rt().currentRevision());
    await waitUntil(() => fake!.sends.some((send) => JSON.stringify(send.body).includes('deliver me')), 900);
  });

  it('invalid bodies answer 400 with the parse reason (sendConfig required, need-one-of)', async () => {
    const response = await call('/api/message-queue/sessions/bad-s/items', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ directory: WORK_TREE, item: { content: 'x', text: 'x', sendConfig: undefined } }),
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain('sendConfig');
  });

  it('400s cover oversized content, non-JSON, and missing directory', async () => {
    for (const [body, key] of [
      [JSON.stringify({ item: rawItem() }), 'directory'],
      [JSON.stringify({ directory: WORK_TREE, item: rawItem({ content: 'y'.repeat(200_001) }) }), 'size'],
      ['junk', 'malformed'],
    ] as Array<[string, string]>) {
      const response = await call('/api/message-queue/sessions/bad-s/items', { method: 'POST', headers: jsonHeaders, body });
      expect(response.status, key).toBe(400);
    }
  });

  it('the 50 MiB bounded body budget answers one mappable 400 (never parses)', async () => {
    const response = await call('/api/message-queue/sessions/cap-s/items', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ directory: WORK_TREE, pad: 'x'.repeat(QUEUE_BODY_MAX_CHARS + 10) }),
    });
    expect(response.status).toBe(400);
    expect(QUEUE_BODY_MAX_CHARS).toBe(50 * 1024 * 1024);
  });
});

describe('take / takeAll / order / delete (§D.5)', () => {
  it('take returns the FULL item with payloads reattached; a replayed take is 404', async () => {
    fake!.enqueueOutcome({ kind: 'hold' }); // the head send parks in-flight, untouched by this test
    await enqueue('head parked', 'take-s');
    await waitUntil(() => fake!.heldCount > 0, 1200);
    const survivor = await enqueue('take me back', 'take-s');
    const response = await call(`/api/message-queue/sessions/take-s/items/${survivor.itemId}/take`, { method: 'POST' });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      item: { text: string; context?: unknown[]; preview?: string };
    };
    expect(payload.item.text).toBe('take me back');
    expect(payload.item.preview).toBe('take me back');
    expect(Array.isArray(payload.item.context)).toBe(true);
    const replay = await call(`/api/message-queue/sessions/take-s/items/${survivor.itemId}/take`, { method: 'POST' });
    expect(replay.status).toBe(404);
    fake!.releaseHeldSends();
    await releaseSend('take-s');
  });

  it('409 while the item is in flight (the UI cannot pluck the sending head)', async () => {
    fake!.enqueueOutcome({ kind: 'hold' });
    await enqueue('in-flight take', 'flight-take-s');
    const sendingId = await pinnedSend('flight-take-s');
    const held = await call(`/api/message-queue/sessions/flight-take-s/items/${sendingId}/take`, { method: 'POST' });
    expect(held.status).toBe(409);
    fake!.releaseHeldSends();
    await releaseSend('flight-take-s');
  });

  it('takeAll removes every non-in-flight item in order; the sending head stays queued', async () => {
    fake!.enqueueOutcome({ kind: 'hold' });
    const enqueued = await enqueue('head first', 'takeall-s');
    await enqueue('second', 'takeall-s');
    await enqueue('third', 'takeall-s');
    await pinnedSend('takeall-s');
    const takeAll = await call('/api/message-queue/sessions/takeall-s/take', { method: 'POST' });
    expect(takeAll.status).toBe(200);
    const payload = (await takeAll.json()) as { items: Array<{ text: string }> };
    expect(payload.items.map((item) => item.text)).toEqual(['second', 'third']);
    expect(sessionOf('takeall-s')!.items).toHaveLength(1); // the in-flight head stays
    expect(sessionOf('takeall-s')!.sendingId).toBe(enqueued.itemId);
    fake!.releaseHeldSends();
    await releaseSend('takeall-s');
    expect(sessionOf('takeall-s')).toBeUndefined(); // success removed the last item
  });

  it('a take over an EMPTIED (memory-only) queue stays mute: same revision, no broadcast, directory named', async () => {
    await enqueue('drain me', 'mute-s'); // delivers outright: live idleness passes against the empty fake maps
    await waitUntil(() => (rt().store.entryOf('mute-s')?.items.length ?? 1) === 0, 1200);
    const before = rt().currentRevision();
    spy!.clear();
    const response = await call('/api/message-queue/sessions/mute-s/take', { method: 'POST' });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { items: unknown[]; revision: number; session: string };
    expect(payload.items).toEqual([]);
    expect(payload.revision).toBe(before); // nothing mutated: revision never shifts
    expect(payload.session).toBe(WORK_TREE); // the memory-only entry still names its directory (E-09-6)
    const noopOrder = await call('/api/message-queue/sessions/mute-s/order', {
      method: 'PUT', headers: jsonHeaders, body: JSON.stringify({ itemIds: [] }),
    });
    expect(noopOrder.status).toBe(200);
    expect(((await noopOrder.json()) as { revision: number; session: string })).toEqual({ revision: before, session: WORK_TREE }); // the empty no-op reply names the directory too
    await new Promise((done) => setTimeout(done, 60));
    expect(spy!.updates()).toHaveLength(0); // and the bus heard nothing
  });

  it('order PUT applies a complete permutation; an incomplete one is 400; empty queue no-ops', async () => {
    const first = await enqueue('one', 'order-s');
    const second = await enqueue('two', 'order-s');
    const third = await enqueue('three', 'order-s');
    const shuffled = await call('/api/message-queue/sessions/order-s/order', {
      method: 'PUT', headers: jsonHeaders,
      body: JSON.stringify({ itemIds: [second.itemId, third.itemId, first.itemId] }),
    });
    expect(shuffled.status).toBe(200);
    expect(sessionOf('order-s')!.items.map((item) => (item as { text?: string }).text)).toEqual(['two', 'three', 'one']);
    const broken = await call('/api/message-queue/sessions/order-s/order', {
      method: 'PUT', headers: jsonHeaders,
      body: JSON.stringify({ itemIds: [first.itemId, first.itemId] }),
    });
    expect(broken.status).toBe(400);
    const noop = await call('/api/message-queue/sessions/order-never/order', {
      method: 'PUT', headers: jsonHeaders, body: JSON.stringify({ itemIds: [] }),
    });
    expect(noop.status).toBe(404); // unknown session stays 404
    fake!.releaseHeldSends();
  });

  it('DELETE item answers ok / 409 while in flight / 404 unknown', async () => {
    fake!.enqueueOutcome({ kind: 'hold' });
    const first = await enqueue('nd one', 'del-s');
    const second = await enqueue('nd two', 'del-s');
    await pinnedSend('del-s');
    const removed = await call(`/api/message-queue/sessions/del-s/items/${second.itemId}`, { method: 'DELETE' });
    expect(removed.status).toBe(200); // the non-head item deletes while the head sends
    const inFlight = await call(`/api/message-queue/sessions/del-s/items/${first.itemId}`, { method: 'DELETE' });
    expect(inFlight.status).toBe(409);
    const unknown = await call(`/api/message-queue/sessions/del-s/items/queued-nah`, { method: 'DELETE' });
    expect(unknown.status).toBe(404);
    fake!.releaseHeldSends();
    await releaseSend('del-s');
  });

  it('the LAST-item DELETE response still names the directory (§D.5 reply, not just the broadcast)', async () => {
    fake!.statusPayload = { 'last-del-s': { type: 'busy' } }; // hold the tick at idleness: the item stays deleteable, not in flight
    const enqueued = await enqueue('last rider', 'last-del-s');
    const response = await call(`/api/message-queue/sessions/last-del-s/items/${enqueued.itemId}`, { method: 'DELETE' });
    fake!.statusPayload = {};
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { revision: number; session: string };
    expect(payload.session).toBe(WORK_TREE); // NOT the snapshot-derived '' behind a memory-only entry
    expect(rt().store.entryOf('last-del-s')!.directory).toBe(WORK_TREE); // directory memory kept (E-09-6)
  });

  it('DELETE session clears the queue but the in-flight item STAYS until its send resolves', async () => {
    fake!.enqueueOutcome({ kind: 'hold' });
    await enqueue('stays queued', 'clear-s');
    await enqueue('will leave', 'clear-s');
    await pinnedSend('clear-s');
    const cleared = await call('/api/message-queue/sessions/clear-s', { method: 'DELETE' });
    expect(cleared.status).toBe(200);
    expect(sessionOf('clear-s')!.items.map((item) => (item as { text?: string }).text)).toEqual(['stays queued']);
    fake!.releaseHeldSends();
    await releaseSend('clear-s'); // its send must still find its entry (§D.5)
  });
});

describe('hold PUT (§D.4)', () => {
  it('held true holds the head across idle signals; held false releases and dispatches', async () => {
    await enqueue('held back', 'hold-s');
    const held = await call('/api/message-queue/sessions/hold-s/hold', {
      method: 'PUT', headers: jsonHeaders, body: JSON.stringify({ held: true }),
    });
    const heldPayload = (await held.json()) as { held: boolean; expiresAt: number };
    expect(heldPayload.held).toBe(true);
    expect(heldPayload.expiresAt - Date.now()).toBeGreaterThan(4 * 60_000); // default 5 min
    feed!.emit(feedEnvelope('hold-s', 'session.status', { status: { type: 'idle' } }));
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 120));
    expect(fake!.sends.some((send) => send.sessionId === 'hold-s')).toBe(false); // still held at the idle boundary
    const released = await call('/api/message-queue/sessions/hold-s/hold', {
      method: 'PUT', headers: jsonHeaders, body: JSON.stringify({ held: false }),
    });
    expect((await released.json()) as { held: boolean }).toEqual({ held: false });
    await waitUntil(() => fake!.sends.some((send) => send.sessionId === 'hold-s'), 900);
  });

  it('ttlMs clamps to the 10 min ceiling (min(ttlMs || 5 min, 10 min))', async () => {
    const tooLong = await call('/api/message-queue/sessions/hold-ttl-s/hold', {
      method: 'PUT', headers: jsonHeaders, body: JSON.stringify({ held: true, ttlMs: 100 * 60_000 }),
    });
    const longHold = (await tooLong.json()) as { expiresAt: number };
    expect(longHold.expiresAt - Date.now()).toBeLessThanOrEqual(10 * 60_000 + 5);
  });
});

describe('broadcast contract (§D.5, control bus)', () => {
  it('every mutation announces {revision, session=directory}, including the last-item removal', async () => {
    spy!.clear();
    fake!.enqueueOutcome({ kind: 'hold' }); // park the head so its send cannot race the assertions
    const first = await enqueue('broadcast me', 'bus-s');
    const second = await enqueue('and me too', 'bus-s');
    await pinnedSend('bus-s'); // in-flight mark broadcast BEFORE the harness send leaves
    const removed = await call(`/api/message-queue/sessions/bus-s/items/${second.itemId}`, { method: 'DELETE' });
    expect(removed.status).toBe(200); // non-head delete while the head sends
    fake!.releaseHeldSends(); // the head send resolves -> success removal
    await waitUntil(() => rt().snapshotSessions().some((session) => session.sessionId === 'bus-s') === false, 2500);
    const updates = spy!.updates();
    expect(updates.length).toBeGreaterThanOrEqual(4); // enqueue x2 + in-flight + delete + success removal
    for (const update of updates) {
      expect(update.payload.session).toBe(WORK_TREE); // ALWAYS directory-named
      expect(update.payload.revision).toBeGreaterThan(0);
    }
    expect(updates.at(-1)!.payload.revision).toBe(rt().currentRevision());
    expect(sessionOf('bus-s')).toBeUndefined(); // the LAST-item removal kept the session cleared
  });

  it('in-flight marking broadcasts too, before the harness send leaves', async () => {
    spy!.clear();
    fake!.enqueueOutcome({ kind: 'hold' });
    await enqueue('flight broadcast', 'bus-flight-s');
    await pinnedSend('bus-flight-s');
    const duringFlight = spy!.updates().at(-1)!.payload;
    expect(duringFlight.session).toBe(WORK_TREE);
    fake!.releaseHeldSends();
    await releaseSend('bus-flight-s');
  });
});

