// SPDX-License-Identifier: Apache-2.0
/** Full archive over the authoritative global session projection (doc 05 §D.13). */
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { toast } from 'sonner';
import { normalizeDirectory } from '../lib/nnd/client.ts';
import type { Session } from '../lib/nnd/types.ts';
import type { SessionFolder } from '../lib/session-folders.ts';
import { useGlobalSessionsStore } from '../sync/global-stores.ts';
import { useSessionFoldersStore } from '../stores/useSessionFoldersStore.ts';
import { getRuntimeKey } from '../lib/runtime-switch.ts';
import { formatRelative } from './time-format.ts';
import { clearKnownSessionTreePins } from './session-pin-cleanup.ts';

function subscribeRuntimeKey(notify: () => void): () => void {
  window.addEventListener('notnative:runtime-endpoint-changed', notify);
  return () => window.removeEventListener('notnative:runtime-endpoint-changed', notify);
}

interface ArchiveViewProps {
  currentDirectory: string;
  onClose: () => void;
  onOpenSession: (id: string, directory: string) => void;
  onRestore: (id: string, directory: string) => Promise<void>;
  onDelete: (id: string, directory: string) => Promise<void>;
}

interface ArchiveBucket { key: string; label: string; sessions: Session[] }
interface ArchiveWorkspace { directory: string; buckets: ArchiveBucket[] }

export function archiveWorkspaces(sessions: Session[], foldersByDirectory: Record<string, SessionFolder[]>, currentDirectory: string): ArchiveWorkspace[] {
  const byDirectory = new Map<string, Session[]>();
  for (const session of sessions) {
    const directory = normalizeDirectory(session.directory ?? 'global');
    byDirectory.set(directory, [...(byDirectory.get(directory) ?? []), session]);
  }
  const current = normalizeDirectory(currentDirectory);
  if (current && !byDirectory.has(current)) byDirectory.set(current, []);
  return [...byDirectory.entries()].sort(([left], [right]) => left === current ? -1 : right === current ? 1 : left.localeCompare(right)).map(([directory, items]) => {
    const folders = foldersByDirectory[directory] ?? [];
    const byId = new Map(items.map((session) => [session.id, session]));
    // A parent is the lifecycle authority. Keep its archived descendants in
    // the same bucket even when only the parent was explicitly filed.
    const bucketOwner = (session: Session): string => {
      let owner = session;
      const seen = new Set([owner.id]);
      while (owner.parentID && byId.has(owner.parentID) && !seen.has(owner.parentID)) {
        owner = byId.get(owner.parentID)!;
        seen.add(owner.id);
      }
      return owner.id;
    };
    const assigned = new Set<string>();
    const buckets = folders.map((folder) => {
      const ids = new Set(folder.sessionIds);
      const matched = items.filter((session) => ids.has(bucketOwner(session)) && !assigned.has(session.id));
      matched.forEach((session) => assigned.add(session.id));
      return { key: folder.id, label: folder.name, sessions: matched };
    });
    buckets.push({ key: 'unfiled', label: 'Other sessions', sessions: items.filter((session) => !assigned.has(session.id)) });
    return { directory, buckets };
  });
}

export function archiveMatches(session: Session, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  if (needle.startsWith('ses_')) return session.id.toLocaleLowerCase() === needle;
  return (session.title ?? '').toLocaleLowerCase().includes(needle) || session.id.toLocaleLowerCase().includes(needle);
}

export function ArchiveView(props: ArchiveViewProps): ReactNode {
  const sessions = useSyncExternalStore(useGlobalSessionsStore.subscribe, useGlobalSessionsStore.getState);
  const folders = useSyncExternalStore(useSessionFoldersStore.subscribe, useSessionFoldersStore.getState);
  const runtimeKey = useSyncExternalStore(subscribeRuntimeKey, getRuntimeKey);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => { void useGlobalSessionsStore.getState().loadSessions(); }, [runtimeKey]);
  useEffect(() => { if (!folders.hasLoaded) void useSessionFoldersStore.getState().load(); }, [folders.hasLoaded]);
  const workspaces = archiveWorkspaces(sessions.archived, folders.foldersByDirectory, props.currentDirectory);
  const act = async (items: Session[], kind: 'restore' | 'delete'): Promise<void> => {
    const roots = items.filter((session) => !session.parentID && !busy.has(session.id));
    if (roots.length === 0) return;
    if (kind === 'delete' && !confirm(`Permanently delete ${roots.length} archived session${roots.length === 1 ? '' : 's'} and their subtasks? This cannot be undone.`)) return; // eslint-disable-line no-alert
    const runtimeKey = getRuntimeKey();
    setBusy((current) => new Set([...current, ...roots.map((session) => session.id)]));
    let succeeded = 0;
    for (const session of roots) {
      try {
        if (kind === 'restore') await props.onRestore(session.id, session.directory ?? '');
        else {
          await props.onDelete(session.id, session.directory ?? '');
          clearKnownSessionTreePins(session, [...sessions.active, ...sessions.archived], runtimeKey);
        }
        succeeded += 1;
      } catch { /* Keep the failed row visible; surface a count below. */ }
    }
    setBusy((current) => new Set([...current].filter((id) => !roots.some((session) => session.id === id))));
    if (succeeded > 0) toast.success(`${kind === 'restore' ? 'Restored' : 'Deleted'} ${succeeded} session${succeeded === 1 ? '' : 's'}`);
    if (succeeded !== roots.length) toast.error(`${roots.length - succeeded} session${roots.length - succeeded === 1 ? '' : 's'} could not be ${kind === 'restore' ? 'restored' : 'deleted'}`);
  };

  return <main className="min-w-0 flex-1 overflow-y-auto bg-neutral-950 px-5 py-4 text-neutral-200" data-testid="archive-view">
    <div className="mx-auto max-w-5xl">
      <header className="mb-4 flex items-center gap-3">
        <button type="button" className="rounded px-2 py-1 text-sm text-neutral-400 hover:bg-white/10 hover:text-white" onClick={props.onClose}>← Back to chat</button>
        <h1 className="text-lg font-medium">Archive</h1>
        <span className="text-xs text-neutral-500">{sessions.archived.length} sessions</span>
      </header>
      <input aria-label="Search archived sessions" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search archived sessions…" className="mb-5 w-full rounded-lg border border-white/10 bg-neutral-900 px-3 py-2 text-sm outline-none focus:border-white/30" />
      {sessions.status === 'error' ? <p role="alert" className="mb-3 text-xs text-amber-300">Session list could not refresh; showing the last available archive. <button type="button" className="underline" onClick={() => void useGlobalSessionsStore.getState().loadSessions()}>Try again</button></p> : null}
      {sessions.status === 'loading' && sessions.archived.length === 0 ? <p className="mb-3 text-xs text-neutral-500">Loading archived sessions…</p> : null}
      {workspaces.map((workspace) => <section key={workspace.directory} className="mb-7" data-testid="archive-workspace">
        <h2 className="mb-2 break-all border-b border-white/10 pb-2 text-sm font-medium" title={workspace.directory}>{workspace.directory || 'General'}</h2>
        {workspace.buckets.map((bucket) => {
          const visible = bucket.sessions.filter((session) => archiveMatches(session, query));
          if (query.trim() && visible.length === 0) return null;
          const roots = bucket.sessions.filter((session) => !session.parentID);
          return <div key={bucket.key} className="mb-4" data-testid="archive-bucket">
            <div className="mb-1 flex items-center gap-3">
              <h3 className="text-xs uppercase tracking-wide text-neutral-500">{bucket.label} ({visible.length})</h3>
              {!query.trim() && roots.length > 0 ? <button type="button" disabled={roots.every((session) => busy.has(session.id))} className="text-[11px] text-red-400 hover:text-red-300 disabled:opacity-40" onClick={() => void act(roots, 'delete')}>Delete all in {bucket.label} ({roots.length})</button> : null}
            </div>
            {visible.length === 0 ? <p className="rounded-lg bg-white/[0.03] px-3 py-2 text-xs text-neutral-600">No archived sessions yet.</p> : null}
            <ul className="divide-y divide-white/5 rounded-lg bg-white/[0.03]">
              {visible.map((session) => <li key={session.id} className="flex items-center gap-3 px-3 py-2">
                <button type="button" className="min-w-0 flex-1 text-left" onClick={() => props.onOpenSession(session.id, session.directory ?? '')}>
                  <span className="block truncate text-sm">{session.title || 'Untitled Session'}</span>
                  <span className="text-[11px] text-neutral-600">{session.id} · archived {formatRelative(session.time.archived ?? session.time.updated)}</span>
                </button>
                {!session.parentID ? <>
                  <button type="button" disabled={busy.has(session.id)} className="text-xs text-neutral-400 hover:text-white disabled:opacity-40" onClick={() => void act([session], 'restore')}>Restore</button>
                  <button type="button" disabled={busy.has(session.id)} className="text-xs text-red-400 hover:text-red-300 disabled:opacity-40" onClick={() => void act([session], 'delete')}>Delete</button>
                </> : <span className="text-[11px] text-neutral-600">Child transcript</span>}
              </li>)}
            </ul>
          </div>;
        })}
      </section>)}
      {sessions.archived.length === 0 && workspaces.length === 0 ? <p className="text-sm text-neutral-500">No archived sessions yet.</p> : null}
      {query.trim() && !sessions.archived.some((session) => archiveMatches(session, query)) ? <p className="text-sm text-neutral-500">No archived sessions match this search.</p> : null}
    </div>
  </main>;
}
