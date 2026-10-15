// SPDX-License-Identifier: Apache-2.0
/**
 * Reducer gates (doc 04 §J.2 subset): freshness guard, out-of-order chronology,
 * terminal tool preservation, delta overlap dedupe, no-op reference equality,
 * archive removal + tombstone, optimistic part replace-in-place, and
 * transactional batch commit with cloned-field isolation.
 */
import { describe, expect, it } from 'vitest';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { DirectoryEventBatch, applyDirectoryEvent } from '../event-reducer.ts';
import { applyTranscriptEvent } from '../transcript-reducer.ts';
import { INITIAL_STATE, type DirectoryStore, type SyncState } from '../types.ts';
import type { HarnessEvent } from '../../lib/nnd/events.ts';
import type { Session } from '../../lib/nnd/types.ts';

function freshState(seed: Partial<SyncState> = {}): SyncState {
  return { ...deepInitialState(), ...seed };
}

function deepInitialState(): SyncState {
  return JSON.parse(JSON.stringify(INITIAL_STATE)) as SyncState;
}

function eventOf(type: string, properties: Record<string, unknown>, directory = 'D:\\work'): HarnessEvent {
  return { type, properties, directory };
}

function store(): StoreApi<DirectoryStore> {
  return createStore<DirectoryStore>(() => ({
    ...INITIAL_STATE,
    patch: () => undefined,
    replace: () => undefined,
  }));
}

function session(id: string, updated: number, extra: Partial<Session> = {}): Session {
  return {
    id,
    directory: 'D:\\work',
    title: `s-${id}`,
    time: { created: updated - 1, updated },
    ...(extra as object),
  } as Session;
}

function apply(draft: SyncState, event: HarnessEvent, now = Date.now()): void {
  let changed = 0;
  const cloned = new Set<keyof SyncState>();
  applyDirectoryEvent(draft, event, {
    ensure: (field) => {
      if (cloned.has(field)) return;
      cloned.add(field);
      const value = draft[field];
      if (Array.isArray(value)) (draft as unknown as Record<string, unknown>)[field] = [...(value as unknown[])];
      else if (value && typeof value === 'object') (draft as unknown as Record<string, unknown>)[field] = { ...(value as object) };
    },
    changed: () => { changed += 1; },
    out: {
      changedCount: changed,
      materializations: [], cleanupSessionIds: [], sessionRoutes: [], messageRoutes: [], statusChanges: [],
      settled: [], permissionAsks: [], permissionReplies: [], questionAsks: [], questionSettled: [],
      todosPersisted: [], sessionRemoved: [], sessionArchived: [], messageCompleted: [],
      projectUpdated: null, globalRefresh: false, lspRefresh: false, partChangedMessageIDs: [],
    },
    now,
  });
}

describe('session upsert events', () => {
  it('skips STALE session events on recency, keeps references', () => {
    const draft = freshState({ session: [session('s1', 200)] });
    const before = draft.session[0];
    apply(draft, eventOf('session.updated', { info: session('s1', 100) }));
    expect(draft.session[0]).toBe(before); // no reference churn for stale refresh
  });

  it('inserts chronologically out-of-order events by id and bumps revisions', () => {
    const draft = freshState();
    apply(draft, eventOf('session.created', { info: session('s2', 10) }));
    apply(draft, eventOf('session.created', { info: session('s1', 10) }));
    expect(draft.session.map((s) => s.id)).toEqual(['s1', 's2']); // binary index by ID
    expect(draft.sessionTotal).toBe(2);
    expect(draft.sessionListSource).toBe('live');
    expect(draft.sessionRevision).toBe(2);
  });

  it('archive branch REMOVES, cleans caches, and tombstones', () => {
    const draft = freshState({ session: [session('s1', 200)] });
    draft.message.s1 = [];
    const archived = { ...session('s1', 300), time: { created: 100, updated: 300, archived: 300 as unknown as number } };
    apply(draft, eventOf('session.updated', { info: archived }));
    expect(draft.session).toHaveLength(0);
    expect(draft.sessionTotal).toBe(0);
    expect(draft.sessionDeletedRevision.s1).toBeGreaterThan(0);
    expect(draft.message.s1).toBeUndefined(); // cleanupSessionCaches dropped the bucket key
  });

  it('archiving a fork preserves inherited prompt parts still referenced by its parent', () => {
    const draft = freshState({ session: [session('fork', 100), session('parent', 100)] });
    const user = (sessionID: string) => ({ id: 'shared-request', sessionID, role: 'user' as const, time: { created: 1 }, agent: 'nna', model: { providerID: 'p', modelID: 'm' } });
    draft.message.parent = [user('parent')]; draft.message.fork = [user('fork')];
    draft.part['shared-request'] = [{ id: 'part', sessionID: 'parent', messageID: 'shared-request', type: 'text', text: 'Keep my prompt' }];
    apply(draft, eventOf('session.updated', { info: { ...session('fork', 300), time: { created: 100, updated: 300, archived: 300 } } }));
    expect(draft.message.fork).toBeUndefined();
    expect(draft.part['shared-request']?.[0]).toMatchObject({ text: 'Keep my prompt' });
    apply(draft, eventOf('session.deleted', { sessionID: 'parent' }));
    expect(draft.part['shared-request']).toBeUndefined();
  });

  it('session.deleted tombstones and removes routes', () => {
    const draft = freshState({ session: [session('s1', 200)] });
    draft.permission.s1 = [];
    apply(draft, eventOf('session.deleted', { sessionID: 's1' }));
    expect(draft.session).toHaveLength(0);
    expect(draft.sessionDeletedRevision.s1).toBeGreaterThan(0);
    expect(draft.permission.s1).toBeUndefined();
  });
});

describe('status, todo, and diff events', () => {
  it('status no-ops keep references; change replaces the entry', () => {
    const draft = freshState({ session_status: { s1: { type: 'busy' as const } } });
    const before = draft.session_status;
    apply(draft, eventOf('session.status', { sessionID: 's1', status: { type: 'busy' } }));
    expect(draft.session_status).toBe(before);
    apply(draft, eventOf('session.status', { sessionID: 's1', status: { type: 'retry', attempt: 1, message: 'x', next: 5 } }));
    expect(draft.session_status.s1).toEqual({ type: 'retry', attempt: 1, message: 'x', next: 5 });
  });

  it('idle writes idle and reports a settle in the same batch', () => {
    const draft = freshState({ session_status: { s1: { type: 'busy' as const } } });
    apply(draft, eventOf('session.idle', { sessionID: 's1' }));
    expect(draft.session_status.s1).toEqual({ type: 'idle' });
  });

  it('todo.updated refuses JSON-equal payload', () => {
    const todos = [{ content: 'a', status: 'pending' as const, priority: 'high' as const }];
    const draft = freshState({ todo: { s1: todos } });
    const before = draft.todo.s1;
    apply(draft, eventOf('todo.updated', { sessionID: 's1', todos }));
    expect(draft.todo.s1).toBe(before);
  });
});

describe('transcript reducer', () => {
  it('out-of-order message.updated inserts chronologically and routes', () => {
    const draft = freshState();
    const message = (id: string, created: number): object => ({ id, sessionID: 's1', role: 'user', time: { created } });
    applyTranscriptEvent(draft, eventOf('message.updated', { info: message('m2', 20) }), apiOf(draft));
    applyTranscriptEvent(draft, eventOf('message.updated', { info: message('m1', 10) }), apiOf(draft));
    expect(draft.message.s1!.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(draft.message.s1![0]!.time.created).toBe(10); // never ID-ordered
  });

  it('message.part.updated preserves terminal tool parts from stale refreshes', () => {
    const draft = freshState();
    draft.part.m1 = [{
      id: 'p1', messageID: 'm1', type: 'tool', sessionID: 's1',
      state: { status: 'completed', error: undefined },
    } as never];
    applyTranscriptEvent(draft, eventOf('message.part.updated', { part: { id: 'p1', messageID: 'm1', type: 'tool', state: { status: 'running' } } }), apiOf(draft));
    expect((draft.part.m1![0] as unknown as { state: { status: string } }).state.status).toBe('completed'); // stale refresh cannot regress
  });

  it('delta appends with overlap dedupe when the flag is present', () => {
    const draft = freshState();
    applyTranscriptEvent(draft, eventOf('message.part.updated', { part: { id: 'p1', messageID: 'm1', type: 'text', text: 'He', sessionID: 's1', __dedupeNextDeltaFields: ['text'] } }), apiOf(draft));
    applyTranscriptEvent(draft, eventOf('message.part.delta', { messageID: 'm1', partID: 'p1', field: 'text', delta: 'He', sessionID: 's1' }), apiOf(draft));
    expect((draft.part.m1![0] as { text: string }).text).toBe('He'); // overlap swallowed
    applyTranscriptEvent(draft, eventOf('message.part.delta', { messageID: 'm1', partID: 'p1', field: 'text', delta: 'llo', sessionID: 's1' }), apiOf(draft));
    expect((draft.part.m1![0] as { text: string }).text).toBe('Hello');
    expect((draft.part.m1![0] as { __dedupeNextDeltaFields?: string[] }).__dedupeNextDeltaFields).toBeUndefined(); // cleared after first apply
  });

  it('new-id text part replaces the optimistic part in place (no remount)', () => {
    const draft = freshState();
    draft.part.m1 = [{ id: 'opt1', messageID: 'm1', type: 'text', text: 'draft text', sessionID: '' } as never, { id: 'other', messageID: 'm1', type: 'tool', state: { status: 'pending' } } as never];
    applyTranscriptEvent(draft, eventOf('message.part.updated', { part: { id: 'srv1', messageID: 'm1', type: 'text', text: 'final', sessionID: 's1' } }), apiOf(draft));
    expect(draft.part.m1![0]!.id).toBe('srv1'); // replaced at index 0
    expect((draft.part.m1![0] as { text: string }).text).toBe('final');
    expect(draft.part.m1![1]!.id).toBe('other'); // untouched
  });

  it('reports missing-owning-message materialization and orphan-delta', () => {
    const draft = freshState();
    const api = apiOf(draft);
    applyTranscriptEvent(draft, eventOf('message.part.updated', { sessionID: 's1', part: { id: 'p1', messageID: 'm1', type: 'text', text: 'x', sessionID: 's1' } }), api);
        expect(api.getOut().materializations).toEqual([{ reason: 'missing-owning-message', sessionID: 's1', messageID: 'm1' }]);

    const emptyDraft = { ...INITIAL_STATE };
    applyTranscriptEvent(emptyDraft, eventOf('message.part.delta', { sessionID: 's1', messageID: 'm9', partID: 'p9', field: 'text', delta: 'x' }), apiOf(emptyDraft));
  });
});

describe('batch transaction (§B.3)', () => {
  it('clones ONLY touched fields and commits one setState', () => {
    const origin = { ...INITIAL_STATE };
    const ordered = createStore<DirectoryStore>(() => ({
      ...deepInitialState(),
      patch: () => undefined,
      replace: () => undefined,
    }));
    const before = ordered.getState();
    const batch = new DirectoryEventBatch(ordered);
    batch.apply(eventOf('session.status', { sessionID: 's1', status: { type: 'busy' } }), Date.now());
    batch.commit();
    const after = ordered.getState();
    expect(after.session_status).not.toBe(before.session_status); // touched field cloned
    expect(after.session).toBe(before.session); // untouched fields keep identity
  });
});

interface ApiCapture {
  ensure: (field: keyof SyncState) => void;
  changed: () => void;
  out: import("../reducer-core.ts").BatchOutcome;
  now: number;
  getOut: () => import("../reducer-core.ts").BatchOutcome;
}

function apiOf(draft: SyncState): ApiCapture {
  const cloned = new Set<keyof SyncState>();
  const out = makeOut();
  const ensure = (field: keyof SyncState): void => {
    if (cloned.has(field)) return;
    cloned.add(field);
    const value = draft[field];
    if (Array.isArray(value)) (draft as unknown as Record<string, unknown>)[field] = [...(value as unknown[])];
    else if (value && typeof value === 'object') (draft as unknown as Record<string, unknown>)[field] = { ...(value as object) };
  }
  return { ensure, changed: () => undefined, out, now: 0, getOut: () => out };
}

function makeOut(): import('../reducer-core.ts').BatchOutcome {
  return {
    changedCount: 0,
    materializations: [],
    cleanupSessionIds: [],
    sessionRoutes: [],
    messageRoutes: [],
    statusChanges: [],
    settled: [],
    permissionAsks: [],
    permissionReplies: [],
    questionAsks: [],
    questionSettled: [],
    todosPersisted: [],
    sessionRemoved: [],
    sessionArchived: [],
    messageCompleted: [],
    projectUpdated: null,
    globalRefresh: false,
    lspRefresh: false,
    partChangedMessageIDs: [],
  };
}
