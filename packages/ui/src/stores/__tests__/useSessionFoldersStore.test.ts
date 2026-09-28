// SPDX-License-Identifier: Apache-2.0
/**
 * Session folders store (W-18): §5.22 snapshot load, optimistic full-snapshot
 * POST mutations, single-membership assign, LWW `ignored:true` refetch, and
 * the collapsed toggle riding its own snapshot write.
 */
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('../../lib/runtime-fetch.ts', () => ({ runtimeFetch: vi.fn() }));

import { runtimeFetch } from '../../lib/runtime-fetch.ts';
import { __resetSessionFoldersStoreForTests, useSessionFoldersStore } from '../useSessionFoldersStore.ts';

const fetchMock = runtimeFetch as unknown as Mock;

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: async () => body } as unknown as Response;
}

const DIRECTORY = 'D:/work/demo';

beforeEach(() => {
  __resetSessionFoldersStoreForTests();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(jsonResponse({ version: 1, exists: false }));
});

describe('useSessionFoldersStore (§5.22 projection)', () => {
  it('load: exists:false → empty shape; ready without error', async () => {
    await useSessionFoldersStore.getState().load();
    expect(useSessionFoldersStore.getState().status).toBe('ready');
    expect(useSessionFoldersStore.getState().foldersByDirectory).toEqual({});
    expect(String(fetchMock.mock.calls[0]![0])).toContain('/api/session-folders');
  });

  it('createFolder posts the FULL snapshot with the folder entry; local state applied', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ version: 1, exists: false })) // load
      .mockResolvedValue(jsonResponse({ success: true })); // mutations
    const state = useSessionFoldersStore.getState();
    await state.load();
    await state.createFolder(DIRECTORY, 'Reviews');
    const folders = useSessionFoldersStore.getState().foldersByDirectory['D:/work/demo'] ?? [];
    expect(folders).toHaveLength(1);
    expect(folders[0]!.name).toBe('Reviews');
    expect(folders[0]!.sessionIds).toEqual([]);
    const post = fetchMock.mock.calls.at(-1)!;
    expect(post[1]!.method).toBe('POST');
    const body = JSON.parse(String(post[1]!.body)) as { version: number; exists: true; foldersMap: Record<string, Array<{ name: string }>>; updatedAt: number };
    expect(body.version).toBe(1);
    expect(body.exists).toBe(true);
    expect(body.foldersMap['D:/work/demo']![0]!.name).toBe('Reviews');
    expect(typeof body.updatedAt).toBe('number');
  });

  it('assignSession keeps single membership and remove refills unsorted', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ version: 1, exists: false }))
      .mockResolvedValue(jsonResponse({ success: true }));
    const state = useSessionFoldersStore.getState();
    await state.load();
    await state.createFolder(DIRECTORY, 'Reviews');
    const folderId = (useSessionFoldersStore.getState().foldersByDirectory['D:/work/demo'] ?? [])[0]!.id;
    await state.createFolder(DIRECTORY, 'Second');
    const secondId = (useSessionFoldersStore.getState().foldersByDirectory['D:/work/demo'] ?? [])[1]!.id;
    await state.assignSession(DIRECTORY, folderId, 'ses_a1');
    await state.assignSession(DIRECTORY, secondId, 'ses_a1'); // moves, never duplicates
    const folders = useSessionFoldersStore.getState().foldersByDirectory['D:/work/demo']!;
    expect(folders[0]!.sessionIds).toEqual([]);
    expect(folders[1]!.sessionIds).toEqual(['ses_a1']);
    await state.unassignSession(DIRECTORY, 'ses_a1');
    expect(useSessionFoldersStore.getState().foldersByDirectory['D:/work/demo']![1]!.sessionIds).toEqual([]);
  });

  it('assignManySessions moves unique ids in one snapshot write and reports failed persistence', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ success: true }));
    useSessionFoldersStore.setState({ foldersByDirectory: { 'D:/work/demo': [
      { id: 'first', name: 'First', sessionIds: ['ses_a1'], createdAt: 1 },
      { id: 'second', name: 'Second', sessionIds: [], createdAt: 2 },
    ] } });
    const state = useSessionFoldersStore.getState();
    expect(await state.assignManySessions(DIRECTORY, 'second', ['ses_a1', 'ses_a2', 'ses_a2'])).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(useSessionFoldersStore.getState().foldersByDirectory['D:/work/demo']!.map((folder) => folder.sessionIds)).toEqual([[], ['ses_a1', 'ses_a2']]);
    fetchMock.mockResolvedValue(jsonResponse({ error: 'write failed' }, false));
    expect(await state.assignManySessions(DIRECTORY, 'first', ['ses_a2'])).toBe(false);
    expect(useSessionFoldersStore.getState().foldersByDirectory['D:/work/demo']!.map((folder) => folder.sessionIds)).toEqual([[], ['ses_a1', 'ses_a2']]);
  });

  it('does not roll back a newer folder edit when a bulk move write fails', async () => {
    let answer!: (response: Response) => void;
    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => { answer = resolve; }));
    const original = [{ id: 'first', name: 'First', sessionIds: [], createdAt: 1 }];
    useSessionFoldersStore.setState({ foldersByDirectory: { 'D:/work/demo': original } });
    const pending = useSessionFoldersStore.getState().assignManySessions(DIRECTORY, 'first', ['ses_a1']);
    useSessionFoldersStore.setState({ foldersByDirectory: {
      'D:/work/demo': [{ id: 'first', name: 'Renamed', sessionIds: ['ses_a1'], createdAt: 1 }],
    } });
    answer(jsonResponse({ error: 'write failed' }, false));
    expect(await pending).toBe(false);
    expect(useSessionFoldersStore.getState().foldersByDirectory['D:/work/demo']![0]!.name).toBe('Renamed');
  });

  it('LWW ignored:true triggers a refetch so the server snapshot wins', async () => {
    const serverSnapshot = jsonResponse({ version: 1, exists: true, foldersMap: { 'D:/work/demo': [{ id: 'folder_srv', name: 'Server', sessionIds: [], createdAt: 1 }] }, collapsedFolderIds: [], updatedAt: 50 });
    fetchMock
      .mockResolvedValueOnce(serverSnapshot) // load
      .mockResolvedValueOnce(jsonResponse({ success: true, ignored: true })) // our stale write
      .mockResolvedValueOnce(serverSnapshot); // the refetch the LWW answer arms
    const state = useSessionFoldersStore.getState();
    await state.load();
    await state.renameFolder(DIRECTORY, 'folder_srv', 'Older edit');
    // the ignored answer reloaded the stored snapshot: server name wins
    const folders = useSessionFoldersStore.getState().foldersByDirectory['D:/work/demo']!;
    expect(folders[0]!.name).toBe('Server');
    expect(fetchMock.mock.calls.filter((call) => String(call[0]).includes('session-folders')).length).toBe(3);
  });

  it('write failure surfaces lastError but keeps the local optimistic view', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ version: 1, exists: false }))
      .mockResolvedValue(jsonResponse({ error: 'Stored session folders snapshot has an invalid shape' }, false));
    const state = useSessionFoldersStore.getState();
    await state.load();
    await state.createFolder(DIRECTORY, 'Reviews');
    expect(useSessionFoldersStore.getState().lastError).toContain('invalid shape');
    expect((useSessionFoldersStore.getState().foldersByDirectory['D:/work/demo'] ?? []).length).toBe(1);
  });

  it('toggleCollapsed rides its own snapshot write and deleteFolder drops it', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ version: 1, exists: false }))
      .mockResolvedValue(jsonResponse({ success: true }));
    const state = useSessionFoldersStore.getState();
    await state.load();
    await state.createFolder(DIRECTORY, 'Reviews');
    const folderId = (useSessionFoldersStore.getState().foldersByDirectory['D:/work/demo'] ?? [])[0]!.id;
    state.toggleCollapsed(folderId);
    expect(useSessionFoldersStore.getState().collapsedFolderIds[folderId]).toBe(true);
    await state.deleteFolder(DIRECTORY, folderId);
    expect((useSessionFoldersStore.getState().foldersByDirectory['D:/work/demo'] ?? []).length).toBe(0);
    expect(useSessionFoldersStore.getState().collapsedFolderIds[folderId]).toBeUndefined();
  });
});
