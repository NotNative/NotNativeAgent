// SPDX-License-Identifier: Apache-2.0
/**
 * P9-1 dispatch gates (doc 12 §D.3.6–§D.3.8): slash command resolution
 * against the harness catalog (command route vs prompt route, skill
 * instruction, `$ARGUMENTS`/`$1..$N` expansion, quoted words, append-if-none,
 * catalog miss), the exact prompt part order, knowledge attach +
 * recordDelivered-after-acceptance, onPromptSent hooks, the failure pitch
 * with the next-item idle gate, reconcileAll on feed connect, and the
 * startup load-then-reconcile boot contract.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ControlBusSpy,
  FakeQueueFeed,
  FakeQueueHarness,
  fakeKnowledge,
  feedEnvelope,
  installFakeHarness,
  makeQueueRuntime,
  rawItem,
  SHORT_TIMING,
  WORK_TREE,
  waitUntil,
  type ProjectKnowledgeProvider,
} from './helpers/queue-fakes.ts';
import { onPromptSent } from '../queue/queue-hooks.ts';
import { QUEUE_FILE_NAME } from '../queue/queue-store.ts';
import type { MessageQueueRuntime } from '../queue/queue-runtime.ts';
import { failureDelayMs } from '../queue/queue-runtime.ts';

const sessionId = 'sx-sess';

interface Rig {
  fake: FakeQueueHarness;
  feed: FakeQueueFeed;
  spy: ControlBusSpy;
  runtime: MessageQueueRuntime;
}

function rig(): Rig {
  const fake = new FakeQueueHarness();
  installFakeHarness(fake); // dispatch rides the adapter seam (last registration wins)
  const feed = new FakeQueueFeed();
  const spy = new ControlBusSpy().start();
  const runtime = makeQueueRuntime(feed, mkdtempSync(`${tmpdir()}${sep}nnd-p91-r2-`), SHORT_TIMING);
  runtime.start();
  return { fake, feed, spy, runtime };
}

function cleanup(session: Rig): void {
  session.fake.releaseHeldSends();
  session.fake.releaseStatusChecks();
  session.spy.stop();
  session.runtime.dispose();
}

const enqueue = (session: Rig, content: string, overrides: Record<string, unknown> = {}, terminal: string = sessionId): { itemId: string } =>
  session.runtime.enqueueItem(terminal, WORK_TREE, rawItem({ content, ...overrides }));

const idle = (session: Rig, terminal: string = sessionId): void =>
  session.feed.emit(feedEnvelope(terminal, 'session.status', { status: { type: 'idle' } }));

const sendsTo = (session: Rig, terminal: string = sessionId): FakeQueueHarness['sends'] =>
  session.fake.sends.filter((send) => send.sessionId === terminal);

describe('backoff formula (§D.3.8, single authority)', () => {
  it('failure delay doubles from the base and caps at 60 s', () => {
    const timing = { backoffBaseMs: 2000, backoffMaxMs: 60_000 };
    expect(failureDelayMs(1, timing)).toBe(2000);
    expect(failureDelayMs(2, timing)).toBe(4000);
    expect(failureDelayMs(3, timing)).toBe(8000);
    expect(failureDelayMs(5, timing)).toBe(32_000);
    expect(failureDelayMs(6, timing)).toBe(60_000); // cap engaged
    expect(failureDelayMs(30, timing)).toBe(60_000);
    expect(failureDelayMs(1, { backoffBaseMs: 60, backoffMaxMs: 60_000 })).toBe(60);
  });
});

describe('slash routing (§D.3.6, NND-side expansion → prompt_async)', () => {
  it('a command WITH a served template expands the template into the delivered text ($ARGUMENTS) on prompt_async', async () => {
    const session = rig();
    try {
      session.fake.catalog = [{ name: 'plan', source: 'command', template: 'Draft a plan for $ARGUMENTS' }];
      await enqueue(session, '/plan the rollout today', { context: [{ kind: 'instruction', text: 'be terse' }] });
      await waitUntil(() => sendsTo(session).length === 1, 900);
      const send = sendsTo(session)[0]!;
      expect(send.route).toBe('prompt_async');
      const parts = send.body.parts as Array<Record<string, unknown>>;
      expect(parts[0]!.text).toBe('Draft a plan for the rollout today'); // expansion replaced the text
      expect(parts.some((part) => part.text === 'be terse')).toBe(true);
    } finally {
      cleanup(session);
    }
  });

  it('a command WITHOUT context with a served template also expands and rides prompt_async', async () => {
    const session = rig();
    try {
      session.fake.catalog = [{ name: 'review', source: 'command', template: 'Review the changes ($ARGUMENTS)' }];
      await enqueue(session, '/review the staging diff');
      await waitUntil(() => sendsTo(session).length === 1, 900);
      const send = sendsTo(session)[0]!;
      expect(send.route).toBe('prompt_async'); // Why: NNA owns no command route; NND expands its own §B.8 grammar
      const parts = send.body.parts as Array<Record<string, unknown>>;
      expect(parts[0]!.text).toBe('Review the changes (the staging diff)');
      expect('command' in send.body).toBe(false); // the dead command route is never called
      expect(session.fake.servedPaths.some((path) => path.startsWith('POST /session/') && path.endsWith('/command'))).toBe(false);
    } finally {
      cleanup(session);
    }
  });

  it('a skill-shaped slash that NNA\'s served skills inventory names rides prompt_async with the skill instruction (no catalog served)', async () => {
    const session = rig();
    try {
      session.fake.skillsInventory = { version: 1, state: 'discovered', skills: [{ id: 'explain', version: '1', description: null, invocation: 'user' }] };
      session.fake.commandCatalogFailure = true; // real NNA serves no /command catalog
      await enqueue(session, '/explain recursion basics');
      await waitUntil(() => sendsTo(session).length === 1, 900);
      const send = sendsTo(session)[0]!;
      expect(send.route).toBe('prompt_async');
      const parts = send.body.parts as Array<Record<string, unknown>>;
      expect(parts[0]!.text).toBe('/explain recursion basics'); // skill keeps its invocation text
      expect(parts[0]!.synthetic).toBeUndefined();
      expect(parts.some((part) => part.text === 'The user explicitly invoked the explain skill. Use the corresponding skill tool to handle this request.')).toBe(true);
    } finally {
      cleanup(session);
    }
  });

  it('a catalog skill entry still resolves as a skill when the harness serves a catalog', async () => {
    const session = rig();
    try {
      session.fake.catalog = [{ name: 'explain', source: 'skill' }];
      await enqueue(session, '/explain recursion basics');
      await waitUntil(() => sendsTo(session).length === 1, 900);
      const send = sendsTo(session)[0]!;
      expect(send.route).toBe('prompt_async');
      const parts = send.body.parts as Array<Record<string, unknown>>;
      expect(parts[0]!.text).toBe('/explain recursion basics');
      expect(parts.some((part) => part.text === 'The user explicitly invoked the explain skill. Use the corresponding skill tool to handle this request.')).toBe(true);
    } finally {
      cleanup(session);
    }
  });

  it('$1..$N uses quoted-or-bare words with the LAST placeholder absorbing the remainder', async () => {
    const session = rig();
    try {
      session.fake.catalog = [{ name: 'fix', source: 'command', template: 'Fix $1 then $2' }];
      await enqueue(session, '/fix alpha "beta gamma" delta', { context: [{ kind: 'synthetic', text: 's' }] });
      await waitUntil(() => sendsTo(session).length === 1, 900);
      const send = sendsTo(session)[0]!;
      expect(send.route).toBe('prompt_async');
      const parts = send.body.parts as Array<Record<string, unknown>>;
      expect(parts[0]!.text).toBe('Fix alpha then beta gamma delta');
    } finally {
      cleanup(session);
    }
  });

  it('no placeholder in the template appends the arguments (append-if-none)', async () => {
    const session = rig();
    try {
      session.fake.catalog = [{ name: 'check', source: 'command', template: 'Run the checks' }];
      await enqueue(session, '/check now loudly', { context: [{ kind: 'synthetic', text: 's' }] });
      await waitUntil(() => sendsTo(session).length === 1, 900);
      const parts = sendsTo(session)[0]!.body.parts as Array<Record<string, unknown>>;
      expect(parts[0]!.text).toBe('Run the checks now loudly');
    } finally {
      cleanup(session);
    }
  });

  it('an unknown slash name degrades to plain prose when no catalog is served (real-NNA catalog miss)', async () => {
    const session = rig();
    try {
      session.fake.commandCatalogFailure = true;
      await enqueue(session, '/mystery arg');
      await waitUntil(() => sendsTo(session).length === 1, 900);
      const send = sendsTo(session)[0]!;
      expect(send.route).toBe('prompt_async');
      expect((send.body.parts as Array<{ text?: string }>)[0]!.text).toBe('/mystery arg');
    } finally {
      cleanup(session);
    }
  });

  it('a non-skill catalog entry without a template keeps the raw invocation (nothing to expand)', async () => {
    const session = rig();
    try {
      session.fake.catalog = [{ name: 'check', source: 'command' }];
      await enqueue(session, '/check now');
      await waitUntil(() => sendsTo(session).length === 1, 900);
      const parts = sendsTo(session)[0]!.body.parts as Array<{ text?: string }>;
      expect(parts[0]!.text).toBe('/check now');
    } finally {
      cleanup(session);
    }
  });
});

describe('prompt part order (§D.3.6, exact)', () => {
  it('text, files, context (instructions first), instruction kind, knowledge, agent — verbatim', async () => {
    const session = rig();
    const knowledge = fakeKnowledge();
    try {
      const runtime = makeQueueRuntime(session.feed, mkdtempSync(`${tmpdir()}${sep}nnd-p91-r3-`), SHORT_TIMING, knowledge as ProjectKnowledgeProvider);
      runtime.start();
      runtime.enqueueItem(sessionId, WORK_TREE, rawItem({
        // the leading mention rides the composer idiom: the parser strips it
        // into the {type:'agent',name:'scout'} part AFTER everything (§D.1/§D.3.6)
        content: '@scout check this',
        attachments: [{ id: 'a1', filename: 'a.png', mimeType: 'image/png', size: 3, source: 'server', dataUrl: 'data:image/png;base64,QkE=' }],
        context: [
          { kind: 'context', text: 'ctx body', metadata: { k: 1 }, instructions: 'explain ctx' },
          { kind: 'instruction', text: 'be terse' },
          { kind: 'synthetic', text: 'sys note' },
        ],
      }));
      await waitUntil(() => session.fake.sends.filter((send) => send.sessionId === sessionId).length === 1, 1200);
      const parts = session.fake.sends[0]!.body.parts as Array<Record<string, unknown>>;
      expect(parts.map((part) => part.type)).toEqual(['text', 'file', 'text', 'text', 'text', 'text', 'text', 'agent']);
      expect(parts[0]!.text).toBe('check this');
      expect((parts[1] as { mime?: string }).mime).toBe('image/png');
      expect((parts[1] as { url?: string }).url).toBe('data:image/png;base64,QkE=');
      expect(parts[2]!.text).toBe('explain ctx'); // instructions own synthetic slot BEFORE the entry
      expect(parts[3]!.text).toBe('ctx body');
      expect(parts[3]!.metadata).toEqual({ k: 1 }); // the metadata rides the synthetic part
      expect(parts[4]!.text).toBe('be terse');
      expect(parts[5]!.text).toBe('sys note');
      expect(parts[6]!.text).toBe('project knowledge body'); // position 5
      expect(parts[7]!.type).toBe('agent');
      expect((parts[7] as { name?: string }).name).toBe('scout'); // mention rides AFTER everything
      expect(knowledge.state.delivered).toBe(1); // recordDelivered AFTER acceptance
      runtime.dispose();
    } finally {
      cleanup(session);
    }
  });
});

describe('knowledge + hooks (§D.3.6/§D.3.7)', () => {
  it('knowledge lookup failure sends without it; recordDelivered stays silent', async () => {
    const session = rig();
    try {
      const knowledge = fakeKnowledge();
      knowledge.state.fail = true;
      const runtime = makeQueueRuntime(session.feed, mkdtempSync(`${tmpdir()}${sep}nnd-p91-r4-`), SHORT_TIMING, knowledge as ProjectKnowledgeProvider);
      runtime.start();
      runtime.enqueueItem(sessionId, WORK_TREE, rawItem({ content: 'plain text and knowledge' }));
      await waitUntil(() => session.fake.sends.length === 1, 1200);
      const parts = session.fake.sends[0]!.body.parts as Array<{ text?: string }>;
      expect(parts.some((part) => part.text === 'project knowledge body')).toBe(false);
      expect(knowledge.state.delivered).toBe(0);
      runtime.dispose();
    } finally {
      cleanup(session);
    }
  });

  it('a rejected dispatch keeps knowledge pending; the accepted retry records delivery once', async () => {
    const session = rig();
    try {
      const knowledge = fakeKnowledge();
      session.fake.enqueueOutcome({ kind: 'fail', status: 500 });
      const runtime = makeQueueRuntime(session.feed, mkdtempSync(`${tmpdir()}${sep}nnd-p91-r5-`), SHORT_TIMING, knowledge as ProjectKnowledgeProvider);
      runtime.start();
      runtime.enqueueItem(sessionId, WORK_TREE, rawItem({ content: 'retry knowledge' }));
      await waitUntil(() => session.fake.sends.length === 1, 1200);
      expect(knowledge.state.delivered).toBe(0); // rejected: knowledge carries again next time
      await waitUntil(() => session.fake.sends.length === 2, 1600); // backoff re-dispatch succeeded
      expect(knowledge.state.delivered).toBe(1);
    } finally {
      cleanup(session);
    }
  });

  it('onPromptSent hooks fire per delivered item and unsubscribe cleanly', async () => {
    const session = rig();
    const seen: string[] = [];
    const off = onPromptSent((sentSessionId, _directory, itemId) => {
      void sentSessionId; void _directory;
      seen.push(itemId);
    });
    try {
      const enqueued = enqueue(session, 'hook delivery', {}, 'hooks-s');
      idle(session, 'hooks-s');
      await waitUntil(() => seen.length === 1, 1200);
      expect(seen[0]).toBe(enqueued.itemId);
      off(); // the second delivery must NOT re-fire after unsubscribing
      enqueue(session, 'second delivery', {}, 'hooks-s');
      idle(session, 'hooks-s');
      await waitUntil(() => sendsTo(session, 'hooks-s').length === 2, 1200);
      expect(seen.length).toBe(1);
    } finally {
      cleanup(session);
    }
  });
});

describe('failure pitch + next-item idle gate (§D.3.8)', () => {
  it('failure: item kept, backoff record set; success: removal + never back-to-back', async () => {
    const session = rig();
    try {
      session.spy.clear();
      session.fake.enqueueOutcome({ kind: 'fail', status: 500 });
      const enqueued = enqueue(session, 'fails once', {}, 'gate-s');
      idle(session, 'gate-s');
      await waitUntil(() => sendsTo(session, 'gate-s').length === 1, 1200);
      expect(session.runtime.store.entryOf('gate-s')!.items[0]!.id).toBe(enqueued.itemId); // kept
      const failureUpdates = session.spy.updates().filter((update) => update.payload.session === WORK_TREE);
      expect(failureUpdates.length).toBeGreaterThanOrEqual(2); // in-flight pitch + failure pitch
      await waitUntil(() => sendsTo(session, 'gate-s').length === 2, 1600); // backoff retry of the SAME head
      session.fake.statusPayload = { 'gate-s': { type: 'busy' } };
      enqueue(session, 'queued behind', {}, 'gate-s'); // the NEXT item waits for a busy→idle cycle
      await new Promise((done) => setTimeout(done, 100));
      expect(sendsTo(session, 'gate-s')).toHaveLength(2); // never back-to-back without an idle
      session.fake.statusPayload = {};
      idle(session, 'gate-s'); // the fresh busy→idle cycle delivers the next item
      await waitUntil(() => sendsTo(session, 'gate-s').length === 3, 1600);
      // success REMOVED the item (§D.5): the queue is empty while the entry
      // survives as in-RAM directory memory (§D.2: emptied queues stay
      // memory-only — the entry itself never drops without session.deleted)
      await waitUntil(() => (session.runtime.store.entryOf('gate-s')?.items.length ?? 1) === 0, 1200);
      await session.runtime.store.flushWrites();
      const persisted = JSON.parse(readFileSync(session.runtime.store.file, 'utf8')) as { sessions: Record<string, unknown> };
      expect(persisted.sessions['gate-s']).toBeUndefined(); // the emptied queue left the file
      expect(session.runtime.store.entryOf('gate-s')).not.toBeNull(); // directory memory stays in RAM
    } finally {
      cleanup(session);
    }
  });
});

describe('feed reconnect + startup (§D.3)', () => {
  it('a reconcile probe re-enables writes after a hard read failure (§D.2 "a later load success re-enables")', async () => {
    const dir = mkdtempSync(`${tmpdir()}${sep}nnd-p91-r7-`);
    const file = joinPath(dir, QUEUE_FILE_NAME);
    const fake = new FakeQueueHarness();
    installFakeHarness(fake);
    fake.statusPayload = { 'rw-s': { type: 'busy' } }; // the re-armed tick must not dispatch; the queue stays in RAM
    const feed = new FakeQueueFeed();
    mkdirSync(file); // a DIRECTORY at the file path: every read fails hard
    const runtime = makeQueueRuntime(feed, dir, SHORT_TIMING);
    runtime.start(); // load = 'disabled': writes off, in-memory stays owner
    expect(runtime.store.writesEnabled).toBe(false);
    runtime.enqueueItem('rw-s', WORK_TREE, rawItem({ content: 'in memory only' }));
    rmSync(file, { recursive: true });
    writeFileSync(file, JSON.stringify({ version: 1, revision: 900, sessions: {} })); // stale disk state
    runtime.reconcileAll(); // the (re)connect beat carries the recovery probe
    await waitUntil(() => runtime.store.writesEnabled, 900);
    await runtime.store.flushWrites();
    const doc = JSON.parse(readFileSync(file, 'utf8')) as { revision: number; sessions: Record<string, unknown> };
    expect(doc.revision).toBeGreaterThanOrEqual(1); // the stale disk 900 was never adopted
    expect(doc.sessions['rw-s']).toBeDefined(); // the in-memory queue re-persisted, never reverted
    runtime.dispose();
  });

  it('feed connect re-arms every armed-less session with items (reconcileAll)', async () => {
    const session = rig();
    try {
      session.fake.statusPayload = { [sessionId]: { type: 'busy' } }; // ticks gate on the busy map
      enqueue(session, 'reconnect me');
      await new Promise((done) => setTimeout(done, 120)); // the busy map blocked dispatch
      expect(sendsTo(session)).toHaveLength(0);
      session.fake.statusPayload = {}; // the harness recovered; NO idle event fires
      session.feed.connected(); // hub (re)connect → reconcileAll re-arms
      await waitUntil(() => sendsTo(session).length === 1, 1200);
      expect(JSON.stringify(sendsTo(session)[0]!.body)).toContain('reconnect me');
    } finally {
      cleanup(session);
    }
  });

  it('startup loads the persisted file, then reconcileAll delivers without any feed event', async () => {
    const dir = mkdtempSync(`${tmpdir()}${sep}nnd-p91-r6-`);
    const fake = new FakeQueueHarness();
    installFakeHarness(fake); // the dispatch seam reads the registry AT CALL TIME; without this both parks went to the previous test's adapter
    const feed = new FakeQueueFeed();
    const spy = new ControlBusSpy().start();
    const first = makeQueueRuntime(feed, dir, SHORT_TIMING);
    first.start();
    fake.enqueueOutcome({ kind: 'hold' }); // park the first dispatch so the item persists
    first.enqueueItem(sessionId, WORK_TREE, rawItem({ content: 'survives a restart' }));
    await waitUntil(() => fake.heldCount > 0, 1200);
    await first.store.flushWrites();
    first.dispose(); // parked feed promise stays; the worker ends with it
    spy.clear();
    const revived = makeQueueRuntime(feed, dir, SHORT_TIMING);
    revived.start(); // load file, then reconcileAll
    await waitUntil(() => fake.sends.filter((send) => send.route === 'prompt_async').length === 2, 1600);
    const replays = fake.sends.filter((send) => JSON.stringify(send.body).includes('survives a restart'));
    expect(replays.length).toBe(2); // parked first + revived second dispatch of the SAME item
    const revivedUpdates = spy.updates(); // only the revived runtime posts after the clear above
    expect(revivedUpdates.length).toBeGreaterThanOrEqual(2); // in-flight + success removal
    expect(revivedUpdates.every((update) => update.payload.session === WORK_TREE)).toBe(true); // every post-revival broadcast is directory-named
    // revision contract (§D.2/§D.5): enqueue commit + removal commit ONLY —
    // the in-flight mark BROADCASTS without bumping (sendingId is memory-only,
    // so a persisted "sending" flag would strand a message across a restart)
    expect(revived.store.currentRevision).toBeGreaterThanOrEqual(2);
    expect(revived.store.entryOf(sessionId)?.items.length ?? 0).toBe(0); // success removed it
    revived.dispose();
    spy.stop();
  });
});
