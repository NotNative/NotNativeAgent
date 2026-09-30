// SPDX-License-Identifier: Apache-2.0
/** Bounded durable walkthrough results addressed by their capture and model identity. */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const CACHE_VERSION = 1;
const CACHE_LIMIT = 64;
const FILE_LIMIT = 8 * 1024 * 1024;
const ID_PATTERN = /^[A-Za-z0-9_.:\\/-]{1,256}$/u;
const TEXT_PATTERN = /^[^\r\n\t\0]{1,1000}$/u;
const TITLE_PATTERN = /^[^\r\n\t\0]{1,120}$/u;

export type CachedChapter = { id: string; explanation: string };
export type CachedWalkthrough = {
  revision: string;
  chapters: { title: string; stops: CachedChapter[] }[];
  omittedSensitiveHunks: number;
  providerID: string;
  modelID: string;
};
type CacheDocument = { version: 1; entries: Record<string, CachedWalkthrough & { savedAt: number }> };

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

export function validCachedWalkthrough(value: unknown): CachedWalkthrough | null {
  const record = objectOf(value);
  if (record === null || !/^[0-9a-f]{40}$|^[0-9a-f]{64}$/u.test(boundIdentity(record.revision, 128))
    || integerAtLeast(record.omittedSensitiveHunks, 0) === null
    || !TEXT_PATTERN.test(boundIdentity(record.providerID, 512))
    || !TEXT_PATTERN.test(boundIdentity(record.modelID, 1024))) return null;
  if (!Array.isArray(record.chapters) || record.chapters.length === 0 || record.chapters.length > 12) return null;
  const chapters: CachedWalkthrough['chapters'] = [];
  for (const rawChapter of record.chapters) {
    const chapter = objectOf(rawChapter);
    const title = boundIdentity(chapter?.title, 128);
    if (!TITLE_PATTERN.test(title) || !Array.isArray(chapter!.stops)) return null;
    const stops: CachedChapter[] = [];
    for (const rawStop of chapter!.stops.slice(0, 200)) {
      const stop = objectOf(rawStop);
      if (stop === null || !ID_PATTERN.test(boundIdentity(stop.id, 128))
        || !TEXT_PATTERN.test(boundIdentity(stop.explanation, 1024))) return null;
      stops.push({ id: boundIdentity(stop.id, 128), explanation: boundIdentity(stop.explanation, 1024) });
    }
    if (stops.length === 0) return null;
    chapters.push({ title, stops });
  }
  const omitted = integerAtLeast(record.omittedSensitiveHunks, 0);
  if (omitted === null) return null;
  return {
    revision: boundIdentity(record.revision, 128),
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
