// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { getRuntimeKey, onRuntimeEndpointChanged } from '../lib/runtime-switch.ts';
import { readDurableActivityPage, type DurableActivityPage } from '../sync/durable-activity-history.ts';
import type { ActivityRecord } from '../sync/activity-log.ts';

type View = { scope: string; state: 'loading' | 'ready' | 'gap' | 'unavailable';
  snapshot?: DurableActivityPage['snapshot']; records: ActivityRecord[]; cursor: string | null };

/** Deliberately independent of the live Activity store and SSE cursor. */
export function SavedActivityWindow({ directory, sessionID }: { directory: string; sessionID: string }): ReactNode {
  const runtimeKey = useSyncExternalStore((notify) => onRuntimeEndpointChanged(notify), getRuntimeKey, getRuntimeKey);
  const scope = JSON.stringify([runtimeKey, directory, sessionID]);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const sequence = useRef(0);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View | null>(null);
  const shown = view?.scope === scope ? view : null;
  useEffect(() => {
    sequence.current += 1;
    setOpen(false);
    setView(null);
  }, [scope]);

  async function load(cursor?: string): Promise<void> {
    if (!sessionID || getRuntimeKey() !== runtimeKey) return;
    const token = ++sequence.current;
    const previous = cursor && shown?.state === 'ready' ? shown : null;
    setView({ scope, state: 'loading', snapshot: previous?.snapshot,
      records: previous?.records ?? [], cursor: previous?.cursor ?? null });
    try {
      const page = await readDurableActivityPage(sessionID, cursor);
      if (token !== sequence.current || currentScope.current !== scope || getRuntimeKey() !== runtimeKey) return;
      if (page.status === 'gap' || previous && (previous.snapshot?.digest !== page.snapshot.digest
        || previous.snapshot.createdAt !== page.snapshot.createdAt)) {
        setView({ scope, state: 'gap', records: [], cursor: null });
        return;
      }
      const records = previous ? [...page.records, ...previous.records] : page.records;
      if (records.length > 500 || new Set(records.map((row) => row.id)).size !== records.length) {
        setView({ scope, state: 'gap', records: [], cursor: null });
        return;
      }
      setView({ scope, state: 'ready', snapshot: page.snapshot, records, cursor: page.nextCursor });
    } catch {
      if (token === sequence.current && currentScope.current === scope && getRuntimeKey() === runtimeKey) {
        setView({ scope, state: 'unavailable', records: previous?.records ?? [], cursor: previous?.cursor ?? null,
          snapshot: previous?.snapshot });
      }
    }
  }

  return <section className="mt-2 rounded border border-white/10 p-2 text-[10px]" data-testid="saved-activity-window">
    <button type="button" aria-expanded={open} className="text-sky-300 hover:underline" onClick={() => {
      setOpen((value) => !value);
      if (!open && !shown) void load();
    }}>Saved Activity · retained window</button>
    {open ? <div className="mt-2 space-y-2">
      <p className="text-neutral-400">This is a partial durable snapshot, separate from the live log. Earlier records may have been discarded; stream gaps are not filled by this view.</p>
      {shown?.state === 'loading' ? <p role="status">Loading saved Activity…</p> : null}
      {shown?.state === 'unavailable' ? <p role="status" className="text-amber-300">Saved Activity could not be verified. <button type="button" className="underline" onClick={() => void load()}>Retry newest</button></p> : null}
      {shown?.state === 'gap' ? <p role="status" className="text-amber-300">The saved snapshot changed while paging. Previously loaded rows were cleared. <button type="button" className="underline" onClick={() => void load()}>Reload newest</button></p> : null}
      {shown?.state === 'ready' ? <>
        <p role="status" className="text-neutral-400">{shown.snapshot?.durablePresent
          ? `${shown.snapshot.retainedCount} retained record${shown.snapshot.retainedCount === 1 ? '' : 's'} in this saved window.`
          : 'No durable snapshot is available for this session.'}</p>
        <ol className="max-h-56 space-y-1 overflow-y-auto" data-testid="saved-activity-rows">{shown.records.map((row) =>
          <li key={row.id} className="rounded border border-white/10 p-1"><span className="text-neutral-500">{row.kind} · {row.status} · </span><span className="break-words">{row.summary}</span></li>)}</ol>
        {shown.cursor ? <button type="button" className="text-sky-300 hover:underline" onClick={() => void load(shown.cursor!)}>Load older retained records</button>
          : <p className="text-neutral-500">End of the retained window; this does not establish the start of session history.</p>}
      </> : null}
    </div> : null}
  </section>;
}
