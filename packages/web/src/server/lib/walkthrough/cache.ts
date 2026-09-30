// SPDX-License-Identifier: Apache-2.0
/** Bounded durable walkthrough results addressed by their capture and model identity. */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const CACHE_VERSION = 3;
const CACHE_LIMIT = 64;
const FILE_LIMIT = 8 * 1024 * 1024;
const ID_PATTERN = /^[A-Za-z0-9_.:\\/-]{1,256}$/u;
const TEXT_PATTERN = /^[^\r\n\t\0]{1,1000}$/u;
// Model prose may contain legitimate paragraph breaks or tabs. Keep other
// controls out while accepting the same narrative text as generation.
const NARRATIVE_PATTERN = /^[^\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]{1,1000}$/u;
const SUMMARY_NARRATIVE_PATTERN = /^[^\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]{1,600}$/u;
const SCOPE_PATTERN = /^(?:staged|working)$/u;
const PATH_PATTERN = /^[^\r\n\0]{1,4096}$/u;
const TITLE_PATTERN = /^[^\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]{1,120}$/u;
const ICON_PATTERN = /^(?:bug|wrench|path|flask|doc|gear)$/u;
const IMPORTANCE_PATTERN = /^(?:critical|normal|context)$/u;

export type CachedHunk = { id: string; scope: 'staged' | 'working'; path: string; oldPath?: string; oldStart: number; newStart: number };
export type CachedStop = { id: string; title: string; importance: 'critical' | 'normal' | 'context'; prose: string; hunks: CachedHunk[] };
export type CachedChapter = { id: string; title: string; icon: 'bug' | 'wrench' | 'path' | 'flask' | 'doc' | 'gear'; blurb: string; stops: CachedStop[] };
export type CachedWalkthrough = {
  revision: string;
  title: string;
  focus: string;
  chapters: CachedChapter[];
  omittedSensitiveHunks: number;
  providerID: string;
  modelID: string;
};
type CacheDocument = { version: typeof CACHE_VERSION; entries: Record<string, CachedWalkthrough & { savedAt: number }> };

function objectOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function boundIdentity(value: unknown, limit: number): string {
  return typeof value === 'string' ? value.slice(0, limit).trim() : '';
}

function integerAtLeast(value: unknown, minimum: number): number | null {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= minimum ? value : null;
}

function cachedHunk(value: unknown, seen: Set<string>): CachedHunk | null {
  const hunk = objectOf(value);
  const id = boundIdentity(hunk?.id, 128);
  const scope = boundIdentity(hunk?.scope, 16);
  const path = boundIdentity(hunk?.path, 4096);
  const oldPath = hunk?.oldPath === undefined ? null : boundIdentity(hunk.oldPath, 4096);
  const oldStart = integerAtLeast(hunk?.oldStart, 0);
  const newStart = integerAtLeast(hunk?.newStart, 0);
  if (!ID_PATTERN.test(id) || !SCOPE_PATTERN.test(scope) || !PATH_PATTERN.test(path)
    || oldStart === null || newStart === null || oldPath !== null && !PATH_PATTERN.test(oldPath) || seen.has(id)) return null;
  seen.add(id);
  return { id, scope: scope as CachedHunk['scope'], path, oldStart, newStart, ...(oldPath ? { oldPath } : {}) };
}

function cachedStop(value: unknown, hunkIds: Set<string>, narrativeIds: Set<string>): CachedStop | null {
  const stop = objectOf(value);
  const id = boundIdentity(stop?.id, 128);
  const title = boundIdentity(stop?.title, 100);
  const importance = boundIdentity(stop?.importance, 16);
  const prose = boundIdentity(stop?.prose, 1000);
  if (!ID_PATTERN.test(id) || narrativeIds.has(id) || !TITLE_PATTERN.test(title)
    || !IMPORTANCE_PATTERN.test(importance) || !NARRATIVE_PATTERN.test(prose)
    || !Array.isArray(stop?.hunks) || stop.hunks.length === 0 || stop.hunks.length > 14) return null;
  const hunks = stop.hunks.map((hunk) => cachedHunk(hunk, hunkIds));
  if (hunks.some((hunk) => hunk === null)) return null;
  narrativeIds.add(id);
  return { id, title, importance: importance as CachedStop['importance'], prose, hunks: hunks as CachedHunk[] };
}

function cachedChapter(value: unknown, hunkIds: Set<string>, narrativeIds: Set<string>, maxStops: number): CachedChapter | null {
  const chapter = objectOf(value);
  const id = boundIdentity(chapter?.id, 128);
  const title = boundIdentity(chapter?.title, 24);
  const icon = boundIdentity(chapter?.icon, 16);
  const blurb = boundIdentity(chapter?.blurb, 600);
  if (!ID_PATTERN.test(id) || narrativeIds.has(id) || !TITLE_PATTERN.test(title) || !ICON_PATTERN.test(icon)
    || !SUMMARY_NARRATIVE_PATTERN.test(blurb) || !Array.isArray(chapter?.stops) || chapter.stops.length === 0
    || chapter.stops.length > maxStops) return null;
  narrativeIds.add(id);
  const stops = chapter.stops.map((stop) => cachedStop(stop, hunkIds, narrativeIds));
  if (stops.some((stop) => stop === null)) return null;
  return { id, title, icon: icon as CachedChapter['icon'], blurb, stops: stops as CachedStop[] };
}

export function validCachedWalkthrough(value: unknown): CachedWalkthrough | null {
  const record = objectOf(value);
  if (record === null || !/^[0-9a-f]{40}$|^[0-9a-f]{64}$/u.test(boundIdentity(record.revision, 128))
    || integerAtLeast(record.omittedSensitiveHunks, 0) === null
    || !TEXT_PATTERN.test(boundIdentity(record.providerID, 512))
    || !TEXT_PATTERN.test(boundIdentity(record.modelID, 1024))) return null;
  const title = boundIdentity(record.title, 80);
  const focus = boundIdentity(record.focus, 500);
  if (!NARRATIVE_PATTERN.test(title) || !SUMMARY_NARRATIVE_PATTERN.test(focus)
    || !Array.isArray(record.chapters) || record.chapters.length === 0 || record.chapters.length > 6) return null;
  const chapters: CachedChapter[] = [];
  const hunkIds = new Set<string>();
  const narrativeIds = new Set<string>();
  let stopCount = 0;
  for (const rawChapter of record.chapters) {
    const chapter = cachedChapter(rawChapter, hunkIds, narrativeIds, 16 - stopCount);
    if (chapter === null) return null;
    stopCount += chapter.stops.length;
    chapters.push(chapter);
  }
  const omitted = integerAtLeast(record.omittedSensitiveHunks, 0);
  if (omitted === null) return null;
  return {
    revision: boundIdentity(record.revision, 128),
    title,
    focus,
    chapters,
    omittedSensitiveHunks: omitted,
    providerID: boundIdentity(record.providerID, 512),
    modelID: boundIdentity(record.modelID, 1024),
  };
}

function loadDocument(filePath: string): CacheDocument | null {
  if (!existsSync(filePath)) return null;
  try {
    const parsed = objectOf(JSON.parse(readFileSync(filePath, 'utf8')));
    if (parsed?.version !== CACHE_VERSION || !objectOf(parsed.entries)) return null;
    const entries: CacheDocument['entries'] = {};
    for (const [key, value] of Object.entries(parsed.entries as Record<string, unknown>)) {
      const entry = validCachedWalkthrough(value);
      const savedAt = objectOf(value)?.savedAt;
      if (ID_PATTERN.test(key) && entry !== null && typeof savedAt === 'number'
        && Number.isInteger(savedAt) && savedAt >= 0) {
        entries[key] = { ...entry, savedAt };
      }
    }
    return { version: CACHE_VERSION, entries };
  } catch {
    return null;
  }
}

export class WalkthroughCache {
  private filePath: string;
  private document: CacheDocument | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  private stamp = 0;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  get size(): number {
    this.ensure();
    return Object.keys(this.document!.entries).length;
  }

  get(key: string): CachedWalkthrough | null {
    if (!ID_PATTERN.test(key)) return null;
    this.ensure();
    const saved = this.document!.entries[key];
    if (saved === undefined) return null;
    if (typeof saved.savedAt !== 'number' || Date.now() - saved.savedAt > 30 * 24 * 60 * 60 * 1000) {
      delete this.document!.entries[key];
      this.persist();
      return null;
    }
    const entry = validCachedWalkthrough(saved);
    if (entry === null) {
      delete this.document!.entries[key];
      this.persist();
      return null;
    }
    return entry;
  }

  delete(key: string): void {
    if (!ID_PATTERN.test(key)) return;
    this.ensure();
    if (Object.hasOwn(this.document!.entries, key)) {
      delete this.document!.entries[key];
      this.persist();
    }
  }

  set(key: string, value: CachedWalkthrough): void {
    if (!ID_PATTERN.test(key)) throw new RangeError('Invalid walkthrough cache key');
    const entry = validCachedWalkthrough(value);
    if (entry === null) throw new TypeError('Invalid walkthrough cache entry');
    this.ensure();
    this.document!.entries[key] = { ...entry, savedAt: Date.now() };
    const sorted = Object.entries(this.document!.entries)
      .sort((left, right) => (right[1].savedAt ?? 0) - (left[1].savedAt ?? 0));
    let entries = Object.fromEntries(sorted.slice(0, CACHE_LIMIT));
    for (const [oldestKey] of sorted.reverse()) {
      if (Buffer.byteLength(JSON.stringify({ version: CACHE_VERSION, entries }), 'utf8') <= FILE_LIMIT) break;
      delete entries[oldestKey];
    }
    if (Buffer.byteLength(JSON.stringify({ version: CACHE_VERSION, entries }), 'utf8') > FILE_LIMIT) return;
    this.document!.entries = entries;
    this.persist();
  }

  async flush(): Promise<void> {
    await this.writeChain;
  }

  private ensure(): void {
    this.document ??= loadDocument(this.filePath) ?? { version: CACHE_VERSION, entries: {} };
    for (const [key, entry] of Object.entries(this.document.entries)) {
      if (!Number.isInteger(entry.savedAt) || Date.now() - entry.savedAt > 30 * 24 * 60 * 60 * 1000) delete this.document.entries[key];
    }
  }

  private persist(): void {
    if (this.document === null) return;
    const document = this.document;
    this.stamp += 1;
    this.writeChain = this.writeChain.then(() => {
      mkdirSync(dirname(this.filePath), { recursive: true });
      const temporary = `${this.filePath}.tmp-${process.pid}-${this.stamp}`;
      writeFileSync(temporary, JSON.stringify(document), { encoding: 'utf8', mode: 0o600 });
      renameSync(temporary, this.filePath);
    }).catch(() => undefined);
  }
}
