// SPDX-License-Identifier: Apache-2.0
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../../lib/runtime-fetch.ts', () => ({
  runtimeFetch: vi.fn(async () => ({ ok: false, status: 404, text: async () => '' })),
}));
vi.mock('../../lib/project-context-api.ts', () => ({
  getProjectContext: vi.fn(async () => ({ version: 2, notes: [], todos: [], plans: [], todosRevision: 'a'.repeat(64) })),
  ProjectContextRequestError: class extends Error { constructor(readonly status: number) { super('context failed'); } },
  createProjectNote: vi.fn(), updateProjectNote: vi.fn(), deleteProjectNote: vi.fn(),
  getProjectPlan: vi.fn(), createProjectPlan: vi.fn(), updateProjectPlan: vi.fn(), deleteProjectPlan: vi.fn(),
  replaceProjectTodos: vi.fn(),
}));

import { createDirectoryStore } from '../../sync/child-store.ts';
import { OperatorRail, resolveContextProjectId } from '../operator-rail.tsx';
import { useSessionViewStore } from '../../sync/view-store.ts';
import { I18nProvider } from '../../components/I18nProvider.tsx';
import { runtimeFetch } from '../../lib/runtime-fetch.ts';
import { registerRuntimeAPIs } from '../../lib/api/registry.ts';
import * as serverFiles from '../../lib/files/server-api.ts';
import type { RuntimeAPIs } from '../../lib/api/types.ts';
import { getProjectContext } from '../../lib/project-context-api.ts';
import { useGlobalSyncStore } from '../../sync/global-stores.ts';

declare global { var IS_REACT_ACT_ENVIRONMENT: boolean | undefined; }
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let rootHandle: Root | null = null;

beforeEach(() => {
  registerRuntimeAPIs({ files: {
    listDirectory: serverFiles.listDirectory, search: serverFiles.searchWorkspaceFiles,
    readFileStat: serverFiles.readFileStat, readFileText: serverFiles.readFileText,
    writeFileText: serverFiles.writeFileText, rawAssetUrl: serverFiles.rawAssetUrl,
    createDirectory: serverFiles.createDirectory, deleteEntry: serverFiles.deleteEntry,
    renameEntry: serverFiles.renameEntry,
  } } as unknown as RuntimeAPIs);
  vi.mocked(getProjectContext).mockReset().mockResolvedValue({ version: 2, notes: [], todos: [], plans: [], todosRevision: 'a'.repeat(64) });
  vi.mocked(runtimeFetch).mockImplementation(async () => ({ ok: false, status: 404, text: async () => '', clone: () => ({ json: async () => ({ error: 'File not found', reason: 'not-found' }) }) }) as Response);
});

afterEach(() => {
  act(() => rootHandle?.unmount());
  container?.remove();
  container = null;
  rootHandle = null;
  document.body.innerHTML = '';
  useSessionViewStore.setState({ currentSessionId: null, activeDirectory: '' });
  useGlobalSyncStore.setState({ projects: [] });
});

describe('OperatorRail Notes surface', () => {
  it('resolves the longest project worktree without a sibling-prefix match', () => {
    const projects = [{ id: 'outer', worktree: 'D:/work' }, { id: 'inner', worktree: 'D:/work/sub' }];
    expect(resolveContextProjectId('d:\\WORK\\sub\\src', projects)).toBe('inner');
    expect(resolveContextProjectId('D:/workspace', projects)).toBeNull();
    expect(resolveContextProjectId('D:/work/../other', projects)).toBeNull();
    expect(resolveContextProjectId('D:/work', [...projects, { id: 'ambiguous', worktree: 'D:/work' }])).toBeNull();
  });
  it('opens canonical project General, Todos, and Plans before legacy workspace files', async () => {
    const store = createDirectoryStore();
    useGlobalSyncStore.setState({ projects: [{ id: 'p1', worktree: 'D:/work' }] });
    container = document.createElement('div'); document.body.appendChild(container); rootHandle = createRoot(container);
    await act(async () => { rootHandle!.render(<I18nProvider><OperatorRail store={store} engine={{} as never} directory="D:/work" compactOpen /></I18nProvider>); });
    await act(async () => { (container!.querySelector('button[aria-label="Notes"]') as HTMLButtonElement).click(); });
    expect(getProjectContext).toHaveBeenCalledWith('p1');
    expect(container!.querySelector('[data-testid="project-context-notes"]')).not.toBeNull();
    expect(container!.textContent).toContain('Project-owned notes');
    expect(container!.querySelector('[aria-label="Legacy workspace notes"]')).toBeNull();
    expect(vi.mocked(runtimeFetch).mock.calls.some(([url]) => String(url).includes('general-notes.md'))).toBe(false);
    await act(async () => { [...container!.querySelectorAll('[data-testid="project-notes"] button')]
      .find((button) => button.textContent === 'Plans')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve(); });
    expect(container!.querySelector('[data-testid="project-context-plans"]')).not.toBeNull();
    await act(async () => { [...container!.querySelectorAll('[data-testid="project-notes"] button')]
      .find((button) => button.textContent === 'Todos')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve(); });
    expect(container!.querySelector('[data-testid="project-context-todos"]')).not.toBeNull();
    await act(async () => { ([...container!.querySelectorAll('[data-testid="project-notes"] button')]
      .find((button) => button.textContent?.startsWith('Workspace files')) as HTMLButtonElement).click(); });
    expect(container!.textContent).toContain('nothing has been moved');
    expect(container!.querySelector('[aria-label="Legacy workspace notes"]')).not.toBeNull();
    await act(async () => { ([...container!.querySelectorAll('[data-testid="project-notes"] button')]
      .find((button) => button.textContent === 'Note file') as HTMLButtonElement).click(); });
    expect(container!.textContent).toContain('General notes');
    expect(container!.querySelector('[aria-label="Search project notes, todos, and plan titles"]')).toBeNull();
    await act(async () => { ([...container!.querySelectorAll('[data-testid="project-notes"] button')]
      .find((button) => button.textContent === 'General') as HTMLButtonElement).click(); });
    expect(container!.querySelector('[aria-label="Search project notes, todos, and plan titles"]')).not.toBeNull();
  });
  it('shows refreshable cross-tab search counts and navigates to a matching section', async () => {
    useGlobalSyncStore.setState({ projects: [{ id: 'p1', worktree: 'D:/work' }] });
    vi.mocked(getProjectContext).mockResolvedValue({ version: 2,
      notes: [{ id: 'n1', body: 'Alpha context', source: 'manual', createdAt: 1, updatedAt: 1 }],
      todos: [{ id: 't1', text: 'Alpha task', completed: false, createdAt: 1 }],
      plans: [{ id: 'p1', title: 'Beta plan', file: 'p1.md', createdAt: 1 }], todosRevision: 'a'.repeat(64) });
    container = document.createElement('div'); document.body.appendChild(container); rootHandle = createRoot(container);
    await act(async () => { rootHandle!.render(<I18nProvider><OperatorRail store={createDirectoryStore()} engine={{} as never} directory="D:/work" compactOpen /></I18nProvider>); });
    await act(async () => { (container!.querySelector('button[aria-label="Notes"]') as HTMLButtonElement).click(); });
    const search = container!.querySelector('[aria-label="Search project notes, todos, and plan titles"]') as HTMLInputElement;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'alpha');
      search.dispatchEvent(new Event('input', { bubbles: true })); await Promise.resolve(); });
    expect(container!.querySelector('[aria-label="General: 1 snapshot matches"]')).not.toBeNull();
    expect(container!.querySelector('[aria-label="Todos: 1 snapshot matches"]')).not.toBeNull();
    expect(container!.querySelector('[aria-label="Plans: 0 snapshot matches"]')).not.toBeNull();
    await act(async () => { (container!.querySelector('[aria-label="Todos: 1 snapshot matches"]') as HTMLButtonElement).click(); });
    expect(container!.querySelector('[data-testid="project-context-todos"]')!.textContent).toContain('Alpha task');
  });
  it('does not advertise matches in stored entries that sections refuse to display', async () => {
    useGlobalSyncStore.setState({ projects: [{ id: 'p1', worktree: 'D:/work' }] });
    vi.mocked(getProjectContext).mockResolvedValue({ version: 2,
      notes: [{ body: 'Alpha hidden note' } as never],
      todos: [{ id: 't1', text: 'Alpha task', completed: false, createdAt: 1 }, { id: 'bad', text: 'Alpha malformed' }],
      plans: [{ title: 'Alpha hidden plan' }], todosRevision: 'a'.repeat(64) });
    container = document.createElement('div'); document.body.appendChild(container); rootHandle = createRoot(container);
    await act(async () => { rootHandle!.render(<I18nProvider><OperatorRail store={createDirectoryStore()} engine={{} as never} directory="D:/work" compactOpen /></I18nProvider>); });
    await act(async () => { (container!.querySelector('button[aria-label="Notes"]') as HTMLButtonElement).click(); });
    const search = container!.querySelector('[aria-label="Search project notes, todos, and plan titles"]') as HTMLInputElement;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'alpha');
      search.dispatchEvent(new Event('input', { bubbles: true })); await Promise.resolve(); });
    expect(container!.querySelector('[aria-label="General: 0 snapshot matches"]')).not.toBeNull();
    expect(container!.querySelector('[aria-label="Todos: 0 snapshot matches"]')).not.toBeNull();
    expect(container!.querySelector('[aria-label="Plans: 0 snapshot matches"]')).not.toBeNull();
  });
  it('retains context drafts per project across directory switches', async () => {
    const store = createDirectoryStore();
    useGlobalSyncStore.setState({ projects: [
      { id: 'p1', worktree: 'D:/one' }, { id: 'p2', worktree: 'D:/two' },
    ] });
    container = document.createElement('div'); document.body.appendChild(container); rootHandle = createRoot(container);
    const open = async (directory: string): Promise<void> => {
      await act(async () => { rootHandle!.render(<I18nProvider><OperatorRail store={store} engine={{} as never} directory={directory} compactOpen /></I18nProvider>); });
      await act(async () => { (container!.querySelector('button[aria-label="Notes"]') as HTMLButtonElement).click(); });
    };
    const enter = async (value: string): Promise<void> => {
      const area = container!.querySelector('textarea[aria-label="New context note"]') as HTMLTextAreaElement;
      await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, value);
        area.dispatchEvent(new Event('input', { bubbles: true })); });
    };
    await open('D:/one'); await enter('Draft one');
    await open('D:/two');
    expect((container!.querySelector('textarea[aria-label="New context note"]') as HTMLTextAreaElement).value).toBe('');
    await enter('Draft two');
    await open('D:/one');
    expect((container!.querySelector('textarea[aria-label="New context note"]') as HTMLTextAreaElement).value).toBe('Draft one');
    await open('D:/two');
    expect((container!.querySelector('textarea[aria-label="New context note"]') as HTMLTextAreaElement).value).toBe('Draft two');
  });
  it('keeps project notes distinct and opens the plan editor on demand', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    rootHandle = createRoot(container);
    await act(async () => {
      rootHandle!.render(
        <I18nProvider>
          <OperatorRail store={createDirectoryStore()} engine={{} as never} directory="D:/work" />
        </I18nProvider>,
      );
      await Promise.resolve();
    });

    await act(async () => {
      (document.querySelector('button[aria-label="Notes"]') as HTMLButtonElement).click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(document.querySelector('[data-testid="project-notes"]')!.textContent).toContain('General notes');
    await act(async () => {
      ([...document.querySelectorAll('[data-testid="project-notes"] button')].find((button) => button.textContent === 'Plans') as HTMLButtonElement).click();
      await Promise.resolve();
    });
    expect(document.querySelector('[data-testid="plan-view"]')).not.toBeNull();
    expect(document.querySelector('[data-plan-host] textarea')).not.toBeNull();
  });

  it('does not let a failed notes read overwrite an existing note', async () => {
    vi.mocked(runtimeFetch).mockImplementation(async () => ({ ok: false, status: 403, clone: () => ({ json: async () => ({ error: 'Access denied' }) }) }) as Response);
    container = document.createElement('div'); document.body.appendChild(container); rootHandle = createRoot(container);
    await act(async () => { rootHandle!.render(<I18nProvider><OperatorRail store={createDirectoryStore()} engine={{} as never} directory="D:/work" /></I18nProvider>); });
    await act(async () => { (document.querySelector('button[aria-label="Notes"]') as HTMLButtonElement).click(); });
    const notes = document.querySelector('[data-testid="project-notes"]')!;
    expect(notes.textContent).toContain('Load failed');
    expect((notes.querySelector('textarea') as HTMLTextAreaElement).disabled).toBe(true);
    expect(([...notes.querySelectorAll('button')].find((button) => button.textContent === 'Save notes') as HTMLButtonElement).disabled).toBe(true);
    expect(vi.mocked(runtimeFetch).mock.calls.every(([, init]) => init?.method !== 'POST')).toBe(true);
  });

  it('does not replace malformed saved todos with an empty list', async () => {
    vi.mocked(runtimeFetch).mockImplementation(async () => ({ ok: true, status: 200, text: async () => '{broken' }) as Response);
    container = document.createElement('div'); document.body.appendChild(container); rootHandle = createRoot(container);
    await act(async () => { rootHandle!.render(<I18nProvider><OperatorRail store={createDirectoryStore()} engine={{} as never} directory="D:/work" /></I18nProvider>); });
    await act(async () => { (document.querySelector('button[aria-label="Notes"]') as HTMLButtonElement).click(); });
    await act(async () => { ([...document.querySelectorAll('[data-testid="project-notes"] button')].find((button) => button.textContent === 'Todos') as HTMLButtonElement).click(); });
    const todos = document.querySelector('[data-testid="project-notes"]')!;
    expect(todos.textContent).toContain('Load failed');
    expect((todos.querySelector('input') as HTMLInputElement).disabled).toBe(true);
    expect(([...todos.querySelectorAll('button')].find((button) => button.textContent === 'Add') as HTMLButtonElement).disabled).toBe(true);
    expect(vi.mocked(runtimeFetch).mock.calls.every(([, init]) => init?.method !== 'POST')).toBe(true);
  });

  it('does not confuse an unknown read endpoint with a missing note', async () => {
    vi.mocked(runtimeFetch).mockImplementation(async () => ({ ok: false, status: 404, clone: () => ({ json: async () => ({ error: 'Not Found' }) }) }) as Response);
    container = document.createElement('div'); document.body.appendChild(container); rootHandle = createRoot(container);
    await act(async () => { rootHandle!.render(<I18nProvider><OperatorRail store={createDirectoryStore()} engine={{} as never} directory="D:/work" /></I18nProvider>); });
    await act(async () => { (document.querySelector('button[aria-label="Notes"]') as HTMLButtonElement).click(); });
    const notes = document.querySelector('[data-testid="project-notes"]')!;
    expect(notes.textContent).toContain('Load failed');
    expect((notes.querySelector('textarea') as HTMLTextAreaElement).disabled).toBe(true);
    expect(([...notes.querySelectorAll('button')].find((button) => button.textContent === 'Save notes') as HTMLButtonElement).disabled).toBe(true);
  });

  it('keeps an unsaved note draft while visiting other tabs and rail surfaces', async () => {
    container = document.createElement('div'); document.body.appendChild(container); rootHandle = createRoot(container);
    await act(async () => { rootHandle!.render(<I18nProvider><OperatorRail store={createDirectoryStore()} engine={{} as never} directory="D:/work" /></I18nProvider>); });
    await act(async () => { (document.querySelector('button[aria-label="Notes"]') as HTMLButtonElement).click(); });
    const note = document.querySelector('[data-testid="project-notes"] textarea') as HTMLTextAreaElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(note, 'Draft to keep');
      note.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { ([...document.querySelectorAll('[data-testid="project-notes"] button')].find((button) => button.textContent === 'Todos') as HTMLButtonElement).click(); });
    await act(async () => { (document.querySelector('button[aria-label="Activity"]') as HTMLButtonElement).click(); });
    await act(async () => { (document.querySelector('button[aria-label="Notes"]') as HTMLButtonElement).click(); });
    await act(async () => { ([...document.querySelectorAll('[data-testid="project-notes"] button')].find((button) => button.textContent === 'General') as HTMLButtonElement).click(); });
    expect((document.querySelector('[data-testid="project-notes"] textarea') as HTMLTextAreaElement).value).toBe('Draft to keep');
    expect(document.querySelector('[data-testid="project-notes"]')!.textContent).toContain('Unsaved');
    expect(vi.mocked(runtimeFetch).mock.calls.every(([, init]) => init?.method !== 'POST')).toBe(true);
  });

  it('retains one unsaved draft across project switches and locks a second project until it is saved', async () => {
    const fetch = vi.mocked(runtimeFetch);
    container = document.createElement('div'); document.body.appendChild(container); rootHandle = createRoot(container);
    const render = async (directory: string): Promise<void> => {
      await act(async () => { rootHandle!.render(<I18nProvider><OperatorRail store={createDirectoryStore()} engine={{} as never} directory={directory} /></I18nProvider>); });
      await act(async () => { (document.querySelector('button[aria-label="Notes"]') as HTMLButtonElement).click(); await Promise.resolve(); });
    };
    await render('D:/work-a');
    const note = document.querySelector('[data-testid="project-notes"] textarea') as HTMLTextAreaElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(note, 'Draft A');
      note.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await render('D:/work-b');
    expect((document.querySelector('[data-testid="project-notes"] textarea') as HTMLTextAreaElement).disabled).toBe(true);
    expect(document.querySelector('[data-testid="project-notes"]')!.textContent).toContain('Unsaved notes in another project');
    expect(fetch.mock.calls.every(([, init]) => init?.method !== 'POST')).toBe(true);
    await render('D:/work-a');
    expect((document.querySelector('[data-testid="project-notes"] textarea') as HTMLTextAreaElement).value).toBe('Draft A');
    fetch.mockImplementation(async (_url, init) => init?.method === 'POST'
      ? ({ ok: false, status: 500, clone: () => ({ json: async () => ({ error: 'Write failed' }) }) }) as Response
      : ({ ok: false, status: 404, clone: () => ({ json: async () => ({ error: 'File not found', reason: 'not-found' }) }) }) as Response);
    await act(async () => { ([...document.querySelectorAll('[data-testid="project-notes"] button')].find((button) => button.textContent === 'Save notes') as HTMLButtonElement).click(); await Promise.resolve(); await Promise.resolve(); });
    expect(document.querySelector('[data-testid="project-notes"]')!.textContent).toContain('Save failed');
    await render('D:/work-b');
    expect((document.querySelector('[data-testid="project-notes"] textarea') as HTMLTextAreaElement).disabled).toBe(true);
    await render('D:/work-a');
    fetch.mockImplementation(async (_url, init) => init?.method === 'POST'
      ? ({ ok: true, status: 200 }) as Response
      : ({ ok: false, status: 404, clone: () => ({ json: async () => ({ error: 'File not found', reason: 'not-found' }) }) }) as Response);
    await act(async () => { ([...document.querySelectorAll('[data-testid="project-notes"] button')].find((button) => button.textContent === 'Save notes') as HTMLButtonElement).click(); await Promise.resolve(); await Promise.resolve(); });
    await render('D:/work-b');
    expect((document.querySelector('[data-testid="project-notes"] textarea') as HTMLTextAreaElement).disabled).toBe(false);
  });

  it('retries an ambiguous read without losing a retained draft or writing before recovery', async () => {
    const fetch = vi.mocked(runtimeFetch);
    fetch.mockClear();
    container = document.createElement('div'); document.body.appendChild(container); rootHandle = createRoot(container);
    const render = async (directory: string): Promise<void> => {
      await act(async () => { rootHandle!.render(<I18nProvider><OperatorRail store={createDirectoryStore()} engine={{} as never} directory={directory} /></I18nProvider>); });
      await act(async () => { (document.querySelector('button[aria-label="Notes"]') as HTMLButtonElement).click(); });
    };
    await render('D:/work-a');
    const note = document.querySelector('[data-testid="project-notes"] textarea') as HTMLTextAreaElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(note, 'Draft A');
      note.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await render('D:/work-b');
    fetch.mockImplementation(async () => ({ ok: false, status: 500, clone: () => ({ json: async () => ({ error: 'Read failed' }) }) }) as Response);
    await render('D:/work-a');
    const notes = document.querySelector('[data-testid="project-notes"]')!;
    expect((notes.querySelector('textarea') as HTMLTextAreaElement).value).toBe('Draft A');
    expect((notes.querySelector('textarea') as HTMLTextAreaElement).disabled).toBe(true);
    expect(([...notes.querySelectorAll('button')].find((button) => button.textContent === 'Save notes') as HTMLButtonElement).disabled).toBe(true);
    expect(fetch.mock.calls.every(([, init]) => init?.method !== 'POST')).toBe(true);
    fetch.mockImplementation(async () => ({ ok: false, status: 404, clone: () => ({ json: async () => ({ error: 'File not found', reason: 'not-found' }) }) }) as Response);
    await act(async () => { ([...notes.querySelectorAll('button')].find((button) => button.textContent === 'Retry load') as HTMLButtonElement).click(); });
    expect((notes.querySelector('textarea') as HTMLTextAreaElement).value).toBe('Draft A');
    expect((notes.querySelector('textarea') as HTMLTextAreaElement).disabled).toBe(false);
    expect(([...notes.querySelectorAll('button')].find((button) => button.textContent === 'Save notes') as HTMLButtonElement).disabled).toBe(false);
  });

  it('deactivates the plan editor when Notes is hidden and reloads it on return', async () => {
    container = document.createElement('div'); document.body.appendChild(container); rootHandle = createRoot(container);
    await act(async () => { rootHandle!.render(<I18nProvider><OperatorRail store={createDirectoryStore()} engine={{} as never} directory="D:/plan-visibility" compactOpen /></I18nProvider>); });
    await act(async () => { (document.querySelector('button[aria-label="Notes"]') as HTMLButtonElement).click(); });
    await act(async () => { ([...document.querySelectorAll('[data-testid="project-notes"] button')].find((button) => button.textContent === 'Plans') as HTMLButtonElement).click(); });
    const planReads = (): number => vi.mocked(runtimeFetch).mock.calls.filter(([url]) => typeof url === 'string' && url.includes('/api/fs/read?') && url.includes('plans')).length;
    expect(planReads()).toBe(1);
    await act(async () => { (document.querySelector('button[aria-label="Activity"]') as HTMLButtonElement).click(); });
    await act(async () => { (document.querySelector('button[aria-label="Notes"]') as HTMLButtonElement).click(); });
    expect(planReads()).toBe(2);
  });
});
