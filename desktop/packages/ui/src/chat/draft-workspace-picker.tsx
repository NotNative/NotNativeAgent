// SPDX-License-Identifier: Apache-2.0
import { useEffect, useSyncExternalStore, type ReactNode } from 'react';
import { normalizeDirectory } from '../lib/nnd/client.ts';
import { useWorkspaceStore } from '../stores/useWorkspaceStore.ts';
import { getRuntimeKey } from '../lib/runtime-switch.ts';
import { shortDirectory } from './session-sidebar-utils.ts';
import { useWorkspaceDisplayStore, workspaceDisplay } from '../stores/useWorkspaceDisplayStore.ts';
import { SidebarIcon } from './sidebar-icon.tsx';

function subscribeRuntime(notify: () => void): () => void {
  window.addEventListener('notnative:runtime-endpoint-changed', notify);
  return () => window.removeEventListener('notnative:runtime-endpoint-changed', notify);
}

export function DraftWorkspacePicker({ directory, onSelect }: { directory: string; onSelect: (directory: string) => void }): ReactNode {
  const displays = useWorkspaceDisplayStore(state => state.rows);
  const inventory = useWorkspaceStore(state => state.inventory);
  const error = useWorkspaceStore(state => state.phase === 'error');
  const runtimeKey = useSyncExternalStore(subscribeRuntime, getRuntimeKey);
  useEffect(() => { void useWorkspaceStore.getState().load(); }, [runtimeKey]);
  const current = normalizeDirectory(directory);
  const roots = inventory ? [inventory.attached.root, ...inventory.admitted.map(row => row.root)] : [];
  if (!roots.some(root => normalizeDirectory(root) === current)) roots.unshift(directory);
  return <div className="flex flex-wrap items-center gap-2 text-[12px] text-neutral-300" data-testid="draft-workspace-picker">
    <span className="text-sky-400"><SidebarIcon name="folder" /></span>
    <select aria-label="New conversation workspace" value={current}
      className="max-w-72 rounded-md border border-white/10 bg-neutral-800 px-2 py-1.5 text-neutral-100 outline-none focus:border-white/30"
      onChange={event => onSelect(event.target.value)}>
      {roots.map(root => <option key={root} value={normalizeDirectory(root)}>{workspaceDisplay(root, displays).label || shortDirectory(normalizeDirectory(root))}</option>)}
    </select>
    {error ? <span role="status" className="text-amber-300">Workspace list unavailable</span> : null}
  </div>;
}
