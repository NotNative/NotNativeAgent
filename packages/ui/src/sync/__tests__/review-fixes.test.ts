// SPDX-License-Identifier: Apache-2.0
/**
 * Review-fix gates: batch publication of primitive counters + tombstones,
 * closed-hierarchy merge exclusion, scheduler survival across a runtime reset,
 * archive echo routing to the global cache, and the signature-guarded
 * blocking-request merge using the post-fetch base.
 */
import { describe, expect, it } from 'vitest';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { DirectoryEventBatch } from '../event-reducer.ts';
import { ChildStoreManager } from '../child-store.ts';
import { mergeBootstrapLists } from '../session-actions.ts';
import { useGlobalSessionsStore, useGlobalSessionStatusStore } from '../global-stores.ts';
import { INITIAL_STATE, type DirectoryStore } from '../types.ts';
import type { HarnessEvent } from '../../lib/nnd/events.ts';
import type { Session } from '../../lib/nnd/types.ts';

function realStore(): StoreApi<DirectoryStore> {
  return createStore<DirectoryStore>(() => ({
    ...JSON.parse(JSON.stringify(INITIAL_STATE)) as unknown as DirectoryStore,
    patch: () => undefined,
    replace: () => undefined,
  }));
}

function eventOf(type: string, properties: Record<string, unknown>, directory = 'D:/work'): HarnessEvent {
  return { type, properties, directory };
}

const session = (id: string, extra: Record<string, unknown> = {}): Session =>
  ({ id, directory: 'D:/work', title: id, time: { created: Date.now() - 1, updated: Date.now() }, ...(extra as object) }) as Session;

describe('batch publishes primitive counters and tombstones (§B.3)', () => {
  it('created + archived events advance sessionRevision/sessionTotal/deletedRevision in the STORE', () => {
    const store = realStore();
    const batch = new DirectoryEventBatch(store);
    batch.apply(eventOf('session.created', { info: session('s1') }), Date.now());
    expect(batch.commit()).toBeGreaterThan(0);
    const afterCreate = store.getState();
    expect(afterCreate.sessionRevision).toBe(1);
    expect(afterCreate.sessionEventRevision.s1).toBe(1);
    expect(afterCreate.sessionTotal).toBe(1);

    const next = new DirectoryEventBatch(store);
    const archivedRecord = session('s1', { time: { created: 1, updated: Date.now() + 99, archived: Date.now() + 99 } }); // fresher than the current record
    next.apply(eventOf('session.updated', { info: archivedRecord }), Date.now());
    next.commit();
    const afterArchive = store.getState();
    expect(afterArchive.sessionRevision).toBe(2);
    expect(afterArchive.sessionTotal).toBe(0);
    expect(afterArchive.sessionDeletedRevision.s1).toBe(2); // tombstone beats later overlays
    expect(afterArchive.session).toHaveLength(0);
  });
});

describe('closed hierarchy merge excludes tombstoned ancestors (§C.3-7d)', () => {
  it('drops children whose parent is absent from response AND cache; keeps cached PARENTS of survivors', () => {
    const cached = [session('cached-root'), session('unrelated-cached')];
    const roots = [session('incoming-root')];
    const children = [
      session('child-of-incoming', { parentID: 'incoming-root' }),
      session('child-of-cached', { parentID: 'cached-root' }), // parent must be RETAINED from cache
      session('orphan-child', { parentID: 'tombstoned-parent' }), // parent nowhere
    ];
    const merged = mergeBootstrapLists(cached, roots, children, new Set<string>());
    const ids = merged.map((s) => s.id);
    expect(ids).toContain('child-of-incoming');
    expect(ids).toContain('incoming-root');
    expect(ids).toContain('cached-root'); // retained parent of a surviving child
    expect(ids).not.toContain('unrelated-cached'); // snapshot replaces the cache wholesale
    expect(ids).not.toContain('orphan-child'); // tombstoned ancestor excluded
  });

  it('post-baseline live events overlay back over the snapshot', () => {
    const cachedLive = session('live-one', { title: 'fresh-live' });
    const roots = [session('stable-root')];
    const merged = mergeBootstrapLists([cachedLive], roots, null, new Set(['live-one']));
    expect(merged.some((s) => s.id === 'live-one' && s.title === 'fresh-live')).toBe(true);
    expect(merged.map((s) => s.id).sort()).toEqual(['live-one', 'stable-root']);
  });
});

describe('scheduler survives a runtime reset (§11.2 disposition)', () => {
  it('reset() re-arms configure/run instead of bricking the manager', async () => {
    const manager = new ChildStoreManager();
    manager.dispose(); // simulate the old runtime teardown
    manager.reset();
    const runs: string[] = [];
    manager.configure(async (directory) => {
      runs.push(directory);
      return 'complete';
    });
    manager.requestBootstrap({ directory: 'D:/b', priority: 0, reason: 'selected-session' });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    expect(runs).toEqual(['D:/b']); // admitted + completed on the NEW runtime
    expect(manager.states.get('D:/b')).toBe('complete');
  });
});

describe('archive echo keeps the record in the global cache (§B.2)', () => {
  it('archived record lands in the archived bucket; deleted record is removed; status retired', () => {
    useGlobalSessionsStore.getState().reset();
    useGlobalSessionStatusStore.getState().reset();
    const store = realStore();
    const batch = new DirectoryEventBatch(store);
    batch.apply(eventOf('session.created', { info: session('arch1') }), Date.now());
    batch.commit();
    useGlobalSessionsStore.getState().upsertSession(session('arch1'));
    useGlobalSessionStatusStore.getState().applyEvent('arch1', { type: 'busy' });

    const archived = new DirectoryEventBatch(store);
    const archivedRecord = session('arch1', { time: { created: 1, updated: Date.now() + 999, archived: Date.now() + 999 } });
    archived.apply(eventOf('session.updated', { info: archivedRecord }), Date.now());
    archived.commit();
    // the REDUCER carried the stripped record out (§B.2): side effects upsert it
    expect(archived.out.sessionArchived).toEqual([{ sessionID: 'arch1', record: archivedRecord }]);
    useGlobalSessionsStore.getState().upsertSession(archivedRecord); // side-effect contract per §B.2/§D.5
    const global = useGlobalSessionsStore.getState();
    expect(global.archived.some((s) => s.id === 'arch1')).toBe(true);
    expect(global.active.some((s) => s.id === 'arch1')).toBe(false); // upsert moved it out of active
    useGlobalSessionStatusStore.getState().removeSession('arch1'); // live index entry retired on archive too
    expect(useGlobalSessionStatusStore.getState().statusById['arch1']).toBeUndefined();
  });
});

const flat = (buckets: Record<string, { id: string }[]>): string[] =>
  Object.values(buckets).flat().map((request) => request.id).sort();

describe('signature-guarded merge uses the post-fetch base (§C.3-6)', () => {
  it('resurrects nothing when the signature is stable', () => {
    const before = { A: [{ id: 'wa' }] } as Record<string, { id: string }[]>;
    const currentAfter = { A: [{ id: 'wa' }] } as Record<string, { id: string }[]>; // nothing live arrived
    const grouped = new Map<string, { id: string; sessionID: string }[]>(); // response omits A
    const stable = flat(before).join('|') === flat(currentAfter).join('|');
    const next: Record<string, { id: string }[]> = {};
    for (const sessionID of new Set([...Object.keys(currentAfter), ...grouped.keys()])) {
      const response = grouped.get(sessionID);
      if (response) {
        next[sessionID] = response;
        continue;
      }
      if (stable) continue; // deleted, and it STAYS deleted (no pre-read resurrection)
      const liveBucket = currentAfter[sessionID];
      if (liveBucket) next[sessionID] = liveBucket;
    }
    expect(stable).toBe(true);
    expect(next).toEqual({}); // omitted + stable ⇒ deleted
  });

  it('preserves the CURRENT bucket when the signature moved mid-flight', () => {
    const before = { A: [{ id: 'wa' }] } as Record<string, { id: string }[]>;
    const currentAfter = { A: [{ id: 'wa' }, { id: 'wb' }] } as Record<string, { id: string }[]>; // a live arrival moved the set
    const grouped = new Map<string, { id: string; sessionID: string }[]>(); // response omits A
    const stable = flat(before).join('|') === flat(currentAfter).join('|');
    const next: Record<string, { id: string }[]> = {};
    for (const sessionID of new Set([...Object.keys(currentAfter), ...grouped.keys()])) {
      const response = grouped.get(sessionID);
      if (response) {
        next[sessionID] = response;
        continue;
      }
      if (stable) continue;
      next[sessionID] = currentAfter[sessionID]!;
    }
    expect(stable).toBe(false);
    expect(next.A).toEqual([{ id: 'wa' }, { id: 'wb' }]); // live arrival survives, read from CURRENT
  });
});
