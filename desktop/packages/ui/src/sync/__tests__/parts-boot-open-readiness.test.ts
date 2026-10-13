// SPDX-License-Identifier: Apache-2.0
/**
 * SLICE-A chat-alive boot-open readiness (boot-open-readiness.ts): the open
 * decision must wait for the AUTHORITATIVE LIST (§C.3 step 7d). The v1 boot
 * used the 'initial' resync promise, which short-circuits on a fresh boot
 * (zero reconnect candidates), so the welcome fallback fired against an
 * empty list and nothing opened — the app looked dead. These tests pin the
 * readiness contract: authoritative merge, bootstrap failure, cap decay.
 * The §F.10 ordering identity test guards the sidebar strip regression that
 * rendered every row as "Untitled Session" (originals must ride through).
 */
import { describe, expect, it } from 'vitest';

import { awaitAuthoritativeList, type BootListManager, type BootListStore } from '../boot-open-readiness.ts';
import { orderSessionsByLifecycle } from '../session-ordering.ts';
import type { Session } from '../../lib/nnd/types.ts';

interface FakeStoreState {
  status: string;
  sessionListSource: string;
}

interface FakeStore extends BootListStore {
  state: FakeStoreState;
  publish(patch: Partial<FakeStoreState>): void;
}

function fakeStore(initial: FakeStoreState): FakeStore {
  const listeners = new Set<() => void>();
  const store: FakeStore = {
    state: initial,
    getState: (): FakeStoreState => store.state,
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    publish(patch: Partial<FakeStoreState>): void {
      store.state = { ...store.state, ...patch };
      for (const listener of [...listeners]) listener();
    },
  };
  return store;
}

function managerOf(store: BootListStore | undefined, expected: string): BootListManager {
  return { peekChild: (directory) => (directory === expected ? store : undefined) };
}

describe('awaitAuthoritativeList', () => {
  it('resolves immediately when the list is already authoritative', async () => {
    const store = fakeStore({ status: 'complete', sessionListSource: 'authoritative' });
    expect(await awaitAuthoritativeList(managerOf(store, 'D:/work'), 'D:\\work', 500)).toBe(true);
    expect(store.state.sessionListSource).toBe('authoritative');
  });

  it('waits for the authoritative merge that lands AFTER status complete (the v1 race)', async () => {
    const store = fakeStore({ status: 'complete', sessionListSource: 'empty' });
    const promise = awaitAuthoritativeList(managerOf(store, 'D:/work'), 'D:\\work', 500);
    let resolved = false;
    void promise.then(() => { resolved = true; });
    await new Promise((r) => setTimeout(r, 10));
    expect(resolved).toBe(false); // status complete alone must NOT release
    store.publish({ sessionListSource: 'authoritative' });
    expect(await promise).toBe(true);
  });

  it('resolves when the bootstrap fails outright (no list will come)', async () => {
    const store = fakeStore({ status: 'partial', sessionListSource: 'empty' });
    const promise = awaitAuthoritativeList(managerOf(store, 'D:/work'), 'D:\\work', 500);
    store.publish({ status: 'failed' });
    expect(await promise).toBe(false);
  });

  it('decays at the cap so boot-open still gets its chance', async () => {
    const store = fakeStore({ status: 'running', sessionListSource: 'empty' });
    const started = Date.now();
    expect(await awaitAuthoritativeList(managerOf(store, 'D:/work'), 'D:\\work', 20)).toBe(false);
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
  });

  it('returns immediately when the child store is absent', async () => {
    expect(await awaitAuthoritativeList(managerOf(undefined, 'D:/work'), 'D:\\work', 20)).toBe(false);
  });
});

describe('§F.10 lifecycle ordering keeps session identity', () => {
  it('returns the ORIGINAL session objects — never a stripped projection', () => {
    const welcome = {
      id: 'ses_welcome',
      title: 'Welcome to NotNativeDesktop',
      slug: 'welcome',
      projectID: 'proj',
      directory: 'D:/work',
      version: '2026.0.0',
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 1_000, updated: 2_000 },
    } as Session;
    const child = {
      id: 'ses_child',
      title: 'Forked child',
      parentID: 'ses_welcome',
      time: { created: 3_000, updated: 4_000 },
    } as Session;
    const ordered = orderSessionsByLifecycle([child, welcome]);
    expect(ordered[0]).toBe(welcome); // identity, not a look-alike
    expect(ordered.map((session) => session.title)).toEqual(['Welcome to NotNativeDesktop', 'Forked child']);
  });
});
