// SPDX-License-Identifier: Apache-2.0
/** Docked operator surfaces. Activity consumes explicit harness evidence only. */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { StoreApi } from 'zustand/vanilla';
import type { DirectoryStore } from '../sync/types.ts';
import type { SyncEngine } from '../sync/sync-engine.ts';
import { useSessionViewStore } from '../sync/view-store.ts';
import { WorkStatusPanel } from './work-status-panel.tsx';
import { GitView } from '../components/git/GitView.tsx';
import { ProjectNotes, type NotesDraftLease } from './project-notes.tsx';
import { TerminalView } from '../components/terminal/TerminalView.tsx';
import { BrowserSurface } from './browser-surface.tsx';
import { getRuntimeKey, isTransientRuntimeKey } from '../lib/runtime-switch.ts';

type Surface = 'context' | 'activity' | 'changes' | 'notes' | 'browser' | 'terminal';
const SURFACES: readonly { id: Surface; label: string }[] = [
  { id: 'context', label: 'Context' },
  { id: 'activity', label: 'Activity' },
  { id: 'changes', label: 'Changes' },
  { id: 'notes', label: 'Notes' },
  { id: 'browser', label: 'Browser' },
  { id: 'terminal', label: 'Terminal' },
];

export function OperatorRail({ store, engine, directory, compactOpen = false, suppressed = false, onCloseCompact }: {
  store: StoreApi<DirectoryStore>; engine: SyncEngine; directory: string; compactOpen?: boolean; suppressed?: boolean; onCloseCompact?: () => void;
}): ReactNode {
  const [wide, setWide] = useState(() => typeof window !== 'undefined' && (window.matchMedia?.('(min-width: 1280px)').matches ?? false));
  useEffect(() => {
    const query = window.matchMedia?.('(min-width: 1280px)');
    if (!query) return;
    setWide(query.matches);
    const update = (event: MediaQueryListEvent): void => setWide(event.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  const paneVisible = !suppressed && (compactOpen || wide);
  const storageKey = surfaceStorageKey(directory);
  const [selection, setSelection] = useState(() => ({ key: storageKey, surface: readSurface(storageKey) }));
  // A single chat view can move between directories without remounting.  Do
  // not write its old selection into the newly selected directory before its
  // stored selection has been read.
  const surface = selection.key === storageKey ? selection.surface : readSurface(storageKey);
  const widthKey = surfaceWidthStorageKey(storageKey, surface);
  const [savedWidth, setSavedWidth] = useState(() => ({ key: widthKey, value: readWidth(widthKey, surface) }));
  const [viewportWidth, setViewportWidth] = useState(() => typeof window === 'undefined' ? 1280 : window.innerWidth);
  const width = clampRailWidth(savedWidth.key === widthKey ? savedWidth.value : readWidth(widthKey, surface), viewportWidth);
  const dragCleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => dragCleanup.current?.(), []);
  useEffect(() => {
    const updateViewport = (): void => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', updateViewport);
    return () => window.removeEventListener('resize', updateViewport);
  }, []);
  useEffect(() => {
    if (savedWidth.key !== widthKey) setSavedWidth({ key: widthKey, value: readWidth(widthKey, surface) });
  }, [savedWidth.key, surface, widthKey]);
  useEffect(() => {
    if (savedWidth.key !== widthKey || widthKey === null) return;
    try { localStorage.setItem(widthKey, String(savedWidth.value)); } catch { /* optional device preference */ }
  }, [savedWidth.key, savedWidth.value, widthKey]);
  const resize = (next: number): void => setSavedWidth({ key: widthKey, value: clampRailWidth(next, viewportWidth) });
  useEffect(() => {
    if (selection.key !== storageKey) setSelection({ key: storageKey, surface: readSurface(storageKey) });
  }, [selection.key, storageKey]);
  useEffect(() => {
    if (selection.key !== storageKey) return;
    try { localStorage.setItem(storageKey, selection.surface); } catch { /* optional device preference */ }
  }, [selection.key, selection.surface, storageKey]);
  // Keep opened views mounted across rail surfaces. A project switch remounts
  // Notes, while the single dirty-draft lease above survives that remount.
  const [terminalOpenedKey, setTerminalOpenedKey] = useState<string | null>(() => selection.surface === 'terminal' ? storageKey : null);
  const [browserOpenedKey, setBrowserOpenedKey] = useState<string | null>(() => selection.surface === 'browser' ? storageKey : null);
  const [notesOpenedKey, setNotesOpenedKey] = useState<string | null>(() => selection.surface === 'notes' ? storageKey : null);
  // Exactly one unsaved General Notes draft may cross project mounts. The
  // Notes pane locks other projects until this lease is saved or discarded.
  const [notesDraft, setNotesDraft] = useState<NotesDraftLease | null>(null);
  useEffect(() => {
    if (selection.key === storageKey && surface === 'terminal') setTerminalOpenedKey(storageKey);
  }, [selection.key, storageKey, surface]);
  useEffect(() => {
    if (selection.key === storageKey && surface === 'browser') setBrowserOpenedKey(storageKey);
  }, [selection.key, storageKey, surface]);
  useEffect(() => {
    if (selection.key === storageKey && surface === 'notes') setNotesOpenedKey(storageKey);
  }, [selection.key, storageKey, surface]);
  return (
    <aside className={`${suppressed ? 'hidden' : compactOpen ? 'flex' : 'hidden xl:flex'} relative min-w-0 shrink-0 flex-col border-l border-white/10 bg-neutral-950/40 ${surface === 'browser' ? 'w-full xl:w-[min(60vw,900px)]' : 'w-full xl:w-[300px]'}`} style={wide && !compactOpen ? { width } : undefined} data-testid="operator-rail">
      <div role="separator" aria-label="Resize operator panel" aria-orientation="vertical" aria-valuemin={280} aria-valuemax={maxRailWidth(viewportWidth)} aria-valuenow={width} tabIndex={0}
        className={`absolute bottom-0 left-0 top-0 z-20 w-1 cursor-col-resize hover:bg-white/20 focus:bg-white/20 ${compactOpen || suppressed ? 'hidden' : 'hidden xl:block'}`}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          dragCleanup.current?.();
          const startX = event.clientX;
          const startWidth = width;
          const move = (next: PointerEvent): void => resize(startWidth + startX - next.clientX);
          const stop = (): void => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', stop);
            window.removeEventListener('pointercancel', stop);
            dragCleanup.current = null;
          };
          window.addEventListener('pointermove', move);
          window.addEventListener('pointerup', stop);
          window.addEventListener('pointercancel', stop);
          dragCleanup.current = stop;
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft') { event.preventDefault(); resize(width + 24); }
          else if (event.key === 'ArrowRight') { event.preventDefault(); resize(width - 24); }
          else if (event.key === 'Home') { event.preventDefault(); resize(280); }
          else if (event.key === 'End') { event.preventDefault(); resize(maxRailWidth(viewportWidth)); }
        }} />
      {compactOpen ? <div className="border-b border-white/10 px-3 py-2">
        <button type="button" data-testid="operator-return-chat" className="rounded px-2 py-1 text-xs text-neutral-200 hover:bg-white/10" onClick={onCloseCompact}>← Return to chat</button>
      </div> : null}
      <div className="border-b border-white/10 px-3 py-1.5 text-[11px] text-neutral-300" data-testid="operator-surface-title">{SURFACES.find((item) => item.id === surface)?.label}</div>
      <div className="flex min-h-0 flex-1">
      <nav className="flex w-10 shrink-0 flex-col border-r border-white/10 py-2" aria-label="Operator surfaces">
        {SURFACES.map((item) => (
          <button key={item.id} type="button" title={item.label} aria-label={item.label} aria-pressed={surface === item.id}
            className={`px-1 py-2 text-[9px] ${surface === item.id ? 'bg-white/10 text-white' : 'text-neutral-500 hover:text-neutral-200'}`}
            onClick={() => {
              if (item.id === 'terminal') setTerminalOpenedKey(storageKey);
              if (item.id === 'browser') setBrowserOpenedKey(storageKey);
              if (item.id === 'notes') setNotesOpenedKey(storageKey);
              setSelection({ key: storageKey, surface: item.id });
            }}>{item.label.slice(0, 1)}</button>
        ))}
      </nav>
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        {surface === 'context' ? <WorkStatusPanel store={store} engine={engine} embedded /> : null}
        {surface === 'activity' ? <ActivitySurface store={store} /> : null}
        {surface === 'changes' ? <GitView directory={directory} visible compact /> : null}
        {notesOpenedKey === storageKey || surface === 'notes' ? (
          <div className={surface === 'notes' ? 'h-full min-h-0' : 'hidden'}>
            <ProjectNotes key={storageKey} directory={directory} directoryKey={storageKey} visible={surface === 'notes' && paneVisible}
              draftLease={notesDraft} setDraftLease={setNotesDraft} />
          </div>
        ) : null}
        {terminalOpenedKey === storageKey || surface === 'terminal' ? (
          <div className={surface === 'terminal' ? 'flex h-full min-h-0' : 'hidden'}>
            <TerminalView directory={directory} visible={surface === 'terminal' && paneVisible} compact />
          </div>
        ) : null}
        {browserOpenedKey === storageKey || surface === 'browser' ? (
          <div className={surface === 'browser' ? 'h-full min-h-0' : 'hidden'}>
            <BrowserSurface key={storageKey} />
          </div>
        ) : null}
      </div>
      </div>
    </aside>
  );
}

function readSurface(key: string): Surface {
  try { const value = localStorage.getItem(key); return SURFACES.some((surface) => surface.id === value) ? value as Surface : 'context'; } catch { return 'context'; }
}

/** Match the harness directory identity: slash spelling and drive-case must
 * not turn one Windows project into two independent rail preferences. */
function surfaceStorageKey(directory: string): string {
  let normalized = directory.trim().replaceAll('\\', '/');
  normalized = normalized.replace(/^([a-z]):/u, (_match, drive: string) => `${drive.toUpperCase()}:`);
  normalized = normalized.length > 1 ? normalized.replace(/\/+$/u, '') : normalized;
  return `nnd.operator-rail.surface:${normalized}`;
}

function surfaceWidthStorageKey(directoryKey: string, surface: Surface): string | null {
  const runtime = getRuntimeKey();
  return isTransientRuntimeKey(runtime) ? null : `nnd.operator-rail.width:${runtime}:${directoryKey}:${surface}`;
}

function maxRailWidth(viewportWidth: number): number {
  return Math.max(280, Math.min(900, viewportWidth - 550));
}

function clampRailWidth(width: number, viewportWidth: number): number {
  return Math.min(maxRailWidth(viewportWidth), Math.max(280, Math.round(width)));
}

function readWidth(key: string | null, surface: Surface): number {
  const fallback = surface === 'browser' ? 600 : 300;
  if (key === null) return fallback;
  try {
    const raw = localStorage.getItem(key);
    const saved = raw === null ? NaN : Number(raw);
    return Number.isFinite(saved) ? Math.min(900, Math.max(280, Math.round(saved))) : fallback;
  } catch { return fallback; }
}

type ActivityFilter = 'all' | 'turn' | 'tool' | 'notice' | 'failed';
const ACTIVITY_FILTERS: readonly { id: ActivityFilter; label: string }[] = [
  { id: 'all', label: 'All' }, { id: 'turn', label: 'Turns' }, { id: 'tool', label: 'Tools' },
  { id: 'notice', label: 'Notices' }, { id: 'failed', label: 'Failures' },
];

function ActivitySurface({ store }: { store: StoreApi<DirectoryStore> }): ReactNode {
  const snapshot = useSyncExternalStore(store.subscribe, store.getState);
  const view = useSyncExternalStore(useSessionViewStore.subscribe, useSessionViewStore.getState);
  const [filter, setFilter] = useState<ActivityFilter>('all');
  const [unseen, setUnseen] = useState(0);
  const viewport = useRef<HTMLOListElement>(null);
  const following = useRef(true);
  const previous = useRef({ key: '', ids: new Set<string>() });
  // Preserve the harness's arrival order. The source merges corrections in
  // place, so a redaction does not masquerade as a newly emitted row.
  const records = useMemo(() => snapshot.activity.filter((record) => record.sessionID === view.currentSessionId
    && (filter === 'all' || (filter === 'failed' ? record.status === 'failed' : record.kind === filter))),
  [snapshot.activity, view.currentSessionId, filter]);
  const key = `${view.currentSessionId ?? ''}\u0000${filter}`;
  useEffect(() => {
    const viewportNode = viewport.current;
    if (previous.current.key !== key) {
      previous.current = { key, ids: new Set(records.map((record) => record.id)) };
      following.current = true;
      setUnseen(0);
      if (viewportNode) viewportNode.scrollTop = viewportNode.scrollHeight;
      return;
    }
    // The harness bounds activity to 500 rows. A fresh row can evict the
    // oldest one, leaving the length unchanged while the reader is away.
    const added = records.filter((record) => !previous.current.ids.has(record.id)).length;
    previous.current.ids = new Set(records.map((record) => record.id));
    if (following.current) {
      if (viewportNode) viewportNode.scrollTop = viewportNode.scrollHeight;
      setUnseen(0);
    } else if (added > 0) setUnseen((count) => count + added);
  }, [key, records]);
  return <section className="flex h-full min-h-0 flex-col" data-testid="operator-activity">
    <header className="shrink-0 border-b border-white/10 p-3 pb-2">
      <div className="mb-2 flex items-center justify-between"><h2 className="text-xs font-medium text-neutral-200">Activity log</h2><span className="text-[10px] text-neutral-500">{records.length} events</span></div>
      <div className="flex flex-wrap gap-1" role="group" aria-label="Filter activity">
        {ACTIVITY_FILTERS.map((option) => <button key={option.id} type="button" aria-pressed={filter === option.id}
          className={`rounded px-1.5 py-1 text-[10px] ${filter === option.id ? 'bg-white/15 text-white' : 'text-neutral-500 hover:text-neutral-200'}`}
          onClick={() => setFilter(option.id)}>{option.label}</button>)}
      </div>
    </header>
    <ol ref={viewport} className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3" data-testid="activity-rows"
      onScroll={(event) => {
        const node = event.currentTarget;
        following.current = node.scrollHeight - node.scrollTop - node.clientHeight <= 24;
        if (following.current) setUnseen(0);
      }}>
      {records.length === 0 ? <li className="text-[11px] text-neutral-500">{filter === 'all' ? 'No activity evidence has been received for this session.' : `No ${filter === 'failed' ? 'failed' : filter} activity evidence has been received for this session.`}</li>
        : records.map((record) => <li key={record.id} className="rounded border border-white/10 bg-neutral-900/40 p-2 text-[11px]"><div className="flex justify-between gap-2 text-neutral-500"><span>{record.kind}</span><time dateTime={new Date(record.time).toISOString()}>{new Date(record.time).toLocaleTimeString()}</time><span className={record.status === 'failed' ? 'text-red-300' : record.status === 'redacted' ? 'text-amber-300' : ''}>{record.status}</span></div><p className="mt-1 break-words text-neutral-300">{record.summary}</p></li>)}
    </ol>
    {unseen > 0 ? <button type="button" className="m-2 shrink-0 rounded border border-white/15 bg-neutral-800 px-2 py-1 text-[10px] text-neutral-200" data-testid="activity-jump-live"
      onClick={() => { following.current = true; if (viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight; setUnseen(0); }}>↓ {unseen} new {unseen === 1 ? 'event' : 'events'} · Jump to live</button> : null}
  </section>;
}
