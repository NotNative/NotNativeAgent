// SPDX-License-Identifier: Apache-2.0
/**
 * Settings split store (doc 14 §F.3, server machinery): values live in
 * `preferences.json` (`{version:1, fields:{key:{value,updatedAt,surfaces?}}}`);
 * `settings.json` keeps the flat mirrored copy for rollback + legacy readers.
 * The server seeds preferences.json once from settings.json, never touches an
 * unparseable preferences.json, and writes are atomic tmp+rename (§5.14).
 */
import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync, statSync, linkSync, unlinkSync } from 'node:fs';
import { join as joinPath } from 'node:path';
import { ENV } from '../env.ts';
import { withConfigLock } from '../scheduled/config-lock.ts';
import {
  fieldPerSurface,
  fieldSurfaces,
  isComputedField,
  isRegisteredKey,
  isSecretField,
  isWritableField,
  registrySnapshot,
} from './settings-gate.ts';
import type { SurfaceKind } from './settings-gate.ts';

const PREFERENCES_FILE = joinPath(ENV.dataDir, 'preferences.json');
const SETTINGS_FILE = joinPath(ENV.dataDir, 'settings.json');

export interface StoredFieldValue {
  value: unknown;
  updatedAt: string;
  surfaces?: Record<string, { value: unknown; updatedAt: string }>;
}

export interface PreferenceDoc {
  version: 1;
  fields: Record<string, StoredFieldValue>;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

function preferenceDoc(): PreferenceDoc | null {
  // null = unparseable presence → the server never rewrites the file (§F.3).
  const raw = readJson(PREFERENCES_FILE);
  if (raw === undefined) return null;
  const doc = raw as PreferenceDoc | null;
  if (!doc || typeof doc !== 'object' || Array.isArray(doc) || doc.version !== 1) return null;
  if (!doc.fields || typeof doc.fields !== 'object') return null;
  return doc;
}

function writeAtomic(path: string, value: unknown): void {
  mkdirSync(joinPath(ENV.dataDir), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, path);
}

/** One-time seed: preferences.json from settings.json registered keys; a
 * boot WITHOUT legacy settings.json seeds an EMPTY registry-gated doc so
 * the normal gated write path owns the store from the very first write
 * (the corrupt-presence refusal is untouched — only a MISSING file seeds). */
export function seedPreferencesFromSettings(): void {
  if (existsSync(PREFERENCES_FILE)) return;
  const legacy = readJson(SETTINGS_FILE);
  const fields: Record<string, StoredFieldValue> = {};
  const now = new Date().toISOString();
  if (legacy && typeof legacy === 'object' && !Array.isArray(legacy)) {
    for (const [key, value] of Object.entries(legacy as Record<string, unknown>)) {
      if (!isRegisteredKey(key) || !isWritableField(key)) continue;
      fields[key] = { value, updatedAt: now };
    }
  }
  // Seeding can be triggered by a synchronous GET in a different process
  // from a locked writer. Publish with no-replace semantics: a plain atomic
  // rename here could overwrite the writer's just-patched document if both
  // observed the file as missing.
  mkdirSync(ENV.dataDir, { recursive: true });
  const tmp = `${PREFERENCES_FILE}.seed-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify({ version: 1, fields } satisfies PreferenceDoc, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    linkSync(tmp, PREFERENCES_FILE);
  } catch (error) {
    if ((error as { code?: string }).code !== 'EEXIST') throw error;
  } finally {
    try { unlinkSync(tmp); } catch { /* cleanup only */ }
  }
}

function surfaceEntry(field: StoredFieldValue, kind: SurfaceKind): unknown {
  return field.surfaces?.[kind] !== undefined ? field.surfaces[kind]!.value : field.value;
}

/** Server-side computed exports for this build/process (§F.2 flag). */
function computedValue(key: string, fields: Record<string, StoredFieldValue>): unknown {
  const password = fields['desktopUiPassword']?.value;
  const hasPassword = typeof password === 'string' && password.length > 0;
  switch (key) {
    case 'hasDesktopUiPassword': return hasPassword;
    case 'desktopLanAccessActive': return false;
    case 'desktopLanAccessBlockedReason': return '';
    default: return null;
  }
}

/**
 * Flat resolution for one surface kind: kind → surfaces[kind] → base →
 * absent ("missing is not default"). Secrets never returned; computed keys
 * emit their process-local values.
 */
export function readMergedSettings(kind: SurfaceKind, includeSurfaceEcho?: string): Record<string, unknown> {
  seedPreferencesFromSettings();
  const prefs = preferenceDoc();
  const fields = prefs?.fields ?? {};
  const merged: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(fields)) {
    if (!isRegisteredKey(key) || isSecretField(key) || isComputedField(key)) continue;
    const surfaces = fieldSurfaces(key);
    if (surfaces && !surfaces.includes(kind)) continue;
    merged[key] = surfaceEntry(field, kind);
  }
  for (const [key, snapshot] of Object.entries(registrySnapshot().fields)) {
    if (snapshot.computed !== true || !canShowOnSurface(key, kind)) continue;
    merged[key] = computedValue(key, fields);
  }
  if (includeSurfaceEcho) merged.surface = includeSurfaceEcho;
  return merged;
}

/** Flat mirror refresh: unknown legacy keys stay, base values sync; an
 * in-memory digest skips no-op rewrites (the fs churn rule, §5.14). */
let mirrorDigest = '';

function refreshSettingsMirror(fields: Record<string, StoredFieldValue>): void {
  const rawLegacy = readJson(SETTINGS_FILE);
  const kept: Record<string, unknown> =
    rawLegacy && typeof rawLegacy === 'object' && !Array.isArray(rawLegacy)
      ? { ...(rawLegacy as Record<string, unknown>) }
      : {};
  for (const [key, field] of Object.entries(fields)) {
    if (!isRegisteredKey(key) || isComputedField(key) || isSecretField(key)) continue;
    if (field.surfaces !== undefined) continue; // per-surface values do not reach the base
    kept[key] = field.value;
  }
  const digest = JSON.stringify(kept);
  if (digest === mirrorDigest) return;
  mirrorDigest = digest;
  writeAtomic(SETTINGS_FILE, kept);
}

export interface PatchOutcome {
  settings: Record<string, unknown>;
  kind: SurfaceKind;
  dropped: string[];
}

const writeListeners = new Set<(keys: readonly string[]) => void>();

/** Notify process-local runtimes after a durable, registry-gated patch. */
export function onSettingsWrite(listener: (keys: readonly string[]) => void): () => void {
  writeListeners.add(listener);
  return () => { writeListeners.delete(listener); };
}

function notifySettingsWrite(keys: readonly string[]): void {
  if (keys.length === 0) return;
  for (const listener of writeListeners) {
    try { listener(keys); } catch { /* a runtime observer cannot undo a persisted write */ }
  }
}

/** Registry-gated write: unknown/computed/local/device/owner keys dropped. */
export function writeSettingsPatch(patch: Record<string, unknown>, kind: SurfaceKind): PatchOutcome {
  seedPreferencesFromSettings();
  const prefs = preferenceDoc();
  if (!prefs) {
    // §F.3: never touch a corrupt preferences.json — the GATED patch still
    // lands in the legacy mirror path so no key bypasses the registry gate.
    const accepted: Record<string, unknown> = {};
    const dropped: string[] = [];
    for (const [key, value] of Object.entries(patch)) {
      if (!isWritableField(key) || !canShowOnSurface(key, kind) || fieldPerSurface(key)) {
        dropped.push(key); // per-surface values cannot ride the flat mirror
        continue;
      }
      accepted[key] = value;
    }
    const legacy = (readJson(SETTINGS_FILE) as Record<string, unknown> | undefined) ?? {};
    writeAtomic(SETTINGS_FILE, { ...legacy, ...accepted });
    notifySettingsWrite(Object.keys(accepted));
    return { settings: { ...readMergedSettings(kind), ...accepted }, kind, dropped };
  }
  const now = new Date().toISOString();
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (!isWritableField(key) || !canShowOnSurface(key, kind)) {
      dropped.push(key);
      continue;
    }
    const entry = prefs.fields[key] ?? { value: null, updatedAt: now };
    if (fieldPerSurface(key)) {
      // Kind value is NEVER written to the base (§F.2): surface-scoped only.
      entry.surfaces = { ...(entry.surfaces ?? {}), [kind]: { value, updatedAt: now } };
    } else {
      entry.value = value;
      entry.updatedAt = now;
    }
    prefs.fields[key] = entry;
  }
  writeAtomic(PREFERENCES_FILE, prefs);
  refreshSettingsMirror(prefs.fields);
  notifySettingsWrite(Object.keys(patch).filter((key) => !dropped.includes(key)));
  return { settings: readMergedSettings(kind), kind, dropped };
}

/** Cross-process read/modify/write boundary for HTTP settings mutations.
 * Each process rereads the canonical file only after acquiring the shared
 * lock, so concurrent desktop/server instances preserve unrelated fields. */
export function writeSettingsPatchLocked(patch: Record<string, unknown>, kind: SurfaceKind): Promise<PatchOutcome> {
  return withConfigLock(PREFERENCES_FILE, async () => writeSettingsPatch(patch, kind));
}

function canShowOnSurface(key: string, kind: SurfaceKind): boolean {
  const surfaces = fieldSurfaces(key);
  return !surfaces || surfaces.includes(kind);
}

/** Secret read for auth consumers (doc 08 password source via the settings
 * registry): nullish surface values degrade to the base value; the value
 * never travels to a response. */
export function readStoredSecretValue(key: string): string {
  seedPreferencesFromSettings();
  const prefs = preferenceDoc();
  if (!prefs) return '';
  const field = prefs.fields[key];
  if (!field) return '';
  const perSurface = fieldPerSurface(key);
  const kind = fieldSurfaces(key)?.[0] ?? 'desktop';
  const value = perSurface && field.surfaces !== undefined
    ? field.surfaces[kind]?.value
    : field.value;
  return typeof value === 'string' ? value : '';
}

/** Non-throwing stat helper for tests/diagnostics. */
export function storeFileStats(): { preferences: boolean; settings: boolean } {
  const stat = (path: string): boolean => existsSync(path) && statSync(path).isFile();
  return { preferences: stat(PREFERENCES_FILE), settings: stat(SETTINGS_FILE) };
}
