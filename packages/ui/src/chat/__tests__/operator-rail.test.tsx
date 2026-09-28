// SPDX-License-Identifier: Apache-2.0
/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createDirectoryStore } from '../../sync/child-store.ts';
import { OperatorRail } from '../operator-rail.tsx';
import { I18nProvider } from '../../components/I18nProvider.tsx';
import { useSessionViewStore } from '../../sync/view-store.ts';
import { useGlobalSessionStatusStore } from '../../sync/global-stores.ts';
import * as runtimeSwitch from '../../lib/runtime-switch.ts';
import { harnessClient } from '../../lib/nnd/client.ts';
import * as runtimeFetch from '../../lib/runtime-fetch.ts';
import { useGitStore } from '../../lib/git/store.ts';

vi.mock('../../components/terminal/TerminalView.tsx', () => ({ TerminalView: ({ visible }: { visible: boolean }) => <div data-testid="terminal-keepalive-controller" data-visible={visible} /> }));

declare global { var IS_REACT_ACT_ENVIRONMENT: boolean | undefined; }
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let rootHandle: Root | null = null;

afterEach(() => {
  act(() => rootHandle?.unmount());
  container?.remove();
  container = null;
  rootHandle = null;
  document.body.innerHTML = '';
  window.localStorage.clear();
  useSessionViewStore.setState({ currentSessionId: null, activeDirectory: '' });
  useGlobalSessionStatusStore.getState().reset();
  useGitStore.getState().__resetForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('OperatorRail', () => {
  it('shows newly added panes for complete older layouts but honors a later hide', () => {
    vi.spyOn(runtimeSwitch, 'getRuntimeKey').mockReturnValue('local');
    const key = 'nnd.operator-rail.panels:local:nnd.operator-rail.surface:D:/work';
    const older = ['context', 'activity', 'changes', 'walkthrough', 'notes', 'browser', 'terminal'];
    window.localStorage.setItem(key, JSON.stringify({ order: older, visible: older.filter((id) => id !== 'notes') }));
    container = document.createElement('div'); document.body.appendChild(container); rootHandle = createRoot(container);
    act(() => rootHandle!.render(<OperatorRail store={createDirectoryStore()} engine={{} as never} directory="D:/work" />));
    expect(document.querySelector('nav button[aria-label="Worktrees"]')).not.toBeNull();
    expect(document.querySelector('nav button[aria-label="Files"]')).not.toBeNull();
    expect(document.querySelector('nav button[aria-label="Notes"]')).toBeNull();
    act(() => (document.querySelector('button[aria-label="Customize operator panels"]') as HTMLButtonElement).click());
    act(() => (document.querySelector('input[aria-label="Show Worktrees"]') as HTMLInputElement).click());
    expect(document.querySelector('nav button[aria-label="Worktrees"]')).toBeNull();
    act(() => rootHandle!.render(<OperatorRail store={createDirectoryStore()} engine={{} as never} directory="D:/other" />));
    act(() => rootHandle!.render(<OperatorRail store={createDirectoryStore()} engine={{} as never} directory="D:/work" />));
    expect(document.querySelector('nav button[aria-label="Worktrees"]')).toBeNull();
    expect(document.querySelector('nav button[aria-label="Files"]')).not.toBeNull();
  });

  it('reveals Files after a complete pre-Files layout, then preserves a deliberate hide', () => {
    vi.spyOn(runtimeSwitch, 'getRuntimeKey').mockReturnValue('local');
    const key = 'nnd.operator-rail.panels:local:nnd.operator-rail.surface:D:/work';
    const older = ['context', 'activity', 'changes', 'worktrees', 'walkthrough', 'notes', 'browser', 'terminal'];
    window.localStorage.setItem(key, JSON.stringify({ order: older, visible: older }));
    container = document.createElement('div'); document.body.appendChild(container); rootHandle = createRoot(container);
    act(() => rootHandle!.render(<OperatorRail store={createDirectoryStore()} engine={{} as never} directory="D:/work" />));
    expect(document.querySelector('nav button[aria-label="Files"]')).not.toBeNull();
    act(() => (document.querySelector('button[aria-label="Customize operator panels"]') as HTMLButtonElement).click());
    act(() => (document.querySelector('input[aria-label="Show Files"]') as HTMLInputElement).click());
    act(() => rootHandle!.render(<OperatorRail store={createDirectoryStore()} engine={{} as never} directory="D:/other" />));
    act(() => rootHandle!.render(<OperatorRail store={createDirectoryStore()} engine={{} as never} directory="D:/work" />));
    expect(document.querySelector('nav button[aria-label="Files"]')).toBeNull();
  });

  it('keeps the read-only Files preview when another rail surface is selected', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }));
    vi.spyOn(runtimeFetch, 'runtimeFetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/api/fs/list')) return new Response(JSON.stringify({ entries: [{ name: 'note.txt', path: 'D:/work/note.txt', isDirectory: false, isFile: true }] }), { headers: { 'content-type': 'application/json' } });
      if (url.includes('/api/fs/stat')) return new Response(JSON.stringify({ path: 'D:/work/note.txt', isFile: true, size: 12, mtimeMs: 1 }), { headers: { 'content-type': 'application/json' } });
      if (url.includes('/api/fs/read')) return new Response('preview text');
      return new Response(JSON.stringify({ isGitRepository: false, files: [] }), { headers: { 'content-type': 'application/json' } });
    });
    container = document.createElement('div'); document.body.appendChild(container); rootHandle = createRoot(container);
    await act(async () => rootHandle!.render(<I18nProvider><OperatorRail store={createDirectoryStore()} engine={{} as never} directory="D:/work" /></I18nProvider>));
    await act(async () => { (document.querySelector('button[aria-label="Files"]') as HTMLButtonElement).click(); await Promise.resolve(); });
    await act(async () => { (document.querySelector('button[title="D:/work/note.txt"]') as HTMLButtonElement).click(); await Promise.resolve(); });
    const preview = document.querySelector('[data-testid="operator-file-preview"]') as HTMLElement;
    expect(preview.textContent).toContain('preview text');
    await act(async () => (document.querySelector('button[aria-label="Context"]') as HTMLButtonElement).click());
    expect(document.querySelector('[data-testid="operator-file-preview"]')).toBe(preview);
    await act(async () => (document.querySelector('button[aria-label="Files"]') as HTMLButtonElement).click());
    expect(document.querySelector('[data-testid="operator-file-preview"]')).toBe(preview);
  });

  it('opens Worktrees beside chat and keeps the pane across rail surface switches', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }));
    vi.spyOn(runtimeFetch, 'runtimeFetch').mockImplementation(async () => new Response(JSON.stringify({ worktrees: [] }), {
      headers: { 'content-type': 'application/json' },
    }));
    container = document.createElement('div'); document.body.appendChild(container); rootHandle = createRoot(container);
    await act(async () => rootHandle!.render(<I18nProvider><OperatorRail store={createDirectoryStore()} engine={{} as never} directory="D:/work" /></I18nProvider>));
    await act(async () => { (document.querySelector('button[aria-label="Worktrees"]') as HTMLButtonElement).click(); await Promise.resolve(); });
    const view = document.querySelector('[data-testid="worktrees-view"]') as HTMLElement;
    expect(view).not.toBeNull();
    expect(view.className).not.toContain('fixed inset-0');
    await act(async () => (document.querySelector('button[aria-label="Context"]') as HTMLButtonElement).click());
    expect(document.querySelector('[data-testid="worktrees-view"]')).toBe(view);
    expect(view.parentElement?.className).toContain('hidden');
    await act(async () => (document.querySelector('button[aria-label="Worktrees"]') as HTMLButtonElement).click());
    expect(document.querySelector('[data-testid="worktrees-view"]')).toBe(view);
  });

  it('maximizes an inspection surface without losing its selected pane or saved dock width', () => {
    vi.stubGlobal('innerWidth', 1280);
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }));
    container = document.createElement('div'); document.body.appendChild(container); rootHandle = createRoot(container);
    act(() => rootHandle!.render(<OperatorRail store={createDirectoryStore()} engine={{} as never} directory="D:/work" />));
    const rail = document.querySelector('[data-testid="operator-rail"]') as HTMLElement;
    const dockWidth = rail.style.width;
    act(() => (document.querySelector('button[aria-label="Maximize operator panel"]') as HTMLButtonElement).click());
    expect(rail.className).toContain('absolute inset-0');
    expect(rail.style.width).toBe('');
    expect((document.querySelector('[aria-label="Resize operator panel"]') as HTMLElement).className).toContain('hidden');
    act(() => (document.querySelector('button[aria-label="Activity"]') as HTMLButtonElement).click());
    expect(document.querySelector('[data-testid="operator-surface-title"]')?.textContent).toContain('Activity');
    expect(rail.className).toContain('absolute inset-0');
    act(() => (document.querySelector('button[aria-label="Activity"]') as HTMLButtonElement).click());
    expect(document.querySelector('[data-testid="operator-surface-title"]')?.className).not.toContain('hidden');
    expect(document.querySelector('button[aria-label="Restore operator panel"]')).not.toBeNull();
    act(() => (document.querySelector('button[aria-label="Restore operator panel"]') as HTMLButtonElement).click());
    expect(rail.className).not.toContain('absolute inset-0');
    expect(rail.style.width).toBe(dockWidth);
  });

  it('explains absent Context projections and summarizes the latest authored tool event', () => {
    container = document.createElement('div'); document.body.appendChild(container); rootHandle = createRoot(container);
    const store = createDirectoryStore();
    act(() => rootHandle!.render(<OperatorRail store={store} engine={{} as never} directory="D:/work" />));
    expect(document.querySelector('[data-testid="work-status-panel"]')?.textContent).toContain('Select a session');
    act(() => useSessionViewStore.setState({ currentSessionId: 's1' }));
    expect(document.querySelector('[data-testid="work-status-panel"]')?.textContent).toContain('not available for this session');
    act(() => store.getState().patch({ vcs: { branch: 'main' } }));
    expect(document.querySelector('[data-testid="work-status-panel"]')?.textContent).toContain('Branchmain');
    expect(document.querySelector('[data-testid="work-status-panel"]')?.textContent).toContain('not available for this session');
    act(() => store.getState().patch({ activity: [
      { id: 'other', sessionID: 's2', time: 2, kind: 'tool', status: 'failed', summary: 'Other tool' },
      { id: 'first', sessionID: 's1', time: 3, kind: 'tool', status: 'started', summary: 'fs_read_text: running' },
      { id: 'latest', sessionID: 's1', time: 4, kind: 'tool', status: 'completed', summary: 'fs_edit_text: succeeded' },
    ] }));
    const panel = document.querySelector('[data-testid="work-status-panel"]')!;
    expect(panel.textContent).toContain('Latest tool event');
    expect(panel.textContent).toContain('fs_edit_text: succeeded');
    expect(panel.textContent).not.toContain('Other tool');
  });

  it('reorders and hides panels per runtime and directory while keeping one available', () => {
    let runtime = 'local';
    vi.spyOn(runtimeSwitch, 'getRuntimeKey').mockImplementation(() => runtime);
    container = document.createElement('div'); document.body.appendChild(container); rootHandle = createRoot(container);
    const store = createDirectoryStore();
    act(() => rootHandle!.render(<OperatorRail store={store} engine={{} as never} directory="D:/work" />));
    act(() => (document.querySelector('button[aria-label="Customize operator panels"]') as HTMLButtonElement).click());
    act(() => (document.querySelector('button[aria-label="Move Activity up"]') as HTMLButtonElement).click());
    expect([...document.querySelectorAll('nav[aria-label="Operator surfaces"] button[aria-pressed]')].map((button) => button.getAttribute('aria-label')).slice(0, 2)).toEqual(['Activity', 'Context']);
    act(() => (document.querySelector('input[aria-label="Show Context"]') as HTMLInputElement).click());
    expect(document.querySelector('nav button[aria-label="Context"]')).toBeNull();
    expect(document.querySelector('[data-testid="operator-surface-title"]')?.textContent).toBe('Activity');
    expect(window.localStorage.getItem('nnd.operator-rail.surface:D:/work')).toBe('activity');
    for (const label of ['Changes', 'Files', 'Worktrees', 'Walkthrough', 'Notes', 'Browser', 'Terminal']) {
      act(() => (document.querySelector(`input[aria-label="Show ${label}"]`) as HTMLInputElement).click());
    }
    expect((document.querySelector('input[aria-label="Show Activity"]') as HTMLInputElement).disabled).toBe(true);
    const key = 'nnd.operator-rail.panels:local:nnd.operator-rail.surface:D:/work';
    expect(JSON.parse(window.localStorage.getItem(key)!).visible).toEqual(['activity']);
    act(() => rootHandle!.render(<OperatorRail store={store} engine={{} as never} directory="D:/other" />));
    expect(document.querySelector('nav button[aria-label="Context"]')).not.toBeNull();
    act(() => rootHandle!.render(<OperatorRail store={store} engine={{} as never} directory="D:/work" />));
    expect(document.querySelector('nav button[aria-label="Context"]')).toBeNull();
    runtime = 'host:other';
    act(() => rootHandle!.render(<OperatorRail store={store} engine={{} as never} directory="D:/work" />));
    expect(document.querySelector('nav button[aria-label="Context"]')).not.toBeNull();
  });

  it('repairs malformed saved panel preferences without losing any supported pane', () => {
    vi.spyOn(runtimeSwitch, 'getRuntimeKey').mockReturnValue('local');
    window.localStorage.setItem('nnd.operator-rail.panels:local:nnd.operator-rail.surface:D:/work', JSON.stringify({
      order: ['activity', 'activity', 'alien'], visible: ['activity', 'alien', 'activity'],
    }));
    container = document.createElement('div'); document.body.appendChild(container); rootHandle = createRoot(container);
    act(() => rootHandle!.render(<OperatorRail store={createDirectoryStore()} engine={{} as never} directory="D:/work" />));
    act(() => (document.querySelector('button[aria-label="Customize operator panels"]') as HTMLButtonElement).click());
    expect([...document.querySelectorAll('section[aria-label="Customize operator panels"] input[type="checkbox"]')]).toHaveLength(9);
    expect([...document.querySelectorAll('nav[aria-label="Operator surfaces"] button[aria-pressed]')].map((button) => button.getAttribute('aria-label'))).toEqual(['Activity']);
  });

  it('opens Walkthrough from Changes even when an older saved layout hides it', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }));
    vi.spyOn(runtimeSwitch, 'getRuntimeKey').mockReturnValue('local');
    vi.spyOn(runtimeFetch, 'runtimeFetch').mockImplementation(async () => new Response(JSON.stringify({
      isGitRepository: true, branch: 'main', files: [], trackingAhead: 0, trackingBehind: 0,
    }), { headers: { 'content-type': 'application/json' } }));
    const key = 'nnd.operator-rail.panels:local:nnd.operator-rail.surface:D:/work';
    window.localStorage.setItem(key, JSON.stringify({ order: ['context', 'changes'], visible: ['context', 'changes'] }));
    container = document.createElement('div'); document.body.appendChild(container); rootHandle = createRoot(container);
    await act(async () => { rootHandle!.render(<OperatorRail store={createDirectoryStore()} engine={{} as never} directory="D:/work" />); });
    await act(async () => (document.querySelector('button[aria-label="Changes"]') as HTMLButtonElement).click());
    await act(async () => (document.querySelector('[data-testid="git-open-walkthrough"]') as HTMLButtonElement).click());
    expect(document.querySelector('[data-testid="operator-surface-title"]')?.textContent).toContain('Walkthrough');
    expect(document.querySelector('nav button[aria-label="Walkthrough"]')).not.toBeNull();
    expect(JSON.parse(window.localStorage.getItem(key)!).visible).toContain('walkthrough');
  });

  it('keeps the Changes view and unsubmitted commit text while another surface is foregrounded', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }));
    let runtime = 'local';
    vi.spyOn(runtimeSwitch, 'getRuntimeKey').mockImplementation(() => runtime);
    vi.spyOn(runtimeFetch, 'runtimeFetch').mockImplementation(async () => new Response(JSON.stringify({
      isGitRepository: true, branch: 'main', files: [], trackingAhead: 0, trackingBehind: 0,
    }), { headers: { 'content-type': 'application/json' } }));
    container = document.createElement('div'); document.body.appendChild(container); rootHandle = createRoot(container);
    const store = createDirectoryStore();
    await act(async () => rootHandle!.render(<OperatorRail store={store} engine={{} as never} directory="D:/work" />));
    await act(async () => { (document.querySelector('button[aria-label="Changes"]') as HTMLButtonElement).click(); await Promise.resolve(); });
    const view = document.querySelector('[data-testid="git-view"]')!;
    const textarea = view.querySelector('textarea') as HTMLTextAreaElement;
    const setValue = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => { setValue.call(textarea, 'Keep this draft'); textarea.dispatchEvent(new Event('input', { bubbles: true })); });
    expect(textarea.value).toBe('Keep this draft');
    await act(async () => (document.querySelector('button[aria-label="Context"]') as HTMLButtonElement).click());
    expect(document.querySelector('[data-testid="git-view"]')).toBe(view);
    expect(view.parentElement?.className).toContain('hidden');
    expect(textarea.value).toBe('Keep this draft');
    await act(async () => (document.querySelector('button[aria-label="Changes"]') as HTMLButtonElement).click());
    expect(document.querySelector('[data-testid="git-view"]')).toBe(view);
    expect(view.parentElement?.className).not.toContain('hidden');
    expect(textarea.value).toBe('Keep this draft');
    runtime = 'host:other';
    await act(async () => rootHandle!.render(<OperatorRail store={store} engine={{} as never} directory="D:/work" />));
    await act(async () => { (document.querySelector('button[aria-label="Changes"]') as HTMLButtonElement).click(); await Promise.resolve(); });
    const otherRuntimeView = document.querySelector('[data-testid="git-view"]')!;
    expect(otherRuntimeView).not.toBe(view);
    expect((otherRuntimeView.querySelector('textarea') as HTMLTextAreaElement).value).toBe('');
  });

  it('does not replay a prior Activity review jump after leaving and returning to a workspace', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }));
    vi.spyOn(runtimeSwitch, 'getRuntimeKey').mockReturnValue('local');
    vi.spyOn(runtimeFetch, 'runtimeFetch').mockImplementation(async () => new Response(JSON.stringify({
      isGitRepository: true, workspacePrefix: '', branch: 'main', trackingAhead: 0, trackingBehind: 0,
      files: [{ path: 'work.ts', index: ' ', working_dir: 'M' }],
    }), { headers: { 'content-type': 'application/json' } }));
    useSessionViewStore.setState({ currentSessionId: 's1' });
    const store = createDirectoryStore({ activity: [{ id: 'write', sessionID: 's1', time: 1, kind: 'tool',
      status: 'completed', summary: 'file written', toolEvidence: { reviewPath: 'work.ts', reviewDirectory: 'D:/work' } }] });
    container = document.createElement('div'); document.body.appendChild(container); rootHandle = createRoot(container);
    await act(async () => rootHandle!.render(<OperatorRail store={store} engine={{} as never} directory="D:/work" />));
    await act(async () => (document.querySelector('button[aria-label="Activity"]') as HTMLButtonElement).click());
    await act(async () => { ([...document.querySelectorAll<HTMLButtonElement>('[data-testid="activity-rows"] button')]
      .find((button) => button.textContent === 'Review file in Changes') as HTMLButtonElement).click(); await Promise.resolve(); });
    expect(document.querySelector('button[aria-label="View diff for work.ts (working)"]')?.getAttribute('aria-pressed')).toBe('true');

    await act(async () => rootHandle!.render(<OperatorRail store={store} engine={{} as never} directory="D:/other" />));
    await act(async () => rootHandle!.render(<OperatorRail store={store} engine={{} as never} directory="D:/work" />));
    await act(async () => { (document.querySelector('button[aria-label="Changes"]') as HTMLButtonElement).click(); await Promise.resolve(); });
    expect(document.querySelector('button[aria-label="View diff for work.ts (working)"]')?.getAttribute('aria-pressed')).toBe('false');
  });

  it('pauses retained Changes status polling while another surface is foregrounded', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }));
    const fetch = vi.spyOn(runtimeFetch, 'runtimeFetch').mockImplementation(async () => new Response(JSON.stringify({
      isGitRepository: true, workspacePrefix: '', branch: 'main', files: [], trackingAhead: 0, trackingBehind: 0,
    }), { headers: { 'content-type': 'application/json' } }));
    container = document.createElement('div'); document.body.appendChild(container); rootHandle = createRoot(container);
    await act(async () => rootHandle!.render(<OperatorRail store={createDirectoryStore()} engine={{} as never} directory="D:/work" />));
    await act(async () => { (document.querySelector('button[aria-label="Changes"]') as HTMLButtonElement).click(); await Promise.resolve(); });
    await act(async () => (document.querySelector('button[aria-label="Context"]') as HTMLButtonElement).click());
    expect(document.querySelector('[data-testid="git-view"]')).not.toBeNull();
    const before = fetch.mock.calls.filter(([url]) => String(url).includes('/api/git/status')).length;
    vi.useFakeTimers();
    try {
      await act(async () => { await vi.advanceTimersByTimeAsync(31_000); });
      expect(fetch.mock.calls.filter(([url]) => String(url).includes('/api/git/status')).length).toBe(before);
    } finally { vi.useRealTimers(); }
  });

  it('does not let a hidden pane on a remote runtime overwrite the local selection', () => {
    let runtime = 'local';
    vi.spyOn(runtimeSwitch, 'getRuntimeKey').mockImplementation(() => runtime);
    const projectKey = 'nnd.operator-rail.surface:D:/work';
    window.localStorage.setItem(projectKey, 'context');
    window.localStorage.setItem(`nnd.operator-rail.panels:host:other:${projectKey}`, JSON.stringify({
      order: ['context', 'activity'], visible: ['activity'],
    }));
    container = document.createElement('div'); document.body.appendChild(container); rootHandle = createRoot(container);
    const store = createDirectoryStore();
    act(() => rootHandle!.render(<OperatorRail store={store} engine={{} as never} directory="D:/work" />));
    expect(document.querySelector('[data-testid="operator-surface-title"]')?.textContent).toBe('Context');
    runtime = 'host:other';
    act(() => rootHandle!.render(<OperatorRail store={store} engine={{} as never} directory="D:/work" />));
    expect(document.querySelector('[data-testid="operator-surface-title"]')?.textContent).toBe('Activity');
    expect(window.localStorage.getItem(projectKey)).toBe('context');
    runtime = 'local';
    act(() => rootHandle!.render(<OperatorRail store={store} engine={{} as never} directory="D:/work" />));
    expect(document.querySelector('[data-testid="operator-surface-title"]')?.textContent).toBe('Context');
  });

  it('hides an active terminal without disposing its mounted session', () => {
    vi.spyOn(runtimeSwitch, 'getRuntimeKey').mockReturnValue('local');
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }));
    container = document.createElement('div'); document.body.appendChild(container); rootHandle = createRoot(container);
    act(() => rootHandle!.render(<OperatorRail store={createDirectoryStore()} engine={{} as never} directory="D:/work" />));
    act(() => (document.querySelector('button[aria-label="Terminal"]') as HTMLButtonElement).click());
    const terminal = document.querySelector('[data-testid="terminal-keepalive-controller"]');
    expect(terminal?.getAttribute('data-visible')).toBe('true');
    act(() => (document.querySelector('button[aria-label="Customize operator panels"]') as HTMLButtonElement).click());
    act(() => (document.querySelector('input[aria-label="Show Terminal"]') as HTMLInputElement).click());
    expect(document.querySelector('button[aria-label="Terminal"]')).toBeNull();
    expect(document.querySelector('[data-testid="terminal-keepalive-controller"]')).toBe(terminal);
    expect(terminal?.getAttribute('data-visible')).toBe('false');
    act(() => (document.querySelector('input[aria-label="Show Terminal"]') as HTMLInputElement).click());
    act(() => (document.querySelector('button[aria-label="Terminal"]') as HTMLButtonElement).click());
    expect(document.querySelector('[data-testid="terminal-keepalive-controller"]')).toBe(terminal);
    expect(terminal?.getAttribute('data-visible')).toBe('true');
  });

  it('loads authenticated NNA Activity history when the surface opens', async () => {
    useSessionViewStore.setState({ currentSessionId: 's1' });
    const history = vi.spyOn(harnessClient, 'listActivity').mockResolvedValue({ data: [
      { id: 'saved-turn', sessionID: 's1', time: 12, kind: 'turn', status: 'completed', summary: 'Saved turn completed' },
    ] } as never);
    const store = createDirectoryStore({ config: { nnd: { engine: 'nna' } } as never });
    container = document.createElement('div'); document.body.appendChild(container); rootHandle = createRoot(container);
    await act(async () => { rootHandle!.render(<OperatorRail store={store} engine={{} as never} directory="D:/work" />); });
    await act(async () => { (document.querySelector('button[aria-label="Activity"]') as HTMLButtonElement).click(); await Promise.resolve(); });
    expect(history).toHaveBeenCalledWith('s1', { directory: 'D:/work' });
    expect(document.querySelector('[data-testid="operator-activity"]')!.textContent).toContain('Saved turn completed');
  });

  it('distinguishes unselected, loading, and genuinely empty Activity history', async () => {
    let finish!: (value: unknown) => void;
    vi.spyOn(harnessClient, 'listActivity').mockImplementation(() => new Promise((resolve) => { finish = resolve; }) as never);
    const store = createDirectoryStore({ config: { nnd: { engine: 'nna' } } as never });
    container = document.createElement('div'); document.body.appendChild(container); rootHandle = createRoot(container);
    await act(async () => rootHandle!.render(<OperatorRail store={store} engine={{} as never} directory="D:/work" />));
    await act(async () => (document.querySelector('button[aria-label="Activity"]') as HTMLButtonElement).click());
    expect(document.querySelector('[data-testid="activity-rows"]')?.textContent).toContain('Select a session');
    await act(async () => useSessionViewStore.setState({ currentSessionId: 's1' }));
    expect(document.querySelector('[data-testid="activity-rows"]')?.textContent).toContain('Loading saved activity');
    await act(async () => store.getState().patch({ activity: [
      { id: 'live', sessionID: 's1', time: 5, kind: 'tool', status: 'completed', summary: 'Live tool' },
    ] }));
    expect(document.querySelector('[data-testid="operator-activity"]')?.textContent).toContain('showing live evidence so far');
    await act(async () => store.getState().patch({ activity: [] }));
    await act(async () => ([...document.querySelectorAll<HTMLButtonElement>('[data-testid="operator-activity"] button')]
      .find((button) => button.textContent === 'Failures') as HTMLButtonElement).click());
    expect(document.querySelector('[data-testid="activity-rows"]')?.textContent).toContain('Loading saved activity');
    await act(async () => finish({ data: [] }));
    expect(document.querySelector('[data-testid="activity-rows"]')?.textContent).toContain('No failed activity evidence');
    await act(async () => ([...document.querySelectorAll<HTMLButtonElement>('[data-testid="operator-activity"] button')]
      .find((button) => button.textContent === 'All') as HTMLButtonElement).click());
    expect(document.querySelector('[data-testid="activity-rows"]')?.textContent).toContain('No recorded activity for this session yet');
    expect(document.querySelector('[data-testid="activity-rows"]')?.textContent).toContain('transcript');
  });

  it('lets the operator retry an unavailable saved Activity snapshot', async () => {
    useSessionViewStore.setState({ currentSessionId: 's1' });
    const history = vi.spyOn(harnessClient, 'listActivity')
      .mockRejectedValueOnce(new Error('temporary disconnect'))
      .mockResolvedValueOnce({ data: [{ id: 'saved-turn', sessionID: 's1', time: 12, kind: 'turn', status: 'completed', summary: 'Recovered turn' }] } as never);
    const store = createDirectoryStore({ config: { nnd: { engine: 'nna' } } as never });
    container = document.createElement('div'); document.body.appendChild(container); rootHandle = createRoot(container);
    await act(async () => rootHandle!.render(<OperatorRail store={store} engine={{} as never} directory="D:/work" />));
    await act(async () => { (document.querySelector('button[aria-label="Activity"]') as HTMLButtonElement).click(); await Promise.resolve(); });
    expect(document.querySelector('[data-testid="operator-activity"]')?.textContent).toContain('Saved activity unavailable');
    expect(document.querySelector('[data-testid="activity-rows"]')?.textContent).toContain('could not be loaded');
    await act(async () => ([...document.querySelectorAll<HTMLButtonElement>('[data-testid="operator-activity"] button')]
      .find((button) => button.textContent === 'Failures') as HTMLButtonElement).click());
    expect(document.querySelector('[data-testid="activity-rows"]')?.textContent).toContain('could not be loaded');
    await act(async () => { (document.querySelector('[data-testid="operator-activity"] button:not([aria-pressed])') as HTMLButtonElement).click(); await Promise.resolve(); });
    expect(history).toHaveBeenCalledTimes(2);
    await act(async () => ([...document.querySelectorAll<HTMLButtonElement>('[data-testid="operator-activity"] button')]
      .find((button) => button.textContent === 'All') as HTMLButtonElement).click());
    expect(document.querySelector('[data-testid="operator-activity"]')?.textContent).toContain('Recovered turn');
    expect(document.querySelector('[data-testid="operator-activity"]')?.textContent).not.toContain('Saved activity unavailable');
  });

  it('resizes the desktop pane by keyboard and restores width per runtime and surface', () => {
    vi.stubGlobal('innerWidth', 1280);
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }));
    let activeRuntime = 'local';
    vi.spyOn(runtimeSwitch, 'getRuntimeKey').mockImplementation(() => activeRuntime);
    container = document.createElement('div');
    document.body.appendChild(container);
    rootHandle = createRoot(container);
    act(() => rootHandle!.render(<OperatorRail store={createDirectoryStore()} engine={{} as never} directory="D:/work" />));
    const rail = document.querySelector('[data-testid="operator-rail"]') as HTMLElement;
    const separator = document.querySelector('[aria-label="Resize operator panel"]') as HTMLElement;
    expect(rail.style.width).toBe('341px');
    act(() => separator.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true })));
    expect(rail.style.width).toBe('365px');
    expect(separator.getAttribute('aria-valuenow')).toBe('324');
    act(() => separator.dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: 500, bubbles: true })));
    act(() => window.dispatchEvent(new MouseEvent('pointermove', { clientX: 460 })));
    act(() => window.dispatchEvent(new MouseEvent('pointerup')));
    expect(rail.style.width).toBe('405px');
    act(() => (document.querySelector('button[aria-label="Browser"]') as HTMLButtonElement).click());
    expect(rail.style.width).toBe('512px');
    vi.stubGlobal('innerWidth', 1100);
    act(() => window.dispatchEvent(new Event('resize')));
    expect(rail.style.width).toBe('332px');
    vi.stubGlobal('innerWidth', 400);
    act(() => window.dispatchEvent(new Event('resize')));
    expect(rail.style.width).toBe('321px');
    vi.stubGlobal('innerWidth', 1280);
    act(() => window.dispatchEvent(new Event('resize')));
    expect(rail.style.width).toBe('512px');
    act(() => (document.querySelector('button[aria-label="Context"]') as HTMLButtonElement).click());
    expect(rail.style.width).toBe('405px');
    activeRuntime = 'host:other';
    act(() => rootHandle!.render(<OperatorRail store={createDirectoryStore()} engine={{} as never} directory="D:/work" />));
    expect(rail.style.width).toBe('341px');
    activeRuntime = 'local';
    act(() => rootHandle!.render(<OperatorRail store={createDirectoryStore()} engine={{} as never} directory="D:/work" />));
    expect(rail.style.width).toBe('405px');
    expect([...Array(window.localStorage.length)].map((_, index) => window.localStorage.key(index)).some((key) => key?.includes('nnd.operator-rail.width:local:'))).toBe(true);
    act(() => rootHandle!.render(<OperatorRail store={createDirectoryStore()} engine={{} as never} directory="D:/work" compactOpen />));
    expect(rail.style.width).toBe('');
  });
  it('tracks a pointer drag back to its starting width', () => {
    vi.stubGlobal('innerWidth', 1280);
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }));
    vi.spyOn(runtimeSwitch, 'getRuntimeKey').mockReturnValue('local');
    container = document.createElement('div'); document.body.appendChild(container); rootHandle = createRoot(container);
    act(() => rootHandle!.render(<OperatorRail store={createDirectoryStore()} engine={{} as never} directory="D:/work" />));
    const rail = document.querySelector('[data-testid="operator-rail"]') as HTMLElement;
    const separator = document.querySelector('[aria-label="Resize operator panel"]') as HTMLElement;
    act(() => separator.dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: 500, bubbles: true })));
    act(() => window.dispatchEvent(new MouseEvent('pointermove', { clientX: 460 })));
    expect(rail.style.width).toBe('381px');
    act(() => window.dispatchEvent(new MouseEvent('pointermove', { clientX: 500 })));
    act(() => window.dispatchEvent(new MouseEvent('pointerup')));
    expect(rail.style.width).toBe('341px');
    expect(window.localStorage.getItem('nnd.operator-rail.width:local:nnd.operator-rail.surface:D:/work:context')).toBe('300');
  });
  it('keeps an icon dock visible at the installed desktop width and opens panels on demand', () => {
    vi.stubGlobal('innerWidth', 1265);
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('1024px'), addEventListener: () => undefined, removeEventListener: () => undefined,
    }));
    container = document.createElement('div');
    document.body.appendChild(container);
    rootHandle = createRoot(container);
    act(() => rootHandle!.render(<OperatorRail store={createDirectoryStore()} engine={{} as never} directory="D:/work" />));
    const rail = document.querySelector('[data-testid="operator-rail"]') as HTMLElement;
    expect(rail.style.width).toBe('41px');
    expect(rail.className).toContain('flex');
    act(() => (document.querySelector('button[aria-label="Notes"]') as HTMLButtonElement).click());
    expect(rail.style.width).toBe('341px');
    expect(document.querySelector('[data-testid="operator-surface-title"]')?.textContent).toContain('Notes');
    act(() => (document.querySelector('button[aria-label="Close operator panel"]') as HTMLButtonElement).click());
    expect(rail.style.width).toBe('41px');
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Notes');
    expect(document.activeElement?.getAttribute('aria-pressed')).toBe('true');
  });
  it('restores dock visibility per workspace and runtime without carrying another project\'s open state', () => {
    vi.stubGlobal('innerWidth', 1265);
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('1024px'), addEventListener: () => undefined, removeEventListener: () => undefined,
    }));
    let runtime = 'local';
    vi.spyOn(runtimeSwitch, 'getRuntimeKey').mockImplementation(() => runtime);
    container = document.createElement('div'); document.body.appendChild(container); rootHandle = createRoot(container);
    const store = createDirectoryStore();
    act(() => rootHandle!.render(<OperatorRail store={store} engine={{} as never} directory="D:/first" />));
    const rail = document.querySelector('[data-testid="operator-rail"]') as HTMLElement;
    expect(rail.style.width).toBe('41px');
    act(() => (document.querySelector('button[aria-label="Activity"]') as HTMLButtonElement).click());
    expect(rail.style.width).toBe('341px');
    expect(window.localStorage.getItem('nnd.operator-rail.open:local:nnd.operator-rail.surface:D:/first')).toBe('open');

    act(() => rootHandle!.render(<OperatorRail store={store} engine={{} as never} directory="D:/second" />));
    expect(rail.style.width).toBe('41px');
    act(() => (document.querySelector('button[aria-label="Context"]') as HTMLButtonElement).click());
    act(() => (document.querySelector('button[aria-label="Close operator panel"]') as HTMLButtonElement).click());
    expect(window.localStorage.getItem('nnd.operator-rail.open:local:nnd.operator-rail.surface:D:/second')).toBe('closed');

    act(() => rootHandle!.render(<OperatorRail store={store} engine={{} as never} directory="D:/first" />));
    expect(rail.style.width).toBe('341px');
    expect(document.querySelector('[data-testid="operator-surface-title"]')?.textContent).toContain('Activity');
    runtime = 'host:other';
    act(() => rootHandle!.render(<OperatorRail store={store} engine={{} as never} directory="D:/first" />));
    expect(rail.style.width).toBe('41px');
    runtime = 'local';
    act(() => rootHandle!.render(<OperatorRail store={store} engine={{} as never} directory="D:/first" />));
    expect(rail.style.width).toBe('341px');
  });
  it('does not save an untouched viewport default as a panel preference', () => {
    let wide = false;
    vi.stubGlobal('innerWidth', 1265);
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('1024px') || (query.includes('1280px') && wide),
      addEventListener: () => undefined, removeEventListener: () => undefined,
    }));
    vi.spyOn(runtimeSwitch, 'getRuntimeKey').mockReturnValue('local');
    container = document.createElement('div'); document.body.appendChild(container); rootHandle = createRoot(container);
    const store = createDirectoryStore();
    const openKey = 'nnd.operator-rail.open:local:nnd.operator-rail.surface:D:/work';
    act(() => rootHandle!.render(<OperatorRail store={store} engine={{} as never} directory="D:/work" />));
    expect((document.querySelector('[data-testid="operator-rail"]') as HTMLElement).style.width).toBe('41px');
    expect(window.localStorage.getItem(openKey)).toBeNull();
    act(() => rootHandle!.unmount());
    wide = true;
    vi.stubGlobal('innerWidth', 1600);
    rootHandle = createRoot(container);
    act(() => rootHandle!.render(<OperatorRail store={store} engine={{} as never} directory="D:/work" />));
    expect((document.querySelector('[data-testid="operator-rail"]') as HTMLElement).style.width).not.toBe('41px');
    expect(window.localStorage.getItem(openKey)).toBeNull();
  });
  it('gives new wide-screen panels a substantial width while respecting a saved narrow preference', () => {
    vi.stubGlobal('innerWidth', 3440);
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }));
    vi.spyOn(runtimeSwitch, 'getRuntimeKey').mockReturnValue('local');
    container = document.createElement('div');
    document.body.appendChild(container);
    rootHandle = createRoot(container);
    const store = createDirectoryStore();
    act(() => rootHandle!.render(<OperatorRail store={store} engine={{} as never} directory="D:/wide" />));
    const rail = document.querySelector('[data-testid="operator-rail"]') as HTMLElement;
    expect(rail.style.width).toBe('1241px');
    vi.stubGlobal('innerWidth', 1100);
    act(() => window.dispatchEvent(new Event('resize')));
    expect(rail.style.width).toBe('332px');
    expect(window.localStorage.getItem('nnd.operator-rail.width:local:nnd.operator-rail.surface:D:/wide:context')).toBeNull();
    vi.stubGlobal('innerWidth', 3440);
    act(() => window.dispatchEvent(new Event('resize')));
    expect(rail.style.width).toBe('1241px');
    window.localStorage.setItem('nnd.operator-rail.width:local:nnd.operator-rail.surface:D:/narrow:context', '300');
    act(() => rootHandle!.render(<OperatorRail store={store} engine={{} as never} directory="D:/narrow" />));
    expect(rail.style.width).toBe('341px');
  });
  it('lets an older narrow preference return to responsive fitting without replacing widths in other workspaces', () => {
    vi.stubGlobal('innerWidth', 3440);
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }));
    vi.spyOn(runtimeSwitch, 'getRuntimeKey').mockReturnValue('local');
    const narrowKey = 'nnd.operator-rail.width:local:nnd.operator-rail.surface:D:/work:context';
    const otherKey = 'nnd.operator-rail.width:local:nnd.operator-rail.surface:D:/other:context';
    window.localStorage.setItem(narrowKey, '300');
    window.localStorage.setItem(otherKey, '420');
    container = document.createElement('div'); document.body.appendChild(container); rootHandle = createRoot(container);
    const store = createDirectoryStore();
    act(() => rootHandle!.render(<OperatorRail store={store} engine={{} as never} directory="D:/work" />));
    const rail = document.querySelector('[data-testid="operator-rail"]') as HTMLElement;
    expect(rail.style.width).toBe('341px');
    act(() => (document.querySelector('button[aria-label="Fit operator panel to window"]') as HTMLButtonElement).click());
    expect(rail.style.width).toBe('1241px');
    expect(window.localStorage.getItem(narrowKey)).toBeNull();
    expect(window.localStorage.getItem(otherKey)).toBe('420');
    vi.stubGlobal('innerWidth', 1100);
    act(() => window.dispatchEvent(new Event('resize')));
    expect(rail.style.width).toBe('332px');
    vi.stubGlobal('innerWidth', 3440);
    act(() => window.dispatchEvent(new Event('resize')));
    expect(rail.style.width).toBe('1241px');
    expect(window.localStorage.getItem(narrowKey)).toBeNull();
    act(() => rootHandle!.render(<OperatorRail store={store} engine={{} as never} directory="D:/other" />));
    expect(rail.style.width).toBe('461px');
    act(() => rootHandle!.render(<OperatorRail store={store} engine={{} as never} directory="D:/work" />));
    expect(rail.style.width).toBe('1241px');
  });
  it('does not pin the viewport cap when Fit is used in a narrow desktop window', () => {
    vi.stubGlobal('innerWidth', 1100);
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }));
    vi.spyOn(runtimeSwitch, 'getRuntimeKey').mockReturnValue('local');
    const key = 'nnd.operator-rail.width:local:nnd.operator-rail.surface:D:/work:context';
    window.localStorage.setItem(key, '500');
    container = document.createElement('div'); document.body.appendChild(container); rootHandle = createRoot(container);
    act(() => rootHandle!.render(<OperatorRail store={createDirectoryStore()} engine={{} as never} directory="D:/work" />));
    const rail = document.querySelector('[data-testid="operator-rail"]') as HTMLElement;
    expect(rail.style.width).toBe('332px');
    act(() => (document.querySelector('button[aria-label="Fit operator panel to window"]') as HTMLButtonElement).click());
    expect(window.localStorage.getItem(key)).toBeNull();
    vi.stubGlobal('innerWidth', 3440);
    act(() => window.dispatchEvent(new Event('resize')));
    expect(rail.style.width).toBe('1241px');
    expect(window.localStorage.getItem(key)).toBeNull();
  });
  it('restores an ultrawide panel without crushing chat on a normal desktop', () => {
    vi.stubGlobal('innerWidth', 1265);
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }));
    vi.spyOn(runtimeSwitch, 'getRuntimeKey').mockReturnValue('local');
    window.localStorage.setItem('nnd.operator-rail.width:local:nnd.operator-rail.surface:D:/work:context', '1200');
    container = document.createElement('div');
    document.body.appendChild(container);
    rootHandle = createRoot(container);
    act(() => rootHandle!.render(<OperatorRail store={createDirectoryStore()} engine={{} as never} directory="D:/work" />));
    const rail = document.querySelector('[data-testid="operator-rail"]') as HTMLElement;
    expect(rail.style.width).toBe('497px'); // 456px panel + 41px dock; 480px chat remains beside the sidebar.
    const separator = document.querySelector('[aria-label="Resize operator panel"]') as HTMLElement;
    act(() => separator.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true })));
    expect(rail.style.width).toBe('497px');
    expect(window.localStorage.getItem('nnd.operator-rail.width:local:nnd.operator-rail.surface:D:/work:context')).toBe('1200');
    vi.stubGlobal('innerWidth', 3440);
    act(() => window.dispatchEvent(new Event('resize')));
    expect(rail.style.width).toBe('1241px');
  });
  it('keeps the foreground compact pane open when it becomes a desktop dock', () => {
    vi.stubGlobal('innerWidth', 1100);
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('1024px'), addEventListener: () => undefined, removeEventListener: () => undefined,
    }));
    container = document.createElement('div');
    document.body.appendChild(container);
    rootHandle = createRoot(container);
    const store = createDirectoryStore();
    act(() => rootHandle!.render(<OperatorRail store={store} engine={{} as never} directory="D:/work" compactOpen />));
    act(() => (document.querySelector('button[aria-label="Notes"]') as HTMLButtonElement).click());
    act(() => rootHandle!.render(<OperatorRail store={store} engine={{} as never} directory="D:/work" />));
    const rail = document.querySelector('[data-testid="operator-rail"]') as HTMLElement;
    expect(rail.style.width).toBe('332px');
    expect(document.querySelector('[data-testid="operator-surface-title"]')?.textContent).toContain('Notes');
  });
  it('stops terminal foreground work when the desktop rail becomes compact-hidden', () => {
    let change: ((event: MediaQueryListEvent) => void) | undefined;
    vi.stubGlobal('matchMedia', () => ({
      matches: true,
      addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => { change = listener; },
      removeEventListener: () => undefined,
    }));
    window.localStorage.setItem('nnd.operator-rail.surface:D:/work', 'terminal');
    const store = createDirectoryStore();
    container = document.createElement('div');
    document.body.appendChild(container);
    rootHandle = createRoot(container);
    act(() => rootHandle!.render(<OperatorRail store={store} engine={{} as never} directory="D:/work" />));
    const terminal = document.querySelector('[data-testid="terminal-keepalive-controller"]');
    expect(terminal?.getAttribute('data-visible')).toBe('true');
    act(() => change?.({ matches: false } as MediaQueryListEvent));
    expect(document.querySelector('[data-testid="terminal-keepalive-controller"]')).toBe(terminal);
    expect(terminal?.getAttribute('data-visible')).toBe('false');
    act(() => rootHandle!.render(<OperatorRail store={store} engine={{} as never} directory="D:/work" compactOpen />));
    expect(terminal?.getAttribute('data-visible')).toBe('true');
  });
  it('keeps an opened terminal mounted but not visible while focus mode suppresses the rail', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }));
    window.localStorage.setItem('nnd.operator-rail.surface:D:/work', 'terminal');
    const store = createDirectoryStore();
    container = document.createElement('div');
    document.body.appendChild(container);
    rootHandle = createRoot(container);
    act(() => rootHandle!.render(<OperatorRail store={store} engine={{} as never} directory="D:/work" />));
    const terminal = document.querySelector('[data-testid="terminal-keepalive-controller"]');
    expect(terminal?.getAttribute('data-visible')).toBe('true');
    act(() => rootHandle!.render(<OperatorRail store={store} engine={{} as never} directory="D:/work" suppressed />));
    const rail = document.querySelector('[data-testid="operator-rail"]')!;
    expect(rail.className).toContain('hidden');
    expect(rail.className).not.toContain('xl:flex');
    expect(document.querySelector('[data-testid="terminal-keepalive-controller"]')).toBe(terminal);
    expect(terminal?.getAttribute('data-visible')).toBe('false');
  });
  it('exposes one full-width compact surface with a return-to-chat control', () => {
    const store = createDirectoryStore();
    const close = vi.fn();
    container = document.createElement('div');
    document.body.appendChild(container);
    rootHandle = createRoot(container);
    act(() => rootHandle!.render(<OperatorRail store={store} engine={{} as never} directory="D:/work" compactOpen onCloseCompact={close} />));
    const rail = document.querySelector('[data-testid="operator-rail"]')!;
    expect(rail.className).toContain('w-full xl:w-[300px]');
    expect(rail.className).not.toContain('hidden xl:flex');
    act(() => (document.querySelector('[data-testid="operator-return-chat"]') as HTMLButtonElement).click());
    expect(close).toHaveBeenCalledOnce();
  });
  it('shows NNA estimated context without inventing provider-billed usage', () => {
    useSessionViewStore.setState({ currentSessionId: 's1' });
    const store = createDirectoryStore({ session: [{ id: 's1', metadata: { nnd: { context: {
      estimatedTokens: 4_000, limitTokens: 16_000, measurement: 'estimated', observedAt: 1,
    } } }, time: { created: 1, updated: 1 } }] as never });
    container = document.createElement('div');
    document.body.appendChild(container);
    rootHandle = createRoot(container);
    act(() => rootHandle!.render(<OperatorRail store={store} engine={{} as never} directory="D:/work" />));
    const context = document.querySelector('[data-testid="work-status-panel"]')!;
    expect(context.textContent).toContain('25.0% estimated');
    expect(context.textContent).toContain('4,000 tokens');
    expect(context.textContent).toContain('16,000 tokens');
    expect(context.textContent).not.toContain('$0.00');
  });

  it('shows an NNA-authored turn phase even when context measurement is unavailable', () => {
    useSessionViewStore.setState({ currentSessionId: 's1' });
    const store = createDirectoryStore({ session: [{ id: 's1', metadata: { nnd: { turnState: {
      phase: 'awaiting_approval', secret: 'never render',
    } } }, time: { created: 1, updated: 1 } }] as never });
    container = document.createElement('div'); document.body.appendChild(container); rootHandle = createRoot(container);
    act(() => rootHandle!.render(<OperatorRail store={store} engine={{} as never} directory="D:/work" />));
    const panel = document.querySelector('[data-testid="work-status-panel"]')!;
    expect(panel.textContent).toContain('Reviewing tool use');
    expect(panel.textContent).not.toContain('never render');
    act(() => store.getState().patch({ session: [{ id: 's1', metadata: { nnd: { turnState: { phase: 'idle' } } },
      time: { created: 1, updated: 2 } }] as never }));
    expect(panel.textContent).toContain('Idle');
  });

  it('shows NNA governance classifications and pending operator requests without exposing metadata extras', () => {
    useSessionViewStore.setState({ currentSessionId: 's1' });
    const store = createDirectoryStore({
      session: [{ id: 's1', metadata: { nnd: { governance: { reviewPosture: 'auto-review', recordHealth: 'attention', durable: true,
        attentionEvidence: 2, unsettledDecisions: 1, uncertainEffects: 0, privateNote: 'never render' } } }, time: { created: 1, updated: 1 } }] as never,
      permission: { s1: [{ id: 'p1' }] } as never,
      question: { s1: [{ id: 'q1' }] } as never,
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    rootHandle = createRoot(container);
    act(() => rootHandle!.render(<OperatorRail store={store} engine={{} as never} directory="D:/work" />));
    const context = document.querySelector('[data-testid="work-status-panel"]')!;
    expect(context.textContent).toContain('auto-review');
    expect(context.textContent).toContain('Needs attention');
    expect(context.textContent).toContain('Unsettled decisions');
    expect(context.textContent).toContain('Approvals');
    expect(context.textContent).toContain('Questions');
    expect(context.textContent).not.toContain('never render');
  });

  it('shows live NNA goal and tasks while ignoring compatibility todos and private work evidence', () => {
    useSessionViewStore.setState({ currentSessionId: 's1' });
    const store = createDirectoryStore({
      config: { nnd: { engine: 'nna' } } as never,
      session: [{ id: 's1', metadata: { nnd: { work: {
        revision: 2,
        goal: { id: 'goal_1', objective: 'Build the desktop', status: 'active', evidence: 'private proof' },
        tasks: [{ id: 'T1', title: 'Connect work rail', status: 'in_progress', evidence: 'private task proof' }],
      } } }, time: { created: 1, updated: 2 } }] as never,
      todo: { s1: [{ content: 'stale compatibility todo', status: 'pending', priority: 'low' }] } as never,
    });
    container = document.createElement('div'); document.body.appendChild(container); rootHandle = createRoot(container);
    act(() => rootHandle!.render(<OperatorRail store={store} engine={{} as never} directory="D:/work" />));
    const panel = document.querySelector('[data-testid="work-status-panel"]')!;
    expect(panel.textContent).toContain('Build the desktop');
    expect(panel.textContent).toContain('Connect work rail');
    expect(panel.textContent).toContain('in progress');
    expect(panel.textContent).not.toContain('stale compatibility todo');
    expect(panel.textContent).not.toContain('private proof');
    expect(panel.textContent).not.toContain('private task proof');
    act(() => store.getState().patch({ session: [{ id: 's1', metadata: { nnd: { work: {
      revision: 3, goal: null, tasks: [],
    } } }, time: { created: 1, updated: 3 } }] as never }));
    expect(panel.textContent).not.toContain('Build the desktop');
    expect(panel.textContent).not.toContain('Connect work rail');
    expect(panel.textContent).not.toContain('stale compatibility todo');
  });

  it('does not revive stale compatibility todos when NNA work is cleared before config arrives', () => {
    useSessionViewStore.setState({ currentSessionId: 's1' });
    const store = createDirectoryStore({
      session: [{ id: 's1', metadata: { nnd: { work: {
        revision: 3, goal: null, tasks: [],
      } } }, time: { created: 1, updated: 3 } }] as never,
      todo: { s1: [{ content: 'stale compatibility todo', status: 'pending', priority: 'low' }] } as never,
    });
    container = document.createElement('div'); document.body.appendChild(container); rootHandle = createRoot(container);
    act(() => rootHandle!.render(<OperatorRail store={store} engine={{} as never} directory="D:/work" />));
    expect(document.querySelector('[data-testid="work-status-panel"]')!.textContent).not.toContain('stale compatibility todo');
  });

  it('shows the same NNA-configured model identity as the composer', () => {
    useSessionViewStore.setState({ currentSessionId: 's1' });
    const store = createDirectoryStore({
      session: [{ id: 's1', time: { created: 1, updated: 1 } }] as never,
      config: { nnd: { engine: 'nna', modelSelection: 'configured', primaryModel: { providerID: 'local', modelID: 'code-main' } } } as never,
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    rootHandle = createRoot(container);
    act(() => rootHandle!.render(<OperatorRail store={store} engine={{} as never} directory="D:/work" />));
    const context = document.querySelector('[data-testid="work-status-panel"]')!;
    expect(context.textContent).toContain('Configured route');
    expect(context.textContent).toContain('local · code-main');
    act(() => store.getState().patch({ config: { nnd: { engine: 'nna', modelSelection: 'configured' } } as never }));
    expect(context.textContent).toContain('NNA model unavailable');
  });

  it('does not present the root model as a delegated child session model', () => {
    useSessionViewStore.setState({ currentSessionId: 'child' });
    const store = createDirectoryStore({
      session: [
        { id: 'root', time: { created: 1, updated: 1 } },
        { id: 'child', parentID: 'root', metadata: { nnd: { configuredModel: { providerID: 'delegated', modelID: 'child-only', endpoint: 'private endpoint' } } }, time: { created: 2, updated: 2 } },
      ] as never,
      config: { nnd: { engine: 'nna', modelSelection: 'configured', primaryModel: { providerID: 'primary', modelID: 'root-only' } } } as never,
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    rootHandle = createRoot(container);
    act(() => rootHandle!.render(<OperatorRail store={store} engine={{} as never} directory="D:/work" />));
    const context = document.querySelector('[data-testid="work-status-panel"]')!;
    expect(context.textContent).not.toContain('root-only');
    expect(context.textContent).toContain('delegated · child-only');
    expect(context.textContent).not.toContain('private endpoint');
    act(() => useSessionViewStore.getState().setCurrentSession('root'));
    expect(context.textContent).toContain('primary · root-only');
  });

  it('follows a selected session change even without a directory-store update', () => {
    useSessionViewStore.setState({ currentSessionId: 's1' });
    const store = createDirectoryStore({ session: [
      { id: 's1', metadata: { nnd: { context: { estimatedTokens: 4_000, limitTokens: 16_000, measurement: 'estimated' } } }, time: { created: 1, updated: 1 } },
      { id: 's2', metadata: { nnd: { context: { estimatedTokens: 8_000, limitTokens: 16_000, measurement: 'estimated' } } }, time: { created: 1, updated: 1 } },
    ] as never });
    container = document.createElement('div');
    document.body.appendChild(container);
    rootHandle = createRoot(container);
    act(() => rootHandle!.render(<OperatorRail store={store} engine={{} as never} directory="D:/work" />));
    expect(document.querySelector('[data-testid="work-status-panel"]')!.textContent).toContain('25.0% estimated');

    act(() => useSessionViewStore.getState().setCurrentSession('s2'));
    const context = document.querySelector('[data-testid="work-status-panel"]')!;
    expect(context.textContent).toContain('50.0% estimated');
    expect(context.textContent).not.toContain('25.0% estimated');
  });

  it('does not call an unreported subagent done and refreshes blocker precedence live', () => {
    useSessionViewStore.setState({ currentSessionId: 'parent' });
    const store = createDirectoryStore({ session: [
      { id: 'parent', time: { created: 1, updated: 1 } },
      { id: 'child', parentID: 'parent', title: 'Explorer', time: { created: 2, updated: 2 } },
    ] as never });
    container = document.createElement('div');
    document.body.appendChild(container);
    rootHandle = createRoot(container);
    act(() => rootHandle!.render(<OperatorRail store={store} engine={{} as never} directory="D:/work" />));
    const subagents = document.querySelector('[data-testid="ws-subagents"]')!;
    expect(subagents.textContent).toContain('No live status');
    expect(subagents.textContent).not.toContain('Done');

    act(() => useGlobalSessionStatusStore.getState().applyEvent('child', { type: 'busy' }));
    expect(subagents.textContent).toContain('working');
    act(() => store.getState().patch({ session: [
      { id: 'parent', time: { created: 1, updated: 1 } },
      { id: 'child', parentID: 'parent', title: 'Explorer', metadata: { nnd: { turnState: { phase: 'running_tool' } } },
        time: { created: 2, updated: 3 } },
    ] as never }));
    expect(subagents.textContent).toContain('Running tool');
    act(() => store.getState().patch({ permission: { child: [{ id: 'p1' }] } as never }));
    expect(subagents.textContent).toContain('needs permission');
    expect(subagents.textContent).not.toContain('Running tool');
    act(() => store.getState().patch({ permission: {}, question: { child: [{ id: 'q1' }] } as never }));
    expect(subagents.textContent).toContain('asked a question');
    act(() => store.getState().patch({ question: {} }));
    act(() => useGlobalSessionStatusStore.getState().applyEvent('child', { type: 'idle' }));
    expect(subagents.textContent).toContain('No live status');
    act(() => store.getState().patch({ session_status: { child: { type: 'idle' } } }));
    expect(subagents.textContent).toContain('Idle');
    expect(subagents.textContent).not.toContain('Done');
    act(() => store.getState().patch({ session_status: {}, sessionStatusReady: true }));
    expect(subagents.textContent).toContain('No live status');
    act(() => store.getState().patch({ session: [
      { id: 'parent', time: { created: 1, updated: 1 } },
      { id: 'child', parentID: 'parent', title: 'Explorer', metadata: { nnd: { turnState: { phase: 'idle' } } },
        time: { created: 2, updated: 4 } },
    ] as never }));
    expect(subagents.textContent).toContain('Idle');
    expect(subagents.textContent).not.toContain('No live status');
  });

  it('renders only explicit activity evidence and offers a bounded browser preview', () => {
    useSessionViewStore.setState({ currentSessionId: 's1' });
    const store = createDirectoryStore({ activity: [
      { id: 'a1', sessionID: 's1', time: 1, kind: 'tool', status: 'completed', summary: 'Applied patch' },
      { id: 'a2', sessionID: 's2', time: 2, kind: 'turn', status: 'completed', summary: 'Other session' },
    ] });
    container = document.createElement('div');
    document.body.appendChild(container);
    rootHandle = createRoot(container);
    act(() => rootHandle!.render(<OperatorRail store={store} engine={{} as never} directory="D:/work" />));
    expect(document.querySelector('[data-testid="operator-rail"]')).not.toBeNull();
    act(() => (document.querySelector('button[aria-label="Activity"]') as HTMLButtonElement).click());
    expect(document.querySelector('[data-testid="operator-activity"]')!.textContent).toContain('Applied patch');
    expect(document.querySelector('[data-testid="operator-activity"]')!.textContent).not.toContain('Other session');
    act(() => (document.querySelector('button[aria-label="Browser"]') as HTMLButtonElement).click());
    expect(document.querySelector('[data-testid="operator-browser"]')!.textContent).toContain('isolated web preview');
    expect(document.querySelector('[data-testid="operator-browser"] iframe')).toBeNull();
  });

  it('jumps from an authored turn to its loaded prompt without inventing links for tools or missing messages', () => {
    useSessionViewStore.setState({ currentSessionId: 's1' });
    const store = createDirectoryStore({
      message: { s1: [{ id: 'prompt_a', sessionID: 's1', role: 'user', time: { created: 1 } }] } as never,
      activity: [
        { id: 'turn-a', sessionID: 's1', time: 1, kind: 'turn', status: 'completed', summary: 'Done', evidenceMessageID: 'prompt_a' },
        { id: 'turn-b', sessionID: 's1', time: 2, kind: 'turn', status: 'completed', summary: 'Older', evidenceMessageID: 'missing' },
        { id: 'tool', sessionID: 's1', time: 3, kind: 'tool', status: 'completed', summary: 'Shell command' },
      ],
    });
    const anchor = document.createElement('div'); anchor.id = 'message-prompt_a';
    const scroll = vi.fn(); anchor.scrollIntoView = scroll; document.body.appendChild(anchor);
    container = document.createElement('div'); document.body.appendChild(container); rootHandle = createRoot(container);
    act(() => rootHandle!.render(<OperatorRail store={store} engine={{} as never} directory="D:/work" />));
    act(() => (document.querySelector('button[aria-label="Activity"]') as HTMLButtonElement).click());
    const links = [...document.querySelectorAll('[data-testid="activity-rows"] button')];
    expect(links).toHaveLength(1);
    expect(links[0]!.textContent).toBe('View prompt');
    act(() => (links[0] as HTMLButtonElement).click());
    expect(window.location.hash).toBe('#message-prompt_a');
    expect(scroll).toHaveBeenCalledWith({ block: 'start' });
  });

  it('expands authored tool metadata without exposing raw tool arguments or output', () => {
    useSessionViewStore.setState({ currentSessionId: 's1' });
    const store = createDirectoryStore({ activity: [{ id: 'tool-a', sessionID: 's1', time: 1, kind: 'tool',
      status: 'completed', summary: 'shell_run: succeeded', toolEvidence: {
        target: 'D:/work/check.js', effect: 'read_only', elapsedMs: 25, exitCode: 0,
      } }] });
    container = document.createElement('div'); document.body.appendChild(container); rootHandle = createRoot(container);
    act(() => rootHandle!.render(<OperatorRail store={store} engine={{} as never} directory="D:/work" />));
    act(() => (document.querySelector('button[aria-label="Activity"]') as HTMLButtonElement).click());
    const detail = document.querySelector('[data-testid="activity-tool-evidence"]') as HTMLDetailsElement;
    expect(detail.open).toBe(false);
    expect(detail.textContent).toContain('D:/work/check.js');
    expect(detail.textContent).toContain('25 ms');
    expect(detail.textContent).not.toContain('secret');
    act(() => (detail.querySelector('summary') as HTMLElement).click());
    expect(detail.open).toBe(true);
  });

  it('offers a Changes jump only for a completed tool with an authored review path', async () => {
    vi.spyOn(runtimeFetch, 'runtimeFetch').mockImplementation(async () => new Response(JSON.stringify({
      isGitRepository: false, branch: null, files: [], current: null,
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    useSessionViewStore.setState({ currentSessionId: 's1' });
    const store = createDirectoryStore({ activity: [
      { id: 'write', sessionID: 's1', time: 1, kind: 'tool', status: 'completed', summary: 'file written',
        toolEvidence: { reviewPath: 'src/check.js', reviewDirectory: 'D:/work' } },
      { id: 'read', sessionID: 's1', time: 2, kind: 'tool', status: 'completed', summary: 'file read',
        toolEvidence: { target: 'src/other.js' } },
    ] });
    container = document.createElement('div'); document.body.appendChild(container); rootHandle = createRoot(container);
    act(() => rootHandle!.render(<OperatorRail store={store} engine={{} as never} directory="D:/work" />));
    act(() => (document.querySelector('button[aria-label="Activity"]') as HTMLButtonElement).click());
    const jumps = [...document.querySelectorAll<HTMLButtonElement>('[data-testid="activity-rows"] button')]
      .filter((button) => button.textContent === 'Review file in Changes');
    expect(jumps).toHaveLength(1);
    await act(async () => { jumps[0]!.click(); await Promise.resolve(); });
    expect(document.querySelector('[data-testid="operator-surface-title"]')?.textContent).toBe('Changes');
  });

  it('does not offer an old workspace review path after the session changes workspace', () => {
    useSessionViewStore.setState({ currentSessionId: 's1' });
    const store = createDirectoryStore({ activity: [
      { id: 'old-write', sessionID: 's1', time: 1, kind: 'tool', status: 'completed', summary: 'old file written',
        toolEvidence: { reviewPath: 'src/check.js', reviewDirectory: 'D:/old-work' } },
    ] });
    container = document.createElement('div'); document.body.appendChild(container); rootHandle = createRoot(container);
    act(() => rootHandle!.render(<OperatorRail store={store} engine={{} as never} directory="D:/new-work" />));
    act(() => (document.querySelector('button[aria-label="Activity"]') as HTMLButtonElement).click());
    expect(document.querySelector('[data-testid="activity-rows"]')?.textContent).toContain('old file written');
    expect([...document.querySelectorAll<HTMLButtonElement>('[data-testid="activity-rows"] button')]
      .some((button) => button.textContent === 'Review file in Changes')).toBe(false);
  });

  it('filters activity to failures without claiming that all session evidence is absent', () => {
    useSessionViewStore.setState({ currentSessionId: 's1' });
    const store = createDirectoryStore({ activity: [
      { id: 'completed', sessionID: 's1', time: 1, kind: 'tool', status: 'completed', summary: 'Applied patch' },
      { id: 'failed', sessionID: 's1', time: 2, kind: 'tool', status: 'failed', summary: 'Command failed' },
    ] });
    container = document.createElement('div');
    document.body.appendChild(container);
    rootHandle = createRoot(container);
    act(() => rootHandle!.render(<OperatorRail store={store} engine={{} as never} directory="D:/work" />));
    act(() => (document.querySelector('button[aria-label="Activity"]') as HTMLButtonElement).click());
    act(() => ([...document.querySelectorAll('[data-testid="operator-activity"] button')].find((button) => button.textContent === 'Failures') as HTMLButtonElement).click());
    const activity = document.querySelector('[data-testid="operator-activity"]')!;
    expect(activity.textContent).toContain('Command failed');
    expect(activity.textContent).not.toContain('Applied patch');

    act(() => store.getState().patch({ activity: [{ id: 'completed', sessionID: 's1', time: 1, kind: 'tool', status: 'completed', summary: 'Applied patch' }] }));
    expect(activity.textContent).toContain('No failed activity evidence has been received for this session.');
    expect(activity.textContent).not.toContain('No activity evidence has been received for this session.');
  });

  it('highlights and filters only harness-authored needs-input activity', () => {
    useSessionViewStore.setState({ currentSessionId: 's1' });
    const store = createDirectoryStore({ activity: [
      { id: 'waiting', sessionID: 's1', time: 1, kind: 'turn', status: 'attention', summary: 'Turn needs input' },
      { id: 'failed', sessionID: 's1', time: 2, kind: 'tool', status: 'failed', summary: 'Command failed' },
      { id: 'normal', sessionID: 's1', time: 3, kind: 'turn', status: 'completed', summary: 'Turn completed' },
    ] });
    container = document.createElement('div'); document.body.appendChild(container); rootHandle = createRoot(container);
    act(() => rootHandle!.render(<OperatorRail store={store} engine={{} as never} directory="D:/work" />));
    act(() => (document.querySelector('button[aria-label="Activity"]') as HTMLButtonElement).click());
    const rows = document.querySelector('[data-testid="activity-rows"]')!;
    expect(rows.querySelectorAll('li')[0]!.className).toContain('border-amber');
    expect(rows.querySelectorAll('li')[1]!.className).toContain('border-red');
    expect(rows.querySelectorAll('li')[2]!.className).not.toContain('border-red');
    act(() => ([...document.querySelectorAll('[data-testid="operator-activity"] button')].find((button) => button.textContent === 'Needs input') as HTMLButtonElement).click());
    expect(rows.textContent).toContain('Turn needs input');
    expect(rows.textContent).not.toContain('Command failed');
    act(() => store.getState().patch({ activity: store.getState().activity.filter((record) => record.id !== 'waiting') }));
    expect(rows.textContent).toContain('No activity requiring input has been received for this session.');
  });

  it('filters authored categories and follows the live tail only while the reader is at the bottom', () => {
    useSessionViewStore.setState({ currentSessionId: 's1' });
    const store = createDirectoryStore({ activity: [
      { id: 'turn-1', sessionID: 's1', time: 1, kind: 'turn', status: 'started', summary: 'Started work' },
      { id: 'tool-1', sessionID: 's1', time: 2, kind: 'tool', status: 'completed', summary: 'Read file' },
    ] });
    container = document.createElement('div');
    document.body.appendChild(container);
    rootHandle = createRoot(container);
    act(() => rootHandle!.render(<OperatorRail store={store} engine={{} as never} directory="D:/work" />));
    act(() => (document.querySelector('button[aria-label="Activity"]') as HTMLButtonElement).click());
    const activity = document.querySelector('[data-testid="operator-activity"]')!;
    const rows = document.querySelector('[data-testid="activity-rows"]') as HTMLOListElement;
    Object.defineProperty(rows, 'scrollHeight', { configurable: true, value: 300 });
    Object.defineProperty(rows, 'clientHeight', { configurable: true, value: 100 });
    expect(rows.textContent).toContain('Started work');
    expect(rows.textContent).toContain('Read file');
    expect(rows.textContent!.indexOf('Started work')).toBeLessThan(rows.textContent!.indexOf('Read file'));
    act(() => ([...activity.querySelectorAll('button')].find((button) => button.textContent === 'Tools') as HTMLButtonElement).click());
    expect(rows.textContent).not.toContain('Started work');
    expect(rows.textContent).toContain('Read file');
    act(() => ([...activity.querySelectorAll('button')].find((button) => button.textContent === 'All') as HTMLButtonElement).click());

    // Browsing old entries must not jump when a new frame arrives.
    act(() => { rows.scrollTop = 0; rows.dispatchEvent(new Event('scroll', { bubbles: true })); });
    act(() => store.getState().patch({ activity: [
      ...store.getState().activity,
      { id: 'tool-2', sessionID: 's1', time: 3, kind: 'tool', status: 'started', summary: 'Run tests' },
    ] }));
    expect(rows.scrollTop).toBe(0);
    expect((document.querySelector('[data-testid="activity-jump-live"]') as HTMLButtonElement).textContent).toContain('1 new event');
    act(() => (document.querySelector('[data-testid="activity-jump-live"]') as HTMLButtonElement).click());
    expect(rows.scrollTop).toBe(300);
    expect(document.querySelector('[data-testid="activity-jump-live"]')).toBeNull();

    // The bounded activity store can replace an old row with a new row while
    // keeping the total count constant. That arrival still needs a badge.
    act(() => { rows.scrollTop = 0; rows.dispatchEvent(new Event('scroll', { bubbles: true })); });
    act(() => store.getState().patch({ activity: [
      ...store.getState().activity.slice(1),
      { id: 'tool-3', sessionID: 's1', time: 4, kind: 'tool', status: 'started', summary: 'Review tests' },
    ] }));
    expect((document.querySelector('[data-testid="activity-jump-live"]') as HTMLButtonElement).textContent).toContain('1 new event');
    act(() => store.getState().patch({ activity: store.getState().activity.map((record) => record.id === 'tool-3'
      ? { ...record, status: 'completed', summary: 'Reviewed tests' } : record) }));
    expect((document.querySelector('[data-testid="activity-jump-live"]') as HTMLButtonElement).textContent).toContain('1 new event');
  });

  it('loads the new directory preference without overwriting it during a live directory switch', () => {
    window.localStorage.setItem('nnd.operator-rail.surface:D:/alpha', 'activity');
    window.localStorage.setItem('nnd.operator-rail.surface:D:/beta', 'context');
    const store = createDirectoryStore();
    container = document.createElement('div');
    document.body.appendChild(container);
    rootHandle = createRoot(container);
    act(() => rootHandle!.render(<OperatorRail store={store} engine={{} as never} directory="D:/alpha" />));
    expect((document.querySelector('button[aria-label="Activity"]') as HTMLButtonElement).getAttribute('aria-pressed')).toBe('true');

    act(() => rootHandle!.render(<OperatorRail store={store} engine={{} as never} directory="D:/beta" />));
    expect((document.querySelector('button[aria-label="Context"]') as HTMLButtonElement).getAttribute('aria-pressed')).toBe('true');
    expect(window.localStorage.getItem('nnd.operator-rail.surface:D:/beta')).toBe('context');
    expect(window.localStorage.getItem('nnd.operator-rail.surface:D:/alpha')).toBe('activity');
  });

  it('uses one preference for equivalent Windows directory spellings', () => {
    window.localStorage.setItem('nnd.operator-rail.surface:D:/same-project', 'activity');
    const store = createDirectoryStore();
    container = document.createElement('div');
    document.body.appendChild(container);
    rootHandle = createRoot(container);
    act(() => rootHandle!.render(<OperatorRail store={store} engine={{} as never} directory={'d:\\same-project'} />));
    expect((document.querySelector('button[aria-label="Activity"]') as HTMLButtonElement).getAttribute('aria-pressed')).toBe('true');
  });
});
