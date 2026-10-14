// SPDX-License-Identifier: Apache-2.0
/**
 * F9 queue idempotency: a retried enqueue after a lost acknowledgement
 * replays without duplicating the queue, a changed payload under the same id
 * is a conflict, and the dispatch carries the stable `messageID` so a
 * duplicate submission after a lost acceptance is answered by NNA as the
 * already-persisted duplicate instead of a second turn.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FakeQueueFeed, FakeQueueHarness, installFakeHarness, makeQueueRuntime, rawItem,
  SHORT_TIMING, waitUntil, WORK_TREE,
} from './helpers/queue-fakes.ts';
import { QueueItemConflictError, parseQueuedItemInput, sameQueuePayload } from '../queue/queue-item.ts';

const sessionId = 'f9-dup';

function rig() {
  const fake = new FakeQueueHarness();
  installFakeHarness(fake);
  const feed = new FakeQueueFeed();
  const runtime = makeQueueRuntime(feed, mkdtempSync(`${tmpdir()}${sep}nnd-f9-q-`), SHORT_TIMING);
  runtime.start();
  return { fake, runtime };
}

describe('idempotent enqueue (duplicate after a lost acknowledgement)', () => {
  it('the same id with the same payload appends exactly once', () => {
    const { runtime } = rig();
    const raw = rawItem({ content: 'once', id: 'dup-1' });
    const first = runtime.enqueueItem(sessionId, WORK_TREE, raw);
    expect(first.duplicate).toBe(false);
    const replay = runtime.enqueueItem(sessionId, WORK_TREE, raw);
    expect(replay.duplicate).toBe(true);
    expect(replay.itemId).toBe(first.itemId);
    expect(replay.revision).toBe(first.revision); // no mutation: no revision bump
    expect(runtime.store.entryOf(sessionId)?.items).toHaveLength(1);
    runtime.dispose();
  });

  it('the same id with a CHANGED payload is rejected as a conflict', () => {
    const { runtime } = rig();
    runtime.enqueueItem(sessionId, WORK_TREE, rawItem({ content: 'original', id: 'dup-2' }));
    expect(() => runtime.enqueueItem(
      sessionId, WORK_TREE, rawItem({ content: 'tampered', id: 'dup-2' }),
    )).toThrow(QueueItemConflictError);
    expect(runtime.store.entryOf(sessionId)?.items).toHaveLength(1);
    runtime.dispose();
  });

  it('the route answers the replay without a revision bump and 409 on a changed payload', async () => {
    const { runtime } = rig();
    const { createMessageQueueRoutes } = await import('../queue/queue-routes.ts');
    const { Hono } = await import('hono');
    const app = new Hono().route('/', createMessageQueueRoutes(runtime));
    const enqueue = (item: Record<string, unknown>): Promise<Response> =>
      app.fetch(new Request('http://q.test/api/message-queue/sessions/route-s/items', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ directory: WORK_TREE, item }),
      })) as Promise<Response>;
    const item = { content: 'via route', id: 'route-dup', sendConfig: { providerID: 'p', modelID: 'm' } };
    const first = await enqueue(item);
    expect(first.status).toBe(200);
    const firstBody = await first.json() as { revision: number; itemId: string; duplicate?: boolean };
    expect(firstBody.duplicate).toBeUndefined();
    const replay = await enqueue(item);
    const replayBody = await replay.json() as { revision: number; duplicate?: boolean };
    expect(replay.status).toBe(200);
    expect(replayBody.duplicate).toBe(true);
    expect(replayBody.revision).toBe(firstBody.revision);
    const conflict = await enqueue({ content: 'changed', id: 'route-dup', sendConfig: { providerID: 'p', modelID: 'm' } });
    expect(conflict.status).toBe(409);
    runtime.dispose();
  });

  it('payload identity ignores key order but not content', () => {
    const left = parseQueuedItemInput(rawItem({ content: 'x', sendConfig: { providerID: 'p', modelID: 'm' } }));
    const right = parseQueuedItemInput({ sendConfig: { modelID: 'm', providerID: 'p' }, content: 'x' });
    expect(sameQueuePayload(left, right)).toBe(true);
    const tampered = parseQueuedItemInput(rawItem({ content: 'x!', id: 'same' }));
    const original = parseQueuedItemInput(rawItem({ content: 'x', id: 'same' }));
    expect(sameQueuePayload(original, tampered)).toBe(false);
  });
});

describe('duplicate native submission after a lost acknowledgement', () => {
  it('the dispatch carries the stable item id as the NNA idempotency identity', async () => {
    const { fake, runtime } = rig();
    fake.statusPayload = {};
    runtime.enqueueItem(sessionId, WORK_TREE, rawItem({ content: 'deliver once', id: 'stable-item' }));
    await waitUntil(() => fake.sends.length === 1, 2000);
    const body = fake.sends[0]!.body as Record<string, unknown>;
    expect(body.messageID).toBe('stable-item'); // the idempotency identity
    runtime.dispose();
  });

  it('a legacy id already in storage rides without the identity (no send block)', async () => {
    const { fake, runtime } = rig();
    fake.statusPayload = {};
    // A queue file from before the bounded-id rule: the item was persisted
    // under an id NNA would refuse, so it must still deliver (without the
    // idempotency identity) instead of being blocked now.
    runtime.store.enqueue(sessionId, WORK_TREE, {
      id: 'queued-legacy bad id', createdAt: 1, content: 'legacy', text: 'legacy',
      attachments: [], context: [], sendConfig: { providerID: 'p', modelID: 'm' },
    }, () => null);
    runtime.reconcileAll(); // the boot arm for seeded items
    await waitUntil(() => fake.sends.length === 1, 2000);
    expect('messageID' in fake.sends[0]!.body).toBe(false);
    runtime.dispose();
  });

  it('an acceptance the first attempt lost: the re-dispatch repeats the SAME identity', async () => {
    const { fake, runtime } = rig();
    fake.statusPayload = {};
    fake.enqueueOutcome({ kind: 'fail', status: 502 }); // response lost: reject first
    runtime.enqueueItem(sessionId, WORK_TREE, rawItem({ content: 'held head', id: 'held-id' }));
    await waitUntil(() => fake.sends.length === 1, 2000);
    await waitUntil(() => fake.sends.length === 2, 3000); // backoff re-dispatch
    const identities = fake.sends.map((send) => (send.body as Record<string, unknown>).messageID);
    expect(identities).toEqual(['held-id', 'held-id']); // same id → NNA dedupes
    runtime.dispose();
  });

  it('a supplied id outside the bounded shape is refused at parse', () => {
    expect(() => parseQueuedItemInput(rawItem({ content: 'x', id: 'bad id!' })))
      .toThrow(/bounded item identifier/u);
  });
});
