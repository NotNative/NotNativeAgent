// SPDX-License-Identifier: Apache-2.0
import type { ReactNode } from 'react';
import { toast } from 'sonner';
import type { Session } from '../lib/nnd/types.ts';
import type { ChatSidebarProps } from './session-sidebar.tsx';
import { useSessionFoldersStore } from '../stores/useSessionFoldersStore.ts';
import { useGlobalSessionsStore } from '../sync/global-stores.ts';
import { getRuntimeKey } from '../lib/runtime-switch.ts';
import { clearKnownSessionTreePins } from './session-pin-cleanup.ts';
import { formatRelative } from './time-format.ts';
import { shortDirectory } from './session-sidebar-utils.ts';

export function FolderActions({ directory, folderId, folderName, hasSessions }: { directory: string; folderId: string; folderName: string; hasSessions: boolean }): ReactNode {
  return <div className="flex items-center gap-1 text-[10px] text-neutral-600 opacity-0 transition group-hover:opacity-100">
    <button type="button" aria-label={`Rename folder ${folderName}`} onClick={() => {
      const name = prompt('Rename folder', folderName); // eslint-disable-line no-alert
      if (name !== null) void useSessionFoldersStore.getState().renameFolder(directory, folderId, name);
    }}>✎</button>
    <button type="button" aria-label={`Delete folder ${folderName}`} onClick={() => {
      if (hasSessions && !confirm('Delete the folder? Inside sessions survive as unsorted.')) return; // eslint-disable-line no-alert
      void useSessionFoldersStore.getState().deleteFolder(directory, folderId);
    }}>🗑</button>
  </div>;
}

export function ArchivedRow({ session, actions }: { session: Session; actions: ChatSidebarProps['actions'] }): ReactNode {
  return <li className="group flex items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-white/5">
    <button type="button" className="min-w-0 flex-1 text-left" onClick={() => actions.openSession(session.id, session.directory ?? '')} data-testid="archived-row">
      <div className="truncate text-[13px] text-neutral-500">{session.title || 'Untitled Session'}</div>
      <div className="text-[10px] text-neutral-700">archived {formatRelative(session.time.archived ?? session.time.updated)}{session.directory ? <> · <span data-testid="archived-workspace-label" title={session.directory}>{shortDirectory(session.directory)}</span></> : null}</div>
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
  </li>;
}
