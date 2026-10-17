// SPDX-License-Identifier: Apache-2.0
/**
 * Session sidebar (doc 05 §D, SLICE-C task 2): new-draft nav, per-directory
 * zones with SERVER-PERSISTED folders (§5.22 store), lifecycle ordering,
 * live status, blocked badges, actions (real PATCH rename, archive, restore,
 * delete), search with exact-ID rule, draft targeting, and the archived
 * split view from the global sessions cache.
 */
import { useCallback, useEffect, useSyncExternalStore, useMemo, useRef, useState, type ReactNode, type ChangeEvent } from 'react';
import { normalizeDirectory } from '../lib/nnd/client.ts';
import { useSessionViewStore } from '../sync/view-store.ts';
import { useGlobalSessionsStore, useGlobalSessionStatusStore, useGlobalSyncStore } from '../sync/global-stores.ts';
import { useWorkspaceDisplayStore, workspaceDisplay, isDefaultWorkspace } from '../stores/useWorkspaceDisplayStore.ts';
import { readDraft, subscribeDraftChanges, getDraftRevision } from './drafts.ts';
import { DraftPersistenceStatus } from './draft-persistence-status.tsx';
import { ConversationDraftRows } from './conversation-draft-rows.tsx';
import { useConversationDraftStore } from '../stores/useConversationDraftStore.ts';
import { WorkspaceMenu } from './workspace-menu.tsx';
import { useSidebarPreference, oneOf, collapsedMap } from './sidebar-preferences.ts';
import { useWorkspaceStore } from '../stores/useWorkspaceStore.ts';
import { WorkspaceRecoveryControls } from './workspace-recovery-controls.tsx';
import { useSessionOrderingStore } from '../sync/session-ordering.ts';
import { useSessionFoldersStore, unsortedSessionIds } from '../stores/useSessionFoldersStore.ts';
import type { SyncEngine } from '../sync/sync-engine.ts';
import type { Session, SessionStatus } from '../lib/nnd/types.ts';
import { toast } from 'sonner';
import { sidebarHierarchy } from './session-sidebar-hierarchy.ts';
import { childActivityPhrase, sessionAttention } from './session-row-evidence.ts';
import { pinnedSessionIds, useSessionPinnedStore } from '../stores/useSessionPinnedStore.ts';
import { getRuntimeKey } from '../lib/runtime-switch.ts';
import { clearKnownSessionTreePins } from './session-pin-cleanup.ts';
import { expandedParentIds, useSessionExpansionStore } from '../stores/useSessionExpansionStore.ts';
import { filterSessions, orderSessionsByLifecycleWrap, sessionDepths, shortDirectory } from './session-sidebar-utils.ts';
import { ArchivedRow, FolderActions } from './session-sidebar-actions.tsx';
import { SidebarIcon } from './sidebar-icon.tsx';
import { SidebarRow } from './session-sidebar-row.tsx';
import { useWorkspaceAddition } from './use-workspace-addition.tsx';

import { useSidebarInteractions, moveWorkspaceOrder, workspaceOrderList } from './sidebar-interactions.tsx';
import { useWorkspaceDrag, reorderWorkspace } from './workspace-drag.tsx';
const AVATAR_LIMIT = 50;

function subscribeRuntimeKey(notify: () => void): () => void {
  window.addEventListener('notnative:runtime-endpoint-changed', notify);
  return () => window.removeEventListener('notnative:runtime-endpoint-changed', notify);
}

export interface ChatSidebarProps {
  engine: SyncEngine;
  nativeAlpha?: boolean;
  currentDirectory: string;
  currentSessionId: string | null;
  onOpenArchive?: () => void;
  onRunFusion?: (session: Session) => void;
  actions: {
    openDraft: (directory: string, draftId?: string) => void;
    openSession: (sessionID: string, directory: string) => void;
    rename: (sessionID: string, title: string) => Promise<void>;
    archive: (sessionID: string, directory: string) => Promise<void>;
    restore: (sessionID: string, directory: string) => Promise<void>;
    deleteSession: (sessionID: string, directory: string) => Promise<void>;
    fork?: (sessionID: string, directory: string) => Promise<void>;
  };
}

export function ChatSidebar(props: ChatSidebarProps): ReactNode {
  const [query, setQuery] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [collapsedZones, setCollapsedZones] = useSidebarPreference<Record<string, true>>('collapsed', {}, collapsedMap);
  const [filterOpen, setFilterOpen] = useState(false);
  const [sortBy, setSortBy] = useSidebarPreference<'activity' | 'name' | 'manual'>('sort', 'activity', oneOf('activity', 'name', 'manual'));
  const [manualOrder, setManualOrder] = useSidebarPreference<string[]>('workspace-order', [], workspaceOrderList);
  const sidebar = useSidebarInteractions(useCallback(() => setFilterOpen(false), []));
  const [groupBy, setGroupBy] = useSidebarPreference<'workspace' | 'list'>('group', 'workspace', oneOf('workspace', 'list'));
  const [archiveMode, setArchiveMode] = useSidebarPreference<'active' | 'all' | 'archived'>('archive', 'active', oneOf('active', 'all', 'archived'));
  const [listLimit, setListLimit] = useState(AVATAR_LIMIT);
  const [showSearch, setShowSearch] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const draftRevision = useSyncExternalStore(subscribeDraftChanges, getDraftRevision);
  const conversationDrafts = useConversationDraftStore(state => state.drafts);
  const workspaceDisplays = useWorkspaceDisplayStore(state => state.rows);
  const displayError = useWorkspaceDisplayStore(state => state.error);
  const [showHidden, setShowHidden] = useState(false);
  const workspaceInventory = useWorkspaceStore(state => state.inventory);
  const workspaceError = useWorkspaceStore(state => state.phase === 'error');
  const [workspaceRefreshKey, setWorkspaceRefreshKey] = useState(0);
  const workspaceAddition = useWorkspaceAddition(({ directory, inventory }) => {
    useWorkspaceStore.getState().adopt(inventory);
    setWorkspaceRefreshKey(key => key + 1);
    setGroupBy('workspace');
    setArchiveMode('active');
    setQuery('');
    setShowSearch(false);
    const normalized = normalizeDirectory(directory);
    setCollapsedZones(current => { const next = { ...current }; delete next[normalized]; return next; });
    props.actions.openDraft(normalized);
  });
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
    if (props.nativeAlpha) { void useWorkspaceStore.getState().load(); void useWorkspaceDisplayStore.getState().load(); }
  }, [runtimeKey, props.nativeAlpha]);
  useEffect(() => {
    if (!useGlobalSessionsStore.getState().hasLoaded) void useGlobalSessionsStore.getState().loadSessions();
  }, [runtimeKey]);
  useEffect(() => {
    const refresh = (): void => { useSessionPinnedStore.getState().reload(); useSessionExpansionStore.getState().reload(); };
    window.addEventListener('storage', refresh);
    return () => window.removeEventListener('storage', refresh);
  }, []);

  const pendingSessionIds = useMemo(() => new Set(conversationDrafts.map(draft => readDraft(draft.directory, draft.id).start?.sessionID).filter(Boolean)), [conversationDrafts, draftRevision]);
  const visibleSessions = useMemo(() => archiveMode === 'archived' ? sessionsGlobal.archived
    : archiveMode === 'all' ? [...sessionsGlobal.active, ...sessionsGlobal.archived] : sessionsGlobal.active.filter(session => !pendingSessionIds.has(session.id)),
  [archiveMode, sessionsGlobal.active, sessionsGlobal.archived, pendingSessionIds]);
  const zones = useMemo(() => {
    const grouped = new Map<string, Session[]>();
    for (const session of visibleSessions) {
      const directory = normalizeDirectory(session.directory ?? 'global');
      const list = grouped.get(directory) ?? [];
      list.push(session);
      grouped.set(directory, list);
    }
    if (archiveMode !== 'archived') {
      const current = normalizeDirectory(props.currentDirectory);
      if (current && !grouped.has(current)) grouped.set(current, []);
      for (const root of [...conversationDrafts.map(draft => draft.directory), workspaceInventory?.attached.root, ...(workspaceInventory?.admitted.map(row => row.root) ?? [])]) {
        if (root) { const directory = normalizeDirectory(root); if (!grouped.has(directory)) grouped.set(directory, []); }
      }
    }
    return grouped;
  }, [visibleSessions, props.currentDirectory, workspaceInventory, archiveMode, conversationDrafts]);

  const filtered = useMemo(() => filterSessions(visibleSessions, query), [visibleSessions, query]);
  const filteredDirectories = new Set(filtered.map((session) => normalizeDirectory(session.directory ?? 'global')));
  const workspaceOptions = workspaceInventory
    ? [workspaceInventory.attached, ...workspaceInventory.admitted].map((row) => ({ directory: normalizeDirectory(row.root), label: shortDirectory(row.root) }))
    : projects.filter((project) => typeof project.worktree === 'string')
      .map((project) => ({ directory: normalizeDirectory(String(project.worktree)),
        label: typeof project.name === 'string' ? project.name : String(project.worktree) }));
  const currentWorkspace = normalizeDirectory(props.currentDirectory);
  if (currentWorkspace && !workspaceOptions.some((item) => item.directory === currentWorkspace)) {
    workspaceOptions.unshift({ directory: currentWorkspace, label: currentWorkspace });
  }
  if (!query.trim() && archiveMode !== 'archived' && props.currentDirectory) filteredDirectories.add(normalizeDirectory(props.currentDirectory));
  if (!query.trim() && archiveMode !== 'archived') for (const draft of conversationDrafts) filteredDirectories.add(draft.directory);
  if (!query.trim() && archiveMode !== 'archived') for (const directory of workspaceOptions) filteredDirectories.add(directory.directory);
  const archivedInDirectory = sessionsGlobal.archived.filter((session) => normalizeDirectory(session.directory ?? 'global') === normalizeDirectory(props.currentDirectory));
  const nameCounts = new Map<string, number>();
  for (const directory of zones.keys()) {
    const name = shortDirectory(directory).toLocaleLowerCase();
    nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  }

  const compareZones = ([left, a]: [string, Session[]], [right, b]: [string, Session[]]) => sortBy === 'manual' ? (manualOrder.indexOf(left) < 0 ? 256 : manualOrder.indexOf(left)) - (manualOrder.indexOf(right) < 0 ? 256 : manualOrder.indexOf(right)) || left.localeCompare(right)
    : sortBy === 'name' ? (workspaceDisplay(left, workspaceDisplays).label || shortDirectory(left)).localeCompare(workspaceDisplay(right, workspaceDisplays).label || shortDirectory(right)) || left.localeCompare(right)
      : Math.max(0, ...b.map(row => row.time.updated)) - Math.max(0, ...a.map(row => row.time.updated)) || left.localeCompare(right);
  const orderedRoots = [...zones.entries()].sort(compareZones).map(([path]) => path);
  const nudgeWorkspace = (directory: string, distance: -1 | 1) => { setManualOrder(moveWorkspaceOrder(orderedRoots, directory, distance)); setSortBy('manual'); };
  const workspaceDrag = useWorkspaceDrag((source, target) => { setManualOrder(reorderWorkspace(orderedRoots, source, target)); setSortBy('manual'); }, nudgeWorkspace);
  return (
    <aside ref={sidebar.root} style={{ width: sidebar.width }} className="relative flex min-h-0 shrink-0 flex-col border-r border-border/50 bg-card" data-testid="session-sidebar">
      {sidebar.grip}
      <nav className="relative shrink-0 border-b border-border/50 px-3 pb-3 pt-4">
        <div className="mb-3 flex items-center justify-between gap-2">
          <span className="text-[13px] font-medium text-foreground">Workspaces</span>
          <div className="flex items-center gap-0.5">
            <button type="button" aria-label="Search conversations" title="Search conversations" className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground" onClick={() => { setShowSearch(true); requestAnimationFrame(() => searchRef.current?.focus()); }}><SidebarIcon name="search" /></button>
            <button type="button" aria-label="Filter conversations" title="Filter conversations" aria-expanded={filterOpen} className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground" onClick={() => setFilterOpen(value => !value)}><SidebarIcon name="filter" /></button>
            {props.nativeAlpha ? <button type="button" aria-label="Add workspace" title="Add workspace" disabled={workspaceAddition.busy} className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50" onClick={() => void workspaceAddition.choose()}><SidebarIcon name="folder-plus" /></button> : null}
          </div>
        </div>
        {filterOpen ? <div className="absolute right-3 top-12 z-40 w-56 rounded-xl border border-border/50 bg-muted p-2 text-xs text-foreground shadow-2xl" data-testid="sidebar-filter-menu">
          <button type="button" className="w-full px-2 py-1.5 text-left" onClick={() => setShowHidden(value => !value)}>{showHidden ? 'Hide removed workspaces' : 'Show removed workspaces'}</button>
          <div className="px-2 pb-1 text-[11px] text-muted-foreground">Group conversations</div>
          <button type="button" className="flex w-full items-center justify-between rounded px-2 py-1.5 text-left hover:bg-muted" onClick={() => setGroupBy('workspace')}>By workspace {groupBy === 'workspace' ? '✓' : ''}</button>
          <button type="button" className="flex w-full items-center justify-between rounded px-2 py-1.5 text-left hover:bg-muted" onClick={() => setGroupBy('list')}>One list {groupBy === 'list' ? '✓' : ''}</button>
          <div className="mt-2 border-t border-border/50 px-2 pb-1 pt-2 text-[11px] text-muted-foreground">Show conversations</div>
          <button type="button" className="flex w-full items-center justify-between rounded px-2 py-1.5 text-left hover:bg-muted" onClick={() => setArchiveMode('active')}>Active {archiveMode === 'active' ? '✓' : ''}</button>
          <button type="button" className="flex w-full items-center justify-between rounded px-2 py-1.5 text-left hover:bg-muted" onClick={() => setArchiveMode('all')}>All {archiveMode === 'all' ? '✓' : ''}</button>
          <button type="button" className="flex w-full items-center justify-between rounded px-2 py-1.5 text-left hover:bg-muted" onClick={() => setArchiveMode('archived')}>Archived only {archiveMode === 'archived' ? '✓' : ''}</button>
          <div className="mt-2 border-t border-border/50 pt-2" />
          <div className="px-2 pb-1 text-[11px] text-muted-foreground">Order workspaces</div>
          <button type="button" className="w-full rounded px-2 py-1.5 text-left hover:bg-muted" onClick={() => { setSortBy('manual'); setFilterOpen(false); }}>Manual {sortBy === 'manual' ? '✓' : ''}</button>
          {props.nativeAlpha ? <button type="button" data-testid="sidebar-select-toggle" aria-pressed={selecting} className="w-full px-2 py-1.5 text-left hover:bg-muted" onClick={() => { setSelecting(!selecting); clearSelected(); setFilterOpen(false); }}>{selecting ? 'Exit selection' : 'Select sessions'}</button> : null}
          <button type="button" className="flex w-full items-center justify-between rounded px-2 py-1.5 text-left hover:bg-muted" onClick={() => { setSortBy('activity'); setFilterOpen(false); }}>Recent activity {sortBy === 'activity' ? '✓' : ''}</button>
          <button type="button" className="flex w-full items-center justify-between rounded px-2 py-1.5 text-left hover:bg-muted" onClick={() => { setSortBy('name'); setFilterOpen(false); }}>Name {sortBy === 'name' ? '✓' : ''}</button>
        </div> : null}
        {workspaceAddition.controls}
        {props.nativeAlpha ? <DraftPersistenceStatus /> : null}
        {displayError ? <p role="status" className="text-xs text-amber-300">Workspace names unavailable. <button onClick={() => void useWorkspaceDisplayStore.getState().load()}>Retry names</button></p> : null}
        {workspaceError ? <div role="alert" className="mb-2 text-[11px] text-amber-300">Workspace list unavailable. <button type="button" className="underline" onClick={() => {
          void useWorkspaceStore.getState().load(true);
        }}>Retry</button></div> : null}
        {props.nativeAlpha ? <WorkspaceRecoveryControls runtimeKey={runtimeKey} refreshKey={workspaceRefreshKey} /> : null}
        <button type="button" data-testid="sidebar-new-session" className="flex w-full items-center justify-center gap-2 rounded-lg border border-border/60 bg-muted px-3 py-2 text-[13px] font-medium text-foreground hover:bg-muted/80" onClick={event => { if (event.detail < 2) props.actions.openDraft(props.currentDirectory); }}>
          <SidebarIcon name="plus" /> New conversation
        </button>
        {!props.nativeAlpha || selecting ? <button type="button" data-testid="sidebar-select-toggle" aria-pressed={selecting} className="mt-2 w-full rounded-lg px-2 py-1.5 text-left text-[12px] text-muted-foreground hover:bg-muted/50 hover:text-foreground" onClick={() => { setSelecting(!selecting); clearSelected(); }}>
          {selecting ? 'Exit selection' : 'Select sessions'}
        </button> : null}
      </nav>
      {selecting ? <div className="border-y border-border/50 px-3 py-2 text-[11px] text-muted-foreground" data-testid="sidebar-bulk-actions">
        <div>{selected.length} selected <span className="text-muted-foreground">· parent sessions; children follow their parent</span></div>
        <div className="mt-1 flex gap-2">
          <button type="button" disabled={bulkBusy || selected.length === 0} onClick={() => void bulkLifecycle('archive')}>Archive</button>
          {!props.nativeAlpha ? <button type="button" disabled={bulkBusy || selected.length === 0} onClick={() => void bulkMove()}>Move to folder</button> : null}
          <button type="button" disabled={bulkBusy || selected.length === 0} className="text-red-400" onClick={() => void bulkLifecycle('delete')}>Delete</button>
        </div>
      </div> : null}
      <div className={`px-3 pt-2 ${showSearch ? '' : 'hidden'}`}>
        <input
          ref={searchRef}
          value={query}
          onChange={(event: ChangeEvent<HTMLInputElement>) => setQuery(event.target.value)}
          placeholder="Search sessions…"
          aria-label="Search sessions"
          data-testid="sidebar-search"
          className="w-full rounded-lg border border-border/50 bg-card px-3 py-2 text-[12px] text-foreground outline-none focus:border-white/25"
        />
        {query.length > 0 ? <div className="mt-1 text-[10px] text-muted-foreground">{filtered.length} match{filtered.length === 1 ? '' : 'es'}</div> : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-2" data-testid="workspace-scroll">
        {sessionsGlobal.status === 'error' ? <div role="alert" className="mb-2 rounded-lg border border-amber-800/50 px-2 py-2 text-[11px] text-amber-300" data-testid="sidebar-sessions-error">
          Could not refresh sessions. <button type="button" className="underline" onClick={() => void useGlobalSessionsStore.getState().loadSessions()}>Try again</button>
        </div> : null}
        {groupBy === 'list' ? <ul data-testid="sidebar-flat-list">
          {archiveMode !== 'archived' && !query.trim() ? <ConversationDraftRows onOpen={props.actions.openDraft} /> : null}
          {[...filtered].sort((left, right) => right.time.updated - left.time.updated || left.id.localeCompare(right.id)).slice(0, listLimit).map(session =>
            <SidebarRow key={session.id} session={session} status={statusById[session.id]} currentSessionId={props.currentSessionId}
              actions={props.actions} pinned={pinnedSessionIds(pins, normalizeDirectory(session.directory ?? 'global')).has(session.id)}
              selecting={selecting} selected={selectedIds.has(session.id)} onToggleSelected={() => toggleSelected([session.id])}
              hasChildren={false} expanded={false} onToggleExpanded={() => undefined}
              onRunFusion={props.onRunFusion} allowFolders={false} />)}
          {filtered.length > listLimit ? <li><button type="button" className="w-full rounded px-3 py-2 text-left text-xs text-sky-300 hover:bg-muted/50" onClick={() => setListLimit(limit => limit + AVATAR_LIMIT)}>Show {Math.min(AVATAR_LIMIT, filtered.length - listLimit)} more conversations</button></li> : null}
        </ul> : [...zones.entries()]
          .filter(([directory]) => filteredDirectories.has(directory) && (query.trim() || showHidden || !workspaceDisplay(directory, workspaceDisplays).hidden))
          .sort(compareZones)
          .map(([directory, sessions]) => (
            <Zone
              key={directory}
              showDrafts={archiveMode !== 'archived' && !query.trim()}
              display={workspaceDisplay(directory, workspaceDisplays)}
              onMove={distance => nudgeWorkspace(directory, distance)}
              dragHandle={workspaceDrag.handle(directory, workspaceDisplay(directory, workspaceDisplays).label || shortDirectory(directory))}
              dropTarget={workspaceDrag.target === directory}
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
              allowFolders={!props.nativeAlpha}
              expandedIds={expandedIds}
              onToggleExpanded={(id) => useSessionExpansionStore.getState().toggle(id, runtimeKey)}
            />
          ))}
      </div>
      {archiveMode === 'active' ? props.nativeAlpha ? <button type="button" className="border-t border-border/50 px-4 py-3 text-left text-xs text-muted-foreground hover:bg-muted/50" onClick={() => setArchiveMode('archived')}>Archived conversations ({sessionsGlobal.archived.length})</button> : <div className="border-t border-border/50 px-2 py-2" data-testid="sidebar-archive">
        {props.onOpenArchive ? <button type="button" data-testid="sidebar-archive-view" className="w-full rounded px-2 py-1 text-left text-[11px] text-muted-foreground hover:bg-muted/50 hover:text-foreground" onClick={props.onOpenArchive}>
          View all archived sessions ({sessionsGlobal.archived.length})
        </button> : null}
        <button
          type="button"
          data-testid="sidebar-archive-toggle"
          aria-expanded={showArchived}
          onClick={() => setShowArchived(!showArchived)}
          className="flex w-full items-center gap-1 px-2 py-1 text-left text-[11px] uppercase tracking-wide text-muted-foreground hover:text-muted-foreground"
        >
          <span aria-hidden>{showArchived ? '▾' : '▸'}</span>
          Archive ({archivedInDirectory.length})
        </button>
        {showArchived ? (
          <ul>
            {archivedInDirectory.length === 0 ? <li className="px-2 py-1 text-[11px] text-muted-foreground">Nothing archived in this workspace.</li> : null}
            {archivedInDirectory.slice(0, AVATAR_LIMIT).map((session) => (
              <ArchivedRow key={session.id} session={session} actions={props.actions} />
            ))}
          </ul>
        ) : null}
      </div> : null}
    </aside>
  );
}

function Zone({ dragHandle, dropTarget, onMove, showDrafts, display, directory, sessions, statusById, ranks, pinnedIds, actions, currentSessionId, folders, collapsed, active, forceOpen, zoneCollapsed, onToggleZone, duplicateName, selecting, selectedIds, onToggleSelected, sessionListStatus, onRunFusion, allowFolders, expandedIds, onToggleExpanded }: { dragHandle: ReactNode; dropTarget: boolean; onMove: (distance: -1 | 1) => void; showDrafts?: boolean; display?: { id: string | null; label: string; hidden: boolean }; directory: string; sessions: Session[]; statusById: Record<string, SessionStatus>; ranks: Record<string, number>; pinnedIds: ReadonlySet<string>; actions: ChatSidebarProps['actions']; currentSessionId: string | null; folders: import('../lib/session-folders.ts').SessionFolder[]; collapsed: Record<string, true>; active: boolean; forceOpen: boolean; zoneCollapsed: boolean; onToggleZone: () => void; duplicateName: boolean; selecting: boolean; selectedIds: ReadonlySet<string>; onToggleSelected: (ids: string[]) => void; sessionListStatus: 'idle' | 'loading' | 'ready' | 'error'; onRunFusion?: (session: Session) => void; allowFolders: boolean; expandedIds: ReadonlySet<string>; onToggleExpanded: (id: string) => void }): ReactNode {
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
    <section className={`mb-2 ${dropTarget ? 'rounded-lg ring-1 ring-sky-400' : ''}`} data-workspace-root={directory} data-testid="workspace-zone" data-active={active ? 'true' : undefined}>
      <header className={`group mb-1 flex items-center justify-between rounded-lg px-1 py-0.5 hover:bg-muted/50 ${active ? 'bg-muted/50' : ''}`}>
        {dragHandle}
        <button type="button" aria-expanded={zoneOpen} aria-label={`${zoneOpen ? 'Collapse' : 'Expand'} ${directory || 'general'} workspace`} data-testid="workspace-zone-toggle" disabled={forceOpen}
          className="flex h-8 w-6 shrink-0 items-center justify-center rounded text-[12px] text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={onToggleZone} title={forceOpen ? 'Search results keep this workspace open' : directory}>{zoneOpen ? '▾' : '▸'}</button>
        <button type="button" data-workspace-directory={directory} aria-label={`Workspace ${display?.label || shortDirectory(directory)}`} aria-expanded={zoneOpen} aria-current={active ? 'page' : undefined}
          className={`flex min-w-0 flex-1 items-center gap-2 rounded px-1 py-1.5 text-left text-[13px] hover:text-foreground ${active ? 'font-medium text-foreground' : 'text-muted-foreground'}`}
          onClick={onToggleZone} title={`Expand or collapse ${directory}`}>
          <span className={active ? 'text-sky-400' : 'text-muted-foreground'}><SidebarIcon name="folder" /></span>
          <span className="truncate font-medium">{display?.label || shortDirectory(directory)}</span>
          {duplicateName ? <span className="truncate text-[10px] text-muted-foreground">{directory}</span> : null}
        </button>
        <div className="flex items-center gap-0.5">
          {allowFolders ? <button type="button" aria-label={`New folder in ${directory || 'general'}`} data-testid={`folder-create-${directory.replace(/[^\w]/g, '_')}`} className="text-[11px] text-muted-foreground hover:text-muted-foreground" onClick={() => {
            const name = prompt('New folder name', 'Folder'); // eslint-disable-line no-alert
            if (name !== null && name.trim()) createFolder(name);
          }}>▤+</button> : null}
          <button type="button" aria-label={`New draft session in ${directory || 'general'}`} title="New conversation" className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground" onClick={event => { if (event.detail < 2) actions.openDraft(directory); }}><SidebarIcon name="plus" /></button>
          <details className="relative">
            <summary aria-label={`More actions for ${directory || 'general'} workspace`} title="Workspace actions" className="flex h-8 w-8 cursor-pointer list-none items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"><SidebarIcon name="more" /></summary>
            <div className="absolute right-0 top-9 z-30 w-44 rounded-xl border border-border/60 bg-muted p-1.5 shadow-xl" onClick={event => { if ((event.target as Element).closest('button')) event.currentTarget.closest('details')?.removeAttribute('open'); }}>
              <button type="button" className="w-full rounded px-3 py-2 text-left text-xs hover:bg-muted" onClick={() => onMove(-1)}>Move workspace up</button><button type="button" className="w-full rounded px-3 py-2 text-left text-xs hover:bg-muted" onClick={() => onMove(1)}>Move workspace down</button>
              <button type="button" className="w-full rounded-lg px-3 py-2 text-left text-xs text-foreground hover:bg-muted" onClick={() => actions.openDraft(directory)}>New conversation</button>
              {display?.id ? <WorkspaceMenu permanent={isDefaultWorkspace(directory)} id={display.id} label={display.label || shortDirectory(directory)} hidden={display.hidden} /> : null}
              <button type="button" className="w-full rounded-lg px-3 py-2 text-left text-xs text-muted-foreground hover:bg-muted" onClick={() => {
                if (!navigator.clipboard) { toast.error('Clipboard is unavailable'); return; }
                void navigator.clipboard.writeText(directory).then(() => toast.success('Workspace path copied')).catch(() => toast.error('Could not copy workspace path'));
              }}>Copy path</button>
            </div>
          </details>
        </div>
      </header>
      {zoneOpen ? <ul className="ml-9 border-l border-border/30 pl-2" aria-label={`Conversations in ${display?.label || shortDirectory(directory)}`}>
        {showDrafts ? <ConversationDraftRows directory={directory} onOpen={actions.openDraft} /> : null}
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
              <div className="group flex items-center gap-1 rounded-lg px-2 py-1 hover:bg-muted/50">
                {selecting && folderSelectable.length > 0 ? <input type="checkbox" aria-label={`Select sessions in ${folder.name}`} checked={folderSelectable.every((id) => selectedIds.has(id))} onChange={() => onToggleSelected(folderSelectable)} /> : null}
                <button type="button" aria-expanded={!isCollapsed} onClick={() => useSessionFoldersStore.getState().toggleCollapsed(folder.id)} className="flex min-w-0 flex-1 items-center gap-1 text-left text-[11px] text-muted-foreground" data-testid="folder-header">
                  <span aria-hidden>{isCollapsed ? '▸' : '▾'}</span>
                  <span className="truncate">▤ {folder.name}</span>
                  <span className="text-neutral-700">{folder.sessionIds.length}</span>
                </button>
                <FolderActions directory={directory} folderId={folder.id} folderName={folder.name} hasSessions={folder.sessionIds.length > 0} />
              </div>
              {!isCollapsed ? (
                <ul className="ml-3 border-l border-border/30">
                  {folderNormal.map((session) => (
                    <SidebarRow key={session.id} session={session} status={statusById[session.id]} currentSessionId={currentSessionId} actions={actions} pinned={pinnedIds.has(session.id)} folderId={folder.sessionIds.includes(session.id) ? folder.id : undefined} depth={depthById.get(session.id) ?? 0} selecting={selecting} selected={selectedIds.has(session.id)} onToggleSelected={() => onToggleSelected([session.id])} hasChildren={!forceOpen && childParents.has(session.id)} expanded={expandedIds.has(session.id)} onToggleExpanded={() => onToggleExpanded(session.id)} hiddenAttention={hiddenAttention.get(session.id)} onRunFusion={onRunFusion} allowFolders={allowFolders} />
                  ))}
                  {folderUnavailable.length > 0 ? <li className="px-2 pt-2 text-[10px] uppercase tracking-wide text-neutral-700">Parent unavailable</li> : null}
                  {folderUnavailable.map((session) => (
                    <SidebarRow key={session.id} session={session} status={statusById[session.id]} currentSessionId={currentSessionId} actions={actions} pinned={pinnedIds.has(session.id)} folderId={folder.sessionIds.includes(session.id) ? folder.id : undefined} depth={depthById.get(session.id) ?? 0} selecting={selecting} selected={selectedIds.has(session.id)} onToggleSelected={() => onToggleSelected([session.id])} hasChildren={!forceOpen && childParents.has(session.id)} expanded={expandedIds.has(session.id)} onToggleExpanded={() => onToggleExpanded(session.id)} hiddenAttention={hiddenAttention.get(session.id)} onRunFusion={onRunFusion} allowFolders={allowFolders} />
                  ))}
                  {inside.length === 0 ? <li className="px-2 py-1 text-[10px] text-muted-foreground">Empty folder — sessions land via the row menu.</li> : null}
                </ul>
              ) : null}
            </li>
          );
        })}
        {(folders.length > 0 && (visibleUnsorted.length > 0 || orphaned.length > 0)) || folders.length > 0
          ? <li className="px-2 pt-1 text-[10px] uppercase tracking-wide text-neutral-700">Sessions</li>
          : null}
        {ordered.length === 0 && folders.length === 0 ? <li className="px-2 py-1 text-[11px] text-muted-foreground" data-testid="zone-empty">{sessionListStatus === 'loading' ? 'Loading sessions…' : sessionListStatus === 'error' ? 'Could not refresh sessions.' : 'No sessions in this workspace yet.'}</li> : null}
        {visibleUnsorted.map((sessionID) => (
          <SidebarRow key={sessionID} session={byId.get(sessionID)!} status={statusById[sessionID]} currentSessionId={currentSessionId} actions={actions} pinned={pinnedIds.has(sessionID)} depth={depthById.get(sessionID) ?? 0} selecting={selecting} selected={selectedIds.has(sessionID)} onToggleSelected={() => onToggleSelected([sessionID])} hasChildren={!forceOpen && childParents.has(sessionID)} expanded={expandedIds.has(sessionID)} onToggleExpanded={() => onToggleExpanded(sessionID)} hiddenAttention={hiddenAttention.get(sessionID)} onRunFusion={onRunFusion} allowFolders={allowFolders} />
        ))}
        {orphaned.length > 0 ? <li className="px-2 pt-2 text-[10px] uppercase tracking-wide text-neutral-700">Parent unavailable</li> : null}
        {orphaned.map((sessionID) => (
          <SidebarRow key={sessionID} session={byId.get(sessionID)!} status={statusById[sessionID]} currentSessionId={currentSessionId} actions={actions} pinned={pinnedIds.has(sessionID)} depth={depthById.get(sessionID) ?? 0} selecting={selecting} selected={selectedIds.has(sessionID)} onToggleSelected={() => onToggleSelected([sessionID])} hasChildren={!forceOpen && childParents.has(sessionID)} expanded={expandedIds.has(sessionID)} onToggleExpanded={() => onToggleExpanded(sessionID)} hiddenAttention={hiddenAttention.get(sessionID)} onRunFusion={onRunFusion} allowFolders={allowFolders} />
        ))}
      </ul> : null}
      {zoneOpen && folders.length > 0 ? <div className="px-2 pt-1 text-[10px] text-neutral-700">{foldersState.status === 'error' ? 'folder store error' : `${folders.length} folder(s)`}</div> : null}
    </section>
  );
}

export { toast, sessionAttention, childActivityPhrase };
