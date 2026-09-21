// SPDX-License-Identifier: Apache-2.0
/**
 * P9-1 delivery-loop gates, A half (doc 12 §D.3–§D.5): feed intake
 * (deleted/status/message.updated), the tick gate ladder (empty/sending/
 * hold expiry/abort hold/backoff), live idleness verification with the
 * unknown-rearm posture, and the head stability re-read. The dispatch
 * halves (slash routing, part order, knowledge, reconcile, startup) live
 * in p9-1-message-queue-runtime-2.test.ts.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { sep } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ControlBusSpy,
  FakeQueueFeed,
  FakeQueueHarness,
  assistantInfo,
  feedEnvelope,
  installFakeHarness,
  makeQueueRuntime,
  rawItem,
  SHORT_TIMING,
  WORK_TREE,
  waitUntil,
} from './helpers/queue-fakes.ts';
import type { MessageQueueRuntime } from '../queue/queue-runtime.ts';

const sessionId = 'rt-sess';
const jsonHeaders = { 'content-type': 'application/json' };
let fake: FakeQueueHarness | null = null;
let feed: FakeQueueFeed | null = null;
let spy: ControlBusSpy | null = null;
let runtime: MessageQueueRuntime | null = null;

const rt = (): MessageQueueRuntime => {
  if (!runtime) throw new Error('runtime missing');
  return runtime;
};

beforeAll(() => {
  spy = new ControlBusSpy().start();
});

// Fresh fake+feed+runtime per test: no leaks across tests (timers, sends, holds).
beforeEach(() => {
  if (runtime) rt().dispose();
  fake = new FakeQueueHarness();
  installFakeHarness(fake);
  feed = new FakeQueueFeed();
  runtime = makeQueueRuntime(feed, mkdtempSync(`${tmpdir()}${sep}nnd-p91-rt-`), SHORT_TIMING);
  runtime.start();
  spy!.clear();
});

afterAll(() => {
  spy?.stop();
  if (runtime) rt().dispose();
  fake?.releaseHeldSends();
  fake?.releaseStatusChecks();
});

const enqueue = async (content: string, overrides: Record<string, unknown> = {}, session: string = sessionId): Promise<{ itemId: string }> =>
  rt().enqueueItem(session, WORK_TREE, rawItem({ content, ...overrides }));

const idle = (session: string = sessionId): void =>
  feed!.emit(feedEnvelope(session, 'session.status', { status: { type: 'idle' } }));

const busy = (session: string = sessionId): void =>
  feed!.emit(feedEnvelope(session, 'session.status', { status: { type: 'busy' } }));

const sendsTo = (session: string): FakeQueueHarness['sends'] => fake!.sends.filter((send) => send.sessionId === session);

describe('feed intake (§D.3 processPayload)', () => {
  it('session.deleted drops the whole queue, broadcasts, and forgets the directory memory', async () => {
    spy!.clear();
    await enqueue('marked for deletion', {}, 'deleted-s');
    await enqueue('and the second', {}, 'deleted-s');
    feed!.emit(feedEnvelope('deleted-s', 'session.deleted', {}));
    await waitUntil(() => rt().store.entryOf('deleted-s') === null, 500);
    const updates = spy!.updates().filter((update) => update.payload.session === WORK_TREE);
    expect(updates.at(-1)).toBeDefined(); // commit + broadcast with the directory named
    expect(rt().store.currentRevision).toBeGreaterThan(0);
    await enqueue('rebuilt', {}, 'deleted-s'); // enqueue re-inserts after the forget
    expect(rt().store.entryOf('deleted-s')).toBeDefined();
  });

  it('busy clears the quiet arm; a later idle arms and dispatches the head', async () => {
    await enqueue('coalesced', {}, 'burst-s');
    busy('burst-s'); // clears the armed timer (§D.3)
    await new Promise((done) => setTimeout(done, 60));
    expect(sendsTo('burst-s')).toHaveLength(0);
    idle('burst-s');
    await waitUntil(() => sendsTo('burst-s').length === 1, 900);
  });

  it('message.updated with a completed assistant reply arms dispatch without a status event', async () => {
    await enqueue('arm via completion', {}, 'completed-s');
    busy('completed-s'); // wipe the enqueue-time arm
    feed!.emit(feedEnvelope('completed-s', 'message.updated', { info: assistantInfo({ completed: true }) }));
    await waitUntil(() => sendsTo('completed-s').length === 1, 900);
  });

  it('message.updated MessageAbortedError records the 2 s stop hold (re-arm at expiry)', async () => {
    await enqueue('after a stop', {}, 'aborted-s');
    busy('aborted-s'); // clear arm; the abort arrives mid-busy
    feed!.emit(feedEnvelope('aborted-s', 'message.updated', { info: assistantInfo({ aborted: true }) }));
    feed!.emit(feedEnvelope('aborted-s', 'session.status', { status: { type: 'idle' } }));
    await new Promise((done) => setTimeout(done, 60)); // inside the 150 ms test abort hold
    expect(sendsTo('aborted-s')).toHaveLength(0);
    await waitUntil(() => sendsTo('aborted-s').length === 1, 900); // re-armed at the hold expiry
    expect(rt().abortAtOf('aborted-s')).toBeNull(); // consumed at the tick's check time (holds posture)
  });

  it('MessageAbortedError stamps even without a queue (a stop just before queueing keeps its window)', async () => {
    feed!.emit(feedEnvelope('aborted-nq-s', 'message.updated', { info: assistantInfo({ aborted: true }) }));
    const stamp = rt().abortAtOf('aborted-nq-s');
    expect(stamp).not.toBeNull();
    expect(stamp!).toBeLessThanOrEqual(Date.now());
  });
});

describe('hold expiry auto-release (§D.4)', () => {
  it('a dead asserting UI cannot strand the queue: delivery wakes at the TTL with NO further events', async () => {
    rt().setHold('wake-s', true, 120); // the asserting side dies right after this
    await enqueue('wake at expiry', {}, 'wake-s'); // the quiet arm is REFUSED while held
    busy('wake-s'); // a turn-boundary burst clear — must never kill the hold's own wake
    await new Promise((done) => setTimeout(done, 60)); // inside the hold
    expect(sendsTo('wake-s')).toHaveLength(0); // no delivery raced out while held
    expect(rt().heldExpiryOf('wake-s')).not.toBeNull();
    await waitUntil(() => sendsTo('wake-s').length === 1, 1200); // the expiry wake, no idle needed
    expect(JSON.stringify(sendsTo('wake-s')[0]!.body)).toContain('wake at expiry');
    expect(rt().heldExpiryOf('wake-s')).toBeNull(); // consumed at the wake tick's check time
  });

  it('re-asserting the hold replaces the wake; delivery waits for the NEWEST expiry', async () => {
    rt().setHold('stair-s', true, 160);
    await enqueue('stair rider', {}, 'stair-s');
    await new Promise((done) => setTimeout(done, 80));
    rt().setHold('stair-s', true, 160); // the UI re-asserts (~every 2 min in production)
    await new Promise((done) => setTimeout(done, 100)); // past the FIRST expiry, before the newest
    expect(rt().heldExpiryOf('stair-s')).not.toBeNull();
    expect(sendsTo('stair-s')).toHaveLength(0); // the earlier TTL actually expired silently
    await waitUntil(() => sendsTo('stair-s').length === 1, 1200); // only the replaced wake delivers
    expect(JSON.stringify(sendsTo('stair-s')[0]!.body)).toContain('stair rider');
  });

  it('held:false clears the stale wake; the backstop never re-dispatches over a released handoff', async () => {
    rt().setHold('release-s', true, 150);
    await enqueue('first out', {}, 'release-s');
    await enqueue('fires only on a fresh idle', {}, 'release-s');
    rt().setHold('release-s', false); // release + arm; the stale wake MUST be cleared
    await waitUntil(() => sendsTo('release-s').length === 1, 900); // the released tick delivers the head
    await new Promise((done) => setTimeout(done, 300)); // past the original hold expiry
    expect(sendsTo('release-s')).toHaveLength(1); // no phantom dispatch; the second item waits for idle (§D.3.8)
  });
});

describe('tick gates (§D.3.1)', () => {
  it('tick stays silent for an empty or unknown queue', async () => {
    idle('never-queued-s');
    await new Promise((done) => setTimeout(done, 120));
    expect(fake!.sends).toHaveLength(0);
    expect(spy!.records.some((record) => record.type === 'notnative:message-queue.updated')).toBe(false);
  });

  it('already sending: no second concurrent dispatch for the session', async () => {
    fake!.enqueueOutcome({ kind: 'hold' });
    await enqueue('first flight', {}, 'sending-s');
    await waitUntil(() => fake!.heldCount > 0, 1200);
    idle('sending-s');
    await new Promise((done) => setTimeout(done, 80));
    expect(sendsTo('sending-s')).toHaveLength(1); // the parked send only
    fake!.releaseHeldSends();
    await waitUntil(() => sendsTo('sending-s').length === 1, 1200);
  });

  it('while the hold is CURRENT, idle signals and enqueues never dispatch; the release hands off to the quiet arm', async () => {
    rt().setHold('ttl-hold-s', true, 10 * 60_000); // a long, still-current hold
    await enqueue('waits out the ttl', {}, 'ttl-hold-s'); // the quiet arm is REFUSED while held
    idle('ttl-hold-s'); // §D.4: the armed dispatch timer stays cleared under the hold
    await new Promise((done) => setTimeout(done, 80));
    idle('ttl-hold-s'); // another idle boundary: still silent
    expect(rt().heldExpiryOf('ttl-hold-s')).not.toBeNull();
    expect(sendsTo('ttl-hold-s')).toHaveLength(0); // airtight while current; the wake owns the auto-release (§D.4)
    rt().setHold('ttl-hold-s', false); // released: armQuiet + the stale wake dies with it
    await waitUntil(() => sendsTo('ttl-hold-s').length === 1, 1200);
    expect(rt().heldExpiryOf('ttl-hold-s')).toBeNull();
  });

  it('failure backoff re-arms the same head at nextAttemptAt (60 ms base, 2 s verified shape)', async () => {
    fake!.enqueueOutcome({ kind: 'fail', status: 500 });
    await enqueue('needs one retry', {}, 'backoff-s');
    idle('backoff-s');
    await waitUntil(
      () => sendsTo('backoff-s').length === 1,
      900,
      10,
      () => JSON.stringify({ sends: fake!.sends.length, sessions: rt().snapshotSessions().map((entry) => [entry.sessionId, entry.items.length, entry.sendingId]), holds: rt().heldExpiryOf('backoff-s'), outcomes: fake!.outcomes.map((outcome) => outcome.kind), paths: fake!.servedPaths }),
    );
    const firstFailureAt = Date.now();
    await waitUntil(
      () => sendsTo('backoff-s').length === 2,
      1400,
      10,
      () => JSON.stringify({ sends: fake!.sends.length, sessions: rt().snapshotSessions().map((entry) => [entry.sessionId, entry.items.length, entry.sendingId]) }),
    );
    expect(Date.now() - firstFailureAt).toBeGreaterThanOrEqual(40); // not due before the backoff expiry
    await waitUntil(
      () => (rt().store.entryOf('backoff-s')?.items.length ?? 0) === 0,
      900,
      10,
      () => JSON.stringify({ items: rt().store.entryOf('backoff-s')?.items.length ?? null, sends: fake!.sends.map((send) => send.route), sessions: rt().snapshotSessions().map((entry) => [entry.sessionId, entry.items.length, entry.sendingId]), holds: rt().heldExpiryOf('backoff-s') }),
    ); // the retry removed the item
  });

  it('a failure record for a DIFFERENT head drops; the new head dispatches at once', async () => {
    fake!.enqueueOutcome({ kind: 'fail', status: 500 });
    await enqueue('fails then leaves', {}, 'drop-s');
    idle('drop-s');
    await waitUntil(() => sendsTo('drop-s').length === 1, 900);
    const survivor = await enqueue('fresh head rushes in', {}, 'drop-s');
    void survivor;
    await waitUntil(() => sendsTo('drop-s').length === 2, 900); // next 10 ms tick, no backoff wait
  });

  it('backoff doubles with consecutive failures and caps at 60 s', async () => {
    fake!.enqueueOutcome({ kind: 'fail', status: 503 });
    fake!.enqueueOutcome({ kind: 'fail', status: 503 });
    fake!.enqueueOutcome({ kind: 'fail', status: 503 });
    await enqueue('keep failing', {}, 'double-s');
    idle('double-s');
    await waitUntil(() => sendsTo('double-s').length === 3, 1600); // 60+120+240ms ladder
    expect(rt().currentRevision()).toBeGreaterThan(0);
  });
});

describe('live idleness verification (§D.3.4)', () => {
  it('the status map listing the session (busy) blocks dispatch; absent means idle', async () => {
    fake!.statusPayload = { 'busy-map-s': { type: 'busy' } };
    await enqueue('not while busy', {}, 'busy-map-s');
    await new Promise((done) => setTimeout(done, 120));
    expect(sendsTo('busy-map-s')).toHaveLength(0);
    fake!.statusPayload = {};
    idle('busy-map-s'); // the real busy→idle transition re-arms
    await waitUntil(() => sendsTo('busy-map-s').length === 1, 900);
  });

  it('an unfinished assistant tail blocks dispatch even with no status entry', async () => {
    fake!.tailPayload = [{ info: assistantInfo({}) }]; // no time.completed
    await enqueue('wait for the reply', {}, 'tail-s');
    await new Promise((done) => setTimeout(done, 120));
    expect(sendsTo('tail-s')).toHaveLength(0);
    fake!.tailPayload = [];
    idle('tail-s');
    await waitUntil(() => sendsTo('tail-s').length === 1, 900);
  });

  it('a failed status fetch is unknown: re-armed at the 2 s verify backoff until it recovers', async () => {
    fake!.statusFailure = true;
    await enqueue('unknown status', {}, 'unknown-s');
    await new Promise((done) => setTimeout(done, 200)); // two verifyBackoff cycles (80 ms) fail
    expect(sendsTo('unknown-s')).toHaveLength(0);
    expect(fake!.servedPaths.some((path) => path === 'POST /session/unknown-s/prompt_async')).toBe(false);
    fake!.statusFailure = false;
    idle('unknown-s');
    await waitUntil(() => sendsTo('unknown-s').length === 1, 900);
  });

  it('a failed tail fetch is unknown the same way', async () => {
    fake!.tailFailure = true;
    await enqueue('unknown tail', {}, 'unknown-tail-s');
    await new Promise((done) => setTimeout(done, 200));
    expect(sendsTo('unknown-tail-s')).toHaveLength(0);
    fake!.tailFailure = false;
    idle('unknown-tail-s');
    await waitUntil(() => sendsTo('unknown-tail-s').length === 1, 900);
  });
});

describe('head stability re-read (§D.3.5)', () => {
  it('a queue edit between the record and the send stops the stale head; the new head rides later', async () => {
    const headA = await enqueue('head a', {}, 'stable-s');
    busy('stable-s'); // clear the enqueue arm so nothing dispatches yet
    fake!.gateNextStatusCheck();
    idle('stable-s'); // armed tick starts; its status check parks on the gate
    await waitUntil(() => fake!.parkedStatusChecks > 0, 1200);
    await enqueue('head b', {}, 'stable-s'); // user edited the queue mid-verification
    await enqueue('head c', {}, 'stable-s');
    // the recorded head LEFT the queue while the tick was parked: only a
    // head-ID CHANGE trips the §D.3.5 re-read refusal (adds alone do not)
    expect(rt().deleteItem('stable-s', headA.itemId).kind).toBe('deleted');
    fake!.releaseStatusChecks();
    await waitUntil(() => fake!.parkedStatusChecks === 0, 1200);
    idle('stable-s'); // the stale head was refused: a fresh idle re-arms the CURRENT head
    await waitUntil(() => sendsTo('stable-s').length === 1, 1200); // ... until an idle fires for the new head
    const deliveredText = JSON.stringify(sendsTo('stable-s')[0]!.body);
    expect(deliveredText).not.toContain('head a'); // the stale head never delivered
    expect(deliveredText).toContain('head b'); // the re-read picked the CURRENT head
    fake!.releaseHeldSends();
  });
});
