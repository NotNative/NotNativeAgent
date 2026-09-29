// SPDX-License-Identifier: Apache-2.0
/**
 * Per-source NND skills catalog client cache (E.5). Transport failures keep
 * previous data, never become empty state.
 */
import { create } from 'zustand';
import {
  installSkills, loadSkillCatalog, loadSkillCatalogSource,
  type SkillCatalogScanItem, type SkillConflict, type SkillScope, type SkillSource,
  type SkillTargetSource,
} from '../lib/skills-api.ts';

const CATALOG_TTL_MS = 3 * 60 * 60 * 1000;
let runtimeEpoch = 0;
const isCurrentRuntime = (epoch: number) => epoch === runtimeEpoch;
let catalogRequestSerial = 0;
const sourceRequestSerials: Record<string, number> = {};

export type SkillInstallOutcome =
  | { kind: 'success'; message: string; installed: number }
  | { kind: 'error'; message: string; conflicts?: SkillConflict[]; identities?: unknown[] };

interface SkillsCatalogState {
  sources: SkillSource[] | null;
  itemsBySource: Record<string, SkillCatalogScanItem[]>;
  refreshedAt: Record<string, number>;
  loadingSourceIds: string[];
  installingSourceIds: string[];
  lastCatalogError: string | null;
  lastScanError: string | null;
  installOutcomes: Record<string, SkillInstallOutcome>;

  loadCatalog: () => Promise<void>;
  loadSource: (sourceId: string, options: {
    refresh?: boolean; directory?: string;
  }) => Promise<void>;
  installSource: (sourceId: string, input: {
    directory?: string; scope: SkillScope; targetSource?: SkillTargetSource;
    selections: string[]; conflictPolicy?: 'prompt' | 'skipAll' | 'overwriteAll';
    conflictDecisions?: Record<string, 'skip' | 'overwrite'>;
  }) => Promise<SkillInstallOutcome>;
  resetForRuntimeSwitch: () => void;
}

export const catalogCacheTtlMs = CATALOG_TTL_MS;

function isValid(value: unknown): value is { sources: SkillSource[] } {
  return Array.isArray((value as { sources?: unknown })?.sources)
    && (value as { sources: unknown[] }).sources.every(isValidSource);
}

function isValidSource(value: unknown): value is SkillSource {
  if (!value || typeof value !== 'object') return false;
  const source = value as Record<string, unknown>;
      return typeof source.id === 'string' && typeof source.label === 'string' && typeof source.source === 'string'
        && (source.id !== '' && source.label !== '' && source.source !== '');
}

function item(value: unknown): SkillCatalogScanItem | null {
  if (!value || typeof value !== 'object') return null;
  const substance = value as Record<string, unknown>;
  const installed = substance.installed as Record<string, unknown> | null;
  if (typeof substance.skillName !== 'string' || typeof substance.description !== 'string'
    || typeof substance.installable !== 'boolean' || !Array.isArray(substance.warnings)
    || !installed || typeof installed.isInstalled !== 'boolean') return null;
  return { repoSource: String(substance.repoSource ?? ''), repoSubpath: typeof substance.repoSubpath === 'string' ? substance.repoSubpath : null,
    skillDir: String(substance.skillDir ?? ''), skillName: substance.skillName,
    frontmatterName: String(substance.frontmatterName ?? ''), description: substance.description,
    installable: substance.installable, warnings: substance.warnings.filter((entry): entry is string => typeof entry === 'string'),
    installed: { isInstalled: installed.isInstalled, scope: installed.scope === 'user' || installed.scope === 'project' ? installed.scope : null,
      source: typeof installed.source === 'string' ? installed.source : null } };
}

export const useSkillsCatalogStore = create<SkillsCatalogState>((set, get) => ({
  sources: null,
  itemsBySource: {},
  refreshedAt: {},
  loadingSourceIds: [],
  installingSourceIds: [],
  lastCatalogError: null,
  lastScanError: null,
  installOutcomes: {},

  async loadCatalog() {
    const epoch = runtimeEpoch;
    const requestSerial = ++catalogRequestSerial;
    try {
      const value = asRecord(await loadSkillCatalog());
      if (!isCurrentRuntime(epoch) || catalogRequestSerial !== requestSerial) return;
      if (!isValid(value)) throw new Error('invalid catalog response');
      set({ sources: value.sources, lastCatalogError: null });
    } catch (error) {
      console.error('skills catalog load failed', error);
      if (!isCurrentRuntime(epoch) || catalogRequestSerial !== requestSerial) return;
      set({ lastCatalogError: String(error) });
    }
  },

  async loadSource(sourceId, options) {
    const epoch = runtimeEpoch;
    const key = `${sourceId}|${options.directory ?? ''}`;
    const requestSerial = sourceRequestSerials[sourceId] = (sourceRequestSerials[sourceId] ?? 0) + 1;
    const now = Date.now();
    if (!options.refresh && now - (get().refreshedAt[key] ?? 0) < CATALOG_TTL_MS
      && get().itemsBySource[key] !== undefined) return;
    set((state) => ({
      loadingSourceIds: state.loadingSourceIds.includes(sourceId) ? state.loadingSourceIds : [...state.loadingSourceIds, sourceId],
    }));
    try {
      const value = asRecord(await loadSkillCatalogSource(sourceId, options));
      if (!isCurrentRuntime(epoch) || sourceRequestSerials[sourceId] !== requestSerial) return;
      const payload = value as { source?: unknown; items?: unknown[] };
      const items = Array.isArray(payload.items) ? payload.items.map(item).filter((entry): entry is SkillCatalogScanItem => entry !== null) : [];
      set((state) => ({ itemsBySource: { ...state.itemsBySource, [key]: items },
        refreshedAt: { ...state.refreshedAt, [key]: Date.now() }, lastScanError: null }));
    } catch (error) {
      console.error('skills catalog source load failed', error);
      const failure = error as { message?: unknown };
      if (!isCurrentRuntime(epoch) || sourceRequestSerials[sourceId] !== requestSerial) return;
      set({ lastScanError: typeof failure?.message === 'string' ? failure.message : 'Skill catalog scan failed.' });
    } finally {
      if (isCurrentRuntime(epoch) && sourceRequestSerials[sourceId] === requestSerial) {
        set((state) => ({ loadingSourceIds: state.loadingSourceIds.filter((entry) => entry !== sourceId) }));
      }
    }
  },

  async installSource(sourceId, input) {
    const epoch = runtimeEpoch;
    const key = `${sourceId}|${input.scope}|${input.directory ?? ''}`;
    const source = get().sources?.find((entry) => entry.id === sourceId);
    if (!source) return { kind: 'error', message: 'Select a catalog source first.' };
    if (input.scope === 'project' && !input.directory) return { kind: 'error', message: 'Project installation requires a workspace.' };
    set((state) => ({ installingSourceIds: state.installingSourceIds.includes(sourceId)
      ? state.installingSourceIds : [...state.installingSourceIds, sourceId] }));
    try {
      const result = await installSkills({
        source: source.source, subpath: source.subpath ?? null,
        gitIdentityId: source.gitIdentityId ?? null, scope: input.scope,
        targetSource: input.targetSource ?? 'opencode', selections: input.selections,
        conflictPolicy: input.conflictPolicy, conflictDecisions: input.conflictDecisions,
      }, input.directory);
      const outcome: SkillInstallOutcome = {
        kind: 'success', message: result.message, installed: result.installed.length,
      };
      if (!isCurrentRuntime(epoch)) return outcome;
      set((state) => ({ installOutcomes: { ...state.installOutcomes, [key]: outcome } }));
      return outcome;
    } catch (error) {
      const failure = error as { kind?: unknown; message?: unknown; conflicts?: SkillConflict[]; identities?: unknown[] };
      const outcome: SkillInstallOutcome = {
        kind: 'error', message: typeof failure.message === 'string' ? failure.message : 'Skill installation failed.',
        conflicts: Array.isArray(failure.conflicts) ? failure.conflicts : undefined,
        identities: Array.isArray(failure.identities) ? failure.identities : undefined,
      };
      if (!isCurrentRuntime(epoch)) return outcome;
      set((state) => ({ installOutcomes: { ...state.installOutcomes, [key]: outcome } }));
      return outcome;
    } finally {
      if (isCurrentRuntime(epoch)) {
        set((state) => ({ installingSourceIds: state.installingSourceIds.filter((entry) => entry !== sourceId) }));
      }
    }
  },

  resetForRuntimeSwitch() {
    runtimeEpoch += 1;
    set({
      sources: [], itemsBySource: {}, refreshedAt: {}, loadingSourceIds: [],
      installingSourceIds: [], lastCatalogError: null, lastScanError: null, installOutcomes: {},
    });
  },
}));

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}
