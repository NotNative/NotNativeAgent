// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MessageQueueRuntime, QUEUE_TIMING } from '../queue/queue-runtime.ts';
import { QUEUE_FILE_NAME, MessageQueueStore } from '../queue/queue-store.ts';
import { withConfigLock } from '../scheduled/config-lock.ts';
import { FakeQueueFeed, FakeQueueHarness, feedEnvelope, installFakeHarness, rawItem, SHORT_TIMING, WORK_TREE, waitUntil } from './helpers/queue-fakes.ts';

const scratch = mkdtempSync(join(tmpdir(), 'nnd-queue-xproc-'));
const queueFile = join(scratch, QUEUE_FILE_NAME);
const previousDataDir = process.env.NOTNATIVE_DATA_DIR;
const runtimeModule = new URL('../queue/queue-runtime.ts', import.meta.url).href;
const childScript = [
  "import { writeFileSync } from 'node:fs';",
  "import { join } from 'node:path';",
  'const { MessageQueueRuntime } = await import(process.env.QUEUE_RUNTIME_MODULE);',
  'const { MessageQueueStore, QUEUE_FILE_NAME } = await import(process.env.QUEUE_STORE_MODULE);',
  "const feed = { onEvent: () => () => {}, onConnected: () => () => {}, start() {}, stop() {} };",
  'const runtime = new MessageQueueRuntime(new MessageQueueStore(join(process.env.NOTNATIVE_DATA_DIR, QUEUE_FILE_NAME)), feed);',
  "writeFileSync(process.env.READY_FILE, 'ready');",
  "await runtime.enqueueItemShared(process.env.SESSION_ID, 'D:/work/' + process.env.SESSION_ID, { content: process.env.SESSION_ID, sendConfig: { providerID: 'nnd-mock', modelID: 'mock-smart' } });",
  'runtime.dispose();',
  "writeFileSync(process.env.DONE_FILE, 'done');",
].join('\n');

beforeAll(() => { process.env.NOTNATIVE_DATA_DIR = scratch; });
afterAll(() => {
  if (previousDataDir === undefined) delete process.env.NOTNATIVE_DATA_DIR;
  else process.env.NOTNATIVE_DATA_DIR = previousDataDir;
  rmSync(scratch, { recursive: true, force: true });
});

function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  return new Promise((resolvePromise, reject) => {
    const poll = () => {
      try { readFileSync(path, 'utf8'); resolvePromise(); }
      catch {
        if (Date.now() >= deadline) reject(new Error(`child did not create ${path}`));
        else setTimeout(poll, 10);
      }
    };
    poll();
  });
}

function runWriter(sessionId: string) {
  const ready = join(scratch, `${sessionId}.ready`);
  const done = join(scratch, `${sessionId}.done`);
  const child = spawn(process.execPath, ['--experimental-transform-types', '--input-type=module', '-e', childScript], {
    cwd: resolve(process.cwd(), '..', '..'),
    env: { ...process.env, NOTNATIVE_DATA_DIR: scratch, SESSION_ID: sessionId,
      QUEUE_RUNTIME_MODULE: runtimeModule,
      QUEUE_STORE_MODULE: new URL('../queue/queue-store.ts', import.meta.url).href,
      READY_FILE: ready, DONE_FILE: done },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
  const exited = new Promise<void>((resolvePromise, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolvePromise() : reject(new Error(`child exited ${code}: ${stderr}`)));
  });
  return { ready, done, exited };
}

describe('queue cross-process mutations', () => {
  it('refreshes and serializes concurrent enqueues so neither server overwrites the other', async () => {
    const writers: ReturnType<typeof runWriter>[] = [];
    await withConfigLock(queueFile, async () => {
      writers.push(runWriter('first-session'));
      writers.push(runWriter('second-session'));
      await Promise.all(writers.map((writer) => waitForFile(writer.ready)));
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
      expect(writers.some((writer) => {
        try { readFileSync(writer.done, 'utf8'); return true; } catch { return false; }
      })).toBe(false);
    });
    await Promise.all(writers.map((writer) => writer.exited));
    const store = new MessageQueueStore(queueFile);
    expect(store.load()).toBe('loaded');
    expect(store.entryOf('first-session')?.items[0]?.content).toBe('first-session');
    expect(store.entryOf('second-session')?.items[0]?.content).toBe('second-session');
  });

  it('releases a failed retry claim when the session is deleted, while an active send keeps its claim until settlement', async () => {
    const activeDir = mkdtempSync(join(tmpdir(), 'nnd-queue-delete-'));
    const activeFile = join(activeDir, QUEUE_FILE_NAME);
    const claimFile = `${activeFile}.dispatch-${createHash('sha256').update('deleted-session').digest('hex')}.claim`;
    const fake = new FakeQueueHarness();
    installFakeHarness(fake);
    const feed = new FakeQueueFeed();
    const runtime = new MessageQueueRuntime(new MessageQueueStore(activeFile), feed, undefined, {
      ...QUEUE_TIMING, ...SHORT_TIMING, quietMs: 5, verifyBackoffMs: 5, backoffBaseMs: 2_000,
    });
    try {
      fake.enqueueOutcome({ kind: 'fail', status: 503 });
      runtime.start();
      runtime.enqueueItem('deleted-session', WORK_TREE, rawItem({ content: 'will fail' }));
      await waitUntil(() => fake.sends.length === 1 && existsSync(claimFile) && !(runtime as unknown as { sending: Map<string, string> }).sending.has('deleted-session'), 1_500);

      feed.emit(feedEnvelope('deleted-session', 'session.deleted', {}));
      await waitUntil(() => !existsSync(claimFile) && runtime.store.entryOf('deleted-session') === null, 1_500);
    } finally {
      runtime.dispose();
      rmSync(activeDir, { recursive: true, force: true });
    }

    const sendDir = mkdtempSync(join(tmpdir(), 'nnd-queue-delete-send-'));
    const sendFile = join(sendDir, QUEUE_FILE_NAME);
    const sendClaim = `${sendFile}.dispatch-${createHash('sha256').update('active-delete').digest('hex')}.claim`;
    const sendHarness = new FakeQueueHarness();
    installFakeHarness(sendHarness);
    const sendFeed = new FakeQueueFeed();
    const active = new MessageQueueRuntime(new MessageQueueStore(sendFile), sendFeed, undefined, { ...QUEUE_TIMING, ...SHORT_TIMING, quietMs: 5 });
    try {
      sendHarness.enqueueOutcome({ kind: 'hold' });
      active.start();
      active.enqueueItem('active-delete', WORK_TREE, rawItem({ content: 'in progress' }));
      await waitUntil(() => sendHarness.heldCount > 0 && existsSync(sendClaim), 1_500);
      sendFeed.emit(feedEnvelope('active-delete', 'session.deleted', {}));
      await waitUntil(() => active.store.entryOf('active-delete') === null, 1_500);
      sendFeed.emit(feedEnvelope('active-delete', 'session.deleted', {})); // duplicate delivery must not release an active claim
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
      expect(existsSync(sendClaim)).toBe(true);
      sendHarness.releaseHeldSends(503);
      await waitUntil(() => !existsSync(sendClaim), 1_500);
    } finally {
      sendHarness.releaseHeldSends();
      active.dispose();
      rmSync(sendDir, { recursive: true, force: true });
    }
  });

  it('pins a head claimed by another runtime across take, clear, and enqueue-at-cap operations', async () => {
    const activeFile = join(mkdtempSync(join(tmpdir(), 'nnd-queue-active-')), QUEUE_FILE_NAME);
    const fake = new FakeQueueHarness();
    installFakeHarness(fake);
    const first = new MessageQueueRuntime(new MessageQueueStore(activeFile), new FakeQueueFeed(), undefined, { ...QUEUE_TIMING, ...SHORT_TIMING });
    const second = new MessageQueueRuntime(new MessageQueueStore(activeFile), new FakeQueueFeed(), undefined, { ...QUEUE_TIMING, ...SHORT_TIMING });
    try {
      fake.enqueueOutcome({ kind: 'hold' });
      first.start();
      const queued = first.enqueueItem('active-session', WORK_TREE, rawItem({ content: 'active' }));
      await waitUntil(() => fake.heldCount > 0, 1_500);
      second.start();
      expect((await second.takeItemShared('active-session', queued.itemId)).kind).toBe('inFlight');
      expect((await second.deleteItemShared('active-session', queued.itemId)).kind).toBe('inFlight');
      const taken = await second.takeAllItemsShared('active-session');
      expect(taken.kind === 'taken' ? taken.items : []).toEqual([]);
      const added = await second.enqueueItemShared('active-session', WORK_TREE, rawItem({ content: 'behind active' }));
      const beforeReorder = await second.snapshotSessionsShared();
      expect((await second.reorderItemsShared('active-session', [added.itemId, queued.itemId])).outcome, JSON.stringify(beforeReorder)).toBe('inFlight');
      expect((await second.snapshotSessionsShared()).sessions.find((entry) => entry.sessionId === 'active-session')?.items[0]?.id).toBe(queued.itemId);
      for (let index = 0; index < 20; index += 1) {
        await second.enqueueItemShared('active-session', WORK_TREE, rawItem({ content: `replacement-${index}` }));
      }
      const snapshot = await second.snapshotSessionsShared();
      expect(snapshot.sessions.find((entry) => entry.sessionId === 'active-session')?.items[0]?.id).toBe(queued.itemId);
      const cleared = await second.deleteSessionQueueShared('active-session');
      expect(cleared.kind).toBe('cleared');
      expect(second.store.entryOf('active-session')?.items[0]?.id).toBe(queued.itemId);
      fake.releaseHeldSends();
      await waitUntil(() => first.store.entryOf('active-session')?.items.length === 0, 1_500);
    } finally {
      fake.releaseHeldSends();
      first.dispose();
      second.dispose();
      rmSync(dirname(activeFile), { recursive: true, force: true });
    }
  });
});
