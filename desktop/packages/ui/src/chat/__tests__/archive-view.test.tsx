// SPDX-License-Identifier: Apache-2.0
/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Session } from '../../lib/nnd/types.ts';
import { ArchiveView, archiveMatches, archiveWorkspaces } from '../archive-view.tsx';
import { useGlobalSessionsStore } from '../../sync/global-stores.ts';
import { useSessionFoldersStore } from '../../stores/useSessionFoldersStore.ts';
import { initializeRuntimeEndpoint, switchRuntimeEndpoint } from '../../lib/runtime-switch.ts';
import { pinnedSessionIds, useSessionPinnedStore } from '../../stores/useSessionPinnedStore.ts';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
initializeRuntimeEndpoint({ apiBaseUrl: 'http://127.0.0.1:61776', runtimeKey: 'local' });
let root: Root | null = null;
let container: HTMLDivElement | null = null;
let originalSessionLoad: () => Promise<void>;

const archived = (id: string, directory: string, title: string): Session => ({ id, directory, title, time: { created: 1, updated: 2, archived: 3 } }) as Session;

beforeEach(() => {
  useGlobalSessionsStore.getState().reset();
  originalSessionLoad = useGlobalSessionsStore.getState().loadSessions;
  useGlobalSessionsStore.setState({ loadSessions: async () => undefined });
  useSessionFoldersStore.setState({ foldersByDirectory: {}, hasLoaded: true });
  useSessionPinnedStore.setState({ pins: {} });
});
afterEach(async () => {
  act(() => root?.unmount());
  await switchRuntimeEndpoint({ apiBaseUrl: 'http://127.0.0.1:61776', runtimeKey: 'local' });
  container?.remove();
  root = null;
  container = null;
  useGlobalSessionsStore.getState().reset();
  useGlobalSessionsStore.setState({ loadSessions: originalSessionLoad });
});

function mount(overrides: Partial<Parameters<typeof ArchiveView>[0]> = {}) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const onRestore = vi.fn(async () => undefined);
  const onDelete = vi.fn(async () => undefined);
  const onClose = vi.fn();
  const onOpenSession = vi.fn();
  act(() => root!.render(<ArchiveView currentDirectory="D:/work" onRestore={onRestore} onDelete={onDelete} onClose={onClose} onOpenSession={onOpenSession} {...overrides} />));
  return { node: container, onRestore, onDelete, onClose, onOpenSession };
}

it('refreshes the archive after an in-place runtime switch', async () => {
  const loadSessions = vi.fn(async () => undefined);
  useGlobalSessionsStore.setState({ loadSessions });
  mount();
  expect(loadSessions).toHaveBeenCalledTimes(1);
  await act(async () => {
    useGlobalSessionsStore.getState().reset();
    await switchRuntimeEndpoint({ apiBaseUrl: 'http://127.0.0.1:61777', runtimeKey: 'remote-test' });
  });
  expect(loadSessions).toHaveBeenCalledTimes(2);
});

it('groups archived sessions once by workspace and persisted folder, with an unfiled bucket', () => {
  const workspaces = archiveWorkspaces([
    archived('ses_a', 'D:/work', 'A'), archived('ses_b', 'D:/work', 'B'), archived('ses_c', 'D:/other', 'C'),
  ], { 'D:/work': [{ id: 'f1', name: 'Plans', sessionIds: ['ses_a'], createdAt: 1 }] }, 'D:/work');
  expect(workspaces.map((workspace) => workspace.directory)).toEqual(['D:/work', 'D:/other']);
  expect(workspaces[0]!.buckets.map((bucket) => [bucket.label, bucket.sessions.map((session) => session.id)])).toEqual([
    ['Plans', ['ses_a']], ['Other sessions', ['ses_b']],
  ]);
});

it('keeps descendants in the parent lifecycle bucket even if separately filed', () => {
  const parent = archived('ses_parent', 'D:/work', 'Parent');
  const child = { ...archived('ses_child', 'D:/work', 'Child'), parentID: 'ses_parent' };
  const grandchild = { ...archived('ses_grandchild', 'D:/work', 'Grandchild'), parentID: 'ses_child' };
  const buckets = archiveWorkspaces([parent, child, grandchild], { 'D:/work': [
    { id: 'plans', name: 'Plans', sessionIds: ['ses_parent'], createdAt: 1 },
    { id: 'other', name: 'Other folder', sessionIds: ['ses_child'], createdAt: 2 },
  ] }, 'D:/work')[0]!.buckets;
  expect(buckets.find((bucket) => bucket.key === 'plans')!.sessions.map((session) => session.id)).toEqual(['ses_parent', 'ses_child', 'ses_grandchild']);
  expect(buckets.find((bucket) => bucket.key === 'other')!.sessions).toEqual([]);
});

it('uses exact matching for ses_ ids and title matching otherwise', () => {
  const item = archived('ses_abc', 'D:/work', 'Review report');
  expect(archiveMatches(item, 'ses_abc')).toBe(true);
  expect(archiveMatches(item, 'ses_ab')).toBe(false);
  expect(archiveMatches(item, 'review')).toBe(true);
});

it('shows archived groups and invokes restore and navigation with the bound directory', async () => {
  useGlobalSessionsStore.setState({ archived: [archived('ses_a', 'D:/work', 'First'), archived('ses_b', 'D:/other', 'Second')] });
  useSessionFoldersStore.setState({ foldersByDirectory: { 'D:/work': [{ id: 'f1', name: 'Plans', sessionIds: ['ses_a'], createdAt: 1 }] } });
  const { node, onRestore, onOpenSession } = mount();
  expect(node.querySelectorAll('[data-testid="archive-workspace"]')).toHaveLength(2);
  expect(node.textContent).toContain('Plans');
  const first = [...node.querySelectorAll('[data-testid="archive-bucket"] li')].find((row) => row.textContent?.includes('First'))!;
  await act(async () => ([...first.querySelectorAll('button')].find((button) => button.textContent === 'Restore') as HTMLButtonElement).click());
  expect(onRestore).toHaveBeenCalledWith('ses_a', 'D:/work');
  act(() => (first.querySelector('button') as HTMLButtonElement).click());
  expect(onOpenSession).toHaveBeenCalledWith('ses_a', 'D:/work');
});

it('confirms a bucket delete and never deletes archived rows in another bucket', async () => {
  useGlobalSessionsStore.setState({ archived: [archived('ses_a', 'D:/work', 'First'), archived('ses_b', 'D:/work', 'Second')] });
  useSessionFoldersStore.setState({ foldersByDirectory: { 'D:/work': [{ id: 'f1', name: 'Plans', sessionIds: ['ses_a'], createdAt: 1 }] } });
  const { node, onDelete } = mount();
  const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
  const plans = [...node.querySelectorAll('[data-testid="archive-bucket"]')].find((bucket) => bucket.textContent?.includes('Plans'))!;
  await act(async () => (plans.querySelector('button') as HTMLButtonElement).click());
  expect(onDelete).toHaveBeenCalledTimes(1);
  expect(onDelete).toHaveBeenCalledWith('ses_a', 'D:/work');
  confirmSpy.mockRestore();
});

it('hides full-bucket deletion while a search filters rows', async () => {
  useGlobalSessionsStore.setState({ archived: [archived('ses_a', 'D:/work', 'Visible'), archived('ses_b', 'D:/work', 'Hidden')] });
  const { node, onDelete } = mount();
  const field = node.querySelector('input[aria-label="Search archived sessions"]') as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, 'Visible');
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(node.textContent).not.toContain('Delete all in Other sessions');
  expect(node.textContent).toContain('Visible');
  expect(node.textContent).not.toContain('Hidden');
  expect(onDelete).not.toHaveBeenCalled();
});

it('clears parent and descendant pins only after successful hard deletion', async () => {
  const parent = archived('ses_parent', 'D:/work', 'Parent');
  const child = { ...archived('ses_child', 'D:/work', 'Child'), parentID: 'ses_parent' };
  const grandchild = { ...archived('ses_grandchild', 'D:/work', 'Grandchild'), parentID: 'ses_child' };
  useGlobalSessionsStore.setState({ archived: [parent, child, grandchild] });
  for (const session of [parent, child, grandchild]) useSessionPinnedStore.getState().toggle('D:/work', session.id);
  const { node, onDelete } = mount();
  const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
  const parentRow = [...node.querySelectorAll('li')].find((row) => row.textContent?.includes('Parent'))!;
  await act(async () => ([...parentRow.querySelectorAll('button')].find((button) => button.textContent === 'Delete') as HTMLButtonElement).click());
  expect(onDelete).toHaveBeenCalledWith('ses_parent', 'D:/work');
  expect(pinnedSessionIds(useSessionPinnedStore.getState().pins, 'D:/work').size).toBe(0);
  confirmSpy.mockRestore();
});
