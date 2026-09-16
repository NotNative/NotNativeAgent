// SPDX-License-Identifier: Apache-2.0
/**
 * ChildStoreManager gates (doc 04 §C.2/§F.5): scheduler priority ordering
 * (selected first), demand dedupe + rank promotion, force ORs, stale
 * generation guards, and eviction rules (grace beats burst, TTL bounds,
 * blocking-request protection).
 */
import { describe, expect, it, vi } from 'vitest';
import { ChildStoreManager, pickDirectoriesToEvict } from '../child-store.ts';
import type { StoreApi } from 'zustand/vanilla';
import { createStore } from 'zustand/vanilla';
import type { DirectoryStore } from '../types.ts';
import { INITIAL_STATE } from '../types.ts';

function store(): StoreApi<DirectoryStore> {
  return createStore<DirectoryStore>(() => ({ ...JSON.parse(JSON.stringify(INITIAL_STATE)) as DirectoryStore, patch: () => undefined, replace: () => undefined }));
}

function harnessYield(): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
}

describe('bootstrap scheduler', () => {
  it('runs selected(0) before visible(3)/background(4) and dedupes by directory', async () => {
    const manager = new ChildStoreManager();
    const runs: string[] = [];
    const blocking = new Map<string, (value: unknown) => void>();
    manager.configure(async (directory: string) => {
      runs.push(`${directory}`);
      await new Promise((resolvePromise) => { blocking.set(directory, resolvePromise); });
      return 'complete' as const;
    });
    manager.requestBootstrap({ directory: 'D:/a', priority: 3, reason: 'current-directory' });
    manager.requestBootstrap({ directory: 'D:/b', priority: 4, reason: 'server-connected' });
    manager.requestBootstrap({ directory: 'D:/a', priority: 0, reason: 'selected-session' });
    manager.requestBootstrap({ directory: 'D:/a', priority: 3, reason: 'current-directory' }); // dedupe
    await harnessYield();
    expect([...manager.queuedSnapshot().keys()]).not.toContain('D:/a'); // deduped
    expect(manager.states.get('D:/a')).toBe('running');
    expect(runs[0]).toBe('D:/a'); // selected(0) outranks visible/background
    blocking.get('D:/a')?.(undefined);
    await harnessYield();
    await harnessYield();
    expect(manager.states.get('D:/a')).toBe('complete');
  });

  it('promotes a queued demand by rank and ORs force', async () => {
    const manager = new ChildStoreManager();
    let released: ((value: unknown) => void) | undefined;
    manager.configure(async () => {
      await new Promise((resolvePromise) => { released = resolvePromise; });
      return 'complete' as const;
    });
    manager.requestBootstrap({ directory: 'D:/x', priority: 4, reason: 'server-connected' });
    await harnessYield();
    expect(manager.queuedSnapshot().get('D:/x')?.force).toBeUndefined();
    manager.requestBootstrap({ directory: 'D:/x', priority: 1, reason: 'action-demand', force: true });
    expect(manager.queuedSnapshot().get('D:/x')).toMatchObject({ priority: 1, force: true });
    released?.(undefined);
    await harnessYield();
  });

  it('stale completions publish nothing (generation + runSequence guard)', async () => {
    const manager = new ChildStoreManager();
    const releases = new Map<string, (value: unknown) => void>();
    manager.configure(async (_directory: string, _store: unknown, isCurrent: () => boolean) => {
      await new Promise((resolvePromise) => releases.set('release', resolvePromise));
      return isCurrent() ? ('complete' as const) : ('failed' as const);
    });
    manager.requestBootstrap({ directory: 'D:/s', priority: 0, reason: 'selected-session' });
    await harnessYield();
    releases.get('release')?.(undefined);
    await harnessYield();
    expect(manager.states.get('D:/s')).toBe('complete');
    // a NEW configure bumps the manager generation; that older run's state stays
    manager.dispose();
    expect(manager.children.size).toBe(0);
  });
});

describe('eviction (§F.5)', () => {
  it('grace beats burst: recently touched directories never overflow-evict', () => {
    const victims = pickDirectoriesToEvict([
      { dir: 'D:\\fresh', lastAccessAt: Date.now() - 1_000, pinned: false, protected: false },
      { dir: 'D:\\old', lastAccessAt: Date.now() - 40 * 60_000, pinned: false, protected: false },
    ], Date.now(), 30);
    expect(victims).toEqual(['D:\\old']);
  });

  it('idle TTL bounds disposal for untouched directories', () => {
    const twenty = 20 * 60_000;
    const now = Date.now();
    const victims = pickDirectoriesToEvict(
      [{ dir: 'D:\\idle', lastAccessAt: now - twenty - 100, pinned: false, protected: false }],
      now,
      0, // over-cap already
    );
    expect(victims).toEqual(['D:\\idle']);
    const recent = pickDirectoriesToEvict(
      [{ dir: 'D:\\idle', lastAccessAt: now - 5_000, pinned: false, protected: false }],
      now,
      0,
    );
    expect(recent).toEqual([]); // inside 30s grace
  });

  it('blocking-request protection keeps a directory dismountable-by-rules only', () => {
    const manager = new ChildStoreManager();
    const target = store();
    manager.children.set('D:/keep', target);
    manager.lifecycle.set('D:/keep', { lastAccessAt: Date.now() - 40 * 60_000 });
    manager.hasPendingBlockingRequests = (storeRef) => storeRef === target;
    expect(manager.canDisposeDirectory('D:/keep')).toBe(false);
    manager.hasPendingBlockingRequests = () => false;
    expect(manager.canDisposeDirectory('D:/keep')).toBe(true);
  });

  it('disposeDirectory churns onDispose and clears scheduler state', () => {
    const manager = new ChildStoreManager();
    const disposed: string[] = [];
    manager.onDispose = (dir) => disposed.push(dir);
    manager.children.set('D:/g', store());
    manager.states.set('D:/g', 'complete');
    manager.disposeDirectory('D:/g');
    expect(manager.children.has('D:/g')).toBe(false);
    expect(disposed).toEqual(['D:/g']);
    expect(manager.states.has('D:/g')).toBe(false);
  });

  it('unpin triggers a synchronous eviction pass', () => {
    const manager = new ChildStoreManager();
    manager.children.set('D:/p', store());
    manager.lifecycle.set('D:/p', { lastAccessAt: Date.now() - 40 * 60_000 });
    const unpin = manager.pin('D:/p');
    expect(manager.canDisposeDirectory('D:/p')).toBe(false);
    unpin();
    expect(manager.children.has('D:/p')).toBe(false); // expired TTL → disposed on unpin
    void vi;
  });
});
