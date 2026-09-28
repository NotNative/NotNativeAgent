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
import { initializeRuntimeEndpoint } from '../../lib/runtime-switch.ts';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
initializeRuntimeEndpoint({ apiBaseUrl: 'http://127.0.0.1:61776', runtimeKey: 'local' });
let root: Root | null = null;
let container: HTMLDivElement | null = null;
let originalLoad: () => Promise<void>;

beforeEach(() => {
  localStorage.clear();
  useSessionPinnedStore.setState({ pins: {} });
  originalLoad = useSessionFoldersStore.getState().load;
  useSessionFoldersStore.setState({ load: async () => undefined, foldersByDirectory: {}, collapsedFolderIds: {} });
});
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  useGlobalSessionsStore.getState().reset();
  useSessionFoldersStore.setState({ load: originalLoad, foldersByDirectory: {}, collapsedFolderIds: {} });
});

function session(id: string, directory: string, title: string): Session {
  return { id, directory, title, time: { created: 1, updated: 1 } } as Session;
}

function mount(currentDirectory: string, openDraft = vi.fn()): { node: HTMLDivElement; openDraft: ReturnType<typeof vi.fn> } {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<ChatSidebar engine={{} as never} currentDirectory={currentDirectory} currentSessionId={null}
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

it('pins a session without a directory in the displayed global workspace', () => {
  useGlobalSessionsStore.setState({ active: [{ ...session('global-one', 'global', 'Global chat'), directory: undefined } as unknown as Session] });
  const { node } = mount('global');
  const row = node.querySelector('[data-testid="session-row"]')!;
  act(() => (row.parentElement!.querySelector('[aria-label="Pin Global chat"]') as HTMLButtonElement).click());
  expect(row.querySelector('[aria-label="Pinned session"]')).toBeTruthy();
  expect(row.parentElement!.querySelector('[aria-label="Unpin Global chat"]')).toBeTruthy();
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
  expect([...folderNode.querySelectorAll('[data-testid="session-row"]')].map((row) => row.textContent)).toEqual([
    expect.stringContaining('Main task'), expect.stringContaining('Research'),
  ]);
  expect(folderNode.querySelector('[data-child-session="true"]')?.textContent).toContain('explore');
  expect(folderNode.querySelector('[data-child-session="true"] [aria-label="Unfile from folder"]')).toBeNull();
  expect(folderNode.querySelector('[data-child-session="true"]')?.getAttribute('data-child-depth')).toBe('1');
  expect(folderNode.querySelector('[aria-label="Unfile from folder"]')).toBeTruthy();
  expect(node.querySelector('[data-testid="workspace-zone"] > ul > [data-child-session="true"]')).toBeNull();
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
