// SPDX-License-Identifier: Apache-2.0
/**
 * messageQueueStore (doc 12 §D.6, SLICE-C task 4): full-snapshot application
 * with revision gates + omission ownership, optimistic add against
 * POST /api/message-queue/sessions/:id/items with restore-on-failure, complete
 * permutation reorder with snapshot-on-failure, in-flight clear protection,
 * takeForInput, and the revision-notification coalescing.
 */
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('../../lib/runtime-fetch.ts', () => ({ runtimeFetch: vi.fn() }));
vi.mock('../../lib/runtime-switch.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/runtime-switch.ts')>();
  return { ...actual, getRuntimeKey: () => 'test-runtime' };
});

import { runtimeFetch } from '../../lib/runtime-fetch.ts';
import {
  __resetMessageQueueStoreForTests,
  applySnapshotForTests,
  DEFAULT_FOLLOW_UP_BEHAVIOR,
  normalizeFollowUpBehavior,
  queueKey,
  useMessageQueueStore,
} from '../useMessageQueueStore.ts';

const fetchMock = runtimeFetch as unknown as Mock;

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 500): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

const DIRECTORY = 'D:/work/demo';
const SESSION = 'ses_q1';
const KEY = queueKey(DIRECTORY, SESSION);

const SERVER_ITEM = (id: string, content = id) => ({
  id,
  createdAt: 1,
  content,
  text: content,
  preview: content.slice(0, 5),
  sendConfig: { providerID: 'nnd-mock', modelID: 'mock-smart' },
  attachments: [],
});

describe('follow-up behavior normalization (§D.7 default queue)', () => {
  it('defaults unset and invalid values to queue while preserving explicit steer', () => {
    expect(DEFAULT_FOLLOW_UP_BEHAVIOR).toBe('queue');
    expect(normalizeFollowUpBehavior(undefined)).toBe('queue');
    expect(normalizeFollowUpBehavior('queue')).toBe('queue');
    expect(normalizeFollowUpBehavior('steer')).toBe('steer');
    expect(normalizeFollowUpBehavior('immediate')).toBe('queue');
  });
});

beforeEach(() => {
  __resetMessageQueueStoreForTests();
  fetchMock.mockReset();
});

describe('snapshot application (§D.6 apply gates)', () => {
  it('applies keyed items, maps sending ids, and owns omissions (a session missing ⇒ cleared)', () => {
    const state = useMessageQueueStore.getState();
    const applied = applySnapshotForTests(state, {
      revision: 7,
      sessions: [
        { sessionId: SESSION, directory: DIRECTORY, items: [SERVER_ITEM('queued-a', 'first message')], sendingId: 'queued-b' },
        { sessionId: 'ses_other', directory: 'D:/other', items: [SERVER_ITEM('queued-x')], sendingId: null },
      ],
    });
    expect(applied.status).toBe('ready');
    expect(applied.queuedMessages![KEY]).toHaveLength(1);
    expect(applied.queuedMessages![KEY]![0]!.id).toBe('queued-a');
    expect(applied.sendingIds![KEY]).toEqual(['queued-b']);
    const second = applySnapshotForTests({ ...(state as object), lastRevision: 7, queuedMessages: applied.queuedMessages! } as never, { revision: 7, sessions: [] });
    // equal revision still applies: a FULL snapshot owns every session it omits
    expect(second.queuedMessages![KEY]).toEqual([]);
  });

  it('malformed items drop silently while valid ones keep the session payload', () => {
    const applied = applySnapshotForTests(useMessageQueueStore.getState(), {
      revision: 3,
      sessions: [{ sessionId: SESSION, directory: DIRECTORY, items: [SERVER_ITEM('good'), { id: 'bad' }], sendingId: null }],
    });
    expect(applied.queuedMessages![KEY]!.map((item) => item.id)).toEqual(['good']);
  });

  it('older snapshots are dropped by the revision gate (never regress)', () => {
    const state = { ...useMessageQueueStore.getState(), lastRevision: 9 } as never as Parameters<typeof applySnapshotForTests>[0];
    expect(applySnapshotForTests(state, { revision: 5, sessions: [] })).toEqual({});
  });
});

describe('mutations (mirror-server-first, refetch on failure)', () => {
  it('addToQueue POSTs the D.1 envelope and refetches the snapshot on acceptance', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ revision: 2, itemId: 'queued-server-1' }))
      .mockResolvedValueOnce(jsonResponse({ revision: 2, sessions: [{ sessionId: SESSION, directory: DIRECTORY, items: [SERVER_ITEM('queued-server-1')], sendingId: null }] }));
    const result = await useMessageQueueStore.getState().addToQueue(DIRECTORY, SESSION, {
      content: 'please continue',
      sendConfig: { providerID: 'nnd-mock', modelID: 'mock-smart', agent: 'build' },
    });
    expect(result.ok).toBe(true);
    const post = fetchMock.mock.calls[0]!;
    expect(post[0]).toContain(`/api/message-queue/sessions/${SESSION}/items`);
    expect(JSON.parse(String(post[1]!.body))).toEqual({
      directory: DIRECTORY,
      item: { content: 'please continue', attachments: [], context: [], sendConfig: { providerID: 'nnd-mock', modelID: 'mock-smart', agent: 'build' } },
    });
    expect(useMessageQueueStore.getState().queuedMessages[KEY]!.map((item) => item.id)).toEqual(['queued-server-1']);
  });

  it('a failed enqueue removes the optimistic entry', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'sendConfig required' }, false, 400));
    const result = await useMessageQueueStore.getState().addToQueue(DIRECTORY, SESSION, {
      content: 'x',
      sendConfig: { providerID: '', modelID: '' },
    });
    expect(result.ok).toBe(false);
    expect(useMessageQueueStore.getState().queuedMessages[KEY] ?? []).toHaveLength(0);
    expect(useMessageQueueStore.getState().lastError).toContain('sendConfig required');
  });

  it('reorder PUTs the FULL permutation and restores the snapshot on failure', async () => {
    applySnapshotForTests(useMessageQueueStore.getState(), {
      revision: 2,
      sessions: [{ sessionId: SESSION, directory: DIRECTORY, items: [SERVER_ITEM('a'), SERVER_ITEM('b'), SERVER_ITEM('c')], sendingId: null }],
    });
    fetchMock.mockResolvedValue(jsonResponse({}, false, 409));
    await useMessageQueueStore.getState().reorderQueue(DIRECTORY, SESSION, ['c', 'a', 'b']);
    const put = fetchMock.mock.calls[0]!;
    expect(put[0]).toContain(`/api/message-queue/sessions/${SESSION}/order`);
    expect(JSON.parse(String(put[1]!.body))).toEqual({ itemIds: ['c', 'a', 'b'] });
    // 409: server rejects — the resync restores the authoritative order a,b,c
    expect(useMessageQueueStore.getState().queuedMessages[KEY]!.map((item) => item.id)).toEqual(['a', 'b', 'c']);
  });

  it('clearQueue DELETEs the session queue while the projection empties locally', async () => {
    applySnapshotForTests(useMessageQueueStore.getState(), {
      revision: 2,
      sessions: [{ sessionId: SESSION, directory: DIRECTORY, items: [SERVER_ITEM('a')], sendingId: null }],
    });
    fetchMock.mockResolvedValue(jsonResponse({ revision: 3, session: DIRECTORY }));
    await useMessageQueueStore.getState().clearQueue(DIRECTORY, SESSION);
    expect(fetchMock.mock.calls[0]![0]).toContain(`/api/message-queue/sessions/${SESSION}`);
    expect(fetchMock.mock.calls[0]![1]!.method).toBe('DELETE');
    expect(useMessageQueueStore.getState().queuedMessages[KEY]).toEqual([]);
  });

  it('removing an in-flight item surfaces the 409 without touching the projection', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'queued item is in flight' }, false, 409));
    const result = await useMessageQueueStore.getState().removeFromQueue(DIRECTORY, SESSION, 'queued-a');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('in flight');
  });

  it('takeForInput returns the payload text and refetches', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ revision: 4, session: DIRECTORY, item: { ...SERVER_ITEM('a', 'sent me here'), preview: 'sent me' } }))
      .mockResolvedValue(jsonResponse({ revision: 4, sessions: [] }));
    const result = await useMessageQueueStore.getState().takeForInput(DIRECTORY, SESSION, 'a');
    expect(result.ok).toBe(true);
    expect(result.text).toBe('sent me here');
    expect(String(fetchMock.mock.calls[1]![0])).toContain('/api/message-queue');
  });

  it('revision notifications hydrate; older notifications are dropped', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ revision: 5, sessions: [] }));
    await useMessageQueueStore.getState().applyRevisionNotification(5);
    expect(useMessageQueueStore.getState().lastRevision).toBe(5);
    await useMessageQueueStore.getState().applyRevisionNotification(4);
    expect(fetchMock).toHaveBeenCalledTimes(1); // older — no refetch
  });
});
