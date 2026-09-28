// SPDX-License-Identifier: Apache-2.0
/** Docked operator surfaces. Activity consumes explicit harness evidence only. */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { StoreApi } from 'zustand/vanilla';
import type { DirectoryStore } from '../sync/types.ts';
import type { SyncEngine } from '../sync/sync-engine.ts';
import { useSessionViewStore } from '../sync/view-store.ts';
import { useGlobalSyncStore } from '../sync/global-stores.ts';
import { WorkStatusPanel } from './work-status-panel.tsx';
import { GitView } from '../components/git/GitView.tsx';
import { ProjectNotes, type NotesDraftLease } from './project-notes.tsx';
import type { ContextPlanDraft } from './context-plans.tsx';
import type { ContextNotesDraft } from './context-notes.tsx';
import { TerminalView } from '../components/terminal/TerminalView.tsx';
import { BrowserSurface } from './browser-surface.tsx';
import { WalkthroughPreviewSurface } from './walkthrough-preview.tsx';
import { getRuntimeKey, isTransientRuntimeKey } from '../lib/runtime-switch.ts';
import { isNnaActivitySource, refreshActivitySnapshot } from '../sync/activity-snapshot.ts';
import type { ToolEvidence } from '../sync/activity-log.ts';
import { OperatorIcon } from './operator-icons.tsx';

type Surface = 'context' | 'activity' | 'changes' | 'walkthrough' | 'notes' | 'browser' | 'terminal';
const SURFACES: readonly { id: Surface; label: string }[] = [
  { id: 'context', label: 'Context' },
  { id: 'activity', label: 'Activity' },
  { id: 'changes', label: 'Changes' },
  { id: 'walkthrough', label: 'Walkthrough' },
  { id: 'notes', label: 'Notes' },
  { id: 'browser', label: 'Browser' },
  { id: 'terminal', label: 'Terminal' },
];
type PanelPreferences = { order: Surface[]; visible: Surface[] };
type ReviewRequest = { directory: string; path: string; id: number };
const DEFAULT_PANEL_PREFERENCES: PanelPreferences = {
  order: SURFACES.map((item) => item.id), visible: SURFACES.map((item) => item.id),
};

export function OperatorRail({ store, engine, directory, compactOpen = false, suppressed = false, onCloseCompact }: {
  store: StoreApi<DirectoryStore>; engine: SyncEngine; directory: string; compactOpen?: boolean; suppressed?: boolean; onCloseCompact?: () => void;
}): ReactNode {
  const walkthroughSessionId = useSessionViewStore((state) => state.activeDirectory === directory ? state.currentSessionId : null);
  const [wide, setWide] = useState(() => typeof window !== 'undefined' && (window.matchMedia?.('(min-width: 1280px)').matches ?? false));
  const [docked, setDocked] = useState(() => typeof window !== 'undefined' && (window.matchMedia?.('(min-width: 1024px)').matches ?? false));
  const [panelOpen, setPanelOpen] = useState(wide);
  useEffect(() => {
    const query = window.matchMedia?.('(min-width: 1280px)');
    if (!query) return;
    setWide(query.matches);
    const update = (event: MediaQueryListEvent): void => setWide(event.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    const query = window.matchMedia?.('(min-width: 1024px)');
    if (!query) return;
    setDocked(query.matches);
    const update = (event: MediaQueryListEvent): void => setDocked(event.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    // When a foreground compact surface becomes docked, keep its pane open.
    // ChatView simultaneously restores the chat column at this breakpoint.
    if (docked && compactOpen) setPanelOpen(true);
  }, [compactOpen, docked]);
  const paneVisible = !suppressed && (compactOpen || (docked && panelOpen));
  const global = useSyncExternalStore(useGlobalSyncStore.subscribe, useGlobalSyncStore.getState);
  const projectId = resolveContextProjectId(directory, global.projects);
  const storageKey = surfaceStorageKey(directory);
  const selectionKey = surfaceSelectionKey(storageKey);
  const preferencesKey = panelPreferencesKey(storageKey);
  const [panelState, setPanelState] = useState(() => ({ key: preferencesKey, value: readPanelPreferences(preferencesKey) }));
  const panels = panelState.key === preferencesKey ? panelState.value : readPanelPreferences(preferencesKey);
  const [customizing, setCustomizing] = useState(false);
  const [reviewRequest, setReviewRequest] = useState<ReviewRequest | null>(null);
  useEffect(() => {
    if (panelState.key !== preferencesKey) setPanelState({ key: preferencesKey, value: readPanelPreferences(preferencesKey) });
  }, [panelState.key, preferencesKey]);
  useEffect(() => {
    if (panelState.key !== preferencesKey || preferencesKey === null) return;
    try { localStorage.setItem(preferencesKey, JSON.stringify(panelState.value)); } catch { /* optional device preference */ }
  }, [panelState.key, panelState.value, preferencesKey]);
  const changePanels = (next: PanelPreferences): void => setPanelState({ key: preferencesKey, value: next });
  const [selection, setSelection] = useState(() => ({ key: selectionKey, surface: readSurface(selectionKey) }));
  // A single chat view can move between directories without remounting.  Do
  // not write its old selection into the newly selected directory before its
  // stored selection has been read.
  const selectedSurface = selection.key === selectionKey ? selection.surface : readSurface(selectionKey);
  const surface = panels.visible.includes(selectedSurface) ? selectedSurface : panels.order.find((id) => panels.visible.includes(id))!;
  const widthKey = surfaceWidthStorageKey(storageKey, surface);
  const [savedWidth, setSavedWidth] = useState(() => ({ key: widthKey, value: readWidth(widthKey, surface) }));
  const [viewportWidth, setViewportWidth] = useState(() => typeof window === 'undefined' ? 1280 : window.innerWidth);
  const width = clampRailWidth(savedWidth.key === widthKey ? savedWidth.value : readWidth(widthKey, surface), viewportWidth);
  const dragCleanup = useRef<(() => void) | null>(null);
  const selectedButton = useRef<HTMLButtonElement | null>(null);
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
  const resize = (next: number): void => {
    const resized = clampRailWidth(next, viewportWidth);
    // A no-op at the viewport limit is not a new width preference. Keep an
    // ultrawide saved width for when this window is widened again.
    if (resized !== width) setSavedWidth({ key: widthKey, value: resized });
  };
  useEffect(() => {
    if (selection.key !== selectionKey) setSelection({ key: selectionKey, surface: readSurface(selectionKey) });
  }, [selection.key, selectionKey]);
  useEffect(() => {
    if (selection.key === selectionKey && selection.surface !== surface) setSelection({ key: selectionKey, surface });
  }, [selection.key, selection.surface, selectionKey, surface]);
  useEffect(() => {
    if (selection.key !== selectionKey) return;
    try { localStorage.setItem(selectionKey, selection.surface); } catch { /* optional device preference */ }
  }, [selection.key, selection.surface, selectionKey]);
  // Keep opened views mounted across rail surfaces. A project switch remounts
  // Notes, while the single dirty-draft lease above survives that remount.
  const [terminalOpenedKey, setTerminalOpenedKey] = useState<string | null>(() => selection.surface === 'terminal' ? storageKey : null);
  const [browserOpenedKey, setBrowserOpenedKey] = useState<string | null>(() => selection.surface === 'browser' ? storageKey : null);
  const [notesOpenedKey, setNotesOpenedKey] = useState<string | null>(() => selection.surface === 'notes' ? storageKey : null);
  // Exactly one unsaved General Notes draft may cross project mounts. The
  // Notes pane locks other projects until this lease is saved or discarded.
  const [notesDraft, setNotesDraft] = useState<NotesDraftLease | null>(null);
  const [contextDrafts, setContextDrafts] = useState<Record<string, ContextNotesDraft>>({});
  const retainContextDraft = useCallback((id: string, draft: ContextNotesDraft): void => {
    setContextDrafts((current) => ({ ...current, [id]: draft }));
  }, []);
  const [planDrafts, setPlanDrafts] = useState<Record<string, ContextPlanDraft>>({});
  const retainPlanDraft = useCallback((id: string, draft: ContextPlanDraft): void => {
    setPlanDrafts((current) => ({ ...current, [id]: draft }));
  }, []);
  const [todoDrafts, setTodoDrafts] = useState<Record<string, string>>({});
  const retainTodoDraft = useCallback((id: string, draft: string): void => {
    setTodoDrafts((current) => ({ ...current, [id]: draft }));
  }, []);
  useEffect(() => {
    if (selection.key === selectionKey && surface === 'terminal') setTerminalOpenedKey(storageKey);
  }, [selection.key, selectionKey, storageKey, surface]);
  useEffect(() => {
    if (selection.key === selectionKey && surface === 'browser') setBrowserOpenedKey(storageKey);
  }, [selection.key, selectionKey, storageKey, surface]);
  useEffect(() => {
    if (selection.key === selectionKey && surface === 'notes') setNotesOpenedKey(storageKey);
  }, [selection.key, selectionKey, storageKey, surface]);
  // The 40px icon nav sits inside this aside's 1px border. Omitting that
  // border pixel makes the document itself scroll in both directions.
  const dockWidth = 41;
  return (
    <aside className={`${suppressed ? 'hidden' : compactOpen || docked ? 'flex' : 'hidden'} relative min-w-0 shrink-0 flex-col border-l border-white/10 bg-neutral-950/40 ${surface === 'browser' ? 'w-full xl:w-[min(60vw,900px)]' : 'w-full xl:w-[300px]'}`} style={docked && !compactOpen ? { width: panelOpen ? width + dockWidth : dockWidth } : undefined} data-testid="operator-rail">
      <div role="separator" aria-label="Resize operator panel" aria-orientation="vertical" aria-valuemin={280} aria-valuemax={maxRailWidth(viewportWidth)} aria-valuenow={width} tabIndex={0}
        className={`absolute bottom-0 left-0 top-0 z-20 w-1 cursor-col-resize hover:bg-white/20 focus:bg-white/20 ${compactOpen || suppressed || !panelOpen ? 'hidden' : 'hidden lg:block'}`}
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
      <div className={`${docked && !panelOpen && !compactOpen ? 'hidden' : 'flex'} items-center justify-between border-b border-white/10 px-3 py-1.5 text-[11px] text-neutral-300`} data-testid="operator-surface-title">
        {SURFACES.find((item) => item.id === surface)?.label}
        {docked && !compactOpen ? <button type="button" aria-label="Close operator panel" className="rounded px-1 text-neutral-500 hover:text-neutral-200" onClick={() => { setPanelOpen(false); selectedButton.current?.focus(); }}>×</button> : null}
      </div>
      <div className="flex min-h-0 flex-1">
      <nav className="order-2 flex w-10 shrink-0 flex-col border-l border-white/10 py-2" aria-label="Operator surfaces">
        {panels.order.filter((id) => panels.visible.includes(id)).map((id) => {
          const item = SURFACES.find((candidate) => candidate.id === id)!;
          return (
          <button key={item.id} ref={surface === item.id ? selectedButton : undefined} type="button" title={item.label} aria-label={item.label} aria-pressed={surface === item.id}
            className={`flex h-10 items-center justify-center ${surface === item.id && paneVisible ? 'text-amber-500' : 'text-neutral-500 hover:text-neutral-200'}`}
            onClick={() => {
              if (item.id === 'terminal') setTerminalOpenedKey(storageKey);
              if (item.id === 'browser') setBrowserOpenedKey(storageKey);
              if (item.id === 'notes') setNotesOpenedKey(storageKey);
              if (docked && !compactOpen) setPanelOpen(item.id !== surface || !panelOpen);
              setSelection({ key: selectionKey, surface: item.id });
            }}><OperatorIcon surface={item.id} /></button>
          );
        })}
        <button type="button" aria-label="Customize operator panels" aria-expanded={customizing}
          className="mt-auto px-1 py-2 text-[9px] text-neutral-500 hover:text-neutral-200"
          onClick={() => { setPanelOpen(true); setCustomizing((value) => !value); }}>⋯</button>
      </nav>
      <div className={`${docked && !panelOpen && !compactOpen ? 'hidden' : ''} order-1 min-h-0 min-w-0 flex-1 overflow-y-auto`}>
        {customizing ? <section aria-label="Customize operator panels" className="border-b border-white/10 p-2 text-xs">
          <div className="mb-2 text-neutral-300">Panels</div>
          {panels.order.map((id, index) => {
            const item = SURFACES.find((candidate) => candidate.id === id)!;
            const checked = panels.visible.includes(id);
            return <div key={id} className="flex items-center gap-1 py-1">
              <label className="flex min-w-0 flex-1 items-center gap-1 text-neutral-300">
                <input type="checkbox" aria-label={`Show ${item.label}`} checked={checked}
                  disabled={checked && panels.visible.length === 1}
                  onChange={() => {
                    const visible = checked ? panels.visible.filter((entry) => entry !== id) : [...panels.visible, id];
                    changePanels({ ...panels, visible });
                  }} />{item.label}
              </label>
              <button type="button" aria-label={`Move ${item.label} up`} disabled={index === 0}
                className="px-1 disabled:opacity-30" onClick={() => changePanels({ ...panels, order: movedPanel(panels.order, index, -1) })}>↑</button>
              <button type="button" aria-label={`Move ${item.label} down`} disabled={index === panels.order.length - 1}
                className="px-1 disabled:opacity-30" onClick={() => changePanels({ ...panels, order: movedPanel(panels.order, index, 1) })}>↓</button>
            </div>;
          })}
        </section> : null}
        {surface === 'context' ? <WorkStatusPanel store={store} engine={engine} embedded /> : null}
        {surface === 'activity' ? <ActivitySurface store={store} directory={directory} onReviewPath={(path) => {
          setReviewRequest({ directory, path, id: Date.now() });
          setSelection({ key: selectionKey, surface: 'changes' });
        }} /> : null}
        {surface === 'changes' ? <GitView directory={directory} visible compact reviewRequest={reviewRequest}
          onOpenWalkthrough={() => {
            if (!panels.visible.includes('walkthrough')) changePanels({ ...panels, visible: [...panels.visible, 'walkthrough'] });
            setSelection({ key: selectionKey, surface: 'walkthrough' });
          }} /> : null}
        {surface === 'walkthrough' ? <WalkthroughPreviewSurface directory={directory} sessionId={walkthroughSessionId} visible={paneVisible} /> : null}
        {notesOpenedKey === storageKey || surface === 'notes' ? (
          <div className={surface === 'notes' ? 'h-full min-h-0' : 'hidden'}>
            <ProjectNotes key={storageKey} directory={directory} directoryKey={storageKey} projectId={projectId} visible={surface === 'notes' && paneVisible}
              contextDraft={projectId ? contextDrafts[projectId] : undefined} onContextDraftChange={retainContextDraft}
              planDraft={projectId ? planDrafts[projectId] : undefined} onPlanDraftChange={retainPlanDraft}
              todoDraft={projectId ? todoDrafts[projectId] : undefined} onTodoDraftChange={retainTodoDraft}
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
            <BrowserSurface key={storageKey} visible={surface === 'browser' && paneVisible} />
          </div>
        ) : null}
      </div>
      </div>
    </aside>
  );
}

export function resolveContextProjectId(directory: string, projects: Record<string, unknown>[]): string | null {
  const target = normalizedProjectPath(directory);
  const matches = projects.flatMap((project) => {
    const id = project['id'];
    const worktree = project['worktree'];
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(id) || typeof worktree !== 'string') return [];
    const base = normalizedProjectPath(worktree);
    return base && (target === base || target.startsWith(`${base}/`)) ? [{ id, length: base.length }] : [];
  });
  matches.sort((a, b) => b.length - a.length);
  // If the roster assigns the same directory to different IDs, there is no
  // safe owner for a write. Wait for the project roster to be corrected.
  if (matches.length > 1 && matches[0]!.length === matches[1]!.length && matches[0]!.id !== matches[1]!.id) return null;
  return matches[0]?.id ?? null;
}

function normalizedProjectPath(value: string): string {
  let path = value.trim().replaceAll('\\', '/').replace(/\/+$/u, '');
  // Lexical traversal aliases can make a directory appear to belong to the
  // wrong project. Leave such paths unresolved instead of guessing an owner.
  if (path.split('/').some((segment) => segment === '.' || segment === '..')) return '';
  if (/^[a-z]:/iu.test(path) || path.startsWith('//')) path = path.toLowerCase();
  return path;
}

function readSurface(key: string): Surface {
  try { const value = localStorage.getItem(key); return SURFACES.some((surface) => surface.id === value) ? value as Surface : 'context'; } catch { return 'context'; }
}

function surfaceSelectionKey(directoryKey: string): string {
  const runtime = getRuntimeKey();
  // Preserve the existing local preference while isolating selections for
  // remote runtimes whose panel visibility can differ from the local harness.
  return isTransientRuntimeKey(runtime) || runtime === 'local' ? directoryKey : `${directoryKey}:runtime:${runtime}`;
}

function panelPreferencesKey(directoryKey: string): string | null {
  const runtime = getRuntimeKey();
  return isTransientRuntimeKey(runtime) ? null : `nnd.operator-rail.panels:${runtime}:${directoryKey}`;
}

function readPanelPreferences(key: string | null): PanelPreferences {
  if (key === null) return DEFAULT_PANEL_PREFERENCES;
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return DEFAULT_PANEL_PREFERENCES;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return DEFAULT_PANEL_PREFERENCES;
    const value = parsed as Partial<PanelPreferences>;
    const known = new Set<Surface>(DEFAULT_PANEL_PREFERENCES.order);
    const order = Array.isArray(value.order) ? value.order.filter((id): id is Surface => known.has(id)) : [];
    const uniqueOrder = [...new Set(order), ...DEFAULT_PANEL_PREFERENCES.order.filter((id) => !order.includes(id))];
    const visible = Array.isArray(value.visible) ? value.visible.filter((id): id is Surface => known.has(id)) : [];
    const uniqueVisible = [...new Set(visible)];
    return { order: uniqueOrder, visible: uniqueVisible.length > 0 ? uniqueVisible : DEFAULT_PANEL_PREFERENCES.visible };
  } catch { return DEFAULT_PANEL_PREFERENCES; }
}

function movedPanel(order: Surface[], index: number, distance: -1 | 1): Surface[] {
  const next = [...order];
  const target = index + distance;
  if (target < 0 || target >= next.length) return next;
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
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
  // The dock is beside a 288px session sidebar, not an otherwise empty page.
  // A width saved on an ultrawide monitor must leave a readable chat column
  // when restored in the ordinary desktop window.
  const sidebarWidth = 288;
  const dockWidth = 41;
  const minimumChatWidth = 480;
  return Math.max(280, Math.min(1200, viewportWidth - sidebarWidth - dockWidth - minimumChatWidth));
}

function clampRailWidth(width: number, viewportWidth: number): number {
  return Math.min(maxRailWidth(viewportWidth), Math.max(280, Math.round(width)));
}

function readWidth(key: string | null, surface: Surface): number {
  const viewport = typeof window === 'undefined' ? 1280 : window.innerWidth;
  const fallback = viewport >= 1600 ? Math.min(1200, Math.round(viewport * 0.36)) : surface === 'browser' ? 600 : 300;
  if (key === null) return fallback;
  try {
    const raw = localStorage.getItem(key);
    const saved = raw === null ? NaN : Number(raw);
    return Number.isFinite(saved) ? Math.min(1200, Math.max(280, Math.round(saved))) : fallback;
  } catch { return fallback; }
}

type ActivityFilter = 'all' | 'turn' | 'tool' | 'notice' | 'attention' | 'failed';
const ACTIVITY_FILTERS: readonly { id: ActivityFilter; label: string }[] = [
  { id: 'all', label: 'All' }, { id: 'turn', label: 'Turns' }, { id: 'tool', label: 'Tools' },
  { id: 'notice', label: 'Notices' }, { id: 'attention', label: 'Needs input' }, { id: 'failed', label: 'Failures' },
];

function ActivitySurface({ store, directory, onReviewPath }: {
  store: StoreApi<DirectoryStore>; directory: string; onReviewPath: (path: string) => void;
}): ReactNode {
  const snapshot = useSyncExternalStore(store.subscribe, store.getState);
  const view = useSyncExternalStore(useSessionViewStore.subscribe, useSessionViewStore.getState);
  const nnaSource = isNnaActivitySource(store);
  const [historyAvailable, setHistoryAvailable] = useState<boolean | null>(null);
  useEffect(() => {
    const sessionID = view.currentSessionId;
    if (!nnaSource || !sessionID) { setHistoryAvailable(null); return; }
    let current = true;
    setHistoryAvailable(null);
    void refreshActivitySnapshot(store, directory, sessionID, () => current)
      .then((available) => { if (current) setHistoryAvailable(available); });
    return () => { current = false; };
  }, [directory, nnaSource, store, view.currentSessionId]);
  const [filter, setFilter] = useState<ActivityFilter>('all');
  const [unseen, setUnseen] = useState(0);
  const viewport = useRef<HTMLOListElement>(null);
  const following = useRef(true);
  const previous = useRef({ key: '', ids: new Set<string>() });
  // Preserve the harness's arrival order. The source merges corrections in
  // place, so a redaction does not masquerade as a newly emitted row.
  const records = useMemo(() => snapshot.activity.filter((record) => record.sessionID === view.currentSessionId
    && (filter === 'all' || (filter === 'failed' || filter === 'attention' ? record.status === filter : record.kind === filter))),
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
      {nnaSource && historyAvailable === false ? <p role="status" className="mb-2 text-[10px] text-amber-300">Saved activity unavailable; live evidence may be incomplete.</p> : null}
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
      {records.length === 0 ? <li className="text-[11px] text-neutral-500">{filter === 'all' ? 'No activity evidence has been received for this session.' : filter === 'attention' ? 'No activity requiring input has been received for this session.' : `No ${filter === 'failed' ? 'failed' : filter} activity evidence has been received for this session.`}</li>
        : records.map((record) => <li key={record.id} className={`rounded border p-2 text-[11px] ${record.status === 'failed' ? 'border-red-500/40 bg-red-950/20' : record.status === 'attention' ? 'border-amber-500/40 bg-amber-950/20' : 'border-white/10 bg-neutral-900/40'}`}><div className="flex justify-between gap-2 text-neutral-500"><span>{record.kind}</span><time dateTime={new Date(record.time).toISOString()}>{new Date(record.time).toLocaleTimeString()}</time><span className={record.status === 'failed' ? 'text-red-300' : record.status === 'attention' || record.status === 'redacted' ? 'text-amber-300' : ''}>{record.status === 'attention' ? 'needs input' : record.status}</span></div><p className="mt-1 break-words text-neutral-300">{record.summary}</p>
          {record.toolEvidence ? <ToolEvidenceDetail evidence={record.toolEvidence} /> : null}
          {record.status === 'completed' && record.toolEvidence?.reviewPath
            && record.toolEvidence.reviewDirectory === directory ? <button type="button"
            className="mt-1 text-sky-300 hover:underline" onClick={() => onReviewPath(record.toolEvidence!.reviewPath!)}>
            Review file in Changes</button> : null}
          {record.evidenceMessageID && snapshot.message[record.sessionID]?.some((message) => message.id === record.evidenceMessageID)
            ? <button type="button" className="mt-1 text-sky-300 hover:underline" onClick={() => {
              const anchor = `message-${record.evidenceMessageID}`;
              window.history.replaceState(null, '', window.location.pathname + window.location.search);
              window.location.hash = `#${anchor}`;
              document.getElementById(anchor)?.scrollIntoView({ block: 'start' });
            }}>View prompt</button> : null}</li>)}
    </ol>
    {unseen > 0 ? <button type="button" className="m-2 shrink-0 rounded border border-white/15 bg-neutral-800 px-2 py-1 text-[10px] text-neutral-200" data-testid="activity-jump-live"
      onClick={() => { following.current = true; if (viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight; setUnseen(0); }}>↓ {unseen} new {unseen === 1 ? 'event' : 'events'} · Jump to live</button> : null}
  </section>;
}

function ToolEvidenceDetail({ evidence }: { evidence: ToolEvidence }): ReactNode {
  const rows = [
    ['Target', evidence.target], ['Effect', evidence.effect], ['Reason', evidence.reasonCode],
    ['Elapsed', evidence.elapsedMs === undefined ? undefined : `${evidence.elapsedMs} ms`],
    ['Exit code', evidence.exitCode === undefined ? undefined : String(evidence.exitCode)],
  ].filter((row): row is [string, string] => row[1] !== undefined);
  return <details className="mt-1 rounded border border-white/10 px-2 py-1" data-testid="activity-tool-evidence">
    <summary className="cursor-pointer text-sky-300">Tool evidence</summary>
    <dl className="mt-1 space-y-1">{rows.map(([label, value]) => <div key={label} className="flex flex-wrap justify-between gap-x-2">
      <dt className="text-neutral-500">{label}</dt><dd className="max-w-full break-all text-neutral-300">{value}</dd>
    </div>)}</dl>
  </details>;
}
