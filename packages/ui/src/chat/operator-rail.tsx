// SPDX-License-Identifier: Apache-2.0
/** Docked operator surfaces. Activity consumes explicit harness evidence only. */
import { useState, useSyncExternalStore, type ReactNode } from 'react';
import type { StoreApi } from 'zustand/vanilla';
import type { DirectoryStore } from '../sync/types.ts';
import type { SyncEngine } from '../sync/sync-engine.ts';
import { useSessionViewStore } from '../sync/view-store.ts';
import { WorkStatusPanel } from './work-status-panel.tsx';
import { GitView } from '../components/git/GitView.tsx';
import { ProjectNotes } from './project-notes.tsx';
import { TerminalView } from '../components/terminal/TerminalView.tsx';

type Surface = 'context' | 'activity' | 'changes' | 'notes' | 'browser' | 'terminal';
const SURFACES: readonly { id: Surface; label: string }[] = [
  { id: 'context', label: 'Context' },
  { id: 'activity', label: 'Activity' },
  { id: 'changes', label: 'Changes' },
  { id: 'notes', label: 'Notes' },
  { id: 'browser', label: 'Browser' },
  { id: 'terminal', label: 'Terminal' },
];

export function OperatorRail({ store, engine, directory }: { store: StoreApi<DirectoryStore>; engine: SyncEngine; directory: string }): ReactNode {
  const [surface, setSurface] = useState<Surface>('context');
  // TerminalView owns the observer and the ten-minute keepalive.  Once the
  // user has opened it, keep that controller mounted while another rail
  // surface is selected so a live background terminal is not silently reaped.
  const [terminalEverOpened, setTerminalEverOpened] = useState(false);
  return (
    <aside className="hidden w-[300px] shrink-0 border-l border-white/10 bg-neutral-950/40 xl:flex" data-testid="operator-rail">
      <nav className="flex w-10 shrink-0 flex-col border-r border-white/10 py-2" aria-label="Operator surfaces">
        {SURFACES.map((item) => (
          <button key={item.id} type="button" title={item.label} aria-label={item.label} aria-pressed={surface === item.id}
            className={`px-1 py-2 text-[9px] ${surface === item.id ? 'bg-white/10 text-white' : 'text-neutral-500 hover:text-neutral-200'}`}
            onClick={() => {
              if (item.id === 'terminal') setTerminalEverOpened(true);
              setSurface(item.id);
            }}>{item.label.slice(0, 1)}</button>
        ))}
      </nav>
      <div className="min-w-0 flex-1 overflow-y-auto">
        {surface === 'context' ? <WorkStatusPanel store={store} engine={engine} embedded /> : null}
        {surface === 'activity' ? <ActivitySurface store={store} /> : null}
        {surface === 'changes' ? <GitView directory={directory} visible compact /> : null}
        {surface === 'notes' ? <ProjectNotes directory={directory} /> : null}
        {terminalEverOpened ? (
          <div className={surface === 'terminal' ? 'flex h-full min-h-0' : 'hidden'}>
            <TerminalView directory={directory} visible={surface === 'terminal'} compact />
          </div>
        ) : null}
        {surface === 'browser' ? <DeferredSurface label="Browser" /> : null}
      </div>
    </aside>
  );
}

function ActivitySurface({ store }: { store: StoreApi<DirectoryStore> }): ReactNode {
  const snapshot = useSyncExternalStore(store.subscribe, store.getState);
  const view = useSyncExternalStore(useSessionViewStore.subscribe, useSessionViewStore.getState);
  // The activity rail follows the selected transcript.  Reversing ingestion
  // order keeps the newest received evidence first without relying on clocks
  // that may differ during a replay.
  const records = snapshot.activity.filter((record) => record.sessionID === view.currentSessionId).reverse();
  return <section className="p-3" data-testid="operator-activity"><h2 className="mb-3 text-xs font-medium text-neutral-200">Activity</h2>
    {records.length === 0 ? <p className="text-[11px] text-neutral-500">No activity evidence has been received for this session.</p> : <ol className="flex flex-col gap-2">{records.map((record) => <li key={record.id} className="rounded border border-white/10 bg-neutral-900/40 p-2 text-[11px]"><div className="flex justify-between gap-2 text-neutral-500"><span>{record.kind}</span><time dateTime={new Date(record.time).toISOString()}>{new Date(record.time).toLocaleTimeString()}</time><span>{record.status}</span></div><p className="mt-1 text-neutral-300">{record.summary}</p></li>)}</ol>}
  </section>;
}

function DeferredSurface({ label }: { label: string }): ReactNode {
  return <section className="p-3" data-testid={`operator-${label.toLowerCase()}`}><h2 className="text-xs font-medium text-neutral-200">{label}</h2><p className="mt-2 text-[11px] text-neutral-500">This operator surface is reserved for the next integration slice.</p></section>;
}
