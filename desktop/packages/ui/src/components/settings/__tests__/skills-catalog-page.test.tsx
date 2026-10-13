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
import { I18nProvider } from '../../I18nProvider.tsx';
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
  act(() => { rootHandle!.render(<I18nProvider><SkillsCatalogPage /></I18nProvider>); });
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

function deferred<T>(): {
  promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((settle, fail) => { resolve = settle; reject = fail; });
  return { promise, resolve, reject };
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
    expect(rows[1]!.textContent).toContain('Installed · Project');
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
    }, 'D:/workspace', { signal: expect.anything() });
    expect(document.body.textContent).toContain('Installed one skill');
    expect(sourceMock).toHaveBeenLastCalledWith('anthropic', { directory: 'D:/workspace', refresh: true });
  });

  it('prompts a captured target conflict and retries one skill individually', async () => {
    const anthropic = source('anthropic', 'Anthropic');
    catalogMock.mockResolvedValue({ ok: true, sources: [anthropic], itemsBySource: {} });
    sourceMock.mockResolvedValue({ ok: true, source: anthropic, sourceId: 'anthropic', items: [item('review')] });
    installMock.mockRejectedValueOnce({
      kind: 'conflicts', message: 'One skill already exists',
      conflicts: [
        { skillName: 'review', path: 'D:/workspace/.agents/skills/review', scope: 'user', source: 'opencode' },
        { skillName: 'review', path: 'C:/Users/test/.claude/skills/review', scope: 'user', source: 'claude' },
      ],
    });
    installMock.mockResolvedValueOnce({
      ok: true, installed: [{ skillName: 'review', scope: 'user', source: 'opencode' }],
      skipped: [], requiresReload: true, message: 'Installed one skill',
    });
    mount();
    await settle();
    click(document.querySelector('[data-testid="install-skill-review"]')!);
    await settle();

    const conflict = document.querySelector('[data-testid="skill-catalog-conflict"]');
    expect(conflict?.textContent).toContain('review');
    expect(conflict?.textContent).toContain('D:/workspace/.agents/skills/review');
    expect(conflict?.textContent).not.toContain('C:/Users/test/.claude/skills/review');
    clickText('Skip');
    await settle();

    expect(installMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
      scope: 'user', targetSource: 'opencode', selections: ['review'],
      conflictPolicy: undefined, conflictDecisions: { review: 'skip' },
    }), 'D:/workspace', expect.objectContaining({ signal: expect.anything() }));
    expect(document.querySelector('[data-testid="skill-catalog-conflict"]')).toBeNull();
    expect(sourceMock.mock.calls.at(-1)?.[0]).toBe('anthropic');
    expect(sourceMock.mock.calls.at(-1)?.[1]?.refresh).toBe(true);
  });
  it('exports a captured conflict with overwrite-all', async () => {
    const anthropic = source('anthropic', 'Anthropic');
    catalogMock.mockResolvedValue({ ok: true, sources: [anthropic], itemsBySource: {} });
    sourceMock.mockResolvedValue({ ok: true, source: anthropic, sourceId: 'anthropic', items: [item('review')] });
    installMock.mockRejectedValueOnce({
      kind: 'conflicts', message: 'One skill already exists',
      conflicts: [{ skillName: 'review', path: 'D:/workspace/.agents/skills/review', scope: 'user', source: 'opencode' }],
    });
    installMock.mockResolvedValueOnce({ ok: true, installed: [], skipped: [], requiresReload: true, message: 'Installed' });
    mount();
    await settle();
    click(document.querySelector('[data-testid="install-skill-review"]')!);
    await settle();

    clickText('Overwrite all');
    await settle();
    expect(installMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
      scope: 'user', targetSource: 'opencode', selections: ['review'],
      conflictPolicy: 'overwriteAll', conflictDecisions: undefined,
    }), 'D:/workspace', expect.objectContaining({ signal: expect.anything() }));
  });
  it('exports a captured conflict with skip-all', async () => {
    const anthropic = source('anthropic', 'Anthropic');
    catalogMock.mockResolvedValue({ ok: true, sources: [anthropic], itemsBySource: {} });
    sourceMock.mockResolvedValue({ ok: true, source: anthropic, sourceId: 'anthropic', items: [item('review')] });
    installMock.mockRejectedValueOnce({
      kind: 'conflicts', message: 'One skill already exists',
      conflicts: [{ skillName: 'review', path: 'D:/workspace/.agents/skills/review', scope: 'user', source: 'opencode' }],
    });
    installMock.mockResolvedValueOnce({ ok: true, installed: [], skipped: [], requiresReload: true, message: 'Skipped' });
    mount();
    await settle();
    click(document.querySelector('[data-testid="install-skill-review"]')!);
    await settle();

    clickText('Skip all');
    await settle();
    expect(installMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
      scope: 'user', targetSource: 'opencode', selections: ['review'],
      conflictPolicy: 'skipAll', conflictDecisions: undefined,
    }), 'D:/workspace', expect.objectContaining({ signal: expect.anything() }));
  });
  it('hides decisions for a cross-target conflict', async () => {
    const anthropic = source('anthropic', 'Anthropic');
    catalogMock.mockResolvedValue({ ok: true, sources: [anthropic], itemsBySource: {} });
    sourceMock.mockResolvedValue({ ok: true, source: anthropic, sourceId: 'anthropic', items: [item('review')] });
    installMock.mockRejectedValueOnce({
      kind: 'conflicts', message: 'One skill already exists',
      conflicts: [{ skillName: 'review', path: 'D:/workspace/.agents/other/review', scope: 'user', source: 'agents' }],
    });
    mount();
    await settle();
    click(document.querySelector('[data-testid="install-skill-review"]')!);
    await settle();

    expect(document.querySelector('[data-testid="skill-catalog-conflict"]')).toBeNull();
    expect([...document.querySelectorAll('button')].some((button) => button.textContent === 'Skip all')).toBe(false);
    expect(sourceMock.mock.calls.filter(([, options]) => options?.refresh === true)).toHaveLength(0);
  });

  it('treats malformed conflict metadata as a non-conflict failure', async () => {
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
    expect(document.querySelector('[data-testid="skill-catalog-conflict"]')).toBeNull();
    expect(sourceMock.mock.calls.filter(([, options]) => options?.refresh === true)).toHaveLength(0);
  });

  it('shows captured auth identities and retries with the chosen profile', async () => {
    const anthropic = source('anthropic', 'Anthropic');
    catalogMock.mockResolvedValue({ ok: true, sources: [anthropic], itemsBySource: {} });
    sourceMock.mockResolvedValue({ ok: true, source: anthropic, sourceId: 'anthropic', items: [item('review')] });
    installMock.mockRejectedValueOnce({
      kind: 'authRequired', message: 'Git authentication is required',
      identities: [{ id: 'work-key', name: 'Work key' }, { id: 'home-key', name: 'Home key' }],
    });
    installMock.mockResolvedValueOnce({ ok: true, installed: [], skipped: [], requiresReload: true, message: 'Installed with identity' });
    mount();
    await settle();
    click(document.querySelector('[data-testid="install-skill-review"]')!);
    await settle();

    const picker = document.querySelector('[data-testid="skill-catalog-identity"]');
    expect(picker?.textContent).toContain('Work key');
    expect(picker?.textContent).toContain('Home key');
    clickText('Home key');
    await settle();

    expect(installMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
      scope: 'user', targetSource: 'opencode', selections: ['review'],
      gitIdentityId: 'home-key', conflictPolicy: undefined, conflictDecisions: undefined,
    }), 'D:/workspace', expect.objectContaining({ signal: expect.anything() }));
    expect(document.querySelector('[data-testid="skill-catalog-identity"]')).toBeNull();
  });

  it('retains a configured source identity when no profile is chosen', async () => {
    const anthropic = { ...source('anthropic', 'Anthropic'), gitIdentityId: 'default-key' };
    catalogMock.mockResolvedValue({ ok: true, sources: [anthropic], itemsBySource: {} });
    sourceMock.mockResolvedValue({ ok: true, source: anthropic, sourceId: 'anthropic', items: [item('review')] });
    installMock.mockRejectedValueOnce(new Error('identity is not configured'));
    mount();
    await settle();
    click(document.querySelector('[data-testid="install-skill-review"]')!);
    await settle();

    expect(installMock).toHaveBeenCalledWith(expect.objectContaining({
      source: 'anthropic-repo', subpath: 'skills', gitIdentityId: 'default-key',
    }), 'D:/workspace', expect.objectContaining({ signal: expect.anything() }));
  });

  it('shows no identity picker when a 401 supplies only malformed profiles', async () => {
    const anthropic = source('anthropic', 'Anthropic');
    catalogMock.mockResolvedValue({ ok: true, sources: [anthropic], itemsBySource: {} });
    sourceMock.mockResolvedValue({ ok: true, source: anthropic, sourceId: 'anthropic', items: [item('review')] });
    installMock.mockRejectedValueOnce({
      kind: 'authRequired', message: 'Git authentication is required',
      identities: [null, 'work-key', { id: '', name: 'Bad' }, { id: ' ', name: 'Bad' },
        { id: 'bad', name: '' }, { id: 'bad', name: ' ' }],
    });
    mount();
    await settle();
    click(document.querySelector('[data-testid="install-skill-review"]')!);
    await settle();

    expect(document.querySelector('[data-testid="skill-catalog-identity"]')).toBeNull();
    expect(document.body.textContent).toContain('Git authentication is required');
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

  it('cancels the visible pending skill and shows the cancellation outcome', async () => {
    const anthropic = source('anthropic', 'Anthropic');
    catalogMock.mockResolvedValue({ ok: true, sources: [anthropic], itemsBySource: {} });
    sourceMock.mockResolvedValue({ ok: true, source: anthropic, sourceId: 'anthropic', items: [item('review')] });
    const install = deferred<Awaited<ReturnType<typeof installSkills>>>();
    installMock.mockReturnValueOnce(install.promise);
    mount();
    await settle();
    click(document.querySelector('[data-testid="install-skill-review"]')!);
    await settle();

    expect(document.querySelector('[data-testid="cancel-install-review"]')).not.toBeNull();
    click(document.querySelector('[data-testid="cancel-install-review"]')!);
    const signal = (installMock.mock.calls[0]![2] as { signal: AbortSignal }).signal;
    expect(signal.aborted).toBe(true);
    await act(async () => {
      install.reject(new DOMException('aborted', 'AbortError'));
      await install.promise.catch(() => undefined);
    });
    await settle();

    expect(document.querySelector('[data-testid="cancel-install-review"]')).toBeNull();
    expect(document.body.textContent).toContain('Skill installation was cancelled.');
  });

  it('does not offer cancellation after another workspace replacement appears', async () => {
    const anthropic = source('anthropic', 'Anthropic');
    catalogMock.mockResolvedValue({ ok: true, sources: [anthropic], itemsBySource: {} });
    sourceMock.mockResolvedValueOnce({
      ok: true, source: anthropic, sourceId: 'anthropic',
      items: [{ ...item('review'), installed: { isInstalled: false, scope: null, source: null } }],
    });
    const install = deferred<Awaited<ReturnType<typeof installSkills>>>();
    installMock.mockReturnValueOnce(install.promise);
    mount();
    await settle();
    click(document.querySelector('[data-testid="install-skill-review"]')!);
    await settle();

    sourceMock.mockResolvedValueOnce({
      ok: true, source: anthropic, sourceId: 'anthropic',
      items: [{ ...item('review'), installed: { isInstalled: false, scope: null, source: null } }],
    });
    await act(async () => {
      useSessionViewStore.setState({ activeDirectory: 'D:/other' });
      await Promise.resolve();
    });
    await settle();
    expect(document.querySelector('[data-testid="cancel-install-review"]')).toBeNull();

    await act(async () => {
      useSessionViewStore.setState({ activeDirectory: 'D:/workspace' });
      await Promise.resolve();
    });
    await settle();
    expect(document.querySelector('[data-testid="cancel-install-review"]')).not.toBeNull();
    click(document.querySelector('[data-testid="cancel-install-review"]')!);
    install.reject(new DOMException('aborted', 'AbortError'));
    expect((installMock.mock.calls[0]![2] as { signal: AbortSignal }).signal.aborted).toBe(true);
    await install.promise.catch(() => undefined);
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
    }), 'D:/workspace', expect.objectContaining({ signal: expect.anything() }));
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
