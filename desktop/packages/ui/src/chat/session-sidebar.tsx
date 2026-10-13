// SPDX-License-Identifier: Apache-2.0
/**
 * Session sidebar (doc 05 §D, SLICE-C task 2): new-draft nav, per-directory
 * zones with SERVER-PERSISTED folders (§5.22 store), lifecycle ordering,
 * live status, blocked badges, actions (real PATCH rename, archive, restore,
 * delete), search with exact-ID rule, draft targeting, and the archived
 * split view from the global sessions cache.
 */
import { useEffect, useSyncExternalStore, useMemo, useState, type ReactNode, type ChangeEvent } from 'react';
import { harnessClient, normalizeDirectory } from '../lib/nnd/client.ts';
import { useSessionViewStore } from '../sync/view-store.ts';
import { useGlobalSessionsStore, useGlobalSessionStatusStore, useGlobalSyncStore } from '../sync/global-stores.ts';
import { addNativeWorkspace, readNativeWorkspaceAdmissions } from '../lib/nnd/workspace-admission.ts';
import { WorkspaceRecoveryControls } from './workspace-recovery-controls.tsx';
import { useSessionOrderingStore } from '../sync/session-ordering.ts';
import { useSessionFoldersStore, unsortedSessionIds } from '../stores/useSessionFoldersStore.ts';
import type { SyncEngine } from '../sync/sync-engine.ts';
import type { Session, SessionStatus } from '../lib/nnd/types.ts';
import { toast } from 'sonner';
import { formatRelative } from './time-format.ts';
import { sidebarHierarchy } from './session-sidebar-hierarchy.ts';
import { childActivityPhrase, sessionAttention } from './session-row-evidence.ts';
import { pinnedSessionIds, useSessionPinnedStore } from '../stores/useSessionPinnedStore.ts';
import { getRuntimeKey } from '../lib/runtime-switch.ts';
import { clearKnownSessionTreePins } from './session-pin-cleanup.ts';
import { expandedParentIds, useSessionExpansionStore } from '../stores/useSessionExpansionStore.ts';
import { fusionIdentityFromSession } from '../lib/multirun/fusion.ts';
import { filterSessions, orderSessionsByLifecycleWrap, sessionDepths, shortDirectory } from './session-sidebar-utils.ts';
import { suggestAndApplyRename } from './suggest-name.ts';

const AVATAR_LIMIT = 50;

function subscribeRuntimeKey(notify: () => void): () => void {
  window.addEventListener('notnative:runtime-endpoint-changed', notify);
  return () => window.removeEventListener('notnative:runtime-endpoint-changed', notify);
}

export interface ChatSidebarProps {
  engine: SyncEngine;
  currentDirectory: string;
  currentSessionId: string | null;
  onOpenArchive?: () => void;
  onRunFusion?: (session: Session) => void;
  actions: {
    openDraft: (directory: string) => void;
    openSession: (sessionID: string, directory: string) => void;
    rename: (sessionID: string, title: string) => Promise<void>;
    archive: (sessionID: string, directory: string) => Promise<void>;
    restore: (sessionID: string, directory: string) => Promise<void>;
    deleteSession: (sessionID: string, directory: string) => Promise<void>;
  };
}

export function ChatSidebar(props: ChatSidebarProps): ReactNode {
  const [query, setQuery] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [collapsedZones, setCollapsedZones] = useState<Record<string, true>>({});
  const [canAddWorkspace, setCanAddWorkspace] = useState(false);
  const [workspaceRefreshKey, setWorkspaceRefreshKey] = useState(0);
  const runtimeKey = useSyncExternalStore(subscribeRuntimeKey, getRuntimeKey);
  const projects = useGlobalSyncStore((state) => state.projects);
  const sessionsGlobal = useSyncExternalStore(useGlobalSessionsStore.subscribe, useGlobalSessionsStore.getState);
  const folders = useSyncExternalStore(useSessionFoldersStore.subscribe, useSessionFoldersStore.getState);
  const statusById = useSyncExternalStore(useGlobalSessionStatusStore.subscribe, () => useGlobalSessionStatusStore.getState().statusById);
  const orderingRanks = useSyncExternalStore(useSessionOrderingStore.subscribe, () => useSessionOrderingStore.getState().rankById) as Record<string, number>;
  const pins = useSyncExternalStore(useSessionPinnedStore.subscribe, () => useSessionPinnedStore.getState().pins);
  const expanded = useSyncExternalStore(useSessionExpansionStore.subscribe, () => useSessionExpansionStore.getState().expanded);
  const expandedIds = useMemo(() => expandedParentIds(expanded, runtimeKey), [expanded, runtimeKey]);
  const selectable = useMemo(() => new Map(sessionsGlobal.active.filter((session) => !session.parentID).map((session) => [session.id, session])), [sessionsGlobal.active]);
  const selected = [...selectedIds].map((id) => selectable.get(id)).filter((session): session is Session => Boolean(session));
  const toggleSelected = (ids: string[]): void => setSelectedIds((current) => {
    const next = new Set(current);
    const allSelected = ids.every((id) => next.has(id));
    for (const id of ids) if (allSelected) next.delete(id); else next.add(id);
    return next;
  });
  const clearSelected = (): void => setSelectedIds(new Set());
  const bulkLifecycle = async (kind: 'archive' | 'delete'): Promise<void> => {
    if (bulkBusy || selected.length === 0) return;
    if (kind === 'delete' && !confirm(`Delete ${selected.length} selected sessions and their subtasks? This cannot be undone.`)) return; // eslint-disable-line no-alert
    const runtimeKey = getRuntimeKey();
    setBulkBusy(true);
    const succeeded: string[] = [];
    try {
      for (const session of selected) {
        try {
          await props.actions[kind === 'archive' ? 'archive' : 'deleteSession'](session.id, session.directory ?? '');
          if (kind === 'delete') clearKnownSessionTreePins(session, [...sessionsGlobal.active, ...sessionsGlobal.archived], runtimeKey);
          succeeded.push(session.id);
        } catch { /* Keep failed rows selected for an explicit retry. */ }
      }
      setSelectedIds((current) => new Set([...current].filter((id) => !succeeded.includes(id))));
      if (succeeded.length !== selected.length) toast.error(`${selected.length - succeeded.length} session${selected.length - succeeded.length === 1 ? '' : 's'} could not be ${kind === 'archive' ? 'archived' : 'deleted'}`);
    } finally { setBulkBusy(false); }
  };
  const bulkMove = async (): Promise<void> => {
    if (bulkBusy || selected.length === 0) return;
    const directories = new Set(selected.map((session) => normalizeDirectory(session.directory ?? 'global')));
    if (directories.size !== 1) { toast.message('Select sessions from one workspace to move them into a folder'); return; }
    const directory = [...directories][0]!;
    const choices = folders.foldersByDirectory[directory] ?? [];
    if (choices.length === 0) { toast.message('Create a folder in this workspace first'); return; }
    const pick = prompt(`Move ${selected.length} sessions into folder:\n${choices.map((folder, at) => `${at + 1}. ${folder.name}`).join('\n')}`, '1'); // eslint-disable-line no-alert
    if (pick === null) return;
    const index = Number(pick.trim()) - 1;
    const target = Number.isInteger(index) ? choices[index] : undefined;
    if (!target) { toast.error('Choose a folder number from the list'); return; }
    setBulkBusy(true);
    try {
      const saved = await useSessionFoldersStore.getState().assignManySessions(directory, target.id, selected.map((session) => session.id));
      if (saved) clearSelected(); else toast.error('Could not save the folder move');
    } finally { setBulkBusy(false); }
  };

  useEffect(() => { setSelectedIds((current) => new Set([...current].filter((id) => selectable.has(id)))); }, [selectable]);

  useEffect(() => { void useSessionFoldersStore.getState().load(); }, []);
  useEffect(() => {
    let live = true;
    setCanAddWorkspace(false);
    void readNativeWorkspaceAdmissions().then(() => { if (live) setCanAddWorkspace(true); })
      .catch(() => { if (live) setCanAddWorkspace(false); });
    return () => { live = false; };
  }, [runtimeKey]);
  useEffect(() => {
    if (!useGlobalSessionsStore.getState().hasLoaded) void useGlobalSessionsStore.getState().loadSessions();
  }, [runtimeKey]);
  useEffect(() => {
    const refresh = (): void => { useSessionPinnedStore.getState().reload(); useSessionExpansionStore.getState().reload(); };
    window.addEventListener('storage', refresh);
    return () => window.removeEventListener('storage', refresh);
  }, []);

  const zones = useMemo(() => {
    const grouped = new Map<string, Session[]>();
    for (const session of sessionsGlobal.active) {
      const directory = normalizeDirectory(session.directory ?? 'global');
      const list = grouped.get(directory) ?? [];
      list.push(session);
      grouped.set(directory, list);
    }
    const current = normalizeDirectory(props.currentDirectory);
    if (current && !grouped.has(current)) grouped.set(current, []);
    return grouped;
  }, [sessionsGlobal.active, props.currentDirectory]);

  const filtered = useMemo(() => filterSessions([...sessionsGlobal.active], query), [sessionsGlobal.active, query]);
  const filteredDirectories = new Set(filtered.map((session) => normalizeDirectory(session.directory ?? 'global')));
  const workspaceOptions = projects.filter((project) => typeof project.worktree === 'string')
    .map((project) => ({ directory: normalizeDirectory(String(project.worktree)),
      label: typeof project.name === 'string' ? project.name : String(project.worktree) }));
  const currentWorkspace = normalizeDirectory(props.currentDirectory);
  if (currentWorkspace && !workspaceOptions.some((item) => item.directory === currentWorkspace)) {
    workspaceOptions.unshift({ directory: currentWorkspace, label: currentWorkspace });
  }
  const addWorkspace = async (): Promise<void> => {
    const path = prompt('Enter the absolute folder path to add as a workspace:'); // eslint-disable-line no-alert
    if (path === null) return;
    try {
      const directory = await addNativeWorkspace(path);
      const refreshed = await harnessClient.listProjects();
      if (refreshed.error || !refreshed.data) throw new Error('Workspace was admitted; refresh to see it in the list.');
      useGlobalSyncStore.getState().set({ projects: refreshed.data as unknown as Record<string, unknown>[] });
      setWorkspaceRefreshKey(key => key + 1);
      props.actions.openDraft(normalizeDirectory(directory));
    } catch (error) { toast.error(error instanceof Error ? error.message : 'Could not add workspace.'); }
  };
  if (!query.trim() && props.currentDirectory) filteredDirectories.add(normalizeDirectory(props.currentDirectory));
  const archivedInDirectory = sessionsGlobal.archived.filter((session) => normalizeDirectory(session.directory ?? 'global') === normalizeDirectory(props.currentDirectory));
  const nameCounts = new Map<string, number>();
  for (const directory of zones.keys()) {
    const name = shortDirectory(directory).toLocaleLowerCase();
    nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  }

  return (
    <aside className="flex w-72 min-w-64 flex-col border-r border-white/10 bg-neutral-950/80" data-testid="session-sidebar">
      <nav className="p-2">
        {workspaceOptions.length > 0 ? <label className="mb-2 block text-[11px] text-neutral-500">
          Workspace
          <select aria-label="Workspace" value={currentWorkspace} className="mt-1 w-full rounded bg-neutral-900 px-2 py-1.5 text-[12px] text-neutral-200"
            onChange={(event) => props.actions.openDraft(event.target.value)}>
            {workspaceOptions.map((item) => <option key={item.directory} value={item.directory}>{item.label}</option>)}
          </select>
        </label> : null}
        {canAddWorkspace ? <button type="button" className="mb-2 w-full rounded px-2 py-1 text-left text-[11px] text-neutral-400 hover:bg-white/5 hover:text-neutral-100"
          onClick={() => void addWorkspace()}>+ Add workspace</button> : null}
        <WorkspaceRecoveryControls runtimeKey={runtimeKey} refreshKey={workspaceRefreshKey} />
        <button type="button" className="w-full rounded-lg bg-white/5 px-3 py-2 text-left text-[13px] text-neutral-200 hover:bg-white/10" onClick={() => props.actions.openDraft(props.currentDirectory)}>
          + New session
        </button>
        <button type="button" data-testid="sidebar-select-toggle" aria-pressed={selecting} className="mt-1 w-full rounded-lg px-3 py-1 text-left text-[11px] text-neutral-500 hover:bg-white/5 hover:text-neutral-200" onClick={() => { setSelecting(!selecting); clearSelected(); }}>
          {selecting ? 'Exit selection' : 'Select sessions'}
        </button>
      </nav>
      {selecting ? <div className="border-y border-white/10 px-3 py-2 text-[11px] text-neutral-400" data-testid="sidebar-bulk-actions">
        <div>{selected.length} selected <span className="text-neutral-600">· parent sessions; children follow their parent</span></div>
        <div className="mt-1 flex gap-2">
          <button type="button" disabled={bulkBusy || selected.length === 0} onClick={() => void bulkLifecycle('archive')}>Archive</button>
          <button type="button" disabled={bulkBusy || selected.length === 0} onClick={() => void bulkMove()}>Move to folder</button>
          <button type="button" disabled={bulkBusy || selected.length === 0} className="text-red-400" onClick={() => void bulkLifecycle('delete')}>Delete</button>
        </div>
      </div> : null}
      <div className="px-3">
        <input
          value={query}
          onChange={(event: ChangeEvent<HTMLInputElement>) => setQuery(event.target.value)}
          placeholder="Search sessions…"
          aria-label="Search sessions"
          data-testid="sidebar-search"
          className="w-full rounded-lg border border-white/10 bg-neutral-900 px-2 py-1.5 text-[12px] text-neutral-200 outline-none focus:border-white/25"
        />
        {query.length > 0 ? <div className="mt-1 text-[10px] text-neutral-600">{filtered.length} match{filtered.length === 1 ? '' : 'es'}</div> : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {sessionsGlobal.status === 'error' ? <div role="alert" className="mb-2 rounded-lg border border-amber-800/50 px-2 py-2 text-[11px] text-amber-300" data-testid="sidebar-sessions-error">
          Could not refresh sessions. <button type="button" className="underline" onClick={() => void useGlobalSessionsStore.getState().loadSessions()}>Try again</button>
        </div> : null}
        {[...zones.entries()]
          .filter(([directory]) => filteredDirectories.has(directory))
          .sort(([left], [right]) => left === normalizeDirectory(props.currentDirectory) ? -1 : right === normalizeDirectory(props.currentDirectory) ? 1 : left.localeCompare(right))
          .map(([directory, sessions]) => (
            <Zone
              key={directory}
              directory={directory}
              sessions={filtered.filter((session) => normalizeDirectory(session.directory ?? 'global') === directory)}
              statusById={statusById}
              ranks={orderingRanks}
              pinnedIds={pinnedSessionIds(pins, directory)}
              currentSessionId={props.currentSessionId}
              actions={props.actions}
              folders={folders.foldersByDirectory[directory] ?? []}
              collapsed={folders.collapsedFolderIds}
              active={directory === normalizeDirectory(props.currentDirectory)}
              forceOpen={query.trim().length > 0}
              zoneCollapsed={Boolean(collapsedZones[directory])}
              onToggleZone={() => setCollapsedZones((current) => {
                const next = { ...current };
                if (next[directory]) delete next[directory]; else next[directory] = true;
                return next;
              })}
              duplicateName={(nameCounts.get(shortDirectory(directory).toLocaleLowerCase()) ?? 0) > 1}
              sessionListStatus={sessionsGlobal.status}
              selecting={selecting}
              selectedIds={selectedIds}
              onToggleSelected={toggleSelected}
              onRunFusion={props.onRunFusion}
              expandedIds={expandedIds}
              onToggleExpanded={(id) => useSessionExpansionStore.getState().toggle(id, runtimeKey)}
            />
          ))}
      </div>
      <div className="border-t border-white/10 px-2 py-2" data-testid="sidebar-archive">
        {props.onOpenArchive ? <button type="button" data-testid="sidebar-archive-view" className="w-full rounded px-2 py-1 text-left text-[11px] text-neutral-400 hover:bg-white/5 hover:text-neutral-100" onClick={props.onOpenArchive}>
          View all archived sessions ({sessionsGlobal.archived.length})
        </button> : null}
        <button
          type="button"
          data-testid="sidebar-archive-toggle"
          aria-expanded={showArchived}
          onClick={() => setShowArchived(!showArchived)}
          className="flex w-full items-center gap-1 px-2 py-1 text-left text-[11px] uppercase tracking-wide text-neutral-500 hover:text-neutral-300"
        >
          <span aria-hidden>{showArchived ? '▾' : '▸'}</span>
          Archive ({archivedInDirectory.length})
        </button>
        {showArchived ? (
          <ul>
            {archivedInDirectory.length === 0 ? <li className="px-2 py-1 text-[11px] text-neutral-600">Nothing archived in this workspace.</li> : null}
            {archivedInDirectory.slice(0, AVATAR_LIMIT).map((session) => (
              <ArchivedRow key={session.id} session={session} actions={props.actions} />
            ))}
          </ul>
        ) : null}
      </div>
    </aside>
  );
}

function Zone({ directory, sessions, statusById, ranks, pinnedIds, actions, currentSessionId, folders, collapsed, active, forceOpen, zoneCollapsed, onToggleZone, duplicateName, selecting, selectedIds, onToggleSelected, sessionListStatus, onRunFusion, expandedIds, onToggleExpanded }: { directory: string; sessions: Session[]; statusById: Record<string, SessionStatus>; ranks: Record<string, number>; pinnedIds: ReadonlySet<string>; actions: ChatSidebarProps['actions']; currentSessionId: string | null; folders: import('../lib/session-folders.ts').SessionFolder[]; collapsed: Record<string, true>; active: boolean; forceOpen: boolean; zoneCollapsed: boolean; onToggleZone: () => void; duplicateName: boolean; selecting: boolean; selectedIds: ReadonlySet<string>; onToggleSelected: (ids: string[]) => void; sessionListStatus: 'idle' | 'loading' | 'ready' | 'error'; onRunFusion?: (session: Session) => void; expandedIds: ReadonlySet<string>; onToggleExpanded: (id: string) => void }): ReactNode {
  const zoneOpen = forceOpen || !zoneCollapsed;
  // Lifecycle ordering per doc 04 §F.10: baseline desc → created desc → id asc.
  const ordered = orderSessionsByLifecycleWrap(sessions);
  // Search shows only matching rows; an omitted parent is not unavailable.
  const hierarchy = forceOpen ? null : sidebarHierarchy(ordered, folders, AVATAR_LIMIT, pinnedIds, expandedIds,
    new Set(ordered.filter((session) => sessionAttention(session)).map((session) => session.id)));
  const childParents = new Set(ordered.map((session) => session.parentID).filter((id): id is string => Boolean(id)));
  const shown = new Set(hierarchy?.visible.filter((id) => {
    if ((hierarchy.depth.get(id) ?? 0) === 0) return true;
    let parentId = hierarchy.byId.get(id)?.parentID;
    const seen = new Set([id]);
    while (parentId && hierarchy.byId.has(parentId) && !seen.has(parentId)) {
      if (!expandedIds.has(parentId)) return false;
      seen.add(parentId);
      parentId = hierarchy.byId.get(parentId)?.parentID;
    }
    return true;
  }) ?? []);
  // A collapsed branch must still advertise NNA-authored attention. Without
  // this, a child needing input can vanish entirely behind its parent (or the
  // recent-row cap) until the operator happens to open that branch.
  const hiddenAttention = new Map<string, string[]>();
  if (!forceOpen) {
    const all = new Map(ordered.map((session) => [session.id, session]));
    for (const session of ordered) {
      if (shown.has(session.id)) continue;
      const attention = sessionAttention(session);
      if (!attention) continue;
      const seen = new Set([session.id]);
      let parentId = session.parentID;
      while (parentId && !seen.has(parentId)) {
        seen.add(parentId);
        if (shown.has(parentId) && !expandedIds.has(parentId)) {
          hiddenAttention.set(parentId, [...(hiddenAttention.get(parentId) ?? []), attention]);
          break;
        }
        parentId = all.get(parentId)?.parentID;
      }
    }
  }
  const searchRows = forceOpen ? ordered.slice(0, AVATAR_LIMIT) : [];
  const byId = hierarchy?.byId ?? new Map(searchRows.map((session) => [session.id, session]));
  const depthById = hierarchy?.depth ?? sessionDepths(searchRows);
  const visibleUnsorted = hierarchy?.unfiled.filter((id) => shown.has(id)) ?? unsortedSessionIds(directory, searchRows);
  const orphaned = hierarchy?.unavailableParent.filter((id) => shown.has(id)) ?? [];
  const foldersState = useSessionFoldersStore.getState();
  const createFolder = (name: string): void => { void useSessionFoldersStore.getState().createFolder(directory, name); };

  return (
    <section className="mb-3" data-testid="workspace-zone" data-active={active ? 'true' : undefined}>
      <header className="mb-1 flex items-center justify-between px-2">
        <button type="button" aria-expanded={zoneOpen} aria-label={`${zoneOpen ? 'Collapse' : 'Expand'} ${directory || 'general'} workspace`} data-testid="workspace-zone-toggle" disabled={forceOpen}
          className={`flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left text-[11px] hover:text-neutral-200 ${active ? 'text-neutral-300' : 'text-neutral-500'}`}
          onClick={onToggleZone} title={forceOpen ? 'Search results keep this workspace open' : directory}>
          <span aria-hidden className="shrink-0 text-neutral-600">{zoneOpen ? '▾' : '▸'}</span>
          <span className="truncate font-medium">{shortDirectory(directory)}</span>
          {duplicateName ? <span className="truncate text-[10px] text-neutral-700">{directory}</span> : null}
          <span className="shrink-0 text-neutral-700">{sessions.length}</span>
        </button>
        <div className="flex items-center gap-1">
          <button type="button" aria-label={`New folder in ${directory || 'general'}`} data-testid={`folder-create-${directory.replace(/[^\w]/g, '_')}`} className="text-[11px] text-neutral-600 hover:text-neutral-300" onClick={() => {
            const name = prompt('New folder name', 'Folder'); // eslint-disable-line no-alert
            if (name !== null && name.trim()) createFolder(name);
          }}>▤+</button>
          <button type="button" aria-label={`New draft session in ${directory || 'general'}`} className="text-[11px] text-neutral-600 hover:text-neutral-300" onClick={() => actions.openDraft(directory)}>+</button>
        </div>
      </header>
      {zoneOpen ? <ul>
        {folders.map((folder) => {
          const isCollapsed = !forceOpen && Boolean(collapsed[folder.id]);
          const inside = hierarchy
            ? hierarchy.visible.filter((id) => shown.has(id) && hierarchy.folder.get(id) === folder.id && !orphaned.includes(id)).map((id) => byId.get(id)!)
            : folder.sessionIds.map((id) => byId.get(id)).filter((session): session is Session => Boolean(session));
          const folderNormal = inside.filter((session) => !hierarchy?.unavailableIds.has(session.id));
          const folderUnavailable = inside.filter((session) => hierarchy?.unavailableIds.has(session.id));
          const folderSelectable = [...new Set(folder.sessionIds.filter((id) => byId.get(id) && !byId.get(id)?.parentID))];
          // §5.22 sessionIds are the record of truth: show the count even for
          // ids that belong to another workspace surface in this directory.
          return (
            <li key={folder.id} data-testid={`folder-${folder.id}`}>
              <div className="group flex items-center gap-1 rounded-lg px-2 py-1 hover:bg-white/5">
                {selecting && folderSelectable.length > 0 ? <input type="checkbox" aria-label={`Select sessions in ${folder.name}`} checked={folderSelectable.every((id) => selectedIds.has(id))} onChange={() => onToggleSelected(folderSelectable)} /> : null}
                <button type="button" aria-expanded={!isCollapsed} onClick={() => useSessionFoldersStore.getState().toggleCollapsed(folder.id)} className="flex min-w-0 flex-1 items-center gap-1 text-left text-[11px] text-neutral-400" data-testid="folder-header">
                  <span aria-hidden>{isCollapsed ? '▸' : '▾'}</span>
                  <span className="truncate">▤ {folder.name}</span>
                  <span className="text-neutral-700">{folder.sessionIds.length}</span>
                </button>
                <FolderActions directory={directory} folderId={folder.id} folderName={folder.name} hasSessions={folder.sessionIds.length > 0} />
              </div>
              {!isCollapsed ? (
                <ul className="ml-3 border-l border-white/5">
                  {folderNormal.map((session) => (
                    <SidebarRow key={session.id} session={session} status={statusById[session.id]} currentSessionId={currentSessionId} actions={actions} pinned={pinnedIds.has(session.id)} folderId={folder.sessionIds.includes(session.id) ? folder.id : undefined} depth={depthById.get(session.id) ?? 0} selecting={selecting} selected={selectedIds.has(session.id)} onToggleSelected={() => onToggleSelected([session.id])} hasChildren={!forceOpen && childParents.has(session.id)} expanded={expandedIds.has(session.id)} onToggleExpanded={() => onToggleExpanded(session.id)} hiddenAttention={hiddenAttention.get(session.id)} onRunFusion={onRunFusion} />
                  ))}
                  {folderUnavailable.length > 0 ? <li className="px-2 pt-2 text-[10px] uppercase tracking-wide text-neutral-700">Parent unavailable</li> : null}
                  {folderUnavailable.map((session) => (
                    <SidebarRow key={session.id} session={session} status={statusById[session.id]} currentSessionId={currentSessionId} actions={actions} pinned={pinnedIds.has(session.id)} folderId={folder.sessionIds.includes(session.id) ? folder.id : undefined} depth={depthById.get(session.id) ?? 0} selecting={selecting} selected={selectedIds.has(session.id)} onToggleSelected={() => onToggleSelected([session.id])} hasChildren={!forceOpen && childParents.has(session.id)} expanded={expandedIds.has(session.id)} onToggleExpanded={() => onToggleExpanded(session.id)} hiddenAttention={hiddenAttention.get(session.id)} onRunFusion={onRunFusion} />
                  ))}
                  {inside.length === 0 ? <li className="px-2 py-1 text-[10px] text-neutral-600">Empty folder — sessions land via the row menu.</li> : null}
                </ul>
              ) : null}
            </li>
          );
        })}
        {(folders.length > 0 && (visibleUnsorted.length > 0 || orphaned.length > 0)) || folders.length > 0
          ? <li className="px-2 pt-1 text-[10px] uppercase tracking-wide text-neutral-700">Sessions</li>
          : null}
        {ordered.length === 0 && folders.length === 0 ? <li className="px-2 py-1 text-[11px] text-neutral-600" data-testid="zone-empty">{sessionListStatus === 'loading' ? 'Loading sessions…' : sessionListStatus === 'error' ? 'Could not refresh sessions.' : 'No sessions in this workspace yet.'}</li> : null}
        {visibleUnsorted.map((sessionID) => (
          <SidebarRow key={sessionID} session={byId.get(sessionID)!} status={statusById[sessionID]} currentSessionId={currentSessionId} actions={actions} pinned={pinnedIds.has(sessionID)} depth={depthById.get(sessionID) ?? 0} selecting={selecting} selected={selectedIds.has(sessionID)} onToggleSelected={() => onToggleSelected([sessionID])} hasChildren={!forceOpen && childParents.has(sessionID)} expanded={expandedIds.has(sessionID)} onToggleExpanded={() => onToggleExpanded(sessionID)} hiddenAttention={hiddenAttention.get(sessionID)} onRunFusion={onRunFusion} />
        ))}
        {orphaned.length > 0 ? <li className="px-2 pt-2 text-[10px] uppercase tracking-wide text-neutral-700">Parent unavailable</li> : null}
        {orphaned.map((sessionID) => (
          <SidebarRow key={sessionID} session={byId.get(sessionID)!} status={statusById[sessionID]} currentSessionId={currentSessionId} actions={actions} pinned={pinnedIds.has(sessionID)} depth={depthById.get(sessionID) ?? 0} selecting={selecting} selected={selectedIds.has(sessionID)} onToggleSelected={() => onToggleSelected([sessionID])} hasChildren={!forceOpen && childParents.has(sessionID)} expanded={expandedIds.has(sessionID)} onToggleExpanded={() => onToggleExpanded(sessionID)} hiddenAttention={hiddenAttention.get(sessionID)} onRunFusion={onRunFusion} />
        ))}
      </ul> : null}
      {zoneOpen && folders.length > 0 ? <div className="px-2 pt-1 text-[10px] text-neutral-700">{foldersState.status === 'error' ? 'folder store error' : `${folders.length} folder(s)`}</div> : null}
    </section>
  );
}

function FolderActions({ directory, folderId, folderName, hasSessions }: { directory: string; folderId: string; folderName: string; hasSessions: boolean }): ReactNode {
  return (
    <div className="flex items-center gap-1 text-[10px] text-neutral-600 opacity-0 transition group-hover:opacity-100">
      <button type="button" aria-label={`Rename folder ${folderName}`} onClick={() => {
        const name = prompt('Rename folder', folderName); // eslint-disable-line no-alert
        if (name !== null) void useSessionFoldersStore.getState().renameFolder(directory, folderId, name).then(() => undefined);
      }}>✎</button>
      <button type="button" aria-label={`Delete folder ${folderName}`} onClick={() => {
        if (hasSessions && !confirm('Delete the folder? Inside sessions survive as unsorted.')) return; // eslint-disable-line no-alert
        void useSessionFoldersStore.getState().deleteFolder(directory, folderId);
      }}>🗑</button>
    </div>
  );
}

function SidebarRow({ session, status, currentSessionId, actions, pinned, folderId, depth = 0, selecting, selected, onToggleSelected, hasChildren, expanded, onToggleExpanded, hiddenAttention, onRunFusion }: { session: Session; status: SessionStatus | undefined; currentSessionId: string | null; actions: ChatSidebarProps['actions']; pinned: boolean; folderId?: string; depth?: number; selecting: boolean; selected: boolean; onToggleSelected: () => void; hasChildren: boolean; expanded: boolean; onToggleExpanded: () => void; hiddenAttention?: string[]; onRunFusion?: (session: Session) => void }): ReactNode {
  const active = status && status.type !== 'idle';
  const attention = sessionAttention(session);
  const activity = !attention ? childActivityPhrase(session.metadata) : null;
  return (
    <li className={`group flex items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-white/5 ${depth > 0 ? 'border-l border-white/10' : ''}`} style={depth > 0 ? { marginLeft: `${depth * 16}px` } : undefined} data-child-session={session.parentID ? 'true' : undefined} data-child-depth={depth > 0 ? depth : undefined} data-attention={attention ?? undefined}>
      {hasChildren ? <button type="button" aria-label={`${expanded ? 'Collapse' : 'Expand'} ${session.title || 'session'} subtasks`} aria-expanded={expanded} className="shrink-0 text-[11px] text-neutral-500 hover:text-neutral-200" onClick={onToggleExpanded}>{expanded ? '▾' : '▸'}</button> : null}
      {selecting && !session.parentID ? <input type="checkbox" aria-label={`Select ${session.title || 'session'}`} checked={selected} onChange={onToggleSelected} /> : null}
      <button type="button" className="min-w-0 flex-1 text-left" onClick={() => selecting && !session.parentID ? onToggleSelected() : actions.openSession(session.id, session.directory ?? '')} data-testid="session-row">
        <div className="flex items-center gap-1.5">
          <span aria-hidden className={`inline-block h-1.5 w-1.5 rounded-full ${attention || hiddenAttention?.length ? 'bg-amber-400' : active ? 'bg-sky-400' : 'bg-neutral-700'}`} />
          {session.parentID ? <span className="text-[10px] text-neutral-600" aria-label="Child session">↳</span> : null}
          <span className={`min-w-0 flex-1 truncate text-[13px] ${currentSessionId === session.id ? 'text-neutral-100' : 'text-neutral-300'}`}>{session.title || 'Untitled Session'}</span>
          {pinned ? <span aria-label="Pinned session" className="text-[10px] text-amber-400">◆</span> : null}
        </div>
        <div className="pl-3 text-[10px] text-neutral-600">{formatRelative(session.time.updated)}{session.parentID && session.agent ? <span> · {session.agent}</span> : null}{attention ? <span className="text-amber-300"> · {attention}</span> : null}{hiddenAttention?.length ? <span className="text-amber-300" data-testid="collapsed-subtask-attention"> · {hiddenAttention.length} subtask{hiddenAttention.length === 1 ? ' needs' : 's need'} attention</span> : null}{activity ? <span className="text-sky-300" data-testid={session.parentID ? 'child-current-activity' : 'session-current-activity'}> · {activity}</span> : null}</div>
      </button>
      {!selecting ? <div className="flex items-center gap-1 text-[10px] text-neutral-600 opacity-0 transition group-hover:opacity-100">
        <button type="button" aria-label={`${pinned ? 'Unpin' : 'Pin'} ${session.title || 'session'}`} className="hover:text-amber-300" onClick={() => useSessionPinnedStore.getState().toggle(session.directory ?? 'global', session.id)}>{pinned ? '◆' : '◇'}</button>
        {!session.parentID ? <>
        <button type="button" aria-label={`Rename ${session.title || 'session'}`} data-testid="session-rename" className="hover:text-neutral-200" onClick={() => {
          const title = prompt('Rename session', session.title ?? ''); // eslint-disable-line no-alert
          if (title !== null) void actions.rename(session.id, title);
        }}>✎</button>
        <button type="button" aria-label={`Suggest a name for ${session.title || 'session'}`} data-testid="session-suggest-name" className="hover:text-sky-300" onClick={() => suggestAndApplyRename(session.id, session.directory ?? '', actions.rename)}>✶</button>
        <button type="button" aria-label={`Archive ${session.title || 'session'}`} className="hover:text-neutral-200" onClick={() => void actions.archive(session.id, session.directory ?? '').catch(() => toast.error('Failed to archive the session'))}>🗄</button>
        {fusionTarget(session) ? <button type="button" aria-label={`Run fusion on ${session.title || 'session'}`} data-testid="run-fusion" className="hover:text-sky-300" onClick={() => onRunFusion?.(session)}>⨁</button> : null}
        <button type="button" aria-label={`File ${session.title || 'session'} into a folder`} data-testid="session-file-into" className="hover:text-neutral-200" onClick={() => {
          const folders = foldersOfSession(session);
          if (folders.length === 0) { toast.message('Create a folder first (+ ▤+ in the workspace header)'); return; }
          const pick = prompt(`File into folder:\n${folders.map((folder, at) => `${at + 1}. ${folder.name}`).join('\n')}`, '1'); // eslint-disable-line no-alert
          const index = Number((pick ?? '').trim()) - 1;
          const target = Number.isInteger(index) && folders[index] ? folders[index] : null;
          if (target) void useSessionFoldersStore.getState().assignSession(session.directory ?? '', target.id, session.id);
        }}>▤</button>
        </> : null}
        {folderId ? <button type="button" aria-label="Unfile from folder" onClick={() => void useSessionFoldersStore.getState().unassignSession(session.directory ?? '', session.id)}>⤫</button> : null}
        {!session.parentID ? <button type="button" aria-label={`Delete ${session.title || 'session'}`} className="hover:text-red-400" onClick={() => {
          if (!confirm(`Delete ${session.title || 'session'} and its subtasks?`)) return; // eslint-disable-line no-alert
          const runtimeKey = getRuntimeKey();
          const known = [...useGlobalSessionsStore.getState().active, ...useGlobalSessionsStore.getState().archived];
          void actions.deleteSession(session.id, session.directory ?? '').then(() => clearKnownSessionTreePins(session, known, runtimeKey)).catch(() => toast.error('Failed to delete the session'));
        }}>🗑</button> : null}
      </div> : null}
    </li>
  );
}

function fusionTarget(session: Session): boolean {
  return fusionIdentityFromSession(session) !== null;
}

function ArchivedRow({ session, actions }: { session: Session; actions: ChatSidebarProps['actions'] }): ReactNode {
  return (
    <li className="group flex items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-white/5">
      <button type="button" className="min-w-0 flex-1 text-left" onClick={() => actions.openSession(session.id, session.directory ?? '')} data-testid="archived-row">
        <div className="truncate text-[13px] text-neutral-500">{session.title || 'Untitled Session'}</div>
        <div className="text-[10px] text-neutral-700">archived {formatRelative(session.time.archived ?? session.time.updated)}</div>
      </button>
      {!session.parentID ? <div className="flex items-center gap-1 text-[10px] text-neutral-600 opacity-0 transition group-hover:opacity-100">
        <button type="button" aria-label={`Restore ${session.title || 'session'}`} data-testid="restore-session" className="hover:text-neutral-200" onClick={() => void actions.restore(session.id, session.directory ?? '').catch(() => toast.error('Failed to restore the session'))}>↩</button>
        <button type="button" aria-label={`Delete ${session.title || 'session'}`} className="hover:text-red-400" onClick={() => {
          if (!confirm(`Delete ${session.title || 'session'} permanently?`)) return; // eslint-disable-line no-alert
          const runtimeKey = getRuntimeKey();
          const known = [...useGlobalSessionsStore.getState().active, ...useGlobalSessionsStore.getState().archived];
          void actions.deleteSession(session.id, session.directory ?? '').then(() => clearKnownSessionTreePins(session, known, runtimeKey)).catch(() => toast.error('Failed to delete the session'));
        }}>🗑</button>
      </div> : null}
    </li>
  );
}

/** Folders that live in the session's directory (the assignment key). */
function foldersOfSession(session: Session): import('../lib/session-folders.ts').SessionFolder[] {
  const directory = normalizeDirectory(session.directory ?? '');
  return useSessionFoldersStore.getState().foldersByDirectory[directory] ?? [];
}

export { toast, sessionAttention, childActivityPhrase };
