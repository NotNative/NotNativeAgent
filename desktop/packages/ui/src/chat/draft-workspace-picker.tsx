// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { normalizeDirectory } from '../lib/nnd/client.ts';
import { useWorkspaceStore } from '../stores/useWorkspaceStore.ts';
import { getRuntimeKey } from '../lib/runtime-switch.ts';
import { shortDirectory } from './session-sidebar-utils.ts';
import { useWorkspaceDisplayStore, workspaceDisplay } from '../stores/useWorkspaceDisplayStore.ts';
import { SidebarIcon } from './sidebar-icon.tsx';
import { activeWorkspaceRoots, newConversationWorkspace } from './active-workspaces.ts';

function subscribeRuntime(notify: () => void): () => void {
  window.addEventListener('notnative:runtime-endpoint-changed', notify);
  return () => window.removeEventListener('notnative:runtime-endpoint-changed', notify);
}

export function DraftWorkspacePicker({ directory, onSelect }: { directory: string; onSelect: (directory: string) => void }): ReactNode {
  const displays = useWorkspaceDisplayStore(state => state.rows);
  const ready = useWorkspaceDisplayStore(state => state.ready);
  const displayError = useWorkspaceDisplayStore(state => state.error);
  const inventory = useWorkspaceStore(state => state.inventory);
  const error = useWorkspaceStore(state => state.phase === 'error');
  const runtimeKey = useSyncExternalStore(subscribeRuntime, getRuntimeKey);
  const [failure, setFailure] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const select = useRef(onSelect); select.current = onSelect;
  useEffect(() => { void useWorkspaceStore.getState().load(); void useWorkspaceDisplayStore.getState().load(); }, [runtimeKey]);
  const current = normalizeDirectory(directory);
  const roots = ready ? activeWorkspaceRoots() : [];
  const signature = JSON.stringify(roots);
  useEffect(() => {
    if (!inventory || !ready || roots.includes(current)) return;
    setFailure(null);
    let live = true;
    void newConversationWorkspace(current).then(next => { if (live) select.current(next); })
      .catch(error => { if (live) setFailure(String(error)); });
    return () => { live = false; };
  }, [current, signature, ready, runtimeKey, Boolean(inventory), retry]);
  return <div className="flex flex-wrap items-center gap-2 text-[12px] text-neutral-300" data-testid="draft-workspace-picker">
    <span className="text-sky-400"><SidebarIcon name="folder" /></span>
    <select aria-label="New conversation workspace" value={roots.includes(current) ? current : ''} disabled={!roots.length}
      className="max-w-72 cursor-pointer rounded-md border-0 bg-transparent py-1 pr-2 text-neutral-200 outline-none hover:bg-white/5 [&>option]:bg-neutral-900"
      onChange={event => onSelect(event.target.value)}>
      {!roots.includes(current) ? <option value="">{ready ? 'Preparing workspace…' : 'Loading workspaces…'}</option> : null}
      {roots.map(root => <option key={root} value={root}>{workspaceDisplay(root, displays).label || shortDirectory(root)}</option>)}
    </select>
    {error || failure || displayError ? <span role="status" className="text-amber-300">{failure || displayError || 'Workspace list unavailable'} <button type="button" className="underline" onClick={() => { void Promise.all([useWorkspaceStore.getState().load(), useWorkspaceDisplayStore.getState().load()]).then(() => setRetry(value => value + 1)); }}>Retry</button></span> : null}
  </div>;
}
