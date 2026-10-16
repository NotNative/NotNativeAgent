// SPDX-License-Identifier: Apache-2.0
import { useState, type ReactNode } from 'react';
import { ConversationRenameDialog } from './conversation-rename-dialog.tsx';
import { normalizeDirectory } from '../lib/nnd/client.ts';
import { useGlobalSessionsStore } from '../sync/global-stores.ts';
import type { Session, SessionStatus } from '../lib/nnd/types.ts';
import type { ChatSidebarProps } from './session-sidebar.tsx';
import { toast } from 'sonner';
import { formatRelative } from './time-format.ts';
import { childActivityPhrase, sessionAttention } from './session-row-evidence.ts';
import { useSessionPinnedStore } from '../stores/useSessionPinnedStore.ts';
import { getRuntimeKey } from '../lib/runtime-switch.ts';
import { clearKnownSessionTreePins } from './session-pin-cleanup.ts';
import { fusionIdentityFromSession } from '../lib/multirun/fusion.ts';
import { shortDirectory } from './session-sidebar-utils.ts';
import { suggestAndApplyRename } from './suggest-name.ts';
import { SidebarIcon } from './sidebar-icon.tsx';
import { useSessionFoldersStore } from '../stores/useSessionFoldersStore.ts';
export function SidebarRow({ session, status, currentSessionId, actions, pinned, folderId, depth = 0, selecting, selected, onToggleSelected, hasChildren, expanded, onToggleExpanded, hiddenAttention, onRunFusion, allowFolders }: { session: Session; status: SessionStatus | undefined; currentSessionId: string | null; actions: ChatSidebarProps['actions']; pinned: boolean; folderId?: string; depth?: number; selecting: boolean; selected: boolean; onToggleSelected: () => void; hasChildren: boolean; expanded: boolean; onToggleExpanded: () => void; hiddenAttention?: string[]; onRunFusion?: (session: Session) => void; allowFolders: boolean }): ReactNode {
  const [renaming, setRenaming] = useState(false);
  const active = status && status.type !== 'idle';
  const attention = sessionAttention(session);
  const activity = !attention ? childActivityPhrase(session.metadata) : null;
  return (
    <>
    {renaming ? <ConversationRenameDialog title={session.title ?? ''} save={title => actions.rename(session.id, title)} close={() => setRenaming(false)} /> : null}
    <li className={`group flex items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-muted/50 ${depth > 0 ? 'border-l border-border/50' : ''}`} style={depth > 0 ? { marginLeft: `${depth * 16}px` } : undefined} data-child-session={session.parentID ? 'true' : undefined} data-child-depth={depth > 0 ? depth : undefined} data-attention={attention ?? undefined}>
      {hasChildren ? <button type="button" aria-label={`${expanded ? 'Collapse' : 'Expand'} ${session.title || 'session'} subtasks`} aria-expanded={expanded} className="shrink-0 text-[11px] text-muted-foreground hover:text-foreground" onClick={onToggleExpanded}>{expanded ? '▾' : '▸'}</button> : null}
      {selecting && !session.parentID && !session.time.archived ? <input type="checkbox" aria-label={`Select ${session.title || 'session'}`} checked={selected} onChange={onToggleSelected} /> : null}
      <button type="button" className="min-w-0 flex-1 text-left" onClick={() => selecting && !session.parentID && !session.time.archived ? onToggleSelected() : actions.openSession(session.id, session.directory ?? '')} data-testid="session-row">
        <div className="flex items-center gap-1.5">
          <span aria-hidden className={`inline-block h-1.5 w-1.5 rounded-full ${attention || hiddenAttention?.length ? 'bg-amber-400' : active ? 'bg-sky-400' : 'bg-neutral-700'}`} />
          {session.parentID ? <span className="text-[10px] text-muted-foreground" aria-label="Child session">↳</span> : null}
          <span className={`min-w-0 flex-1 truncate text-[13px] ${currentSessionId === session.id ? 'text-foreground' : 'text-muted-foreground'}`}>{session.title || 'Untitled Session'}</span>
          {pinned ? <span aria-label="Pinned session" className="text-[10px] text-amber-400">◆</span> : null}
        </div>
        <div className="pl-3 text-[10px] text-muted-foreground">{formatRelative(session.time.updated)}{session.parentID && session.agent ? <span> · {session.agent}</span> : null}{session.directory ? <span data-testid="session-workspace-label" title={session.directory}> · {shortDirectory(session.directory)}</span> : null}{attention ? <span className="text-amber-300"> · {attention}</span> : null}{hiddenAttention?.length ? <span className="text-amber-300" data-testid="collapsed-subtask-attention"> · {hiddenAttention.length} subtask{hiddenAttention.length === 1 ? ' needs' : 's need'} attention</span> : null}{activity ? <span className="text-sky-300" data-testid={session.parentID ? 'child-current-activity' : 'session-current-activity'}> · {activity}</span> : null}</div>
      </button>
      {!selecting ? <details className="relative shrink-0">
        <summary aria-label={`More actions for ${session.title || 'session'}`} title="Conversation actions" className="flex h-8 w-8 cursor-pointer list-none items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"><SidebarIcon name="more" /></summary>
        <div onClick={event => { if ((event.target as Element).closest('button')) event.currentTarget.closest('details')?.removeAttribute('open'); }} className="absolute right-0 top-9 z-30 w-48 rounded-xl border border-border/60 bg-muted p-1.5 shadow-xl [&>button]:block [&>button]:w-full [&>button]:rounded-lg [&>button]:px-3 [&>button]:py-2 [&>button]:text-left [&>button]:text-xs [&>button:hover]:bg-muted">
          <button type="button" aria-label={`${pinned ? 'Unpin' : 'Pin'} ${session.title || 'session'}`} onClick={() => useSessionPinnedStore.getState().toggle(session.directory ?? 'global', session.id)}>{pinned ? 'Unpin conversation' : 'Pin conversation'}</button>
          {!session.parentID ? <>
            <button type="button" aria-label={`Rename ${session.title || 'session'}`} data-testid="session-rename" onClick={() => setRenaming(true)}>Rename</button>
            {actions.fork && !session.time.archived ? <button type="button" aria-label={`Fork ${session.title || 'session'}`} onClick={() => void actions.fork?.(session.id, session.directory ?? '').catch(() => toast.error('Could not fork the conversation'))}>Fork conversation</button> : null}
            <button type="button" aria-label={`Suggest a name for ${session.title || 'session'}`} data-testid="session-suggest-name" onClick={() => suggestAndApplyRename(session.id, session.directory ?? '', actions.rename)}>Suggest a name</button>
            {session.time.archived ? <button type="button" aria-label={`Restore ${session.title || 'session'}`} onClick={() => void actions.restore(session.id, session.directory ?? '').catch(() => toast.error('Failed to restore the session'))}>Restore</button>
              : <button type="button" aria-label={`Archive ${session.title || 'session'}`} onClick={() => void actions.archive(session.id, session.directory ?? '').catch(() => toast.error('Failed to archive the session'))}>Archive</button>}
            {fusionTarget(session) ? <button type="button" aria-label={`Run fusion on ${session.title || 'session'}`} data-testid="run-fusion" onClick={() => onRunFusion?.(session)}>Run fusion</button> : null}
            {allowFolders ? <button type="button" aria-label={`File ${session.title || 'session'} into a folder`} data-testid="session-file-into" onClick={() => {
              const choices = foldersOfSession(session);
              if (choices.length === 0) { toast.message('Create a folder in this workspace first'); return; }
              const pick = prompt(`File into folder:\n${choices.map((folder, at) => `${at + 1}. ${folder.name}`).join('\n')}`, '1'); // eslint-disable-line no-alert
              const index = Number((pick ?? '').trim()) - 1;
              const target = Number.isInteger(index) && choices[index] ? choices[index] : null;
              if (target) void useSessionFoldersStore.getState().assignSession(session.directory ?? '', target.id, session.id);
            }}>Move to folder</button> : null}
          </> : null}
          {allowFolders && folderId ? <button type="button" aria-label="Unfile from folder" onClick={() => void useSessionFoldersStore.getState().unassignSession(session.directory ?? '', session.id)}>Remove from folder</button> : null}
          {!session.parentID ? <button type="button" aria-label={`Delete ${session.title || 'session'}`} className="text-red-300" onClick={() => {
            if (!confirm(`Delete ${session.title || 'session'} and its subtasks?`)) return; // eslint-disable-line no-alert
            const runtimeKey = getRuntimeKey();
            const known = [...useGlobalSessionsStore.getState().active, ...useGlobalSessionsStore.getState().archived];
            void actions.deleteSession(session.id, session.directory ?? '').then(() => clearKnownSessionTreePins(session, known, runtimeKey)).catch(() => toast.error('Failed to delete the session'));
          }}>Delete</button> : null}
        </div>
      </details> : null}
    </li></>
  );
}

function fusionTarget(session: Session): boolean {
  return fusionIdentityFromSession(session) !== null;
}

/** Folders that live in the session's directory (the assignment key). */
function foldersOfSession(session: Session): import('../lib/session-folders.ts').SessionFolder[] {
  const directory = normalizeDirectory(session.directory ?? '');
  return useSessionFoldersStore.getState().foldersByDirectory[directory] ?? [];
}
