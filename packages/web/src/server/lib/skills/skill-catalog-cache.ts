// SPDX-License-Identifier: Apache-2.0
/** Persistent cache for successful configured catalog scans. */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ENV } from '../../env.ts';
import { scanLocalSkills } from './skill-scan.ts';
import { scanCatalogSource, type CatalogScanItem, type CatalogScanRequest } from './skill-catalog-scan.ts';

const CACHE_FILE = 'skills-catalog-cache.json';
const TTL_MS = 3 * 60 * 60 * 1000;
const SOURCE_LIMIT = 64;
const MAX_ITEMS = 200;
const MAX_CONCURRENCY = 2;

type CacheItem = Omit<CatalogScanItem, 'installed'>;
type CacheEntry = { updatedAt: string; items: CacheItem[] };
type CacheDocument = { version: 1; entries: Record<string, CacheEntry> };

const memory = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<CatalogScanItem[]>>();
let activeScans = 0;
const waiters: Array<() => void> = [];
let saveTimer: ReturnType<typeof setTimeout> | undefined;

function isText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length <= maxLength && !/\p{Control}/u.test(value);
}

function normalizedRepository(source: string): string {
  if (/^(?:[A-Za-z]:)?[\\/]/u.test(source)) {
    try { return realpathSync(source); } catch { return source; }
  }
  if (/^[a-z0-9][a-z0-9-]{0,98}[a-z0-9]?\/[a-z0-9._-]{1,199}(?:\.git)?$/iu.test(source)) {
    return source.replace(/\.git$/iu, '')
      .replace(/\/+$/u, '')
      .toLowerCase();
  }
  try {
    const url = new URL(source);
    const repository = `${decodeURIComponent(url.pathname).replace(/\/+$/u, '')}`
      .replace(/\.git$/iu, '');
    return `${url.protocol}//${url.hostname.toLowerCase()}/${repository}`;
  } catch { return source; }
}

function cacheKey(request: CatalogScanRequest): string | null {
  const repository = normalizedRepository(request.source);
  if (repository === '') return null;
  const identity = request.gitIdentityId === undefined || request.gitIdentityId === null ? '' : request.gitIdentityId;
  const key = [repository, request.subpath ?? '', identity].join('\n');
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

function validItems(value: unknown): CacheItem[] | null {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) return null;
  const output: CacheItem[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const item = raw as Partial<CacheItem>;
    if (!isText(item.repoSource, 512) || item.repoSubpath !== null && !isText(item.repoSubpath, 256)
      || !isText(item.skillDir, 512) || !isText(item.skillName, 256)
      || !isText(item.frontmatterName, 120) || !isText(item.description, 500)
      || typeof item.installable !== 'boolean' || !Array.isArray(item.warnings)
      || item.warnings.some((warning) => !isText(warning, 120))) return null;
    output.push({
      repoSource: item.repoSource!, repoSubpath: item.repoSubpath ?? null,
      skillDir: item.skillDir!, skillName: item.skillName!,
      frontmatterName: item.frontmatterName!, description: item.description!,
      installable: item.installable, warnings: item.warnings,
    });
  }
  return output;
}

function entryValid(value: unknown): value is CacheEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<CacheEntry>;
  return typeof entry.updatedAt === 'string' && !Number.isNaN(Date.parse(entry.updatedAt)) && entry.items !== undefined;
}

function cachedItem(item: CacheItem, directory: string | undefined): CatalogScanItem {
  let installedSkills: ReturnType<typeof scanLocalSkills> = [];
  if (directory) {
    try { installedSkills = scanLocalSkills(directory); } catch { installedSkills = []; }
  }
  const installed = installedSkills.find((skill) => skill.name === item.skillName);
  return {
    ...item,
    installed: !installed
      ? { isInstalled: false, scope: null, source: null }
      : { isInstalled: true, scope: installed.scope, source: installed.source },
  };
}

function readPersisted(key: string): CacheEntry | null {
  let document: unknown;
  try {
    document = JSON.parse(readFileSync(join(ENV.dataDir, CACHE_FILE), 'utf8'));
  } catch { return null; }
  if (!document || typeof document !== 'object' || Array.isArray(document)) return null;
  const entries = (document as { entries?: unknown }).entries;
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) return null;
  const entry = (entries as Record<string, unknown>)[key];
  if (!entryValid(entry)) return null;
  const items = validItems(entry.items);
  if (!items) return null;
  if (Date.now() - Date.parse(entry.updatedAt) >= TTL_MS) return null;
  return { updatedAt: entry.updatedAt, items };
}

function writeDocument(): void {
  const entries = [...memory.entries()]
    .sort(([, left], [, right]) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
    .slice(0, SOURCE_LIMIT);
  memory.clear();
  for (const [key, entry] of entries) memory.set(key, entry);
  const document: CacheDocument = {
    version: 1,
    entries: Object.fromEntries(memory.entries()),
  };
  mkdirSync(ENV.dataDir, { recursive: true });
  const path = join(ENV.dataDir, CACHE_FILE);
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

function scheduleSave(): void {
  if (saveTimer !== undefined) return;
  saveTimer = setTimeout(() => {
    saveTimer = undefined;
    try { writeDocument(); } catch { /* cache writes must not fail scans */ }
  }, 250);
  saveTimer.unref?.();
}

async function scanWithLimit(task: () => Promise<CatalogScanItem[]>): Promise<CatalogScanItem[]> {
  if (activeScans >= MAX_CONCURRENCY) {
    await new Promise<void>((resolve) => waiters.push(resolve));
  }
  activeScans += 1;
  try { return await task(); }
  finally {
    activeScans -= 1;
    waiters.shift()?.();
  }
}

export async function scanCatalogSourceCached(request: CatalogScanRequest,
  refresh: boolean): Promise<CatalogScanItem[]> {
  const key = cacheKey(request);
  if (!refresh && key) {
    const entry = memory.get(key) ?? readPersisted(key);
    if (entry) {
      memory.set(key, entry);
      return entry.items.map((item) => cachedItem(item, request.directory));
    }
  }
  if (key === null) return scanWithLimit(() => scanCatalogSource(request));
  const running = inFlight.get(key);
  if (running) return running.then((items) => items.map((item) => cachedItem(item, request.directory)));
  const promise = scanWithLimit(async () => {
    const scanned = await scanCatalogSource(request);
    memory.set(key, {
      updatedAt: new Date().toISOString(),
      items: scanned.map(({ installed: _installed, ...item }) => item),
    });
    scheduleSave();
    return scanned;
  }).finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}

export async function flushCatalogScanCache(): Promise<void> {
  if (saveTimer === undefined) return;
  clearTimeout(saveTimer);
  saveTimer = undefined;
  try { writeDocument(); } catch { /* leave a scan success intact */ }
}

export function resetCatalogScanCache(): void {
  if (saveTimer !== undefined) {
    clearTimeout(saveTimer);
    saveTimer = undefined;
  }
  try { rmSync(join(ENV.dataDir, CACHE_FILE), { force: true }); } catch { /* tests own isolation */ }
  memory.clear();
  inFlight.clear();
}
