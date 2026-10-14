// SPDX-License-Identifier: Apache-2.0
import { join as joinPath } from 'node:path';
import { publishControlEvent } from '../lib/bus.ts';
import { CONTROL_EVENTS } from '../lib/harnessNaming.ts';
import { ENV } from '../env.ts';
import { harnessRequest, callHarnessJson } from './queue-adapter-calls.ts';
import { deliverHead, type DeliveryOutcome } from './queue-dispatch.ts';
import { AdapterQueueFeed, type QueueEnvelope, type QueueFeed } from './queue-feed.ts';
import { NULL_KNOWLEDGE_PROVIDER, notifyPromptSent, type ProjectKnowledgeProvider } from './queue-hooks.ts';
import { createAgentMemoryKnowledgeProvider } from '../agent-tool/memory-delivery.ts';
import { QUEUE_FILE_NAME, MessageQueueStore } from './queue-store.ts';
import { QueueItemConflictError, parseQueuedItemInput, sameQueuePayload, type QueueItem } from './queue-item.ts';
import { withConfigLock } from '../scheduled/config-lock.ts';
import { QueueDispatchClaims, type DispatchClaim } from './queue-dispatch-claims.ts';
import { asRecord, errorNameOf, optionalPropertyString, tailUnfinishedAssistant, failureDelayMs } from './queue-runtime-utils.ts';
export { failureDelayMs } from './queue-runtime-utils.ts';
import { QUEUE_TIMING, type QueueTiming, type QueueTimingOverride } from './queue-runtime-timing.ts';
export { QUEUE_TIMING, type QueueTiming, type QueueTimingOverride } from './queue-runtime-timing.ts';

interface ArmedTimer {
  timer: ReturnType<typeof setTimeout>;
  at: number;
}

interface BackoffRecord {
  itemId: string;
  failures: number;
  nextAttemptAt: number;
}

export class MessageQueueRuntime {
  readonly store: MessageQueueStore;
  readonly feed: QueueFeed;
  readonly knowledge: ProjectKnowledgeProvider;
  readonly timing: QueueTiming;
  private readonly arms = new Map<string, ArmedTimer>();
  private readonly holdWakes = new Map<string, ArmedTimer>();
  private readonly holds = new Map<string, number>();
  private readonly sending = new Map<string, string>();
  /** Network calls remain active after session.deleted clears the public
   * sending projection; keep their claim until the call settles. */
  private readonly activeDeliveries = new Set<string>();
  private readonly dispatchClaims: QueueDispatchClaims;
  private readonly backoffs = new Map<string, BackoffRecord>();
  private readonly aborts = new Map<string, number>();
  private readonly ticking = new Set<string>();
  private stopped = false;
  private unsubs: Array<() => void> = [];
  constructor(
    store: MessageQueueStore,
    feed: QueueFeed,
    knowledge: ProjectKnowledgeProvider = NULL_KNOWLEDGE_PROVIDER,
    timing: QueueTiming = QUEUE_TIMING,
  ) {
    this.store = store;
    this.feed = feed;
    this.knowledge = knowledge;
    this.timing = timing;
    this.dispatchClaims = new QueueDispatchClaims(store.file, (sessionId) => this.store.entryOf(sessionId)?.items[0]?.id ?? null);
  }

  /** Startup (§D.3): load the persisted file, then reconcile every queue. */
  start(): void {
    const loaded = this.store.load();
    void loaded;
    this.unsubs.push(this.feed.onEvent((envelope) => this.onEnvelope(envelope)));
    this.unsubs.push(this.feed.onConnected(() => this.reconcileAll()));
    this.feed.start?.();
    this.reconcileAll();
  }
  dispose(): void {
    this.stopped = true;
    this.dispatchClaims.releaseAll();
    for (const sessionId of [...this.arms.keys()]) this.clearArm(sessionId);
    for (const sessionId of [...this.holdWakes.keys()]) this.clearHoldWake(sessionId);
    for (const unsubscribe of [...this.unsubs]) {
      try {
        unsubscribe();
      } catch {
        /* dispose is defensive */
      }
    }
    this.unsubs = [];
    this.feed.stop?.();
  }
  snapshotSessions(): ReturnType<MessageQueueStore['snapshot']> {
    return this.store.snapshot((sessionId) => this.inFlightIdOf(sessionId));
  }
  private inFlightIdOf(sessionId: string): string | null {
    return this.dispatchClaims.inFlightIdOf(sessionId, this.sending.get(sessionId) ?? null);
  }
  snapshotSessionsShared(): Promise<{ revision: number; sessions: ReturnType<MessageQueueStore['snapshot']> }> {
    return this.withSharedQueue(() => ({ revision: this.store.currentRevision, sessions: this.snapshotSessions() }));
  }
  currentRevision(): number {
    return this.store.currentRevision;
  }

  /** Every mutation: bump + persist + broadcast; the payload names `session`
   *  = directory even when the LAST item leaves (§D.5). */
  private announceWithRevision(sessionId: string, directory: string, revision: number): void {
    publishControlEvent({
      type: CONTROL_EVENTS.messageQueueUpdated,
      payload: { revision, session: directory },
    });
  }
  private announce(sessionId: string, directory: string): void {
    this.announceWithRevision(sessionId, directory, this.store.currentRevision);
  }

  /** Serialize production mutations across server processes sharing the
   * queue file. Refresh under the lock before invoking the synchronous core
   * mutation, then wait for its atomic file replacement before releasing. */
  private async withSharedQueue<T>(mutate: () => T): Promise<T> {
    return withConfigLock(this.store.file, async () => {
      this.store.refreshPreservingEmpty();
      const result = mutate();
      await this.store.flushWrites();
      return result;
    });
  }
  enqueueItem(sessionId: string, directory: string, rawItem: unknown): { revision: number; itemId: string; duplicate: boolean } {
    const item = parseQueuedItemInput(rawItem);
    // F9 duplicate policy: an id already present with the SAME payload is the
    // same enqueue retried after a lost acknowledgement — accept without a
    // mutation (same revision, no duplicate append); a CHANGED payload under
    // that id is a conflict the caller must reject.
    const prior = this.store.findItem(sessionId, item.id);
    if (prior !== null) {
      if (sameQueuePayload(prior, item)) {
        return { revision: this.store.currentRevision, itemId: item.id, duplicate: true };
      }
      throw new QueueItemConflictError(`queued item ${item.id} already exists with a different payload`);
    }
    const revision = this.store.enqueue(sessionId, directory, item, (id) => this.inFlightIdOf(id));
    this.announceWithRevision(sessionId, directory, revision);
    this.armQuiet(sessionId); // arms dispatch; a session may already be idle
    return { revision, itemId: item.id, duplicate: false };
  }
  enqueueItemShared(sessionId: string, directory: string, rawItem: unknown): Promise<{ revision: number; itemId: string; duplicate: boolean }> {
    return this.withSharedQueue(() => this.enqueueItem(sessionId, directory, rawItem));
  }
  takeItem(sessionId: string, itemId: string): { kind: 'taken'; item: QueueItem; revision: number; directory: string } | { kind: 'inFlight' } | { kind: 'unknown' } {
    if (this.inFlightIdOf(sessionId) === itemId) return { kind: 'inFlight' };
    const directory = this.store.directoryOf(sessionId);
    const item = this.store.removeItem(sessionId, itemId);
    if (!item || directory === null) return { kind: 'unknown' };
    const revision = this.store.commit();
    this.announceWithRevision(sessionId, directory, revision);
    this.armQuiet(sessionId);
    return { kind: 'taken', item, revision, directory };
  }
  takeItemShared(sessionId: string, itemId: string): Promise<ReturnType<MessageQueueRuntime['takeItem']>> {
    return this.withSharedQueue(() => this.takeItem(sessionId, itemId));
  }
  takeAllItems(sessionId: string): { kind: 'taken'; items: QueueItem[]; revision: number; directory: string } | { kind: 'unknown' } {
    const directory = this.store.directoryOf(sessionId);
    const entry = this.store.entryOf(sessionId);
    if (!entry || directory === null) return { kind: 'unknown' };
    const items = this.store.takeAllExcept(sessionId, this.inFlightIdOf(sessionId));
    if (items.length === 0) return { kind: 'taken', items, revision: this.store.currentRevision, directory }; // no mutation: no bump/persist/broadcast
    const revision = this.store.commit();
    this.announceWithRevision(sessionId, directory, revision);
    return { kind: 'taken', items, revision, directory };
  }
  takeAllItemsShared(sessionId: string): Promise<ReturnType<MessageQueueRuntime['takeAllItems']>> {
    return this.withSharedQueue(() => this.takeAllItems(sessionId));
  }
  reorderItems(sessionId: string, itemIds: string[]): 'applied' | 'noop' | 'incomplete' | 'unknown' | 'inFlight' {
    const entry = this.store.entryOf(sessionId);
    if (!entry) return 'unknown';
    if (entry.items.length === 0 || itemIds.length === 0) return 'noop';
    const reordered = this.store.reorder(sessionId, itemIds, this.inFlightIdOf(sessionId));
    if (reordered === 'inFlight') return 'inFlight';
    if (reordered !== 'applied') return 'incomplete';
    const revision = this.store.commit();
    this.announceWithRevision(sessionId, entry.directory, revision);
    return 'applied';
  }
  reorderItemsShared(sessionId: string, itemIds: string[]): Promise<{ outcome: ReturnType<MessageQueueRuntime['reorderItems']>; revision: number; directory: string }> {
    return this.withSharedQueue(() => {
      const outcome = this.reorderItems(sessionId, itemIds);
      return { outcome, revision: this.store.currentRevision, directory: this.store.directoryOf(sessionId) ?? '' };
    });
  }

  /** 409 semantics live HERE: an in-flight item cannot leave the queue.
   *  The result names the directory so the LAST-item removal answers
   *  directory-named too (§D.5 — the reply payload, not only the broadcast). */
  deleteItem(sessionId: string, itemId: string): { kind: 'deleted'; revision: number; directory: string } | { kind: 'inFlight' } | { kind: 'unknown' } {
    if (this.inFlightIdOf(sessionId) === itemId) return { kind: 'inFlight' };
    const directory = this.store.directoryOf(sessionId);
    const removed = this.store.removeItem(sessionId, itemId);
    if (!removed || directory === null) return { kind: 'unknown' };
    const revision = this.store.commit();
    this.announceWithRevision(sessionId, directory, revision);
    return { kind: 'deleted', revision, directory };
  }
  deleteItemShared(sessionId: string, itemId: string): Promise<ReturnType<MessageQueueRuntime['deleteItem']>> {
    return this.withSharedQueue(() => this.deleteItem(sessionId, itemId));
  }

  /** §D.5 DELETE :id — clear all; the in-flight item STAYS so its send can
   *  resolve against its entry; the entry survives as directory memory. */
  deleteSessionQueue(sessionId: string): { kind: 'cleared'; revision: number; directory: string } | { kind: 'unknown' } {
    const directory = this.store.directoryOf(sessionId);
    if (!this.store.entryOf(sessionId) || directory === null) return { kind: 'unknown' };
    const removed = this.store.takeAllExcept(sessionId, this.inFlightIdOf(sessionId));
    const revision = removed.length > 0 ? this.store.commit() : this.store.currentRevision;
    if (removed.length > 0) this.announceWithRevision(sessionId, directory, revision);
    return { kind: 'cleared', revision, directory };
  }
  deleteSessionQueueShared(sessionId: string): Promise<ReturnType<MessageQueueRuntime['deleteSessionQueue']>> {
    return this.withSharedQueue(() => this.deleteSessionQueue(sessionId));
  }

  /** §D.3.1 session.deleted: drop the whole queue, commit + broadcast, and
   *  forget the directory memory; a mid-flight send resolves after it. */
  dropQueuedSession(sessionId: string): { dropped: boolean; directory: string | null } {
    const directory = this.store.directoryOf(sessionId);
    const entry = this.store.entryOf(sessionId);
    if (!entry || directory === null) {
      this.forgetTransientState(sessionId);
      return { dropped: false, directory: null };
    }
    this.forgetTransientState(sessionId);
    this.store.dropSession(sessionId);
    const revision = this.store.commit();
    this.announceWithRevision(sessionId, directory, revision);
    return { dropped: true, directory };
  }
  dropQueuedSessionShared(sessionId: string): Promise<ReturnType<MessageQueueRuntime['dropQueuedSession']>> {
    return this.withSharedQueue(() => this.dropQueuedSession(sessionId));
  }
  private forgetTransientState(sessionId: string): void {
    const activelySending = this.activeDeliveries.has(sessionId);
    this.sending.delete(sessionId);
    if (!activelySending) {
      this.dispatchClaims.release(sessionId);
    }
    this.backoffs.delete(sessionId);
    this.aborts.delete(sessionId);
    this.holds.delete(sessionId);
    this.clearArm(sessionId);
    this.clearHoldWake(sessionId);
  }

  /** §D.4 hold (in-memory only): `held:true` holds until
   *  `now + min(ttlMs || 5 min, 10 min)`; `held:false` releases + arms. */
  setHold(sessionId: string, held: boolean, ttlMs?: number): { held: boolean; expiresAt?: number } {
    if (!held) {
      this.holds.delete(sessionId);
      this.clearHoldWake(sessionId);
      this.armQuiet(sessionId);
      return { held: false };
    }
    const requested = typeof ttlMs === 'number' && Number.isSafeInteger(ttlMs) && ttlMs > 0 ? ttlMs : this.timing.holdDefaultMs;
    const expiresAt = Date.now() + Math.min(requested, this.timing.holdMaxMs);
    this.holds.set(sessionId, expiresAt);
    this.clearArm(sessionId); // clears any armed dispatch timer (§D.4)
    this.armHoldWake(sessionId, expiresAt);
    return { held: true, expiresAt };
  }
  heldExpiryOf(sessionId: string): number | null {
    const expiresAt = this.holds.get(sessionId);
    if (expiresAt === undefined) return null;
    if (Date.now() >= expiresAt) {
      this.holds.delete(sessionId); // expired holds self-delete at check time (§D.3.1)
      return null;
    }
    return expiresAt;
  }

  /** Abort-window read (§D.3.2 bookkeeping, test/diagnostic seam): the
   *  recorded stop timestamp, null once absent. Consumed stamps vanish at
   *  check time (mirrors holds); only ticking sessions vacuum theirs. */
  abortAtOf(sessionId: string): number | null {
    return this.aborts.get(sessionId) ?? null;
  }

  /** §D.4 auto-release: "the hold EXPIRES ON ITS OWN at the TTL" (the
   *  asserting UI may die), so expiry schedules its own wake — a separate
   *  timer map that burst busy/retry clears cannot kill, and every
   *  re-assertion replaces. The wake only drives a tick: the §D.3 gate
   *  ladder (idleness + hold self-delete) still owns every dispatch. */
  private armHoldWake(sessionId: string, expiresAt: number): void {
    this.clearHoldWake(sessionId);
    const timer = setTimeout(() => {
      this.holdWakes.delete(sessionId);
      if (this.stopped) return;
      void this.tick(sessionId);
    }, Math.max(1, expiresAt - Date.now() + 1)); // ≥ expiresAt: the check self-deletes the hold
    this.holdWakes.set(sessionId, { timer, at: expiresAt });
  }
  private clearHoldWake(sessionId: string): void {
    const wake = this.holdWakes.get(sessionId);
    if (!wake) return;
    clearTimeout(wake.timer);
    this.holdWakes.delete(sessionId);
  }
  private onEnvelope(envelope: QueueEnvelope): void {
    if (this.stopped) return;
    const properties = asRecord(envelope.payload?.properties) ?? {};
    const sessionId = optionalPropertyString(properties, 'sessionID') ?? optionalPropertyString(properties, 'sessionId');
    if (!sessionId) return;
    if (envelope.payload.type === 'session.deleted') {
      void this.dropQueuedSessionShared(sessionId).catch(() => {});
      return;
    }
    if (envelope.payload.type === 'session.status') {
      const queued = this.store.entryOf(sessionId) !== null;
      this.onSessionStatus(sessionId, properties.status, queued);
      return;
    }
    if (envelope.payload.type === 'message.updated') {
      const queued = this.store.entryOf(sessionId) !== null;
      this.onMessageUpdated(sessionId, properties.info, queued);
    }
  }
  private onSessionStatus(sessionId: string, status: unknown, queued: boolean): void {
    if (!queued) return;
    const type = asRecord(status)?.type;
    if (type === 'idle') {
      this.armQuiet(sessionId);
      return;
    }
    if (type === 'busy' || type === 'retry') this.clearArm(sessionId); // burst gate (§D.3)
  }
  private onMessageUpdated(sessionId: string, info: unknown, queued: boolean): void {
    const record = asRecord(info);
    if (!record || record.role !== 'assistant') return;
    if (errorNameOf(record.error) === 'MessageAbortedError') {
      this.aborts.set(sessionId, Date.now());
      return;
    }
    const completed = asRecord(record.time)?.completed;
    if (typeof completed === 'number' && queued && !this.arms.has(sessionId)) this.armQuiet(sessionId);
  }
  private arm(sessionId: string, delayMs: number): void {
    const at = Date.now() + Math.max(0, delayMs);
    const existing = this.arms.get(sessionId);
    if (existing && existing.at <= at) return;
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => {
      this.arms.delete(sessionId);
      void this.tick(sessionId);
    }, Math.max(1, at - Date.now()));
    this.arms.set(sessionId, { timer, at });
  }
  private armQuiet(sessionId: string): void {
    if (this.heldExpiryOf(sessionId) !== null) return;
    this.arm(sessionId, this.timing.quietMs);
  }
  private clearArm(sessionId: string): void {
    const existing = this.arms.get(sessionId);
    if (!existing) return;
    clearTimeout(existing.timer);
    this.arms.delete(sessionId);
  }

  /** §D.3 hub (re)connect: re-arm every armed-less session with items. The
   *  probe is ALSO the §D.2 write-recovery hook ("a later load success
   *  re-enables"): reconcileAll is the process's only recurring wiring
   *  beat, so a previously hard-failed store re-probes here. */
  reconcileAll(): void {
    if (this.stopped) return;
    this.store.recoverWrites(); // post-failure recovery nit never reverts the in-memory queue
    for (const { sessionId } of this.store.nonEmptyEntries()) {
      if (this.sending.has(sessionId)) continue;
      if (this.arms.has(sessionId)) continue;
      this.armQuiet(sessionId);
    }
  }
  async tick(sessionId: string): Promise<void> {
    if (this.stopped || this.ticking.has(sessionId)) return;
    const entry = this.store.entryOf(sessionId);
    const head = entry?.items[0] ?? null;
    if (!entry || !head) return;
    if (this.sending.has(sessionId)) return;
    if (this.heldExpiryOf(sessionId) !== null) return;
    this.ticking.add(sessionId);
    try {
      await this.tickVerified(sessionId, head, entry.directory);
    } finally {
      this.ticking.delete(sessionId);
    }
  }
  private async tickVerified(sessionId: string, head: QueueItem, directory: string): Promise<void> {
    const now = Date.now();
    const abortedAt = this.aborts.get(sessionId);
    if (abortedAt !== undefined && now < abortedAt + this.timing.abortHoldMs) {
      this.arm(sessionId, abortedAt + this.timing.abortHoldMs - now); // stop hold (§D.3.2)
      return;
    }
    this.aborts.delete(sessionId); // consumed stop window self-deletes at check time (holds posture)
    const record = this.backoffs.get(sessionId);
    if (record) {
      if (record.itemId !== head.id) this.backoffs.delete(sessionId); // drop stale record
      else if (record.nextAttemptAt > now) {
        this.arm(sessionId, record.nextAttemptAt - now); // same item, not yet due
        return;
      }
    }
    const idleness = await this.verifyIdle(sessionId, directory);
    if (idleness !== 'idle') {
      if (idleness === 'unknown') this.arm(sessionId, this.timing.verifyBackoffMs);
      return;
    }
    const currentHead = this.store.entryOf(sessionId)?.items[0] ?? null;
    if (!currentHead || currentHead.id !== head.id) return;
    await this.dispatchHead(sessionId, currentHead, directory);
  }

  /** Live idleness verification, BOTH signals authoritative (§D.3.4). A
   *  failed fetch of either is unknown — never treated as idle. */
  private async verifyIdle(sessionId: string, directory: string): Promise<'idle' | 'not-idle' | 'unknown'> {
    const statusMap = await callHarnessJson(harnessRequest('/session/status', directory, { method: 'GET' }));
    if (statusMap === null || !asRecord(statusMap)) return 'unknown';
    if ((statusMap as Record<string, unknown>)[sessionId] !== undefined) return 'not-idle';
    const tail = await callHarnessJson(
      harnessRequest(`/session/${encodeURIComponent(sessionId)}/message?limit=2`, directory, { method: 'GET' }),
    );
    if (!Array.isArray(tail)) return 'unknown';
    if (tail.length > 0 && tailUnfinishedAssistant(tail[tail.length - 1])) return 'not-idle';
    return 'idle';
  }
  private async dispatchHead(sessionId: string, head: QueueItem, directory: string): Promise<void> {
    let claim = this.dispatchClaims.get(sessionId);
    try {
      if (!claim) {
        claim = this.dispatchClaims.acquire(sessionId, head.id);
        if (!claim) {
          this.arm(sessionId, this.timing.verifyBackoffMs);
          return;
        }
        this.dispatchClaims.set(sessionId, claim);
        const stillHead = await this.withSharedQueue(() => this.store.entryOf(sessionId)?.items[0]?.id === head.id);
        if (!stillHead) return;
      }
      if (this.stopped) return;
      if (await this.verifyIdle(sessionId, directory) !== 'idle') {
        this.arm(sessionId, this.timing.verifyBackoffMs);
        return;
      }
      if (!this.dispatchClaims.owns(sessionId, claim)) return;
      this.sending.set(sessionId, head.id);
      this.activeDeliveries.add(sessionId);
      this.announce(sessionId, directory); // in-flight mark + broadcast FIRST (§D.3.6)
      const outcome = await deliverHead(sessionId, directory, head, this.knowledge);
      if (this.stopped) return; // dispose releases the claim; late results cannot mutate the revived queue
      if (outcome.ok) await this.withSharedQueue(() => this.onDelivered(head, sessionId, directory));
      else {
        const retainedForRetry = await this.withSharedQueue(() => {
          if (this.store.entryOf(sessionId)?.items[0]?.id !== head.id) return false;
          this.onRejected(head, sessionId, directory, outcome);
          return true;
        });
        if (retainedForRetry) claim = null; // retain the claim across this item's exponential backoff
      }
    } catch {
      if (!this.stopped) this.arm(sessionId, this.timing.verifyBackoffMs);
    } finally {
      this.sending.delete(sessionId);
      this.activeDeliveries.delete(sessionId);
      if (claim) this.dispatchClaims.release(sessionId, claim);
    }
  }
  private onDelivered(item: QueueItem, sessionId: string, directory: string): void {
    const removed = this.store.removeItem(sessionId, item.id); // tolerates a mid-send queue drop
    if (removed) {
      const revision = this.store.commit();
      this.announceWithRevision(sessionId, directory, revision);
      notifyPromptSent(sessionId, directory, item.id); // notification trigger seam (§D.3.7)
    }
    this.backoffs.delete(sessionId);
  }
  private onRejected(item: QueueItem, sessionId: string, directory: string, outcome: DeliveryOutcome): void {
    void outcome;
    const previous = this.backoffs.get(sessionId);
    const failures = previous?.itemId === item.id ? previous.failures + 1 : 1;
    const delay = failureDelayMs(failures, this.timing);
    this.backoffs.set(sessionId, { itemId: item.id, failures, nextAttemptAt: Date.now() + delay });
    this.announce(sessionId, directory); // the UI sees the failure pitch (§D.3.8)
    this.arm(sessionId, delay); // the next item waits for the next idle cycle
  }
}

let defaultRuntime: MessageQueueRuntime | null = null;

export function getMessageQueueRuntime(): MessageQueueRuntime {
  if (!defaultRuntime) {
    const store = new MessageQueueStore(joinPath(ENV.dataDir, QUEUE_FILE_NAME));
    const feed = new AdapterQueueFeed();
    const runtime = new MessageQueueRuntime(store, feed, createAgentMemoryKnowledgeProvider());
    runtime.start();
    defaultRuntime = runtime;
  }
  return defaultRuntime;
}
