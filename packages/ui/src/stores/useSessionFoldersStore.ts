// SPDX-License-Identifier: Apache-2.0
/**
 * Session folders store (doc 03 §5.22 + SECTION-3 §3.2 sidebar row; W-18):
 * the UI projection over the server snapshot. The server owns persistence
 * (last-writer-wins by updatedAt); this store applies local mutations first,
 * POSTs the WHOLE snapshot, and refetches when the server answers
 * `ignored:true` (an older writer won). Keys are normalized directories.
 */
import { create, type StoreApi, type UseBoundStore, type Mutate } from 'zustand';
import { loadSessionFolders, saveSessionFolders, type SessionFolder, type SessionFoldersSnapshot } from '../lib/session-folders.ts';
import { normalizeDirectory } from '../lib/nnd/client.ts';

export type SessionFolderRow = SessionFolder;

interface SessionFoldersState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  foldersByDirectory: Record<string, SessionFolder[]>;
  collapsedFolderIds: Record<string, true>;
  updatedAt: number;
  lastError: string | null;
  hasLoaded: boolean;
  load: () => Promise<void>;
  createFolder: (directory: string, name: string) => Promise<void>;
  renameFolder: (directory: string, folderId: string, name: string) => Promise<void>;
  deleteFolder: (directory: string, folderId: string) => Promise<void>;
  assignSession: (directory: string, folderId: string, sessionId: string) => Promise<void>;
  unassignSession: (directory: string, sessionId: string) => Promise<void>;
  toggleCollapsed: (folderId: string) => void;
}

const newFolderId = (): string => `folder_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

function foldersOn(map: Record<string, SessionFolder[]>, directory: string): SessionFolder[] {
  return map[normalizeDirectory(directory)] ?? [];
}

function mapWith(map: Record<string, SessionFolder[]>, directory: string, folders: SessionFolder[]): Record<string, SessionFolder[]> {
  const key = normalizeDirectory(directory);
  return { ...map, [key]: folders };
}

/** Local-apply optimistic → POST the WHOLE snapshot → LWW refetch. */
async function persist(
  set: (partial: Partial<SessionFoldersState>) => void,
  get: () => SessionFoldersState,
  directory: string,
  localApply: (folders: SessionFolder[]) => SessionFolder[],
): Promise<void> {
  const applied = localApply(foldersOn(get().foldersByDirectory, directory));
  set({ foldersByDirectory: mapWith(get().foldersByDirectory, directory, applied), status: 'ready' });
  const snapshot: SessionFoldersSnapshot = {
    version: 1,
    foldersMap: mapWith(get().foldersByDirectory, directory, applied),
    collapsedFolderIds: Object.keys(get().collapsedFolderIds),
    updatedAt: Date.now(),
  };
  const result = await saveSessionFolders(snapshot);
  if (!result.ok) {
    set({ lastError: result.error });
    return;
  }
  if (result.ignored === true) await useSessionFoldersStore.getState().load(); // older writer won LWW
}

export const useSessionFoldersStore: UseBoundStore<Mutate<StoreApi<SessionFoldersState>, []>> = create<SessionFoldersState>((set, get) => ({
  status: 'idle',
  foldersByDirectory: {},
  collapsedFolderIds: {},
  updatedAt: 0,
  lastError: null,
  hasLoaded: false,

  async load() {
    set({ status: get().hasLoaded ? 'ready' : 'loading', lastError: null });
    const { snapshot, error } = await loadSessionFolders();
    if (error !== null) {
      set({ status: 'error', lastError: error, hasLoaded: true });
      return;
    }
    const collapsed: Record<string, true> = {};
    for (const id of snapshot.collapsedFolderIds) collapsed[id] = true;
    set({ status: 'ready', foldersByDirectory: snapshot.foldersMap, collapsedFolderIds: collapsed, updatedAt: snapshot.updatedAt, lastError: null, hasLoaded: true });
  },

  createFolder: async (directory, name) => {
    if (name.trim() === '') return;
    await persist(set, get, directory, (folders) => [...folders, { id: newFolderId(), name: name.trim(), sessionIds: [], createdAt: Date.now() }]);
  },

  renameFolder: async (directory, folderId, name) => {
    await persist(set, get, directory, (folders) => folders
      .map((folder) => (folder.id === folderId ? { ...folder, name: name.trim() || folder.name } : folder)));
  },

  deleteFolder: async (directory, folderId) => {
    const collapsed = { ...get().collapsedFolderIds };
    delete collapsed[folderId];
    set({ collapsedFolderIds: collapsed });
    await persist(set, get, directory, (folders) => folders.filter((folder) => folder.id !== folderId));
  },

  assignSession: async (directory, folderId, sessionId) => {
    await persist(set, get, directory, (folders) => folders
      .map((folder) => ({ ...folder, sessionIds: folder.sessionIds.filter((id) => id !== sessionId) }))
      .map((folder) => (folder.id === folderId ? { ...folder, sessionIds: [...folder.sessionIds, sessionId] } : folder)));
  },

  unassignSession: async (directory, sessionId) => {
    await persist(set, get, directory, (folders) => folders
      .map((folder) => ({ ...folder, sessionIds: folder.sessionIds.filter((id) => id !== sessionId) })));
  },

  toggleCollapsed: (folderId) => {
    const current = get().collapsedFolderIds;
    const next = { ...current };
    if (next[folderId]) delete next[folderId];
    else next[folderId] = true;
    set({ collapsedFolderIds: next });
    // §5.22 keeps collapsed state inside the snapshot; ride a full POST.
    void saveSessionFolders({
      version: 1,
      foldersMap: get().foldersByDirectory,
      collapsedFolderIds: Object.keys(next),
      updatedAt: Date.now(),
    }).then((result) => {
      if (!result.ok) set({ lastError: result.error });
    }).catch(() => undefined);
  },
}));

/** Folder membership helper: session ids present in NO folder of the zone. */
export function unsortedSessionIds(directory: string, sessions: Array<{ id: string }>): string[] {
  const folders = useSessionFoldersStore.getState().foldersByDirectory[normalizeDirectory(directory)] ?? [];
  const inFolders = new Set(folders.flatMap((folder) => folder.sessionIds));
  return sessions.map((session) => session.id).filter((id) => !inFolders.has(id));
}

/** Reset for tests (the store has no server-sync dependency). */
export function __resetSessionFoldersStoreForTests(): void {
  useSessionFoldersStore.setState({ status: 'idle', foldersByDirectory: {}, collapsedFolderIds: {}, updatedAt: 0, lastError: null, hasLoaded: false });
}
