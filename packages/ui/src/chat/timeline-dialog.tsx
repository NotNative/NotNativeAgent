// SPDX-License-Identifier: Apache-2.0
/**
 * Timeline dialog (doc 05 §A.7): session turns newest-first, search, and the
 * row action set — click = scroll+close; menu: Revert from here (loads the
 * reverted prompt back into the composer per §D.6), Fork from here (mock fork
 * + optional instructions into the composer), Previous-turn navigation.
 * Keyboard: rows focusable, Enter activates, Escape closes.
 */
import { useSyncExternalStore, useState, useMemo, type ReactNode } from 'react';
import { toast } from 'sonner';
import type { StoreApi } from 'zustand/vanilla';
import type { DirectoryStore } from '../sync/types.ts';
import type { SyncEngine } from '../sync/sync-engine.ts';
import { useSessionViewStore } from '../sync/view-store.ts';
import { persistLastActiveSession } from '../sync/persist-cache.ts';
import { projectTurns, type PartLite } from './turns.ts';
import { formatRelative } from './time-format.ts';
import { exportSession } from './session-export.ts';

export interface TimelineDialogProps {
  store: StoreApi<DirectoryStore>;
  engine: SyncEngine;
  sessionID: string;
  onClose: () => void;
}

interface Row {
  id: string;
  at: number;
  text: string;
}

export function TimelineDialog({ store, engine, sessionID, onClose }: TimelineDialogProps): ReactNode {
  const snapshot = useSyncExternalStore(store.subscribe, store.getState);
  const [query, setQuery] = useState('');
  const [forkRow, setForkRow] = useState<Row | null>(null);
  const [instruction, setInstruction] = useState('');
  const [busy, setBusy] = useState(false);

  const rows = useMemo<Row[]>(() => {
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

  const composerTextOf = (row: Row): string => row.text;

  const revertFromHere = async (row: Row): Promise<void> => {
    try {
      await engine.actions.revert(sessionID, row.id);
      // §A.7 + §D.6: the reverted prompt text re-fills the composer.
      window.dispatchEvent(new CustomEvent('nnd:composer-fill', { detail: { text: composerTextOf(row) } }));
      toast.message('Conversation reverted to this point — the prompt is back in the composer');
      onClose();
    } catch {
      toast.error('Failed to revert the conversation');
    }
  };

  /** §A.7 fork-from-here: mock fork copies the entries; optional instructions
   *  pre-fill the composer of the NEW session (never auto-sent). */
  const forkFromHere = async (): Promise<void> => {
    if (!forkRow) return;
    setBusy(true);
    try {
      const childID = await engine.actions.fork(sessionID, forkRow.id);
      const directory = engine.routingDirectoryOf(sessionID) ?? useSessionViewStore.getState().activeDirectory;
      persistLastActiveSession(childID, directory);
      useSessionViewStore.setState({ currentSessionId: childID, activeDirectory: directory || useSessionViewStore.getState().activeDirectory });
      if (instruction.trim()) {
        window.dispatchEvent(new CustomEvent('nnd:composer-fill', { detail: { text: instruction.trim() } }));
      }
      toast.success('Forked into a new session');
      setForkRow(null);
      setInstruction('');
      onClose();
    } catch {
      toast.error('Failed to fork the session');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div role="dialog" aria-label="Conversation Timeline" tabIndex={0} data-testid="timeline-dialog"
      className="absolute inset-0 z-30 flex items-start justify-center bg-black/50 p-10"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          if (forkRow) { setForkRow(null); return; }
          onClose();
        }
      }}>
      <div className="flex max-h-[70vh] w-full max-w-2xl flex-col rounded-xl border border-white/10 bg-neutral-950 p-3">
        <div className="mb-2 flex items-center gap-2">
          <strong className="text-[13px] text-neutral-100">Conversation Timeline</strong>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search messages…" aria-label="Search messages" data-testid="timeline-search" className="ml-auto w-56 rounded-lg border border-white/10 bg-neutral-900 px-2 py-1 text-[12px] text-neutral-200 outline-none focus:border-white/25" />
          <button type="button" aria-label="Export transcript" data-testid="timeline-export"
            onClick={() => { try { exportSession(store, sessionID); toast.success('Transcript exported as Markdown'); } catch { toast.error('Failed to export the transcript'); } }}
            className="rounded px-2 py-1 text-[12px] text-neutral-400 hover:text-white">⬇</button>
          <button type="button" aria-label="Close timeline" className="rounded px-2 py-1 text-[12px] text-neutral-400 hover:text-white" onClick={onClose}>×</button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {rows.length === 0 ? <div className="p-4 text-[12px] text-neutral-600">No messages in this session yet</div> : null}
          {visible.length === 0 && rows.length > 0 ? <div className="p-4 text-[12px] text-neutral-600">No messages found</div> : null}
          {visible.map((row, index) => (
            <div key={row.id} className="flex items-start gap-2 rounded-lg px-2 py-2 hover:bg-white/5" data-testid="timeline-row">
              <span className="mt-0.5 w-16 shrink-0 text-right text-[10px] text-neutral-600">{formatRelative(row.at)}</span>
              <button type="button" className="min-w-0 flex-1 text-left text-[12px] text-neutral-300" onClick={() => scrollTo(row.id, onClose)}>
                <span className="line-clamp-2">{row.text || '[No text content]'}</span>
              </button>
              {index < visible.length - 1 ? (
                <button type="button" className="text-[10px] text-neutral-500 hover:text-neutral-200" aria-label="Previous turn" onClick={() => jumpTo(visible[index + 1]!.id)}>↑</button>
              ) : null}
              <button type="button" className="text-[10px] text-neutral-500 hover:text-neutral-200" aria-label="Revert from here" data-testid="timeline-revert" onClick={() => void revertFromHere(row)}>⟲</button>
              <button type="button" className="text-[10px] text-neutral-500 hover:text-neutral-200" aria-label="Fork from here" data-testid="timeline-fork" onClick={() => setForkRow(row)}>⑂</button>
            </div>
          ))}
        </div>
        {forkRow ? (
          <div className="mt-2 rounded-lg border border-white/10 bg-neutral-900/80 p-3" data-testid="timeline-fork-dialog">
            <div className="mb-1 text-[12px] font-medium text-neutral-200">Fork from here</div>
            <p className="mb-2 text-[11px] text-neutral-400">A new session copies everything up to “{(forkRow.text || '[No text content]').slice(0, 60)}”. Optional first instructions land in the composer — nothing is sent automatically.</p>
            <textarea value={instruction} onChange={(event) => setInstruction(event.target.value)} rows={2} placeholder="Optional instructions for the fork…" data-testid="timeline-fork-instructions" className="w-full resize-none rounded-lg border border-white/10 bg-neutral-900 p-2 text-[12px] text-neutral-200 outline-none focus:border-white/25" />
            <div className="mt-2 flex items-center gap-2">
              <button type="button" disabled={busy} className="rounded bg-indigo-600/80 px-2 py-1 text-[11px] text-white disabled:opacity-40" data-testid="timeline-fork-confirm" onClick={() => void forkFromHere()}>Fork session</button>
              <button type="button" className="rounded bg-neutral-800 px-2 py-1 text-[11px] text-neutral-300" onClick={() => setForkRow(null)}>Cancel</button>
            </div>
          </div>
        ) : null}
        <footer className="mt-2 border-t border-white/10 pt-2 text-[10px] text-neutral-600">Click = scroll · ⟲ = revert (prompt returns to the composer) · ⑂ = fork a new session from here · Esc closes</footer>
      </div>
    </div>
  );
}

/** Idempotent anchor: replaceState clears the hash WITHOUT a history entry,
 * then sets it for repeat presses (the consumption contract doc 05 §J.3). */
function scrollTo(messageID: string, onClose: () => void): void {
  onClose();
  jumpTo(messageID);
}

/** Jump without closing (the ↑ previous-turn action). */
function jumpTo(messageID: string): void {
  if (typeof window === 'undefined') return;
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
  window.location.hash = `#message-${messageID}`;
  document.getElementById(`message-${messageID}`)?.scrollIntoView({ block: 'start' });
}
