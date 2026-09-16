// SPDX-License-Identifier: Apache-2.0
/**
 * Timeline dialog (doc 05 §A.7, v1): sessions' turns newest-first, search,
 * rows navigate/fork/revert; fork hands the prompt to the composer when the
 * harness returns one (pendingComposerRestore consumed by the composer).
 */
import { useSyncExternalStore, useState, useMemo } from 'react';
import type { StoreApi } from 'zustand/vanilla';
import type { DirectoryStore } from '../sync/types.ts';
import type { SyncEngine } from '../sync/sync-engine.ts';
import { projectTurns, type PartLite } from './turns.ts';
import { formatRelative } from './time-format.ts';
import type { ReactNode } from 'react';

export interface TimelineDialogProps {
  store: StoreApi<DirectoryStore>;
  engine: SyncEngine;
  sessionID: string;
  onClose: () => void;
}

export function TimelineDialog({ store, engine, sessionID, onClose }: TimelineDialogProps): ReactNode {
  const snapshot = useSyncExternalStore(store.subscribe, store.getState);
  const [query, setQuery] = useState('');
  const rows = useMemo(() => {
    const turns = projectTurns(snapshot.message[sessionID] ?? []);
    return turns
      .map((turn) => ({
        id: turn.userMessage.id,
        at: turn.userMessage.time.created,
        text: ((snapshot.part[turn.userMessage.id] ?? []) as PartLite[]).filter((part) => part.type === 'text').map((part) => part.text ?? '').join('\n').trim(),
      }))
      .reverse();
  }, [snapshot, sessionID]);
  const visible = rows.filter((row) => row.text.toLowerCase().includes(query.trim().toLowerCase()));

  return (
    <div role="dialog" aria-label="Conversation Timeline" className="absolute inset-0 z-30 flex items-start justify-center bg-black/50 p-10" data-testid="timeline-dialog">
      <div className="flex max-h-[70vh] w-full max-w-2xl flex-col rounded-xl border border-white/10 bg-neutral-950 p-3">
        <div className="mb-2 flex items-center gap-2">
          <strong className="text-[13px] text-neutral-100">Conversation Timeline</strong>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search messages…" aria-label="Search messages" className="ml-auto w-56 rounded-lg border border-white/10 bg-neutral-900 px-2 py-1 text-[12px] text-neutral-200 outline-none focus:border-white/25" />
          <button type="button" aria-label="Close timeline" className="rounded px-2 py-1 text-[12px] text-neutral-400 hover:text-white" onClick={onClose}>×</button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {rows.length === 0 ? <div className="p-4 text-[12px] text-neutral-600">No messages in this session yet</div> : null}
          {visible.length === 0 && rows.length > 0 ? <div className="p-4 text-[12px] text-neutral-600">No messages found</div> : null}
          {visible.map((row) => (
            <div key={row.id} className="flex items-start gap-2 rounded-lg px-2 py-2 hover:bg-white/5" data-testid="timeline-row">
              <span className="mt-0.5 w-16 shrink-0 text-right text-[10px] text-neutral-600">{formatRelative(row.at)}</span>
              <button type="button" className="min-w-0 flex-1 text-left text-[12px] text-neutral-300" onClick={() => scrollTo(row.id, onClose)}>
                <span className="line-clamp-2">{row.text || '[No text content]'}</span>
              </button>
              <button type="button" className="text-[10px] text-neutral-500 hover:text-neutral-200" aria-label="Revert from here" onClick={() => void engine.actions.revert(sessionID, row.id).then(onClose).catch(() => undefined)}>⟲</button>
              <button type="button" className="text-[10px] text-neutral-500 hover:text-neutral-200" aria-label="Fork from here" onClick={() => void engine.actions.fork(sessionID, row.id).then(onClose).catch(() => undefined)}>⑂</button>
            </div>
          ))}
        </div>
        <footer className="border-t border-white/10 pt-2 text-[10px] text-neutral-600">Click = scroll · ⟲ = revert to this point · ⑂ = fork a new session from here · Esc closes</footer>
      </div>
    </div>
  );
}

/** Idempotent anchor: clear the hash so repeat presses still work (§E.9 pinned rule). */
function scrollTo(messageID: string, onClose: () => void): void {
  onClose();
  if (typeof window === 'undefined') return;
  window.location.hash = '';
  window.location.hash = `#message-${messageID}`;
  document.getElementById(`message-${messageID}`)?.scrollIntoView({ block: 'start' });
}
