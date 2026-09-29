// SPDX-License-Identifier: Apache-2.0
/** Boundary pin for the per-source skills catalog store (P10-37). */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { catalogCacheTtlMs, useSkillsCatalogStore } from '../useSkillsCatalogStore.ts';
import type { SkillCatalogScanItem, SkillSource } from '../../lib/skills-api.ts';

vi.mock('../../lib/skills-api.ts', () => ({
  installSkills: vi.fn(),
  loadSkillCatalog: vi.fn(),
  loadSkillCatalogSource: vi.fn(),
}));
import { installSkills, loadSkillCatalog, loadSkillCatalogSource } from '../../lib/skills-api.ts';

const installMock = vi.mocked(installSkills);
const catalogMock = vi.mocked(loadSkillCatalog);
const sourceMock = vi.mocked(loadSkillCatalogSource);

const source: SkillSource = { id: 'anthropic', label: 'Anthropic', source: 'anthropics/skills', subpath: 'skills' };
const sample: SkillCatalogScanItem = {
  repoSource: 'anthropics/skills', repoSubpath: 'skills', skillDir: 'skills/review',
  skillName: 'review-flow', frontmatterName: 'review-flow', description: 'Review code',
  installable: true, warnings: [],
  installed: { isInstalled: false, scope: null, source: null },
};

function catalogPayload(): { ok: true; sources: SkillSource[]; itemsBySource: Record<string, SkillCatalogScanItem[]> } {
  return {
    ok: true,
    sources: [source],
    itemsBySource: { anthropic: [sample] },
    override: new Date(Date.now() + catalogCacheTtlMs).toISOString(),
  } as unknown as { ok: true; sources: SkillSource[]; itemsBySource: Record<string, SkillCatalogScanItem[]> };
}

function sourcePayload(overwriteInstalled = false): { ok: true; source: SkillSource; sourceId: string; items: SkillCatalogScanItem[] } {
  return {
    ok: true, source, sourceId: source.id,
    items: [{ ...sample, installed: { ...sample.installed, isInstalled: overwriteInstalled } }],
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

function sourceArray(...ids: string[]): SkillSource[] {
  return ids.map((id) => ({ ...source, id, label: id }));
}

beforeEach(() => {
  vi.resetAllMocks();
  useSkillsCatalogStore.getState().resetForRuntimeSwitch();
  useSkillsCatalogStore.setState({
    sources: [source, { ...source, subpath: null, id: 'openai', label: 'OpenAI', source: 'openai/skills', defaultSubpath: 'root' }],
    itemsBySource: { openai: [] }, refreshedAt: {}, loadingSourceIds: [], lastScanError: null,
  });
});

describe('skills catalog store', () => {
  it('presents a catalog without installed state and reuses source cache', async () => {
    catalogMock.mockResolvedValueOnce(catalogPayload());
    sourceMock.mockResolvedValueOnce(sourcePayload(false));
    await useSkillsCatalogStore.getState().loadCatalog();
    expect(catalogMock).toHaveBeenCalledOnce();
    expect(useSkillsCatalogStore.getState().sources?.[0]?.id).toBe('anthropic');
    expect(useSkillsCatalogStore.getState().sources?.[0]?.stars).toBeUndefined();
    await useSkillsCatalogStore.getState().loadSource('anthropic', { directory: 'D:/new' });
    const first = useSkillsCatalogStore.getState().itemsBySource['anthropic|D:/new'];
    await useSkillsCatalogStore.getState().loadSource('anthropic', { directory: 'D:/new' });
    expect(sourceMock).toHaveBeenCalledOnce();
    expect(first).toEqual([sample]);
    expect(useSkillsCatalogStore.getState().installOutcomes).toEqual({});
  });

  it('bypasses source cache only when refresh is requested', async () => {
    sourceMock.mockResolvedValue(sourcePayload(true));
    await useSkillsCatalogStore.getState().loadSource('anthropic', { directory: 'D:/new' });
    await useSkillsCatalogStore.getState().loadSource('anthropic', { directory: 'D:/new', refresh: true });
    expect(sourceMock).toHaveBeenCalledTimes(2);
    expect(sourceMock.mock.calls[1]?.[1]).toEqual({ directory: 'D:/new', refresh: true });
  });

  it('keeps prior data and reports failed catalog scans', async () => {
    sourceMock.mockRejectedValueOnce({ kind: 'authRequired', message: 'Authentication is required' });
    await useSkillsCatalogStore.getState().loadSource('anthropic', { directory: 'D:/new' });
    expect(useSkillsCatalogStore.getState().itemsBySource['anthropic|D:/new']).toBeUndefined();
    expect(useSkillsCatalogStore.getState().lastScanError).toContain('Authentication is required');
  });

  it('drops transport results that arrive after a runtime switch', async () => {
    useSkillsCatalogStore.setState({ lastCatalogError: 'previous catalog failure' });
    useSkillsCatalogStore.getState().resetForRuntimeSwitch();
    expect(useSkillsCatalogStore.getState().lastCatalogError).toBeNull();

    const scan = deferred<{ ok: true; source: SkillSource; sourceId: string; items: SkillCatalogScanItem[] }>();
    sourceMock.mockReturnValueOnce(scan.promise);
    const scanRequest = useSkillsCatalogStore.getState().loadSource('anthropic', { directory: 'D:/new' });
    useSkillsCatalogStore.getState().resetForRuntimeSwitch();
    scan.resolve(sourcePayload(false));
    await scanRequest;

    const install = deferred<{
      ok: true; installed: Array<{ skillName: string; scope: 'project'; source: 'opencode' }>;
      skipped: []; requiresReload: true; message: string;
    }>();
    installMock.mockReturnValueOnce(install.promise);
    const installRequest = useSkillsCatalogStore.getState().installSource('anthropic', {
      directory: 'D:/new', scope: 'project', selections: ['review-flow'],
    });
    useSkillsCatalogStore.getState().resetForRuntimeSwitch();
    install.resolve({ ok: true, installed: [], skipped: [], requiresReload: true, message: 'installed' });
    await installRequest;

    const state = useSkillsCatalogStore.getState();
    expect(state.sources).toEqual([]);
    expect(state.itemsBySource).toEqual({});
    expect(state.loadingSourceIds).toEqual([]);
    expect(state.installingSourceIds).toEqual([]);
    expect(state.installOutcomes).toEqual({});
  });

  it('caches scans separately by workspace', async () => {
    sourceMock.mockResolvedValueOnce(sourcePayload(false));
    sourceMock.mockResolvedValueOnce({ ...sourcePayload(false),
      items: [{ ...sample, skillName: 'other-workspace-skill' }] });

    await useSkillsCatalogStore.getState().loadSource('anthropic', { directory: 'D:/new' });
    await useSkillsCatalogStore.getState().loadSource('anthropic', { directory: 'D:/old' });

    expect(sourceMock).toHaveBeenCalledTimes(2);
    expect(useSkillsCatalogStore.getState().itemsBySource['anthropic|D:/new']?.[0]?.skillName).toBe('review-flow');
    expect(useSkillsCatalogStore.getState().itemsBySource['anthropic|D:/old']?.[0]?.skillName).toBe('other-workspace-skill');
  });

  it('keeps only the latest requested source result when scans overlap', async () => {
    const oldScan = deferred<{ ok: true; source: SkillSource; sourceId: string; items: SkillCatalogScanItem[] }>();
    const newScan = deferred<{ ok: true; source: SkillSource; sourceId: string; items: SkillCatalogScanItem[] }>();
    sourceMock.mockReturnValueOnce(oldScan.promise);
    sourceMock.mockReturnValueOnce(newScan.promise);

    const oldRequest = useSkillsCatalogStore.getState().loadSource('anthropic', { directory: 'D:/old' });
    const newRequest = useSkillsCatalogStore.getState().loadSource('anthropic', { directory: 'D:/new' });
    newScan.resolve(sourcePayload(false));
    await newRequest;
    oldScan.resolve(sourcePayload(false));
    await oldRequest;

    const state = useSkillsCatalogStore.getState();
    expect(state.itemsBySource['anthropic|D:/new']?.[0]?.skillName).toBe('review-flow');
    expect(state.itemsBySource['anthropic|D:/old']).toBeUndefined();
    expect(state.loadingSourceIds).toEqual([]);
  });

  it('keeps the latest requested catalog response when reads overlap', async () => {
    const oldCatalog = deferred<{ ok: true; sources: SkillSource[]; itemsBySource: Record<string, SkillCatalogScanItem[]> }>();
    const newCatalog = deferred<{ ok: true; sources: SkillSource[]; itemsBySource: Record<string, SkillCatalogScanItem[]> }>();
    catalogMock.mockReturnValueOnce(oldCatalog.promise);
    catalogMock.mockReturnValueOnce(newCatalog.promise);

    const oldRequest = useSkillsCatalogStore.getState().loadCatalog();
    const newRequest = useSkillsCatalogStore.getState().loadCatalog();
    newCatalog.resolve({ ok: true, sources: sourceArray('new'), itemsBySource: {} });
    await newRequest;
    oldCatalog.resolve({ ok: true, sources: sourceArray('old'), itemsBySource: {} });
    await oldRequest;

    expect(useSkillsCatalogStore.getState().sources?.map(({ id }) => id)).toEqual(['new']);
    expect(useSkillsCatalogStore.getState().lastCatalogError).toBeNull();
  });

  it('caches scans separately by workspace', async () => {
    sourceMock.mockResolvedValueOnce(sourcePayload(false));
    sourceMock.mockResolvedValueOnce({ ...sourcePayload(false),
      items: [{ ...sample, skillName: 'other-workspace-skill' }] });

    await useSkillsCatalogStore.getState().loadSource('anthropic', { directory: 'D:/new' });
    await useSkillsCatalogStore.getState().loadSource('anthropic', { directory: 'D:/old' });

    expect(sourceMock).toHaveBeenCalledTimes(2);
    expect(useSkillsCatalogStore.getState().itemsBySource['anthropic|D:/new']?.[0]?.skillName).toBe('review-flow');
    expect(useSkillsCatalogStore.getState().itemsBySource['anthropic|D:/old']?.[0]?.skillName).toBe('other-workspace-skill');
  });

  it('keeps only the latest requested source result when scans overlap', async () => {
    const oldScan = deferred<{ ok: true; source: SkillSource; sourceId: string; items: SkillCatalogScanItem[] }>();
    const newScan = deferred<{ ok: true; source: SkillSource; sourceId: string; items: SkillCatalogScanItem[] }>();
    sourceMock.mockReturnValueOnce(oldScan.promise);
    sourceMock.mockReturnValueOnce(newScan.promise);

    const oldRequest = useSkillsCatalogStore.getState().loadSource('anthropic', { directory: 'D:/old' });
    const newRequest = useSkillsCatalogStore.getState().loadSource('anthropic', { directory: 'D:/new' });
    newScan.resolve(sourcePayload(false));
    await newRequest;
    oldScan.resolve(sourcePayload(false));
    await oldRequest;

    const state = useSkillsCatalogStore.getState();
    expect(state.itemsBySource['anthropic|D:/new']?.[0]?.skillName).toBe('review-flow');
    expect(state.itemsBySource['anthropic|D:/old']).toBeUndefined();
    expect(state.loadingSourceIds).toEqual([]);
  });

  it('blocks project installation before transport without a workspace', async () => {
    const result = await useSkillsCatalogStore.getState().installSource('anthropic', {
      scope: 'project', selections: ['review-flow'],
    });
    expect(installMock).not.toHaveBeenCalled();
    expect(result).toEqual({ kind: 'error', message: 'Project installation requires a workspace.' });
  });

  it('installs selections and refreshes installed state', async () => {
    installMock.mockResolvedValueOnce({
      ok: true, installed: [{ skillName: 'review-flow', scope: 'project', source: 'opencode' }],
      skipped: [], requiresReload: true, message: 'installed',
    });
    const result = await useSkillsCatalogStore.getState().installSource('anthropic', {
      directory: 'D:/new', scope: 'project', targetSource: 'agents', selections: ['review-flow'],
    });
    expect(result).toEqual({ kind: 'success', message: 'installed', installed: 1 });
    expect(installMock).toHaveBeenCalledWith({
      source: 'anthropics/skills', subpath: 'skills', gitIdentityId: null,
      scope: 'project', targetSource: 'agents', selections: ['review-flow'],
      conflictPolicy: undefined, conflictDecisions: undefined,
    }, 'D:/new');
  });

  it('retains conflicts and identities from failed installation', async () => {
    installMock.mockRejectedValueOnce({ kind: 'conflicts', message: 'skills already exist',
      conflicts: [{ skillName: 'review-flow' }], identities: [{ id: 'git-1', name: 'Work' }] });
    const result = await useSkillsCatalogStore.getState().installSource('anthropic', {
      directory: 'D:/new', scope: 'project', selections: ['review-flow'],
    });
    expect(result).toMatchObject({ kind: 'error', message: 'skills already exist',
      conflicts: [{ skillName: 'review-flow' }], identities: [{ id: 'git-1', name: 'Work' }] });
    expect(useSkillsCatalogStore.getState().installOutcomes).toEqual({
      'anthropic|project|D:/new': {
        conflicts: [{ skillName: 'review-flow' }],
        identities: [{ id: 'git-1', name: 'Work' }],
        kind: 'error', message: 'skills already exist',
      },
    });
  });

  it('deletes runtime data exactly', () => {
    useSkillsCatalogStore.getState().resetForRuntimeSwitch();
    const state = useSkillsCatalogStore.getState();
    expect(state.sources).toEqual([]);
    expect(state).toEqual({ ...state,
      sources: [], itemsBySource: {}, refreshedAt: {}, loadingSourceIds: [], lastScanError: null });
  });
});
