// SPDX-License-Identifier: Apache-2.0
/**
 * SessionMessageLoader (doc 04 §E.1): the single authority for transcript
 * HTTP. One in-flight request per entry shared by ALL callers; cursor via
 * `x-next-cursor`; refreshTail queues behind in-flight older loads and never
 * clobbers the coverage cursor; optimistic items merge into every page;
 * failure preserves records — never an empty success.
 */
import type { StoreApi } from 'zustand/vanilla';
import { harnessClient } from '../lib/nnd/client.ts';
import { getRuntimeKey } from '../lib/runtime-switch.ts';
import type { Message, MessageEntry, Part } from '../lib/nnd/types.ts';
import type { DirectoryStore } from './types.ts';
import { INITIAL_EXPANSION_LIMITS, SESSION_OLDER_PAGE_SIZE, SESSION_PAGE_SIZE } from './types.ts';
import { insertMessageChronological, normalizeMessageEntries } from './message-ordering.ts';
import { sanitizeMessageEntry } from './sanitize.ts';

export type LoadKind = 'initial' | 'older' | 'refresh' | 'prefetch' | null;

export interface SessionMessageLoadState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  loadingKind: LoadKind;
  error: Error | null;
  resolved: boolean;
  limit: number;
  cursor: string | undefined;
  complete: boolean;
  generation: number;
  updatedAt: number | undefined;
}

export interface LoaderTarget {
  directory: string;
  sessionID: string;
  store: StoreApi<DirectoryStore>;
}

export interface OptimisticItem {
  messageID: string;
  message: Message;
  parts: Part[];
}

const IDLE_STATE: SessionMessageLoadState = {
  status: 'idle',
  loadingKind: null,
  error: null,
  resolved: false,
  limit: 0,
  cursor: undefined,
  complete: false,
  generation: 0,
  updatedAt: Date.now(),
};

export function isTranscriptRenderable(store: StoreApi<DirectoryStore>, sessionID: string): boolean {
  const state = store.getState();
  const messages = state.message[sessionID];
  if (!messages || messages.length === 0) return false;
  // every message must have an explicit (possibly empty) part bucket
  return messages.every((m) => state.part[m.id] !== undefined);
}

export class SessionMessageLoader {
  private entries = new Map<string, { state: SessionMessageLoadState; inflight: Promise<void> | null; optimistic: Map<string, OptimisticItem>; queuedRefresh: number | null }>();
  private sdkEpoch = 0;
  private disposed = false;
  private runtimeKey = getRuntimeKey();

  configure(runtimeKey: string): void {
    this.sdkEpoch += 1;
    if (runtimeKey !== this.runtimeKey) {
      this.entries.clear(); // runtime changed: entry keys were the old runtime's
      this.runtimeKey = runtimeKey;
    } else {
      for (const entry of this.entries.values()) {
        entry.state.generation += 1;
        entry.inflight = null;
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    this.sdkEpoch += 1;
    this.entries.clear();
  }

  private key(target: LoaderTarget): string {
    return `${this.runtimeKey}\n${target.directory}\n${target.sessionID}`;
  }

  private entry(target: LoaderTarget) {
    const key = this.key(target);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { state: { ...IDLE_STATE }, inflight: null, optimistic: new Map(), queuedRefresh: null };
      this.entries.set(key, entry);
    }
    return entry;
  }

  getState(target: LoaderTarget): SessionMessageLoadState {
    const entry = this.entries.get(this.key(target));
    return entry ? { ...entry.state } : { ...IDLE_STATE };
  }

  isCurrent(entryKey: string, generation: number, target: LoaderTarget): boolean {
    if (this.disposed) return false;
    const entry = this.entries.get(entryKey);
    return !!entry && entry.state.generation === generation && this.entry(target) === entry;
  }

  /** Renderable ⇒ ready without HTTP; in-flight attaches; prefetch→initial promotion. */
  ensure(target: LoaderTarget, opts?: { force?: boolean; reason?: 'initial' | 'prefetch' | 'navigation' }): Promise<void> {
    const entry = this.entry(target);
    // A successful empty page (including a just-created session) is already
    // hydrated. Empty transcripts cannot satisfy isTranscriptRenderable().
    if (!opts?.force && entry.state.status === 'ready' && entry.state.resolved
      && target.store.getState().message[target.sessionID]?.length === 0) {
      return Promise.resolve();
    }
    if (!opts?.force && isTranscriptRenderable(target.store, target.sessionID)) {
      if (entry.state.status !== 'ready') {
        entry.state = { ...entry.state, status: 'ready', loadingKind: null, resolved: true, updatedAt: Date.now() };
      }
      return Promise.resolve();
    }
    if (entry.inflight) {
      if (entry.state.loadingKind === 'prefetch' && opts?.reason !== 'prefetch') {
        entry.state = { ...entry.state, loadingKind: 'initial' }; // kind upgrade, no restart
      }
      return entry.inflight;
    }
    if (opts?.force) entry.state.generation += 1; // supersede prior publications
    const generation = entry.state.generation; // captured AFTER the bump
    const kind: LoadKind = opts?.reason === 'prefetch' ? 'prefetch' : 'initial';
    entry.inflight = this.runLoad(target, entry, SESSION_PAGE_SIZE, undefined, kind, generation)
      .finally(() => {
        const stillOurs = this.entries.get(this.key(target)) === entry;
        if (stillOurs) entry.inflight = null;
        const pendingRefresh = entry.queuedRefresh;
        if (pendingRefresh !== null && stillOurs) {
          entry.queuedRefresh = null;
          void this.refreshTail(target, pendingRefresh); // queued refresh runs AFTER the in-flight load
        }
      });
    return entry.inflight;
  }

  prefetch(target: LoaderTarget): Promise<void> {
    return this.ensure(target, { reason: 'prefetch' });
  }

  private async runLoad(
    target: LoaderTarget,
    entry: ReturnType<SessionMessageLoader['entry']>,
    limit: number,
    before: string | undefined,
    kind: LoadKind,
    generation: number,
  ): Promise<void> {
    const entryKey = this.key(target);
    entry.state = { ...entry.state, status: 'loading', loadingKind: kind, error: null };
    const result = await harnessClient.listMessagesPage(target.sessionID, { directory: target.directory, limit, before });
    if (!this.isCurrent(entryKey, entry.state.generation, target) || entry.state.generation !== generation) {
      return; // stale completion publishes nothing
    }
    if (result.error || !Array.isArray(result.data)) {
      // fetch failure: keep prior records; status error, never empty success
      entry.state = { ...entry.state, status: 'error', loadingKind: null, error: new Error(result.error ?? 'messages failed') };
      return;
    }
    let entries = normalizeMessageEntries(result.data.map(sanitizeMessageEntry));

    // initial underfill expansion: no user message and more history exists
    if (kind === 'initial' && result.cursor && !entries.some((e) => e.info.role === 'user')) {
      for (const expansionLimit of INITIAL_EXPANSION_LIMITS) {
        if (expansionLimit <= limit) continue;
        const retry = await harnessClient.listMessagesPage(target.sessionID, { directory: target.directory, limit: expansionLimit, before });
        if (!this.isCurrent(entryKey, entry.state.generation, target)) return;
        if (retry.error || !Array.isArray(retry.data)) break;
        entries = normalizeMessageEntries(retry.data.map(sanitizeMessageEntry));
        limit = expansionLimit;
        if (!retry.cursor || entries.some((e) => e.info.role === 'user')) {
          result.cursor = retry.cursor;
          break;
        }
        result.cursor = retry.cursor;
      }
    }

    this.commit(target.store, target.sessionID, entries, entry, kind === 'older' ? 'prepend' : 'replace');
    entry.state = {
      ...entry.state,
      status: 'ready',
      loadingKind: null,
      resolved: true,
      limit,
      cursor: result.cursor ?? undefined,
      complete: !result.cursor,
      updatedAt: Date.now(),
    };
  }

  async loadOlder(target: LoaderTarget): Promise<void> {
    const entry = this.entry(target);
    if (entry.state.status === 'loading') return;
    if (entry.state.complete || !entry.state.cursor) return;
    await this.runLoad(target, entry, SESSION_OLDER_PAGE_SIZE, entry.state.cursor, 'older', entry.state.generation);
  }

  async loadComplete(target: LoaderTarget): Promise<void> {
    const visited = new Set<string>();
    while (true) {
      const state = this.getState(target);
      if (state.complete) return;
      if (!state.cursor) throw new Error('no progress');
      if (visited.has(state.cursor)) throw new Error('no progress');
      visited.add(state.cursor);
      await this.loadOlder(target);
    }
  }

  /** Small-window tail refresh; its cursor does NOT replace coverage state.
   * Queued behind an in-flight older-page load (newest authority must win). */
  async refreshTail(target: LoaderTarget, limit = SESSION_PAGE_SIZE): Promise<void> {
    const entry = this.entry(target);
    if (entry.inflight) {
      entry.queuedRefresh = Math.max(entry.queuedRefresh ?? 0, limit);
      return;
    }
    const generation = entry.state.generation;
    const entryKey = this.key(target);
    const result = await harnessClient.listMessagesPage(target.sessionID, { directory: target.directory, limit });
    if (!this.isCurrent(entryKey, generation, target) || !this.entries.get(entryKey)) return;
    if (result.error || !Array.isArray(result.data)) return; // preserve materialized records
    const current = this.entries.get(entryKey);
    if (!current) return;
    this.commit(target.store, target.sessionID, normalizeMessageEntries(result.data.map(sanitizeMessageEntry)), current, 'tail');
    current.state = { ...current.state, status: 'ready', resolved: true, updatedAt: Date.now() };
  }

  /**
   * Merge a page into the store.
   * - replace: upsert messages + part buckets (terminal parts preserved)
   * - prepend: older page — existing buckets are NOT overwritten
   * - tail: like replace but never touches coverage cursor/complete
   */
  private commit(
    store: StoreApi<DirectoryStore>,
    sessionID: string,
    entries: MessageEntry[],
    entry: { optimistic: Map<string, OptimisticItem> },
    mode: 'replace' | 'prepend' | 'tail',
  ): void {
    const state = store.getState();
    const existingMessages = state.message[sessionID] ?? [];
    const nextMessages = [...existingMessages];
    const message = { ...state.message };
    const part = { ...state.part };

    const mergeEntry = (rec: MessageEntry) => {
      const index = nextMessages.findIndex((m) => m.id === rec.info.id);
      const isComplete = (parts: Part[] | undefined): boolean =>
        !!parts && parts.every((p) => !isOptimisticPart(p));
      if (index >= 0) {
        const current = nextMessages[index]!;
        const currentParts = part[current.id];
        if (mode === 'prepend' && currentParts !== undefined) {
          // prepend never overwrites materialized buckets
          if (!Array.isArray(rec.parts)) return;
          return;
        }
        if (mode !== 'prepend' && isComplete(currentParts) && rec.parts.length === 0) return;
        const merged = mergePartsPreservingTerminal(currentParts, rec.parts);
        nextMessages[index] = keepReferenceIfEqual(current, rec.info) ? current : rec.info;
        part[rec.info.id] = merged;
      } else {
        insertMessageChronological(nextMessages, rec.info);
        if (Array.isArray(rec.parts)) part[rec.info.id] = rec.parts;
      }
    };

    for (const rec of entries) mergeEntry(rec);

    // optimistic shadow: merge live items; drop confirmed when server covers them
    for (const [messageID, item] of [...entry.optimistic]) {
      const covered = entries.find((rec) => rec.info.id === messageID);
      if (covered && covered.parts.some((p) => p.type === 'text' && !isOptimisticPart(p))) {
        entry.optimistic.delete(messageID);
        continue;
      }
      if (!nextMessages.some((m) => m.id === messageID)) {
        insertMessageChronological(nextMessages, item.message);
        if (part[item.messageID] === undefined) part[item.messageID] = item.parts;
      }
    }

    message[sessionID] = nextMessages;
    store.setState({ message, part });
  }

  optimisticAdd(target: LoaderTarget, item: OptimisticItem): void {
    const entry = this.entry(target);
    entry.optimistic.set(item.messageID, item);
    const state = target.store.getState();
    const messages = [...(state.message[target.sessionID] ?? [])];
    if (!messages.some((m) => m.id === item.messageID)) insertMessageChronological(messages, item.message);
    const part = { ...state.part };
    if (part[item.messageID] === undefined) part[item.messageID] = item.parts;
    target.store.setState({ message: { ...state.message, [target.sessionID]: messages }, part });
  }

  optimisticRemove(target: LoaderTarget, messageID: string): void {
    const entry = this.entry(target);
    entry.optimistic.delete(messageID);
    const state = target.store.getState();
    const messages = (state.message[target.sessionID] ?? []).filter((m) => m.id !== messageID);
    const part = { ...state.part };
    delete part[messageID];
    target.store.setState({ message: { ...state.message, [target.sessionID]: messages }, part });
  }

  optimisticConfirm(target: LoaderTarget, messageID: string): void {
    this.entry(target).optimistic.delete(messageID);
  }

  /** Post-create: claim an EMPTY transcript so opening needs no history read. */
  initializeCreatedSession(target: LoaderTarget): void {
    const entry = this.entry(target);
    entry.state.generation += 1; // supersede any unresolved history load
    entry.inflight = null;
    const state = target.store.getState();
    const arrived = state.message[target.sessionID];
    if (!arrived || arrived.length === 0) {
      target.store.setState({ message: { ...state.message, [target.sessionID]: [] } });
    }
    entry.state = { ...entry.state, status: 'ready', loadingKind: null, resolved: true, limit: 0, cursor: undefined, complete: true, updatedAt: Date.now() };
  }

  invalidateSession(target: LoaderTarget): void {
    const entry = this.entries.get(this.key(target));
    if (entry) {
      entry.state.generation += 1;
      entry.optimistic.clear();
      entry.state = { ...IDLE_STATE, generation: entry.state.generation + 1 };
      entry.inflight = null;
    }
  }

  invalidateDirectory(directory: string): void {
    for (const [key, entry] of [...this.entries]) {
      if (key.startsWith(`${this.runtimeKey}\n${directory}\n`)) {
        entry.state.generation += 1;
        entry.optimistic.clear();
        entry.inflight = null;
        this.entries.delete(key);
      }
    }
  }
}

function isOptimisticPart(part: Part): boolean {
  return !part.sessionID;
}

function keepReferenceIfEqual(current: Message, incoming: Message): boolean {
  return current === incoming || JSON.stringify(current) === JSON.stringify(incoming);
}

/** Terminal tool parts and live streaming parts survive page merges. */
export function mergePartsPreservingTerminal(existing: Part[] | undefined, incoming: Part[]): Part[] {
  if (!existing || existing.length === 0) return incoming;
  // A server part can have a new ID while replacing an optimistic draft part.
  // Keep unrelated live/tool parts, but never render both text copies.
  const authoritativeTypes = new Set(incoming.filter((part) => !isOptimisticPart(part)).map((part) => part.type));
  const merged = existing.filter((part) => !isOptimisticPart(part) || !authoritativeTypes.has(part.type));
  for (const incomingPart of incoming) {
    const index = merged.findIndex((p) => p.id === incomingPart.id);
    if (index < 0) {
      merged.push(incomingPart);
      continue;
    }
    const current = merged[index]!;
    const currentStatus = (current as { state?: { status?: string } }).state?.status;
    const terminal = currentStatus === 'completed' || currentStatus === 'error' || currentStatus === 'aborted';
    if (terminal && (incomingPart as { state?: { time?: { end?: number } } }).state?.time?.end === undefined && !isTerminalState(incomingPart)) {
      continue; // stale refresh cannot regress a finalized tool
    }
    merged[index] = incomingPart;
  }
  return merged;
}

function isTerminalState(part: Part): boolean {
  const status = (part as { state?: { status?: string } }).state?.status;
  return status === 'completed' || status === 'error' || status === 'aborted';
}
