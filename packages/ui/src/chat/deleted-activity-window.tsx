// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { getRuntimeKey, onRuntimeEndpointChanged } from '../lib/runtime-switch.ts';
import { useAuthSessionStore } from '../lib/runtime-auth-expiry.ts';
import { readDeletionPage, type DeletionReceipt } from '../sync/activity-tombstones.ts';

type View = { scope: string; state: 'loading' | 'ready' | 'gap' | 'unavailable';
  records: DeletionReceipt[]; cursor: number; floor: number; more: boolean };

/** Separate from session Activity and SSE: deletion receipts are an owner-scoped retained window. */
export function DeletedActivityWindow(): ReactNode {
  const runtime = useSyncExternalStore(onRuntimeEndpointChanged, getRuntimeKey, getRuntimeKey);
  const runtimeEpoch = useRef(0);
  const [runtimeRevision, setRuntimeRevision] = useState(0);
  useEffect(() => onRuntimeEndpointChanged(() => {
    runtimeEpoch.current += 1;
    setRuntimeRevision(runtimeEpoch.current);
  }), []);
  const auth = useAuthSessionStore(state => state.status);
  const scope = JSON.stringify([runtime, runtimeRevision, auth]);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const sequence = useRef(0);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View | null>(null);
  const shown = view?.scope === scope && auth === 'ok' ? view : null;
  useEffect(() => { sequence.current += 1; setOpen(false); setView(null); }, [scope]);

  async function load(after = 0): Promise<void> {
    if (getRuntimeKey() !== runtime || auth !== 'ok' || useAuthSessionStore.getState().status !== 'ok') return;
    const token = ++sequence.current;
    const endpointEpoch = runtimeEpoch.current;
    const previous = after > 0 && shown?.state === 'ready' && shown.cursor === after ? shown : null;
    setView({ scope, state: 'loading', records: previous?.records ?? [], cursor: previous?.cursor ?? 0,
      floor: previous?.floor ?? 0, more: false });
    try {
      const page = await readDeletionPage(after);
      if (token !== sequence.current || endpointEpoch !== runtimeEpoch.current
        || currentScope.current !== scope || getRuntimeKey() !== runtime
        || useAuthSessionStore.getState().status !== 'ok') return;
      if (page.status === 'gap') {
        setView({ scope, state: 'gap', records: [], cursor: 0, floor: page.floor, more: false });
        return;
      }
      const records = previous ? [...previous.records, ...page.records] : page.records;
      if (previous && page.floor !== previous.floor || records.length > 200
        || page.records.some((row) => row.sequence <= (previous?.cursor ?? after))) {
        setView({ scope, state: 'gap', records: [], cursor: 0, floor: page.floor, more: false });
        return;
      }
      setView({ scope, state: 'ready', records, cursor: page.nextCursor!, floor: page.floor,
        more: page.records.length === 50 && records.length < 200 });
    } catch {
      if (token === sequence.current && endpointEpoch === runtimeEpoch.current
        && currentScope.current === scope && getRuntimeKey() === runtime
        && useAuthSessionStore.getState().status === 'ok') {
        setView({ scope, state: 'unavailable', records: previous?.records ?? [], cursor: previous?.cursor ?? 0,
          floor: previous?.floor ?? 0, more: false });
      }
    }
  }

  return <section className="mt-2 rounded border border-white/10 p-2 text-[10px]" data-testid="deleted-activity-window">
    <button type="button" aria-expanded={open} disabled={auth !== 'ok'} className="text-sky-300 hover:underline disabled:opacity-50" onClick={() => {
      setOpen((value) => !value);
      if (!open && !shown) void load();
    }}>Deleted sessions · retained receipts</button>
    {open ? <div className="mt-2 space-y-2">
      <p className="text-neutral-400">These are owner-scoped deletion receipts, not a complete deletion history. Older receipts may have been discarded.</p>
      {shown?.state === 'loading' ? <p role="status">Loading deletion receipts…</p> : null}
      {shown?.state === 'unavailable' ? <p role="status" className="text-amber-300">Deletion receipts could not be verified. <button type="button" className="underline" onClick={() => void load()}>Retry newest</button></p> : null}
      {shown?.state === 'gap' ? <p role="status" className="text-amber-300">The retained deletion window moved. Previously loaded receipts were cleared. <button type="button" className="underline" onClick={() => void load(shown.floor)}>Load retained receipts</button></p> : null}
      {shown?.state === 'ready' ? <>
        <p role="status" className="text-neutral-400">{shown.records.length} retained deletion receipt{shown.records.length === 1 ? '' : 's'} loaded. Retention floor: {shown.floor}.</p>
        <ol className="max-h-44 space-y-1 overflow-y-auto" data-testid="deleted-activity-rows">{shown.records.map((row) =>
          <li key={row.sequence} className="break-all rounded border border-white/10 p-1">Session {row.sessionID} deleted · {new Date(row.deletedAt).toLocaleString()}</li>)}</ol>
        {shown.more ? <button type="button" className="text-sky-300 hover:underline" onClick={() => void load(shown.cursor)}>Load later retained receipts</button>
          : <button type="button" className="text-sky-300 hover:underline" onClick={() => void load()}>Refresh retained window</button>}
      </> : null}
    </div> : null}
  </section>;
}
