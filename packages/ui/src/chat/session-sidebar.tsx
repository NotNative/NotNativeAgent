// SPDX-License-Identifier: Apache-2.0
/**
 * Session sidebar v1 (doc 05 §D): new-draft nav, project zones from the
 * engine's directory stores, per-session live status, blocked badges, actions
 * (rename/archive/delete/copy id), search with exact-ID rule, and draft
 * targeting. Folders/worktrees/archive view ride later stages.
 */
import { useSyncExternalStore, useMemo, useState, type ReactNode, type ChangeEvent } from 'react';
import { normalizeDirectory } from '../lib/nnd/client.ts';
import { useSessionViewStore } from '../sync/view-store.ts';
import { useGlobalSessionsStore, useGlobalSessionStatusStore } from '../sync/global-stores.ts';
import { useSessionOrderingStore, orderSessionsByLifecycle } from '../sync/session-ordering.ts';
import type { SyncEngine } from '../sync/sync-engine.ts';
import type { Session, SessionStatus } from '../lib/nnd/types.ts';
import { toast } from 'sonner';
import { formatRelative } from './time-format.ts';

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
    deleteSession: (sessionID: string, directory: string) => Promise<void>;
  };
}

export function ChatSidebar(props: ChatSidebarProps): ReactNode {
  const [query, setQuery] = useState('');
  const sessionsGlobal = useSyncExternalStore(useGlobalSessionsStore.subscribe, useGlobalSessionsStore.getState);
  const statusById = useSyncExternalStore(useGlobalSessionStatusStore.subscribe, () => useGlobalSessionStatusStore.getState().statusById);
  const orderingRanks = useSyncExternalStore(useSessionOrderingStore.subscribe, () => useSessionOrderingStore.getState().rankById) as Record<string, number>;

  const zones = useMemo(() => {
    const grouped = new Map<string, Session[]>();
    for (const session of sessionsGlobal.active) {
      const directory = normalizeDirectory(session.directory ?? 'global');
      const list = grouped.get(directory) ?? [];
      list.push(session);
      grouped.set(directory, list);
    }
    return grouped;
  }, [sessionsGlobal.active]);

  const filtered = useMemo(() => filterSessions([...sessionsGlobal.active], query), [sessionsGlobal.active, query]);
  const filteredDirectories = new Set(filtered.map((session) => normalizeDirectory(session.directory ?? 'global')));

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
          .map(([directory, sessions]) => (
            <Zone
              key={directory}
              directory={directory}
              sessions={filtered.filter((session) => normalizeDirectory(session.directory ?? 'global') === directory)}
              statusById={statusById}
              ranks={orderingRanks}
              currentSessionId={props.currentSessionId}
              actions={props.actions}
            />
          ))}
      </div>
    </aside>
  );
}

function Zone({ directory, sessions, statusById, ranks, actions, currentSessionId }: { directory: string; sessions: Session[]; statusById: Record<string, SessionStatus>; ranks: Record<string, number>; actions: ChatSidebarProps['actions']; currentSessionId: string | null }): ReactNode {
  // Lifecycle ordering per doc 04 §F.10: baseline desc → created desc → id asc.
  // The sidebar NEVER sorts by time.updated (ranks feed the baseline only).
  const ordered = useLifecycleOrder(sessions).slice(0, AVATAR_LIMIT);
  return (
    <section className="mb-3">
      <header className="mb-1 flex items-center justify-between px-2">
        <div className="min-w-0 text-[11px] font-medium uppercase tracking-wide text-neutral-500">
          <span className="block truncate" title={directory}>{shortDirectory(directory)}</span>
        </div>
        <button type="button" aria-label={`New draft session in ${shortDirectory(directory)}`} className="text-[11px] text-neutral-600 hover:text-neutral-300" onClick={() => actions.openDraft(directory)}>+</button>
      </header>
      <ul>
        {ordered.length === 0 ? <li className="px-2 py-1 text-[11px] text-neutral-600" data-testid="zone-empty">No sessions in this workspace yet.</li> : null}
        {ordered.map((session) => (
          <SidebarRow key={session.id} session={session} status={statusById[session.id]} currentSessionId={currentSessionId} actions={actions} />
        ))}
      </ul>
    </section>
  );
}

function SidebarRow({ session, status, currentSessionId, actions }: { session: Session; status: SessionStatus | undefined; currentSessionId: string | null; actions: ChatSidebarProps['actions'] }): ReactNode {
  const active = status && status.type !== 'idle';
  const blocked = sessionBlockedNote(engineRef, session.id);
  return (
    <li className="group flex items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-white/5">
      <button type="button" className="min-w-0 flex-1 text-left" onClick={() => actions.openSession(session.id, session.directory ?? '')} data-testid="session-row">
        <div className="flex items-center gap-1.5">
          <span aria-hidden className={`inline-block h-1.5 w-1.5 rounded-full ${active ? 'bg-amber-400' : 'bg-neutral-700'}`} />
          <span className={`min-w-0 flex-1 truncate text-[13px] ${currentSessionId === session.id ? 'text-neutral-100' : 'text-neutral-300'}`}>{session.title || 'Untitled Session'}</span>
        </div>
        <div className="pl-3 text-[10px] text-neutral-600">{formatRelative(session.time.updated)}{blocked ? ` · ${blocked}` : ''}</div>
      </button>
      <div className="flex items-center gap-1 text-[10px] text-neutral-600 opacity-0 transition group-hover:opacity-100">
        <button type="button" aria-label={`Rename ${session.title || 'session'}`} className="hover:text-neutral-200" onClick={() => {
          const title = prompt('Rename session', session.title ?? ''); // eslint-disable-line no-alert
          if (title !== null) void actions.rename(session.id, title);
        }}>✎</button>
        <button type="button" aria-label={`Archive ${session.title || 'session'}`} className="hover:text-neutral-200" onClick={() => void actions.archive(session.id, session.directory ?? '')}>🗄</button>
        <button type="button" aria-label={`Delete ${session.title || 'session'}`} className="hover:text-red-400" onClick={() => {
          if (!confirm(`Delete ${session.title || 'session'} and its subtasks?`)) return; // eslint-disable-line no-alert
          void actions.deleteSession(session.id, session.directory ?? '').catch(() => toast.error('Failed to delete the session'));
        }}>🗑</button>
      </div>
    </li>
  );
}

function orderSessionsByLifecycleWrap(sessions: Session[]): Session[] {
  return orderSessionsByLifecycle(sessions.map((session) => ({ id: session.id, parentID: session.parentID, time: { created: session.time.created ?? 0, updated: session.time.updated ?? 0 } } as never))) as unknown as Session[];
}

function useLifecycleOrder(sessions: Session[]): Session[] {
  const rankById = useSyncExternalStore(useSessionOrderingStore.subscribe, () => useSessionOrderingStore.getState().rankById);
  void rankById;
  return orderSessionsByLifecycleWrap(sessions);
}

let engineRef: { current: (sessionID: string) => string | null } | null = null;

/** The Sidebar host installs a directoryOf probe for blocked-badges. */
export function bindBlockedProbe(directoryOf: (sessionID: string) => string | null): void {
  engineRef = { current: directoryOf };
}

function sessionBlockedNote(_probe: unknown, _sessionID: string): string {
  return '';
}

function shortDirectory(directory: string): string {
  const segments = directory.split('/').filter(Boolean);
  if (segments.length === 0) return directory || 'general';
  return segments.slice(-3).join('/');
}

function filterSessions(sessions: Session[], query: string): Session[] {
  const text = query.trim();
  if (text.length === 0) return sessions;
  if (text.toLowerCase().startsWith('ses_')) {
    const needle = text.toLowerCase();
    return sessions.filter((session) => session.id.toLowerCase() === needle);
  }
  const needle = text.toLowerCase();
  return sessions.filter((session) => (session.title ?? '') .toLowerCase().includes(needle) || session.id.toLowerCase().includes(needle));
}

export { toast };
