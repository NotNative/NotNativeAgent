// SPDX-License-Identifier: Apache-2.0
/** Workspace manager chip for the persistent shell header: the current
 *  workspace context plus a dropdown over the admission inventory (attached +
 *  admitted roots), with add-workspace and unavailable-row cleanup folded in.
 *  Workspace model gaps (c)+(f) from UX-AUDIT-nnd-workspaces.md. */
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { StoreApi } from 'zustand/vanilla';
import type { DirectoryStore } from '../sync/types.ts';
import { useOptionalI18n } from '../lib/i18n/context.tsx';
import { readNativeWorkspaceAdmissions, addNativeWorkspace, removeUnavailableNativeWorkspace, type WorkspaceAdmissions } from '../lib/nnd/workspace-admission.ts';
import { harnessClient } from '../lib/nnd/client.ts';
import { useGlobalSyncStore } from '../sync/global-stores.ts';
import { normalizeDirectory } from '../lib/nnd/client.ts';
import { toast } from 'sonner';

type WorkspaceSource = {
  childStoreOf: (directory: string) => StoreApi<DirectoryStore> | undefined;
  manager: {
    ensureChild: (directory: string) => StoreApi<DirectoryStore>;
    pin: (directory: string) => () => void;
  };
};
const subscribeNone = (): (() => void) => () => undefined;

export function workspaceName(directory: string, fallback = 'Workspace'): string {
  return directory.replace(/[\\/]+$/u, '').split(/[\\/]/u).filter(Boolean).at(-1) ?? fallback;
}

type AdmissionRow = WorkspaceAdmissions['admitted'][number];

/** Workspace manager chip: identity display + a dropdown that lists every
 *  attached/admitted root (from the native admission inventory), lets the
 *  operator switch with a draft-open, add a workspace by path (the admission
 *  contract; the native picker is a later Electron prerequisite), and remove
 *  unavailable rows (healthy-row revoke rides the same manager once its UI
 *  path lands). One owner for workspace switching in the shell header. */
export function WorkspaceIdentity({ directory, engine, runtimeKey, onOpenDraft }: { directory: string; engine: WorkspaceSource; runtimeKey: string; onOpenDraft: (directory: string) => void }): ReactNode {
  const i18n = useOptionalI18n();
  const [binding, setBinding] = useState<{ directory: string; runtimeKey: string; store: StoreApi<DirectoryStore> } | null>(null);
  const [open, setOpen] = useState(false);
  const [inventory, setInventory] = useState<WorkspaceAdmissions | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  useEffect(() => {
    if (!directory) { setBinding(null); return; }
    // ensureChild schedules a harness bootstrap; never call it during render.
    const store = engine.childStoreOf(directory) ?? engine.manager.ensureChild(directory);
    // The active header outlives a child-store idle TTL; preserve its source
    // until the directory changes so a stale branch cannot remain displayed.
    const release = engine.manager.pin(directory);
    setBinding({ directory, runtimeKey, store });
    return release;
  }, [directory, engine, runtimeKey]);
  // Admission inventory loads when the dropdown first opens (lazy; the
  // sidebar's add button uses the same call).
  useEffect(() => {
    if (!open || inventory || loadFailed) return;
    const live = true;
    readNativeWorkspaceAdmissions().then(next => { if (live) { setInventory(next); setLoadFailed(false); } })
      .catch(() => { if (live) setLoadFailed(true); });
  }, [open, inventory, loadFailed]);
  const store = binding?.directory === directory && binding.runtimeKey === runtimeKey ? binding.store : null;
  const vcs = useSyncExternalStore(store?.subscribe ?? subscribeNone, () => store?.getState().vcs ?? null);
  const branch = typeof vcs?.branch === 'string' && vcs.branch.trim() ? vcs.branch : null;

  const rows: Array<{ root: string; state: 'ok' | 'unavailable' }> = inventory
    ? [
        // The attached primary root leads the list; the audit established the
        // inventory schema has no attached field - the current directory (the
        // attached root or an admitted selection) is passed in via props.
        ...inventory.admitted.map(row => ({ root: row.root, state: 'ok' as const })),
        ...inventory.unavailable.map(row => ({ root: row.root, state: 'unavailable' as const })),
      ]
    : [];
  const seen = new Set(rows.map(row => normalizeDirectory(row.root)));
  const current = normalizeDirectory(directory);
  if (directory && !seen.has(current)) rows.unshift({ root: directory, state: 'ok' });
  const addWorkspace = async (): Promise<void> => {
    const path = window.prompt('Absolute folder path to add as a workspace:'); // eslint-disable-line no-alert
    if (path === null || !path.trim()) return;
    try {
      const admitted = await addNativeWorkspace(path.trim());
      setInventory(null); // refetch on next open
      onOpenDraft(normalizeDirectory(admitted));
      setOpen(false);
      toast.success(`Workspace added: ${workspaceName(admitted)}`);
    } catch (error) { toast.error(error instanceof Error ? error.message : 'Could not add workspace.'); }
  };
  const removeUnavailable = async (root: string): Promise<void> => {
    try {
      await removeUnavailableNativeWorkspace(root);
      setInventory(null);
      toast.success('Stale workspace admission removed.');
    } catch (error) { toast.error(error instanceof Error ? error.message : 'Could not remove the stale workspace.'); }
  };
  const switchTo = (root: string): void => {
    onOpenDraft(normalizeDirectory(root));
    setOpen(false);
  };
  const refreshProjects = async (): Promise<void> => {
    const refreshed = await harnessClient.listProjects();
    if (!refreshed.error && refreshed.data) useGlobalSyncStore.getState().set({ projects: refreshed.data as unknown as Record<string, unknown>[] });
  };

  return <div className="relative flex min-w-0 max-w-56 items-center gap-1.5 border-l border-white/10 pl-3 text-[11px] text-neutral-500" data-testid="workspace-identity">
    <button type="button" aria-haspopup="menu" aria-expanded={open} data-testid="workspace-identity-button"
      title={directory}
      className="flex min-w-0 items-center gap-1.5 rounded px-1 py-0.5 hover:bg-white/5"
      onClick={() => setOpen(value => !value)}>
      <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" className="h-3.5 w-3.5 shrink-0"><path d="M1.5 4.5h4l1.3 1.4h7.7v7.5h-13z"/><path d="M1.5 5V3.4h4.2l1.1 1.1"/></svg>
      <span className="truncate text-neutral-300">{workspaceName(directory, i18n?.t('workspaceUi.workspaceFallback') ?? 'Workspace')}</span>
      {branch ? <span className="flex min-w-0 items-center gap-1 text-neutral-600"><span aria-hidden="true">⑂</span><span className="truncate">{branch}</span></span> : null}
      <svg aria-hidden="true" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2" className="h-2.5 w-2.5 shrink-0 text-neutral-600"><path d="M2.5 4.5 6 8l3.5-3.5"/></svg>
    </button>
    {open ? <div role="menu" aria-label="Workspaces" data-testid="workspace-manager-menu"
      className="absolute left-0 top-full z-40 mt-1 w-80 rounded-lg border border-white/10 bg-neutral-950 p-2 shadow-xl">
      {rows.length === 0 && !loadFailed ? <p className="px-2 py-1 text-[11px] text-neutral-500">Loading workspaces…</p> : null}
      {loadFailed ? <p className="px-2 py-1 text-[11px] text-amber-300">Workspace inventory is unavailable right now.</p> : null}
      <ul className="max-h-64 overflow-y-auto">
        {rows.map(row => <li key={row.root}>
          <div className={`group flex items-center gap-1 rounded px-2 py-1 ${row.root === normalizeDirectory(directory) ? 'bg-white/10' : 'hover:bg-white/5'}`}>
            <button type="button" role="menuitem" data-testid="workspace-manager-row"
              className={`min-w-0 flex-1 truncate text-left text-[12px] ${row.state === 'unavailable' ? 'text-neutral-600 line-through' : row.root === normalizeDirectory(directory) ? 'text-neutral-100' : 'text-neutral-300'}`}
              title={row.root}
              disabled={row.state === 'unavailable'}
              onClick={() => switchTo(row.root)}>
              {workspaceName(row.root)}
              {row.state === 'unavailable' ? <span className="ml-1 text-[10px] text-amber-300">offline</span> : null}
            </button>
            {row.state === 'unavailable' ? <button type="button" role="menuitem" data-testid="workspace-manager-remove"
              aria-label={`Remove stale workspace ${workspaceName(row.root)}`}
              className="shrink-0 text-[10px] text-neutral-600 hover:text-red-400"
              onClick={() => void removeUnavailable(row.root)}>✕</button> : null}
          </div>
        </li>)}
      </ul>
      <div className="mt-1 border-t border-white/10 pt-1">
        <button type="button" role="menuitem" data-testid="workspace-manager-add"
          className="w-full rounded px-2 py-1 text-left text-[12px] text-neutral-400 hover:bg-white/5 hover:text-neutral-200"
          onClick={() => { void (async () => { await addWorkspace(); await refreshProjects(); })(); }}>+ Add workspace…</button>
      </div>
    </div> : null}
  </div>;
}
