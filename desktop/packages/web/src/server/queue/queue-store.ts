// SPDX-License-Identifier: Apache-2.0
/**
 * Message-queue persistence (doc 12 §D.2): `<data-dir>/message-queue.json`
 * holds `{version:1, revision, sessions:{[sessionId]:{directory,items}}}`.
 * Global `revision` bumps on EVERY mutation; writes are atomic pid-suffixed
 * tmp + rename through a serialized chain. A MISSING file boots empty. A
 * MALFORMED file is a failure, NOT empty data: it renames aside to
 * `message-queue.json.corrupt-<timestamp>` first so the next write cannot
 * overwrite the user's data. A hard READ failure disables writes (the
 * in-memory queue stays; a later successful load re-enables) — a fetch
 * failure must never masquerade as an authoritative empty success.
 * Per-runtime in-memory: holds, backoff tracking, and abort timestamps.
 * Per-session dispatch claims are OS-visible beside this file; process-local
 * sending IDs project those claims into snapshots.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { publicQueueItem, type QueueItem } from './queue-item.ts';

export const QUEUE_FILE_NAME = 'message-queue.json';
export const QUEUE_MAX_ITEMS_PER_SESSION = 20;
export const QUEUE_MAX_SESSIONS = 50;

export interface QueueSessionEntry {
  directory: string;
  items: QueueItem[];
}

export interface PersistedQueueFile {
  version: 1;
  revision: number;
  sessions: Record<string, { directory: string; items: QueueItem[] }>;
}

export interface QueueSessionSnapshot {
  sessionId: string;
  directory: string;
  items: Array<ReturnType<typeof publicQueueItem>>;
  sendingId: string | null;
}

/** Pure derivation so tests can pin the pid-suffixed atomic name (§D.2). */
export function queueTempPath(path: string, stamp: number): string {
  return `${path}.tmp-${process.pid}-${stamp}`;
}

function readQueueDoc(filePath: string): LoadedQueueDoc {
  let bytes;
  try {
    bytes = readFileSync(filePath, 'utf8');
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'ENOENT') return { kind: 'missing' };
    void error;
    return { kind: 'hardFailure' };
  }
  let doc;
  try {
    doc = JSON.parse(bytes) as PersistedQueueFile;
  } catch {
    return { kind: 'malformed' };
  }
  if (!doc || typeof doc !== 'object' || doc.version !== 1) return { kind: 'malformed' };
  if (typeof doc.revision !== 'number' || !Number.isFinite(doc.revision) || doc.revision < 0) return { kind: 'malformed' };
  if (!doc.sessions || typeof doc.sessions !== 'object' || Array.isArray(doc.sessions)) return { kind: 'malformed' };
  return { kind: 'loaded', doc };
}

type LoadedQueueDoc = { kind: 'missing' } | { kind: 'malformed' } | { kind: 'hardFailure' } | { kind: 'loaded'; doc: PersistedQueueFile };

export class MessageQueueStore {
  private readonly filePath: string;
  private sessions = new Map<string, QueueSessionEntry>();
  private revision = 0;
  private writesDisabled = false;
  private writeChain: Promise<void> = Promise.resolve();
  private stampCounter = 0;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  get file(): string {
    return this.filePath;
  }

  get currentRevision(): number {
    return this.revision;
  }

  get writesEnabled(): boolean {
    return !this.writesDisabled;
  }

  /** Boot authority (§D.2): full replace; hard read failure disables writes. */
  load(): 'loaded' | 'missing' | 'quarantined' | 'disabled' {
    const read = readQueueDoc(this.filePath);
    if (read.kind === 'hardFailure') {
      this.writesDisabled = true;
      return 'disabled';
    }
    if (read.kind === 'malformed') {
      this.quarantineCorruptFile();
      this.sessions = new Map();
      this.revision = 0;
      return 'quarantined';
    }
    this.writesDisabled = false;
    if (read.kind === 'missing') {
      this.sessions = new Map();
      this.revision = 0;
      return 'missing';
    }
    const loaded = new Map<string, QueueSessionEntry>();
    for (const [sessionId, persisted] of Object.entries(read.doc.sessions)) {
      if (!persisted || typeof persisted !== 'object') continue;
      loaded.set(sessionId, { directory: persisted.directory, items: persisted.items });
    }
    this.sessions = loaded;
    this.revision = read.doc.revision;
    return 'loaded';
  }

  /** Refresh persisted authority while retaining process-local directory
   * memory for queues that were emptied by this store (E-09-6). */
  refreshPreservingEmpty(): 'loaded' | 'missing' | 'quarantined' | 'disabled' {
    const empty = [...this.sessions.entries()].filter(([, entry]) => entry.items.length === 0);
    const result = this.load();
    for (const [sessionId, entry] of empty) {
      if (!this.sessions.has(sessionId)) this.sessions.set(sessionId, entry);
    }
    return result;
  }

  /** Post-failure recovery probe (§D.2): a successful read re-enables
   *  writes and NEVER reverts the in-memory queue (the in-memory state
   *  stayed owner while writes were disabled; registered §D.31). */
  recoverWrites(): boolean {
    if (!this.writesDisabled) return true;
    const read = readQueueDoc(this.filePath);
    if (read.kind === 'hardFailure') return false;
    if (read.kind === 'malformed') {
      this.quarantineCorruptFile();
      this.writesDisabled = false;
      return true;
    }
    this.writesDisabled = false;
    this.writeChain = this.writeChain.then(() => this.writeNow()).catch(() => undefined);
    return true;
  }

  /** Await the serialized write chain (tests and shutdown flushes). */
  async flushWrites(): Promise<void> {
    await this.writeChain.catch(() => undefined);
  }

  /** Malformed file renamed aside FIRST, then the runtime starts empty —
   *  the next write cannot overwrite the user's data (§D.2). */
  protected quarantineCorruptFile(): void {
    if (!existsSync(this.filePath)) return;
    try {
      renameSync(this.filePath, `${this.filePath}.corrupt-${Date.now()}`);
    } catch {
      /* quarantine is best-effort; the empty boot proceeds */
    }
  }

  private scheduleWrite(): void {
    if (this.writesDisabled) return;
    this.stampCounter += 1;
    this.writeChain = this.writeChain.then(() => this.writeNow()).catch(() => undefined);
  }

  private writeNow(): void {
    const doc: PersistedQueueFile = { version: 1, revision: this.revision, sessions: {} };
    for (const [sessionId, entry] of this.sessions) {
      if (entry.items.length === 0) continue; // emptied queues stay memory-only (§D.2)
      doc.sessions[sessionId] = { directory: entry.directory, items: entry.items };
    }
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = queueTempPath(this.filePath, Date.now() + this.stampCounter);
    writeFileSync(tmp, JSON.stringify(doc), { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, this.filePath);
  }

  /** Revision bump + scheduled persist; mutations call this exactly once. */
  commit(): number {
    this.revision += 1;
    this.scheduleWrite();
    return this.revision;
  }

  entryOf(sessionId: string): QueueSessionEntry | null {
    return this.sessions.get(sessionId) ?? null;
  }

  /** F9 idempotent-enqueue lookup: the stored item with this id, if any.
   *  The runtime compares payloads against it before appending, so a retried
   *  enqueue after a lost acknowledgement never duplicates the queue. */
  findItem(sessionId: string, itemId: string): QueueItem | null {
    return this.sessions.get(sessionId)?.items.find((item) => item.id === itemId) ?? null;
  }

  directoryOf(sessionId: string): string | null {
    return this.sessions.get(sessionId)?.directory ?? null;
  }

  nonEmptyEntries(): Array<{ sessionId: string; entry: QueueSessionEntry }> {
    const out = new Array<{ sessionId: string; entry: QueueSessionEntry }>();
    for (const [sessionId, entry] of this.sessions) {
      if (entry.items.length > 0) out.push({ sessionId, entry });
    }
    return out;
  }

  /** Insertion-stable order (§D.5) with public projections only. */
  snapshot(sendingId: (sessionId: string) => string | null): Array<QueueSessionSnapshot> {
    return this.nonEmptyEntries().map(({ sessionId, entry }) => ({
      sessionId,
      directory: entry.directory,
      items: entry.items.map((item) => publicQueueItem(item)),
      sendingId: sendingId(sessionId),
    }));
  }

  private evictOldestSessions(inFlightId: (sessionId: string) => string | null, protect: string): void {
    while (this.sessions.size > QUEUE_MAX_SESSIONS) {
      const candidates = [...this.sessions.entries()]
        .filter(([sessionId]) => sessionId !== protect && inFlightId(sessionId) === null)
        // memory-only entries evict first (nothing persisted to lose), then
        // oldest first-item createdAt wins (§D.2)
        .sort((a, b) => (a[1].items[0]?.createdAt ?? -1) - (b[1].items[0]?.createdAt ?? -1));
      const victim = candidates[0];
      if (!victim) return;
      this.sessions.delete(victim[0]);
    }
  }

  /** §D.2 enqueue limits: 20 items/session (newest kept, in-flight pinned),
   *  50 sessions (oldest-first, never one with an in-flight item). */
  enqueue(sessionId: string, directory: string, item: QueueItem, inFlightId: (sessionId: string) => string | null): number {
    const entry = this.sessions.get(sessionId) ?? { directory, items: new Array<QueueItem>() };
    entry.directory = directory;
    entry.items.push(item);
    let head = 0;
    while (entry.items.length > QUEUE_MAX_ITEMS_PER_SESSION) {
      if (head < entry.items.length && entry.items[head]!.id !== inFlightId(sessionId)) {
        entry.items.splice(head, 1);
        continue;
      }
      head += 1; // skip the pinned in-flight item, keep removing after it
    }
    this.sessions.set(sessionId, entry);
    this.evictOldestSessions(inFlightId, sessionId);
    return this.commit();
  }

  removeItem(sessionId: string, itemId: string): QueueItem | null {
    const entry = this.sessions.get(sessionId);
    if (!entry) return null;
    const index = entry.items.findIndex((item) => item.id === itemId);
    if (index < 0) return null;
    const [removed] = entry.items.splice(index, 1);
    return removed ?? null;
  }

  /** §D.5 take-all: every item NOT in flight, in order; the in-flight item
   *  stays (its send must still find its entry). */
  takeAllExcept(sessionId: string, keepId: string | null): QueueItem[] {
    const entry = this.sessions.get(sessionId);
    if (!entry) return [];
    const taken = entry.items.filter((item) => item.id !== keepId);
    entry.items = keepId === null ? [] : entry.items.filter((item) => item.id === keepId);
    return taken;
  }

  /** §D.2 ordering mutator: `itemIds` must hold every current id exactly once. */
  reorder(sessionId: string, itemIds: string[], pinnedHeadId: string | null = null): 'applied' | 'incomplete' | 'missing' | 'inFlight' {
    const entry = this.sessions.get(sessionId);
    if (!entry) return 'missing';
    if (itemIds.length !== entry.items.length) return 'incomplete';
    const seen = new Set(itemIds);
    if (seen.size !== itemIds.length) return 'incomplete';
    for (const id of itemIds) if (!entry.items.some((item) => item.id === id)) return 'incomplete';
    if (pinnedHeadId !== null && itemIds[0] !== pinnedHeadId) return 'inFlight';
    const byId = new Map(entry.items.map((item) => [item.id, item]));
    entry.items = itemIds.map((id) => byId.get(id)).map((item) => item!) as QueueItem[];
    return 'applied';
  }

  dropSession(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  forgetDirectoryMemory(sessionId: string): void {
    if (this.sessions.get(sessionId)?.items.length === 0) this.sessions.delete(sessionId);
  }
}
