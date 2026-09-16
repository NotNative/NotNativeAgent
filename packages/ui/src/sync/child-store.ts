// SPDX-License-Identifier: Apache-2.0
/**
 * ChildStoreManager (doc 04 §A.4/§C.2/§F.5): one lazily-created Zustand
 * store per normalized directory, a demand-driven bootstrap scheduler
 * (concurrency 2, priority outranking), and soft-cap eviction with grace.
 */
import { createStore, type StoreApi } from 'zustand/vanilla';
import { normalizeDirectory } from '../lib/nnd/client.ts';
import { INITIAL_STATE, MAX_DIR_STORES, EVICTION_GRACE_MS, DIR_IDLE_TTL_MS } from './types.ts';
import type { DirectoryStore, SyncState } from './types.ts';

export function createDirectoryStore(seed?: Partial<SyncState>): StoreApi<DirectoryStore> {
  const store = createStore<DirectoryStore>((set, get) => ({
    ...INITIAL_STATE,
    ...seed,
    patch: (partial) => set(partial),
    replace: (next) => set(next),
  }));
  return store;
}

/** selected(0) < active-project(1) < expanded(2) < visible(3) < background(4) */
export type DirectoryBootstrapPriority = 0 | 1 | 2 | 3 | 4;

export type DirectoryBootstrapReason =
  | 'current-directory'
  | 'selected-session'
  | 'known-project'
  | 'known-worktree'
  | 'project-expanded'
  | 'worktree-expanded'
  | 'server-connected'
  | 'action-demand';

export interface BootstrapDemand {
  directory: string;
  priority: DirectoryBootstrapPriority;
  reason: DirectoryBootstrapReason;
  force?: boolean;
}

export type BootstrapState = 'queued' | 'running' | 'complete' | 'failed';

/** Injected by the provider: performs the actual phased bootstrap. */
export type Bootstrapper = (
  directory: string,
  store: StoreApi<DirectoryStore>,
  isCurrent: () => boolean,
) => Promise<'complete' | 'failed'>;

export class ChildStoreManager {
  readonly children = new Map<string, StoreApi<DirectoryStore>>();
  readonly lifecycle = new Map<string, { lastAccessAt: number }>();
  readonly pins = new Map<string, number>();
  readonly states = new Map<string, BootstrapState>();

  private queued = new Map<string, BootstrapDemand>();
  private running = new Map<string, DirectoryBootstrapPriority>();
  private demandOwners = new Map<string, BootstrapDemand[]>();
  private generation = 0;
  private disposed = false;
  private passScheduled = false;
  private bootstrapper: Bootstrapper | null = null;
  onDispose: ((directory: string) => void) | null = null;
  isBooting: ((directory: string) => boolean) | null = null;
  hasPendingBlockingRequests: ((store: StoreApi<DirectoryStore>) => boolean) | null = null;

  configure(bootstrapper: Bootstrapper): void {
    this.bootstrapper = bootstrapper;
    this.generation += 1;
  }

  /** Test/inspection hook: current queued demands keyed by normalized directory. */
  queuedSnapshot(): Map<string, BootstrapDemand> {
    return new Map(this.queued);
  }

  /** Runtime-switch reset (doc 04 §11.2 contract): identical to construction.
   * Unlike dispose() this is reversible — configure() re-arms the scheduler. */
  reset(): void {
    this.disposed = false;
    this.generation += 1;
    this.children.clear();
    this.lifecycle.clear();
    this.pins.clear();
    this.states.clear();
    this.queued.clear();
    this.running.clear();
    this.demandOwners.clear();
    this.runSequences.clear();
  }

  dispose(): void {
    this.disposed = true;
    this.children.clear();
    this.lifecycle.clear();
    this.pins.clear();
    this.states.clear();
    this.queued.clear();
    this.running.clear();
    this.demandOwners.clear();
    this.runSequences.clear();
  }

  ensureChild(directory: string): StoreApi<DirectoryStore> {
    const dir = normalizeDirectory(directory);
    let store = this.children.get(dir);
    if (!store) {
      store = createDirectoryStore();
      this.children.set(dir, store);
    }
    this.lifecycle.set(dir, { lastAccessAt: Date.now() });
    this.requestBootstrap({ directory: dir, priority: 3, reason: 'current-directory' });
    return store;
  }

  peekChild(directory: string): StoreApi<DirectoryStore> | undefined {
    return this.children.get(normalizeDirectory(directory));
  }

  pin(directory: string): () => void {
    const dir = normalizeDirectory(directory);
    this.pins.set(dir, (this.pins.get(dir) ?? 0) + 1);
    return () => this.unpin(dir);
  }

  unpin(directory: string): void {
    const dir = normalizeDirectory(directory);
    const count = (this.pins.get(dir) ?? 1) - 1;
    if (count <= 0) this.pins.delete(dir);
    else this.pins.set(dir, count);
    this.runEviction(); // explicit lifecycle edge: synchronous pass
  }

  // ── bootstrap scheduling ────────────────────────────────────────────────

  setBootstrapDemand(owner: string, demands: BootstrapDemand[]): void {
    this.demandOwners.set(owner, demands.map((d) => ({ ...d, directory: normalizeDirectory(d.directory) })));
    this.recomputeDemands();
  }

  clearBootstrapDemand(owner: string): void {
    this.demandOwners.delete(owner);
    this.recomputeDemands();
  }

  /** Manual one-off demand; a queued higher rank (lower number) promotes in place. */
  requestBootstrap(demand: BootstrapDemand): void {
    const dir = normalizeDirectory(demand.directory);
    const existing = this.queued.get(dir);
    if (existing) {
      if (demand.priority < existing.priority) existing.priority = demand.priority;
      if (demand.force) existing.force = true;
    } else {
      this.queued.set(dir, { ...demand, directory: dir });
      if (demand.reason === 'action-demand' || demand.reason === 'selected-session' || demand.reason === 'current-directory') {
        this.states.set(dir, 'queued');
      }
    }
    this.schedulePass();
  }

  private recomputeDemands(): void {
    const aggregate = new Map<string, BootstrapDemand>();
    for (const list of this.demandOwners.values()) {
      for (const demand of list) {
        const current = aggregate.get(demand.directory);
        if (!current || demand.priority > current.priority) {
          aggregate.set(demand.directory, { ...demand });
        }
      }
    }
    for (const demand of aggregate.values()) this.requestBootstrap(demand);
  }

  private schedulePass(): void {
    if (this.passScheduled) return;
    this.passScheduled = true;
    queueMicrotask(() => {
      this.passScheduled = false;
      this.runScheduler();
    });
  }

  private runScheduler(): void {
    if (this.disposed || !this.bootstrapper) return;
    const entries = [...this.queued.values()].sort((a, b) => a.priority - b.priority);
    for (const demand of entries) {
      if (this.running.size >= 2) break;
      // selected/active-project/expanded always outrank background work:
      // visible(3)/background(4) admitted only while ZERO such runs are in flight
      if (demand.priority >= 3 && [...this.running.values()].some((p) => p >= 3)) continue;
      this.startRun(demand);
    }
  }

  private startRun(demand: BootstrapDemand): void {
    const dir = demand.directory;
    const bootstrapper = this.bootstrapper!;
    this.queued.delete(dir);
    this.running.set(dir, demand.priority);
    this.states.set(dir, 'running');
    const runGeneration = this.generation;
    let runSequence = (this.runSequences.get(dir) ?? 0) + 1;
    this.runSequences.set(dir, runSequence);
    const store = this.children.get(dir) ?? (() => {
      const created = createDirectoryStore();
      this.children.set(dir, created);
      return created;
    })();
    const isCurrent = (): boolean =>
      !this.disposed &&
      this.generation === runGeneration &&
      this.runSequences.get(dir) === runSequence &&
      this.children.get(dir) === store;
    void bootstrapper(dir, store, isCurrent)
      .then((result) => {
        if (!isCurrent()) return; // stale completions publish nothing
        this.states.set(dir, result);
      })
      .catch(() => {
        if (!isCurrent()) return;
        this.states.set(dir, 'failed');
      })
      .finally(() => {
        this.running.delete(dir);
        this.schedulePass();
      });
  }

  private runSequences = new Map<string, number>();

  // ── eviction (doc 04 §F.5) ───────────────────────────────────────────────

  runEviction(now = Date.now()): void {
    const victims: string[] = [];
    const entries = [...this.children.keys()].map((dir) => ({
      dir,
      lastAccessAt: this.lifecycle.get(dir)?.lastAccessAt ?? 0,
    }));
    const pinnedOrProtected = new Set<string>([
      ...this.pins.keys(),
      ...[...this.children.entries()].filter(([, store]) => this.hasPendingBlockingRequests?.(store) === true).map(([dir]) => dir),
    ]);
    const candidates = entries
      .filter((e) => !pinnedOrProtected.has(e.dir))
      .filter((e) => now - e.lastAccessAt > EVICTION_GRACE_MS) // grace: never a victim
      .sort((a, b) => a.lastAccessAt - b.lastAccessAt);
    let overflow = Math.max(0, this.children.size - MAX_DIR_STORES);
    for (const entry of candidates) {
      const idle = now - entry.lastAccessAt >= DIR_IDLE_TTL_MS;
      if (overflow <= 0 && !idle) break;
      if (this.canDisposeDirectory(entry.dir)) {
        victims.push(entry.dir);
        overflow -= 1;
      }
    }
    for (const dir of victims) this.disposeDirectory(dir);
  }

  canDisposeDirectory(directory: string): boolean {
    const dir = normalizeDirectory(directory);
    if (!this.children.has(dir)) return false;
    if ((this.pins.get(dir) ?? 0) > 0) return false;
    if (this.states.get(dir) === 'queued' || this.states.get(dir) === 'running') return false;
    if (this.isBooting?.(dir)) return false;
    const store = this.children.get(dir)!;
    if (this.hasPendingBlockingRequests?.(store)) return false;
    return true;
  }

  disposeDirectory(directory: string): void {
    const dir = normalizeDirectory(directory);
    this.children.delete(dir);
    this.lifecycle.delete(dir);
    this.states.delete(dir);
    this.queued.delete(dir);
    this.running.delete(dir);
    this.runSequences.delete(dir);
    this.onDispose?.(dir);
  }
}

export function pickDirectoriesToEvict(
  entries: { dir: string; lastAccessAt: number; pinned: boolean; protected: boolean }[],
  now: number,
  maxStores = MAX_DIR_STORES,
): string[] {
  const candidates = entries
    .filter((e) => !e.pinned && !e.protected)
    .filter((e) => now - e.lastAccessAt > EVICTION_GRACE_MS)
    .sort((a, b) => a.lastAccessAt - b.lastAccessAt);
  let overflow = Math.max(0, entries.length - maxStores);
  const victims: string[] = [];
  for (const candidate of candidates) {
    if (overflow <= 0 && now - candidate.lastAccessAt < DIR_IDLE_TTL_MS) break;
    victims.push(candidate.dir);
    overflow -= 1;
  }
  return victims;
}
