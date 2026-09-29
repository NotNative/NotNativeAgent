// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
/** Pins the Settings catalog browse surface against the P10-37 store cache. */
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/skills-api.ts', () => ({
  installSkills: vi.fn(),
  loadSkillCatalog: vi.fn(),
  loadSkillCatalogSource: vi.fn(),
}));
const runtimeListeners = new Set<(detail: {
  apiBaseUrl: string; previousApiBaseUrl: string | null;
  runtimeKey: string; previousRuntimeKey: string;
}) => void>();
vi.mock('../../../lib/runtime-switch.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/runtime-switch.ts')>();
  return {
    ...actual,
    onRuntimeEndpointChanged: (listener: Parameters<typeof actual.onRuntimeEndpointChanged>[0]) => {
      runtimeListeners.add(listener);
      return () => { runtimeListeners.delete(listener); };
    },
  };
});

import { installSkills, loadSkillCatalog, loadSkillCatalogSource } from '../../../lib/skills-api.ts';
import { useSkillsCatalogStore } from '../../../stores/useSkillsCatalogStore.ts';
import { useSessionViewStore } from '../../../sync/view-store.ts';
import { SkillsCatalogPage } from '../pages/skills-catalog.tsx';

const catalogMock = loadSkillCatalog as ReturnType<typeof vi.fn>;
const sourceMock = loadSkillCatalogSource as ReturnType<typeof vi.fn>;
const installMock = installSkills as ReturnType<typeof vi.fn>;

let container: HTMLDivElement | null = null;
let rootHandle: Root | null = null;

const source = (id: string, label: string) => ({ id, label, source: `${id}-repo`, subpath: 'skills' });
const item = (name: string, installed = false) => ({
  repoSource: 'catalog-repo', repoSubpath: 'skills', skillDir: `skills/${name}`,
  skillName: name, frontmatterName: name, description: `${name} description`,
  installable: true, warnings: [],
  installed: { isInstalled: installed, scope: installed ? 'project' as const : null,
    source: installed ? 'opencode' as const : null },
});

function settle(): Promise<void> {
  return act(async () => { await Promise.resolve(); });
}

function mount(): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  rootHandle = createRoot(container);
  act(() => { rootHandle!.render(<SkillsCatalogPage />); });
}

function click(button: Element): void {
  act(() => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function clickText(label: string): void {
  const button = [...document.querySelectorAll('button')].find((node) => node.textContent === label)!;
  click(button);
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

afterEach(() => {
  if (rootHandle !== null) {
    const closing = rootHandle;
    act(() => { closing.unmount(); });
    rootHandle = null;
  }
  container?.remove();
  container = null;
});

beforeEach(() => {
  catalogMock.mockReset();
  sourceMock.mockReset();
  installMock.mockReset();
  useSkillsCatalogStore.getState().resetForRuntimeSwitch();
  useSessionViewStore.setState({ activeDirectory: 'D:/workspace', currentSessionId: null });
});

describe('skills catalog settings page', () => {
  it('loads and browses the first configured source', async () => {
    catalogMock.mockResolvedValue({ ok: true, sources: [source('anthropic', 'Anthropic')], itemsBySource: {} });
    sourceMock.mockResolvedValue({ ok: true, source: source('anthropic', 'Anthropic'), sourceId: 'anthropic',
      items: [item('review'), item('todo', true)] });
    mount();
    await settle();

    expect(document.querySelectorAll('[data-testid="skill-catalog-source"]')).toHaveLength(1);
    expect(document.body.textContent).toContain('Anthropic');
    const rows = [...document.querySelectorAll('[data-testid="skill-catalog-item"]')];
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain('review description');
    expect(rows[1]!.textContent).toContain('Installed · project');
    expect(document.body.textContent).toContain('Workspace: D:/workspace');
  });

  it('selects a source and scans the active workspace directory', async () => {
    const anthropic = source('anthropic', 'Anthropic');
    const openai = source('openai', 'OpenAI');
    catalogMock.mockResolvedValue({ ok: true, sources: [anthropic, openai], itemsBySource: {} });
    sourceMock.mockImplementation((sourceId: unknown) => Promise.resolve({
      ok: true as const, source: sourceId === 'openai' ? openai : anthropic,
      sourceId: sourceId as string,
      items: sourceId === 'openai' ? [item('openai-skill')] : [item('anthropic-skill')],
    }));
    mount();
    await settle();

    const choices = [...document.querySelectorAll('[data-testid="skill-catalog-source"]')];
    click(choices[1]!);
    await settle();
    const rows = [...document.querySelectorAll('[data-testid="skill-catalog-item"]')];
    expect(rows[0]!.textContent).toContain('openai-skill');
    expect(sourceMock).toHaveBeenLastCalledWith('openai', { directory: 'D:/workspace' });
  });

  it('moves each source scan to its active workspace cache', async () => {
    const anthropic = source('anthropic', 'Anthropic');
    catalogMock.mockResolvedValue({ ok: true, sources: [anthropic], itemsBySource: {} });
    sourceMock.mockResolvedValueOnce({ ok: true as const, source: anthropic, sourceId: 'anthropic',
      items: [item('workspace-one-skill')] });
    sourceMock.mockResolvedValueOnce({ ok: true as const, source: anthropic, sourceId: 'anthropic',
      items: [item('workspace-two-skill')] });
    mount();
    await settle();

    act(() => { useSessionViewStore.setState({ activeDirectory: 'D:/other-workspace' }); });
    await settle();

    const rows = [...document.querySelectorAll('[data-testid="skill-catalog-item"]')];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toContain('workspace-two-skill');
    expect(document.body.textContent).toContain('Workspace: D:/other-workspace');
  });

  it('refreshes beyond the cache while retaining earlier data after a failure', async () => {
    const anthropic = source('anthropic', 'Anthropic');
    catalogMock.mockResolvedValue({ ok: true, sources: [anthropic], itemsBySource: {} });
    sourceMock.mockResolvedValue({ ok: true, source: anthropic, sourceId: 'anthropic', items: [item('cached')] });
    mount();
    await settle();

    sourceMock.mockRejectedValueOnce(new Error('Authentication required'));
    catalogMock.mockRejectedValueOnce(new Error('Catalog read denied'));
    click(document.querySelector('[data-testid="skills-catalog-refresh"]')!);
    await settle();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Catalog read denied');
    expect(document.body.textContent).toContain('cached');
    expect(sourceMock.mock.calls.some(([, options]) => options?.refresh === true)).toBe(true);
  });

  it('installs one selected skill and refreshes its source', async () => {
    const anthropic = source('anthropic', 'Anthropic');
    catalogMock.mockResolvedValue({ ok: true, sources: [anthropic], itemsBySource: {} });
    sourceMock.mockResolvedValue({ ok: true, source: anthropic, sourceId: 'anthropic', items: [item('review')] });
    installMock.mockResolvedValue({
      ok: true,
      installed: [{ skillName: 'review', scope: 'user', source: 'opencode' }],
      skipped: [], requiresReload: true, message: 'Installed one skill',
    });
    mount();
    await settle();
    click(document.querySelector('[data-testid="install-skill-review"]')!);
    await settle();

    expect(installMock).toHaveBeenCalledWith({
      source: 'anthropic-repo', subpath: 'skills', gitIdentityId: null,
      scope: 'user', targetSource: 'opencode', selections: ['review'],
      conflictPolicy: undefined, conflictDecisions: undefined,
    }, 'D:/workspace');
    expect(document.body.textContent).toContain('Installed one skill');
    expect(sourceMock).toHaveBeenLastCalledWith('anthropic', { directory: 'D:/workspace', refresh: true });
  });

  it('keeps an install visible after conflict rejection without offering a decision', async () => {
    const anthropic = source('anthropic', 'Anthropic');
    catalogMock.mockResolvedValue({ ok: true, sources: [anthropic], itemsBySource: {} });
    sourceMock.mockResolvedValue({ ok: true, source: anthropic, sourceId: 'anthropic', items: [item('review')] });
    installMock.mockRejectedValueOnce({
      kind: 'conflicts', message: 'One skill already exists',
      conflicts: [{ skillName: 'review', scope: 'user', source: 'opencode' }],
    });
    mount();
    await settle();
    click(document.querySelector('[data-testid="install-skill-review"]')!);
    await settle();

    expect(document.body.textContent).toContain('One skill already exists');
    expect(document.querySelector('[data-testid="install-skill-review"]')).not.toBeNull();
    expect(sourceMock.mock.calls.filter(([, options]) => options?.refresh === true)).toHaveLength(0);
  });

  it('prevents another install while a source install is pending', async () => {
    const anthropic = source('anthropic', 'Anthropic');
    catalogMock.mockResolvedValue({ ok: true, sources: [anthropic], itemsBySource: {} });
    sourceMock.mockResolvedValue({ ok: true, source: anthropic, sourceId: 'anthropic', items: [item('review')] });
    const install = deferred<Awaited<ReturnType<typeof installSkills>>>();
    installMock.mockReturnValueOnce(install.promise);
    mount();
    await settle();
    click(document.querySelector('[data-testid="install-skill-review"]')!);
    await settle();

    expect((document.querySelector('[data-testid="install-skill-review"]') as HTMLButtonElement).disabled).toBe(true);

    install.resolve({ ok: true, installed: [], skipped: [], requiresReload: true, message: 'installed' });
    await settle();
    expect((document.querySelector('[data-testid="install-skill-review"]') as HTMLButtonElement).disabled).toBe(false);
  });

  it('reloads the catalog and ignores a successful install after a runtime switch', async () => {
    const anthropic = source('anthropic', 'Anthropic');
    const openai = source('openai', 'OpenAI');
    catalogMock.mockResolvedValue({ ok: true, sources: [anthropic], itemsBySource: {} });
    sourceMock.mockResolvedValueOnce({ ok: true, source: anthropic, sourceId: 'anthropic', items: [item('old-runtime-skill')] });
    const install = deferred<Awaited<ReturnType<typeof installSkills>>>();
    installMock.mockReturnValueOnce(install.promise);
    mount();
    await settle();
    click(document.querySelector('[data-testid="install-skill-old-runtime-skill"]')!);
    await settle();

    catalogMock.mockResolvedValueOnce({ ok: true, sources: [openai], itemsBySource: {} });
    sourceMock.mockResolvedValueOnce({ ok: true, source: openai, sourceId: 'openai', items: [item('new-runtime-skill')] });
    await act(async () => {
      useSkillsCatalogStore.getState().resetForRuntimeSwitch();
      for (const listener of [...runtimeListeners]) listener({
        previousApiBaseUrl: 'http://old.test', apiBaseUrl: 'http://new.test',
        previousRuntimeKey: 'old', runtimeKey: 'new',
      });
    });
    await act(async () => {
      install.resolve({ ok: true, installed: [], skipped: [], requiresReload: true, message: 'stale installed' });
      await install.promise;
    });
    await settle();

    expect(document.body.textContent).toContain('new-runtime-skill');
    expect(document.body.textContent).not.toContain('stale installed');
    expect(sourceMock).toHaveBeenLastCalledWith('openai', { directory: 'D:/workspace' });
    expect(installMock).toHaveBeenCalledTimes(1);
  });

  it('hides an install outcome after its scope or target request changes', async () => {
    const anthropic = source('anthropic', 'Anthropic');
    catalogMock.mockResolvedValue({ ok: true, sources: [anthropic], itemsBySource: {} });
    sourceMock.mockResolvedValue({ ok: true, source: anthropic, sourceId: 'anthropic', items: [item('review')] });
    const install = deferred<Awaited<ReturnType<typeof installSkills>>>();
    installMock.mockReturnValueOnce(install.promise);
    mount();
    await settle();
    click(document.querySelector('[data-testid="install-skill-review"]')!);
    await settle();
    clickText('Agents');
    clickText('Project');
    install.resolve({ ok: true, installed: [], skipped: [], requiresReload: true, message: 'stale install result' });
    await install.promise;
    await settle();
    expect(document.body.textContent).not.toContain('stale install result');
    expect(installMock).toHaveBeenCalledWith(expect.objectContaining({
      scope: 'user', targetSource: 'opencode', selections: ['review'],
    }), 'D:/workspace');
  });

  it('shows catalog failure and configured-source notices without rows', async () => {
    catalogMock.mockResolvedValue({ ok: true, sources: [], itemsBySource: {} });
    mount();
    await settle();
    expect(document.body.textContent).toContain('No skill catalog sources are configured.');
    expect(document.querySelectorAll('[data-testid="skill-catalog-item"]')).toHaveLength(0);

    catalogMock.mockResolvedValue({ ok: true });
    click(document.querySelector('[data-testid="skills-catalog-refresh"]')!);
    await settle();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('invalid catalog response');
  });
});
