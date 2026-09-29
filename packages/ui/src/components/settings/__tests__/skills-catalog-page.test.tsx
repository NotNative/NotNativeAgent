// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
/** Pins the Settings catalog browse surface against the P10-37 store cache. */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/skills-api.ts', () => ({
  installSkills: vi.fn(),
  loadSkillCatalog: vi.fn(),
  loadSkillCatalogSource: vi.fn(),
}));

import { loadSkillCatalog, loadSkillCatalogSource } from '../../../lib/skills-api.ts';
import { useSkillsCatalogStore } from '../../../stores/useSkillsCatalogStore.ts';
import { useSessionViewStore } from '../../../sync/view-store.ts';
import { SkillsCatalogPage } from '../pages/skills-catalog.tsx';

const catalogMock = loadSkillCatalog as ReturnType<typeof vi.fn>;
const sourceMock = loadSkillCatalogSource as ReturnType<typeof vi.fn>;

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
