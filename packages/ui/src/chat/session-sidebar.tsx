// SPDX-License-Identifier: Apache-2.0
/**
 * Session sidebar (doc 05 §D, SLICE-C task 2): new-draft nav, per-directory
 * zones with SERVER-PERSISTED folders (§5.22 store), lifecycle ordering,
 * live status, blocked badges, actions (real PATCH rename, archive, restore,
 * delete), search with exact-ID rule, draft targeting, and the archived
 * split view from the global sessions cache.
 */
import { useEffect, useSyncExternalStore, useMemo, useState, type ReactNode, type ChangeEvent } from 'react';
import { normalizeDirectory } from '../lib/nnd/client.ts';
import { useSessionViewStore } from '../sync/view-store.ts';
import { useGlobalSessionsStore, useGlobalSessionStatusStore } from '../sync/global-stores.ts';
import { useSessionOrderingStore, orderSessionsByLifecycle } from '../sync/session-ordering.ts';
import { useSessionFoldersStore, unsortedSessionIds } from '../stores/useSessionFoldersStore.ts';
import type { SyncEngine } from '../sync/sync-engine.ts';
import type { Session, SessionStatus } from '../lib/nnd/types.ts';
import { toast } from 'sonner';
import { formatRelative } from './time-format.ts';
import { sidebarHierarchy } from './session-sidebar-hierarchy.ts';
import { nnaTurnPhaseFromMetadata } from './work-status.ts';
import { pinnedSessionIds, useSessionPinnedStore } from '../stores/useSessionPinnedStore.ts';
import { getRuntimeKey } from '../lib/runtime-switch.ts';

const AVATAR_LIMIT = 50;

export interface ChatSidebarProps {
  engine: SyncEngine;
  currentDirectory: string;
  currentSessionId: string | null;
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
  const [collapsedZones, setCollapsedZones] = useState<Record<string, true>>({});
  const sessionsGlobal = useSyncExternalStore(useGlobalSessionsStore.subscribe, useGlobalSessionsStore.getState);
  const folders = useSyncExternalStore(useSessionFoldersStore.subscribe, useSessionFoldersStore.getState);
  const statusById = useSyncExternalStore(useGlobalSessionStatusStore.subscribe, () => useGlobalSessionStatusStore.getState().statusById);
  const orderingRanks = useSyncExternalStore(useSessionOrderingStore.subscribe, () => useSessionOrderingStore.getState().rankById) as Record<string, number>;
  const pins = useSyncExternalStore(useSessionPinnedStore.subscribe, () => useSessionPinnedStore.getState().pins);

  useEffect(() => { void useSessionFoldersStore.getState().load(); }, []);
  useEffect(() => {
    const refresh = (): void => useSessionPinnedStore.getState().reload();
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
        <button type="button" className="w-full rounded-lg bg-white/5 px-3 py-2 text-left text-[13px] text-neutral-200 hover:bg-white/10" onClick={() => props.actions.openDraft(props.currentDirectory)}>
          + New session
        </button>
      </nav>
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
            />
          ))}
      </div>
      <div className="border-t border-white/10 px-2 py-2" data-testid="sidebar-archive">
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

function Zone({ directory, sessions, statusById, ranks, pinnedIds, actions, currentSessionId, folders, collapsed, active, forceOpen, zoneCollapsed, onToggleZone, duplicateName }: { directory: string; sessions: Session[]; statusById: Record<string, SessionStatus>; ranks: Record<string, number>; pinnedIds: ReadonlySet<string>; actions: ChatSidebarProps['actions']; currentSessionId: string | null; folders: import('../lib/session-folders.ts').SessionFolder[]; collapsed: Record<string, true>; active: boolean; forceOpen: boolean; zoneCollapsed: boolean; onToggleZone: () => void; duplicateName: boolean }): ReactNode {
  const zoneOpen = forceOpen || !zoneCollapsed;
  // Lifecycle ordering per doc 04 §F.10: baseline desc → created desc → id asc.
  const ordered = orderSessionsByLifecycleWrap(sessions);
  // Search shows only matching rows; an omitted parent is not unavailable.
  const hierarchy = forceOpen ? null : sidebarHierarchy(ordered, folders, AVATAR_LIMIT, pinnedIds);
  const searchRows = forceOpen ? ordered.slice(0, AVATAR_LIMIT) : [];
  const byId = hierarchy?.byId ?? new Map(searchRows.map((session) => [session.id, session]));
  const depthById = hierarchy?.depth ?? sessionDepths(searchRows);
  const visibleUnsorted = hierarchy?.unfiled ?? unsortedSessionIds(directory, searchRows);
  const orphaned = hierarchy?.unavailableParent ?? [];
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
            ? hierarchy.visible.filter((id) => hierarchy.folder.get(id) === folder.id && !orphaned.includes(id)).map((id) => byId.get(id)!)
            : folder.sessionIds.map((id) => byId.get(id)).filter((session): session is Session => Boolean(session));
          const folderNormal = inside.filter((session) => !hierarchy?.unavailableIds.has(session.id));
          const folderUnavailable = inside.filter((session) => hierarchy?.unavailableIds.has(session.id));
          // §5.22 sessionIds are the record of truth: show the count even for
          // ids that belong to another workspace surface in this directory.
          return (
            <li key={folder.id} data-testid={`folder-${folder.id}`}>
              <div className="group flex items-center gap-1 rounded-lg px-2 py-1 hover:bg-white/5">
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
                    <SidebarRow key={session.id} session={session} status={statusById[session.id]} currentSessionId={currentSessionId} actions={actions} pinned={pinnedIds.has(session.id)} folderId={folder.sessionIds.includes(session.id) ? folder.id : undefined} depth={depthById.get(session.id) ?? 0} />
                  ))}
                  {folderUnavailable.length > 0 ? <li className="px-2 pt-2 text-[10px] uppercase tracking-wide text-neutral-700">Parent unavailable</li> : null}
                  {folderUnavailable.map((session) => (
                    <SidebarRow key={session.id} session={session} status={statusById[session.id]} currentSessionId={currentSessionId} actions={actions} pinned={pinnedIds.has(session.id)} folderId={folder.sessionIds.includes(session.id) ? folder.id : undefined} depth={depthById.get(session.id) ?? 0} />
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
        {ordered.length === 0 && folders.length === 0 ? <li className="px-2 py-1 text-[11px] text-neutral-600" data-testid="zone-empty">No sessions in this workspace yet.</li> : null}
        {visibleUnsorted.map((sessionID) => (
          <SidebarRow key={sessionID} session={byId.get(sessionID)!} status={statusById[sessionID]} currentSessionId={currentSessionId} actions={actions} pinned={pinnedIds.has(sessionID)} depth={depthById.get(sessionID) ?? 0} />
        ))}
        {orphaned.length > 0 ? <li className="px-2 pt-2 text-[10px] uppercase tracking-wide text-neutral-700">Parent unavailable</li> : null}
        {orphaned.map((sessionID) => (
          <SidebarRow key={sessionID} session={byId.get(sessionID)!} status={statusById[sessionID]} currentSessionId={currentSessionId} actions={actions} pinned={pinnedIds.has(sessionID)} depth={depthById.get(sessionID) ?? 0} />
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

function SidebarRow({ session, status, currentSessionId, actions, pinned, folderId, depth = 0 }: { session: Session; status: SessionStatus | undefined; currentSessionId: string | null; actions: ChatSidebarProps['actions']; pinned: boolean; folderId?: string; depth?: number }): ReactNode {
  const active = status && status.type !== 'idle';
  const attention = sessionAttention(session);
  const activity = session.parentID && !attention ? childActivityPhrase(session.metadata) : null;
  return (
    <li className={`group flex items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-white/5 ${depth > 0 ? 'border-l border-white/10' : ''}`} style={depth > 0 ? { marginLeft: `${depth * 16}px` } : undefined} data-child-session={session.parentID ? 'true' : undefined} data-child-depth={depth > 0 ? depth : undefined} data-attention={attention ?? undefined}>
      <button type="button" className="min-w-0 flex-1 text-left" onClick={() => actions.openSession(session.id, session.directory ?? '')} data-testid="session-row">
        <div className="flex items-center gap-1.5">
          <span aria-hidden className={`inline-block h-1.5 w-1.5 rounded-full ${attention ? 'bg-amber-400' : active ? 'bg-sky-400' : 'bg-neutral-700'}`} />
          {session.parentID ? <span className="text-[10px] text-neutral-600" aria-label="Child session">↳</span> : null}
          <span className={`min-w-0 flex-1 truncate text-[13px] ${currentSessionId === session.id ? 'text-neutral-100' : 'text-neutral-300'}`}>{session.title || 'Untitled Session'}</span>
          {pinned ? <span aria-label="Pinned session" className="text-[10px] text-amber-400">◆</span> : null}
        </div>
        <div className="pl-3 text-[10px] text-neutral-600">{formatRelative(session.time.updated)}{session.parentID && session.agent ? <span> · {session.agent}</span> : null}{attention ? <span className="text-amber-300"> · {attention}</span> : null}{activity ? <span className="text-sky-300" data-testid="child-current-activity"> · {activity}</span> : null}</div>
      </button>
      <div className="flex items-center gap-1 text-[10px] text-neutral-600 opacity-0 transition group-hover:opacity-100">
        <button type="button" aria-label={`${pinned ? 'Unpin' : 'Pin'} ${session.title || 'session'}`} className="hover:text-amber-300" onClick={() => useSessionPinnedStore.getState().toggle(session.directory ?? 'global', session.id)}>{pinned ? '◆' : '◇'}</button>
        <button type="button" aria-label={`Rename ${session.title || 'session'}`} className="hover:text-neutral-200" onClick={() => {
          const title = prompt('Rename session', session.title ?? ''); // eslint-disable-line no-alert
          if (title !== null) void actions.rename(session.id, title);
        }}>✎</button>
        <button type="button" aria-label={`Archive ${session.title || 'session'}`} className="hover:text-neutral-200" onClick={() => void actions.archive(session.id, session.directory ?? '')}>🗄</button>
        {session.parentID !== undefined ? null : <button type="button" aria-label={`File ${session.title || 'session'} into a folder`} data-testid="session-file-into" className="hover:text-neutral-200" onClick={() => {
          const folders = foldersOfSession(session);
          if (folders.length === 0) { toast.message('Create a folder first (+ ▤+ in the workspace header)'); return; }
          const pick = prompt(`File into folder:\n${folders.map((folder, at) => `${at + 1}. ${folder.name}`).join('\n')}`, '1'); // eslint-disable-line no-alert
          const index = Number((pick ?? '').trim()) - 1;
          const target = Number.isInteger(index) && folders[index] ? folders[index] : null;
          if (target) void useSessionFoldersStore.getState().assignSession(session.directory ?? '', target.id, session.id);
        }}>▤</button>}
        {folderId ? <button type="button" aria-label="Unfile from folder" onClick={() => void useSessionFoldersStore.getState().unassignSession(session.directory ?? '', session.id)}>⤫</button> : null}
        <button type="button" aria-label={`Delete ${session.title || 'session'}`} className="hover:text-red-400" onClick={() => {
          if (!confirm(`Delete ${session.title || 'session'} and its subtasks?`)) return; // eslint-disable-line no-alert
          const runtimeKey = getRuntimeKey();
          void actions.deleteSession(session.id, session.directory ?? '').then(() => useSessionPinnedStore.getState().clear(session.directory ?? 'global', session.id, runtimeKey)).catch(() => toast.error('Failed to delete the session'));
        }}>🗑</button>
      </div>
    </li>
  );
}

function ArchivedRow({ session, actions }: { session: Session; actions: ChatSidebarProps['actions'] }): ReactNode {
  return (
    <li className="group flex items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-white/5">
      <button type="button" className="min-w-0 flex-1 text-left" onClick={() => actions.openSession(session.id, session.directory ?? '')} data-testid="archived-row">
        <div className="truncate text-[13px] text-neutral-500">{session.title || 'Untitled Session'}</div>
        <div className="text-[10px] text-neutral-700">archived {formatRelative(session.time.archived ?? session.time.updated)}</div>
      </button>
      <div className="flex items-center gap-1 text-[10px] text-neutral-600 opacity-0 transition group-hover:opacity-100">
        <button type="button" aria-label={`Restore ${session.title || 'session'}`} data-testid="restore-session" className="hover:text-neutral-200" onClick={() => void actions.restore(session.id, session.directory ?? '')}>↩</button>
        <button type="button" aria-label={`Delete ${session.title || 'session'}`} className="hover:text-red-400" onClick={() => {
          if (!confirm(`Delete ${session.title || 'session'} permanently?`)) return; // eslint-disable-line no-alert
          const runtimeKey = getRuntimeKey();
          void actions.deleteSession(session.id, session.directory ?? '').then(() => useSessionPinnedStore.getState().clear(session.directory ?? 'global', session.id, runtimeKey)).catch(() => toast.error('Failed to delete the session'));
        }}>🗑</button>
      </div>
    </li>
  );
}

/** Folders that live in the session's directory (the assignment key). */
function foldersOfSession(session: Session): import('../lib/session-folders.ts').SessionFolder[] {
  const directory = normalizeDirectory(session.directory ?? '');
  return useSessionFoldersStore.getState().foldersByDirectory[directory] ?? [];
}

function orderSessionsByLifecycleWrap(sessions: Session[]): Session[] {
  // §F.10 orders by rank/created only — the ORIGINAL session objects must ride
  // through untouched: the fallback projection dropped `title`/`directory`,
  // so rows rendered as "Untitled Session" and openSession lost its directory.
  return orderSessionsByLifecycle(sessions);
}

/** Depth is presentation-only. Missing/cyclic parents render as roots so an
 * orphan cannot imply that its unavailable parent can be navigated to. */
function sessionDepths(sessions: Session[]): Map<string, number> {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const depths = new Map<string, number>();
  for (const session of sessions) {
    let depth = 0;
    let parentID = session.parentID;
    const seen = new Set<string>([session.id]);
    while (parentID && byId.has(parentID) && !seen.has(parentID)) {
      seen.add(parentID);
      depth += 1;
      parentID = byId.get(parentID)?.parentID;
    }
    depths.set(session.id, parentID && (!byId.has(parentID) || seen.has(parentID)) ? 0 : depth);
  }
  return depths;
}

/** Only NNA-authored session metadata can assert attention here. Transport
 * busy/idle has no permission or question semantics. */
export function sessionAttention(session: Session): string | null {
  const nnd = session.metadata?.nnd;
  if (!nnd || typeof nnd !== 'object' || Array.isArray(nnd)) return null;
  const evidence = nnd as Record<string, unknown>;
  if ((evidence.attention as { kind?: unknown } | undefined)?.kind === 'needs_input') return 'needs input';
  const phase = (evidence.turnState as { phase?: unknown } | undefined)?.phase;
  if (phase === 'awaiting_approval') return 'approval pending';
  if (phase === 'needs_input' || phase === 'attention_required') return 'needs input';
  if (phase === 'failed') return 'failed';
  return null;
}

/** NNA's enumerated phase is display evidence, not a transport-busy guess. */
export function childActivityPhrase(metadata: unknown): string | null {
  const phase = nnaTurnPhaseFromMetadata(metadata);
  const labels: Record<string, string> = {
    preparing: 'preparing', waiting_provider: 'waiting for model', reasoning: 'reasoning',
    streaming: 'replying', running_tool: 'using tool', recovering: 'recovering', cancelling: 'stopping',
  };
  return phase ? labels[phase] ?? null : null;
}

function shortDirectory(directory: string): string {
  const segments = directory.split('/').filter(Boolean);
  if (segments.length === 0) return directory || 'general';
  return segments.at(-1) ?? directory;
}

function filterSessions(sessions: Session[], query: string): Session[] {
  const text = query.trim();
  if (text.length === 0) return sessions;
  if (text.toLowerCase().startsWith('ses_')) {
    const needle = text.toLowerCase();
    return sessions.filter((session) => session.id.toLowerCase() === needle);
  }
  const needle = text.toLowerCase();
  return sessions.filter((session) => (session.title ?? '').toLowerCase().includes(needle) || session.id.toLowerCase().includes(needle));
}

export { toast };
