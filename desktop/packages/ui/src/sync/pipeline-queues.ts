// SPDX-License-Identifier: Apache-2.0
/**
 * Pipeline queues + transport math (doc 04 §D.1/§D.2): per-directory ordered
 * queues with the ONLY four coalescing keys, order-critical barriers,
 * double-buffered flush frames, and bounded backoff computation.
 */
import type { HarnessEvent } from '../lib/nnd/events.ts';
import {
  BACKPRESSURE_FLUSH_FRAME_MS,
  BACKPRESSURE_MODE_MS,
  FLUSH_FRAME_MS,
  RETRY_BACKOFF_BASE_MS,
  RETRY_BACKOFF_CAP_HIDDEN_OR_OFFLINE_MS,
  RETRY_BACKOFF_CAP_VISIBLE_MS,
  RETRY_BACKOFF_MAX_EXPONENT,
} from './types.ts';

export const EXTENSION_SUFFIX = /^(.*)\.(\d+)$/;

export function foldEventType(type: string): string {
  const match = EXTENSION_SUFFIX.exec(type);
  return match ? match[1]! : type;
}

export function isHeartbeatType(type: string): boolean {
  return type === 'heartbeat' || type === 'ping';
}

export function resolveEventDirectory(event: HarnessEvent): string {
  const props = (event.properties ?? {}) as Record<string, unknown>;
  if (event.directory) return event.directory;
  if (typeof props['directory'] === 'string' && props['directory']) return props['directory'];
  const info = props['info'] as Record<string, unknown> | undefined;
  if (info && typeof info['directory'] === 'string' && info['directory']) return info['directory'];
  return 'global';
}

/** Coalescing keys — ONLY the four documented keys exist (§D.2). */
export function coalescingKey(event: HarnessEvent): string | null {
  const props = (event.properties ?? {}) as Record<string, unknown>;
  switch (event.type) {
    case 'session.status': {
      const id = props['sessionID'];
      return typeof id === 'string' ? `session.status:${id}` : null;
    }
    case 'session.updated': {
      const info = props['info'] as Record<string, unknown> | undefined;
      const id = (info?.['id'] ?? props['sessionID']) as string | undefined;
      return typeof id === 'string' ? `session.updated:${id}` : null;
    }
    case 'lsp.updated':
      return 'lsp.updated';
    case 'message.part.delta': {
      const messageID = props['messageID'];
      const partID = props['partID'];
      const field = props['field'];
      if (typeof messageID === 'string' && typeof partID === 'string' && typeof field === 'string') {
        return `message.part.delta:${messageID}:${partID}:${field}`;
      }
      return null;
    }
    default:
      return null;
  }
}

interface DirectoryQueue {
  queue: (HarnessEvent | null)[];
  coalesced: Map<string, number>;
  timer: ReturnType<typeof setTimeout> | null;
  last: number;
}

export class PipelineQueues {
  private dirs = new Map<string, DirectoryQueue>();
  backpressureUntil = 0;

  constructor(
    private readonly onFlush: (directory: string, events: readonly HarnessEvent[]) => void,
    private readonly now: () => number = () => Date.now(),
  ) {}

  frameMs(): number {
    return this.now() < this.backpressureUntil ? BACKPRESSURE_FLUSH_FRAME_MS : FLUSH_FRAME_MS;
  }

  push(event: HarnessEvent): void {
    const directory = resolveEventDirectory(event);
    let dir = this.dirs.get(directory);
    if (!dir) {
      dir = { queue: [], coalesced: new Map(), timer: null, last: 0 };
      this.dirs.set(directory, dir);
    }
    applyCoalescingBarriers(dir, event);
    enqueueWithCoalescing(dir, event);
    this.scheduleFlush(directory, dir);
  }

  flush(directory: string): void {
    const dir = this.dirs.get(directory);
    if (!dir) return;
    if (dir.timer !== null) {
      clearTimeout(dir.timer);
      dir.timer = null;
    }
    const events = dir.queue.filter((value): value is HarnessEvent => value !== null);
    dir.queue = [];
    dir.coalesced.clear();
    if (events.length > 0) this.onFlush(directory, events);
  }

  private scheduleFlush(directory: string, dir: DirectoryQueue): void {
    const now = this.now();
    dir.last = now;
    if (dir.timer !== null) return;
    const target = dir;
    const delay = Math.max(0, dir.last + this.frameMs() - now);
    dir.timer = setTimeout(() => {
      target.timer = null;
      this.flush(directory);
    }, delay);
  }

  flushAll(): void {
    for (const directory of [...this.dirs.keys()]) this.flush(directory);
  }

  clear(): void {
    for (const dir of this.dirs.values()) if (dir.timer !== null) clearTimeout(dir.timer);
    this.dirs.clear();
  }
}

function enqueueWithCoalescing(dir: DirectoryQueue, event: HarnessEvent): void {
  const key = coalescingKey(event);
  const slot = key !== null ? dir.coalesced.get(key) : undefined;
  if (key !== null && slot !== undefined) {
    dir.queue[slot] = mergeCoalesced(dir.queue[slot] ?? null, event);
    return;
  }
  const nextSlot = dir.queue.length;
  dir.queue.push(event);
  if (key !== null) dir.coalesced.set(key, nextSlot);
}

/** later replaces earlier IN SLOT; only deltas concatenate (order preserved). */
function mergeCoalesced(previous: HarnessEvent | null, event: HarnessEvent): HarnessEvent {
  if (previous && event.type === 'message.part.delta') {
    const prevProps = previous.properties as Record<string, unknown>;
    const nextProps = event.properties as Record<string, unknown>;
    return {
      ...event,
      properties: { ...nextProps, delta: `${String(prevProps['delta'] ?? '')}${String(nextProps['delta'] ?? '')}` },
    };
  }
  return event;
}


/** Barriers: snapshot-after-delta + terminal-must-not-be-swallowed (§D.2). */
function applyCoalescingBarriers(dir: DirectoryQueue, event: HarnessEvent): void {
  const props = (event.properties ?? {}) as Record<string, unknown>;
  if (event.type === 'message.part.updated') {
    dropPartDeltaKeys(dir, partIdentifiers(props));
    return;
  }
  const structural = STRUCTURAL_SESSION_EVENTS.has(event.type);
  if (structural || SETTLE_SESSION_EVENTS.has(event.type)) {
    const id = String(props['sessionID'] ?? loose(props['info'])['id'] ?? '');
    if (!id) return;
    dropKey(dir, `session.status:${id}`);
    // only structural (created/deleted) also swallow a queued session.updated
    if (structural) dropKey(dir, `session.updated:${id}`);
  }
}

const STRUCTURAL_SESSION_EVENTS = new Set(['session.created', 'session.deleted']);
const SETTLE_SESSION_EVENTS = new Set(['session.idle', 'session.error']);

function loose(value: unknown): Record<string, unknown> {
  return (value ?? {}) as Record<string, unknown>;
}

function partIdentifiers(props: Record<string, unknown>): { messageID: string; partID: string } | null {
  const part = props['part'] as Record<string, unknown> | undefined;
  const messageID = part?.['messageID'];
  const partID = part?.['id'];
  if (typeof messageID === 'string' && typeof partID === 'string') return { messageID, partID };
  return null;
}

function dropPartDeltaKeys(dir: DirectoryQueue, ids: { messageID: string; partID: string } | null): void {
  if (!ids) return;
  const prefix = `message.part.delta:${ids.messageID}:${ids.partID}:`;
  invalidateMatching(dir, (key) => key.startsWith(prefix));
}

function dropKey(dir: DirectoryQueue, exact: string): void {
  invalidateMatching(dir, (key) => key === exact);
}

function invalidateMatching(dir: DirectoryQueue, matches: (key: string) => boolean): void {
  for (const [key, slot] of [...dir.coalesced]) {
    if (!matches(key)) continue;
    dir.queue[slot] = null;
    dir.coalesced.delete(key);
  }
}

export function computeRetryDelay(
  failures: number,
  visible: boolean,
  online: boolean,
  permanent4xx: boolean,
): number {
  const cap = visible && online ? RETRY_BACKOFF_CAP_VISIBLE_MS : RETRY_BACKOFF_CAP_HIDDEN_OR_OFFLINE_MS;
  if (permanent4xx) return cap; // bad auth / stuck path: hammering at 5s never helps
  const exponent = Math.min(Math.max(failures - 1, 0), RETRY_BACKOFF_MAX_EXPONENT);
  return Math.min(cap, RETRY_BACKOFF_BASE_MS * 2 ** exponent);
}

export function isPermanent4xx(status: number | undefined): boolean {
  if (status === undefined) return false;
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}
