// SPDX-License-Identifier: Apache-2.0
/** Agent Manager view (doc 12 §F.3): compares title-grouped worktree runs,
 * then deletes selected sessions with optionally matching worktree cleanup. */
import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { toast } from 'sonner';
import { removeWorktree as removeProjectWorktree } from '../../lib/server-api.ts';
import { normalizeDirectory } from '../../lib/nnd/client.ts';
import type { Session } from '../../lib/nnd/types.ts';
import type { ComposerServices } from '../../chat/composer.tsx';
import {
  deleteAgentGroupSessions,
  isDirectoryInside,
  useAgentGroupsStore,
  type AgentGroupSession,
} from '../../lib/agent-groups/store.ts';
import { useGlobalSessionStatusStore } from '../../sync/global-stores.ts';
import { useSessionViewStore } from '../../sync/view-store.ts';

const IDLE_GROUPS = { status: 'idle' as const, groups: [], errors: [], loadedAt: 0 };

export interface AgentManagerViewProps {
  projectRoot: string;
  currentDirectory: string;
  onClose: () => void;
  onOpenSession: (session: Session) => void;
  services?: ComposerServices;
}

export function AgentManagerView(props: AgentManagerViewProps): ReactNode {
  const services = props.services;
  const projectKey = normalizeDirectory(props.projectRoot);
  const currentDirectoryKey = normalizeDirectory(props.currentDirectory);
  const snapshot = useSyncExternalStore(
    useAgentGroupsStore.subscribe,
    () => useAgentGroupsStore.getState().projects[projectKey] ?? IDLE_GROUPS,
  );
  const statusById = useSyncExternalStore(useGlobalSessionStatusStore.subscribe, () => useGlobalSessionStatusStore.getState().statusById);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void useAgentGroupsStore.getState().loadGroups(projectKey);
  }, [projectKey]);

  const allSessions = useMemo(() => snapshot.groups.flatMap((group) => group.sessions), [snapshot.groups]);
  const selectedEntries = useMemo(() => allSessions.filter((entry) => selected.has(selectionKey(entry))), [allSessions, selected]);
  const selectedCount = selectedEntries.length;
  const selectionKeys = useMemo(() => new Set(allSessions.map(selectionKey)), [allSessions]);
  const activeCount = allSessions.filter((entry) => (statusById[entry.session.id]?.type ?? 'idle') !== 'idle').length;

  useEffect(() => {
    setSelected((current) => {
      const next = new Set([...current].filter((key) => selectionKeys.has(key)));
      return next.size === current.size ? current : next;
    });
  }, [selectionKeys]);

  function toggle(session: AgentGroupSession): void {
    const key = selectionKey(session);
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function removeSelected(withWorktrees: boolean): Promise<void> {
    if (busy || selectedEntries.length === 0 || services === undefined) return;
    if (!window.confirm(`Delete ${selectedEntries.length} selected session${selectedEntries.length === 1 ? '' : 's'}${withWorktrees ? ' and their worktrees' : ''}?`)) return;
    setBusy(true);
    try {
      const result = await deleteAgentGroupSessions(
        selectedEntries,
        { removeWorktrees: withWorktrees, projectDirectory: projectKey },
        {
          deleteSession: ({ sessionID, directory }) => services.engine.actions.deleteSession(sessionID, directory),
          removeWorktree: async ({ projectDirectory, worktreePath, worktreeBranch }) => {
            const outcome = await removeProjectWorktree(projectDirectory, worktreePath, true);
            if (!outcome.ok) throw new Error(outcome.error);
            return {
              removed: true,
              branchError: worktreeBranch !== null && outcome.branch === null ? `failed to delete local branch ${worktreeBranch}` : undefined,
            };
          },
          disposeDirectory: (directory) => services.engine.manager.disposeDirectory(directory),
          currentDirectory: () => props.currentDirectory,
          resetToProjectRoot: (projectDirectory) => {
            useSessionViewStore.setState({ activeDirectory: projectDirectory, currentSessionId: null });
          },
        },
      );
      const failures = [
        ...result.failedSessions.map(({ sessionID, error }) => `${sessionID}: ${error}`),
        ...result.failedWorktrees.map(({ path, error }) => `${path}: ${error}`),
        ...result.failedBranches.map(({ path, error }) => `${path}: ${error}`),
      ];
      if (failures.length > 0) toast.error(`Removed ${result.deletedSessionIds.length + result.removedWorktrees.length} item(s); ${failures.length} failed: ${failures.join('; ')}`);
      await useAgentGroupsStore.getState().loadGroups(projectKey, true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="flex min-w-0 flex-1 flex-col bg-neutral-950" data-testid="agent-manager">
      <header className="flex min-h-12 items-center justify-between gap-3 border-b border-white/10 px-3">
        <div className="min-w-0">
          <div className="truncate text-sm text-neutral-100">Agent Groups</div>
          <div className="text-[11px] text-neutral-500">{allSessions.length} runs · {activeCount} active</div>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" disabled={busy || selectedCount === 0} data-testid="agent-remove-sessions" className="rounded border border-white/10 px-2 py-1 text-[11px] text-neutral-300 hover:bg-white/5 disabled:opacity-50" onClick={() => void removeSelected(false)}>
            Delete sessions
          </button>
          <button type="button" disabled={busy || selectedCount === 0} data-testid="agent-remove-worktrees" className="rounded bg-red-950 px-2 py-1 text-[11px] text-red-200 hover:bg-red-900 disabled:opacity-50" onClick={() => void removeSelected(true)}>
            Delete + worktrees
          </button>
          <button type="button" aria-label="Close agent groups" data-testid="agent-close" className="rounded px-2 py-1 text-neutral-500 hover:text-neutral-100" disabled={busy} onClick={props.onClose}>X</button>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {snapshot.status === 'loading' ? <div className="text-xs text-neutral-500">Loading groups…</div> : null}
        {snapshot.errors.length > 0 ? (
          <div className="mb-3 rounded bg-red-950/50 p-2 text-[11px] text-red-200" data-testid="agent-errors">
            {snapshot.errors.map((error) => <div key={error}>{error}</div>)}
          </div>
        ) : null}
        {snapshot.groups.length === 0 && snapshot.status !== 'loading' ? (
          <div className="rounded bg-white/[0.03] px-3 py-4 text-sm text-neutral-500">No worktree groups yet.</div>
        ) : (
          <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' }}>
            {snapshot.groups.map((group) => (
              <div key={group.name} className="rounded-xl border border-white/10 bg-neutral-900/70 p-3" data-testid="agent-group">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-sm text-neutral-100">{group.name}</div>
                    <div className="text-[10px] text-neutral-500">{group.sessionCount} runs</div>
                  </div>
                  <button type="button" className="text-[10px] text-neutral-500 hover:text-neutral-100" onClick={() => {
                    const groupKeys = group.sessions.map(selectionKey);
                    const allSelected = groupKeys.every((key) => selected.has(key));
                    setSelected((current) => {
                      const next = new Set(current);
                      for (const key of groupKeys) {
                        if (allSelected) next.delete(key);
                        else next.add(key);
                      }
                      return next;
                    });
                  }}>
                    {group.sessions.every((entry) => selected.has(selectionKey(entry))) ? 'Clear' : 'Select'}
                  </button>
                </div>
                <div className="mt-2 space-y-2">
                  {group.sessions.map((entry) => {
                    const key = selectionKey(entry);
                    const status = statusById[entry.session.id];
                    const active = status !== undefined && status.type !== 'idle';
                    const current = normalizeDirectory(entry.session.directory ?? '') === currentDirectoryKey || isDirectoryInside(currentDirectoryKey, entry.worktreePath);
                    return (
                      <div key={key} className="rounded-lg border border-white/5 bg-neutral-950 p-2" data-testid="agent-run">
                        <label className="flex items-start gap-2">
                          <input type="checkbox" checked={selected.has(key)} onChange={() => toggle(entry)} data-testid="agent-run-select" />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[12px] text-neutral-200">{entry.session.title || 'Untitled run'}</span>
                            <span className="block truncate text-[10px] text-neutral-600">{entry.worktreeBranch ?? entry.worktreePath} · {entry.session.directory}</span>
                          </span>
                          <span aria-label={active ? 'Run is active' : 'Run is idle'} className={active ? 'h-2 w-2 shrink-0 rounded-full bg-sky-400' : 'h-2 w-2 shrink-0 rounded-full bg-neutral-700'} data-testid={active ? 'agent-active-dot' : undefined} />
                        </label>
                        <button type="button" className={current ? 'mt-2 w-full rounded bg-white/10 px-2 py-1 text-[11px] text-neutral-100' : 'mt-2 w-full rounded bg-white/5 px-2 py-1 text-[11px] text-neutral-300 hover:bg-white/10'} onClick={() => props.onOpenSession(entry.session)}>
                          Open chat
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function selectionKey(entry: AgentGroupSession): string {
  return `${entry.worktreePath}\u0000${entry.session.id}`;
}
