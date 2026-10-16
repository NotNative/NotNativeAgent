// SPDX-License-Identifier: Apache-2.0
/**
 * Settings persistence engine (doc 14 §F.3): cached GET (2 s TTL + in-flight
 * dedupe riding runtimeFetch's HP-6), debounced PUT (200 ms; model prefs get
 * their own slower cadence from their owner store later), lifecycle flushes
 * with keepalive (pagehide/beforeunload/hidden/freeze/endpoint switch), echo
 * suppression vs the server-known map, pending-mutation overlays, browser
 * mirror with a 5-runtime index, one-per-runtime device seeding, and the
 * `notnative:settings-synced` apply event (`bootstrap`/`adoptTheme` grades).
 */
import { runtimeFetch } from '../runtime-fetch.ts';
import { isDesktopShell, isVSCodeRuntime } from '../platform.ts';
import { resolveHostedSurface } from '../runtimeSurface.ts';
import { getRuntimeKey, isTransientRuntimeKey, onRuntimeEndpointChanged } from '../runtime-switch.ts';
import { parseSettingsDocument, SURFACE_ECHO_KEY } from './parse.ts';
import { getSettingsField, SETTINGS_REGISTRY } from './registry.ts';
import type { SettingsField, SurfaceKind } from './registry.ts';
import { reportSettingsSaveState, setSettingsSaveState } from './save-state.ts';

export const SETTINGS_CACHE_TTL = 2_000;
export const SETTINGS_DEBOUNCE_MS = 200;
export const MODEL_PREFS_DEBOUNCE_MS = 1_200;
const MIRROR_PREFIX = 'notnative.settingsMirror.v2:';
const MIRROR_INDEX_KEY = 'notnative.settingsMirror.v2.index';
const MIRROR_CAP = 5;
const DEVICE_SEED_PREFIX = 'notnative.deviceSeeded.v1:';
export const SETTINGS_SYNCED_EVENT = 'notnative:settings-synced';
const WILL_CHANGE_EVENT = 'notnative:runtime-endpoint-will-change';

export interface SettingsSyncDetail {
  settings: Record<string, unknown>;
  bootstrap: boolean;
  adoptTheme: boolean;
}

type SyncListener = (detail: SettingsSyncDetail) => void;
const syncedListeners = new Set<SyncListener>();

let cacheDoc: Record<string, unknown> | null = null;
let cacheAt = 0;
let inflightGet: Promise<Record<string, unknown> | null> | null = null;
let inflightPut: Promise<boolean> | null = null;
const pending = new Map<string, unknown>();
const serverKnown = new Map<string, unknown>();
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let lifecycleInstalled = false;
let applying = 0;

export function currentSurfaceKind(): SurfaceKind {
  if (isVSCodeRuntime()) return 'vscode';
  if (isDesktopShell()) return 'desktop';
  return resolveHostedSurface() === 'mobile' ? 'mobile' : 'web';
}

/** §F.2 write rule: computed/local/device/owner/derived never sent; secrets
 * ARE sent (accepted-on-write server-side) but never mirrored. */
function writableField(field: SettingsField): boolean {
  return (
    field.computed !== true &&
    field.scope !== 'device' &&
    field.local !== true &&
    field.owner === undefined &&
    field.derived !== true
  );
}

const mirroredField = (field: SettingsField): boolean => writableField(field) && field.secret !== true;

const equalsKnown = (key: string, value: unknown): boolean => {
  const known = serverKnown.get(key);
  if (known === undefined) return false;
  return JSON.stringify(known) === JSON.stringify(value);
};

/** Cached GET; null = load failure, NEVER an empty document (§F.3). */
export function fetchSettingsDocument(
  kind: SurfaceKind = currentSurfaceKind(),
  force = false,
): Promise<Record<string, unknown> | null> {
  if (!force && cacheDoc && Date.now() - cacheAt < SETTINGS_CACHE_TTL) return Promise.resolve(cacheDoc);
  if (!inflightGet) {
    inflightGet = runtimeFetch(`/api/config/settings?surface=${kind}`)
      .then(async (response) => {
        if (!response.ok) return null;
        const raw = (await response.json()) as Record<string, unknown>;
        // §F.3 mutations-in-flight reconciliation: racing local edits overlay
        // the server response so a fetch can never briefly revert them.
        const parsed = parseSettingsDocument(raw, { skipKeys: new Set([SURFACE_ECHO_KEY]) });
        const merged = { ...parsed, ...pendingSettingsSnapshot() };
        cacheDoc = merged;
        cacheAt = Date.now();
        return merged;
      })
      .catch(() => null)
      .finally(() => {
        inflightGet = null;
      });
  }
  return inflightGet;
}

export async function loadDesktopSettings(): Promise<Record<string, unknown> | null> {
  return fetchSettingsDocument(currentSurfaceKind(), false);
}

/** Bootstrap-grade apply path; emits the synced event for adopters. */
export async function startSettingsSync(grade: { bootstrap: boolean; adoptTheme: boolean }): Promise<Record<string, unknown> | null> {
  const doc = await fetchSettingsDocument(currentSurfaceKind(), true);
  if (doc === null) return null;
  applyServerDocument(doc, grade);
  return doc;
}

export function onSettingsSynced(listener: SyncListener): () => void {
  syncedListeners.add(listener);
  return () => syncedListeners.delete(listener);
}

export function adoptNativePreferences(settings: Record<string, unknown>): void {
  emitSynced(settings, true, true);
}

function emitSynced(settings: Record<string, unknown>, bootstrap: boolean, adoptTheme: boolean): void {
  const detail: SettingsSyncDetail = { settings, bootstrap, adoptTheme };
  for (const listener of syncedListeners) listener(detail);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(SETTINGS_SYNCED_EVENT, { detail }));
  }
}

function applyServerDocument(doc: Record<string, unknown>, grade: { bootstrap: boolean; adoptTheme: boolean }): void {
  applying += 1;
  try {
    for (const [key, value] of Object.entries(doc)) serverKnown.set(key, value);
    seedDeviceKeys(doc);
    writeSettingsMirror(doc);
    emitSynced(doc, grade.bootstrap, grade.adoptTheme);
  } finally {
    applying = Math.max(0, applying - 1);
  }
}

export function isApplyingServerSettings(): boolean {
  return applying > 0;
}

/**
 * §F.3 PUT pipeline: drop non-writables, drop echo-equals-known, merge into
 * the pending buffer, schedule the debounce. Returns false when nothing
 * remained after filtering.
 */
export function updateDesktopSettings(changes: Record<string, unknown>): boolean {
  installLifecycleFlushes();
  let accepted = 0;
  for (const [key, value] of Object.entries(changes)) {
    const field = getSettingsField(key);
    if (!field || !writableField(field)) continue;
    const parsed = field.parse(value);
    if (parsed === null) continue; // client sanitizer: invalid == absent (§F.1)
    if (equalsKnown(key, parsed)) {
      pending.delete(key); // toggling back cancels the pending write
      continue;
    }
    pending.set(key, parsed);
    accepted += 1;
  }
  if (accepted > 0) setSettingsSaveState('saving');
  scheduleFlush();
  return accepted > 0;
}

function scheduleFlush(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void flushPendingSettings();
  }, SETTINGS_DEBOUNCE_MS);
}

/** Immediate keepalive PUT of the pending buffer (also lifecycle-bound).
 * Serialized: an overlapping flush first awaits the in-flight one so the
 * newer edit flushes afterwards (no lost updates, no stale known writes). */
export async function flushPendingSettings(): Promise<boolean> {
  if (inflightPut) await inflightPut.catch(() => null);
  if (pending.size === 0) return true;
  const flushKeys = [...pending.keys()];
  const kind = currentSurfaceKind();
  const body: Record<string, unknown> = {};
  for (const key of flushKeys) body[key] = pending.get(key);
  setSettingsSaveState('saving');
  const task = (async (): Promise<boolean> => {
    try {
      const response = await runtimeFetch(`/api/config/settings?surface=${kind}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        keepalive: true,
      });
      if (!response.ok) {
        reportSettingsSaveState('error');
        return false;
      }
      const raw = (await response.json()) as { settings?: Record<string, unknown> };
      const applied = parseSettingsDocument(raw.settings ?? {}, { skipKeys: new Set([SURFACE_ECHO_KEY]) });
      for (const key of flushKeys) {
        if (key in applied) serverKnown.set(key, applied[key]);
        if (cacheDoc) cacheDoc[key] = key in applied ? applied[key] : body[key];
      }
      // Only the keys THIS flush carried leave the buffer — edits made during
      // the PUT (rebased debounce) stay pending for the next flush.
      for (const key of flushKeys) {
        if (JSON.stringify(pending.get(key)) === JSON.stringify(body[key])) pending.delete(key);
      }
      cacheAt = Date.now();
      setSettingsSaveState('idle');
      return true;
    } catch {
      reportSettingsSaveState('error');
      return false;
    }
  })();
  inflightPut = task;
  try {
    return await task;
  } finally {
    if (inflightPut === task) inflightPut = null;
  }
}

/** §F.3 lifecycle flush: crashed windows lose at most the in-flight request.
 * The endpoint FLUSH rides will-change so edits land on the OLD instance;
 * on `changed` the per-instance state resets (fresh doc, no cross-instance
 * echo suppression). */
function installLifecycleFlushes(): void {
  if (lifecycleInstalled || typeof window === 'undefined') return;
  lifecycleInstalled = true;
  const flush = (): void => {
    if (pending.size > 0) void flushPendingSettings();
  };
  window.addEventListener('pagehide', flush);
  window.addEventListener('beforeunload', flush);
  document.addEventListener('freeze', flush);
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
  window.addEventListener(WILL_CHANGE_EVENT, flush);
  onRuntimeEndpointChanged(() => {
    serverKnown.clear();
    cacheDoc = null;
    cacheAt = 0;
    pending.clear();
  });
}

/** Mirror (§F.3): registered doc minus secret/computed/local/owner/derived;
 * indexed at the 5 most recent runtime keys with eviction. */
function writeSettingsMirror(doc: Record<string, unknown>): void {
  if (typeof window === 'undefined') return;
  const runtimeKey = runtimeKeyForStorage();
  if (!runtimeKey) return;
  const mirror = buildMirror(doc);
  if (Object.keys(mirror).length === 0) return;
  try {
    window.localStorage.setItem(`${MIRROR_PREFIX}${encodeURIComponent(runtimeKey)}`, JSON.stringify(mirror));
    maintainMirrorIndex(runtimeKey);
  } catch { /* mirror best-effort only */ }
}

function buildMirror(doc: Record<string, unknown>): Record<string, unknown> {
  const mirror: Record<string, unknown> = {};
  for (const field of SETTINGS_REGISTRY) {
    if (!mirroredField(field)) continue;
    if (!(field.key in doc)) continue;
    mirror[field.key] = doc[field.key];
  }
  return mirror;
}

function maintainMirrorIndex(runtimeKey: string): void {
  const index: string[] = JSON.parse(window.localStorage.getItem(MIRROR_INDEX_KEY) ?? '[]');
  const next = index.filter((key) => key !== runtimeKey);
  next.push(runtimeKey);
  while (next.length > MIRROR_CAP) {
    const evicted = next.shift();
    if (evicted) window.localStorage.removeItem(`${MIRROR_PREFIX}${encodeURIComponent(evicted)}`);
  }
  window.localStorage.setItem(MIRROR_INDEX_KEY, JSON.stringify(next));
}

function runtimeKeyForStorage(): string | null {
  const stamped = window.__NOTNATIVE_RUNTIME_KEY__;
  if (typeof stamped === 'string' && !isTransientRuntimeKey(stamped)) return stamped; // shell-stamped override
  const key = getRuntimeKey();
  return isTransientRuntimeKey(key) ? null : key;
}

/** Device keys from an OLD server document seed once per runtime (§F.3). */
function seedDeviceKeys(doc: Record<string, unknown>): void {
  if (typeof window === 'undefined') return;
  const runtimeKey = runtimeKeyForStorage();
  if (!runtimeKey) return;
  try {
    const marker = `${DEVICE_SEED_PREFIX}${encodeURIComponent(runtimeKey)}`;
    if (window.localStorage.getItem(marker)) return;
    const present = SETTINGS_REGISTRY.some(
      (field) => field.scope === 'device' && field.local !== true && field.key in doc,
    );
    if (present) window.localStorage.setItem(marker, new Date().toISOString());
  } catch { /* seeding marker best-effort */ }
}

/** Read-only view for adopters/tests: what the next flush would send. */
export function pendingSettingsSnapshot(): Record<string, unknown> {
  return Object.fromEntries(pending.entries());
}

/** Test isolation: module-level engine state resets between its blocks. */
export function __resetEngineForTests(): void {
  cacheDoc = null;
  cacheAt = 0;
  inflightGet = null;
  inflightPut = null;
  pending.clear();
  serverKnown.clear();
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = null;
  lifecycleInstalled = false;
  applying = 0;
}
