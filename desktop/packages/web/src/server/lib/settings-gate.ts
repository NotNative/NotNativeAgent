// SPDX-License-Identifier: Apache-2.0
/**
 * Settings registry gate (doc 14 §F.4): the checked-in snapshot is the
 * server's key authority. Keys it does not list never reach the store;
 * computed/local/device-scope/desktop-shell-owned keys are write-ineligible;
 * secret keys are accepted but never returned; surface kinds constrain
 * surface-scoped fields. Source of truth: scripts/registry-snapshot.mjs.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export type ScopeKind = 'instance' | 'profile' | 'device';

export interface SnapshotField {
  scope: ScopeKind;
  perSurface?: boolean;
  surfaces?: string[];
  adopt?: 'bootstrap-only';
  derived?: boolean;
  secret?: boolean;
  computed?: boolean;
  local?: boolean;
  owner?: 'desktop-shell' | 'server';
}

interface RegistrySnapshot {
  version: number;
  fields: Record<string, SnapshotField>;
}

const SNAPSHOT_PATH = fileURLToPath(new URL('./settings-registry.json', import.meta.url));
let snapshotCache: RegistrySnapshot | null = null;

export function registrySnapshot(): RegistrySnapshot {
  if (!snapshotCache) snapshotCache = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8')) as RegistrySnapshot;
  return snapshotCache;
}

export function snapshotField(key: string): SnapshotField | null {
  return registrySnapshot().fields[key] ?? null;
}

export function isRegisteredKey(key: string): boolean {
  return snapshotField(key) !== null;
}

/** Write-ineligible: never persisted for this build/process (§F.2 flags). */
export function isWritableField(key: string): boolean {
  const field = snapshotField(key);
  if (!field) return false;
  if (field.computed === true) return false;
  if (field.local === true) return false;
  if (field.scope === 'device') return false;
  if (field.owner !== undefined) return false;
  return true;
}

export function isSecretField(key: string): boolean {
  return snapshotField(key)?.secret === true;
}

export function isComputedField(key: string): boolean {
  return snapshotField(key)?.computed === true;
}

export function fieldPerSurface(key: string): boolean {
  return snapshotField(key)?.perSurface === true;
}

export function fieldSurfaces(key: string): string[] | null {
  return snapshotField(key)?.surfaces ?? null;
}

const KNOWN_KINDS = new Set(['web', 'desktop', 'mobile', 'vscode']);

export type SurfaceKind = 'web' | 'desktop' | 'mobile' | 'vscode';

/** ?surface= QUERY PARAM (doc §F.2, CORS-simple); header is a fallback. */
export function resolveSurfaceKind(param: string | undefined, header: string | undefined): SurfaceKind {
  const candidate = param ?? header ?? 'web';
  return (KNOWN_KINDS as Set<string>).has(candidate) ? (candidate as SurfaceKind) : 'web';
}
