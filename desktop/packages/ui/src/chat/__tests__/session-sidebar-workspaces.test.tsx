import { runtimeFetch } from '../../lib/runtime-fetch.ts';
import { useWorkspaceDisplayStore } from '../../stores/useWorkspaceDisplayStore.ts';
import { useWorkspaceStore } from '../../stores/useWorkspaceStore.ts';
// SPDX-License-Identifier: Apache-2.0
/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Session } from '../../lib/nnd/types.ts';
import { ChatSidebar } from '../session-sidebar.tsx';
import { useGlobalSessionsStore } from '../../sync/global-stores.ts';
import { useSessionFoldersStore } from '../../stores/useSessionFoldersStore.ts';
import { useSessionPinnedStore } from '../../stores/useSessionPinnedStore.ts';
import { useSessionExpansionStore } from '../../stores/useSessionExpansionStore.ts';
import { initializeRuntimeEndpoint, switchRuntimeEndpoint } from '../../lib/runtime-switch.ts';
import { addNativeWorkspace, readNativeWorkspaceAdmissions } from '../../lib/nnd/workspace-admission.ts';
import { hasNativeWorkspacePicker, pickWorkspaceDirectory } from '../../lib/nnd/workspace-picker.ts';
import type { WorkspaceAdmissionSelection } from '../../lib/nnd/workspace-admission.ts';

vi.mock('../../lib/nnd/workspace-admission.ts', () => ({
  addNativeWorkspace: vi.fn(), readNativeWorkspaceAdmissions: vi.fn(),
}));
vi.mock('../../lib/nnd/workspace-picker.ts', () => ({ hasNativeWorkspacePicker: vi.fn(), pickWorkspaceDirectory: vi.fn() }));

vi.mock('../../lib/runtime-fetch.ts', () => ({ runtimeFetch: vi.fn() }));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
initializeRuntimeEndpoint({ apiBaseUrl: 'http://127.0.0.1:61776', runtimeKey: 'local' });
let root: Root | null = null;
let container: HTMLDivElement | null = null;
let originalLoad: () => Promise<void>;
let originalSessionLoad: () => Promise<void>;

beforeEach(() => {
  useWorkspaceDisplayStore.setState({ rows: {}, error: null });
  vi.mocked(runtimeFetch).mockImplementation(async path => new Response(JSON.stringify(String(path).includes('workspace-browser')
    ? { path: 'D:/browser', parent: 'D:/', roots: ['D:/'], home: 'D:/', entries: [], truncated: false }
    : { version: 1, workspaces: {} })));
  useWorkspaceStore.getState().reset();
  vi.mocked(readNativeWorkspaceAdmissions).mockReset();
  vi.mocked(addNativeWorkspace).mockReset();
  vi.mocked(pickWorkspaceDirectory).mockReset();
  vi.mocked(hasNativeWorkspacePicker).mockReturnValue(true);
  vi.mocked(readNativeWorkspaceAdmissions).mockResolvedValue({
    installation_id: 'install', data_id: 'data', revision: 'absent', selection_enabled: true,
    attached: { root: 'D:/work', id: `ws_${'a'.repeat(24)}` }, admitted: [], unavailable: [],
  });
  localStorage.clear();
  useSessionPinnedStore.setState({ pins: {} });
  useSessionExpansionStore.setState({ expanded: {} });
  originalLoad = useSessionFoldersStore.getState().load;
  originalSessionLoad = useGlobalSessionsStore.getState().loadSessions;
  useSessionFoldersStore.setState({ load: async () => undefined, foldersByDirectory: {}, collapsedFolderIds: {} });
  useGlobalSessionsStore.setState({ loadSessions: async () => undefined });
});
afterEach(async () => {
  act(() => root?.unmount());
  await switchRuntimeEndpoint({ apiBaseUrl: 'http://127.0.0.1:61776', runtimeKey: 'local' });
  container?.remove();
  root = null;
  container = null;
  useGlobalSessionsStore.getState().reset();
  useGlobalSessionsStore.setState({ loadSessions: originalSessionLoad });
  useSessionFoldersStore.setState({ load: originalLoad, foldersByDirectory: {}, collapsedFolderIds: {} });
});

function session(id: string, directory: string, title: string): Session {
  return { id, directory, title, time: { created: 1, updated: 1 } } as Session;
}

function admittedSelection(directory: string, added = true): WorkspaceAdmissionSelection {
  return { directory, added, inventory: {
    installation_id: 'install', data_id: 'data', revision: 'absent', selection_enabled: true,
    attached: { root: 'D:/work', id: `ws_${'a'.repeat(24)}` },
    admitted: [{ root: directory, id: `ws_${'c'.repeat(24)}`, operation_id: 'new' }], unavailable: [],
  } };
}

function mount(currentDirectory: string, openDraft = vi.fn(), nativeAlpha = false): { node: HTMLDivElement; openDraft: ReturnType<typeof vi.fn> } {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<ChatSidebar engine={{} as never} nativeAlpha={nativeAlpha} currentDirectory={currentDirectory} currentSessionId={null}
    actions={{ openDraft, openSession: () => undefined, rename: async () => undefined,
      archive: async () => undefined, restore: async () => undefined, deleteSession: async () => undefined }} />));
  return { node: container, openDraft };
}

it('keeps the active workspace visible even before its first session', () => {
  const { node, openDraft } = mount('D:/work/Empty');
  const zone = node.querySelector('[data-testid="workspace-zone"]')!;
  expect(zone.textContent).toContain('Empty');
  expect(zone.querySelector('[data-testid="zone-empty"]')).toBeTruthy();
  act(() => (zone.querySelector('[aria-label="New draft session in D:/work/Empty"]') as HTMLButtonElement).click());
  expect(openDraft).toHaveBeenCalledWith('D:/work/Empty');
});

it('lists admitted empty workspaces and opens a new conversation in the selected root', async () => {
  vi.mocked(readNativeWorkspaceAdmissions).mockResolvedValue({
    installation_id: 'install', data_id: 'data', revision: 'absent', selection_enabled: true,
    attached: { root: 'D:/work', id: `ws_${'a'.repeat(24)}` },
    admitted: [{ root: 'D:/other', id: `ws_${'b'.repeat(24)}`, operation_id: 'prior' }], unavailable: [],
  });
  const { node, openDraft } = mount('D:/work', vi.fn(), true);
  await act(async () => { await Promise.resolve(); });
  expect([...node.querySelectorAll('[data-testid="workspace-zone"]')].map(zone => zone.textContent)).toEqual([
    expect.stringContaining('work'), expect.stringContaining('other'),
  ]);
  act(() => node.querySelector<HTMLButtonElement>('[aria-label="New draft session in D:/other"]')!.click());
  expect(openDraft).toHaveBeenCalledWith('D:/other');
});

it('opens the admitted workspace even when the project projection is unavailable', async () => {
  const { node, openDraft } = mount('D:/work', vi.fn(), true);
  await act(async () => { await Promise.resolve(); });
  vi.mocked(pickWorkspaceDirectory).mockResolvedValue('D:/new');
  vi.mocked(addNativeWorkspace).mockResolvedValue(admittedSelection('D:/new'));
  vi.mocked(readNativeWorkspaceAdmissions).mockResolvedValue({
    installation_id: 'install', data_id: 'data', revision: 'absent', selection_enabled: true,
    attached: { root: 'D:/work', id: `ws_${'a'.repeat(24)}` },
    admitted: [{ root: 'D:/new', id: `ws_${'c'.repeat(24)}`, operation_id: 'new' }], unavailable: [],
  });
  act(() => node.querySelector<HTMLButtonElement>('[aria-label="Add workspace"]')!.click());
  expect(node.querySelector('[role="dialog"]')).toBeNull();
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expect(pickWorkspaceDirectory).toHaveBeenCalledOnce();
  expect(openDraft).toHaveBeenCalledWith('D:/new');
  expect(node.querySelector('[data-workspace-directory="D:/new"]')).toBeTruthy();
});

it('opens search from the header and applies the workspace order filter', () => {
  useGlobalSessionsStore.setState({ active: [session('a', 'D:/zeta', 'Old'),
    { ...session('b', 'D:/alpha', 'New'), time: { created: 2, updated: 20 } }] });
  const { node } = mount('D:/work');
  const search = node.querySelector<HTMLInputElement>('[data-testid="sidebar-search"]')!;
  expect(search.closest('.hidden')).toBeTruthy();
  act(() => node.querySelector<HTMLButtonElement>('[aria-label="Search conversations"]')!.click());
  expect(search.closest('.hidden')).toBeNull();
  act(() => node.querySelector<HTMLButtonElement>('[aria-label="Filter conversations"]')!.click());
  expect(node.querySelector('[data-testid="sidebar-filter-menu"]')).toBeTruthy();
  act(() => ([...node.querySelectorAll<HTMLButtonElement>('[data-testid="sidebar-filter-menu"] button')]
    .find(button => button.textContent?.includes('Name'))!).click());
  const names = [...node.querySelectorAll('[data-testid="workspace-zone"]')].map(zone => zone.querySelector('[data-workspace-directory]')?.getAttribute('data-workspace-directory'));
  expect(names).toEqual(['D:/work', 'D:/alpha', 'D:/zeta']);
});

it('shows archived conversations in a flat list and offers restore', () => {
  useGlobalSessionsStore.setState({ active: [session('live', 'D:/work', 'Current')],
    archived: [{ ...session('old', 'D:/other', 'Prior'), time: { created: 1, updated: 2, archived: 3 } }] });
  const { node } = mount('D:/work');
  act(() => node.querySelector<HTMLButtonElement>('[aria-label="Filter conversations"]')!.click());
  act(() => ([...node.querySelectorAll<HTMLButtonElement>('[data-testid="sidebar-filter-menu"] button')]
    .find(button => button.textContent?.includes('One list'))!).click());
  act(() => ([...node.querySelectorAll<HTMLButtonElement>('[data-testid="sidebar-filter-menu"] button')]
    .find(button => button.textContent?.includes('Archived only'))!).click());
  expect(node.querySelector('[data-testid="sidebar-flat-list"]')?.textContent).toContain('Prior');
  expect(node.querySelector('[data-testid="sidebar-flat-list"]')?.textContent).not.toContain('Current');
  expect(node.querySelector('[aria-label="Restore Prior"]')).toBeTruthy();
  expect(node.querySelector('[data-testid="sidebar-archive"]')).toBeNull();
});

it('opens the folder picker directly and admits the chosen workspace', async () => {
  const { node, openDraft } = mount('D:/work', vi.fn(), true);
  await act(async () => { await Promise.resolve(); });
  vi.mocked(pickWorkspaceDirectory).mockResolvedValue('D:/typed');
  vi.mocked(addNativeWorkspace).mockResolvedValue(admittedSelection('D:/typed'));
  await act(async () => { node.querySelector<HTMLButtonElement>('[aria-label="Add workspace"]')!.click();
    await Promise.resolve(); await Promise.resolve(); });
  expect(addNativeWorkspace).toHaveBeenCalledWith('D:/typed');
  expect(openDraft).toHaveBeenCalledWith('D:/typed');
  expect(node.querySelector('[role="dialog"]')).toBeNull();
});

it('leaves the workspace unchanged when the folder picker is cancelled', async () => {
  const { node, openDraft } = mount('D:/work', vi.fn(), true);
  await act(async () => { await Promise.resolve(); });
  vi.mocked(pickWorkspaceDirectory).mockResolvedValue(null);
  await act(async () => { node.querySelector<HTMLButtonElement>('[aria-label="Add workspace"]')!.click();
    await Promise.resolve(); });
  expect(addNativeWorkspace).not.toHaveBeenCalled();
  expect(openDraft).not.toHaveBeenCalled();
});

it('browses a folder when opened outside the desktop shell', async () => {
  vi.mocked(hasNativeWorkspacePicker).mockReturnValue(false);
  const { node, openDraft } = mount('D:/work', vi.fn(), true);
  await act(async () => { await Promise.resolve(); });
  vi.mocked(addNativeWorkspace).mockResolvedValue(admittedSelection('D:/browser'));
  act(() => node.querySelector<HTMLButtonElement>('[aria-label="Add workspace"]')!.click());
  expect(pickWorkspaceDirectory).not.toHaveBeenCalled();
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  await act(async () => { [...node.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(button => button.textContent === 'Select folder')!.click();
    await Promise.resolve(); await Promise.resolve(); });
  expect(addNativeWorkspace).toHaveBeenCalledWith('D:/browser');
  expect(openDraft).toHaveBeenCalledWith('D:/browser');
});

it('shows a failed browser folder admission outside the picker', async () => {
  vi.mocked(hasNativeWorkspacePicker).mockReturnValue(false);
  const { node } = mount('D:/work', vi.fn(), true);
  await act(async () => { await Promise.resolve(); });
  vi.mocked(addNativeWorkspace).mockRejectedValue(new Error('NNA refused this path.'));
  act(() => node.querySelector<HTMLButtonElement>('[aria-label="Add workspace"]')!.click());
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  await act(async () => { [...node.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(button => button.textContent === 'Select folder')!.click();
    await Promise.resolve(); });
  expect(node.querySelector('[role="dialog"]')).toBeNull();
  expect(node.querySelector('[data-testid="workspace-add-feedback"]')?.textContent).toContain('NNA refused this path.');
});

it('shows the confirmed workspace when the recovery controls cannot refresh', async () => {
  const { node, openDraft } = mount('D:/work', vi.fn(), true);
  await act(async () => { await Promise.resolve(); });
  vi.mocked(pickWorkspaceDirectory).mockResolvedValue('D:/new');
  vi.mocked(addNativeWorkspace).mockResolvedValue(admittedSelection('D:/new'));
  vi.mocked(readNativeWorkspaceAdmissions).mockRejectedValueOnce(new Error('offline'));
  await act(async () => { node.querySelector<HTMLButtonElement>('[aria-label="Add workspace"]')!.click();
    await Promise.resolve(); await Promise.resolve(); });
  expect(openDraft).toHaveBeenCalledWith('D:/new');
  expect(node.querySelector('[data-workspace-directory="D:/new"]')).toBeTruthy();
  expect(node.querySelector('[role="alert"]')).toBeNull();
});

it('keeps admission errors visible and retries the selected path', async () => {
  const { node, openDraft } = mount('D:/work', vi.fn(), true);
  await act(async () => { await Promise.resolve(); });
  vi.mocked(pickWorkspaceDirectory).mockResolvedValue('D:/new');
  vi.mocked(addNativeWorkspace).mockRejectedValueOnce(new Error('NNA could not verify this directory.'))
    .mockResolvedValueOnce(admittedSelection('D:/new'));
  await act(async () => { node.querySelector<HTMLButtonElement>('[aria-label="Add workspace"]')!.click();
    await Promise.resolve(); await Promise.resolve(); });
  expect(openDraft).not.toHaveBeenCalled();
  expect(node.querySelector('[data-testid="workspace-add-feedback"]')?.textContent).toContain('NNA could not verify this directory.');
  await act(async () => { node.querySelector<HTMLButtonElement>('[data-testid="workspace-add-feedback"] button')!.click();
    await Promise.resolve(); await Promise.resolve(); });
  expect(pickWorkspaceDirectory).toHaveBeenCalledTimes(1);
  expect(addNativeWorkspace).toHaveBeenCalledTimes(2);
  expect(openDraft).toHaveBeenCalledWith('D:/new');
  expect(node.querySelector('[data-workspace-directory="D:/new"]')).toBeTruthy();
});

it('shows progress until admission finishes and prevents another picker', async () => {
  let resolveAdmission!: (value: WorkspaceAdmissionSelection) => void;
  const { node } = mount('D:/work', vi.fn(), true);
  await act(async () => { await Promise.resolve(); });
  vi.mocked(pickWorkspaceDirectory).mockResolvedValue('D:/new');
  vi.mocked(addNativeWorkspace).mockImplementationOnce(() => new Promise(resolve => { resolveAdmission = resolve; }));
  await act(async () => { node.querySelector<HTMLButtonElement>('[aria-label="Add workspace"]')!.click();
    await Promise.resolve(); });
  expect(node.querySelector('[data-testid="workspace-add-progress"]')?.textContent).toContain('Adding workspace in NNA');
  expect(node.querySelector<HTMLButtonElement>('[aria-label="Add workspace"]')?.disabled).toBe(true);
  await act(async () => { resolveAdmission(admittedSelection('D:/new')); await Promise.resolve(); });
  expect(node.querySelector('[data-testid="workspace-add-progress"]')).toBeNull();
  expect(node.querySelector('[data-workspace-directory="D:/new"]')).toBeTruthy();
});

it('reveals the new workspace when search, grouping, and archive filters hid it', async () => {
  const { node, openDraft } = mount('D:/work', vi.fn(), true);
  await act(async () => { await Promise.resolve(); });
  act(() => node.querySelector<HTMLButtonElement>('[aria-label="Filter conversations"]')!.click());
  act(() => ([...node.querySelectorAll<HTMLButtonElement>('[data-testid="sidebar-filter-menu"] button')]
    .find(button => button.textContent?.includes('One list'))!).click());
  act(() => ([...node.querySelectorAll<HTMLButtonElement>('[data-testid="sidebar-filter-menu"] button')]
    .find(button => button.textContent?.includes('Archived only'))!).click());
  act(() => node.querySelector<HTMLButtonElement>('[aria-label="Search conversations"]')!.click());
  const input = node.querySelector<HTMLInputElement>('[data-testid="sidebar-search"]')!;
  act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'unrelated');
    input.dispatchEvent(new Event('input', { bubbles: true })); });
  vi.mocked(pickWorkspaceDirectory).mockResolvedValue('D:/new');
  vi.mocked(addNativeWorkspace).mockResolvedValue(admittedSelection('D:/new'));
  await act(async () => { node.querySelector<HTMLButtonElement>('[aria-label="Add workspace"]')!.click();
    await Promise.resolve(); await Promise.resolve(); });
  expect(openDraft).toHaveBeenCalledWith('D:/new');
  expect(node.querySelector('[data-testid="sidebar-flat-list"]')).toBeNull();
  expect(node.querySelector('[data-workspace-directory="D:/new"]')).toBeTruthy();
  expect(input.value).toBe('');
});

it('does not let an older inventory response erase a newly confirmed workspace', async () => {
  let resolveInitial!: (value: WorkspaceAdmissionSelection['inventory']) => void;
  vi.mocked(readNativeWorkspaceAdmissions).mockImplementationOnce(() => new Promise(resolve => { resolveInitial = resolve; }));
  const { node, openDraft } = mount('D:/work', vi.fn(), true);
  vi.mocked(pickWorkspaceDirectory).mockResolvedValue('D:/new');
  vi.mocked(addNativeWorkspace).mockResolvedValue(admittedSelection('D:/new'));
  await act(async () => { node.querySelector<HTMLButtonElement>('[aria-label="Add workspace"]')!.click();
    await Promise.resolve(); await Promise.resolve(); });
  expect(openDraft).toHaveBeenCalledWith('D:/new');
  expect(node.querySelector('[data-workspace-directory="D:/new"]')).toBeTruthy();
  await act(async () => resolveInitial({ installation_id: 'install', data_id: 'data', revision: 'absent',
    selection_enabled: true, attached: { root: 'D:/work', id: `ws_${'a'.repeat(24)}` },
    admitted: [], unavailable: [] }));
  expect(node.querySelector('[data-workspace-directory="D:/new"]')).toBeTruthy();
});

it('does not offer folder actions that the native service cannot save', async () => {
  useGlobalSessionsStore.setState({ active: [session('s1', 'D:/work', 'Existing conversation')] });
  const { node } = mount('D:/work', vi.fn(), true);
  await act(async () => { await Promise.resolve(); });
  expect(node.querySelector('[aria-label="New folder in D:/work"]')).toBeNull();
  expect(node.querySelector('[data-testid="session-file-into"]')).toBeNull();
  act(() => node.querySelector<HTMLButtonElement>('[data-testid="sidebar-select-toggle"]')!.click());
  expect(node.textContent).not.toContain('Move to folder');
});

it('distinguishes loading from failed session refresh and offers an explicit retry', () => {
  useGlobalSessionsStore.setState({ status: 'loading', hasLoaded: false });
  const { node } = mount('D:/work');
  expect(node.querySelector('[data-testid="zone-empty"]')?.textContent).toContain('Loading sessions');
  const retry = vi.fn(async () => undefined);
  act(() => useGlobalSessionsStore.setState({ status: 'error', hasLoaded: true, lastError: 'offline', loadSessions: retry }));
  expect(node.querySelector('[data-testid="sidebar-sessions-error"]')?.textContent).toContain('Could not refresh sessions');
  act(() => (node.querySelector('[data-testid="sidebar-sessions-error"] button') as HTMLButtonElement).click());
  expect(retry).toHaveBeenCalledTimes(1);
});

it('reloads the global session projection when an in-place runtime switch resets it', async () => {
  const loadSessions = vi.fn(async () => undefined);
  useGlobalSessionsStore.setState({ loadSessions });
  mount('D:/work');
  expect(loadSessions).toHaveBeenCalledTimes(1);
  await act(async () => {
    useGlobalSessionsStore.getState().reset();
    await switchRuntimeEndpoint({ apiBaseUrl: 'http://127.0.0.1:61777', runtimeKey: 'remote-test' });
  });
  expect(loadSessions).toHaveBeenCalledTimes(2);
});

it('pins a session without a directory in the displayed global workspace', () => {
  useGlobalSessionsStore.setState({ active: [{ ...session('global-one', 'global', 'Global chat'), directory: undefined } as unknown as Session] });
  const { node } = mount('global');
  const row = node.querySelector('[data-testid="session-row"]')!;
  act(() => (row.parentElement!.querySelector('[aria-label="Pin Global chat"]') as HTMLButtonElement).click());
  expect(row.querySelector('[aria-label="Pinned session"]')).toBeTruthy();
  expect(row.parentElement!.querySelector('[aria-label="Unpin Global chat"]')).toBeTruthy();
});

it('opens a readable conversation menu and forks through the existing session action', async () => {
  useGlobalSessionsStore.setState({ active: [session('source', 'D:/work', 'Design review')] });
  const fork = vi.fn(async () => undefined);
  const { node } = mount('D:/work');
  await act(async () => root!.render(<ChatSidebar engine={{} as never} currentDirectory="D:/work" currentSessionId={null}
    actions={{ openDraft: () => undefined, openSession: () => undefined, rename: async () => undefined,
      archive: async () => undefined, restore: async () => undefined, deleteSession: async () => undefined, fork }} />));
  const menu = node.querySelector<HTMLDetailsElement>('[data-testid="session-row"] + details')!;
  act(() => (menu.querySelector('summary') as HTMLElement).click());
  expect(menu.open).toBe(true);
  await act(async () => (menu.querySelector('[aria-label="Fork Design review"]') as HTMLButtonElement).click());
  expect(fork).toHaveBeenCalledExactlyOnceWith('source', 'D:/work');
});

it('puts the active workspace first and folds its sessions without hiding its actions', () => {
  useGlobalSessionsStore.setState({ active: [session('s-other', 'D:/other', 'Other chat'), session('s-current', 'D:/work', 'Current chat')] });
  const { node } = mount('D:/work');
  const zones = [...node.querySelectorAll('[data-testid="workspace-zone"]')];
  expect(zones).toHaveLength(2);
  expect(zones[0]?.textContent).toContain('work');
  const toggle = zones[0]!.querySelector('[data-testid="workspace-zone-toggle"]') as HTMLButtonElement;
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  act(() => toggle.click());
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  expect(zones[0]!.querySelector('[data-testid="session-row"]')).toBeNull();
  expect(zones[0]!.querySelector('[aria-label="New draft session in D:/work"]')).toBeTruthy();
  act(() => toggle.click());
  expect(zones[0]!.querySelector('[data-testid="session-row"]')?.textContent).toContain('Current chat');
});

it('reveals a matching session in a collapsed workspace during search', () => {
  useGlobalSessionsStore.setState({ active: [session('s1', 'D:/work', 'Review report')] });
  const { node } = mount('D:/work');
  const toggle = node.querySelector('[data-testid="workspace-zone-toggle"]') as HTMLButtonElement;
  act(() => toggle.click());
  const input = node.querySelector('[data-testid="sidebar-search"]') as HTMLInputElement;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'report');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  expect(toggle.disabled).toBe(true);
  expect(node.querySelector('[data-testid="session-row"]')?.textContent).toContain('Review report');
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
});

it('preserves a folded workspace when search temporarily removes its zone', () => {
  useGlobalSessionsStore.setState({ active: [session('s1', 'D:/work', 'Alpha'), session('s2', 'D:/other', 'Beta')] });
  const { node } = mount('D:/work');
  const toggle = node.querySelector('[data-active="true"] [data-testid="workspace-zone-toggle"]') as HTMLButtonElement;
  act(() => toggle.click());
  const input = node.querySelector('[data-testid="sidebar-search"]') as HTMLInputElement;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Beta');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(node.querySelector('[data-active="true"]')).toBeNull();
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const restored = node.querySelector('[data-active="true"]')!;
  expect(restored.querySelector('[data-testid="workspace-zone-toggle"]')?.getAttribute('aria-expanded')).toBe('false');
  expect(restored.querySelector('[data-testid="session-row"]')).toBeNull();
});

it('reveals a matching session inside a collapsed folder and disambiguates same-name workspaces', () => {
  useGlobalSessionsStore.setState({ active: [session('s1', 'D:/A/shared', 'Review report'), session('s2', 'D:/B/shared', 'Other')] });
  useSessionFoldersStore.setState({
    foldersByDirectory: { 'D:/A/shared': [{ id: 'f1', name: 'Plans', sessionIds: ['s1'], createdAt: 1 }] },
    collapsedFolderIds: { f1: true },
  });
  const { node } = mount('D:/A/shared');
  expect([...node.querySelectorAll('[data-testid="workspace-zone-toggle"]')].map((item) => item.getAttribute('aria-label'))).toEqual([
    'Collapse D:/A/shared workspace', 'Collapse D:/B/shared workspace',
  ]);
  const input = node.querySelector('[data-testid="sidebar-search"]') as HTMLInputElement;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'report');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(node.querySelector('[data-testid="session-row"]')?.textContent).toContain('Review report');
  expect(node.querySelector('[data-testid="folder-header"]')?.getAttribute('aria-expanded')).toBe('true');
});

it('counts archived sessions against a normalized active directory', () => {
  useGlobalSessionsStore.setState({ archived: [{ ...session('old', 'D:/work', 'Old chat'), time: { created: 1, updated: 2, archived: 3 } }] });
  const { node } = mount('D:/work/');
  expect(node.querySelector('[data-testid="sidebar-archive-toggle"]')?.textContent).toContain('Archive (1)');
});

it('shows a delegated child below its parent in the same folder with NNA agent identity', () => {
  useGlobalSessionsStore.setState({ active: [
    { ...session('child', 'D:/work', 'Research'), parentID: 'parent', agent: 'explore', time: { created: 2, updated: 2 } },
    session('parent', 'D:/work', 'Main task'),
  ] });
  useSessionFoldersStore.setState({
    foldersByDirectory: { 'D:/work': [{ id: 'f1', name: 'Plans', sessionIds: ['parent'], createdAt: 1 }] },
  });
  const { node } = mount('D:/work');
  const folderNode = node.querySelector('[data-testid="folder-f1"]')!;
  expect(folderNode.querySelector('[data-child-session="true"]')).toBeNull();
  act(() => (folderNode.querySelector('[aria-label="Expand Main task subtasks"]') as HTMLButtonElement).click());
  expect([...folderNode.querySelectorAll('[data-testid="session-row"]')].map((row) => row.textContent)).toEqual([
    expect.stringContaining('Main task'), expect.stringContaining('Research'),
  ]);
  expect(folderNode.querySelector('[data-child-session="true"]')?.textContent).toContain('explore');
  expect(folderNode.querySelector('[data-child-session="true"] [aria-label="Unfile from folder"]')).toBeNull();
  expect(folderNode.querySelector('[data-child-session="true"]')?.getAttribute('data-child-depth')).toBe('1');
  expect(folderNode.querySelector('[data-child-session="true"] [aria-label^="Archive"]')).toBeNull();
  expect(folderNode.querySelector('[data-child-session="true"] [aria-label^="Rename"]')).toBeNull();
  expect(folderNode.querySelector('[data-child-session="true"] [aria-label^="Delete"]')).toBeNull();
  expect(folderNode.querySelector('[aria-label="Unfile from folder"]')).toBeTruthy();
  expect(node.querySelector('[data-testid="workspace-zone"] > ul > [data-child-session="true"]')).toBeNull();
});

it('keeps delegated children collapsed by default and restores an explicit expansion choice', () => {
  useGlobalSessionsStore.setState({ active: [session('parent', 'D:/work', 'Main task'),
    { ...session('child', 'D:/work', 'Research'), parentID: 'parent' }] });
  const { node } = mount('D:/work');
  expect(node.querySelector('[data-child-session="true"]')).toBeNull();
  act(() => (node.querySelector('[aria-label="Expand Main task subtasks"]') as HTMLButtonElement).click());
  expect(node.querySelector('[data-child-session="true"]')?.textContent).toContain('Research');
  expect(localStorage.getItem('nnd.sessions.expanded.v1')).toContain('parent');
  act(() => useSessionExpansionStore.setState({ expanded: {} }));
  expect(node.querySelector('[data-child-session="true"]')).toBeNull();
  act(() => useSessionExpansionStore.getState().reload());
  expect(node.querySelector('[data-child-session="true"]')?.textContent).toContain('Research');
  act(() => (node.querySelector('[aria-label="Collapse Main task subtasks"]') as HTMLButtonElement).click());
  expect(node.querySelector('[data-child-session="true"]')).toBeNull();
});

it('keeps a filed child with an unavailable parent in its folder with an actionable unfile control', () => {
  useGlobalSessionsStore.setState({ active: [{ ...session('child', 'D:/work', 'Research'), parentID: 'missing' }] });
  useSessionFoldersStore.setState({
    foldersByDirectory: { 'D:/work': [{ id: 'f1', name: 'Plans', sessionIds: ['child'], createdAt: 1 }] },
  });
  const { node } = mount('D:/work');
  const folderNode = node.querySelector('[data-testid="folder-f1"]')!;
  expect(folderNode.querySelector('[data-child-session="true"]')?.textContent).toContain('Research');
  expect(folderNode.querySelector('[aria-label="Unfile from folder"]')).toBeTruthy();
  expect(folderNode.textContent).toContain('Parent unavailable');
});

it('keeps unfiled descendants nested beneath a child whose parent is unavailable', () => {
  useGlobalSessionsStore.setState({ active: [
    { ...session('grandchild', 'D:/work', 'Follow-up'), parentID: 'child', time: { created: 2, updated: 2 } },
    { ...session('child', 'D:/work', 'Research'), parentID: 'missing' },
  ] });
  const { node } = mount('D:/work');
  expect(node.textContent).toContain('Parent unavailable');
  act(() => (node.querySelector('[aria-label="Expand Research subtasks"]') as HTMLButtonElement).click());
  const rows = [...node.querySelectorAll('[data-testid="workspace-zone"] > ul > [data-child-session="true"]')];
  expect(rows.map((row) => row.textContent)).toEqual([
    expect.stringContaining('Research'), expect.stringContaining('Follow-up'),
  ]);
  expect(rows[0]?.hasAttribute('data-child-depth')).toBe(false);
  expect(rows[1]?.getAttribute('data-child-depth')).toBe('1');
});

it('selects parent sessions for bulk archive and leaves failed rows selected', async () => {
  useGlobalSessionsStore.setState({ active: [
    session('parent', 'D:/work', 'Main task'),
    { ...session('child', 'D:/work', 'Research'), parentID: 'parent' },
    session('failed', 'D:/work', 'Other task'),
  ] });
  const archive = vi.fn(async (id: string) => { if (id === 'failed') throw new Error('offline'); });
  const { node } = mount('D:/work');
  // Replace the action through a rerender to exercise the public sidebar seam.
  await act(async () => root!.render(<ChatSidebar engine={{} as never} currentDirectory="D:/work" currentSessionId={null}
    actions={{ openDraft: () => undefined, openSession: () => undefined, rename: async () => undefined,
      archive, restore: async () => undefined, deleteSession: async () => undefined }} />));
  act(() => (node.querySelector('[data-testid="sidebar-select-toggle"]') as HTMLButtonElement).click());
  expect(node.querySelector('[aria-label="Select Research"]')).toBeNull();
  act(() => (node.querySelector('[aria-label="Select Main task"]') as HTMLInputElement).click());
  act(() => (node.querySelector('[aria-label="Select Other task"]') as HTMLInputElement).click());
  expect(node.querySelector('[data-testid="sidebar-bulk-actions"]')?.textContent).toContain('2 selected');
  await act(async () => (node.querySelector('[data-testid="sidebar-bulk-actions"] button') as HTMLButtonElement).click());
  expect(archive).toHaveBeenCalledTimes(2);
  expect(node.querySelector('[data-testid="sidebar-bulk-actions"]')?.textContent).toContain('1 selected');
  expect((node.querySelector('[aria-label="Select Other task"]') as HTMLInputElement).checked).toBe(true);
});

it('moves selected sessions in one folder write and exits selection without opening a session', async () => {
  useGlobalSessionsStore.setState({ active: [session('one', 'D:/work', 'One'), session('two', 'D:/work', 'Two')] });
  const assignManySessions = vi.fn(async () => true);
  useSessionFoldersStore.setState({ foldersByDirectory: {
    'D:/work': [{ id: 'folder-a', name: 'Plans', sessionIds: [], createdAt: 1 }],
  }, assignManySessions });
  const openSession = vi.fn();
  const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('1');
  const { node } = mount('D:/work');
  await act(async () => root!.render(<ChatSidebar engine={{} as never} currentDirectory="D:/work" currentSessionId={null}
    actions={{ openDraft: () => undefined, openSession, rename: async () => undefined,
      archive: async () => undefined, restore: async () => undefined, deleteSession: async () => undefined }} />));
  act(() => (node.querySelector('[data-testid="sidebar-select-toggle"]') as HTMLButtonElement).click());
  act(() => (node.querySelector('[aria-label="Select One"]') as HTMLInputElement).click());
  act(() => (node.querySelector('[aria-label="Select Two"]') as HTMLInputElement).click());
  expect(openSession).not.toHaveBeenCalled();
  const move = [...node.querySelectorAll('[data-testid="sidebar-bulk-actions"] button')].find((button) => button.textContent === 'Move to folder') as HTMLButtonElement;
  await act(async () => move.click());
  expect(assignManySessions).toHaveBeenCalledWith('D:/work', 'folder-a', expect.arrayContaining(['one', 'two']));
  expect(node.querySelector('[data-testid="sidebar-bulk-actions"]')?.textContent).toContain('0 selected');
  promptSpy.mockRestore();
});

it('clears known descendant pins after a successful bulk parent delete', async () => {
  useGlobalSessionsStore.setState({ active: [
    session('parent', 'D:/work', 'Main task'),
    { ...session('child', 'D:/work', 'Research'), parentID: 'parent' },
    { ...session('grandchild', 'D:/work', 'Follow-up'), parentID: 'child' },
  ] });
  useSessionPinnedStore.getState().toggle('D:/work', 'parent');
  useSessionPinnedStore.getState().toggle('D:/work', 'child');
  useSessionPinnedStore.getState().toggle('D:/work', 'grandchild');
  const deleteSession = vi.fn(async () => undefined);
  const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
  const { node } = mount('D:/work');
  await act(async () => root!.render(<ChatSidebar engine={{} as never} currentDirectory="D:/work" currentSessionId={null}
    actions={{ openDraft: () => undefined, openSession: () => undefined, rename: async () => undefined,
      archive: async () => undefined, restore: async () => undefined, deleteSession }} />));
  act(() => (node.querySelector('[data-testid="sidebar-select-toggle"]') as HTMLButtonElement).click());
  act(() => (node.querySelector('[aria-label="Select Main task"]') as HTMLInputElement).click());
  const remove = [...node.querySelectorAll('[data-testid="sidebar-bulk-actions"] button')].find((button) => button.textContent === 'Delete') as HTMLButtonElement;
  await act(async () => remove.click());
  expect(deleteSession).toHaveBeenCalledExactlyOnceWith('parent', 'D:/work');
  expect(useSessionPinnedStore.getState().pins).toEqual({});
  confirmSpy.mockRestore();
});


it('renames a workspace through its menu and keeps its path unchanged', async () => {
  vi.mocked(runtimeFetch).mockImplementation(async (_path, options) => {
    const body = options?.body ? JSON.parse(String(options.body)) : null;
    return new Response(JSON.stringify({ version: 1, workspaces: body ? { [body.id]: { label: body.label, hidden: body.hidden } } : {} }));
  });
  const { node } = mount('D:/work', vi.fn(), true);
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  act(() => [...node.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Rename workspace')!.click());
  const input = document.querySelector<HTMLInputElement>('[aria-label="Workspace name"]')!;
  act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'My workspace'); input.dispatchEvent(new Event('input', { bubbles: true })); });
  await act(async () => { document.querySelector<HTMLFormElement>('[aria-label="Rename workspace"]')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await Promise.resolve(); });
  expect(node.querySelector('[data-workspace-directory="D:/work"]')?.textContent).toContain('My workspace');
  expect(document.querySelector('[aria-label="Workspace name"]')).toBeNull();
});

it('removes a workspace from the grouped sidebar and reveals it on request', async () => {
  const { node } = mount('D:/work', vi.fn(), true);
  await act(async () => { await Promise.resolve(); });
  act(() => useWorkspaceDisplayStore.setState({ rows: { [`ws_${'a'.repeat(24)}`]: { label: 'Saved', hidden: true } } }));
  expect(node.querySelector('[data-testid="workspace-zone"]')).toBeNull();
  act(() => node.querySelector<HTMLButtonElement>('[aria-label="Filter conversations"]')!.click());
  act(() => [...node.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Show removed workspaces')!.click());
  expect(node.querySelector('[data-testid="workspace-zone"]')?.textContent).toContain('Saved');
});

it('restores the grouping preference after the sidebar remounts', () => {
  let { node } = mount('D:/work');
  act(() => node.querySelector<HTMLButtonElement>('[aria-label="Filter conversations"]')!.click());
  act(() => [...node.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.startsWith('One list'))!.click());
  act(() => root!.unmount()); container!.remove();
  ({ node } = mount('D:/work'));
  expect(node.querySelector('[data-testid="sidebar-flat-list"]')).toBeTruthy();
});
